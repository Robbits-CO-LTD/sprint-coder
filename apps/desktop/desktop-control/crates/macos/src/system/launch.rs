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
        if window.is_some() {
            return Ok(result_from_app(&app, window));
        }
        return attach_without_window(id, &app, &path, pid, &instance, options, deadline);
    }
    let target = launch_target(options, initial.clone()).map_err(before_launch)?;
    // Checked before opening exactly as before (`prepare`, the checks `open` always made).
    let path = super::launch_workspace::prepare(id, deadline)?;
    // Only a fresh start (`--no-attach`, `--url`) may be passed to an instance that runs; for it,
    // the instances it may be passed to are read before it starts. Nothing here refuses the
    // launch: what cannot be read only leaves fewer candidates.
    let handoff = (!options.attach_if_running).then(|| read_handoff(id, &initial, &path, deadline));
    // Such a launch without `--activate` also watches the front while it waits, and gives it back
    // when an instance it may be passed to takes it (`launch_front`); any other launch reads
    // nothing more and waits exactly as before.
    let front =
        super::launch_front::FrontGuard::begin(handoff.as_ref(), options.activate, deadline);
    // Only the validated --url path supplies a bundle allowlist. An explicit --activate
    // has no background guard and retains its normal foreground behavior.
    if !options.activate && !options.bundle_ids.is_empty() {
        super::launch_front::check_browser_toolbar_input(id, &path, &options.bundle_ids, deadline)
            .map_err(before_launch)?;
    }
    let pause = |wait: Duration| super::launch_front::pause(front.as_ref(), wait);

    let launched = match crate::system::launch_workspace::open(id, &path, options, deadline) {
        Err(error) => {
            let outcome = after_open_error(
                error,
                handoff.as_ref(),
                |handoff| {
                    watch_live_pausing(
                        handoff,
                        HANDOFF_WATCH.min(deadline.remaining()),
                        deadline,
                        &pause,
                    )
                },
                id,
                options.activate,
            );
            return super::launch_front::finish(front.as_ref(), outcome);
        }
        Ok(launched) => launched,
    };
    validate_launched_target(&target, &launched).map_err(after_launch)?;
    let window = settled_window(launched.0, &launched.1, options, deadline, &pause);
    // A process that cannot be read is taken as still running.
    let gone_now = || {
        !super::process::process_identity::matches_instance(launched.0, &launched.1).unwrap_or(true)
    };
    let window = match after_wait(
        window,
        handoff.as_ref(),
        |wait_for_exit| {
            if !wait_for_exit {
                return gone_now();
            }
            // The grace a started process already has to show its first window: one that passes
            // the launch on exits within it (16 ms seen with Chrome), and a new instance that
            // runs without a window pays at most this, within the deadline.
            let grace = STARTUP_GRACE.min(deadline.remaining());
            exits_within(watch_rounds(grace), gone_now, || {
                pause(HANDOFF_POLL.min(deadline.remaining()));
            })
        },
        |handoff| {
            watch_live_pausing(
                handoff,
                HANDOFF_WATCH.min(deadline.remaining()),
                deadline,
                &pause,
            )
        },
        id,
        &launched,
        options.activate,
    ) {
        AfterWait::Window(window) => window,
        AfterWait::Outcome(outcome) => {
            return super::launch_front::finish(front.as_ref(), outcome);
        }
    };
    let result = window.map_err(after_launch).and_then(|window| {
        result_from_launched(&launched, window, id, &target, options, deadline)
            .map(|result| {
                let already_running = matches!(target, LaunchTarget::Existing { .. });
                with_other_space_suggestion(
                    result,
                    may_explain_missing_window(options.timeout_ms, already_running),
                    deadline,
                )
            })
            .map_err(after_launch)
    });
    super::launch_front::finish(front.as_ref(), result)
}

/// The attach to the running app `app` (process `pid`, instance `instance`, running from the
/// bundle at `path`, already checked) that has no usable window. When `launch_reopen::may_reopen`
/// allows it (and the windows it shows now can be read), it asks the app once for a window
/// through the same open a background launch uses (`launch_workspace::open`: never activating,
/// the bundle and every running instance of it checked again right before it opens), then waits
/// for the window as a fresh launch does (`settled_window`; a zero timeout looks once and does
/// not wait). Meanwhile `launch_front` watches the front with the app as the one that may take it,
/// as for a hand-off, and gives it back under the same rules; every outcome after the guard
/// began passes through its `finish`. An app that quit just before the open is started anew by
/// it: that ends as the launch that started it.
#[cfg(target_os = "macos")]
fn attach_without_window(
    id: &str,
    app: &AppInfo,
    path: &std::path::Path,
    pid: i32,
    instance: &str,
    options: &LaunchOptions,
    deadline: Deadline,
) -> Result<LaunchResult, AdapterError> {
    use super::launch_reopen as reopen;
    let regular = app.presentation == Some(agent_desktop_core::AppPresentation::Foreground);
    let until = deadline_instant(deadline).ok();
    // Reached only when the attach found no usable window.
    let allowed = reopen::may_reopen(
        options,
        false,
        regular,
        || until.and_then(|until| reopen::read_hidden(pid, until)),
        || {
            until.map_or(reopen::Minimized::Unknown, |until| {
                reopen::read_minimized(pid, until)
            })
        },
    )
    .and_then(|()| {
        reopen::shown_numbers(window_list(pid, deadline)).ok_or(reopen::NotSent::Unknown)
    });
    let chromium =
        |result: &LaunchResult| result.renderer == Some(agent_desktop_core::RendererKind::Chromium);
    let windows_before = match allowed {
        Ok(windows_before) => windows_before,
        Err(not_sent) => {
            let mut result = result_from_app(app, None);
            result.suggestion = reopen::suggestion(
                reopen::Reopen::NotSent(not_sent),
                false,
                || other_space_numbers(pid, deadline),
                chromium(&result),
            );
            return Ok(result);
        }
    };
    let handoff = Handoff {
        candidates: vec![HandoffCandidate {
            pid,
            process_instance: instance.to_owned(),
            windows_before,
        }],
        same_app_ran: true,
        others: Vec::new(),
    };
    // An app already in front (its last window closed while it stayed active) takes nothing
    // from anyone when it shows its window, so that is not counted as a take (`asked`, from the
    // watch's own first read of the front). The front is watched all the same, before and after
    // that window: the user may move to another app during the wait, and the asked app may then
    // take the front from that one.
    let front = super::launch_front::FrontGuard::begin(Some(&handoff), false, deadline);
    if let Some(front) = front.as_ref() {
        front.asked();
    }
    let pause = |wait: Duration| super::launch_front::pause(front.as_ref(), wait);
    let reopen_options = reopen::reopen_options(options);
    let outcome = (|| {
        let launched = crate::system::launch_workspace::open(id, path, &reopen_options, deadline)
            .map_err(reopen::after_open)?;
        let opened = reopen::opened((pid, instance), &launched, || {
            still_runs(pid, Some(instance))
        })
        .map_err(after_launch)?;
        if opened == reopen::Opened::Fresh {
            let window = settled_window(launched.0, &launched.1, &reopen_options, deadline, &pause)
                .map_err(after_launch)?;
            let target = LaunchTarget::New {
                baseline_instances: vec![instance.to_owned()],
            };
            return result_from_launched(&launched, window, id, &target, &reopen_options, deadline)
                .map(|result| {
                    with_other_space_suggestion(
                        result,
                        may_explain_missing_window(options.timeout_ms, false),
                        deadline,
                    )
                })
                .map_err(after_launch);
        }
        let window = settled_window(pid, instance, &reopen_options, deadline, &pause)
            .map_err(|error| reopen::after_request(after_launch(error)))?;
        let has_window = window.is_some();
        let mut result = result_from_app(app, window);
        result.suggestion = reopen::suggestion(
            reopen::Reopen::Sent,
            has_window,
            || other_space_numbers(pid, deadline),
            chromium(&result),
        );
        Ok(result)
    })();
    let mut result = super::launch_front::finish_asked(front.as_ref(), outcome)?;
    // The front may have been given back after the window was read: read where it is now (a
    // front that cannot be read leaves what was read).
    if front.is_some() {
        if let Some(window) = result.window.as_mut() {
            let focused = deadline_instant(deadline)
                .and_then(crate::system::window::window_inventory::focused_window_until);
            if let Ok(focused) = focused {
                window.state.is_focused = focused.is_some_and(|front| {
                    front.id == window.id
                        && front.pid == window.pid
                        && front.process_instance == window.process_instance
                });
            }
        }
    }
    Ok(result)
}

/// The windows of `pid` that are probably on another Space, read once after the wait.
#[cfg(target_os = "macos")]
fn other_space_numbers(pid: i32, deadline: Deadline) -> Option<Vec<i64>> {
    crate::system::window::other_space::read_for_pid(pid, deadline_instant(deadline).ok()?)
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

/// A running instance of the same app that is not a candidate: its process, and its instance
/// token when it has one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SameAppInstance {
    pub(crate) pid: i32,
    pub(crate) process_instance: Option<String>,
}

/// What a fresh launch read before it started, for a hand-off: the instances it may be passed to,
/// whether an instance of the same bundle id ran at all (also when no candidate could be made
/// of it: its bundle or windows could not be read, or it runs from another copy of the bundle),
/// and those instances of the same app that are not candidates (`others`), so a launch whose
/// candidates are gone while one of them may still run is not taken as a failure to retry.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct Handoff {
    pub(crate) candidates: Vec<HandoffCandidate>,
    pub(crate) same_app_ran: bool,
    pub(crate) others: Vec<SameAppInstance>,
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
    let bundle_id = super::launch_workspace::bundle_identifier(path);
    let mut apps = handoff_apps(id, initial, deadline);
    if let Some(bundle_id) = bundle_id.as_deref() {
        // Every running app of that bundle id, whatever its name; what cannot be listed leaves
        // the apps found by name, as before.
        let running = deadline_instant(deadline)
            .and_then(super::app::workspace_apps::list_apps_inventory_until)
            .map(|inventory| inventory.apps)
            .unwrap_or_default();
        apps = with_same_bundle_id(apps, running, bundle_id);
    }
    let candidates = handoff_candidates(
        &apps,
        path,
        |pid| {
            super::launch_workspace::resolved_path(id, Some(pid))
                .and_then(|path| super::launch_location::require(&path))
                .ok()
        },
        |pid| crate::system::own_window::check_pid(Some(pid)).is_ok(),
        |pid| window_list(pid, deadline),
    );
    Handoff {
        same_app_ran: same_app_ran(&apps, bundle_id.as_deref()),
        others: other_instances(&apps, bundle_id.as_deref(), &candidates),
        candidates,
    }
}

/// Whether `app` is of the bundle id the launch opens; any app is when that id cannot be read.
fn is_same_app(app: &AppInfo, bundle_id: Option<&str>) -> bool {
    bundle_id.is_none_or(|id| {
        app.bundle_id
            .as_deref()
            .is_some_and(|other| other.eq_ignore_ascii_case(id))
    })
}

/// Whether one of `apps` (named by the launch, or of its bundle id) has the bundle id of the
/// bundle it opens; any of them when that id cannot be read.
pub(crate) fn same_app_ran(apps: &[AppInfo], bundle_id: Option<&str>) -> bool {
    apps.iter().any(|app| is_same_app(app, bundle_id))
}

/// `apps` (found by name) with every app of `running` that has `bundle_id` and is not among them
/// yet (by pid), so an instance of the same bundle id under another name is known too.
pub(crate) fn with_same_bundle_id(
    mut apps: Vec<AppInfo>,
    running: Vec<AppInfo>,
    bundle_id: &str,
) -> Vec<AppInfo> {
    for app in running {
        if is_same_app(&app, Some(bundle_id)) && !apps.iter().any(|known| known.pid == app.pid) {
            apps.push(app);
        }
    }
    apps
}

/// The instances of the same app among `apps` that are not `candidates`: another copy of the
/// bundle, or one whose bundle, windows or instance token could not be read, or that is refused.
pub(crate) fn other_instances(
    apps: &[AppInfo],
    bundle_id: Option<&str>,
    candidates: &[HandoffCandidate],
) -> Vec<SameAppInstance> {
    apps.iter()
        .filter(|app| is_same_app(app, bundle_id))
        .filter_map(|app| {
            let pid = i32::try_from(app.pid.get()).ok()?;
            let candidate = candidates.iter().any(|candidate| {
                candidate.pid == pid
                    && app.process_instance.as_deref() == Some(candidate.process_instance.as_str())
            });
            (!candidate).then(|| SameAppInstance {
                pid,
                process_instance: app.process_instance.clone(),
            })
        })
        .collect()
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
pub(crate) fn window_list(pid: i32, deadline: Deadline) -> Option<Vec<WindowSeen>> {
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
/// candidate, as soon as one that still runs (`alive` is `Some(true)`) shows
/// (`WindowSeen::shown`) a window it did not have before. A candidate whose process cannot be read
/// (`alive` is `None`) may still run, so it keeps the watch from ending in `NoInstance`, but its
/// windows are not read: one that is not proven to be that instance never names a hand-off.
pub(crate) fn watch_handoff(
    candidates: &[HandoffCandidate],
    rounds: usize,
    mut alive: impl FnMut(&HandoffCandidate) -> Option<bool>,
    mut windows: impl FnMut(i32) -> Option<Vec<WindowSeen>>,
    mut wait: impl FnMut(),
) -> HandoffWatch {
    let mut seen_alive = false;
    for round in 0..rounds.max(1) {
        if round > 0 {
            wait();
        }
        for candidate in candidates {
            match alive(candidate) {
                Some(false) => continue,
                None => {
                    seen_alive = true;
                    continue;
                }
                Some(true) => seen_alive = true,
            }
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

/// The looks a watch of `watch` makes, one every `HANDOFF_POLL`, the first at once.
#[cfg(target_os = "macos")]
fn watch_rounds(watch: Duration) -> usize {
    usize::try_from(watch.as_millis() / HANDOFF_POLL.as_millis()).unwrap_or(1) + 1
}

/// Whether the process is gone (`gone`) within `rounds` looks, `wait` between them.
pub(crate) fn exits_within(
    rounds: usize,
    mut gone: impl FnMut() -> bool,
    mut wait: impl FnMut(),
) -> bool {
    for round in 0..rounds.max(1) {
        if round > 0 {
            wait();
        }
        if gone() {
            return true;
        }
    }
    false
}

/// What the watch showed, except that `NoInstance` (no candidate runs) becomes `NoNewWindow`
/// while another instance of the same app may still run (`runs` is not `Some(false)`; one without
/// an instance token cannot be read): the launch may have been passed to it.
pub(crate) fn unless_another_runs(
    seen: HandoffWatch,
    others: &[SameAppInstance],
    mut runs: impl FnMut(&SameAppInstance) -> Option<bool>,
) -> HandoffWatch {
    if seen == HandoffWatch::NoInstance && others.iter().any(|other| runs(other) != Some(false)) {
        return HandoffWatch::NoNewWindow;
    }
    seen
}

/// Whether the process `pid` with the instance token `instance` still runs, or `None` when that
/// cannot be read (or there is no token).
#[cfg(target_os = "macos")]
fn still_runs(pid: i32, instance: Option<&str>) -> Option<bool> {
    super::process::process_identity::matches_instance(pid, instance?).ok()
}

/// `watch_live_pausing` with plain sleeps between its looks.
#[cfg(all(target_os = "macos", test))]
fn watch_live(handoff: &Handoff, watch: Duration, deadline: Deadline) -> HandoffWatch {
    watch_live_pausing(handoff, watch, deadline, &std::thread::sleep)
}

/// The live watch, waiting between its looks with `pause` (which reads the front meanwhile when
/// the launch watches it).
#[cfg(target_os = "macos")]
fn watch_live_pausing(
    handoff: &Handoff,
    watch: Duration,
    deadline: Deadline,
    pause: &dyn Fn(Duration),
) -> HandoffWatch {
    let seen = watch_handoff(
        &handoff.candidates,
        watch_rounds(watch),
        |candidate| still_runs(candidate.pid, Some(&candidate.process_instance)),
        |pid| window_list(pid, deadline),
        || pause(HANDOFF_POLL.min(deadline.remaining())),
    );
    unless_another_runs(seen, &handoff.others, |other| {
        still_runs(other.pid, other.process_instance.as_deref())
    })
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
/// (`after_exit`); otherwise the wait's outcome goes on as before. `gone` is given `true` when
/// the launch may be passed on (`may_be_passed_on`): it then waits a short while for a process
/// that is still running to exit (one passing the launch on may exit just after the wait). A
/// launch that cannot be passed on (no instance of the same app ran) is not slowed.
#[allow(clippy::too_many_arguments)]
pub(crate) fn after_wait(
    window: Result<Option<WindowInfo>, AdapterError>,
    handoff: Option<&Handoff>,
    gone: impl FnOnce(bool) -> bool,
    watch: impl FnOnce(&Handoff) -> HandoffWatch,
    id: &str,
    launched: &(i32, String),
    activate: bool,
) -> AfterWait {
    let Some(handoff) = handoff else {
        return AfterWait::Window(window);
    };
    if matches!(window, Ok(Some(_))) || !gone(may_be_passed_on(handoff)) {
        return AfterWait::Window(window);
    }
    match after_exit(handoff, watch, id, launched.0, activate) {
        Some(outcome) => AfterWait::Outcome(outcome),
        None => AfterWait::Window(window),
    }
}

/// Whether a fresh launch may be passed to an instance that runs: there are candidates, or an
/// instance of the same app ran that could not be made one (it gives the unconfirmed outcome).
fn may_be_passed_on(handoff: &Handoff) -> bool {
    !handoff.candidates.is_empty() || handoff.same_app_ran
}

/// The outcome of a fresh launch whose process `pid` exited without a window, or `None` for the
/// launch's own outcome: no instance of the same app ran before it, or the instances it may have
/// been passed to are gone too (and no other instance of the same app may still run, as `watch`
/// tells). An instance of the same bundle id that ran but could not be watched gives the
/// unconfirmed outcome, never a failure that invites a retry.
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
    pause: &dyn Fn(Duration),
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
        pause(poll_interval.min(remaining));
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

/// Whether a launch without a window may say its window is probably on another Space: only when
/// the app was already running, or the launch waited for a window (a zero `timeout_ms` returns
/// at once, when a just-started app may not have shown its window yet).
pub(crate) fn may_explain_missing_window(timeout_ms: u64, already_running: bool) -> bool {
    already_running || timeout_ms != 0
}

/// A launch that ends without a window, while the app has a window that is probably on another
/// Space (the user is in a full-screen app, say), says so instead of saying nothing. Read once,
/// after the wait, and only when the result has no window and no other guidance.
#[cfg(target_os = "macos")]
fn with_other_space_suggestion(
    mut result: LaunchResult,
    may_explain: bool,
    deadline: Deadline,
) -> LaunchResult {
    if !may_explain || result.window.is_some() || result.suggestion.is_some() {
        return result;
    }
    let (Ok(pid), Ok(until)) = (
        super::process::process_identity::to_pid_t(result.pid),
        deadline_instant(deadline),
    ) else {
        return result;
    };
    result.suggestion = crate::system::window::other_space::read_for_pid(pid, until)
        .and_then(|numbers| crate::system::window::other_space::launch_suggestion(&numbers, None));
    result
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
