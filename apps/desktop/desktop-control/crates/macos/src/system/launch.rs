// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use agent_desktop_core::{
    AdapterError, AppInfo, Deadline, DeliverySemantics, ErrorCode, WindowInfo,
    system::launch_options::LaunchOptions, system::launch_result::LaunchResult,
};
use std::time::{Duration, Instant};

const MAX_ARGUMENT_COUNT: usize = 256;
const MAX_ENVIRONMENT_COUNT: usize = 256;
const MAX_LAUNCH_TEXT_BYTES: usize = 1024 * 1024;
const STARTUP_GRACE: Duration = Duration::from_millis(1500);

/// The `details.kind` of a launch whose started process exited before it presented a window.
pub(crate) const LAUNCHED_PROCESS_EXITED: &str = "launched_process_exited";

/// The guidance of a launch whose process passed it to the instance that was already running.
pub(crate) const HANDED_OFF: &str = "The launched process exited without a window of its own \
     while an instance of the same app that ran before the launch still runs: the app most \
     likely passed the launch to that running instance (a single-instance app, such as a \
     browser given a URL). Which window that instance opened, if any, was not identified here. \
     Do not repeat the launch: run `list-windows` for the app and pick the window by its title; \
     windows that were open before the launch may be ones the user had open.";

enum LaunchTarget {
    Existing { pid: i32, process_instance: String },
    New { baseline_instances: Vec<String> },
}

#[cfg(target_os = "macos")]
pub(crate) fn launch_app_impl(
    id: &str,
    options: &LaunchOptions,
    parent_deadline: Deadline,
) -> Result<LaunchResult, AdapterError> {
    validate_app_identifier(id).map_err(before_launch)?;
    validate_launch_options(options).map_err(before_launch)?;
    let deadline = if options.timeout_ms == 0 {
        parent_deadline
    } else {
        parent_deadline.capped(Duration::from_millis(options.timeout_ms))
    };
    ensure_launch_budget(deadline, id).map_err(before_launch)?;
    let initial = matching_apps(id, deadline).map_err(before_launch)?;
    if options.attach_if_running && initial.len() == 1 && !options.activate {
        let app = initial[0].clone();
        crate::system::own_window::check_pid(i32::try_from(app.pid.get()).ok())?;
        let path = super::launch_workspace::resolved_path(
            id,
            Some(super::process::process_identity::to_pid_t(app.pid)?),
        )?;
        super::launch_location::require(&path)?;
        let instance = required_instance(&app).map_err(before_launch)?;
        let pid = super::process::process_identity::to_pid_t(app.pid).map_err(before_launch)?;
        let window = exact_window(pid, &instance, deadline).map_err(before_launch)?;
        return Ok(result_from_app(&app, window));
    }
    let target = launch_target(options, initial).map_err(before_launch)?;

    let launched = match crate::system::launch_workspace::open(id, options, deadline) {
        // Exited before it could be identified: only the error says so.
        Err(error) => {
            return match exited_launch_pid(&error, None)
                .and_then(|pid| handed_off(id, pid, None, &target, deadline))
            {
                Some(result) => Ok(result),
                None => Err(error),
            };
        }
        Ok(launched) => launched,
    };
    validate_launched_target(&target, &launched).map_err(after_launch)?;
    let window = settled_window(launched.0, &launched.1, options, deadline);
    if !matches!(window, Ok(Some(_))) {
        // The wait ended without a window (an error, the grace or the deadline): judged by what
        // is observed now, whichever way the wait ended.
        let gone = !super::process::process_identity::matches_instance(launched.0, &launched.1)
            .unwrap_or(true);
        if let Some(result) = gone
            .then(|| handed_off(id, launched.0, Some(&launched.1), &target, deadline))
            .flatten()
        {
            return Ok(result);
        }
    }
    let window = window.map_err(after_launch)?;
    result_from_launched(&launched, window, id, &target, options, deadline).map_err(after_launch)
}

/// A fresh launch whose process exited before it presented a window, while an instance of the
/// app that ran before it still runs, was passed to that instance (a browser given `--url` opens
/// the page there): reported as handed off, with no window, rather than as a failure the caller
/// would retry. `None` when it was not (then the launch's own outcome stands).
#[cfg(target_os = "macos")]
fn handed_off(
    id: &str,
    pid: i32,
    process_instance: Option<&str>,
    target: &LaunchTarget,
    deadline: Deadline,
) -> Option<LaunchResult> {
    let LaunchTarget::New { baseline_instances } = target else {
        return None;
    };
    if baseline_instances.is_empty() {
        return None;
    }
    let running: Vec<String> = matching_apps(id, deadline)
        .map(|apps| {
            apps.iter()
                .filter_map(|app| app.process_instance.clone())
                .collect()
        })
        .unwrap_or_default();
    if !passed_to_running_instance(baseline_instances, &running) {
        return None;
    }
    let pid = agent_desktop_core::ProcessId::try_from(pid).ok()?;
    Some(handed_off_result(
        id,
        pid,
        process_instance.map(str::to_owned),
    ))
}

/// The started process's pid when `error` says it exited before it presented a window.
#[cfg(target_os = "macos")]
pub(crate) fn exited_launch_pid(error: &AdapterError, launched: Option<i32>) -> Option<i32> {
    let details = error.details.as_ref()?;
    if details.get("kind").and_then(serde_json::Value::as_str) != Some(LAUNCHED_PROCESS_EXITED) {
        return None;
    }
    let pid = details
        .get("pid")
        .and_then(serde_json::Value::as_i64)
        .and_then(|pid| i32::try_from(pid).ok())?;
    (pid > 0 && launched.is_none_or(|launched| launched == pid)).then_some(pid)
}

/// Whether an instance that ran before the launch (by its exact process instance) still runs.
#[cfg(target_os = "macos")]
pub(crate) fn passed_to_running_instance(baseline: &[String], running: &[String]) -> bool {
    running.iter().any(|instance| baseline.contains(instance))
}

#[cfg(target_os = "macos")]
pub(crate) fn handed_off_result(
    id: &str,
    pid: agent_desktop_core::ProcessId,
    process_instance: Option<String>,
) -> LaunchResult {
    LaunchResult {
        app: id.to_owned(),
        pid,
        process_instance,
        window: None,
        cdp: None,
        renderer: None,
        suggestion: Some(HANDED_OFF.to_owned()),
        attached: true,
        new_instance: false,
        handed_off: true,
        running_without_window: false,
        existing_window: false,
        activated: None,
    }
}

/// Waits only for the windows the launch itself produces. Starting up is what
/// creates them, so once the application reports that it finished starting up,
/// every window it was going to open on its own already exists and further
/// polling can only run out the deadline. An application that opens its first
/// window in response to being brought forward — TextEdit, Preview, any
/// document-based application — reports no window here, and `activate` is how a
/// caller asks for one instead of waiting for one it never requested.
#[cfg(target_os = "macos")]
fn settled_window(
    pid: i32,
    process_instance: &str,
    options: &LaunchOptions,
    deadline: Deadline,
) -> Result<Option<WindowInfo>, AdapterError> {
    let mut poll_interval = Duration::from_millis(25);
    let mut grace_ends_at = None;
    let mut last_read_failure: Option<AdapterError>;
    loop {
        match exact_window(pid, process_instance, deadline) {
            Ok(Some(window)) => return Ok(Some(window)),
            Ok(None) => last_read_failure = None,
            Err(error) if window_read_is_not_ready_yet(&error) => last_read_failure = Some(error),
            Err(error) => return Err(error),
        }
        if options.timeout_ms == 0
            || (!options.activate && grace_over(grace_ends_at, Instant::now()))
        {
            return last_read_failure.map_or(Ok(None), Err);
        }
        if grace_ends_at.is_none() && startup_finished(pid, process_instance)? {
            grace_ends_at = Instant::now().checked_add(STARTUP_GRACE);
        }
        let remaining = deadline.remaining();
        if remaining.is_zero() {
            return last_read_failure.map_or(Ok(None), Err);
        }
        std::thread::sleep(poll_interval.min(remaining));
        poll_interval = (poll_interval * 3 / 2).min(Duration::from_millis(250));
    }
}

#[cfg(target_os = "macos")]
fn window_read_is_not_ready_yet(error: &AdapterError) -> bool {
    matches!(error.code, ErrorCode::AppUnresponsive | ErrorCode::Timeout)
}

/// Ends the wait when the application has created whatever windows its launch
/// produces. The window server keeps no record of a process that exited, and
/// none of one that has not registered yet, so libproc decides which happened:
/// a process that is gone ends the launch with an error rather than an answer
/// about windows it will never open.
#[cfg(target_os = "macos")]
fn startup_finished(pid: i32, process_instance: &str) -> Result<bool, AdapterError> {
    use crate::system::appkit_bridge::StartupState;
    match crate::system::appkit_bridge::startup_state(pid) {
        StartupState::Starting => Ok(false),
        StartupState::Finished => Ok(true),
        StartupState::NoRecord => {
            if super::process::process_identity::matches_instance(pid, process_instance)? {
                Ok(true)
            } else {
                Err(launch_target_gone(pid))
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn launch_target_gone(pid: i32) -> AdapterError {
    AdapterError::new(
        ErrorCode::AppUnresponsive,
        "Launched application exited before it presented a window",
    )
    .with_details(serde_json::json!({
        "pid": pid,
        "complete": false,
        "kind": LAUNCHED_PROCESS_EXITED,
    }))
    .with_suggestion("Check the application's own launch requirements, then retry.")
}

/// The grace covers the gap between an application reporting that it started
/// and its first window reaching the window server. Waiting starts running out
/// only once there is a completed startup to measure from.
#[cfg(target_os = "macos")]
fn grace_over(grace_ends_at: Option<Instant>, now: Instant) -> bool {
    grace_ends_at.is_some_and(|end| now >= end)
}

/// The attaching path reports the display name, so the launching path has to
/// report the same thing for the same field. A window already carries it; the
/// requested identifier is the fallback when there is no window to ask.
#[cfg(target_os = "macos")]
fn launched_display_name(window: Option<&WindowInfo>, id: &str) -> String {
    window
        .map(|window| window.app.clone())
        .unwrap_or_else(|| id.to_owned())
}

#[cfg(target_os = "macos")]
fn result_from_app(app: &AppInfo, window: Option<WindowInfo>) -> LaunchResult {
    let renderer = super::process::process_identity::to_pid_t(app.pid)
        .ok()
        .and_then(crate::system::renderer_kind::detect_chromium);
    LaunchResult {
        app: app.name.clone(),
        pid: app.pid,
        process_instance: app.process_instance.clone(),
        window,
        cdp: None,
        renderer,
        suggestion: None,
        attached: true,
        new_instance: false,
        handed_off: false,
        running_without_window: false,
        existing_window: false,
        activated: None,
    }
}

#[cfg(target_os = "macos")]
fn result_from_launched(
    launched: &(i32, String),
    window: Option<WindowInfo>,
    id: &str,
    target: &LaunchTarget,
    options: &LaunchOptions,
    deadline: Deadline,
) -> Result<LaunchResult, AdapterError> {
    let renderer = crate::system::renderer_kind::detect_chromium(launched.0);
    let attached = matches!(target, LaunchTarget::Existing { .. });
    let activated = options.activate.then(|| {
        window_is_in_front(window.as_ref(), || {
            crate::system::window::window_inventory::focused_window_until(deadline_instant(
                deadline,
            )?)
        })
    });
    Ok(LaunchResult {
        attached,
        new_instance: !attached && window.is_some(),
        handed_off: false,
        running_without_window: false,
        existing_window: false,
        activated,
        app: launched_display_name(window.as_ref(), id),
        pid: agent_desktop_core::ProcessId::try_from(launched.0)
            .map_err(|_| AdapterError::internal("Launched process identifier is out of range"))?,
        process_instance: Some(launched.1.clone()),
        window,
        cdp: None,
        renderer,
        suggestion: None,
    })
}

/// Whether the launched window is the one in front. The app is already open, so this only
/// reports: no window is not activated (and the front is not read), and a front that cannot be
/// read is not confirmed as activated rather than an error after the launch.
#[cfg(target_os = "macos")]
fn window_is_in_front(
    window: Option<&WindowInfo>,
    focused: impl FnOnce() -> Result<Option<WindowInfo>, AdapterError>,
) -> bool {
    let Some(window) = window else {
        return false;
    };
    focused().ok().flatten().is_some_and(|front| {
        front.id == window.id
            && front.pid == window.pid
            && front.process_instance == window.process_instance
    })
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn launch_app_impl(
    _id: &str,
    _options: &LaunchOptions,
    _deadline: Deadline,
) -> Result<LaunchResult, AdapterError> {
    Err(AdapterError::not_supported("launch_app"))
}

#[cfg(target_os = "macos")]
fn launch_target(
    options: &LaunchOptions,
    mut initial: Vec<AppInfo>,
) -> Result<LaunchTarget, AdapterError> {
    if options.attach_if_running {
        if initial.len() > 1 {
            return Err(ambiguous_apps(&initial));
        }
        if let Some(app) = initial.pop() {
            let process_instance = required_instance(&app)?;
            return Ok(LaunchTarget::Existing {
                pid: super::process::process_identity::to_pid_t(app.pid)?,
                process_instance,
            });
        }
    }
    let baseline_instances = initial
        .iter()
        .map(required_instance)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(LaunchTarget::New { baseline_instances })
}

#[cfg(target_os = "macos")]
fn validate_launched_target(
    target: &LaunchTarget,
    launched: &(i32, String),
) -> Result<(), AdapterError> {
    match target {
        LaunchTarget::Existing {
            pid,
            process_instance,
        } => {
            if launched.0 == *pid && launched.1 == *process_instance {
                Ok(())
            } else {
                Err(AdapterError::new(
                    ErrorCode::AppUnresponsive,
                    "NSWorkspace returned a different application while attaching",
                )
                .with_details(serde_json::json!({
                    "expected_pid": pid,
                    "returned_pid": launched.0,
                    "complete": false,
                })))
            }
        }
        LaunchTarget::New { baseline_instances } => {
            if baseline_instances.contains(&launched.1) {
                Err(AdapterError::new(
                    ErrorCode::AppUnresponsive,
                    "NSWorkspace reused an existing application during an exact fresh launch",
                )
                .with_details(serde_json::json!({
                    "returned_pid": launched.0,
                    "complete": false,
                })))
            } else {
                Ok(())
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn matching_apps(id: &str, deadline: Deadline) -> Result<Vec<AppInfo>, AdapterError> {
    ensure_launch_budget(deadline, id)?;
    let until = deadline_instant(deadline)?;
    crate::system::app::app_inventory::stabilize_apps_until(until, || {
        let inventory = super::app::workspace_apps::list_apps_scoped_until(id, None, until)?;
        if inventory.apps.is_empty() {
            super::app::workspace_apps::require_complete(&inventory.skipped)?;
        }
        Ok(inventory.apps)
    })
}

#[cfg(target_os = "macos")]
fn required_instance(app: &AppInfo) -> Result<String, AdapterError> {
    app.process_instance.clone().ok_or_else(|| {
        AdapterError::new(
            ErrorCode::AppUnresponsive,
            "Running application has no exact process instance token",
        )
        .with_details(serde_json::json!({ "pid": app.pid, "complete": false }))
    })
}

#[cfg(target_os = "macos")]
fn ambiguous_apps(apps: &[AppInfo]) -> AdapterError {
    AdapterError::ambiguous_process_target(
        "More than one application instance matches the launch target",
        &apps.iter().map(|app| app.pid).collect::<Vec<_>>(),
    )
}

#[cfg(target_os = "macos")]
fn exact_window(
    pid: i32,
    process_instance: &str,
    deadline: Deadline,
) -> Result<Option<WindowInfo>, AdapterError> {
    let window = match crate::system::window::window_inventory::exact_window_for_pid_until(
        pid,
        deadline_instant(deadline)?,
    ) {
        Ok(window) => window,
        Err(error) if error.code == ErrorCode::WindowNotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if window.process_instance.as_deref() != Some(process_instance) {
        return Err(AdapterError::new(
            ErrorCode::AppUnresponsive,
            "Application process instance changed while waiting for its window",
        )
        .with_details(serde_json::json!({ "pid": pid, "complete": false })));
    }
    Ok(Some(window))
}

#[cfg(target_os = "macos")]
fn ensure_launch_budget(deadline: Deadline, id: &str) -> Result<(), AdapterError> {
    if deadline.is_expired() {
        return Err(deadline
            .timeout_error()
            .with_details(serde_json::json!({ "app_name": id })));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn before_launch(error: AdapterError) -> AdapterError {
    error.with_disposition(DeliverySemantics::not_delivered())
}

#[cfg(target_os = "macos")]
fn validate_app_identifier(id: &str) -> Result<(), AdapterError> {
    let safe_bundle_id = !looks_like_bundle_id(id)
        || id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        });
    if id.is_empty()
        || id.contains("..")
        || id.contains('/')
        || id.chars().any(char::is_control)
        || !safe_bundle_id
    {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Invalid app identifier: use a bare app name or bundle identifier",
        )
        .with_details(serde_json::json!({ "app_name": id }))
        .with_suggestion("Use an app name like 'Safari' or bundle ID like 'com.apple.Safari'."));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn validate_launch_options(options: &LaunchOptions) -> Result<(), AdapterError> {
    if options.cwd.is_some() {
        return Err(AdapterError::new(
            ErrorCode::ActionNotSupported,
            "macOS Launch Services does not support an exact launch working directory",
        )
        .with_suggestion("Remove --cwd, or start the app through a dedicated launcher script"));
    }
    if options.args.len() > MAX_ARGUMENT_COUNT || options.env.len() > MAX_ENVIRONMENT_COUNT {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Launch argument or environment entry count exceeds the supported limit",
        ));
    }
    let text_bytes = options
        .args
        .iter()
        .map(String::len)
        .chain(
            options
                .env
                .iter()
                .map(|(key, value)| key.len() + value.len()),
        )
        .try_fold(0_usize, usize::checked_add)
        .ok_or_else(|| AdapterError::new(ErrorCode::InvalidArgs, "Launch options are too large"))?;
    if text_bytes > MAX_LAUNCH_TEXT_BYTES {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Launch argument and environment data exceeds one MiB",
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn looks_like_bundle_id(id: &str) -> bool {
    id.contains('.') && !id.ends_with(".app") && !id.contains(' ')
}

#[cfg(target_os = "macos")]
fn after_launch(error: AdapterError) -> AdapterError {
    error.with_disposition(DeliverySemantics::delivered_unverified())
}

#[cfg(target_os = "macos")]
fn deadline_instant(deadline: Deadline) -> Result<Instant, AdapterError> {
    Instant::now()
        .checked_add(deadline.remaining())
        .ok_or_else(|| AdapterError::new(ErrorCode::InvalidArgs, "Launch deadline is out of range"))
}

#[cfg(test)]
#[path = "launch_tests.rs"]
mod tests;
