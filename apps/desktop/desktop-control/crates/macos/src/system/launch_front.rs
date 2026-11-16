// Changed by Sprint Coder (new file); see VENDORED.md in apps/desktop/desktop-control.
//! Gives the front back when a running instance a launch was passed to takes it.
//!
//! A fresh launch (`--url`, `--no-attach`) without `--activate` of an app that already runs
//! starts a process that passes the launch to the running instance and exits. That instance
//! then brings itself to the front on its own: not activating a launch only reaches an instance
//! the launch starts. So, while such a launch watches for the hand-off, it also reads the front
//! at every pause, and when an instance it may have been passed to (a candidate) takes it, it
//! gives the front back to what was in front just before:
//!
//! - the app way (`TakeKind::App`): the front app became a candidate, right after another app
//!   was in front. That app (as read at the look before) is brought back to the front.
//! - the window way (`TakeKind::Window`): a candidate already in front moved its focus to a
//!   window it did not have before the launch. Its window focused at the look before is brought
//!   back.
//!
//! Any other move of the front (to another app, to a window the candidate already had) is left
//! alone, as the user's. The user's input decides as the Windows launch does: without input since
//! the launch began, a take is given back whenever it is seen; with input (unreadable input counts
//! as input), only a take within `FRONT_APP_GRACE` of the new window being first seen (an app
//! taking the front as it shows its window, too soon for a person to have picked it), and only
//! when what is given back is still right behind the taker's new windows in the window order
//! (`behind`, with nothing else between): the front is read at looks some tens of milliseconds
//! apart, and the user may have moved it between the last look and the take. The result says
//! what was done.

use agent_desktop_core::{AdapterError, Deadline, WindowInfo, system::launch_result::LaunchResult};
use std::time::{Duration, Instant};

use super::launch::{Handoff, HandoffCandidate};

/// How often the front is read while a launch that may be passed on waits.
pub(crate) const FRONT_POLL: Duration = Duration::from_millis(20);

/// How far from the new window being first seen a take still counts as the app's own move while
/// the user gives input: the Windows launch's `HANDOFF_APP_ACTIVATION_GRACE`. An app that takes
/// the front as it shows its window does so within tens of milliseconds (44 ms seen with
/// Chrome); a person needs the window seen first, and a visual reaction alone takes about 200 ms.
pub(crate) const FRONT_APP_GRACE: Duration = Duration::from_millis(300);

/// How long the front is still read after the new window was first seen, for a take that comes
/// after it (inside the launch's deadline). The takes measured came with the window (44 ms after
/// the launched process exited, the window way about 300 ms after it, with the window); a take
/// later than this is not given back with input anyway.
pub(crate) const FRONT_SETTLE: Duration = FRONT_APP_GRACE;

/// The longest one read of the front (the focused app, the focused window, a candidate's windows)
/// may take, so a look stays short beside the watch's own reads.
pub(crate) const FRONT_READ_BUDGET: Duration = Duration::from_millis(150);

/// The least time left before the deadline that a giving back is tried with, and the most it
/// may take: it waits up to 500 ms for the app to report frontmost (`focus::VERIFY_LIMIT`), and
/// the window way also for the window to become main (about 0.45 s measured), then reads the
/// front again.
pub(crate) const RESTORE_MIN_REMAINING: Duration = Duration::from_millis(1_200);

/// Input this close before the launch began still counts as after it: doubt falls on input.
const INPUT_SLACK: Duration = Duration::from_millis(5);

/// The front app as one read saw it: its process and instance token (`None` when the token
/// could not be read: then it is neither a candidate nor an app to give the front back to).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FrontApp {
    pub(crate) pid: i32,
    pub(crate) instance: Option<String>,
}

/// One read of the front.
#[derive(Debug, Clone, Default)]
pub(crate) struct FrontSeen {
    /// The front app, `None` when it could not be read.
    pub(crate) app: Option<FrontApp>,
    /// The focused window of the front app, read only when that app is a candidate.
    pub(crate) focus: Option<WindowInfo>,
    /// Whether a candidate shows a window it did not have before the launch.
    pub(crate) new_window: bool,
}

/// The user's input since the launch began, as far as it can be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Input {
    /// None since the launch began.
    None,
    /// The last input, at or after the launch began.
    At(Instant),
    /// Cannot be read: taken as input at an unknown time.
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TakeKind {
    App,
    Window,
}

/// What the front is given back to.
#[derive(Debug, Clone)]
pub(crate) enum Target {
    App(FrontApp),
    Window(WindowInfo),
}

/// What one try to give the front back did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Restored {
    /// Read again, the front is the target.
    Back,
    /// The operation reported no error, but the front read again is not the target.
    NotBack,
    /// The target no longer runs (or the window no longer exists).
    Gone,
    /// The operation failed.
    Failed,
    /// Too little time was left before the deadline to try.
    NoTime,
}

/// Why a take was left as it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LeftWhy {
    Input,
    NoTarget,
    TargetGone,
    RestoreFailed,
    NoTime,
}

/// What happened to the last take of the front seen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FrontOutcome {
    Restored(TakeKind),
    Left(TakeKind, LeftWhy),
}

struct Take {
    kind: TakeKind,
    at: Instant,
    /// What to give back to, as read at the look before the take.
    target: Option<Target>,
}

/// The front's watch over one launch: every decision, with no reads of its own.
pub(crate) struct FrontWatch {
    candidates: Vec<HandoffCandidate>,
    last_app: Option<FrontApp>,
    /// The focused window (number) of the candidate in front at the last look that read it.
    last_focus: Option<i64>,
    /// The last app in front that was not a candidate.
    app_target: Option<FrontApp>,
    /// The last focused window of a candidate in front that it had before the launch.
    window_target: Option<WindowInfo>,
    new_window_at: Option<Instant>,
    pending: Option<Take>,
    outcome: Option<FrontOutcome>,
    /// Set once a take was left alone or a giving back failed: nothing more is done.
    stopped: bool,
}

/// The candidates a launch watches the front for: only a launch that judges a hand-off
/// (`handoff`, read for a fresh launch), without `--activate`, with an instance to watch.
pub(crate) fn watches_front(
    handoff: Option<&Handoff>,
    activate: bool,
) -> Option<&[HandoffCandidate]> {
    let handoff = handoff.filter(|_| !activate)?;
    (!handoff.candidates.is_empty()).then_some(handoff.candidates.as_slice())
}

/// The number of a window id (`w-<number>`).
pub(crate) fn window_number(id: &str) -> Option<i64> {
    id.strip_prefix("w-")?.parse().ok()
}

/// The input read as the seconds since the last input event (`seconds_since`, any kind, any
/// source), now: `None` when it came before the launch began (`started`), `Unknown` when the
/// reading is not a time.
pub(crate) fn input_since(started: Instant, now: Instant, seconds_since: f64) -> Input {
    if !seconds_since.is_finite() || seconds_since < 0.0 {
        return Input::Unknown;
    }
    let Some(last) = Duration::try_from_secs_f64(seconds_since)
        .ok()
        .and_then(|ago| now.checked_sub(ago))
    else {
        // Earlier than this clock reaches: long before the launch.
        return Input::None;
    };
    if last + INPUT_SLACK >= started {
        Input::At(last)
    } else {
        Input::None
    }
}

/// Whether a giving back may be tried with `remaining` left before the deadline.
pub(crate) fn restore_has_time(remaining: Duration) -> bool {
    remaining >= RESTORE_MIN_REMAINING
}

impl FrontWatch {
    /// Starts from the front read just before the launch (`before`).
    pub(crate) fn begin(candidates: Vec<HandoffCandidate>, before: FrontSeen) -> Self {
        let mut watch = Self {
            candidates,
            last_app: None,
            last_focus: None,
            app_target: None,
            window_target: None,
            new_window_at: None,
            pending: None,
            outcome: None,
            stopped: false,
        };
        watch.remember(&before);
        watch
    }

    fn is_candidate(&self, app: &FrontApp) -> bool {
        self.candidates.iter().any(|candidate| {
            candidate.pid == app.pid
                && app.instance.as_deref() == Some(candidate.process_instance.as_str())
        })
    }

    fn had_before(&self, pid: i32, number: i64) -> bool {
        self.candidates
            .iter()
            .any(|candidate| candidate.pid == pid && candidate.windows_before.contains(&number))
    }

    /// The focused window of the candidate `app` in `seen`, with its number.
    fn focus_of<'a>(seen: &'a FrontSeen, app: &FrontApp) -> Option<(i64, &'a WindowInfo)> {
        let focus = seen.focus.as_ref()?;
        let pid = i32::try_from(focus.pid.get()).ok()?;
        (pid == app.pid).then_some(())?;
        Some((window_number(&focus.id)?, focus))
    }

    /// Whether the candidates' windows still need reading for a first new window.
    pub(crate) fn wants_new_window(&self) -> bool {
        self.new_window_at.is_none()
    }

    /// When the front stops being read after the hand-off was decided: `FRONT_SETTLE` after the
    /// new window was first seen, or the end of the grace of a take waiting for that window.
    pub(crate) fn settle_end(&self) -> Option<Instant> {
        if self.stopped {
            return None;
        }
        let settle = self.new_window_at.map(|seen| seen + FRONT_SETTLE);
        let pending = self.pending.as_ref().map(|take| take.at + FRONT_APP_GRACE);
        settle.max(pending)
    }

    /// Takes one read of the front at `now`: a take by a candidate is given back (`restore`) or
    /// left as the rules say. `input` is read only when a take is decided, and `behind` (whether
    /// the target is still right behind the taker in the window order: `None` when that cannot
    /// be read) only when there was input.
    pub(crate) fn look(
        &mut self,
        seen: FrontSeen,
        now: Instant,
        input: impl FnOnce() -> Input,
        behind: impl FnOnce(&Target) -> Option<bool>,
        restore: impl FnOnce(&Target) -> Restored,
    ) {
        if self.stopped {
            return;
        }
        if seen.new_window && self.new_window_at.is_none() {
            self.new_window_at = Some(now);
        }
        let Some(app) = seen.app.clone() else {
            // Nothing is known of the front now; a take waiting for its window may still be
            // decided by that window.
            self.decide(now, input, behind, restore);
            return;
        };
        let candidate = self.is_candidate(&app);
        let focus = Self::focus_of(&seen, &app).map(|(number, _)| number);
        // A take waiting for its window is decided first; a second one is not read meanwhile.
        let take = if candidate && self.pending.is_none() {
            match &self.last_app {
                Some(last) if !self.is_candidate(last) => Some(TakeKind::App),
                Some(last) if *last == app => match (self.last_focus, focus) {
                    (Some(before), Some(now_focus))
                        if before != now_focus && !self.had_before(app.pid, now_focus) =>
                    {
                        Some(TakeKind::Window)
                    }
                    // The focus before could not be read, and is now on a window the candidate
                    // did not have: taken, though what to give back is not known.
                    (None, Some(now_focus)) if !self.had_before(app.pid, now_focus) => {
                        Some(TakeKind::Window)
                    }
                    _ => None,
                },
                _ => None,
            }
        } else {
            None
        };
        if let Some(pending) = &self.pending {
            // The front left the take waiting for its window (to another app, or another window
            // of the candidate): that move is not undone, and the take is dropped.
            let still = match pending.kind {
                TakeKind::App => candidate,
                TakeKind::Window => candidate && focus.is_none_or(|n| !self.had_before(app.pid, n)),
            };
            if !still {
                self.pending = None;
            }
        }
        if let Some(kind) = take {
            let target = match kind {
                TakeKind::App => self.app_target.clone().map(Target::App),
                TakeKind::Window => self.window_target.clone().map(Target::Window),
            };
            self.pending = Some(Take {
                kind,
                at: now,
                target,
            });
        }
        self.remember(&seen);
        self.decide(now, input, behind, restore);
    }

    /// Ends the watch: a take still waiting for its window, which never came close enough, is
    /// left alone (there was input). Returns what happened to the last take.
    pub(crate) fn finish(
        &mut self,
        now: Instant,
        input: impl FnOnce() -> Input,
        behind: impl FnOnce(&Target) -> Option<bool>,
        restore: impl FnOnce(&Target) -> Restored,
    ) -> Option<FrontOutcome> {
        if !self.stopped {
            self.decide(now, input, behind, restore);
            if let Some(take) = self.pending.take() {
                self.leave(take.kind, LeftWhy::Input);
            }
        }
        self.outcome
    }

    fn remember(&mut self, seen: &FrontSeen) {
        let Some(app) = seen.app.clone() else {
            return;
        };
        if self.is_candidate(&app) {
            if let Some((number, window)) = Self::focus_of(seen, &app) {
                if self.had_before(app.pid, number) {
                    self.window_target = Some(window.clone());
                }
                self.last_focus = Some(number);
            } else if self.last_app.as_ref() != Some(&app) {
                self.last_focus = None;
            }
        } else {
            self.last_focus = None;
            // An app whose instance cannot be read cannot be proven to be the one to give the
            // front back to.
            self.app_target = app.instance.is_some().then(|| app.clone());
        }
        self.last_app = Some(app);
    }

    fn leave(&mut self, kind: TakeKind, why: LeftWhy) {
        self.outcome = Some(FrontOutcome::Left(kind, why));
        self.stopped = true;
    }

    fn decide(
        &mut self,
        now: Instant,
        input: impl FnOnce() -> Input,
        behind: impl FnOnce(&Target) -> Option<bool>,
        restore: impl FnOnce(&Target) -> Restored,
    ) {
        let Some(take) = self.pending.as_ref() else {
            return;
        };
        let kind = take.kind;
        let Some(target) = take.target.clone() else {
            self.pending = None;
            return self.leave(kind, LeftWhy::NoTarget);
        };
        let give_back = match input() {
            Input::None => true,
            Input::At(_) | Input::Unknown => match self.new_window_at {
                Some(shown) if take.at.max(shown) - take.at.min(shown) <= FRONT_APP_GRACE => {
                    // The user may have moved the front between the last look and the take: only
                    // what is still right behind the taker was in front just before it.
                    behind(&target) == Some(true)
                }
                Some(_) => false,
                // Not seen yet: wait for the window within the grace.
                None if now <= take.at + FRONT_APP_GRACE => return,
                None => false,
            },
        };
        self.pending = None;
        if !give_back {
            return self.leave(kind, LeftWhy::Input);
        }
        match restore(&target) {
            Restored::Back => {
                self.outcome = Some(FrontOutcome::Restored(kind));
                // The front is the target again: a later take is judged from there.
                match &target {
                    Target::App(app) => {
                        self.last_app = Some(app.clone());
                        self.last_focus = None;
                        self.app_target = Some(app.clone());
                    }
                    Target::Window(window) => {
                        self.last_focus = window_number(&window.id);
                        self.window_target = Some(window.clone());
                    }
                }
            }
            Restored::NotBack | Restored::Failed => self.leave(kind, LeftWhy::RestoreFailed),
            Restored::Gone => self.leave(kind, LeftWhy::TargetGone),
            Restored::NoTime => self.leave(kind, LeftWhy::NoTime),
        }
    }
}

/// One window in the window order, front to back: its owner and number.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct OrderedWindow {
    pub(crate) pid: i32,
    pub(crate) number: i64,
}

/// Whether `target` is right behind the candidate that took the front, in `order` (the shown
/// windows, front to back). The windows a candidate did not have before the launch are the
/// taker's and are passed over; the first window after them must be the target's: for an app, a
/// window of that app; for a window, that window. Any other window there (another app's, or
/// another window the candidate already had) may be what the user was using just before, so the
/// target is not proven to be it.
pub(crate) fn just_behind(
    target: &Target,
    order: &[OrderedWindow],
    candidates: &[HandoffCandidate],
) -> bool {
    let takers = |window: &OrderedWindow| {
        candidates.iter().any(|candidate| {
            candidate.pid == window.pid && !candidate.windows_before.contains(&window.number)
        })
    };
    let Some(behind) = order.iter().find(|window| !takers(window)) else {
        return false;
    };
    match target {
        Target::App(app) => behind.pid == app.pid,
        Target::Window(target) => {
            matches!(
                (i32::try_from(target.pid.get()), window_number(&target.id)),
                (Ok(pid), Some(number)) if behind.pid == pid && behind.number == number
            )
        }
    }
}

/// Whether `result` is a launch judged as passed on: handed off, or not confirmed.
pub(crate) fn is_handoff(result: &Result<LaunchResult, AdapterError>) -> bool {
    match result {
        Ok(result) => result.handed_off,
        Err(error) => is_unconfirmed(error),
    }
}

fn is_unconfirmed(error: &AdapterError) -> bool {
    error
        .details
        .as_ref()
        .and_then(|details| details.get("kind"))
        .and_then(serde_json::Value::as_str)
        == Some("launch_handoff_unconfirmed")
}

/// The sentence the result adds for what happened to the front.
pub(crate) fn front_note(outcome: FrontOutcome) -> &'static str {
    use FrontOutcome::{Left, Restored};
    use LeftWhy::{Input, NoTarget, NoTime, RestoreFailed, TargetGone};
    use TakeKind::{App, Window};
    match outcome {
        Restored(App) => {
            "The running instance brought itself to the front (a running app may do so on \
             macOS), and the app that was in front just before was brought back to the front: \
             the new window is behind it. It was in front for a moment, and keys typed in that \
             moment may have gone to it."
        }
        Restored(Window) => {
            "The running instance put its new window in front of its window that had the \
             focus, and that window was brought back to the front: the new window is behind \
             it. It was in front for a moment, and keys typed in that moment may have gone to \
             it."
        }
        Left(_, Input) => {
            "The running instance brought its new window to the front, and it was left there \
             because the user gave input at that time (they may have picked it): the new \
             window is likely in front. Tell the user."
        }
        Left(_, NoTarget) => {
            "The running instance brought its new window to the front, and it was left there \
             because what was in front before could not be read: the new window is likely in \
             front. Tell the user."
        }
        Left(_, TargetGone) => {
            "The running instance brought its new window to the front, and it was left there \
             because what was in front before is gone: the new window is likely in front. Tell \
             the user."
        }
        Left(_, RestoreFailed) => {
            "The running instance brought its new window to the front, and bringing back what \
             was in front before did not work: the new window is likely in front. Tell the \
             user."
        }
        Left(_, NoTime) => {
            "The running instance brought its new window to the front, and it was left there \
             because too little time was left before the deadline to bring back what was in \
             front before: the new window is likely in front. Tell the user."
        }
    }
}

/// The `details.front` of a launch not confirmed whose front was taken.
pub(crate) fn front_details(outcome: FrontOutcome) -> serde_json::Value {
    let (kind, left) = match outcome {
        FrontOutcome::Restored(kind) => (kind, None),
        FrontOutcome::Left(kind, why) => (kind, Some(why)),
    };
    serde_json::json!({
        "taken": match kind {
            TakeKind::App => "app",
            TakeKind::Window => "window",
        },
        "restored": left.is_none(),
        "left_because": left.map(|why| match why {
            LeftWhy::Input => "user_input",
            LeftWhy::NoTarget => "target_unknown",
            LeftWhy::TargetGone => "target_gone",
            LeftWhy::RestoreFailed => "restore_failed",
            LeftWhy::NoTime => "no_time",
        }),
    })
}

fn with_note(suggestion: Option<String>, note: &str) -> String {
    match suggestion {
        Some(suggestion) => format!("{suggestion} {note}"),
        None => note.to_owned(),
    }
}

/// `result` with what happened to the front (`outcome`), when a take was seen: a launch handed
/// off adds it to its suggestion, a launch not confirmed to its suggestion and `details.front`.
/// Everything else of the result stays as it was, and any other result (a launch that was not
/// passed on, another error) is returned as it is: the sentences speak of the instance the
/// launch was passed to.
pub(crate) fn annotate(
    result: Result<LaunchResult, AdapterError>,
    outcome: Option<FrontOutcome>,
) -> Result<LaunchResult, AdapterError> {
    let Some(outcome) = outcome else {
        return result;
    };
    let note = front_note(outcome);
    match result {
        Ok(mut result) if result.handed_off => {
            result.suggestion = Some(with_note(result.suggestion.take(), note));
            Ok(result)
        }
        Ok(result) => Ok(result),
        Err(mut error) if is_unconfirmed(&error) => {
            error.suggestion = Some(with_note(error.suggestion.take(), note));
            if let Some(details) = error.details.as_mut().and_then(|d| d.as_object_mut()) {
                details.insert("front".into(), front_details(outcome));
            }
            Err(error)
        }
        Err(error) => Err(error),
    }
}

/// The front's watch over a launch, with the reads and operations of this Mac.
#[cfg(target_os = "macos")]
pub(crate) struct FrontGuard {
    watch: std::cell::RefCell<FrontWatch>,
    started: Instant,
    deadline: Deadline,
}

#[cfg(target_os = "macos")]
impl FrontGuard {
    /// Reads the front once, just before the launch starts; `None` (and no read at all) for a
    /// launch that does not watch the front (`watches_front`).
    pub(crate) fn begin(
        handoff: Option<&Handoff>,
        activate: bool,
        deadline: Deadline,
    ) -> Option<Self> {
        let candidates = watches_front(handoff, activate)?.to_vec();
        let started = Instant::now();
        let before = read_front(&candidates, false, deadline);
        Some(Self {
            watch: std::cell::RefCell::new(FrontWatch::begin(candidates, before)),
            started,
            deadline,
        })
    }

    fn look(&self) {
        let mut watch = self.watch.borrow_mut();
        let seen = read_front(&watch.candidates, watch.wants_new_window(), self.deadline);
        tracing::trace!(
            "launch front: look app={:?} focus={:?} new_window={}",
            seen.app.as_ref().map(|app| app.pid),
            seen.focus.as_ref().map(|window| window.id.as_str()),
            seen.new_window
        );
        let started = self.started;
        let deadline = self.deadline;
        let candidates = watch.candidates.clone();
        watch.look(
            seen,
            Instant::now(),
            || read_input(started),
            |target| behind_now(target, &candidates, deadline),
            |target| restore(target, deadline),
        );
    }

    /// Waits `wait` (inside the deadline), reading the front every `FRONT_POLL`.
    pub(crate) fn pause(&self, wait: Duration) {
        let until = Instant::now() + wait.min(self.deadline.remaining());
        loop {
            self.look();
            let now = Instant::now();
            if now >= until {
                return;
            }
            std::thread::sleep(FRONT_POLL.min(until - now));
        }
    }

    /// Ends the watch for `result`: a launch judged as passed on reads the front a little
    /// longer (`settle_end`); the result then says what happened to the front.
    pub(crate) fn finish(
        &self,
        result: Result<LaunchResult, AdapterError>,
    ) -> Result<LaunchResult, AdapterError> {
        if is_handoff(&result) {
            // The hand-off may have been judged without one pause (its window was already
            // there at the first look): the front is read at least once here, so a take that
            // came with that window is seen and the time to settle starts from it.
            self.look();
            let end = self.watch.borrow().settle_end();
            if let Some(wait) = end.map(|end| end.saturating_duration_since(Instant::now())) {
                if !wait.is_zero() {
                    self.pause(wait);
                }
            }
        }
        let started = self.started;
        let deadline = self.deadline;
        let candidates = self.watch.borrow().candidates.clone();
        let outcome = self.watch.borrow_mut().finish(
            Instant::now(),
            || read_input(started),
            |target| behind_now(target, &candidates, deadline),
            |target| restore(target, deadline),
        );
        annotate(result, outcome)
    }
}

/// Waits `wait`, reading the front meanwhile when the launch watches it.
#[cfg(target_os = "macos")]
pub(crate) fn pause(guard: Option<&FrontGuard>, wait: Duration) {
    match guard {
        Some(guard) => guard.pause(wait),
        None => std::thread::sleep(wait),
    }
}

/// `result`, with what happened to the front when the launch watched it.
#[cfg(target_os = "macos")]
pub(crate) fn finish(
    guard: Option<&FrontGuard>,
    result: Result<LaunchResult, AdapterError>,
) -> Result<LaunchResult, AdapterError> {
    match guard {
        Some(guard) => guard.finish(result),
        None => result,
    }
}

#[cfg(target_os = "macos")]
fn budget(deadline: Deadline) -> Deadline {
    deadline.capped(FRONT_READ_BUDGET)
}

#[cfg(target_os = "macos")]
fn instant(deadline: Deadline) -> Instant {
    Instant::now() + deadline.remaining()
}

/// The front app's pid: accessibility's focused application (read live from that app), or the
/// workspace's frontmost app when that cannot be read.
#[cfg(target_os = "macos")]
fn front_pid(deadline: Deadline) -> Option<i32> {
    let until = instant(budget(deadline));
    let system =
        crate::tree::AXElement(unsafe { accessibility_sys::AXUIElementCreateSystemWide() });
    let focused = (!system.0.is_null())
        .then(|| crate::tree::surface_read::element(&system, "AXFocusedApplication", until))
        .and_then(Result::ok)
        .flatten()
        .and_then(|app| crate::tree::properties::ax_ipc::pid(&app, until).ok());
    focused.filter(|pid| *pid > 0).or_else(|| {
        crate::system::app::workspace_apps::window_owner_snapshot_until(until)
            .ok()?
            .frontmost()
            .map(|owner| owner.pid)
    })
}

#[cfg(target_os = "macos")]
fn read_front(candidates: &[HandoffCandidate], windows: bool, deadline: Deadline) -> FrontSeen {
    let app = front_pid(deadline).map(|pid| FrontApp {
        pid,
        instance: crate::system::process::process_identity::token_for_pid(pid)
            .ok()
            .flatten(),
    });
    let candidate = app.as_ref().is_some_and(|app| {
        candidates.iter().any(|candidate| {
            candidate.pid == app.pid
                && app.instance.as_deref() == Some(candidate.process_instance.as_str())
        })
    });
    let focus = candidate
        .then(|| {
            crate::system::window::window_inventory::focused_window_until(instant(budget(deadline)))
                .ok()
                .flatten()
        })
        .flatten();
    let new_window = windows
        && candidates.iter().any(|candidate| {
            super::launch::window_list(candidate.pid, budget(deadline)).is_some_and(|now| {
                now.iter().any(|window| {
                    window.shown && !candidate.windows_before.contains(&window.number)
                })
            })
        });
    FrontSeen {
        app,
        focus,
        new_window,
    }
}

/// The shown windows now (on screen, layer 0, not fully transparent, at least
/// `MIN_NEW_WINDOW_POINTS` each way, so overlays and helper windows are passed over), front to
/// back as CoreGraphics lists them; `None` when they cannot be read.
#[cfg(target_os = "macos")]
fn window_order() -> Option<Vec<OrderedWindow>> {
    use crate::tree::properties::cf_type::{borrowed_cf_dictionary, borrowed_cf_number};
    use core_foundation::{base::TCFType, string::CFString};
    use core_graphics::display::CGDisplay;
    use core_graphics::window::{
        kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly,
    };
    let list = CGDisplay::window_list_info(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        None,
    )?;
    let mut order = Vec::new();
    for raw in list.get_all_values() {
        let dictionary = borrowed_cf_dictionary(raw as core_foundation::base::CFTypeRef)?;
        let number = |dict: &core_foundation::dictionary::CFDictionary<
            CFString,
            core_foundation::base::CFType,
        >,
                      key: &str| {
            dict.find(CFString::new(key))
                .and_then(|value| borrowed_cf_number(value.as_concrete_TypeRef()))
                .and_then(|value| value.to_f64())
        };
        if number(&dictionary, "kCGWindowLayer") != Some(0.0)
            || !number(&dictionary, "kCGWindowAlpha").is_some_and(|alpha| alpha > 0.0)
        {
            continue;
        }
        let bounds = dictionary
            .find(CFString::new("kCGWindowBounds"))
            .and_then(|bounds| borrowed_cf_dictionary(bounds.as_concrete_TypeRef()));
        let size = bounds
            .as_ref()
            .and_then(|bounds| Some((number(bounds, "Width")?, number(bounds, "Height")?)));
        if !size.is_some_and(|(width, height)| super::launch::counts_as_shown(true, width, height))
        {
            continue;
        }
        let (Some(pid), Some(window)) = (
            number(&dictionary, "kCGWindowOwnerPID"),
            number(&dictionary, "kCGWindowNumber"),
        ) else {
            return None;
        };
        order.push(OrderedWindow {
            pid: pid as i32,
            number: window as i64,
        });
    }
    Some(order)
}

/// Whether `target` is right behind the taker now (`just_behind`), or `None` when the window
/// order cannot be read.
#[cfg(target_os = "macos")]
fn behind_now(
    target: &Target,
    candidates: &[HandoffCandidate],
    deadline: Deadline,
) -> Option<bool> {
    if deadline.is_expired() {
        return None;
    }
    Some(just_behind(target, &window_order()?, candidates))
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
}

/// Input since the launch began, read without any permission: the combined session state, so
/// input another program posted counts too; any input event type (`kCGAnyInputEventType`).
/// Pointer movement and a finger on the trackpad count as well (a trackpad's touches are events
/// of their own, and a swipe between Spaces moves the front without a key or a button): a
/// narrower list would give the front back more often, but could miss a way the user moved it.
#[cfg(target_os = "macos")]
fn read_input(started: Instant) -> Input {
    const COMBINED_SESSION_STATE: i32 = 0;
    const ANY_INPUT_EVENT: u32 = !0;
    let seconds =
        unsafe { CGEventSourceSecondsSinceLastEventType(COMBINED_SESSION_STATE, ANY_INPUT_EVENT) };
    input_since(started, Instant::now(), seconds)
}

/// Brings the app `pid` back to the front. The app that had the front is often Sprint Coder
/// itself (its approval card was just pressed), whose windows desktop control never operates:
/// this is the one operation let through for it (`own_window::front_return_pass`), and it only
/// sets the app's `AXFrontmost`, never anything in its windows.
#[cfg(target_os = "macos")]
fn bring_app_back(pid: i32, deadline: Deadline) -> Result<(), AdapterError> {
    let _pass = crate::system::own_window::front_return_pass()?;
    crate::system::focus::ensure_app_focused(pid, deadline)
}

#[cfg(target_os = "macos")]
fn restore(target: &Target, deadline: Deadline) -> Restored {
    if !restore_has_time(deadline.remaining()) {
        return Restored::NoTime;
    }
    // An app that does not answer must not use up the rest of the launch's time: the hand-off is
    // still being judged after this.
    let deadline = deadline.capped(RESTORE_MIN_REMAINING);
    match target {
        Target::App(app) => {
            let Some(instance) = app.instance.as_deref() else {
                return Restored::Gone;
            };
            match crate::system::process::process_identity::matches_instance(app.pid, instance) {
                Ok(true) => {}
                Ok(false) => return Restored::Gone,
                Err(_) => return Restored::Failed,
            }
            if let Err(error) = bring_app_back(app.pid, deadline) {
                tracing::debug!(
                    "launch front: bringing app {} back failed: {error:?}",
                    app.pid
                );
                return Restored::Failed;
            }
            let front = front_pid(deadline);
            if front == Some(app.pid) {
                Restored::Back
            } else {
                tracing::debug!(
                    "launch front: app {} is not in front again: {front:?}",
                    app.pid
                );
                Restored::NotBack
            }
        }
        Target::Window(window) => {
            let (Ok(pid), Some(number)) =
                (i32::try_from(window.pid.get()), window_number(&window.id))
            else {
                return Restored::Gone;
            };
            match super::launch::window_list(pid, budget(deadline)) {
                Some(windows) if windows.iter().any(|seen| seen.number == number) => {}
                Some(_) => return Restored::Gone,
                None => {
                    tracing::debug!("launch front: windows of {pid} could not be read");
                    return Restored::Failed;
                }
            }
            if let Err(error) = crate::system::focus::focus_window_impl(window, deadline) {
                tracing::debug!("launch front: bringing window {number} back failed: {error:?}");
                return Restored::Failed;
            }
            let focused = crate::system::window::window_inventory::focused_window_until(instant(
                budget(deadline),
            ));
            match focused {
                Ok(Some(focused)) if focused.id == window.id && focused.pid == window.pid => {
                    Restored::Back
                }
                other => {
                    let seen = other.map(|window| window.map(|window| window.id));
                    tracing::debug!("launch front: window {number} is not focused again: {seen:?}");
                    Restored::NotBack
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "launch_front_tests.rs"]
mod tests;
