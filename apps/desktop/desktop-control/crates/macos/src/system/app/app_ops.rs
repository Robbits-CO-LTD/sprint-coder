// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use agent_desktop_core::{AdapterError, AppInfo, Deadline, ErrorCode, ProcessIdentity};

pub(crate) use crate::system::app::close_outcome::CloseOutcome;

#[cfg(target_os = "macos")]
pub(crate) fn pid_from_element(
    element: &crate::tree::AXElement,
    deadline: Deadline,
) -> Option<i32> {
    crate::tree::properties::ax_ipc::pid(element, deadline).ok()
}

const PROTECTED_PROCESSES: &[&str] = &["loginwindow", "windowserver", "dock", "launchd", "finder"];

pub(crate) fn is_protected_process(identifier: &str) -> bool {
    let lower = identifier.to_lowercase();
    PROTECTED_PROCESSES
        .iter()
        .any(|protected| lower == *protected || lower.split('.').any(|part| part == *protected))
}

fn ensure_not_protected(id: &str) -> Result<(), AdapterError> {
    if is_protected_process(id) {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            format!("'{id}' is a protected system process and cannot be closed"),
        )
        .with_suggestion(
            "Target a regular application; session-critical processes are never closed.",
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn close_app_impl(
    app: &AppInfo,
    force: bool,
    deadline: Deadline,
) -> Result<CloseOutcome, AdapterError> {
    ensure_not_protected(&app.name)?;
    if let Some(bundle_id) = &app.bundle_id {
        ensure_not_protected(bundle_id)?;
    }
    let instance = app.process_instance.as_deref().ok_or_else(|| {
        AdapterError::new(
            ErrorCode::InvalidArgs,
            "Exact close requires a process instance token",
        )
    })?;
    let identity = crate::system::process::process_identity::require_core(&ProcessIdentity {
        pid: app.pid,
        instance: instance.to_owned(),
    })?;
    terminate_running_application(&app.name, identity, force, deadline)
}

#[cfg(target_os = "macos")]
fn terminate_running_application(
    id: &str,
    identity: crate::system::process::process_identity::ProcessIdentity,
    force: bool,
    deadline: Deadline,
) -> Result<CloseOutcome, AdapterError> {
    if deadline.is_expired() {
        return Err(before_termination_request(deadline.timeout_error()));
    }
    crate::system::cocoa_runtime::ensure_cocoa_multithreaded()
        .map_err(before_termination_request)?;
    if !identity
        .still_matches()
        .map_err(before_termination_request)?
    {
        return Ok(CloseOutcome::AlreadyGone);
    }
    let outcome = crate::system::appkit_bridge::terminate(
        identity.pid(),
        identity.launch_time_seconds(),
        force,
    )?;
    match outcome {
        crate::system::appkit_bridge::TerminationOutcome::Missing => {
            return if identity
                .still_matches()
                .map_err(before_termination_request)?
            {
                Err(AdapterError::new(
                    ErrorCode::AppUnresponsive,
                    "NSRunningApplication could not resolve the verified process instance",
                )
                .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered()))
            } else {
                Ok(CloseOutcome::AlreadyGone)
            };
        }
        crate::system::appkit_bridge::TerminationOutcome::Rejected => {
            if identity
                .still_matches()
                .map_err(before_termination_request)?
            {
                return Err(termination_request_not_accepted(id, identity.pid(), force));
            }
            return Ok(CloseOutcome::AlreadyGone);
        }
        crate::system::appkit_bridge::TerminationOutcome::IdentityMismatch => {
            return Err(AdapterError::new(
                ErrorCode::StaleRef,
                "NSRunningApplication changed identity before termination delivery",
            )
            .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered()));
        }
        crate::system::appkit_bridge::TerminationOutcome::Accepted => {}
    }
    wait_for_exit(id, identity, force, deadline)
}

#[cfg(target_os = "macos")]
fn termination_request_not_accepted(id: &str, pid: i32, force: bool) -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        format!("The native termination API did not accept the request for '{id}'"),
    )
    .with_details(serde_json::json!({
        "pid": pid,
        "force": force,
    }))
    .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered())
}

#[cfg(target_os = "macos")]
fn wait_for_exit(
    id: &str,
    identity: crate::system::process::process_identity::ProcessIdentity,
    force: bool,
    deadline: Deadline,
) -> Result<CloseOutcome, AdapterError> {
    loop {
        if !identity
            .still_matches()
            .map_err(after_termination_request)?
        {
            return Ok(CloseOutcome::Exited);
        }
        if deadline.is_expired() {
            return still_running_after_request(id, &identity, force, deadline.timeout_error());
        }
        let pause = match deadline.remaining_slice(std::time::Duration::from_millis(25)) {
            Ok(pause) => pause,
            Err(error) if error.code == ErrorCode::Timeout => {
                return still_running_after_request(id, &identity, force, error);
            }
            Err(error) => return Err(after_termination_request(error)),
        };
        std::thread::sleep(pause.min(std::time::Duration::from_millis(25)));
    }
}

/// How long the look for a confirmation sheet or dialog may take once the wait has run out: a few
/// accessibility reads of the app's windows, each bounded by it.
#[cfg(target_os = "macos")]
const PENDING_DIALOG_PROBE: std::time::Duration = std::time::Duration::from_millis(250);

/// The app accepted the request to quit and still runs when the wait ran out. Looks once, through
/// the accessibility reads `snapshot --surface alert` uses, for a sheet or dialog on its windows;
/// any read that fails only leaves that unsaid. An app that ended meanwhile has exited.
#[cfg(target_os = "macos")]
fn still_running_after_request(
    id: &str,
    identity: &crate::system::process::process_identity::ProcessIdentity,
    force: bool,
    timeout: AdapterError,
) -> Result<CloseOutcome, AdapterError> {
    let probe = std::time::Instant::now() + PENDING_DIALOG_PROBE;
    let dialog = matches!(
        crate::tree::surfaces::alert_for_pid(identity.pid(), probe),
        Ok(Some(_))
    );
    if matches!(identity.still_matches(), Ok(false)) {
        return Ok(CloseOutcome::Exited);
    }
    Err(quit_request_pending_error(
        timeout,
        id,
        identity.pid(),
        force,
        dialog,
    ))
}

/// The error for an app that accepted the request to quit but still runs when the wait ran out,
/// most often because it asks the person something first (whether to save changes). The code of
/// `timeout` is kept, and the request counts as delivered but not confirmed: sending it again only
/// asks again, and forcing it would throw away what the person has not saved. `dialog` is set only
/// when a sheet or dialog was seen on the app's windows; the wording stays a possibility either way.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn quit_request_pending_error(
    timeout: AdapterError,
    app: &str,
    pid: i32,
    force: bool,
    dialog: bool,
) -> AdapterError {
    let mut details = serde_json::json!({
        "kind": "quit_request_pending",
        "app": app,
        "pid": pid,
        "force": force,
    });
    if let Some(waited) = timeout.details.as_ref() {
        for key in ["timeout_ms", "elapsed_ms"] {
            if let Some(value) = waited.get(key) {
                details[key] = value.clone();
            }
        }
    }
    let suggestion = if dialog {
        details["pending_dialog"] = serde_json::Value::Bool(true);
        "The app is showing a sheet or dialog, so it is probably asking the user something first, \
         for example whether to save changes; that window may now be visible to the user. Do not \
         send close-app again and do not force it. Tell the user the app is still open and may be \
         waiting for their answer."
    } else {
        "The app may be asking the user something first, for example whether to save changes, and \
         its confirmation window may now be visible to the user; or it may be busy. Do not send \
         close-app again and do not force it. Tell the user the app is still open."
    };
    AdapterError::new(
        timeout.code,
        format!("'{app}' accepted the request to quit but is still running"),
    )
    .with_suggestion(suggestion)
    .with_details(details)
    .with_disposition(agent_desktop_core::DeliverySemantics::delivered_unverified())
}

#[cfg(target_os = "macos")]
fn after_termination_request(error: AdapterError) -> AdapterError {
    error.with_disposition(agent_desktop_core::DeliverySemantics::delivered_unverified())
}

#[cfg(target_os = "macos")]
fn before_termination_request(error: AdapterError) -> AdapterError {
    error.with_disposition(agent_desktop_core::DeliverySemantics::not_delivered())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn close_app_impl(
    _app: &AppInfo,
    _force: bool,
    _deadline: Deadline,
) -> Result<CloseOutcome, AdapterError> {
    Err(AdapterError::not_supported("close_app"))
}

#[cfg(test)]
#[path = "app_ops_tests.rs"]
mod tests;
