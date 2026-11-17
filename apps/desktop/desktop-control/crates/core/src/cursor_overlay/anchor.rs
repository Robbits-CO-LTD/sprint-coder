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

use crate::{CommandContext, NativeHandle, PlatformAdapter};

/// How long the read of an element's own window may take. It runs once per
/// action, only while the overlay is on.
const ELEMENT_WINDOW_READ_MS: u64 = 150;

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

/// The window to name for an action on `handle`: the separate window the
/// element itself lives in (a sheet or popover of `top_level`) when the
/// adapter reports one, otherwise `top_level`. The read is capped at
/// `ELEMENT_WINDOW_READ_MS` and at what `within` (the action's own deadline)
/// has left, and is skipped when nothing is left or when no cursor would be
/// drawn (the overlay is off, or there is no session to draw it in).
pub(crate) fn element_window(
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
    top_level: Option<String>,
    handle: &NativeHandle,
    within: crate::Deadline,
) -> Option<String> {
    if !context.cursor_overlay().is_enabled() || context.session_id().is_none() {
        return top_level;
    }
    choose_window(top_level, |top_level| {
        let deadline = read_deadline(within)?;
        adapter.element_cursor_window(handle, top_level, deadline)
    })
}

/// The deadline of the element's window read: `ELEMENT_WINDOW_READ_MS` at
/// most, never past `within`, and none when `within` has nothing left.
pub(crate) fn read_deadline(within: crate::Deadline) -> Option<crate::Deadline> {
    if within.is_expired() {
        return None;
    }
    let capped = within.capped(std::time::Duration::from_millis(ELEMENT_WINDOW_READ_MS));
    (!capped.is_expired()).then_some(capped)
}

/// The choice behind [`element_window`]. A ref that names no window keeps
/// none (nothing is read for it); one that names a window keeps a window
/// whatever the element's read says, so the cursor never falls back to above
/// every window. An empty answer, or the top-level window itself, keeps the
/// top-level window.
pub(crate) fn choose_window(
    top_level: Option<String>,
    element: impl FnOnce(&str) -> Option<String>,
) -> Option<String> {
    let top_level = top_level?;
    match element(&top_level) {
        Some(own) if !own.is_empty() && own != top_level => Some(own),
        _ => Some(top_level),
    }
}

#[cfg(test)]
#[path = "anchor_tests.rs"]
mod tests;
