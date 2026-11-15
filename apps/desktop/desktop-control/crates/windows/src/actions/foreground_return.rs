// Added by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! Gives the foreground back when a background action made the target open a
//! window that took it (#1293).
//!
//! A background action runs with the foreground locked until the target has
//! handled it (`foreground_hold`). An app can still answer later: a click that
//! goes to Chromium's own accessibility is passed to the page and on to the
//! browser process, which opens its new window after the lock is dropped
//! (measured on an Electron window: the click returned, the new window was
//! created hidden while the hold waited, and was shown and took the
//! foreground about 70 ms after the unlock). A process that holds the right
//! to set the foreground (a grant a launch handed it, or the user idle past
//! the foreground lock timeout) then takes the front from the user.
//!
//! So the windows of the target's process are read before the action, and
//! once more right after the hold's wait, while the lock still holds. When the
//! target has no new top-level window (shown or still hidden, tool windows
//! aside) and the foreground stayed where it was, nothing more is done and the
//! action returns at once: an ordinary click pays only two window listings.
//! Otherwise the foreground is held locked and watched, then watched unlocked,
//! for the spans a launch passed to a running instance uses
//! (`HANDOFF_FOREGROUND_HOLD`, `HANDOFF_FOREGROUND_WATCH`), and handed back
//! by the launch's own rules (`system::launch::foreground_step`):
//!
//! - Only a window of the target counts as the app's move: one that was not
//!   shown before the action (it opened, or it was hidden and is shown now),
//!   or one the target already showed that came to the front within
//!   `HANDOFF_APP_ACTIVATION_GRACE` of the action being sent (the app
//!   activating its own window instead of opening one). A window of another
//!   process in front is the user's doing and stops the watch.
//! - Without the user's input since the action began, such a window is handed
//!   back whenever it takes the front. With input, only within the grace from
//!   when it was first seen; a window seen first by the look right after the
//!   action is timed from when the action was sent, the earliest it could have
//!   appeared, so the grace never stretches past it.
//! - A hand-back that was tried and never seen to work is reported apart from
//!   a take left alone as possibly the user's choice.
//!
//! What this does not catch: a window the target creates only after that
//! look (a browser that first loads a profile from disk), since the action
//! does not wait for windows that may never come.
#![cfg_attr(not(target_os = "windows"), allow(dead_code))]

use std::time::Instant;

use crate::system::launch::{HandBack, WatchAction, within_grace};

/// `details.foreground` when a window of the target took the foreground and
/// it was handed back to the window that had it.
pub(crate) const HANDED_BACK: &str = "handed_back";
/// `details.foreground_hand_back` beside `target_in_front`: a hand-back was
/// tried and Windows did not let it happen.
pub(crate) const HAND_BACK_FAILED: &str = "failed";
/// `details.foreground_hand_back` beside `target_in_front`: the target's
/// window came to the front when the user may have picked it, so it was left.
pub(crate) const LEFT_FOR_USER: &str = "left_for_user";

/// What the watch did with the foreground, for the result's details.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum HandBackOutcome {
    /// Nothing was watched, or nothing needed saying.
    #[default]
    None,
    /// A window of the target took the foreground and it was handed back.
    HandedBack,
    /// A hand-back was tried and the target's window stayed in front.
    Failed,
    /// The target's window is in front, left alone as possibly the user's.
    LeftForUser,
}

/// How the watch ended, read once the action is over.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Watched {
    /// Whether a hand-back was ever asked of Windows.
    pub(crate) tried: bool,
    /// Whether the last hand-back asked for was not yet seen to work.
    pub(crate) pending: bool,
    pub(crate) last: WatchAction,
}

/// Whether the look right after the action calls for a watch: the target
/// created a top-level window that is not a tool window, or a window of the
/// target other than the one in front before took the foreground.
pub(crate) fn watch_needed(created_window: bool, target_took_front: bool) -> bool {
    created_window || target_took_front
}

/// Whether a window the target already showed before the action, now in
/// front, is taken as the target's own move: the first time it is seen in
/// front, only within the grace of the action being sent. Once taken, it
/// stays taken for the rest of the watch, as a launch's raised window does.
pub(crate) fn takes_as_raised(
    shown_before: bool,
    already_raised: bool,
    within_grace_of_action: bool,
) -> bool {
    shown_before && (already_raised || within_grace_of_action)
}

/// Whether the window in front counts as one the action made the target
/// show (`foreground_step`'s handed window): a window of the target, not the
/// one in front before, that was not shown before the action or was taken as
/// raised.
pub(crate) fn counts_as_handed(
    is_target: bool,
    is_prior: bool,
    shown_before: bool,
    raised: bool,
) -> bool {
    is_target && !is_prior && (!shown_before || raised)
}

/// When the grace of the window in front starts: for a window shown before
/// the action, when the action was sent; for a new one, when it was first
/// seen (`None`, no grace, when that is not known).
pub(crate) fn grace_start(
    shown_before: bool,
    first_seen: Option<Instant>,
    action_started: Instant,
) -> Option<Instant> {
    if shown_before {
        Some(action_started)
    } else {
        first_seen
    }
}

/// Whether the grace from `action_started` still runs at `now`.
pub(crate) fn within_grace_of_action(action_started: Instant, now: Instant) -> bool {
    within_grace(Some(action_started), now)
}

/// What the result says, from how the watch ended and the foreground after
/// it: `came_forward` when the target's process is in front and was not
/// before; `foreground_is_prior` when the window that had the foreground
/// before has it again.
pub(crate) fn outcome(
    watched: Option<Watched>,
    came_forward: bool,
    foreground_is_prior: bool,
) -> HandBackOutcome {
    let Some(watched) = watched else {
        return HandBackOutcome::None;
    };
    if came_forward {
        if watched.last == WatchAction::StopFailed || watched.pending {
            HandBackOutcome::Failed
        } else if watched.last == WatchAction::StopForUser {
            HandBackOutcome::LeftForUser
        } else {
            HandBackOutcome::None
        }
    } else if watched.tried && foreground_is_prior {
        HandBackOutcome::HandedBack
    } else {
        HandBackOutcome::None
    }
}

/// Keeps the hand-back state of one watch: what `HandBack` remembers, and
/// whether any hand-back was asked for.
#[derive(Debug, Default)]
pub(crate) struct WatchState {
    pub(crate) hand_back: HandBack,
    pub(crate) tried: bool,
}

impl WatchState {
    pub(crate) fn watched(&self, last: WatchAction) -> Watched {
        Watched {
            tried: self.tried,
            pending: self.hand_back.pending(),
            last,
        }
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{
        WatchState, Watched, counts_as_handed, grace_start, takes_as_raised, watch_needed,
        within_grace_of_action,
    };
    use crate::actions::foreground_hold::window_belongs_to;
    use crate::system::launch::{
        HANDOFF_FOREGROUND_HOLD, HANDOFF_FOREGROUND_WATCH, WatchAction, foreground_step,
        user_input_since, within_grace,
    };
    use crate::system::window::window_enum::enumerate_top_level;
    use std::collections::HashMap;
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::HWND;

    /// One top-level window of the target, as one listing read it.
    struct TargetWindow {
        handle: isize,
        shown: bool,
        tool: bool,
    }

    /// The target's windows before the action, and when it was sent.
    pub(crate) struct ActionWatch {
        pid: u32,
        prior: HWND,
        /// `GetTickCount` when the action began, for `user_input_since`.
        tick: u32,
        started: Instant,
        /// Every top-level window of the target before the action, hidden
        /// ones too, and whether it was shown.
        before: HashMap<isize, bool>,
    }

    impl ActionWatch {
        /// Reads the target's windows; call it before the action is sent.
        /// `None` when they could not be listed: nothing is watched then.
        pub(crate) fn begin(pid: u32, prior: HWND) -> Option<Self> {
            let tick = unsafe { windows_sys::Win32::System::SystemInformation::GetTickCount() };
            let started = Instant::now();
            let before = target_windows(pid)?
                .into_iter()
                .map(|window| (window.handle, window.shown))
                .collect();
            Some(Self {
                pid,
                prior,
                tick,
                started,
                before,
            })
        }

        /// Called right after the hold's wait, with the lock still held.
        /// Looks once; when nothing calls for a watch, calls `unlock` and
        /// returns `None` at once. Otherwise watches the foreground with the
        /// lock held, calls `unlock`, and watches on, handing the foreground
        /// back by the launch's rules.
        pub(crate) fn finish(
            self,
            deadline: agent_desktop_core::Deadline,
            mut unlock: impl FnMut(),
        ) -> Option<Watched> {
            use windows_sys::Win32::UI::WindowsAndMessaging::{
                GetForegroundWindow, IsIconic, IsWindow,
            };
            let mut seen: HashMap<isize, Instant> = HashMap::new();
            let Some(windows) = target_windows(self.pid) else {
                unlock();
                return None;
            };
            // Seen first by this look: timed from when the action was sent.
            let created = self.note(&windows, &mut seen, self.started);
            let front = unsafe { GetForegroundWindow() };
            let target_took_front =
                !front.is_null() && front != self.prior && window_belongs_to(front, self.pid);
            // A prior window gone or minimized is not given the foreground
            // back, as a launch leaves it.
            let restorable = !self.prior.is_null()
                && unsafe { IsWindow(self.prior) } != 0
                && unsafe { IsIconic(self.prior) } == 0;
            if !watch_needed(created, target_took_front) || !restorable {
                unlock();
                return None;
            }
            let mut state = WatchState::default();
            let mut raised: Vec<isize> = Vec::new();
            let mut last = self.watch(
                HANDOFF_FOREGROUND_HOLD,
                deadline,
                &mut seen,
                &mut raised,
                &mut state,
            );
            unlock();
            if last == WatchAction::Wait {
                last = self.watch(
                    HANDOFF_FOREGROUND_WATCH,
                    deadline,
                    &mut seen,
                    &mut raised,
                    &mut state,
                );
            }
            Some(state.watched(last))
        }

        /// Records `at` for each window of `windows` shown now that was not
        /// shown before and has no time yet; returns whether the target has a
        /// top-level window, not a tool window, that it did not have before.
        fn note(
            &self,
            windows: &[TargetWindow],
            seen: &mut HashMap<isize, Instant>,
            at: Instant,
        ) -> bool {
            let mut created = false;
            for window in windows {
                let before = self.before.get(&window.handle).copied();
                if window.shown && before != Some(true) {
                    seen.entry(window.handle).or_insert(at);
                }
                if before.is_none() && !window.tool {
                    created = true;
                }
            }
            created
        }

        /// Watches the foreground for `span` (inside `deadline`) and hands it
        /// back to the window that had it whenever `foreground_step` says so.
        /// `Wait` when the span ran out; a stop otherwise.
        fn watch(
            &self,
            span: Duration,
            deadline: agent_desktop_core::Deadline,
            seen: &mut HashMap<isize, Instant>,
            raised: &mut Vec<isize>,
            state: &mut WatchState,
        ) -> WatchAction {
            use windows_sys::Win32::UI::WindowsAndMessaging::{
                GetForegroundWindow, SetForegroundWindow,
            };
            let until = Instant::now() + span.min(deadline.remaining());
            loop {
                if let Some(windows) = target_windows(self.pid) {
                    self.note(&windows, seen, Instant::now());
                }
                let front = unsafe { GetForegroundWindow() };
                let key = front as isize;
                let now = Instant::now();
                let is_prior = front == self.prior;
                let is_target = !front.is_null() && window_belongs_to(front, self.pid);
                let shown_before = self.before.get(&key).copied() == Some(true);
                if is_target
                    && !is_prior
                    && takes_as_raised(
                        shown_before,
                        raised.contains(&key),
                        within_grace_of_action(self.started, now),
                    )
                    && !raised.contains(&key)
                {
                    raised.push(key);
                }
                let handed =
                    counts_as_handed(is_target, is_prior, shown_before, raised.contains(&key));
                let shown_at = grace_start(shown_before, seen.get(&key).copied(), self.started);
                let step = foreground_step(
                    front.is_null(),
                    is_prior,
                    handed,
                    user_input_since(self.tick),
                    within_grace(shown_at, now),
                );
                match state.hand_back.observe(step, is_prior, handed) {
                    WatchAction::Wait => {}
                    WatchAction::Restore => {
                        state.tried = true;
                        // Straight to the window that had it, as a launch
                        // does: never through the adapter's window focusing,
                        // whose refusal of Sprint Coder's own windows does
                        // not apply to giving the foreground back.
                        unsafe { SetForegroundWindow(self.prior) };
                    }
                    stop => return stop,
                }
                if Instant::now() >= until {
                    return WatchAction::Wait;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }

    /// Every top-level window of `pid` (its own, owned by one of its windows,
    /// or a shell frame hosting it), hidden ones too; `None` when the windows
    /// could not be listed. Reads only.
    fn target_windows(pid: u32) -> Option<Vec<TargetWindow>> {
        let mut windows = Vec::new();
        enumerate_top_level(|window| {
            if window_belongs_to(window.handle, pid) {
                windows.push(TargetWindow {
                    handle: window.handle as isize,
                    shown: window.visible && !window.cloaked,
                    tool: window.tool,
                });
            }
            true
        })
        .ok()?;
        Some(windows)
    }
}

#[cfg(target_os = "windows")]
pub(crate) use imp::ActionWatch;

#[cfg(test)]
#[path = "foreground_return_tests.rs"]
mod tests;
