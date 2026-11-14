// Added by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::{
    ButtonRead, HoldReport, LOCK_UNAVAILABLE, SETTLE_INCOMPLETE, SETTLE_NO_WINDOW, Settle,
    TARGET_IN_FRONT, lock_needed, lock_unavailable_refusal, note_report, target_came_forward,
};
use agent_desktop_core::{ActionResult, AdapterError, ErrorCode, InteractionPolicy};

fn report(locked: bool, settle: Settle, came_forward: bool) -> HoldReport {
    HoldReport {
        locked,
        settle,
        came_forward,
    }
}

#[test]
fn only_a_target_that_was_behind_and_is_now_in_front_came_forward() {
    assert!(target_came_forward(false, true));
    assert!(!target_came_forward(true, true));
    assert!(!target_came_forward(false, false));
    assert!(!target_came_forward(true, false));
}

#[test]
fn a_clean_hold_adds_nothing() {
    assert!(report(true, Settle::Settled, false).entries().is_empty());
    let noted = note_report(
        Ok(ActionResult::delivered_unverified("click")),
        report(true, Settle::Settled, false),
    );
    assert!(noted.expect("ok").details.is_none());
}

#[test]
fn every_gap_in_the_hold_is_named() {
    let entries = report(false, Settle::NotTried, true).entries();
    assert!(entries.contains(&("foreground", TARGET_IN_FRONT)));
    assert!(entries.contains(&("foreground_lock", LOCK_UNAVAILABLE)));
    assert_eq!(
        report(true, Settle::Incomplete, false).entries(),
        vec![("foreground_settle", SETTLE_INCOMPLETE)]
    );
    assert_eq!(
        report(true, Settle::NoWindow, false).entries(),
        vec![("foreground_settle", SETTLE_NO_WINDOW)]
    );
}

#[test]
fn the_report_is_written_beside_the_details_of_a_result() {
    let result =
        ActionResult::delivered_unverified("click").with_details(serde_json::json!({ "kept": 1 }));
    let details = note_report(Ok(result), report(false, Settle::Incomplete, true))
        .expect("ok")
        .details
        .expect("details");
    assert_eq!(details["kept"], 1);
    assert_eq!(details["foreground"], TARGET_IN_FRONT);
    assert_eq!(details["foreground_lock"], LOCK_UNAVAILABLE);
    assert_eq!(details["foreground_settle"], SETTLE_INCOMPLETE);
}

#[test]
fn the_report_is_written_into_an_error_too() {
    let error = AdapterError::new(ErrorCode::ActionFailed, "failed")
        .with_details(serde_json::json!({ "kind": "x" }));
    let error = note_report(Err(error), report(true, Settle::Settled, true)).expect_err("err");
    let details = error.details.expect("details");
    assert_eq!(details["kind"], "x");
    assert_eq!(details["foreground"], TARGET_IN_FRONT);
    let bare = note_report(
        Err(AdapterError::new(ErrorCode::ActionFailed, "failed")),
        report(false, Settle::NotTried, false),
    )
    .expect_err("err");
    assert_eq!(
        bare.details.expect("details")["foreground_lock"],
        LOCK_UNAVAILABLE
    );
}

#[test]
fn details_that_are_not_an_object_are_kept_under_their_own_key() {
    let result =
        ActionResult::delivered_unverified("click").with_details(serde_json::json!("note"));
    let details = note_report(Ok(result), report(true, Settle::Settled, true))
        .expect("ok")
        .details
        .expect("details");
    assert_eq!(details["details"], "note");
    assert_eq!(details["foreground"], TARGET_IN_FRONT);
}

#[test]
fn without_the_lock_a_click_that_may_be_a_win32_button_is_refused() {
    assert!(lock_needed(false, true, ButtonRead::Button));
    assert!(lock_needed(false, true, ButtonRead::Unread));
    assert!(!lock_needed(false, true, ButtonRead::NotButton));
    assert!(!lock_needed(false, false, ButtonRead::Button));
    assert!(!lock_needed(true, true, ButtonRead::Button));
    assert!(!lock_needed(true, true, ButtonRead::Unread));
}

#[test]
fn the_lock_refusal_sends_nothing_and_may_be_retried() {
    let error = lock_unavailable_refusal(InteractionPolicy::headless(), ButtonRead::Unread);
    assert_eq!(error.code, ErrorCode::PolicyDenied);
    let details = error.details.expect("details");
    assert_eq!(details["kind"], "foreground_lock_unavailable");
    assert_eq!(details["control_read"], "unread");
    assert_eq!(details["retryable"], true);
    assert!(
        error
            .suggestion
            .as_deref()
            .unwrap_or("")
            .contains("--headed")
    );
}

#[test]
fn the_hold_waits_with_sent_messages_and_never_moves_the_foreground() {
    let hold = include_str!("foreground_hold.rs");
    let code = hold
        .split("#[cfg(test)]")
        .next()
        .expect("code before the tests");
    let calls = code.replace("LockSetForegroundWindow", "");
    assert!(
        !calls.contains("SetForegroundWindow("),
        "the hold must never move the foreground itself"
    );
    assert!(
        !code.contains("WaitForInputIdle("),
        "WaitForInputIdle waits only for a process's first idle and cannot stand for the wait"
    );
    assert!(code.contains("SendMessageTimeoutW("));
    assert!(code.contains("SMTO_ABORTIFHUNG"));
    assert!(code.contains("for _ in 0..2"));
}

#[test]
fn dispatch_decides_before_it_locks() {
    let source = include_str!("dispatch.rs");
    let body = source
        .split("pub(crate) fn execute_action_impl(")
        .nth(1)
        .expect("execute_action_impl");
    let check = body.find("check_background_click(").expect("click check");
    let pid = body
        .find("target_pid(element, deadline)")
        .expect("target pid");
    let lock = body.find("ForegroundHold::begin(").expect("lock");
    assert!(check < lock && pid < lock, "reads come before the lock");
    let refusal = body
        .find("lock_unavailable_refusal(")
        .expect("lock refusal");
    let send = body.find("let result = run_action(").expect("the action");
    assert!(
        refusal < send,
        "a missing lock is refused before anything is sent"
    );
    assert!(body.contains("note_report(result, report)"));
}

#[cfg(target_os = "windows")]
#[test]
fn holds_that_overlap_in_one_process_share_the_lock() {
    // Takes the foreground lock for a moment only; moves no window.
    let first = super::ForegroundHold::begin(false).expect("a hold");
    let second = super::ForegroundHold::begin(false).expect("a hold");
    if first.locked() {
        assert!(
            second.locked(),
            "a second hold must share the lock, not fail on it"
        );
    }
    assert!(super::ForegroundHold::begin(true).is_none());
    drop(second);
    drop(first);
}
