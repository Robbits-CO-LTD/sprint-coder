// Changed by Sprint Coder (new file); see VENDORED.md in apps/desktop/desktop-control.
//! A note a command leaves for the envelope of its successful result, for a
//! result whose `data` has a fixed shape with no room for it. The CLI takes it
//! when it writes the response; a command that runs sets or clears it first,
//! so a note never outlives the command that left it.

use std::cell::RefCell;

thread_local! {
    static NOTE: RefCell<Option<String>> = const { RefCell::new(None) };
}

/// Replaces the pending note (`None` clears it).
pub(crate) fn set(note: Option<String>) {
    NOTE.with(|pending| *pending.borrow_mut() = note);
}

/// Takes the pending note, leaving none.
pub fn take() -> Option<String> {
    NOTE.with(|pending| pending.borrow_mut().take())
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_note_is_taken_once_and_a_set_of_none_clears_it() {
        super::set(Some("note".into()));
        assert_eq!(super::take().as_deref(), Some("note"));
        assert_eq!(super::take(), None);
        super::set(Some("stale".into()));
        super::set(None);
        assert_eq!(super::take(), None);
    }
}
