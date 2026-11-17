// Changed by Sprint Coder (new file); see VENDORED.md in apps/desktop/desktop-control.
use super::names_attached;

const APP: i32 = 400;

/// Only the pid and layer are compared: a sheet, a popover and another
/// ordinary window of the same app all pass. The element's own window is
/// named whichever it is, which is safe because the cursor goes directly above
/// it and never past a window in front of it.
#[test]
fn another_window_of_the_same_process_and_layer_is_named() {
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
