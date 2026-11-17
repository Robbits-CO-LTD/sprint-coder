// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! The window the current action works in, for the cursor overlay.
//!
//! A renderer draws the agent's cursor at the height of the window being
//! worked in, so the cursor is hidden where that window is covered. The
//! submit helpers that build each instruction are reached from many places
//! and know only a point; the window is known where the ref was loaded. So
//! the action names its window once, for its whole span, and every
//! instruction sent inside that span carries it.
//!
//! Scoped rather than set: the guard puts back what was there before, so an
//! action that ends (or fails) never leaves its window on a later command's
//! cursor.

use std::cell::RefCell;

thread_local! {
    static ANCHOR: RefCell<Option<String>> = const { RefCell::new(None) };
}

/// Restores the window named before it when dropped.
pub(crate) struct AnchorScope {
    previous: Option<String>,
}

impl Drop for AnchorScope {
    fn drop(&mut self) {
        let previous = self.previous.take();
        ANCHOR.with(|anchor| *anchor.borrow_mut() = previous);
    }
}

/// Names `window` as the window the cursor is drawn with until the returned
/// guard is dropped. `None` names no window for that span.
pub(crate) fn anchor_window(window: Option<String>) -> AnchorScope {
    let previous = ANCHOR.with(|anchor| anchor.replace(window));
    AnchorScope { previous }
}

/// The window the current action works in, if it named one.
pub(crate) fn current_window() -> Option<String> {
    ANCHOR.with(|anchor| anchor.borrow().clone())
}

#[cfg(test)]
#[path = "anchor_tests.rs"]
mod tests;
