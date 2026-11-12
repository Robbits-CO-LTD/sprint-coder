// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! The identity evidence of a landed element's nearest ancestors, read upward
//! from that element, for a saved ref proven together with its ancestors
//! (core's `refs::ref_ancestry`).
//!
//! Each level is one call: the parent is fetched together with the identity
//! properties (`GetParentElementBuildCache` with the identity set), and that
//! call - with the label reads that follow it - runs with the client's
//! transaction timeout lowered to what remains of the deadline, so a target
//! that stops answering cannot hold the read past the command's deadline. At
//! most as many levels are read as the entry recorded ancestors. An entry
//! proven among the visible elements (`proven_in_view`) is read in that view,
//! the one its ancestors were recorded in.

use agent_desktop_core::{AdapterError, Deadline, LocatorEvidence, NativeHandle, RefEntry};

#[cfg(target_os = "windows")]
pub(crate) fn read_ancestor_evidence(
    entry: &RefEntry,
    handle: &NativeHandle,
    count: usize,
    deadline: Deadline,
) -> Result<Vec<LocatorEvidence>, AdapterError> {
    use crate::tree::automation::{automation_client, failure_of, uia_error};
    use crate::tree::element::UIAElement;
    use crate::tree::name_evidence::read_label;
    use crate::tree::properties::property_ids::TreeProperty;
    use crate::tree::properties::read_cached_set;
    use crate::tree::walk::cache::build_set_cache_request;
    use crate::tree::walk::walker::walk_vocabulary;
    use crate::tree::walk::walker_source::{same_element, with_transaction_timeout};
    use agent_desktop_core::refs::resolve_errors::identity_unknown_error;

    /// What one level's read found.
    enum Step {
        Ancestor(UIAElement, LocatorEvidence),
        /// The root of the observation, or no parent at all: the chain ends.
        End,
        /// The parent could not be read.
        Failed,
    }

    let count = count.min(agent_desktop_core::refs::MAX_RECORDED_ANCESTORS);
    let element = crate::tree::element::uia_element(handle)?;
    let root = crate::tree::resolve::resolve_window_root(entry, deadline)?;
    let client = automation_client()?;
    // The ancestors are read in the view they were recorded in: a view proof
    // recorded them among the visible elements, where an offscreen container
    // between the element and its visible ancestors is not a level.
    let walker = if entry.identity.in_view.is_some() {
        crate::tree::walk::walker_source::visible_view_walker(&client)?
    } else {
        client
            .get_raw_view_walker()
            .map_err(|error| uia_error(&error, "open the raw view tree walker"))?
    };
    let request = build_set_cache_request(&client, &TreeProperty::IDENTITY_SET)?;
    let mut ancestors = Vec::with_capacity(count);
    let mut current = element.clone();
    while ancestors.len() < count {
        deadline.ensure_remaining()?;
        let step = with_transaction_timeout(&client, deadline, || {
            match walker.get_parent_build_cache(&current.0, &request) {
                Ok(parent) => {
                    let parent = UIAElement::from(parent);
                    // The observation the ancestors were recorded from stops
                    // below its root, so reaching the root ends the chain.
                    if same_element(&client, &parent, &root) {
                        return Step::End;
                    }
                    let (properties, _) = read_cached_set(&parent, &TreeProperty::IDENTITY_SET);
                    let label = read_label(&parent, true);
                    let vocabulary = walk_vocabulary(&properties, &label);
                    let evidence = properties.locator_evidence(vocabulary);
                    Step::Ancestor(parent, evidence)
                }
                Err(error) if failure_of(&error).is_exhaustion() => Step::End,
                Err(_) => Step::Failed,
            }
        });
        match step {
            None => return Err(deadline.timeout_error()),
            Some(Step::End) => break,
            Some(Step::Failed) => {
                deadline.ensure_remaining()?;
                return Err(identity_unknown_error(entry));
            }
            Some(Step::Ancestor(parent, evidence)) => {
                ancestors.push(evidence);
                current = parent;
            }
        }
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

#[cfg(all(test, target_os = "windows"))]
#[path = "resolve_ancestors_tests.rs"]
mod tests;
