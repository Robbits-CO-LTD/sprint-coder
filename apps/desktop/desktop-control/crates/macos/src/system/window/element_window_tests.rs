// Changed by Sprint Coder (new file); see VENDORED.md in apps/desktop/desktop-control.
use super::names_attached;

const APP: i32 = 400;

#[test]
fn a_sheet_or_popover_of_the_same_process_and_layer_is_named() {
    assert!(names_attached(10, 11, Some((APP, 0)), Some((APP, 0))));
}

#[test]
fn the_captured_window_itself_or_no_window_is_not_named() {
    assert!(!names_attached(10, 10, Some((APP, 0)), Some((APP, 0))));
    assert!(!names_attached(10, 0, Some((APP, 0)), Some((APP, 0))));
}

#[test]
fn a_window_at_another_layer_keeps_the_captured_window() {
    // A menu or pop-up list: naming it would draw the cursor at its level,
    // above the user's ordinary windows.
    assert!(!names_attached(10, 11, Some((APP, 0)), Some((APP, 101))));
}

#[test]
fn a_window_of_another_process_keeps_the_captured_window() {
    assert!(!names_attached(10, 11, Some((APP, 0)), Some((APP + 1, 0))));
}

#[test]
fn an_unread_window_keeps_the_captured_window() {
    assert!(!names_attached(10, 11, None, Some((APP, 0))));
    assert!(!names_attached(10, 11, Some((APP, 0)), None));
    assert!(!names_attached(10, 11, None, None));
}
