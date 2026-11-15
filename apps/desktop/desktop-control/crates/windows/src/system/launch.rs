// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use agent_desktop_core::{
    AdapterError, Deadline, DeliverySemantics, ErrorCode, ProcessId, RendererKind, WindowFilter,
    WindowInfo, system::launch_options::LaunchOptions, system::launch_result::LaunchResult,
};
#[cfg(test)]
use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

#[cfg(test)]
use self::launch_attach::matching_processes;
use self::launch_attach::prepare;
use super::launch_path::{
    child_environment_block, image_file_name, launch_identifier, validate_launch_options,
};
use super::process_identity;
#[cfg(target_os = "windows")]
use super::runtime::hresult::win32_last_error;
use super::window::window_ops::list_windows_live;

pub(crate) fn launch_app_impl(
    id: &str,
    options: &LaunchOptions,
    parent_deadline: Deadline,
) -> Result<LaunchResult, AdapterError> {
    let id = &launch_identifier(id).map_err(before_launch)?;
    validate_launch_options(options).map_err(before_launch)?;
    let deadline = if options.timeout_ms == 0 {
        parent_deadline
    } else {
        parent_deadline.capped(Duration::from_millis(options.timeout_ms))
    };
    deadline.ensure_remaining().map_err(before_launch)?;
    let prepared = prepare(id, options, deadline).map_err(before_launch)?;
    if let Some(mut attached) = prepared.attached {
        bring_forward_if_asked(&mut attached, options.activate, deadline);
        return Ok(attached);
    }
    // Read before anything starts, so a window the running instance opens
    // for this launch can be told apart from the ones it already had.
    let handoff = launch_handoff::Handoff::begin(prepared.running);
    let input_clock = input_clock_now();
    // One clock for the watch and the guard, so both read the same input.
    let guard = ForegroundGuard::begin(options.activate, input_clock);
    let (pid, token, process) = create_process(&prepared.executable, options, deadline)?;
    let lineage = launch_handoff::Lineage::new(pid, &token, process);
    let observed = observe_launched_window(
        pid,
        &token,
        lineage,
        &handoff,
        options,
        deadline,
        input_clock,
    )?;
    let mut left_for_user = false;
    if let Some(guard) = guard {
        let settle = (observed.handed_off && observed.window.is_some()).then_some(HandoffSettle {
            deadline,
            shown_at: observed.shown_at,
            // The instance's one visible window, not seen to move: it is left
            // where it is in the window order.
            restack: observed.existing != Some(launch_attach::ExistingWindow::Only),
        });
        left_for_user = guard.finish(&observed.owners, observed.window.as_ref(), settle);
    }
    let new_instance = observed.window.is_some() && !observed.handed_off;
    let mut result = launch_result(id, pid, token, observed.window);
    result.new_instance = new_instance;
    if observed.exited_without_window {
        // A descendant still running may yet show the window, so the launch
        // is taken as passed on only when none is left.
        let handed_off =
            observed.handed_off || (handoff.any_running() && !observed.descendants_alive);
        result.attached = handed_off;
        result.handed_off = handed_off;
        result.suggestion = Some(
            match (
                handed_off,
                result.window.is_some(),
                observed.handoff_ambiguous,
            ) {
                (true, true, _) => match observed.existing {
                    Some(kind) => launch_attach::existing_window_guidance(kind),
                    None => launch_attach::HANDED_OFF_NEW_WINDOW.to_string(),
                },
                (true, false, true) => launch_attach::HANDED_OFF_AMBIGUOUS.to_string(),
                (true, false, false) => launch_attach::HANDED_OFF.to_string(),
                (false, _, _) => launch_handoff::EXITED_WITHOUT_WINDOW.to_string(),
            },
        );
    }
    result.running_without_window = prepared.running_without_window;
    result.existing_window = observed.existing.is_some() && result.window.is_some();
    bring_forward_if_asked(&mut result, options.activate, deadline);
    report_foreground(&mut result, options.activate, left_for_user);
    Ok(result)
}

/// Makes `window.is_focused` the fact when the launch returns (it was read
/// when the window was found, before the foreground was handed back), and,
/// without `--activate`, says so when a window the running instance showed
/// stayed in front although the launch tried to keep it behind.
fn report_foreground(result: &mut LaunchResult, activate: bool, left_for_user: bool) {
    let in_front = result.window.as_ref().is_some_and(is_foreground);
    apply_foreground_fact(result, activate, in_front, left_for_user);
}

/// `left_for_user`: the watch stopped because the move may have been the
/// user's (a click or Alt+Tab on the window). A window in front then gets no
/// note: saying the app took the front would be wrong when the user did, and
/// the user who did knows. The note is kept for a window the launch tried to
/// hand back and could not.
fn apply_foreground_fact(
    result: &mut LaunchResult,
    activate: bool,
    in_front: bool,
    left_for_user: bool,
) {
    let Some(window) = result.window.as_mut() else {
        return;
    };
    window.state.is_focused = in_front;
    if !activate && in_front && result.handed_off && !left_for_user {
        let note = launch_attach::HANDED_OFF_LEFT_IN_FRONT;
        result.suggestion = Some(match result.suggestion.take() {
            Some(text) => format!("{text} {note}"),
            None => note.to_string(),
        });
    }
}

/// With `--activate`, brings the result's window to the front and records
/// whether it is there (`activated`). Before, `--activate` only skipped
/// keeping the window behind, so a window the app did not raise itself (one
/// a running instance showed for a single-instance app, or the window a
/// launch attached to) stayed behind although the caller asked for it in
/// front. Windows may refuse the foreground to this process (it may take it
/// only while the user's last input went to the process that started it);
/// then `activated` is `false` and nothing else is tried.
fn bring_forward_if_asked(result: &mut LaunchResult, activate: bool, deadline: Deadline) {
    if !activate {
        return;
    }
    result.activated = Some(
        result
            .window
            .as_ref()
            .is_some_and(|window| bring_forward(window, deadline)),
    );
}

#[cfg(target_os = "windows")]
fn bring_forward(window: &WindowInfo, deadline: Deadline) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, IsIconic, SW_RESTORE, SetForegroundWindow, ShowWindowAsync,
    };
    let handle = super::window::window_ops::parse_handle(&window.id);
    // Only the window the result names, still owned by the process it names.
    if handle.is_null() || !window_is_owned_by(handle, &[window.pid]) {
        return false;
    }
    if unsafe { GetForegroundWindow() } == handle {
        return true;
    }
    if unsafe { IsIconic(handle) } != 0 {
        unsafe { ShowWindowAsync(handle, SW_RESTORE) };
    }
    unsafe { SetForegroundWindow(handle) };
    // The switch can land a moment after the call returns.
    let until = std::time::Instant::now() + Duration::from_millis(500).min(deadline.remaining());
    loop {
        if unsafe { GetForegroundWindow() } == handle {
            return true;
        }
        if std::time::Instant::now() >= until {
            return false;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(not(target_os = "windows"))]
fn bring_forward(_window: &WindowInfo, _deadline: Deadline) -> bool {
    false
}

/// What watching a fresh launch found: the window, if one can be tied to the
/// launch; the processes that may own it (the launched one, then any
/// descendant once it exited, and the running instance whose new window was
/// taken); whether the launched process exited with no window of its own or
/// of a descendant; and whether the window is the running instance's.
/// `handoff_ambiguous` is set when several windows the running instances
/// showed could be the one asked for, so none was taken; `descendants_alive`
/// when the watch ended with a descendant of the launch still running, so the
/// launch is not taken as passed to the running instance.
struct LaunchObservation {
    window: Option<WindowInfo>,
    owners: Vec<ProcessId>,
    exited_without_window: bool,
    handed_off: bool,
    handoff_ambiguous: bool,
    descendants_alive: bool,
    /// For a handed-off window: when it was first seen (see
    /// `Handoff::note`), the start of [`HANDOFF_APP_ACTIVATION_GRACE`]. For
    /// a window the instance already had: when the launched process was seen
    /// to have exited (it hands the launch over just before).
    shown_at: Option<std::time::Instant>,
    /// `Some` when the window is one the instance already had before the
    /// launch (`existing_window`), and how it came to be named.
    existing: Option<launch_attach::ExistingWindow>,
}

impl LaunchObservation {
    fn none(lineage: &launch_handoff::Lineage, exited: bool) -> Self {
        Self {
            window: None,
            owners: lineage.pids(),
            exited_without_window: exited,
            handed_off: false,
            handoff_ambiguous: false,
            descendants_alive: false,
            shown_at: None,
            existing: None,
        }
    }
}

/// The observation for a window the running instance already showed before
/// the launch (see `LaunchObservation::existing`).
fn existing_window_observation(
    lineage: &launch_handoff::Lineage,
    window: WindowInfo,
    shown_at: Option<std::time::Instant>,
    kind: launch_attach::ExistingWindow,
) -> LaunchObservation {
    let mut owners = lineage.pids();
    owners.push(window.pid);
    LaunchObservation {
        window: Some(window),
        owners,
        exited_without_window: true,
        handed_off: true,
        handoff_ambiguous: false,
        descendants_alive: false,
        shown_at,
        existing: Some(kind),
    }
}

/// Whether a window the instance already had, now in front, came forward
/// within [`HANDOFF_APP_ACTIVATION_GRACE`] of the launched process being
/// seen to exit: soon enough to be the instance answering the hand-over.
/// Compiled wherever `observe_launched_window` is, as `within_grace` is.
fn launch_window_existing_in_grace(exited_at: std::time::Instant) -> bool {
    within_grace(Some(exited_at), std::time::Instant::now())
}

/// Whether a window the instance already had, now in front, is taken as
/// brought forward by the instance for this launch: only within the grace
/// after the launched process was seen to exit, and only when it was not
/// already in front while that process still ran (the user may have picked
/// it then; it is left in front and in its place).
fn counts_as_raised(within_grace_of_exit: bool, in_front_before_exit: bool) -> bool {
    within_grace_of_exit && !in_front_before_exit
}

/// How a window the instance already had, found in front after the launched
/// process exited (`HandoffRead::raised`), is taken (#1297).
///
/// Which window came forward and who brought it forward are two questions.
/// The first is a fact the watch saw: a window of the instance that was not
/// in front when the launch began is in front now. The second decides only
/// whether the foreground is handed back. Chrome brings its profile picker
/// forward while its launcher still runs (about a second before it exits),
/// so a window that came forward before the exit or later than the grace is
/// not proof that the user picked it: without the user's input since the
/// launch began, nobody but the app can have moved it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RaisedTake {
    /// Within the grace of the exit, and not in front before it: the app's
    /// move even with input, timed from the exit (`ExistingWindow::Raised`).
    InGrace,
    /// No input since the launch began: the app's move, taken at once and
    /// handed back by the no-input rule (`ExistingWindow::Raised`, no grace).
    WithoutInput,
    /// With input, the user may have picked it: it is kept as the answer
    /// only if no new window appears before the watch ends, and never handed
    /// back nor restacked while the input says it may be the user's
    /// (`ExistingWindow::CameForward`).
    MaybeUser,
}

fn raised_take(
    within_grace_of_exit: bool,
    in_front_before_exit: bool,
    user_input: bool,
) -> RaisedTake {
    if counts_as_raised(within_grace_of_exit, in_front_before_exit) {
        RaisedTake::InGrace
    } else if !user_input {
        RaisedTake::WithoutInput
    } else {
        RaisedTake::MaybeUser
    }
}

/// What a watch that ends without a new window names, for a launch passed to
/// the running instance: a window of the instance that came to the front
/// during the launch (with input: it may be the user's pick), else the
/// instance's only visible window, else none.
fn existing_at_the_end(
    lineage: &launch_handoff::Lineage,
    came_forward: Option<WindowInfo>,
    only_existing: Option<WindowInfo>,
) -> Option<LaunchObservation> {
    if let Some(window) = came_forward {
        return Some(existing_window_observation(
            lineage,
            window,
            None,
            launch_attach::ExistingWindow::CameForward,
        ));
    }
    // Not seen to move for the launch: no grace, so with the user's input
    // its being in front is left alone.
    only_existing.map(|window| {
        existing_window_observation(lineage, window, None, launch_attach::ExistingWindow::Only)
    })
}

/// A window kept as `came_forward` stays a candidate only while the latest
/// read still shows it for the same process instance: one closed during the
/// wait, or whose instance ended (`read` is `None`), is dropped, so the end
/// of the watch never names a window that is gone (it falls back to the
/// latest `only_existing`, else to no window).
fn came_forward_after_read(
    kept: Option<WindowInfo>,
    read: Option<&launch_handoff::HandoffRead>,
) -> Option<WindowInfo> {
    kept.filter(|window| read.is_some_and(|read| read.still_shows(window)))
}

/// `GetTickCount` now, to tell the user's input after the launch began;
/// `None` where it cannot be read, which counts as input.
#[cfg(target_os = "windows")]
fn input_clock_now() -> Option<u32> {
    Some(unsafe { windows_sys::Win32::System::SystemInformation::GetTickCount() })
}

#[cfg(not(target_os = "windows"))]
fn input_clock_now() -> Option<u32> {
    None
}

/// Whether the user gave input since `started` (see `user_input_since`);
/// unknown reads as input, the side that leaves the foreground alone.
fn input_since(started: Option<u32>) -> bool {
    #[cfg(target_os = "windows")]
    {
        started.is_none_or(user_input_since)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = started;
        true
    }
}
/// Watches a process this launch created for its window. While the process
/// runs, only its own window counts, exactly as before. Once it has exited, a
/// window of a live descendant counts instead (see `launch_handoff`), and a
/// live descendant is waited for until the deadline, as before. While an
/// instance of the same executable that ran before the launch still runs, a
/// window that instance showed after the launch started counts too, when it
/// is the only such window ([`launch_handoff::HandoffLook`]); without a live
/// descendant that watch lasts at most [`launch_handoff::HANDOFF_WINDOW_WAIT`].
/// With nothing to watch, the watch ends at once instead of at the deadline.
fn observe_launched_window(
    pid: ProcessId,
    process_instance: &str,
    mut lineage: launch_handoff::Lineage,
    handoff: &launch_handoff::Handoff,
    options: &LaunchOptions,
    deadline: Deadline,
    input_clock: Option<u32>,
) -> Result<LaunchObservation, AdapterError> {
    let mut poll_interval = Duration::from_millis(50);
    let mut handoff_deadline: Option<Deadline> = None;
    let mut exited_at: Option<std::time::Instant> = None;
    // A window of the instance that came to the front during the launch
    // while the user gave input: named only if no new window appears.
    let mut came_forward: Option<WindowInfo> = None;
    loop {
        if let Some(window) = observe_window_once(pid, process_instance, deadline)? {
            return Ok(LaunchObservation {
                window: Some(window),
                owners: vec![pid],
                exited_without_window: false,
                handed_off: false,
                handoff_ambiguous: false,
                descendants_alive: false,
                shown_at: None,
                existing: None,
            });
        }
        let exited = lineage.launched_has_exited();
        if !exited && handoff.any_running() {
            // Only to record when each window an instance shows is first seen;
            // whether the launch was passed on is still decided only once the
            // launched process has exited. A failed read records nothing.
            let _ = handoff.note(deadline);
        }
        let mut wait_until = deadline;
        let mut descendants_alive = false;
        let mut only_existing = None;
        if exited {
            let exited_at = *exited_at.get_or_insert_with(std::time::Instant::now);
            lineage.refresh();
            let live = lineage.live_descendants();
            descendants_alive = !live.is_empty();
            if descendants_alive {
                let window =
                    launch_handoff::descendant_window(&live, deadline).map_err(after_launch)?;
                if window.is_some() {
                    return Ok(LaunchObservation {
                        window,
                        owners: lineage.pids(),
                        exited_without_window: false,
                        handed_off: false,
                        handoff_ambiguous: false,
                        descendants_alive: false,
                        shown_at: None,
                        existing: None,
                    });
                }
            }
            let instance_runs = handoff.any_running();
            if instance_runs {
                let read = handoff.read(deadline).map_err(after_launch)?;
                came_forward = came_forward_after_read(came_forward, Some(&read));
                match read.look {
                    launch_handoff::HandoffLook::One(window) => {
                        let mut owners = lineage.pids();
                        owners.push(window.pid);
                        let shown_at = handoff.first_seen(&window.id);
                        // A handle that existed before the launch, hidden, is a
                        // window the instance already had and showed again (a
                        // tray app's main window), not one this launch opened.
                        let existing = handoff
                            .existed_before(&window.id)
                            .then_some(launch_attach::ExistingWindow::Revealed);
                        return Ok(LaunchObservation {
                            window: Some(window),
                            owners,
                            exited_without_window: true,
                            handed_off: true,
                            handoff_ambiguous: false,
                            descendants_alive: false,
                            shown_at,
                            existing,
                        });
                    }
                    // Several candidates: none is taken, nor restacked.
                    launch_handoff::HandoffLook::Several => {
                        return Ok(LaunchObservation {
                            handed_off: true,
                            handoff_ambiguous: true,
                            ..LaunchObservation::none(&lineage, true)
                        });
                    }
                    launch_handoff::HandoffLook::None => {}
                }
                // A window the instance already had, now in front though it
                // was not when the launch began: the app used it instead of
                // opening one (see `RaisedTake`). Just as the launch was
                // handed over, or with no input since the launch began, it is
                // the app's move. Otherwise (it came forward while the
                // launched process still ran, or later, and the user gave
                // input) it may be the user's pick: it is named only when no
                // new window appears, and left where it is.
                if let Some(window) = read.raised {
                    let take = raised_take(
                        launch_window_existing_in_grace(exited_at),
                        handoff.was_in_front_before_exit(&window.id),
                        input_since(input_clock),
                    );
                    match take {
                        RaisedTake::InGrace | RaisedTake::WithoutInput => {
                            let shown_at = (take == RaisedTake::InGrace).then_some(exited_at);
                            return Ok(existing_window_observation(
                                &lineage,
                                window,
                                shown_at,
                                launch_attach::ExistingWindow::Raised,
                            ));
                        }
                        RaisedTake::MaybeUser => came_forward = Some(window),
                    }
                }
                only_existing = read.only_existing;
                let handoff_until = *handoff_deadline
                    .get_or_insert_with(|| deadline.capped(launch_handoff::HANDOFF_WINDOW_WAIT));
                // A live descendant keeps the whole deadline (a launcher whose
                // GUI child is slow to show its window); only without one is
                // the watch held to the short handoff wait.
                if !descendants_alive {
                    wait_until = handoff_until;
                }
            } else {
                // The instance ended: its window is gone with it.
                came_forward = came_forward_after_read(came_forward, None);
            }
            let wait_over = wait_until.remaining().is_zero();
            if launch_handoff::after_exit(descendants_alive, instance_runs, wait_over)
                == launch_handoff::AfterExit::Stop
            {
                if !descendants_alive
                    && let Some(observation) =
                        existing_at_the_end(&lineage, came_forward.take(), only_existing.take())
                {
                    return Ok(observation);
                }
                return Ok(LaunchObservation {
                    descendants_alive,
                    ..LaunchObservation::none(&lineage, true)
                });
            }
        }
        if !should_poll_after_first_observation(options.timeout_ms)
            || wait_until.remaining().is_zero()
        {
            if exited
                && !descendants_alive
                && let Some(observation) =
                    existing_at_the_end(&lineage, came_forward.take(), only_existing.take())
            {
                return Ok(observation);
            }
            return Ok(LaunchObservation {
                descendants_alive,
                ..LaunchObservation::none(&lineage, exited)
            });
        }
        std::thread::sleep(poll_interval.min(wait_until.remaining()));
        // Looked at more often while a running instance may get the launch,
        // so the handed-off window is found soon after it appears (see
        // `HANDOFF_APP_ACTIVATION_GRACE`).
        let cap = if handoff.any_running() { 100 } else { 250 };
        poll_interval = (poll_interval * 3 / 2).min(Duration::from_millis(cap));
    }
}

/// Keeps a launch without `--activate` in the background.
///
/// A process started by a process that may set the foreground inherits that
/// right, so the launched app's first window took the foreground and the
/// user's keystrokes went to it. Starting the app hidden or minimized is not
/// an answer, because later reads (snapshot, screenshot) need a shown window.
/// So the foreground is locked while the app starts (`LockSetForegroundWindow`;
/// Windows also drops the lock when this process exits), and the launched
/// window is then placed just below the window that was in front before the
/// launch. If the app still took the foreground in the moment between the
/// unlock and the check, the foreground is handed back. If the foreground
/// moved off that window while the lock held, the user moved it, so neither
/// step runs (see `may_restore_foreground`), unless the window a running
/// instance showed for the launch took it itself while the user gave no
/// input (see `foreground_step`). For such a window the foreground
/// is also held and watched for a short while, because the instance may
/// activate it after the launch would otherwise have returned (see
/// [`HANDOFF_FOREGROUND_HOLD`]). The hand-back calls `SetForegroundWindow`
/// directly: it never goes through the adapter's `focus_window`, whose
/// refusal of Sprint Coder's own windows does not apply to giving the
/// foreground back to the window that had it.
#[cfg(target_os = "windows")]
struct ForegroundGuard {
    prior: windows_sys::Win32::Foundation::HWND,
    locked: bool,
    /// `GetTickCount` when the launch began, to tell the user's input
    /// after it (`user_input_since`).
    started: u32,
}

#[cfg(target_os = "windows")]
impl ForegroundGuard {
    /// `started` is the launch's input clock (`input_clock_now`).
    fn begin(activate: bool, started: Option<u32>) -> Option<Self> {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetForegroundWindow, LSFW_LOCK, LockSetForegroundWindow,
        };
        if activate {
            return None;
        }
        let started = started.unwrap_or_else(|| unsafe {
            windows_sys::Win32::System::SystemInformation::GetTickCount()
        });
        let prior = unsafe { GetForegroundWindow() };
        let locked = unsafe { LockSetForegroundWindow(LSFW_LOCK) } != 0;
        Some(Self {
            prior,
            locked,
            started,
        })
    }

    /// `owners` are the processes the launch is tied to: the launched one,
    /// and its descendants when the window came from one of them, or the
    /// running instance whose window was taken. `settle` is given for a
    /// window a running instance showed (`handed_off`): see
    /// [`HANDOFF_FOREGROUND_HOLD`].
    fn finish(
        mut self,
        owners: &[ProcessId],
        window: Option<&WindowInfo>,
        settle: Option<HandoffSettle>,
    ) -> bool {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GWL_EXSTYLE, GetForegroundWindow, GetShellWindow, GetWindowLongW, IsIconic, IsWindow,
            SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE,
            SetForegroundWindow, SetWindowPos, WS_EX_TOPMOST,
        };
        let foreground = unsafe { GetForegroundWindow() };
        let prior = self.prior;
        let started = self.started;
        // For a handed-off window only that window itself counts as the app's
        // move, judged with the user's input and the time since it appeared
        // (see `foreground_step`). A running instance may also take the
        // foreground through the lock (an app that synthesizes input drops
        // it): `Restore` then undoes that too.
        let handed = settle
            .and(window)
            .map(|window| super::window::window_ops::parse_handle(&window.id))
            .unwrap_or(std::ptr::null_mut());
        let step = |foreground: windows_sys::Win32::Foundation::HWND, settle: HandoffSettle| {
            foreground_step(
                foreground.is_null(),
                foreground == prior,
                !handed.is_null() && foreground == handed,
                user_input_since(started),
                within_grace(settle.shown_at, std::time::Instant::now()),
            )
        };
        let prior_is_minimized = unsafe { IsIconic(prior) } != 0;
        // Whether the watch left the foreground alone as possibly the user's
        // choice: then a window in front is not reported as the app's doing.
        // A hand-back that was tried and never seen to work is not that.
        let mut hand_back = HandBack::default();
        let mut left_for_user = false;
        let mut may_restore = match settle {
            Some(settle) => {
                let action = hand_back.observe(
                    step(foreground, settle),
                    foreground == prior,
                    !handed.is_null() && foreground == handed,
                );
                left_for_user = action == WatchAction::StopForUser;
                // A first read that says hand back is done by the hold below.
                !matches!(action, WatchAction::StopForUser | WatchAction::StopFailed)
                    && !prior_is_minimized
            }
            None => may_restore_foreground(foreground == prior, prior_is_minimized),
        };
        if prior.is_null() || unsafe { IsWindow(prior) } == 0 {
            may_restore = false;
        }
        if may_restore && let Some(settle) = settle {
            // Held locked, the instance's first activation fails, and an app
            // gets only that one (#1276).
            let end = settle_foreground(
                prior,
                handed,
                self.started,
                settle,
                HANDOFF_FOREGROUND_HOLD,
                &mut hand_back,
            );
            may_restore = end == WatchAction::Wait;
            left_for_user = end == WatchAction::StopForUser;
        }
        self.unlock();
        if !may_restore {
            return left_for_user;
        }
        // A handed-off window is handed back by the watch below, whose first
        // read comes right after the restack.
        let foreground = unsafe { GetForegroundWindow() };
        if settle.is_none() && foreground != prior && window_is_owned_by(foreground, owners) {
            unsafe { SetForegroundWindow(prior) };
        }
        if let Some(window) = window {
            let handle = super::window::window_ops::parse_handle(&window.id);
            let prior_is_topmost =
                unsafe { GetWindowLongW(prior, GWL_EXSTYLE) } as u32 & WS_EX_TOPMOST != 0;
            // Below the desktop's own window the launched window would be
            // hidden behind the desktop: it stays where it is, behind the
            // foreground handed back to the desktop.
            let prior_is_desktop = prior == unsafe { GetShellWindow() };
            if settle.is_none_or(|settle| settle.restack)
                && !handle.is_null()
                && handle != prior
                && !prior_is_topmost
                && !prior_is_desktop
                && window_is_owned_by(handle, owners)
            {
                unsafe {
                    SetWindowPos(
                        handle,
                        prior,
                        0,
                        0,
                        0,
                        0,
                        SWP_ASYNCWINDOWPOS
                            | SWP_NOMOVE
                            | SWP_NOSIZE
                            | SWP_NOACTIVATE
                            | SWP_NOOWNERZORDER,
                    )
                };
            }
        }
        if let Some(settle) = settle {
            let end = settle_foreground(
                prior,
                handed,
                self.started,
                settle,
                HANDOFF_FOREGROUND_WATCH,
                &mut hand_back,
            );
            left_for_user = end == WatchAction::StopForUser;
        }
        left_for_user
    }

    fn unlock(&mut self) {
        use windows_sys::Win32::UI::WindowsAndMessaging::{LSFW_UNLOCK, LockSetForegroundWindow};
        if std::mem::take(&mut self.locked) {
            unsafe { LockSetForegroundWindow(LSFW_UNLOCK) };
        }
    }
}

/// How long, after a running instance showed the window a launch was passed
/// to, the foreground stays locked and watched, and how long it is watched
/// after the lock is dropped.
///
/// An instance shows that window from its own message handling and often
/// activates it a moment later, after the launch already returned (measured
/// with a probe that activates 800 ms after showing: the old guard had
/// unlocked by then and the probe took the foreground). An app gets only its
/// first activation (#1276): one that fails while the lock holds does not
/// come back, so the hold covers the activation that follows the show. The
/// watch after it catches an app that takes the foreground anyway (one that
/// synthesizes input drops the lock) and hands the foreground back. Both stay
/// inside the launch's deadline; 2 seconds in all is the price, paid only by
/// a launch passed to a running instance without `--activate`.
pub(crate) const HANDOFF_FOREGROUND_HOLD: Duration = Duration::from_millis(1_200);
pub(crate) const HANDOFF_FOREGROUND_WATCH: Duration = Duration::from_millis(800);

/// How soon after the handed-off window was first seen that window may
/// take the foreground and still be taken as the app's move while the user is
/// giving input.
///
/// A user picks a window by clicking it or by Alt+Tab, and either needs the
/// window first seen: a visual reaction alone takes about 200 ms, and aiming
/// at and clicking a window that just appeared, or reaching it through
/// Alt+Tab, takes well over that. An app that activates its window together
/// with showing it does so within the same message handling, tens of
/// milliseconds. 300 ms sits between the two. The clock starts when the
/// window was first seen (`Handoff::note`), read every 100 ms at most while
/// the launched process still runs and after it exited, not when the launch
/// found it had been passed on (which can be seconds later, when the launched
/// process is slow to exit): so the clock starts at most one look interval
/// (100 ms) plus one window listing after the window appeared.
pub(crate) const HANDOFF_APP_ACTIVATION_GRACE: Duration = Duration::from_millis(300);

/// When the handed-off window was first seen (`None` when it is not known),
/// and the deadline the watch on its foreground stays inside.
#[derive(Debug, Clone, Copy)]
struct HandoffSettle {
    deadline: Deadline,
    shown_at: Option<std::time::Instant>,
    /// Whether the window may be put back below the window that was in front.
    restack: bool,
}

/// Whether `now` is within [`HANDOFF_APP_ACTIVATION_GRACE`] of when the
/// window was first seen. A window whose first sight is not known gets no
/// grace: with the user's input, its taking the foreground is left alone.
pub(crate) fn within_grace(shown_at: Option<std::time::Instant>, now: std::time::Instant) -> bool {
    shown_at
        .is_some_and(|shown| now.saturating_duration_since(shown) <= HANDOFF_APP_ACTIVATION_GRACE)
}

/// What the watch does with the foreground it reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ForegroundStep {
    /// Still on the window that was in front (or between windows): wait.
    Keep,
    /// The handed-off window itself took it as the app's move: hand it back.
    Restore,
    /// Another window has it, or the handed-off window took it when it may
    /// have been the user's choice: the watch stops and leaves the foreground
    /// (and the window order) alone.
    LeftAlone,
}

/// Decides one read of the foreground. Only the handed-off window counts as
/// the app's move, never another window of the same process the user may
/// have picked. That window taking the foreground is handed back when the
/// user gave no input since the launch began, or, with input, when it took it
/// within [`HANDOFF_APP_ACTIVATION_GRACE`] of being found, too soon for the
/// user to have picked it. Past that, with input, not undoing the user's
/// choice comes before keeping the window behind: it stays in front
/// (`is_focused: true`, with a note). The same holds for a second take after
/// a hand-back.
#[cfg(any(target_os = "windows", test))]
pub(crate) fn foreground_step(
    foreground_is_null: bool,
    foreground_is_prior: bool,
    foreground_is_handed_window: bool,
    user_input: bool,
    within_grace: bool,
) -> ForegroundStep {
    match (
        foreground_is_null,
        foreground_is_prior,
        foreground_is_handed_window,
    ) {
        (true, _, _) | (false, true, _) => ForegroundStep::Keep,
        (false, false, true) if !user_input || within_grace => ForegroundStep::Restore,
        (false, false, _) => ForegroundStep::LeftAlone,
    }
}
/// Whether input recorded at tick `last` (`GetLastInputInfo`) came at or
/// after `started` (`GetTickCount`), across the 49-day wrap. The same tick
/// counts as after: doubt falls on the side of leaving the foreground alone.
#[cfg(any(target_os = "windows", test))]
fn input_at_or_after(last: u32, started: u32) -> bool {
    (last.wrapping_sub(started) as i32) >= 0
}

/// Whether the user gave keyboard or mouse input since `started`. This
/// launch synthesizes none, so input in that span is someone else's: the
/// user's, or another program injecting input (an app that synthesizes a key
/// to take the foreground, another run sending input), which also stops the
/// watch, on the safe side. Unreadable reads as input.
#[cfg(target_os = "windows")]
pub(crate) fn user_input_since(started: u32) -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    if unsafe { GetLastInputInfo(&mut info) } == 0 {
        return true;
    }
    input_at_or_after(info.dwTime, started)
}

/// How a watch over the handed-off window's foreground goes on or ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WatchAction {
    /// Nothing to do yet (or the watch ran its span).
    Wait,
    /// Hand the foreground back to the window that was in front.
    Restore,
    /// Stopped because the move may have been the user's: a take outside the
    /// grace with input before any hand-back was tried, a take again after a
    /// hand-back was seen to work, or the foreground on another window.
    StopForUser,
    /// Stopped with the handed-off window still in front after a hand-back
    /// was tried and never seen to work (Windows refused it): the app's
    /// doing, reported as such.
    StopFailed,
}

/// Remembers whether a hand-back was tried and not yet seen to work, so a
/// window that stays in front through a refused hand-back is not taken as
/// the user's choice once the grace runs out.
#[derive(Debug, Default)]
pub(crate) struct HandBack {
    pending: bool,
}

impl HandBack {
    pub(crate) fn observe(
        &mut self,
        step: ForegroundStep,
        foreground_is_prior: bool,
        foreground_is_handed: bool,
    ) -> WatchAction {
        if foreground_is_prior {
            self.pending = false;
        }
        match step {
            ForegroundStep::Keep => WatchAction::Wait,
            ForegroundStep::Restore => {
                self.pending = true;
                WatchAction::Restore
            }
            ForegroundStep::LeftAlone if self.pending && foreground_is_handed => {
                WatchAction::StopFailed
            }
            ForegroundStep::LeftAlone => WatchAction::StopForUser,
        }
    }

    /// Whether a hand-back was tried and not yet seen to work.
    pub(crate) fn pending(&self) -> bool {
        self.pending
    }
}

/// Watches the foreground for `span` (inside the settle's deadline) and hands
/// it back to `prior` whenever `foreground_step` says the handed-off window
/// `handed` took it as the app's move. `Wait` when the span ran out; a stop
/// otherwise, after which nothing more may be done to the foreground or the
/// window order.
#[cfg(target_os = "windows")]
fn settle_foreground(
    prior: windows_sys::Win32::Foundation::HWND,
    handed: windows_sys::Win32::Foundation::HWND,
    started: u32,
    settle: HandoffSettle,
    span: Duration,
    hand_back: &mut HandBack,
) -> WatchAction {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, SetForegroundWindow};
    let until = std::time::Instant::now() + span.min(settle.deadline.remaining());
    loop {
        let foreground = unsafe { GetForegroundWindow() };
        let is_handed = !handed.is_null() && foreground == handed;
        let step = foreground_step(
            foreground.is_null(),
            foreground == prior,
            is_handed,
            user_input_since(started),
            within_grace(settle.shown_at, std::time::Instant::now()),
        );
        match hand_back.observe(step, foreground == prior, is_handed) {
            WatchAction::Wait => {}
            WatchAction::Restore => {
                unsafe { SetForegroundWindow(prior) };
            }
            stop => return stop,
        }
        if std::time::Instant::now() >= until {
            return WatchAction::Wait;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}
/// Whether `window` is the foreground window now: what `is_focused` reports.
#[cfg(target_os = "windows")]
fn is_foreground(window: &WindowInfo) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    let handle = super::window::window_ops::parse_handle(&window.id);
    !handle.is_null() && unsafe { GetForegroundWindow() } == handle
}

#[cfg(not(target_os = "windows"))]
fn is_foreground(window: &WindowInfo) -> bool {
    window.state.is_focused
}

#[cfg(target_os = "windows")]
impl Drop for ForegroundGuard {
    fn drop(&mut self) {
        self.unlock();
    }
}

/// Whether the guard may hand the foreground back and restack the launched
/// window, read before the lock is dropped.
///
/// While the lock holds, no process can take the foreground on its own, so a
/// foreground that moved off the prior window was moved by the user (a click
/// or Alt, which also drops the lock) or by that window closing or minimizing;
/// either way it is left alone. Without the lock a move cannot be told apart
/// from the launched app taking the foreground, so it is left alone too: the
/// lock fails only when this process may not set the foreground, and then the
/// launched app cannot take it either, nor could it be handed back.
/// A prior window minimized during the launch can stay the foreground, but it
/// sits at the bottom of the z-order, so restacking below it would bury the
/// launched window behind every other one; it is left alone like a closed one.
#[cfg(any(target_os = "windows", test))]
fn may_restore_foreground(foreground_is_prior: bool, prior_is_minimized: bool) -> bool {
    foreground_is_prior && !prior_is_minimized
}

#[cfg(target_os = "windows")]
fn window_pid(handle: windows_sys::Win32::Foundation::HWND) -> Option<ProcessId> {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
    if handle.is_null() {
        return None;
    }
    let mut pid = 0_u32;
    unsafe { GetWindowThreadProcessId(handle, &mut pid) };
    (pid != 0).then(|| ProcessId::from(pid))
}

/// Whether a top-level window belongs to one of `owners`: by the thread that
/// owns it, or, for a frame the shell hosts an app in, by the hosted app's
/// process (the pid the window inventory reports for that frame).
#[cfg(target_os = "windows")]
fn window_is_owned_by(handle: windows_sys::Win32::Foundation::HWND, owners: &[ProcessId]) -> bool {
    let owned = |pid: Option<ProcessId>| pid.is_some_and(|pid| owners.contains(&pid));
    owned(window_pid(handle))
        || (!handle.is_null()
            && owned(super::window::frame_identity::hosted_application_pid(
                handle,
            )))
}

#[cfg(not(target_os = "windows"))]
struct ForegroundGuard;

#[cfg(not(target_os = "windows"))]
impl ForegroundGuard {
    fn begin(_activate: bool, _started: Option<u32>) -> Option<Self> {
        None
    }

    fn finish(
        self,
        _owners: &[ProcessId],
        _window: Option<&WindowInfo>,
        _settle: Option<HandoffSettle>,
    ) -> bool {
        false
    }
}

fn launch_result(
    id: &str,
    pid: ProcessId,
    process_instance: String,
    window: Option<WindowInfo>,
) -> LaunchResult {
    let renderer = window.as_ref().and_then(detect_renderer_from_window);
    LaunchResult {
        app: window
            .as_ref()
            .map(|window| window.app.clone())
            .unwrap_or_else(|| image_file_name(id).to_string()),
        pid,
        process_instance: Some(process_instance),
        window,
        cdp: None,
        renderer,
        suggestion: None,
        attached: false,
        new_instance: false,
        handed_off: false,
        running_without_window: false,
        existing_window: false,
        activated: None,
    }
}

#[cfg(target_os = "windows")]
fn detect_renderer_from_window(window: &WindowInfo) -> Option<RendererKind> {
    const CHROMIUM_WINDOW_CLASS: &str = "Chrome_WidgetWin_1";
    let handle = super::window::window_ops::parse_handle(&window.id);
    if handle.is_null() {
        return None;
    }
    super::window::window_ops::window_class_name(handle)
        .filter(|class| class == CHROMIUM_WINDOW_CLASS)
        .map(|_| RendererKind::Chromium)
}

#[cfg(not(target_os = "windows"))]
fn detect_renderer_from_window(_window: &WindowInfo) -> Option<RendererKind> {
    None
}

/// One window observation, tolerant of the inventory's mid-walk identity race.
///
/// `list_windows_live` now absorbs that race itself (the shared listing-retry
/// budget every caller on this path shares), retrying internally before ever
/// returning `WINDOW_NOT_FOUND` — so this function no longer re-reads the
/// inventory itself. A launch is exactly the moment that race is most
/// reachable, since a process was just created or terminated, but a race that
/// still survives the shared budget, and a budget that runs out entirely
/// (`TIMEOUT`), both say the desktop could not be read coherently in time —
/// not that this launch failed — so both are reported as no window observed.
/// Every other failure still propagates: a target whose process instance
/// changed underneath the launch is a real answer, not a race.
fn observe_window_once(
    pid: ProcessId,
    process_instance: &str,
    deadline: Deadline,
) -> Result<Option<WindowInfo>, AdapterError> {
    match exact_window(pid, process_instance, deadline) {
        Ok(window) => Ok(window),
        Err(error) if is_unobservable_within_budget(&error) => Ok(None),
        Err(error) => Err(after_launch(error)),
    }
}

fn is_unobservable_within_budget(error: &AdapterError) -> bool {
    matches!(error.code, ErrorCode::WindowNotFound | ErrorCode::Timeout)
}

fn exact_window(
    pid: ProcessId,
    process_instance: &str,
    deadline: Deadline,
) -> Result<Option<WindowInfo>, AdapterError> {
    let windows = list_windows_live(
        &WindowFilter {
            focused_only: false,
            app: None,
        },
        deadline,
    )?;
    let Some(window) = windows.into_iter().find(|window| window.pid == pid) else {
        return Ok(None);
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

/// Refuses a relative working directory before it reaches `CreateProcessW`.
///
/// The child's current directory sits early in the default DLL search order,
/// so it picks which copy of a dependency loads; a relative path resolves
/// against whatever directory this process happens to hold, not the caller's.
#[cfg(target_os = "windows")]
fn absolute_cwd(cwd: &Path) -> Result<&Path, AdapterError> {
    if cwd.is_absolute() {
        return Ok(cwd);
    }
    Err(before_launch(AdapterError::new(
        ErrorCode::InvalidArgs,
        "The launch working directory must be an absolute path",
    )))
}

/// The working directory a launch without `--cwd` gives the app: the folder
/// of its executable, as a shortcut without a working directory or a double
/// click in Explorer does. Without it the app inherited this process's own
/// directory (the caller's workspace), and apps that read files next to
/// themselves by relative path failed to start. `None` (inherit, as before)
/// when the executable has no absolute parent that is a directory.
#[cfg(any(target_os = "windows", test))]
fn default_cwd(executable: &Path) -> Option<&Path> {
    executable
        .parent()
        .filter(|folder| folder.is_absolute() && folder.is_dir())
}

#[cfg(target_os = "windows")]
fn create_process(
    executable: &Path,
    options: &LaunchOptions,
    deadline: Deadline,
) -> Result<(ProcessId, String, launch_handoff::Process), AdapterError> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        CREATE_UNICODE_ENVIRONMENT, CreateProcessW, PROCESS_INFORMATION, STARTUPINFOW,
    };

    deadline.ensure_remaining().map_err(before_launch)?;
    let app_wide = to_wide(executable).map_err(before_launch)?;
    let command_line = command_line_for(executable, &options.args).map_err(before_launch)?;
    let mut command_wide = to_wide_str(&command_line).map_err(before_launch)?;
    let cwd_wide = match &options.cwd {
        Some(cwd) => Some(to_wide(absolute_cwd(cwd)?).map_err(before_launch)?),
        None => match default_cwd(executable) {
            Some(folder) => Some(to_wide(folder).map_err(before_launch)?),
            None => None,
        },
    };
    let env_block = child_environment_block(
        &options.env,
        crate::system::interaction_lease::INTERACTION_LEASE_HANDLE_ENV,
    )
    .map_err(before_launch)?;
    let startup = STARTUPINFOW {
        cb: std::mem::size_of::<STARTUPINFOW>() as u32,
        ..Default::default()
    };
    let mut information = PROCESS_INFORMATION::default();
    let flags = if env_block.is_some() {
        CREATE_UNICODE_ENVIRONMENT
    } else {
        0
    };
    let env_ptr = env_block
        .as_ref()
        .map(|block| block.as_ptr().cast())
        .unwrap_or(std::ptr::null());
    let cwd_ptr = cwd_wide
        .as_ref()
        .map(|wide| wide.as_ptr())
        .unwrap_or(std::ptr::null());
    deadline.ensure_remaining().map_err(before_launch)?;
    let ok = unsafe {
        CreateProcessW(
            app_wide.as_ptr(),
            command_wide.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            flags,
            env_ptr,
            cwd_ptr,
            &startup,
            &mut information,
        )
    };
    if ok == 0 {
        return Err(before_launch(win32_last_error(
            "CreateProcessW failed to start the application",
        )));
    }
    let pid = ProcessId::from(information.dwProcessId);
    unsafe { CloseHandle(information.hThread) };
    // Kept, not closed: holding it keeps the pid from being reused while the
    // launch tells its descendants apart (see `launch_handoff`).
    let process = launch_handoff::Process::from_handle(information.hProcess);
    let token = process_identity::token_for_pid(pid)
        .map_err(after_launch)?
        .ok_or_else(|| {
            after_launch(
                AdapterError::new(
                    ErrorCode::AppUnresponsive,
                    "Created process has no exact process instance token",
                )
                .with_details(serde_json::json!({ "pid": pid, "complete": false })),
            )
        })?;
    Ok((pid, token, process))
}

#[cfg(not(target_os = "windows"))]
fn create_process(
    _executable: &Path,
    _options: &LaunchOptions,
    _deadline: Deadline,
) -> Result<(ProcessId, String, launch_handoff::Process), AdapterError> {
    Err(AdapterError::not_supported("launch_app"))
}

fn command_line_for(executable: &Path, args: &[String]) -> Result<String, AdapterError> {
    let mut line = quote_arg(&executable.to_string_lossy());
    for arg in args {
        line.push(' ');
        line.push_str(&quote_arg(arg));
    }
    Ok(line)
}

/// Encodes one argument for the command line the child parses back apart.
///
/// The trailing backslash run is the case that silently corrupts: backslashes
/// are literal except immediately before a quote, so a value ending in one
/// would escape the closing quote this appends, leaving the quoted region open
/// and swallowing every later argument into it. That run is therefore doubled.
/// An embedded quote stays doubled rather than backslash-escaped: that is a
/// valid encoding for the consecutive-quote rule and the form `cmd` accepts,
/// which backslash-escaping is not.
fn quote_arg(value: &str) -> String {
    if !value.is_empty() && !value.chars().any(|c| c.is_whitespace() || c == '"') {
        return value.to_string();
    }
    let mut out = String::from("\"");
    for ch in value.chars() {
        if ch == '"' {
            out.push('"');
        }
        out.push(ch);
    }
    let trailing = value.len() - value.trim_end_matches('\\').len();
    for _ in 0..trailing {
        out.push('\\');
    }
    out.push('"');
    out
}

/// Pass-through kept here, under this module's own name, purely so this
/// module's own tests (`launch_tests.rs`) can call it unqualified through
/// their `use super::*;`; the merge itself lives in `launch_path` beside
/// every other input-shape rule a launch enforces, and `create_process`
/// reaches it through `child_environment_block` rather than this name. Only
/// that test caller remains, so this exists for `#[cfg(test)]` builds alone.
#[cfg(test)]
fn environment_block(overrides: &BTreeMap<String, String>) -> Result<Vec<u16>, AdapterError> {
    super::launch_path::environment_block(overrides)
}

#[cfg(target_os = "windows")]
fn to_wide(path: &Path) -> Result<Vec<u16>, AdapterError> {
    use std::os::windows::ffi::OsStrExt;
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    if wide.contains(&0) {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Launch path contains an interior NUL",
        ));
    }
    wide.push(0);
    Ok(wide)
}

#[cfg(target_os = "windows")]
fn to_wide_str(value: &str) -> Result<Vec<u16>, AdapterError> {
    if value.contains('\0') {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Launch command line contains an interior NUL",
        ));
    }
    let mut wide: Vec<u16> = value.encode_utf16().collect();
    wide.push(0);
    Ok(wide)
}

fn before_launch(error: AdapterError) -> AdapterError {
    error.with_disposition(DeliverySemantics::not_delivered())
}

fn after_launch(error: AdapterError) -> AdapterError {
    error.with_disposition(DeliverySemantics::delivered_unverified())
}

fn should_poll_after_first_observation(timeout_ms: u64) -> bool {
    timeout_ms > 0
}

#[cfg(test)]
#[path = "launch_tests.rs"]
mod tests;

#[cfg(test)]
mod foreground_guard_tests {
    use super::{
        ForegroundStep, HandBack, WatchAction, apply_foreground_fact, foreground_step,
        input_at_or_after, launch_attach, launch_result, may_restore_foreground, within_grace,
    };
    use agent_desktop_core::{ProcessId, WindowInfo, WindowState};
    use std::time::{Duration, Instant};

    // foreground_step(null, prior, handed window, user input, within grace)

    /// The handed-off window taking the foreground with no input from the
    /// user is the app's own activation: it is handed back, early or late in
    /// the watch. Staying on the window that was in front (or between
    /// windows) waits.
    #[test]
    fn without_input_the_handed_off_window_is_handed_back_at_any_time() {
        assert_eq!(
            foreground_step(false, false, true, false, true),
            ForegroundStep::Restore,
            "found 100 ms ago"
        );
        assert_eq!(
            foreground_step(false, false, true, false, false),
            ForegroundStep::Restore,
            "900 ms after it was found"
        );
        assert_eq!(
            foreground_step(false, true, false, false, true),
            ForegroundStep::Keep
        );
        assert_eq!(
            foreground_step(true, false, false, false, false),
            ForegroundStep::Keep
        );
    }

    /// While the user is giving input, the handed-off window taking the
    /// front just after it appeared (too soon for the user to have picked it)
    /// is still the app's move, and is handed back.
    #[test]
    fn with_input_a_take_right_after_the_window_appeared_is_handed_back() {
        assert_eq!(
            foreground_step(false, false, true, true, true),
            ForegroundStep::Restore
        );
    }

    /// With input, a take after the short span may be the user's click or
    /// Alt+Tab, so it is left alone.
    #[test]
    fn with_input_a_later_take_is_left_alone() {
        assert_eq!(
            foreground_step(false, false, true, true, false),
            ForegroundStep::LeftAlone
        );
    }

    /// Another window having the front, including another window of the
    /// same running instance the user picked, is left alone, with or without
    /// input, early or late.
    #[test]
    fn another_window_of_the_same_process_is_left_alone() {
        for (input, grace) in [(false, false), (false, true), (true, false), (true, true)] {
            assert_eq!(
                foreground_step(false, false, false, input, grace),
                ForegroundStep::LeftAlone,
                "input {input}, within grace {grace}"
            );
        }
    }

    /// Input while the front stays on the window that was in front changes
    /// nothing yet: the watch goes on.
    #[test]
    fn input_alone_does_not_stop_the_watch() {
        assert_eq!(
            foreground_step(false, true, false, true, false),
            ForegroundStep::Keep
        );
    }

    #[test]
    fn the_app_activation_span_is_shorter_than_a_person_picking_a_window() {
        assert!(super::HANDOFF_APP_ACTIVATION_GRACE >= std::time::Duration::from_millis(100));
        assert!(super::HANDOFF_APP_ACTIVATION_GRACE <= std::time::Duration::from_millis(400));
    }
    #[test]
    fn input_is_read_against_the_launch_start_across_the_tick_wrap() {
        assert!(input_at_or_after(1_000, 1_000), "the same tick counts");
        assert!(input_at_or_after(1_001, 1_000));
        assert!(!input_at_or_after(999, 1_000));
        assert!(input_at_or_after(5, u32::MAX - 5), "after the wrap");
        assert!(!input_at_or_after(u32::MAX - 5, 5), "before the wrap");
    }
    #[test]
    fn the_hold_and_the_watch_are_short() {
        let total = super::HANDOFF_FOREGROUND_HOLD + super::HANDOFF_FOREGROUND_WATCH;
        assert!(total <= std::time::Duration::from_secs(3), "{total:?}");
        assert!(super::HANDOFF_FOREGROUND_HOLD >= std::time::Duration::from_millis(800));
    }

    fn handed_off_with_window() -> agent_desktop_core::system::launch_result::LaunchResult {
        let mut result = launch_result("app.exe", ProcessId::from(7), "7:1".to_string(), None);
        result.window = Some(WindowInfo {
            id: "w-1".into(),
            title: String::new(),
            app: "app.exe".into(),
            pid: ProcessId::from(8),
            process_instance: Some("8:1".into()),
            bounds: None,
            state: WindowState {
                is_focused: true,
                ..WindowState::default()
            },
        });
        result.handed_off = true;
        result.suggestion = Some(launch_attach::HANDED_OFF_NEW_WINDOW.to_string());
        result
    }

    /// `is_focused` is the fact at return: a window read as focused when it
    /// was found, then handed back, reports `false`, with no extra note.
    #[test]
    fn a_window_put_back_behind_is_not_reported_focused() {
        let mut result = handed_off_with_window();
        apply_foreground_fact(&mut result, false, false, false);
        assert!(!result.window.as_ref().expect("window").state.is_focused);
        assert_eq!(
            result.suggestion.as_deref(),
            Some(launch_attach::HANDED_OFF_NEW_WINDOW)
        );
    }

    /// A window that stayed in front without `--activate` says so, and the
    /// guidance tells the caller to say so to the user.
    #[test]
    fn a_window_left_in_front_says_so() {
        let mut result = handed_off_with_window();
        apply_foreground_fact(&mut result, false, true, false);
        assert!(result.window.as_ref().expect("window").state.is_focused);
        let text = result.suggestion.as_deref().expect("suggestion");
        assert!(text.starts_with(launch_attach::HANDED_OFF_NEW_WINDOW));
        assert!(text.ends_with(launch_attach::HANDED_OFF_LEFT_IN_FRONT));
        let mut asked = handed_off_with_window();
        apply_foreground_fact(&mut asked, true, true, false);
        assert_eq!(
            asked.suggestion.as_deref(),
            Some(launch_attach::HANDED_OFF_NEW_WINDOW),
            "with --activate, in front is what was asked for"
        );
    }

    /// The grace counts from when the window was first seen, not from when
    /// the launch found it had been passed on. Here the launched process ran
    /// 2 seconds; the window was seen from 0.1 s. With the user's input and
    /// the window in front, the user may have clicked it, so it is left alone.
    #[test]
    fn the_grace_starts_when_the_window_was_first_seen() {
        let launch = Instant::now();
        let shown = launch + Duration::from_millis(100);
        let passed_on = launch + Duration::from_secs(2);
        assert!(!within_grace(Some(shown), passed_on));
        assert_eq!(
            foreground_step(
                false,
                false,
                true,
                true,
                within_grace(Some(shown), passed_on)
            ),
            ForegroundStep::LeftAlone
        );
    }

    /// The RabbitMail kind: the window takes the front as it is shown. With
    /// the user's input, that is still the app's move and is handed back.
    #[test]
    fn a_window_that_takes_the_front_as_it_is_shown_is_handed_back_with_input() {
        let shown = Instant::now();
        let now = shown + Duration::from_millis(50);
        assert!(within_grace(Some(shown), now));
        assert_eq!(
            foreground_step(false, false, true, true, within_grace(Some(shown), now)),
            ForegroundStep::Restore
        );
    }

    /// A window whose first sight is not known gets no grace.
    #[test]
    fn a_window_never_seen_before_gets_no_grace() {
        assert!(!within_grace(None, Instant::now()));
        assert_eq!(
            foreground_step(false, false, true, true, within_grace(None, Instant::now())),
            ForegroundStep::LeftAlone
        );
    }

    /// The user brought the window to the front during the watch (the watch
    /// left it alone): no note says the app took it.
    #[test]
    fn a_window_the_user_may_have_picked_gets_no_left_in_front_note() {
        let mut result = handed_off_with_window();
        apply_foreground_fact(&mut result, false, true, true);
        assert!(result.window.as_ref().expect("window").state.is_focused);
        let text = result.suggestion.as_deref().expect("suggestion");
        assert!(
            !text.contains(launch_attach::HANDED_OFF_LEFT_IN_FRONT),
            "{text}"
        );
        assert_eq!(text, launch_attach::HANDED_OFF_NEW_WINDOW);
    }
    /// One read of the foreground: (prior, handed window, other window).
    #[derive(Clone, Copy)]
    enum Front {
        Prior,
        Handed,
        Other,
    }

    /// Drives a watch over reads of (front, user input, within grace) and
    /// returns the action of each read.
    fn drive(reads: &[(Front, bool, bool)]) -> Vec<WatchAction> {
        let mut hand_back = HandBack::default();
        reads
            .iter()
            .map(|&(front, input, grace)| {
                let (prior, handed) = match front {
                    Front::Prior => (true, false),
                    Front::Handed => (false, true),
                    Front::Other => (false, false),
                };
                let step = foreground_step(false, prior, handed, input, grace);
                hand_back.observe(step, prior, handed)
            })
            .collect()
    }

    /// The handed-off window takes the front as it is shown, the user is
    /// working, Windows refuses the hand-back, and the window stays in front
    /// past the grace: a refused hand-back, not the user's choice.
    #[test]
    fn a_refused_hand_back_stays_a_failure_after_the_grace() {
        let actions = drive(&[
            (Front::Handed, true, true),
            (Front::Handed, true, true),
            (Front::Handed, true, false),
        ]);
        assert_eq!(
            actions,
            [
                WatchAction::Restore,
                WatchAction::Restore,
                WatchAction::StopFailed
            ]
        );
        let mut result = handed_off_with_window();
        let left_for_user = *actions.last().expect("an action") == WatchAction::StopForUser;
        apply_foreground_fact(&mut result, false, true, left_for_user);
        assert!(result.window.as_ref().expect("window").state.is_focused);
        let text = result.suggestion.as_deref().expect("suggestion");
        assert!(
            text.ends_with(launch_attach::HANDED_OFF_LEFT_IN_FRONT),
            "{text}"
        );
    }

    /// (a) A take outside the grace with input, before any hand-back.
    #[test]
    fn a_first_take_outside_the_grace_with_input_is_left_for_the_user() {
        assert_eq!(
            drive(&[(Front::Prior, true, false), (Front::Handed, true, false)]),
            [WatchAction::Wait, WatchAction::StopForUser]
        );
    }

    /// (b) A take again after a hand-back was seen to work, outside the
    /// grace with input.
    #[test]
    fn a_take_after_a_hand_back_worked_is_left_for_the_user() {
        assert_eq!(
            drive(&[
                (Front::Handed, true, true),
                (Front::Prior, true, true),
                (Front::Handed, true, false),
            ]),
            [
                WatchAction::Restore,
                WatchAction::Wait,
                WatchAction::StopForUser
            ]
        );
    }

    /// (c) The foreground on another window, even after a hand-back was
    /// tried.
    #[test]
    fn another_window_in_front_is_left_for_the_user() {
        assert_eq!(
            drive(&[(Front::Other, false, true)]),
            [WatchAction::StopForUser]
        );
        assert_eq!(
            drive(&[(Front::Handed, true, true), (Front::Other, true, true)]),
            [WatchAction::Restore, WatchAction::StopForUser]
        );
    }
    /// A window the instance had that was already in front before the
    /// launched process exited (the user picked it while the launch waited)
    /// is not taken as brought forward, so it is neither handed back nor
    /// restacked; one that came forward right after the exit is.
    #[test]
    fn a_window_in_front_before_the_exit_is_not_taken_as_brought_forward() {
        assert!(!super::counts_as_raised(true, true));
        assert!(super::counts_as_raised(true, false));
        assert!(!super::counts_as_raised(false, false));
    }

    // raised_take(within grace of the exit, in front before the exit, input)

    /// #1297: Chrome brought its profile picker forward about a second
    /// before its launcher exited, with nobody at the keyboard. Without the
    /// user's input since the launch began, a window of the instance that
    /// came forward before the exit, or later than the grace, is the app's
    /// move: it is the launch's window, and is handed back (no grace needed:
    /// `foreground_step` hands back without input at any time).
    #[test]
    fn without_input_a_window_brought_forward_before_or_long_after_the_exit_is_taken() {
        use super::{RaisedTake, raised_take};
        assert_eq!(raised_take(true, true, false), RaisedTake::WithoutInput);
        assert_eq!(raised_take(false, true, false), RaisedTake::WithoutInput);
        assert_eq!(raised_take(false, false, false), RaisedTake::WithoutInput);
        assert_eq!(
            foreground_step(
                false,
                false,
                true,
                false,
                within_grace(None, Instant::now())
            ),
            ForegroundStep::Restore
        );
    }

    /// With input, the same windows may be the user's pick (#1288's review:
    /// a window of the same process the user picked is never undone). They
    /// are only named when no new window appears, and never handed back nor
    /// restacked: with input and no grace the watch leaves them alone.
    #[test]
    fn with_input_a_window_in_front_before_the_exit_or_after_the_grace_is_left_to_the_user() {
        use super::{RaisedTake, raised_take};
        assert_eq!(raised_take(true, true, true), RaisedTake::MaybeUser);
        assert_eq!(raised_take(false, true, true), RaisedTake::MaybeUser);
        assert_eq!(raised_take(false, false, true), RaisedTake::MaybeUser);
        assert_eq!(
            foreground_step(false, false, true, true, within_grace(None, Instant::now())),
            ForegroundStep::LeftAlone
        );
        assert_eq!(
            drive(&[(Front::Handed, true, false)]),
            [WatchAction::StopForUser],
            "left for the user, so no note says the app took the front"
        );
    }

    /// Just as the launch was handed over (within the grace of the exit, and
    /// not in front before it), it is the app's move even with input, timed
    /// from the exit, as before.
    #[test]
    fn a_window_brought_forward_right_after_the_exit_is_taken_with_or_without_input() {
        use super::{RaisedTake, raised_take};
        assert_eq!(raised_take(true, false, true), RaisedTake::InGrace);
        assert_eq!(raised_take(true, false, false), RaisedTake::InGrace);
    }

    /// A window that came forward while the user gave input is named only
    /// when the watch ends without a new window, ahead of the instance's
    /// only window, and says it may be the user's pick.
    #[test]
    fn a_window_that_came_forward_is_named_at_the_end_with_its_own_guidance() {
        let guidance =
            launch_attach::existing_window_guidance(launch_attach::ExistingWindow::CameForward);
        assert!(
            guidance.contains("came to the front during the launch"),
            "{guidance}"
        );
        assert!(guidance.contains("may have picked it"), "{guidance}");
        assert!(guidance.contains("existing_window"), "{guidance}");
        assert!(
            guidance
                .to_lowercase()
                .contains("do not repeat --no-attach"),
            "{guidance}"
        );
        let raised = launch_attach::existing_window_guidance(launch_attach::ExistingWindow::Raised);
        assert!(raised.contains("profile picker"), "{raised}");
        assert!(!raised.contains("likely keeps one window"), "{raised}");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn the_end_of_the_watch_names_the_window_that_came_forward_before_the_only_one() {
        use super::launch_handoff::{Lineage, Process};
        let me = ProcessId::from(std::process::id());
        let lineage = || Lineage::new(me, "me:1", Process::open(me).expect("own process"));
        let window = |id: &str| WindowInfo {
            id: id.into(),
            title: String::new(),
            app: "app.exe".into(),
            pid: ProcessId::from(8),
            process_instance: Some("8:1".into()),
            bounds: None,
            state: WindowState::default(),
        };
        let both = super::existing_at_the_end(&lineage(), Some(window("w-2")), Some(window("w-1")))
            .expect("a window");
        assert_eq!(both.window.as_ref().map(|w| w.id.as_str()), Some("w-2"));
        assert_eq!(
            both.existing,
            Some(launch_attach::ExistingWindow::CameForward)
        );
        assert!(both.handed_off && both.shown_at.is_none());
        assert!(both.owners.contains(&ProcessId::from(8)));
        let only = super::existing_at_the_end(&lineage(), None, Some(window("w-1")))
            .expect("the only window");
        assert_eq!(only.existing, Some(launch_attach::ExistingWindow::Only));
        assert!(super::existing_at_the_end(&lineage(), None, None).is_none());
    }

    /// #1299's review: a window kept as `came_forward` (`MaybeUser`) that is
    /// closed during the wait, or whose instance ends, is not named at the
    /// end: the latest read's only window, or no window, is.
    #[cfg(target_os = "windows")]
    #[test]
    fn a_window_that_came_forward_and_closed_during_the_wait_is_not_named() {
        use super::came_forward_after_read;
        use super::launch_handoff::{HandoffLook, HandoffRead, Lineage, Process};
        let me = ProcessId::from(std::process::id());
        let lineage = || Lineage::new(me, "me:1", Process::open(me).expect("own process"));
        let window = |id: &str, instance: &str| WindowInfo {
            id: id.into(),
            title: String::new(),
            app: "app.exe".into(),
            pid: ProcessId::from(8),
            process_instance: Some(instance.into()),
            bounds: None,
            state: WindowState::default(),
        };
        let read = |shown: &[&str], only: Option<WindowInfo>| HandoffRead {
            look: HandoffLook::None,
            raised: None,
            only_existing: only,
            shown: shown
                .iter()
                .map(|id| ((*id).to_string(), Some("8:1".to_string())))
                .collect(),
        };
        let picker = window("w-picker", "8:1");

        // Still shown by the same instance: kept, and named at the end.
        let kept = came_forward_after_read(
            Some(picker.clone()),
            Some(&read(&["w-picker", "w-browser"], None)),
        );
        assert_eq!(kept.as_ref().map(|w| w.id.as_str()), Some("w-picker"));

        // Closed during the wait: the latest read names the browser as the
        // only window, and that is what the end of the watch returns.
        let later = read(&["w-browser"], Some(window("w-browser", "8:1")));
        let kept = came_forward_after_read(kept, Some(&later));
        assert!(kept.is_none());
        let end = super::existing_at_the_end(&lineage(), kept, later.only_existing.clone())
            .expect("the only window");
        assert_eq!(
            end.window.as_ref().map(|w| w.id.as_str()),
            Some("w-browser")
        );
        assert_eq!(end.existing, Some(launch_attach::ExistingWindow::Only));

        // Closed, and no only window: no window at all.
        let kept = came_forward_after_read(Some(picker.clone()), Some(&read(&[], None)));
        assert!(super::existing_at_the_end(&lineage(), kept, None).is_none());

        // The same handle now of another instance (reused), and an instance
        // that ended: both drop it.
        let reused = HandoffRead {
            shown: vec![("w-picker".to_string(), Some("8:2".to_string()))],
            ..read(&[], None)
        };
        assert!(came_forward_after_read(Some(picker.clone()), Some(&reused)).is_none());
        assert!(came_forward_after_read(Some(picker), None).is_none());
    }
    #[test]
    fn a_foreground_that_stayed_on_the_prior_window_is_restored() {
        assert!(may_restore_foreground(true, false));
    }

    #[test]
    fn a_foreground_that_moved_off_the_prior_window_is_left_alone() {
        assert!(!may_restore_foreground(false, false));
    }

    #[test]
    fn a_minimized_prior_window_is_left_alone_even_while_it_is_the_foreground() {
        assert!(!may_restore_foreground(true, true));
        assert!(!may_restore_foreground(false, true));
    }
}

#[cfg(all(test, target_os = "windows"))]
#[path = "launch_lease_isolation_tests.rs"]
mod launch_lease_isolation_tests;

#[path = "launch_attach.rs"]
pub(crate) mod launch_attach;

#[path = "launch_handoff.rs"]
mod launch_handoff;
