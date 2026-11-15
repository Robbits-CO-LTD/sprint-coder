// Added by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::{
    HandBackOutcome, WatchState, Watched, counts_as_handed, grace_start, outcome, takes_as_raised,
    watch_needed, within_grace_of_action,
};
use crate::system::launch::{WatchAction, foreground_step, within_grace};
use std::time::{Duration, Instant};

/// One read of the foreground during a watch.
#[derive(Clone, Copy)]
enum Front {
    /// The window that had the foreground before the action.
    Prior,
    /// A window of the target that was not shown before the action, first
    /// seen at this many milliseconds after the action was sent.
    New(u64),
    /// A window the target already showed before the action.
    Existing,
    /// A window of another process.
    Other,
}

/// Drives a watch over reads of (front, user input, milliseconds since the
/// action was sent), through the same steps as the watch on Windows, and
/// returns the action of each read and how the watch ended.
fn drive(reads: &[(Front, bool, u64)]) -> (Vec<WatchAction>, Watched) {
    let started = Instant::now();
    let mut state = WatchState::default();
    let mut raised = false;
    let mut actions = Vec::new();
    for &(front, input, at) in reads {
        let now = started + Duration::from_millis(at);
        let (is_prior, is_target, shown_before, first_seen) = match front {
            Front::Prior => (true, false, false, None),
            Front::New(seen) => (
                false,
                true,
                false,
                Some(started + Duration::from_millis(seen)),
            ),
            Front::Existing => (false, true, true, None),
            Front::Other => (false, false, false, None),
        };
        if is_target
            && !is_prior
            && takes_as_raised(shown_before, raised, within_grace_of_action(started, now))
        {
            raised = true;
        }
        let handed = counts_as_handed(is_target, is_prior, shown_before, raised && shown_before);
        let shown_at = grace_start(shown_before, first_seen, started);
        let step = foreground_step(false, is_prior, handed, input, within_grace(shown_at, now));
        let action = state.hand_back.observe(step, is_prior, handed);
        if action == WatchAction::Restore {
            state.tried = true;
        }
        actions.push(action);
        if matches!(action, WatchAction::StopFailed | WatchAction::StopForUser) {
            break;
        }
    }
    let last = *actions.last().expect("a read");
    (actions, state.watched(last))
}

/// An ordinary click: no new window and the front where it was. Nothing is
/// watched, so the action returns at once and the result says nothing.
#[test]
fn an_action_that_opens_nothing_is_not_watched() {
    assert!(!watch_needed(false, false));
    assert!(watch_needed(true, false), "a new window, even still hidden");
    assert!(
        watch_needed(false, true),
        "a window of the target took the front"
    );
    assert_eq!(outcome(None, false, true), HandBackOutcome::None);
}

/// The #1293 case: the click makes the target open a window that takes the
/// front while the user gives no input. It is handed back, and the result
/// says so.
#[test]
fn a_new_window_that_takes_the_front_without_input_is_handed_back() {
    let (actions, watched) = drive(&[
        (Front::Prior, false, 300),
        (Front::New(340), false, 360),
        (Front::Prior, false, 380),
    ]);
    assert_eq!(
        actions,
        [WatchAction::Wait, WatchAction::Restore, WatchAction::Wait]
    );
    assert_eq!(
        outcome(Some(watched), false, true),
        HandBackOutcome::HandedBack
    );
}

/// Without input, a late take is handed back too, as a launch does.
#[test]
fn without_input_a_late_take_is_handed_back() {
    let (actions, _) = drive(&[(Front::New(100), false, 1_500)]);
    assert_eq!(actions, [WatchAction::Restore]);
}

/// With input, a window that takes the front just after it appeared is still
/// the app's move; later it may be the user's click on it, and is left.
#[test]
fn with_input_only_a_take_within_the_grace_of_first_sight_is_handed_back() {
    let (actions, _) = drive(&[(Front::New(400), true, 450)]);
    assert_eq!(actions, [WatchAction::Restore]);
    let (actions, watched) = drive(&[(Front::New(400), true, 900)]);
    assert_eq!(actions, [WatchAction::StopForUser]);
    assert_eq!(
        outcome(Some(watched), true, false),
        HandBackOutcome::LeftForUser
    );
}

/// A window first seen by the look right after the action is timed from when
/// the action was sent: after a slow action, with input, it gets no grace.
#[test]
fn a_window_seen_first_after_the_action_is_timed_from_the_action() {
    let started = Instant::now();
    assert_eq!(
        grace_start(false, Some(started), started),
        Some(started),
        "the first look records the action's start"
    );
    let (actions, _) = drive(&[(Front::New(0), true, 700)]);
    assert_eq!(actions, [WatchAction::StopForUser]);
    assert_eq!(grace_start(false, None, started), None, "unknown: no grace");
}

/// A window the target already showed, brought forward right after the
/// action (an app that activates its main window instead of opening one), is
/// handed back; one that comes forward later is left alone, input or not.
#[test]
fn an_existing_window_is_handed_back_only_right_after_the_action() {
    let (actions, _) = drive(&[(Front::Existing, true, 120)]);
    assert_eq!(actions, [WatchAction::Restore]);
    let (actions, _) = drive(&[(Front::Existing, false, 120)]);
    assert_eq!(actions, [WatchAction::Restore]);
    for input in [false, true] {
        let (actions, watched) =
            drive(&[(Front::Prior, input, 200), (Front::Existing, input, 800)]);
        assert_eq!(
            actions,
            [WatchAction::Wait, WatchAction::StopForUser],
            "input {input}"
        );
        assert_eq!(
            outcome(Some(watched), true, false),
            HandBackOutcome::LeftForUser
        );
    }
}

/// An existing window taken as raised stays taken: when Windows refuses the
/// hand-back and it stays in front past the grace, that is a failure, not the
/// user's choice.
#[test]
fn a_refused_hand_back_is_a_failure() {
    let (actions, watched) = drive(&[
        (Front::Existing, true, 100),
        (Front::Existing, true, 200),
        (Front::Existing, true, 600),
    ]);
    assert_eq!(
        actions,
        [
            WatchAction::Restore,
            WatchAction::Restore,
            WatchAction::StopFailed
        ]
    );
    assert_eq!(outcome(Some(watched), true, false), HandBackOutcome::Failed);
    let (_, watched) = drive(&[(Front::New(10), false, 20), (Front::New(10), false, 2_000)]);
    assert!(watched.pending, "tried and never seen to work");
    assert_eq!(outcome(Some(watched), true, false), HandBackOutcome::Failed);
}

/// Another process's window in front is the user's doing: the watch stops
/// and never touches it.
#[test]
fn another_process_in_front_is_left_alone() {
    let (actions, watched) = drive(&[(Front::Other, false, 50)]);
    assert_eq!(actions, [WatchAction::StopForUser]);
    assert!(!watched.tried);
    assert_eq!(outcome(Some(watched), false, false), HandBackOutcome::None);
}

/// A window that opened behind and never took the front: watched, nothing
/// handed back, nothing said.
#[test]
fn a_new_window_left_behind_adds_nothing() {
    let (actions, watched) = drive(&[(Front::Prior, true, 300), (Front::Prior, true, 2_000)]);
    assert_eq!(actions, [WatchAction::Wait, WatchAction::Wait]);
    assert_eq!(outcome(Some(watched), false, true), HandBackOutcome::None);
}

#[test]
fn only_a_window_of_the_target_counts() {
    assert!(counts_as_handed(true, false, false, false), "new");
    assert!(counts_as_handed(true, false, true, true), "raised");
    assert!(
        !counts_as_handed(true, false, true, false),
        "existing, not raised"
    );
    assert!(
        !counts_as_handed(true, true, false, false),
        "the prior window"
    );
    assert!(
        !counts_as_handed(false, false, false, false),
        "another process"
    );
}

/// The watch reuses the launch's decision and spans, and the hand-back lives
/// here, not in the hold.
#[test]
fn the_watch_uses_the_launch_rules() {
    let code = include_str!("foreground_return.rs");
    let code = code.split("#[cfg(test)]").next().expect("code");
    for name in [
        "foreground_step(",
        "HANDOFF_FOREGROUND_HOLD",
        "HANDOFF_FOREGROUND_WATCH",
        "user_input_since(",
    ] {
        assert!(code.contains(name), "{name}");
    }
    assert!(
        !code.contains("focus_window"),
        "the hand-back never goes through the adapter's focus_window"
    );
}
