// Changed by Sprint Coder (new file); see VENDORED.md in apps/desktop/desktop-control.
//! The global inventory lists layer-0 windows only. A system dialog (for example
//! a screen-recording prompt from UserNotificationCenter) is the frontmost app's
//! focused window at a higher layer, so no retry can ever join it to a record.

use crate::system::window::window_ax_state::WindowAxState;
use agent_desktop_core::AdapterError;

/// Reads the frontmost app's focus, then drops a focused window that
/// CoreGraphics confirms exists, belongs to that same app, and sits outside
/// layer 0. Every other case keeps the focus as read, so a missing number, a
/// window CoreGraphics does not know, a layer-0 window, another owner, or a
/// failed lookup still reaches the join check and its retry.
pub(super) fn read_frontmost_in_inventory(
    pid: i32,
    read_frontmost: impl FnOnce(i32) -> Result<WindowAxState, AdapterError>,
    owner_layer: impl FnOnce(i64) -> Result<Option<(i32, i64)>, AdapterError>,
) -> Result<WindowAxState, AdapterError> {
    let mut state = read_frontmost(pid)?;
    let Some(number) = state.focused.as_ref().and_then(|(_, number)| *number) else {
        return Ok(state);
    };
    if matches!(owner_layer(number), Ok(Some((owner, layer))) if owner == pid && layer != 0) {
        tracing::debug!(
            pid,
            number,
            "frontmost focus is outside the layer-0 inventory"
        );
        state.focused = None;
    }
    Ok(state)
}
