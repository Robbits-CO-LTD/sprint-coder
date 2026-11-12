// Added by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::{CursorOverlayStyle, MAX_CURSOR_LINGER_MS, MIN_CURSOR_LINGER_MS};
use crate::CURSOR_IDLE_REST_MS;

#[test]
fn a_style_that_never_set_a_linger_rests_as_before_and_says_nothing_of_it() {
    let style = CursorOverlayStyle::default();
    assert_eq!(style.linger_ms(), None);
    assert_eq!(style.rest_after_ms(), CURSOR_IDLE_REST_MS);
    let json = serde_json::to_string(&style).unwrap();
    assert!(!json.contains("linger"), "{json}");
}

#[test]
fn a_linger_is_kept_on_the_wire_and_read_back() {
    let mut style = CursorOverlayStyle::default();
    style.set_linger_ms(Some(30_000));
    let style = style.validated().unwrap();
    assert_eq!(style.rest_after_ms(), 30_000);
    let json = serde_json::to_string(&style).unwrap();
    let read: CursorOverlayStyle = serde_json::from_str(&json).unwrap();
    assert_eq!(read.linger_ms(), Some(30_000));
}

#[test]
fn a_style_written_before_the_linger_existed_still_reads() {
    let read: CursorOverlayStyle = serde_json::from_str(r##"{"accent":"#16A34A"}"##).unwrap();
    assert_eq!(read.linger_ms(), None);
    assert_eq!(read.rest_after_ms(), CURSOR_IDLE_REST_MS);
}

#[test]
fn a_linger_outside_its_bounds_is_refused() {
    for linger in [0, MIN_CURSOR_LINGER_MS - 1, MAX_CURSOR_LINGER_MS + 1] {
        let mut style = CursorOverlayStyle::default();
        style.set_linger_ms(Some(linger));
        assert!(style.validated().is_err(), "{linger}");
    }
    for linger in [MIN_CURSOR_LINGER_MS, MAX_CURSOR_LINGER_MS] {
        let mut style = CursorOverlayStyle::default();
        style.set_linger_ms(Some(linger));
        assert!(style.validated().is_ok(), "{linger}");
    }
}
