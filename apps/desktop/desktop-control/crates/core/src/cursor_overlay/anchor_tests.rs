use super::{anchor_window, current_window};

#[test]
fn a_scope_names_its_window_and_puts_back_the_one_before_it() {
    assert_eq!(current_window(), None);
    {
        let _outer = anchor_window(Some("w-100".into()));
        assert_eq!(current_window().as_deref(), Some("w-100"));
        {
            let _inner = anchor_window(Some("w-200".into()));
            assert_eq!(current_window().as_deref(), Some("w-200"));
        }
        assert_eq!(current_window().as_deref(), Some("w-100"));
        {
            let _none = anchor_window(None);
            assert_eq!(current_window(), None);
        }
        assert_eq!(current_window().as_deref(), Some("w-100"));
    }
    assert_eq!(
        current_window(),
        None,
        "an action that ended leaves no window for the next one"
    );
}
