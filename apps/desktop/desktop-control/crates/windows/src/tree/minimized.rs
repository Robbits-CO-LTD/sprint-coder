// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics, ErrorCode, NativeHandle};

use super::hit_test::corroborate::root_of_hwnd;
use crate::tree::automation::automation_client;
use crate::tree::element::UIAElement;
use crate::tree::properties::element_properties::ElementProperties;
use crate::tree::properties::property_ids::TreeProperty;
use crate::tree::properties::property_outcome::{PropertyOutcome, PropertyValue};

/// Whether the element's owning top-level window is minimized right now.
///
/// `None` answers nothing: the budget expired, the client or walker would
/// not build, or the climb never reached a window. Callers treat `None` as
/// unknown and change nothing, because a failed window question must never
/// invent an offscreen state.
pub(crate) fn owning_window_minimized(element: &UIAElement, deadline: Deadline) -> Option<bool> {
    owning_window(element, deadline).map(|root| unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::IsIconic(root as *mut std::ffi::c_void) != 0
    })
}

/// The shown top-level window that owns the element, by UI Automation
/// ancestry rather than by the first native handle's `GA_ROOT` alone.
///
/// Chromium (Electron, Chrome) moves the window it draws web content in,
/// `Chrome_RenderWidgetHostHWND`, under its own hidden top-level window
/// (`Chrome_WidgetWin_0`) while the page is hidden, which is the case
/// whenever its window is minimized. Its UI Automation tree still places that
/// content under the minimized window, but the first native handle's root is
/// then the hidden window, which is never minimized, so a minimized Electron
/// window read as shown and ref actions went through to a page that runs no
/// animation frames until it is restored. A root that is not shown cannot be
/// the window the user sees, so the climb skips it and keeps going.
fn owning_window(element: &UIAElement, deadline: Deadline) -> Option<isize> {
    use crate::tree::walk::walker_source::parent_step;
    use windows::Win32::Foundation::HWND;

    deadline.ensure_remaining().ok()?;
    let client = automation_client().ok()?;
    let walker = client.get_raw_view_walker().ok()?;
    owning_shown_root(
        element.clone(),
        &OwnerClimb {
            native_hwnd: &|node: &UIAElement| {
                let handle = node.0.get_native_window_handle().map_err(|_| ())?;
                let hwnd: HWND = handle.into();
                Ok(hwnd.0 as isize)
            },
            parent_of: &|node: &UIAElement| parent_step(&walker, node),
            shown_root: &shown_root_of_hwnd,
            deadline,
        },
    )
}

fn shown_root_of_hwnd(hwnd: isize) -> Option<isize> {
    use windows_sys::Win32::UI::WindowsAndMessaging::IsWindowVisible;
    root_of_hwnd(hwnd)
        .filter(|root| unsafe { IsWindowVisible(*root as *mut std::ffi::c_void) } != 0)
}

/// The climb's cross-process reads, injected so the ancestry rule can be
/// tested without a live provider. `native_hwnd` answers `Err` when the read
/// failed, and `Ok(0)` when the element owns no window.
pub(crate) struct OwnerClimb<'a, N> {
    pub(crate) native_hwnd: &'a dyn Fn(&N) -> Result<isize, ()>,
    pub(crate) parent_of: &'a dyn Fn(&N) -> Result<Option<N>, ()>,
    pub(crate) shown_root: &'a dyn Fn(isize) -> Option<isize>,
    pub(crate) deadline: Deadline,
}

/// Climbs from `start` to the first native window whose root is shown, and
/// answers that root. Any failed read, an expired budget or a climb that runs
/// out of ancestors answers `None`.
pub(crate) fn owning_shown_root<N>(start: N, climb: &OwnerClimb<'_, N>) -> Option<isize> {
    let mut current = start;
    for _ in 0..crate::tree::walk::walker::DEFAULT_MAX_RAW_DEPTH {
        if climb.deadline.is_expired() {
            return None;
        }
        let hwnd = (climb.native_hwnd)(&current).ok()?;
        if hwnd != 0
            && let Some(root) = (climb.shown_root)(hwnd)
        {
            return Some(root);
        }
        current = (climb.parent_of)(&current).ok()??;
    }
    None
}

/// Refuses a ref action whose target sits in a minimized window, before
/// anything is sent. `None` when the window is not proven minimized.
///
/// Measured on 2026-11-12: a minimized Electron page still runs an Invoke's
/// click handler at once, but work it defers to an animation frame waits
/// until the window is restored, and its accessibility tree stops updating,
/// so the app shows nothing and the result cannot be read back. A classic
/// Win32, WPF or WebView2 window was already refused through the offscreen
/// state. Waiting does not help, so the refusal is not retryable, and it is
/// raised before the scroll-into-view recovery so no scroll is sent either.
pub(crate) fn minimized_window_refusal(
    handle: &NativeHandle,
    deadline: Deadline,
) -> Option<AdapterError> {
    let element = crate::tree::element::uia_element(handle).ok()?;
    let root = owning_window(element, deadline)?;
    let minimized = unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::IsIconic(root as *mut std::ffi::c_void) != 0
    };
    minimized.then(|| minimized_window_error(root))
}

pub(crate) fn minimized_window_error(root: isize) -> AdapterError {
    let window_id = format!("w-{root}");
    AdapterError::new(
        ErrorCode::ActionFailed,
        "The target's window is minimized, so the action was not sent",
    )
    .with_details(serde_json::json!({
        "kind": "window_minimized",
        "window_id": window_id,
        "retryable": false,
    }))
    .with_suggestion(format!(
        "Nothing reached the app. A minimized window cannot be operated: restore it first \
         (restore --window-id {window_id}), take a fresh snapshot, then act on the new refs. \
         Repeating this action while the window stays minimized is refused the same way."
    ))
    .with_disposition(DeliverySemantics::not_delivered())
}

/// WinForms reports unclipped descendants as on-screen; intersect their scroll viewports.
pub(crate) fn outside_scroll_viewports(
    element: &UIAElement,
    deadline: Deadline,
) -> Result<bool, agent_desktop_core::AdapterError> {
    use crate::tree::automation::uia_error;
    use crate::tree::properties::read_one;
    use crate::tree::walk::walker_source::{parent_step, viewport_bounds};
    let Some(mut visible) = read_one(element, TreeProperty::BoundingRectangle)
        .bounds()
        .known()
        .copied()
    else {
        return Ok(false);
    };
    let client = automation_client()?;
    let walker = client
        .get_raw_view_walker()
        .map_err(|error| uia_error(&error, "read scroll ancestors"))?;
    let mut current = element.clone();
    for _ in 0..crate::tree::walk::walker::DEFAULT_MAX_RAW_DEPTH {
        deadline.ensure_remaining()?;
        current = match parent_step(&walker, &current) {
            Ok(Some(parent)) => parent,
            Ok(None) => return Ok(false),
            Err(()) => {
                return Err(agent_desktop_core::AdapterError::new(
                    agent_desktop_core::ErrorCode::AppUnresponsive,
                    "Could not inspect scroll clipping",
                ));
            }
        };
        if read_one(&current, TreeProperty::ScrollAvailable).flag() != Some(true) {
            continue;
        }
        if let Some(viewport) = viewport_bounds(&current)? {
            match crate::tree::hit_test::intersect_rects(visible, viewport) {
                Some(intersection) => visible = intersection,
                None => return Ok(true),
            }
        }
    }
    Err(agent_desktop_core::AdapterError::new(
        agent_desktop_core::ErrorCode::AppUnresponsive,
        "Scroll ancestor traversal exceeded its limit",
    ))
}

/// Reports a minimized owner's whole subtree offscreen in the read set.
///
/// A minimized top-level window keeps reporting usable rectangles and a
/// clear `IsOffscreen` on its descendants (A14-8 measured the descendants
/// false throughout on the COM stack), so the visibility gate and `is
/// visible` both read the element as shown. Overwriting the one flag carries
/// the window truth into every projection the shared read serves, without
/// touching what the walk or the resolver collect on their own paths.
pub(crate) fn stamp_minimized_offscreen(properties: &mut ElementProperties) {
    properties.set(
        TreeProperty::IsOffscreen,
        PropertyOutcome::Known(PropertyValue::Flag(true)),
    );
}

#[cfg(test)]
#[path = "minimized_tests.rs"]
mod tests;
