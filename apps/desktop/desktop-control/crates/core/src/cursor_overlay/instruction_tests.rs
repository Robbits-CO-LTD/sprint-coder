// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::{CursorOverlayConfig, CursorOverlayInstruction, CursorPhase};
use crate::Point;

fn instruction(x: f64, phase: CursorPhase) -> CursorOverlayInstruction {
    let config = CursorOverlayConfig::enabled(None, 6).expect("valid config");
    CursorOverlayInstruction::new(Point { x, y: 50.0 }, &config, false)
        .expect("valid instruction")
        .with_phase(phase)
}

#[test]
fn a_travel_somewhere_else_departs_and_one_that_stays_put_does_not() {
    let at = Point { x: 100.0, y: 50.0 };

    assert!(instruction(140.0, CursorPhase::Travel).departs_from(Some(&at)));
    assert!(!instruction(101.0, CursorPhase::Travel).departs_from(Some(&at)));
    assert!(instruction(101.0, CursorPhase::Travel).departs_from(None));
}

#[test]
fn the_window_rides_the_wire_and_an_instruction_without_one_is_unchanged() {
    let bare = serde_json::to_value(instruction(10.0, CursorPhase::Travel)).expect("encodes");
    assert!(
        bare.get("window").is_none(),
        "no window, no key: the wire stays what earlier renderers read"
    );

    let named = instruction(10.0, CursorPhase::Travel).with_window(Some("w-4242".into()));
    let wire = serde_json::to_vec(&named).expect("encodes");
    let decoded: CursorOverlayInstruction = serde_json::from_slice(&wire).expect("decodes");
    assert_eq!(decoded.window(), Some("w-4242"));
    assert_eq!(decoded, named);
}

#[test]
fn an_unusable_window_id_is_dropped_and_refused_on_the_reading_side() {
    let empty = instruction(10.0, CursorPhase::Travel).with_window(Some(String::new()));
    assert_eq!(empty.window(), None);
    let long = instruction(10.0, CursorPhase::Travel).with_window(Some("w".repeat(65)));
    assert_eq!(long.window(), None);

    let mut wire = serde_json::to_value(instruction(10.0, CursorPhase::Travel)).expect("encodes");
    wire["window"] = serde_json::json!("w".repeat(65));
    let decoded: CursorOverlayInstruction = serde_json::from_value(wire).expect("decodes");
    assert!(decoded.validate().is_err());
}

#[test]
fn only_travels_and_drags_depart() {
    let at = Point { x: 100.0, y: 50.0 };
    for phase in [CursorPhase::Effect, CursorPhase::Caret] {
        assert!(
            !instruction(400.0, phase).departs_from(Some(&at)),
            "{phase:?}"
        );
    }
    let drag = instruction(400.0, CursorPhase::Drag).with_drag_from(Some(at.clone()));
    assert!(
        !drag.departs_from(Some(&at)),
        "a drag sets off from its origin, where the cursor already is"
    );
}
