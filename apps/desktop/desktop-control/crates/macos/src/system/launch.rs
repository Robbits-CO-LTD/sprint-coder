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

/// How long a launch whose process exited watches the instance it may have passed the launch to
/// for a new window (capped by the launch's deadline), and how often it looks.
const HANDOFF_WATCH: Duration = Duration::from_secs(3);
const HANDOFF_POLL: Duration = Duration::from_millis(100);

/// The guidance of a launch passed to the instance that was already running.
pub(crate) const HANDED_OFF: &str = "The launched process passed the launch to the instance of \
     the same app (the same bundle) that was already running and exited, and that instance \
     showed a new window soon after (a single-instance app, such as a browser given a URL). \
     The window is not named here: run `list-windows` for the app, find the window that was not \
     there before (for a URL, by its title), and check its `is_focused` before telling the user \
     where it opened. Do not repeat the launch. Windows that were open before the launch may be \
     ones the user had open.";

/// The guidance of a launch whose process exited while an instance of the same app runs, when
/// no new window of that instance was seen.
pub(crate) const HANDOFF_UNCONFIRMED: &str = "The launched process exited without a window \
     while an instance of the same app (the same bundle) was already running. It may have \
     passed the launch to that instance, or it may have failed: no new window of that instance \
     was seen within a few seconds. Do not repeat the launch, which may open a second window: \
     run `list-windows` for the app to see whether a new window appeared, and tell the user if \
     none did.";

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
    let target = launch_target(options, initial.clone()).map_err(before_launch)?;
    // Checked before opening exactly as before (`prepare`, the checks `open` always made).
    let path = super::launch_workspace::prepare(id, deadline)?;
    // Only a fresh start (`--no-attach`, `--url`) may be passed to an instance that runs; for it,
    // the instances it may be passed to are read before it starts. Nothing here refuses the
    // launch: what cannot be read only leaves fewer candidates.
    let handoff = (!options.attach_if_running).then(|| read_handoff(id, &initial, &path, deadline));

    let launched = match crate::system::launch_workspace::open(id, &path, options, deadline) {
        Err(error) => {
            return after_open_error(
                error,
                handoff.as_ref(),
                |handoff| watch_live(handoff, deadline),
                id,
                options.activate,
            );
        }
        Ok(launched) => launched,
    };
    validate_launched_target(&target, &launched).map_err(after_launch)?;
    let window = settled_window(launched.0, &launched.1, options, deadline);
    let window = match after_wait(
        window,
        handoff.as_ref(),
        || {
            // A process that cannot be read is taken as still running.
            !super::process::process_identity::matches_instance(launched.0, &launched.1)
                .unwrap_or(true)
        },
        |handoff| watch_live(handoff, deadline),
        id,
        &launched,
        options.activate,
    ) {
        AfterWait::Window(window) => window.map_err(after_launch)?,
        AfterWait::Outcome(outcome) => return outcome,
    };
    result_from_launched(&launched, window, id, &target, options, deadline).map_err(after_launch)
}

/// The smallest window, in points each way, counted as a new window of an instance a launch was
/// passed to: smaller ones (a browser's helper or status windows) are not taken as its answer.
const MIN_NEW_WINDOW_POINTS: f64 = 100.0;

/// A window of a process, as the hand-off watch reads it: its number, and whether it counts as
/// a window shown to the user (on screen, layer 0, at least `MIN_NEW_WINDOW_POINTS` each way).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowSeen {
    pub(crate) number: i64,
    pub(crate) shown: bool,
}

/// An instance a launch may be passed to: its process, and every window it had before (shown or
/// not, on any Space, minimized or not), so a window it only shows again is not taken as new.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HandoffCandidate {
    pub(crate) pid: i32,
    pub(crate) process_instance: String,
    pub(crate) windows_before: Vec<i64>,
}

/// What a fresh launch read before it started, for a hand-off: the instances it may be passed to,
/// and whether an instance of the same bundle id ran at all (also when no candidate could be made
/// of it: its bundle or windows could not be read, or it runs from another copy of the bundle).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct Handoff {
    pub(crate) candidates: Vec<HandoffCandidate>,
    pub(crate) same_app_ran: bool,
}

/// What watching the candidates after the launched process exited showed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum HandoffWatch {
    /// A candidate showed a window it did not have before: that instance, which still runs.
    NewWindow { pid: i32, process_instance: String },
    /// A candidate still runs, but showed no new window in the time watched.
    NoNewWindow,
    /// No candidate still runs.
    NoInstance,
}

/// What the launch does after the wait for its window.
pub(crate) enum AfterWait {
    /// Goes on with this outcome of the wait, as before.
    Window(Result<Option<WindowInfo>, AdapterError>),
    /// Ends with this.
    Outcome(Result<LaunchResult, AdapterError>),
}

#[cfg(target_os = "macos")]
fn read_handoff(
    id: &str,
    initial: &[AppInfo],
    path: &std::path::Path,
    deadline: Deadline,
) -> Handoff {
    let apps = handoff_apps(id, initial, deadline);
    let bundle_id = super::launch_workspace::bundle_identifier(path);
    Handoff {
        same_app_ran: same_app_ran(&apps, bundle_id.as_deref()),
        candidates: handoff_candidates(
            &apps,
            path,
            |pid| {
                super::launch_workspace::resolved_path(id, Some(pid))
                    .and_then(|path| super::launch_location::require(&path))
                    .ok()
            },
            |pid| crate::system::own_window::check_pid(Some(pid)).is_ok(),
            |pid| window_list(pid, deadline),
        ),
    }
}

/// Whether one of `apps` (named by the launch) has the bundle id of the bundle it opens; any of
/// them when that id cannot be read.
pub(crate) fn same_app_ran(apps: &[AppInfo], bundle_id: Option<&str>) -> bool {
    match bundle_id {
        Some(id) => apps.iter().any(|app| {
            app.bundle_id
                .as_deref()
                .is_some_and(|other| other.eq_ignore_ascii_case(id))
        }),
        None => !apps.is_empty(),
    }
}

/// The running apps a launch of `id` may be passed to: those `id` names, and those its name
/// without a `.app` names (the inventory is matched by name or bundle id, not by file name).
#[cfg(target_os = "macos")]
fn handoff_apps(id: &str, initial: &[AppInfo], deadline: Deadline) -> Vec<AppInfo> {
    let mut apps = initial.to_vec();
    if let Some(stem) = id.strip_suffix(".app").filter(|stem| !stem.is_empty()) {
        for app in matching_apps(stem, deadline).unwrap_or_default() {
            if !apps
                .iter()
                .any(|known| known.process_instance == app.process_instance)
            {
                apps.push(app);
            }
        }
    }
    apps
}

/// Whether a window counts as one shown to the user: on screen and not a small helper window.
pub(crate) fn counts_as_shown(on_screen: bool, width: f64, height: f64) -> bool {
    on_screen && width >= MIN_NEW_WINDOW_POINTS && height >= MIN_NEW_WINDOW_POINTS
}

/// Every layer-0 window of a process now (on screen or not), or `None` when they cannot be read.
#[cfg(target_os = "macos")]
fn window_list(pid: i32, deadline: Deadline) -> Option<Vec<WindowSeen>> {
    let records = crate::system::window::cg_window::window_records_until(
        deadline_instant(deadline).ok()?,
        crate::system::window::cg_window::WindowRecordScope::Pid(pid),
    )
    .ok()?;
    Some(
        records
            .into_iter()
            .filter(|record| record.window_number > 0)
            .map(|record| WindowSeen {
                number: record.window_number,
                shown: counts_as_shown(record.visible, record.bounds.width, record.bounds.height),
            })
            .collect(),
    )
}

/// The instances among `apps` a launch of the bundle at `launch_path` may be passed to: each runs
/// from that same bundle (`bundle_path` gives a running process's bundle, only once it passed the
/// checks of the standard places), is allowed (`allowed`: not Sprint Coder itself, as an attach
/// checks), and its windows can be read now.
pub(crate) fn handoff_candidates(
    apps: &[AppInfo],
    launch_path: &std::path::Path,
    mut bundle_path: impl FnMut(i32) -> Option<std::path::PathBuf>,
    mut allowed: impl FnMut(i32) -> bool,
    mut windows: impl FnMut(i32) -> Option<Vec<WindowSeen>>,
) -> Vec<HandoffCandidate> {
    apps.iter()
        .filter_map(|app| {
            let process_instance = app.process_instance.clone()?;
            let pid = i32::try_from(app.pid.get()).ok()?;
            if bundle_path(pid).as_deref() != Some(launch_path) || !allowed(pid) {
                return None;
            }
            Some(HandoffCandidate {
                pid,
                process_instance,
                windows_before: windows(pid)?.iter().map(|window| window.number).collect(),
            })
        })
        .collect()
}

/// Watches the candidates for up to `rounds` looks, `wait` between them: `NewWindow`, naming the
/// candidate, as soon as one that still runs (`alive`) shows (`WindowSeen::shown`) a window it did
/// not have before.
pub(crate) fn watch_handoff(
    candidates: &[HandoffCandidate],
    rounds: usize,
    mut alive: impl FnMut(&HandoffCandidate) -> bool,
    mut windows: impl FnMut(i32) -> Option<Vec<WindowSeen>>,
    mut wait: impl FnMut(),
) -> HandoffWatch {
    let mut seen_alive = false;
    for round in 0..rounds.max(1) {
        if round > 0 {
            wait();
        }
        for candidate in candidates.iter().filter(|candidate| alive(candidate)) {
            seen_alive = true;
            if windows(candidate.pid).is_some_and(|now| {
                now.iter().any(|window| {
                    window.shown && !candidate.windows_before.contains(&window.number)
                })
            }) {
                return HandoffWatch::NewWindow {
                    pid: candidate.pid,
                    process_instance: candidate.process_instance.clone(),
                };
            }
        }
        if !seen_alive {
            return HandoffWatch::NoInstance;
        }
    }
    HandoffWatch::NoNewWindow
}

#[cfg(target_os = "macos")]
fn watch_live(handoff: &Handoff, deadline: Deadline) -> HandoffWatch {
    let watch = HANDOFF_WATCH.min(deadline.remaining());
    let rounds = usize::try_from(watch.as_millis() / HANDOFF_POLL.as_millis()).unwrap_or(1) + 1;
    watch_handoff(
        &handoff.candidates,
        rounds,
        |candidate| {
            super::process::process_identity::matches_instance(
                candidate.pid,
                &candidate.process_instance,
            )
            .unwrap_or(false)
        },
        |pid| window_list(pid, deadline),
        || std::thread::sleep(HANDOFF_POLL.min(deadline.remaining())),
    )
}

/// After `open` failed: a process that exited before it could be identified, on a fresh launch,
/// is judged as a possible hand-off (`after_exit`); any other error is returned as it is.
pub(crate) fn after_open_error(
    error: AdapterError,
    handoff: Option<&Handoff>,
    watch: impl FnOnce(&Handoff) -> HandoffWatch,
    id: &str,
    activate: bool,
) -> Result<LaunchResult, AdapterError> {
    let (Some(handoff), Some(pid)) = (handoff, exited_launch_pid(&error)) else {
        return Err(error);
    };
    after_exit(handoff, watch, id, pid, activate).unwrap_or(Err(error))
}

/// After the wait for the window: on a fresh launch whose wait ended without a window (an error,
/// the grace or the deadline) and whose process is gone (`gone`), judged as a possible hand-off
/// (`after_exit`); otherwise the wait's outcome goes on as before.
#[allow(clippy::too_many_arguments)]
pub(crate) fn after_wait(
    window: Result<Option<WindowInfo>, AdapterError>,
    handoff: Option<&Handoff>,
    gone: impl FnOnce() -> bool,
    watch: impl FnOnce(&Handoff) -> HandoffWatch,
    id: &str,
    launched: &(i32, String),
    activate: bool,
) -> AfterWait {
    let Some(handoff) = handoff else {
        return AfterWait::Window(window);
    };
    if matches!(window, Ok(Some(_))) || !gone() {
        return AfterWait::Window(window);
    }
    match after_exit(handoff, watch, id, launched.0, activate) {
        Some(outcome) => AfterWait::Outcome(outcome),
        None => AfterWait::Window(window),
    }
}

/// The outcome of a fresh launch whose process `pid` exited without a window, or `None` for the
/// launch's own outcome: no instance of the same app ran before it, or the instances it may have
/// been passed to are gone too. An instance of the same bundle id that ran but could not be
/// watched gives the unconfirmed outcome, never a failure that invites a retry.
pub(crate) fn after_exit(
    handoff: &Handoff,
    watch: impl FnOnce(&Handoff) -> HandoffWatch,
    id: &str,
    pid: i32,
    activate: bool,
) -> Option<Result<LaunchResult, AdapterError>> {
    let seen = if handoff.candidates.is_empty() {
        if !handoff.same_app_ran {
            return None;
        }
        HandoffWatch::NoNewWindow
    } else {
        watch(handoff)
    };
    handoff_outcome(seen, id, pid, activate)
}

/// The result for what the watch showed: handed off, not confirmed (delivery uncertain, with
/// guidance not to repeat the launch), or `None` for the launch's own outcome. A hand-off names
/// the running instance that showed the window; `pid` is the launched process's, which has
/// exited, and is only reported with the unconfirmed outcome.
pub(crate) fn handoff_outcome(
    seen: HandoffWatch,
    id: &str,
    pid: i32,
    activate: bool,
) -> Option<Result<LaunchResult, AdapterError>> {
    match seen {
        HandoffWatch::NoInstance => None,
        HandoffWatch::NewWindow {
            pid: instance,
            process_instance,
        } => {
            let instance = agent_desktop_core::ProcessId::try_from(instance).ok()?;
            Some(Ok(handed_off_result(
                id,
                instance,
                Some(process_instance),
                activate,
            )))
        }
        HandoffWatch::NoNewWindow => Some(Err(AdapterError::new(
            ErrorCode::AppUnresponsive,
            "The launched process exited without a window while an instance of the same app runs; whether the launch reached that instance is not confirmed",
        )
        .with_details(serde_json::json!({
            "pid": pid,
            "complete": false,
            "kind": "launch_handoff_unconfirmed",
        }))
        .with_suggestion(HANDOFF_UNCONFIRMED)
        .with_disposition(DeliverySemantics::uncertain()))),
    }
}

/// The started process's pid when `error` says it exited before it presented a window.
pub(crate) fn exited_launch_pid(error: &AdapterError) -> Option<i32> {
    let details = error.details.as_ref()?;
    if details.get("kind").and_then(serde_json::Value::as_str) != Some(LAUNCHED_PROCESS_EXITED) {
        return None;
    }
    details
        .get("pid")
        .and_then(serde_json::Value::as_i64)
        .and_then(|pid| i32::try_from(pid).ok())
        .filter(|pid| *pid > 0)
}

/// A launch passed to the instance that was already running, which showed a new window: that
/// window is not named (which one is the launch's is not proven). `pid` and `process_instance`
/// are that running instance's, never the launched process's (it has exited). With `--activate`,
/// it is not confirmed in front either (`activated: false`, as the field defines it without a
/// window).
pub(crate) fn handed_off_result(
    id: &str,
    pid: agent_desktop_core::ProcessId,
    process_instance: Option<String>,
    activate: bool,
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
        activated: activate.then_some(false),
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
