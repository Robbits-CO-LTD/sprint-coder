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

#[test]
fn an_element_in_its_own_attached_window_names_that_window() {
    let chosen = super::choose_window(Some("w-100".into()), |top_level| {
        assert_eq!(top_level, "w-100");
        Some("w-101".into())
    });
    assert_eq!(chosen.as_deref(), Some("w-101"));
}

#[test]
fn an_unread_or_same_element_window_keeps_the_top_level_window() {
    for answer in [None, Some(String::new()), Some("w-100".to_owned())] {
        let chosen = super::choose_window(Some("w-100".into()), |_| answer.clone());
        assert_eq!(
            chosen.as_deref(),
            Some("w-100"),
            "a named window is never dropped to none (above every window): {answer:?}"
        );
    }
}

#[test]
fn a_ref_without_a_window_reads_nothing_and_names_none() {
    let chosen = super::choose_window(None, |_| panic!("no read without a top-level window"));
    assert_eq!(chosen, None);
}

#[test]
fn the_element_window_read_is_capped_by_the_actions_own_deadline() {
    let long = crate::Deadline::after(10_000).unwrap();
    let read = super::read_deadline(long).expect("time is left");
    assert!(read.remaining() <= std::time::Duration::from_millis(super::ELEMENT_WINDOW_READ_MS));

    let short = crate::Deadline::after(20).unwrap();
    let read = super::read_deadline(short).expect("time is left");
    assert!(
        read.remaining() <= short.remaining() + std::time::Duration::from_millis(1),
        "never past the action's deadline"
    );

    let spent = crate::Deadline::detached_after(1).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(3));
    assert!(
        super::read_deadline(spent).is_none(),
        "nothing left, nothing read"
    );
}
