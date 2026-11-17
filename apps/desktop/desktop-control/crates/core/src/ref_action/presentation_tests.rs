// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::shows_pointer;
use crate::Action;

#[test]
fn pressable_controls_show_the_pointer_however_they_are_reached() {
    for role in [
        "button",
        "link",
        "checkbox",
        "tab",
        "menuitem",
        "switch",
        "disclosure",
    ] {
        for action in [
            Action::Click,
            Action::ScrollTo,
            Action::SetFocus,
            Action::Toggle,
        ] {
            assert!(shows_pointer(role, &action), "{role} {action:?}");
        }
    }
}

#[test]
fn text_entry_keeps_the_arrow_even_when_clicked() {
    for role in ["textfield", "combobox", "datefield"] {
        for action in [Action::Click, Action::DoubleClick, Action::SetFocus] {
            assert!(!shows_pointer(role, &action), "{role} {action:?}");
        }
    }
}

#[test]
fn other_elements_show_the_pointer_only_when_clicked() {
    for role in ["group", "cell", "statictext", "unknown", "row"] {
        assert!(shows_pointer(role, &Action::Click), "{role}");
        assert!(shows_pointer(role, &Action::RightClick), "{role}");
        assert!(!shows_pointer(role, &Action::ScrollTo), "{role}");
        assert!(
            !shows_pointer(role, &Action::SetValue("x".into())),
            "{role}"
        );
    }
}

#[path = "presentation_lease_tests.rs"]
mod lease;

#[path = "presentation_shared_cursor_tests.rs"]
mod shared_cursor;

#[path = "presentation_caret_tests.rs"]
mod caret;

fn travelled(x: f64, y: f64, window: Option<&str>) -> super::Travelled {
    super::Travelled {
        x,
        y,
        window: window.map(str::to_owned),
    }
}

#[test]
fn the_travel_under_the_lease_is_skipped_only_at_the_same_point_and_window() {
    let at = crate::Point { x: 100.0, y: 50.0 };
    let before = travelled(100.5, 50.5, Some("w-1"));
    assert!(!super::travels_again(Some(&before), &at, Some("w-1")));
    assert!(
        super::travels_again(Some(&before), &at, Some("w-2")),
        "an element found in a sheet of w-1 draws the cursor again above the sheet"
    );
    assert!(super::travels_again(
        Some(&before),
        &crate::Point { x: 140.0, y: 50.0 },
        Some("w-1")
    ));
    assert!(super::travels_again(None, &at, Some("w-1")));
    assert!(!super::travels_again(
        Some(&travelled(100.0, 50.0, None)),
        &at,
        None
    ));
}
