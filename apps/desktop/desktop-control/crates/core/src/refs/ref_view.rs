// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! Refs proven among the elements a window shows.
//!
//! A window holding thousands of elements (a long list a web page keeps whole)
//! cannot be read in full within a command's deadline, so the whole-window rule
//! can prove none of its refs. Such a capture reads only the elements the window
//! reports on screen and proves an entry there: its predicate (and, where needed,
//! its nearest ancestors) must match exactly one element of that view. What the
//! view leaves out can still hold an element that reads the same, so the proof
//! is tied to the view it was measured in: resolution reads the same view again,
//! requires exactly one match there, and requires that match to sit at the
//! recorded path of the view, to carry the recorded runtime identifier and to
//! cover exactly the recorded screen rectangle.
//! A scroll, a reflow, a moved window or a different element in the slot stops
//! the ref; the caller takes a new snapshot. Such an entry is never resolved by
//! the whole-window rule, which would drop the path and the bounds.

use serde_json::json;

use crate::{AdapterError, Rect, RefEntry, locator::live_locator::LocatorEvidence};

/// The screen rectangle a view proof records for an element: its known bounds,
/// and only when they cover an area (an element with no area is not one the
/// view shows).
pub(crate) fn view_bounds(evidence: &LocatorEvidence) -> Option<Rect> {
    evidence
        .ref_evidence
        .bounds
        .known()
        .copied()
        .filter(|bounds| bounds.validate().is_ok() && bounds.width > 0.0 && bounds.height > 0.0)
}

/// The runtime identifier a view proof records: present and of a sane size.
pub(crate) fn view_runtime_id(evidence: &LocatorEvidence) -> Option<Vec<i32>> {
    evidence
        .ref_evidence
        .runtime_id
        .clone()
        .filter(|id| !id.is_empty() && id.len() <= 32)
}

/// Holds the element a view-proven entry matched in a fresh read of the view to
/// the place the entry was recorded at: the same path in the view, the same
/// bounds. An unreadable rectangle is unknown, not a change.
pub(crate) fn confirm_matched(
    entry: &RefEntry,
    path: &[usize],
    evidence: &LocatorEvidence,
) -> Result<(), AdapterError> {
    let Some(view) = &entry.identity.in_view else {
        return Ok(());
    };
    if view.path.as_slice() != path {
        return Err(view_changed(entry));
    }
    match &evidence.ref_evidence.runtime_id {
        Some(live) if *live == view.runtime_id => {}
        Some(_) => return Err(view_changed(entry)),
        None => return Err(crate::refs::resolve_errors::identity_unknown_error(entry)),
    }
    confirm_bounds(
        entry,
        view.bounds,
        evidence.ref_evidence.bounds.known().copied(),
    )
}

/// Holds a live element about to be acted on to the bounds a view-proven entry
/// recorded; an entry without a view proof passes.
pub(crate) fn confirm_live_bounds(
    entry: &RefEntry,
    live: Option<Rect>,
) -> Result<(), AdapterError> {
    match &entry.identity.in_view {
        Some(view) => confirm_bounds(entry, view.bounds, live),
        None => Ok(()),
    }
}

/// Exact equality: no tolerance, so a shift of a single pixel stops the ref.
fn confirm_bounds(
    entry: &RefEntry,
    recorded: Rect,
    live: Option<Rect>,
) -> Result<(), AdapterError> {
    match live {
        Some(live) if live == recorded => Ok(()),
        Some(_) => Err(view_changed(entry)),
        None => Err(crate::refs::resolve_errors::identity_unknown_error(entry)),
    }
}

pub(crate) fn view_changed(entry: &RefEntry) -> AdapterError {
    AdapterError::stale_ref_because(
        "The ref was proven among the elements the window showed, and the window no longer shows \
         that element at the same place (it scrolled, moved or changed)",
    )
    .with_suggestion(
        "Run 'snapshot' again to read what the window shows now, then use the new ref. Refs from \
         a snapshot with scope \"visible\" stop working once the view scrolls or changes.",
    )
    .with_details(json!({
        "kind": "saved_ref_view_changed",
        "retryable": false,
        "complete": true,
        "role": entry.identity.role,
    }))
}

/// A view-proven entry reached a path that cannot read the view it was proven
/// in, so it is refused instead of judged by another rule.
pub(crate) fn view_unavailable(entry: &RefEntry) -> AdapterError {
    crate::refs::resolve_errors::identity_not_unique(entry)
}

/// A find rooted at a view-proven entry would search the visible elements only
/// and report its counts as if they covered the whole subtree, so it is refused.
pub(crate) fn rooted_find_unsupported(entry: &RefEntry) -> AdapterError {
    AdapterError::new(
        crate::ErrorCode::ActionNotSupported,
        "find --root does not accept a ref from a snapshot with scope \"visible\": only the elements on screen can be read under it, so matches scrolled out of view would be missed",
    )
    .with_suggestion(
        "Run 'snapshot --root' with this ref to read what is on screen under it, or scroll and run 'snapshot' again.",
    )
    .with_details(json!({
        "kind": "rooted_find_in_view_unsupported",
        "retryable": false,
        "role": entry.identity.role,
    }))
}

#[cfg(test)]
#[path = "ref_view_tests.rs"]
mod tests;
