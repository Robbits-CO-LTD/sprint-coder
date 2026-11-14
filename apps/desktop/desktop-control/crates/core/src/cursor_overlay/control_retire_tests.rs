// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::CursorOverlayControl;
use crate::ErrorCode;

#[test]
fn a_retire_names_its_session_and_its_agent() {
    let retire = CursorOverlayControl::retire("run-1".into(), "worker-a".into());

    assert_eq!(retire.session_id(), "run-1");
    assert_eq!(retire.agent_id(), Some("worker-a"));
    assert!(retire.is_retire());
    assert!(
        !retire.is_disable(),
        "a retire is not a session-wide disable"
    );
    assert!(retire.expects_acknowledgement());
    assert_eq!(retire.label(), None);
    retire.validate().expect("a valid retire");
}

#[test]
fn a_retire_keeps_its_agent_whatever_agent_is_applied() {
    let retire = CursorOverlayControl::retire("run-1".into(), "worker-a".into());

    assert_eq!(
        retire.clone().with_agent_id(None).agent_id(),
        Some("worker-a")
    );
    assert_eq!(
        retire.with_agent_id(Some("worker-b".into())).agent_id(),
        Some("worker-a")
    );
}

#[test]
fn a_retire_round_trips_and_requires_its_agent_on_the_wire() {
    let retire = CursorOverlayControl::retire("run-1".into(), "worker-a".into());
    let encoded = serde_json::to_value(&retire).expect("a retire serializes");
    assert_eq!(encoded["action"], "retire");
    assert_eq!(encoded["agent_id"], "worker-a");
    let decoded: CursorOverlayControl =
        serde_json::from_value(encoded).expect("a retire deserializes");
    assert_eq!(decoded, retire);

    let without_agent = serde_json::from_value::<CursorOverlayControl>(serde_json::json!({
        "action": "retire",
        "session_id": "run-1",
    }));
    assert!(
        without_agent.is_err(),
        "a retire that names no agent is refused"
    );
}

#[test]
fn a_retire_with_an_invalid_agent_is_refused() {
    let error = CursorOverlayControl::retire("run-1".into(), "not a valid id/".into())
        .validate()
        .expect_err("an agent id outside the accepted form");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
}
