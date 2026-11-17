// Changed by Sprint Coder (new file); see VENDORED.md in apps/desktop/desktop-control.
//! A note a command leaves for the envelope of its successful result, for a
//! result whose `data` has a fixed shape with no room for it. The CLI takes it
//! when it writes the response, and `batch` when it builds each entry; a
//! command that runs sets or clears it first, so a note never outlives the
//! command that left it.

use std::sync::{Mutex, PoisonError};

// Process-wide rather than per thread, so a command that runs on another
// thread than the one writing the response still leaves its note.
static NOTE: Mutex<Option<String>> = Mutex::new(None);

/// Replaces the pending note (`None` clears it).
pub(crate) fn set(note: Option<String>) {
    set_in(&NOTE, note);
}

/// Takes the pending note, leaving none.
pub fn take() -> Option<String> {
    take_from(&NOTE)
}

fn set_in(slot: &Mutex<Option<String>>, note: Option<String>) {
    *slot.lock().unwrap_or_else(PoisonError::into_inner) = note;
}

fn take_from(slot: &Mutex<Option<String>>) -> Option<String> {
    slot.lock().unwrap_or_else(PoisonError::into_inner).take()
}

#[cfg(test)]
mod tests {
    use super::{set_in, take_from};
    use std::sync::Mutex;

    // On a slot the test owns, so no other test that runs a command can touch it.
    #[test]
    fn a_note_is_taken_once_and_a_set_of_none_clears_it() {
        let slot = Mutex::new(None);
        set_in(&slot, Some("note".into()));
        assert_eq!(take_from(&slot).as_deref(), Some("note"));
        assert_eq!(take_from(&slot), None);
        set_in(&slot, Some("stale".into()));
        set_in(&slot, None);
        assert_eq!(take_from(&slot), None);
    }
}
