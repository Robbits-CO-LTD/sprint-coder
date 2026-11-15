// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! Drag delivery/release-guard state.
//!
//! A `MouseInputEvent` batch is plain data - unlike macOS's `CGEvent`-backed
//! guard, constructing the corrective batch here cannot fail. The guard
//! arms immediately before the first committed injection (mouse-down) and
//! disarms only after the final release posts.
//! Cleanup is best-effort like every other post here: `SendInput`'s return
//! value is never treated as delivery evidence (A9-3), so an abort reports
//! `emergency_release_posted` without claiming the OS acknowledged it.
//!
//! Desktop control (Sprint Coder) change: letting the button go is itself a
//! drop, so the release never moves back to the origin blindly. An earlier
//! move can have brought a Sprint Coder window to the origin, and a drop
//! there is exactly what the refusal stopped. The point to let go at is
//! chosen from the facts at that moment (`own_window::drag_release_plan`):
//! the origin when it is not Sprint Coder's, otherwise a screen edge that is
//! not, otherwise in place rather than held.

use agent_desktop_core::{AdapterError, Point};

use crate::input::mouse::mouse_coord::{self, NormalizedPoint};
use crate::input::mouse::mouse_send::{
    MOUSEEVENTF_LEFTUP, button_input, move_input, post_mouse_inputs,
};
use crate::input::release_state::ReleaseState;

const SUGGESTION: &str = "Inspect the source and destination before retrying; the emergency release was posted without an OS acknowledgement";

/// Where an aborted or refused drag let its button go.
pub(crate) struct Released {
    /// `origin`, `safe_point` or `in_place_unverified`.
    pub(crate) label: &'static str,
    /// Whether the point it let go at is verified not to be a Sprint Coder window.
    pub(crate) sprint_coder_avoided: bool,
}

pub(crate) struct DragReleaseGuard {
    origin: NormalizedPoint,
    origin_point: Option<Point>,
    state: ReleaseState,
}

impl DragReleaseGuard {
    pub(crate) fn new(origin: NormalizedPoint) -> Self {
        Self {
            origin,
            origin_point: None,
            state: ReleaseState::default(),
        }
    }

    /// The original (pixel) origin, so the release can re-read who owns it now. Without it the
    /// guard falls back to letting go at the normalized origin, as before.
    pub(crate) fn with_origin_point(mut self, point: Point) -> Self {
        self.origin_point = Some(point);
        self
    }

    pub(crate) fn arm(&mut self) {
        self.state.arm();
    }

    pub(crate) fn disarm(&mut self) {
        self.state.disarm();
    }

    pub(crate) fn mark_delivered(&mut self) {
        self.state.mark_delivered();
    }

    pub(crate) fn should_release(&self) -> bool {
        self.state.should_release()
    }

    pub(crate) fn enrich_error(&self, error: AdapterError) -> AdapterError {
        self.state.enrich_error(error, SUGGESTION)
    }

    /// Lets the button go at a point chosen from the facts now, and disarms so `Drop` does not
    /// let it go a second time. The origin, a safe screen edge, or - when none is verified safe -
    /// in place (the button is never left held).
    pub(crate) fn release_now(&mut self) -> Released {
        let released = match self.origin_point.as_ref() {
            Some(origin) => {
                let plan = crate::system::own_window::drag_release_plan(origin);
                match plan.target {
                    Some(point) => post_mouse_inputs(&[
                        move_input(mouse_coord::normalize_point(&point)),
                        button_input(MOUSEEVENTF_LEFTUP),
                    ]),
                    None => post_mouse_inputs(&[button_input(MOUSEEVENTF_LEFTUP)]),
                }
                Released {
                    label: plan.label,
                    sprint_coder_avoided: plan.sprint_coder_avoided,
                }
            }
            None => {
                post_mouse_inputs(&[move_input(self.origin), button_input(MOUSEEVENTF_LEFTUP)]);
                Released {
                    label: "origin",
                    sprint_coder_avoided: true,
                }
            }
        };
        self.state.disarm();
        released
    }
}

impl Drop for DragReleaseGuard {
    fn drop(&mut self) {
        if !self.should_release() {
            return;
        }
        self.release_now();
    }
}

#[cfg(all(test, target_os = "windows"))]
#[path = "drag_state_tests.rs"]
mod tests;
