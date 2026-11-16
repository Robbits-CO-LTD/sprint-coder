// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics, ErrorCode};
use std::ffi::c_void;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};

const MAX_ERROR_BYTES: usize = 64 * 1024;
const MAX_OUTSTANDING_LAUNCHES: usize = 16;
static OUTSTANDING_LAUNCHES: AtomicUsize = AtomicUsize::new(0);

type LaunchResult = Result<(i32, String), AdapterError>;

struct LaunchCompletion {
    result: Mutex<Option<LaunchResult>>,
    changed: Condvar,
}

impl LaunchCompletion {
    fn new() -> Self {
        Self {
            result: Mutex::new(None),
            changed: Condvar::new(),
        }
    }

    fn wait(&self, deadline: Deadline) -> LaunchResult {
        let mut result = self.result.lock().map_err(|_| {
            AdapterError::internal("Launch completion lock was poisoned")
                .with_disposition(DeliverySemantics::uncertain())
        })?;
        loop {
            if let Some(completed) = result.take() {
                return completed;
            }
            let remaining = deadline.remaining();
            if remaining.is_zero() {
                return Err(deadline
                    .timeout_error()
                    .with_details(serde_json::json!({
                        "kind": "ns_workspace_launch_completion",
                        "callback_may_arrive_late": true,
                    }))
                    .with_disposition(DeliverySemantics::uncertain()));
            }
            let waited = self.changed.wait_timeout(result, remaining).map_err(|_| {
                AdapterError::internal("Launch completion wait was poisoned")
                    .with_disposition(DeliverySemantics::uncertain())
            })?;
            result = waited.0;
        }
    }

    fn complete(&self, result: LaunchResult) {
        if let Ok(mut slot) = self.result.lock()
            && slot.is_none()
        {
            *slot = Some(result);
            self.changed.notify_all();
        }
    }
}

pub(crate) unsafe fn open_and_wait(request: &[u8], deadline: Deadline) -> LaunchResult {
    if deadline.is_expired() {
        return Err(deadline
            .timeout_error()
            .with_disposition(DeliverySemantics::not_delivered()));
    }
    reserve_launch()?;
    let state = Arc::new(LaunchCompletion::new());
    let context = Arc::into_raw(Arc::clone(&state)) as *mut c_void;
    let accepted = unsafe {
        agent_desktop_open_application(
            request.as_ptr(),
            request.len(),
            context,
            launch_completed,
            release_context,
            launch_allowed,
        )
    };
    if !accepted {
        return Err(AdapterError::new(
            ErrorCode::AppUnresponsive,
            "NSWorkspace could not allocate a launch completion context",
        )
        .with_disposition(DeliverySemantics::not_delivered()));
    }
    state.wait(deadline)
}

unsafe extern "C" fn launch_allowed(
    context: *mut c_void,
    pid: i32,
    path: *const std::ffi::c_char,
) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let checked = std::panic::catch_unwind(|| {
        crate::system::own_window::check_variable()?;
        if pid > 0 {
            crate::system::own_window::check_pid(Some(pid))?;
        }
        if path.is_null() {
            return Err(crate::system::launch_location::refused());
        }
        let path = std::path::Path::new(std::ffi::OsStr::from_bytes(
            unsafe { std::ffi::CStr::from_ptr(path) }.to_bytes(),
        ));
        crate::system::launch_location::require(path).map(|_| ())
    })
    .unwrap_or_else(|_| Err(crate::system::launch_location::refused()));
    match checked {
        Ok(()) => true,
        Err(error) => {
            let state = unsafe { &*(context as *const LaunchCompletion) };
            state.complete(Err(error));
            false
        }
    }
}

unsafe extern "C" fn launch_completed(
    context: *mut c_void,
    result: *const crate::system::launch_callback_result::LaunchCallbackResult,
) {
    let _ = std::panic::catch_unwind(|| unsafe {
        let state = &*(context as *const LaunchCompletion);
        let result = result
            .as_ref()
            .ok_or_else(|| AdapterError::internal("NSWorkspace returned a null launch result"))
            .and_then(validate_result);
        state.complete(result);
    });
}

unsafe extern "C" fn release_context(context: *mut c_void) {
    let _ = std::panic::catch_unwind(|| unsafe {
        drop(Arc::from_raw(context as *const LaunchCompletion));
        release_launch();
    });
}

fn validate_result(
    result: &crate::system::launch_callback_result::LaunchCallbackResult,
) -> LaunchResult {
    if result.pid <= 0 {
        let code = if result.error_kind == 1 {
            ErrorCode::AppNotFound
        } else {
            ErrorCode::ActionFailed
        };
        return Err(callback_error(
            result,
            AdapterError::new(
                code,
                "NSWorkspace failed to launch the requested application",
            )
            .with_platform_detail(error_detail(result.error, result.error_len))
            .with_suggestion("Verify the app name or bundle identifier and retry"),
        ));
    }
    if result.terminated != 0 {
        return Err(callback_error(
            result,
            AdapterError::new(
                ErrorCode::AppUnresponsive,
                "Launched application terminated before identity verification",
            )
            .with_details(exited_details(result.pid)),
        ));
    }
    let identity = crate::system::process::process_identity::ProcessIdentity::capture(result.pid)
        .map_err(|error| callback_error(result, error))?
        .ok_or_else(|| {
            callback_error(result, {
                AdapterError::new(
                    ErrorCode::AppUnresponsive,
                    "Launched application exited before identity verification",
                )
                .with_details(exited_details(result.pid))
            })
        })?;
    if identity.conflicts_with_launch_time(result.launch_time) {
        return Err(callback_error(
            result,
            AdapterError::new(
                ErrorCode::AppUnresponsive,
                "NSWorkspace and libproc returned different launch identities",
            )
            .with_details(serde_json::json!({
                "pid": result.pid,
                "launch_time": result.launch_time,
                "complete": false,
            })),
        ));
    }
    if unsafe { agent_desktop_running_application_is_live(result.application, result.pid) } == 0 {
        return Err(callback_error(
            result,
            AdapterError::new(
                ErrorCode::AppUnresponsive,
                "Launched application changed after libproc identity verification",
            )
            .with_details(serde_json::json!({ "pid": result.pid, "complete": false })),
        ));
    }
    Ok((result.pid, identity.token()))
}

/// The details of a launch whose process exited before it could be identified: the kind
/// `launch` reads to tell a hand-off to a running instance (`launch::LAUNCHED_PROCESS_EXITED`).
fn exited_details(pid: i32) -> serde_json::Value {
    serde_json::json!({
        "pid": pid,
        "complete": false,
        "kind": crate::system::launch::LAUNCHED_PROCESS_EXITED,
    })
}

fn callback_error(
    result: &crate::system::launch_callback_result::LaunchCallbackResult,
    error: AdapterError,
) -> AdapterError {
    if result.delivery_started == 0 {
        error.with_disposition(DeliverySemantics::not_delivered())
    } else if result.pid <= 0 {
        error.with_disposition(DeliverySemantics::uncertain())
    } else {
        error.with_disposition(DeliverySemantics::delivered_unverified())
    }
}

fn reserve_launch() -> Result<(), AdapterError> {
    OUTSTANDING_LAUNCHES
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            (current < MAX_OUTSTANDING_LAUNCHES).then_some(current + 1)
        })
        .map(|_| ())
        .map_err(|_| {
            AdapterError::new(
                ErrorCode::AppUnresponsive,
                "Too many macOS launch completions are still outstanding",
            )
            .with_details(serde_json::json!({
                "kind": "launch_completion_backpressure",
                "limit": MAX_OUTSTANDING_LAUNCHES,
                "retryable": true,
            }))
            .with_suggestion("Wait for earlier launch requests to settle before trying again")
            .with_disposition(DeliverySemantics::not_delivered())
        })
}

fn release_launch() {
    let _ = OUTSTANDING_LAUNCHES.fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
        current.checked_sub(1)
    });
}

fn error_detail(error: *const std::ffi::c_char, error_len: usize) -> String {
    if error.is_null() || error_len == 0 {
        return "No NSWorkspace diagnostic".into();
    }
    let retained = error_len.min(MAX_ERROR_BYTES);
    let bytes = unsafe { std::slice::from_raw_parts(error.cast::<u8>(), retained) };
    String::from_utf8_lossy(bytes).into_owned()
}

unsafe extern "C" {
    fn agent_desktop_open_application(
        request: *const u8,
        request_len: usize,
        context: *mut c_void,
        completion: unsafe extern "C" fn(
            *mut c_void,
            *const crate::system::launch_callback_result::LaunchCallbackResult,
        ),
        release: unsafe extern "C" fn(*mut c_void),
        guard: unsafe extern "C" fn(*mut c_void, i32, *const std::ffi::c_char) -> bool,
    ) -> bool;
    fn agent_desktop_running_application_is_live(application: *mut c_void, expected_pid: i32)
    -> u8;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_policy_callback_preserves_the_own_window_refusal_before_opening() {
        let _scope = crate::system::own_window::enter(
            &crate::RefusedWindowOwner::Process {
                pid: 42,
                instance: None,
            },
            "launch_app",
        );
        let state = LaunchCompletion::new();
        let context = (&state as *const LaunchCompletion).cast_mut().cast();
        assert!(!unsafe { launch_allowed(context, 42, std::ptr::null()) });
        // The bridge's generic completion must not overwrite the precise policy error.
        state.complete(Ok((42, "later".into())));
        let error = state.wait(Deadline::after(100).unwrap()).unwrap_err();
        assert_eq!(error.code, ErrorCode::PolicyDenied);
        assert_eq!(error.details.unwrap()["kind"], "own_window_refused");
    }

    #[test]
    fn launch_policy_callback_refuses_an_unconfirmed_bundle_location() {
        let _scope =
            crate::system::own_window::enter(&crate::RefusedWindowOwner::Nobody, "launch_app");
        let state = LaunchCompletion::new();
        let context = (&state as *const LaunchCompletion).cast_mut().cast();
        assert!(!unsafe { launch_allowed(context, 0, c"/tmp/outside.app".as_ptr()) });
        let error = state.wait(Deadline::after(100).unwrap()).unwrap_err();
        assert_eq!(error.code, ErrorCode::PolicyDenied);
        assert_eq!(error.details.unwrap()["kind"], "launch_location_refused");
    }

    #[test]
    fn late_completion_state_remains_safe_after_timeout() {
        let state = LaunchCompletion::new();
        let timeout = state.wait(Deadline::after(1).unwrap()).unwrap_err();

        assert_eq!(timeout.code, ErrorCode::Timeout);
        state.complete(Ok((7, "generation".into())));
        assert_eq!(state.wait(Deadline::after(50).unwrap()).unwrap().0, 7);
    }

    #[test]
    fn outstanding_launch_quota_applies_backpressure() {
        let mut reserved = 0;
        while reserve_launch().is_ok() {
            reserved += 1;
        }

        assert!(reserved <= MAX_OUTSTANDING_LAUNCHES);
        let error = reserve_launch().unwrap_err();
        assert_eq!(
            error.details.unwrap()["kind"],
            "launch_completion_backpressure"
        );
        for _ in 0..reserved {
            release_launch();
        }
    }
}
