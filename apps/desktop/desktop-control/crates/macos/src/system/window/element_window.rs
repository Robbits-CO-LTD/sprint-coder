// Changed by Sprint Coder (new file); see VENDORED.md in apps/desktop/desktop-control.
//! The window an element itself lives in, for the agent's cursor.
//!
//! A sheet or a popover is a separate CoreGraphics window in front of the
//! window it belongs to, while the accessibility tree has it under that
//! window (a sheet as its child, a popover under the control it is anchored
//! to). A ref captured from the window therefore names the window, and a
//! cursor drawn directly above it is hidden under the sheet or popover. The
//! accessibility-to-window bridge answers the element's own window, which is
//! named instead when it is attached to the captured one: the same process
//! and the same layer. A window at another layer (a menu, a pop-up list) is
//! not named, so the cursor never takes a level above the user's windows.

use std::time::Instant;

use crate::tree::AXElement;

/// The window to name for the cursor in place of `top_level` (`w-<number>`)
/// for an action on `element`, or `None` to keep `top_level`.
pub(crate) fn attached_window(
    element: &AXElement,
    top_level: &str,
    deadline: Instant,
) -> Option<String> {
    let top_level = crate::system::launch_front::window_number(top_level)?;
    let own = super::window_bridge::window_id(element, deadline)
        .ok()
        .flatten()?;
    if own == top_level {
        return None;
    }
    let read = |number| {
        super::cg_window_exact::exact_window_owner_layer_until(number, deadline)
            .ok()
            .flatten()
    };
    names_attached(top_level, own, read(top_level), read(own)).then(|| format!("w-{own}"))
}

/// Whether window `own` (the element's) is named in place of `top_level`
/// (the captured window), from each one's owner pid and layer as CoreGraphics
/// reads them: a different, real window of the same process at the same
/// layer. Any part that could not be read keeps the captured window.
pub(super) fn names_attached(
    top_level: i64,
    own: i64,
    top_level_owner_layer: Option<(i32, i64)>,
    own_owner_layer: Option<(i32, i64)>,
) -> bool {
    own > 0
        && own != top_level
        && top_level_owner_layer.is_some_and(|top_level| Some(top_level) == own_owner_layer)
}

#[cfg(test)]
#[path = "element_window_tests.rs"]
mod tests;
