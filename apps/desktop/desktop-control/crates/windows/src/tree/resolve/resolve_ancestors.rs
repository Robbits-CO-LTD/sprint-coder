// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! The identity evidence of a landed element's nearest ancestors, read upward
//! from that element, for a saved ref proven together with its ancestors
//! (core's `refs::ref_ancestry`). Each step is one parent read and one read of
//! the identity properties, at most as many steps as the entry recorded
//! ancestors, and the deadline is checked before each.

use agent_desktop_core::{AdapterError, Deadline, LocatorEvidence, NativeHandle, RefEntry};

#[cfg(target_os = "windows")]
pub(crate) fn read_ancestor_evidence(
    entry: &RefEntry,
    handle: &NativeHandle,
    count: usize,
    deadline: Deadline,
) -> Result<Vec<LocatorEvidence>, AdapterError> {
    use crate::tree::automation::{automation_client, uia_error};
    use crate::tree::name_evidence::read_label;
    use crate::tree::properties::property_ids::TreeProperty;
    use crate::tree::properties::read_live_set;
    use crate::tree::walk::walker::walk_vocabulary;
    use crate::tree::walk::walker_source::{parent_step, same_element};
    use agent_desktop_core::refs::resolve_errors::identity_unknown_error;

    let element = crate::tree::element::uia_element(handle)?;
    let root = crate::tree::resolve::resolve_window_root(entry, deadline)?;
    let client = automation_client()?;
    let walker = client
        .get_raw_view_walker()
        .map_err(|error| uia_error(&error, "open the raw view tree walker"))?;
    let mut ancestors = Vec::with_capacity(count);
    let mut current = element.clone();
    while ancestors.len() < count {
        deadline.ensure_remaining()?;
        let parent = match parent_step(&walker, &current) {
            Ok(Some(parent)) => parent,
            Ok(None) => break,
            Err(()) => return Err(identity_unknown_error(entry)),
        };
        // The observation the ancestors were recorded from stops below its
        // root, so reaching the root ends the chain.
        if same_element(&client, &parent, &root) {
            break;
        }
        let (properties, _) = read_live_set(&parent, &TreeProperty::IDENTITY_SET);
        let label = read_label(&parent, false);
        let vocabulary = walk_vocabulary(&properties, &label);
        ancestors.push(properties.locator_evidence(vocabulary));
        current = parent;
    }
    Ok(ancestors)
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn read_ancestor_evidence(
    _entry: &RefEntry,
    _handle: &NativeHandle,
    _count: usize,
    _deadline: Deadline,
) -> Result<Vec<LocatorEvidence>, AdapterError> {
    Err(AdapterError::not_supported("read_ancestor_evidence"))
}
