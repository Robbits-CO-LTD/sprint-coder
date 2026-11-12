// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! Telling apart elements whose own identity predicate is the same.
//!
//! A window often holds more than one element with the same role and name: a
//! dialog's "Close" next to the title bar's, the arrow buttons of two scroll
//! bars. The element's own predicate matches all of them, so a ref to one of
//! them used to be refused as not proven unique. What still tells them apart
//! is where they sit: the identity of the ancestors above them.
//!
//! The rule is the existing one, applied to a longer record. At capture, the
//! nearest ancestors are added one at a time until the element's predicate
//! together with those ancestors matches exactly one element of a complete
//! whole-window observation; only then is the entry proven, and the ancestors
//! are recorded. At resolution, exactly one live element must match the
//! predicate and the recorded ancestors; two or more is ambiguous, none is
//! stale, and an unreadable field is unknown, exactly as for the predicate
//! alone. Position among siblings is never used: twins under ancestors that
//! read the same stay refused, so an element that moved into another's place
//! cannot be taken for it.
//!
//! The observation's root (the window itself) is not part of the chain: the
//! window is already checked separately, and its title may change.

use crate::{
    IdentityMatch, RefAncestorIdentity, RefEntry,
    locator::live_locator::{LocatorEvidence, ObservedTree},
    refs::ref_full_predicate::{FullPredicate, conjunction},
    refs::ref_identity::stable_name,
    refs::ref_live_predicate::LivePredicate,
    tree::accname::non_blank,
};

/// How a tokenless entry was proven at capture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Proof {
    /// By its own predicate (`unique_at_capture`, no ancestors).
    Own,
    /// By its predicate together with its recorded ancestors (stored with
    /// `unique_at_capture` unset, so a reader that ignores the ancestors sees
    /// an unproven entry).
    WithAncestors,
    /// Not proven, or recorded inconsistently (`unique_at_capture` set and
    /// ancestors present): refused either way.
    None,
}

pub(crate) fn proof_of(entry: &RefEntry) -> Proof {
    match (
        entry.identity.unique_at_capture,
        entry.identity.ancestors.is_empty(),
    ) {
        (true, true) => Proof::Own,
        (false, false) => Proof::WithAncestors,
        _ => Proof::None,
    }
}

/// Holds the element a ref is about to act on to the ancestors its entry
/// recorded, read upward from that element itself.
///
/// Resolution picks the element from a whole-window observation, but the
/// handle comes from landing the recorded path afterwards, and the checks on
/// the landed element compare its own predicate only. A twin under different
/// ancestors that moved into the path in between matches that predicate, so
/// without this an entry proven by its ancestors could act on the twin. An
/// entry without recorded ancestors needs no such read and passes as before.
pub(crate) fn confirm_handle_ancestors(
    adapter: &dyn crate::PlatformAdapter,
    entry: &RefEntry,
    handle: &crate::NativeHandle,
    deadline: crate::Deadline,
) -> Result<(), crate::AdapterError> {
    let recorded = &entry.identity.ancestors;
    if recorded.is_empty() {
        return Ok(());
    }
    let live = match adapter.read_ancestor_evidence(entry, handle, recorded.len(), deadline) {
        Ok(live) => live,
        Err(error) if error.is_default_not_supported("read_ancestor_evidence") => {
            return Err(crate::refs::resolve_errors::identity_not_unique(entry));
        }
        Err(error) => return Err(error),
    };
    if live.len() < recorded.len() {
        return Err(ancestors_changed(entry));
    }
    let verdict = recorded
        .iter()
        .zip(&live)
        .map(|(ancestor, evidence)| {
            FullPredicate::of_ancestor(ancestor).compare(&LivePredicate::observed(evidence))
        })
        .fold(IdentityMatch::Match, conjunction);
    match verdict {
        IdentityMatch::Match => Ok(()),
        IdentityMatch::NoMatch => Err(ancestors_changed(entry)),
        IdentityMatch::Unknown => Err(crate::refs::resolve_errors::identity_unknown_error(entry)),
    }
}

fn ancestors_changed(entry: &RefEntry) -> crate::AdapterError {
    crate::AdapterError::stale_ref_because(
        "The element the ref landed on no longer sits under the ancestors it was recorded with",
    )
    .with_disposition(crate::DeliverySemantics::not_delivered())
    .with_details(serde_json::json!({
        "kind": "saved_ref_ancestors_changed",
        "retryable": false,
        "complete": true,
        "role": entry.identity.role,
    }))
}

/// Each node's parent in the observation, `None` for a root.
pub(crate) fn parents(observed: &ObservedTree) -> Vec<Option<usize>> {
    let mut parents = vec![None; observed.nodes.len()];
    for (index, node) in observed.nodes.iter().enumerate() {
        for child in &node.children {
            if let Some(slot) = parents.get_mut(*child as usize) {
                *slot = Some(index);
            }
        }
    }
    parents
}

/// The node's ancestors, nearest first, without the root.
fn chain(parents: &[Option<usize>], index: usize) -> Vec<usize> {
    let mut chain = Vec::new();
    let mut current = parents.get(index).copied().flatten();
    while let Some(ancestor) = current {
        let above = parents.get(ancestor).copied().flatten();
        if above.is_none() || chain.len() >= parents.len() {
            break;
        }
        chain.push(ancestor);
        current = above;
    }
    chain
}

/// Whether the node's ancestors match the recorded ones: a node with fewer
/// ancestors below the root than were recorded does not match.
pub(crate) fn ancestors_match(
    recorded: &[RefAncestorIdentity],
    observed: &ObservedTree,
    parents: &[Option<usize>],
    index: usize,
) -> IdentityMatch {
    let live = chain(parents, index);
    if live.len() < recorded.len() {
        return IdentityMatch::NoMatch;
    }
    recorded
        .iter()
        .zip(live)
        .map(|(ancestor, node)| match observed.nodes.get(node) {
            Some(node) => FullPredicate::of_ancestor(ancestor)
                .compare(&LivePredicate::observed(&node.evidence)),
            None => IdentityMatch::Unknown,
        })
        .fold(IdentityMatch::Match, conjunction)
}

/// The recorded identity of one ancestor, from the fields its evidence
/// answered. `None` when its role is unread, since every predicate needs one.
fn ancestor_identity(evidence: &LocatorEvidence) -> Option<RefAncestorIdentity> {
    let role = non_blank(evidence.role.known().map(String::as_str))?;
    Some(RefAncestorIdentity {
        role: role.to_string(),
        name: stable_name(
            role,
            evidence.name.known().map(String::as_str),
            evidence.value.known().map(String::as_str),
        )
        .map(str::to_string),
        description: non_blank(evidence.description.known().map(String::as_str))
            .map(str::to_string),
        native_id: evidence
            .identifiers
            .preferred_identifier()
            .filter(|identifier| !identifier.value.trim().is_empty())
            .cloned(),
    })
}

/// The shortest run of nearest ancestors that, with the entry's own
/// predicate, matches the node at `index` and no other node, or `None` when
/// no run does. Every other node the predicate matches must be told apart by
/// a definite mismatch; one whose ancestors cannot be read leaves the entry
/// unproven. A predicate that matches another node only as unknown also
/// leaves it unproven, as the plain proof does.
pub(crate) fn distinguishing_ancestors(
    observed: &ObservedTree,
    parents: &[Option<usize>],
    entry: &RefEntry,
    index: usize,
) -> Option<Vec<RefAncestorIdentity>> {
    let predicate = FullPredicate::of_entry(entry);
    let mut others = Vec::new();
    for (candidate, node) in observed.nodes.iter().enumerate() {
        match predicate.compare(&LivePredicate::observed(&node.evidence)) {
            IdentityMatch::Match if candidate == index => {}
            IdentityMatch::Match => others.push(candidate),
            IdentityMatch::NoMatch if candidate == index => return None,
            IdentityMatch::NoMatch => {}
            IdentityMatch::Unknown => return None,
        }
    }
    if others.is_empty() {
        return None;
    }
    let mut recorded = Vec::new();
    for ancestor in chain(parents, index) {
        recorded.push(ancestor_identity(&observed.nodes.get(ancestor)?.evidence)?);
        if ancestors_match(&recorded, observed, parents, index) != IdentityMatch::Match {
            return None;
        }
        let mut undecided = Vec::new();
        for other in others {
            // An unreadable ancestor is not a mismatch; a nearer one that
            // definitely differs can still tell the two apart.
            if ancestors_match(&recorded, observed, parents, other) != IdentityMatch::NoMatch {
                undecided.push(other);
            }
        }
        if undecided.is_empty() {
            return Some(recorded);
        }
        others = undecided;
    }
    None
}
