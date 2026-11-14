// Added by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::{TARGET_IN_FRONT, note_target_in_front, target_came_forward};
use agent_desktop_core::ActionResult;

#[test]
fn only_a_target_that_was_behind_and_is_now_in_front_came_forward() {
    assert!(target_came_forward(false, true));
    assert!(!target_came_forward(true, true));
    assert!(!target_came_forward(false, false));
    assert!(!target_came_forward(true, false));
}

#[test]
fn a_target_that_came_forward_is_written_beside_the_details_there() {
    let result =
        ActionResult::delivered_unverified("click").with_details(serde_json::json!({ "kept": 1 }));
    let details = note_target_in_front(result, true).details.expect("details");
    assert_eq!(details["foreground"], TARGET_IN_FRONT);
    assert_eq!(details["kept"], 1);
    let bare = note_target_in_front(ActionResult::delivered_unverified("click"), true);
    assert_eq!(
        bare.details.expect("details")["foreground"],
        TARGET_IN_FRONT
    );
}

#[test]
fn a_target_left_behind_adds_nothing() {
    let noted = note_target_in_front(ActionResult::delivered_unverified("click"), false);
    assert!(noted.details.is_none());
}

#[test]
fn dispatch_holds_the_foreground_only_for_actions_that_may_not_take_it() {
    let source = include_str!("dispatch.rs");
    assert!(source.contains("ForegroundHold::begin(request.policy.allow_focus_steal)"));
    let hold = include_str!("foreground_hold.rs");
    let code = hold
        .split("#[cfg(test)]")
        .next()
        .expect("code before the tests");
    assert!(
        !code
            .replace("LockSetForegroundWindow", "")
            .contains("SetForegroundWindow"),
        "the hold must never move the foreground itself"
    );
}
