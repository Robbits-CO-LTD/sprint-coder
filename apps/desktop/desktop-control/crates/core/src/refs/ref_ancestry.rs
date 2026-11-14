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

use std::collections::HashMap;

use crate::{
    IdentityMatch, RefAncestorIdentity, RefEntry,
    locator::live_locator::{LocatorEvidence, LocatorField, ObservedTree},
    refs::ref_full_predicate::{FullPredicate, conjunction},
    refs::ref_identity::{stable_name, stable_name_field},
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
    /// Among the elements the window showed only (`RefEntryIdentity::in_view`,
    /// stored with `unique_at_capture` unset and no top-level ancestors).
    /// Resolution holds it to the same view, its path and its bounds
    /// (`ref_view`), never to the whole-window rule.
    InView,
    /// An item of a window's standard menu bar (`RefEntryIdentity::in_menu`,
    /// stored with `unique_at_capture` unset, no ancestors, no view proof and
    /// no element token). Never resolved to an accessibility element: only a
    /// click runs it, through the window's own menu (`ref_menu`).
    InMenu,
    /// Not proven, or recorded inconsistently (`unique_at_capture` set and
    /// ancestors present, or a view or menu proof next to another proof or an
    /// element token): refused either way.
    None,
}

pub(crate) fn proof_of(entry: &RefEntry) -> Proof {
    if entry.identity.in_menu.is_some() {
        let alone = !entry.identity.unique_at_capture
            && entry.identity.ancestors.is_empty()
            && entry.identity.in_view.is_none()
            && entry.identity.retained_object.is_none();
        return if alone { Proof::InMenu } else { Proof::None };
    }
    match (
        entry.identity.unique_at_capture,
        entry.identity.ancestors.is_empty(),
        entry.identity.in_view.is_some(),
    ) {
        (true, true, false) => Proof::Own,
        (false, false, false) => Proof::WithAncestors,
        (false, true, true) => Proof::InView,
        _ => Proof::None,
    }
}

/// The ancestors an entry's proof recorded: those of a view proof, which are
/// kept inside it, or the entry's own list.
pub(crate) fn recorded_ancestors(entry: &RefEntry) -> &[RefAncestorIdentity] {
    match &entry.identity.in_view {
        Some(view) => &view.ancestors,
        None => &entry.identity.ancestors,
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
    let recorded = recorded_ancestors(entry);
    if recorded.is_empty() {
        return Ok(());
    }
    if recorded.len() > crate::refs::refs_validate::MAX_RECORDED_ANCESTORS {
        return Err(crate::refs::resolve_errors::identity_not_unique(entry));
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
pub(crate) fn chain(parents: &[Option<usize>], index: usize) -> Vec<usize> {
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

/// Whether a recorded ancestor carries a stable feature - a name, a
/// description or a native identifier - that can tell elements apart. An
/// unnamed wrapper does not: wrappers come and go with a redraw, so a
/// difference in their number or role is never what proves a ref.
fn is_stable(ancestor: &RefAncestorIdentity) -> bool {
    ancestor.name.is_some() || ancestor.description.is_some() || ancestor.native_id.is_some()
}

/// Whether the live element could be the recorded stable ancestor: its
/// recorded name, description and identifier compared under the identity
/// rule, with the role taken from the live element, so only a difference in
/// those features rules it out.
fn could_be(ancestor: &RefAncestorIdentity, live: &LocatorEvidence) -> bool {
    let role = crate::refs::ref_identity::meaningful_field(&live.role)
        .known()
        .copied()
        .unwrap_or(ancestor.role.as_str());
    FullPredicate::of_ancestor_as(ancestor, role).compare(&LivePredicate::observed(live))
        != IdentityMatch::NoMatch
}

/// Whether some ancestor of `node` could be the recorded stable ancestor, at
/// whatever depth: an element is told apart by a stable ancestor only when
/// none of its own ancestors could be that one.
fn has_possible(ancestor: &RefAncestorIdentity, observed: &ObservedTree, chain: &[usize]) -> bool {
    chain.iter().any(|node| match observed.nodes.get(*node) {
        Some(node) => could_be(ancestor, &node.evidence),
        None => true,
    })
}

/// The shortest run of nearest ancestors that, with the entry's own
/// predicate, matches the node at `index` and tells it apart from every other
/// node the predicate matches, or `None` when no run does.
///
/// Ancestors are recorded one level at a time, and the node's own ancestor
/// must match its record at every level. Another node is told apart only by
/// a recorded ancestor with a stable feature (`is_stable`) that none of that
/// node's ancestors could be (`could_be`, at any depth): unnamed wrappers,
/// their number and their roles never tell nodes apart, so a node that later
/// gains or loses a wrapper cannot slide into the recorded place. One whose
/// ancestors cannot be read is not told apart. A predicate that matches
/// another node only as unknown leaves the entry unproven, as the plain proof
/// does.
///
/// This is the rule written out directly, one entry at a time. Capture uses
/// [`AncestryProver`], which answers the same for every entry of a window
/// without repeating the work per entry; the tests hold the two to the same
/// answers.
#[cfg(test)]
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
        let identity = ancestor_identity(&observed.nodes.get(ancestor)?.evidence)?;
        recorded.push(identity.clone());
        if ancestors_match(&recorded, observed, parents, index) != IdentityMatch::Match {
            return None;
        }
        if is_stable(&identity) {
            others.retain(|other| has_possible(&identity, observed, &chain(parents, *other)));
        }
        if others.is_empty() {
            return Some(recorded);
        }
    }
    None
}

/// How many identity comparisons one capture may spend proving entries by
/// their ancestors. Past it, every entry still unproven stays unproven - the
/// safe side: such a ref is refused, never guessed at.
const PROOF_WORK_LIMIT: u64 = 20_000_000;

/// The identity fields of one entry's own predicate, as a key: entries with
/// the same key match the same nodes, so the candidates are gathered once.
type PredicateKey = (
    String,
    Option<String>,
    Option<String>,
    Option<crate::ElementIdentifier>,
);

/// Every node one predicate matches (its "group"), with each member's
/// ancestors below the root and an index of the stable features those
/// ancestors carry, used to rule members out without scanning each of them.
struct Group<'a> {
    members: Vec<usize>,
    chains: Vec<Vec<usize>>,
    /// Members whose whole chain of ancestors reads exactly like another
    /// member's: no recorded ancestor can ever tell those two apart.
    shadowed: Vec<bool>,
    features: Option<Features<'a>>,
    /// Generation marks over the members, reused by every entry of the group
    /// so no entry pays for clearing a list as long as the group.
    seen: Vec<u32>,
    alive: Vec<u32>,
    generation: u32,
}

/// For each stable feature, the members that have an ancestor carrying it,
/// and the members that have an ancestor whose slot (or role) is unread and
/// so could carry anything.
#[derive(Default)]
struct Features<'a> {
    names: HashMap<&'a str, Vec<usize>>,
    descriptions: HashMap<&'a str, Vec<usize>>,
    identifiers: HashMap<&'a crate::ElementIdentifier, Vec<usize>>,
    open_names: Vec<usize>,
    open_descriptions: Vec<usize>,
    open_identifiers: Vec<usize>,
}

fn push_once(list: &mut Vec<usize>, member: usize) {
    if list.last() != Some(&member) {
        list.push(member);
    }
}

/// Proves entries by their ancestors for one complete observation, with the
/// same answers as the entry-by-entry rule (`distinguishing_ancestors`): the
/// ancestor chains, the nodes each predicate matches and the index of their
/// ancestors' stable features are built once and shared by every entry of the
/// window, and an entry with a twin whose ancestors all read the same is
/// settled at once, since nothing can ever tell the two apart. The work it
/// does is counted against a limit; past the limit every remaining entry
/// stays unproven.
pub(crate) struct AncestryProver<'a> {
    observed: &'a ObservedTree,
    parents: Vec<Option<usize>>,
    groups: HashMap<PredicateKey, Option<Group<'a>>>,
    work: u64,
    limit: u64,
}

impl<'a> AncestryProver<'a> {
    pub(crate) fn new(observed: &'a ObservedTree) -> Self {
        Self::with_limit(observed, PROOF_WORK_LIMIT)
    }

    pub(crate) fn with_limit(observed: &'a ObservedTree, limit: u64) -> Self {
        Self {
            observed,
            parents: parents(observed),
            groups: HashMap::new(),
            work: 0,
            limit,
        }
    }

    /// Counts `amount` against the limit; false once the limit is spent.
    fn spend(&mut self, amount: usize) -> bool {
        self.work = self
            .work
            .saturating_add(u64::try_from(amount).unwrap_or(u64::MAX));
        self.work <= self.limit
    }

    fn live(&self, node: usize) -> Option<LivePredicate<'a>> {
        self.observed
            .nodes
            .get(node)
            .map(|node| LivePredicate::observed(&node.evidence))
    }

    /// The same answer as `distinguishing_ancestors` for this entry, or `None`
    /// once the work limit is spent.
    pub(crate) fn prove(
        &mut self,
        entry: &RefEntry,
        index: usize,
    ) -> Option<Vec<RefAncestorIdentity>> {
        if self.work > self.limit {
            return None;
        }
        let predicate = FullPredicate::of_entry(entry);
        let key: PredicateKey = (
            predicate.role.to_string(),
            predicate.name.map(str::to_string),
            predicate.description.map(str::to_string),
            predicate.native_id.cloned(),
        );
        if !self.groups.contains_key(&key) {
            let group = self.build_group(&predicate);
            self.groups.insert(key.clone(), group);
        }
        let Some(mut group) = self.groups.remove(&key).flatten() else {
            // Remember the unprovable answer too, so the window is not scanned
            // again for the next entry with the same predicate.
            self.groups.insert(key, None);
            return None;
        };
        let answer = self.prove_in(&mut group, index);
        self.groups.insert(key, Some(group));
        answer
    }

    /// The nodes the predicate matches; `None` when it matches any node only
    /// as unknown, which leaves every entry of the predicate unproven.
    fn build_group(&mut self, predicate: &FullPredicate<'_>) -> Option<Group<'a>> {
        if !self.spend(self.observed.nodes.len()) {
            return None;
        }
        let mut members = Vec::new();
        for (candidate, node) in self.observed.nodes.iter().enumerate() {
            match predicate.compare(&LivePredicate::observed(&node.evidence)) {
                IdentityMatch::Match => members.push(candidate),
                IdentityMatch::NoMatch => {}
                IdentityMatch::Unknown => return None,
            }
        }
        let chains: Vec<Vec<usize>> = if members.len() < 2 {
            Vec::new()
        } else {
            members
                .iter()
                .map(|member| chain(&self.parents, *member))
                .collect()
        };
        if !self.spend(chains.iter().map(Vec::len).sum::<usize>()) {
            return None;
        }
        let signatures: Vec<String> = chains
            .iter()
            .map(|chain| {
                chain
                    .iter()
                    .map(|node| match self.live(*node) {
                        Some(live) => format!(
                            "{:?}|{:?}|{:?}|{:?}|{:?}|{}",
                            live.role,
                            live.name,
                            live.value,
                            live.description,
                            live.native_ids,
                            live.native_ids_complete
                        ),
                        None => "?".to_string(),
                    })
                    .collect::<Vec<_>>()
                    .join("\u{1}")
            })
            .collect();
        let mut seen: HashMap<&str, u32> = HashMap::new();
        for signature in &signatures {
            *seen.entry(signature.as_str()).or_insert(0) += 1;
        }
        let shadowed = signatures
            .iter()
            .map(|signature| seen.get(signature.as_str()).copied().unwrap_or(0) > 1)
            .collect();
        Some(Group {
            members,
            chains,
            shadowed,
            features: None,
            seen: Vec::new(),
            alive: Vec::new(),
            generation: 0,
        })
    }

    /// The index of every member's ancestors' stable features, read the way
    /// `could_be` compares them: the name as the stable name under the
    /// ancestor's own role.
    fn features(&self, group: &Group<'a>) -> Features<'a> {
        let observed: &'a ObservedTree = self.observed;
        let mut features = Features::default();
        for (member, chain) in group.chains.iter().enumerate() {
            for node in chain {
                let Some(evidence) = observed.nodes.get(*node).map(|node| &node.evidence) else {
                    push_once(&mut features.open_names, member);
                    push_once(&mut features.open_descriptions, member);
                    push_once(&mut features.open_identifiers, member);
                    continue;
                };
                match crate::refs::ref_identity::meaningful_field(&evidence.role) {
                    LocatorField::Known(role) => {
                        match stable_name_field(role, &evidence.name, &evidence.value) {
                            LocatorField::Known(name) => {
                                push_once(features.names.entry(name).or_default(), member)
                            }
                            LocatorField::Absent => {}
                            LocatorField::Unknown => push_once(&mut features.open_names, member),
                        }
                    }
                    // A recorded name is compared under the recorded role when
                    // the live one is unread, so such an ancestor stays open.
                    _ => push_once(&mut features.open_names, member),
                }
                match crate::refs::ref_identity::meaningful_field(&evidence.description) {
                    LocatorField::Known(description) => push_once(
                        features.descriptions.entry(description).or_default(),
                        member,
                    ),
                    LocatorField::Absent => {}
                    LocatorField::Unknown => push_once(&mut features.open_descriptions, member),
                }
                for identifier in evidence.identifiers.identifiers() {
                    push_once(features.identifiers.entry(identifier).or_default(), member);
                }
                if !evidence.identifiers.is_complete() {
                    push_once(&mut features.open_identifiers, member);
                }
            }
        }
        features
    }

    /// The rule of `distinguishing_ancestors` for one member. The index only
    /// narrows which members need the full check: a member that has no
    /// ancestor carrying the recorded feature, nor one whose slot is unread,
    /// cannot have an ancestor that could be the recorded one.
    fn prove_in(
        &mut self,
        group: &mut Group<'a>,
        index: usize,
    ) -> Option<Vec<RefAncestorIdentity>> {
        let own = group.members.iter().position(|member| *member == index)?;
        if group.members.len() < 2 || group.shadowed.get(own).copied().unwrap_or(true) {
            return None;
        }
        if group.seen.len() != group.members.len() {
            group.seen = vec![0; group.members.len()];
            group.alive = vec![0; group.members.len()];
        }
        // Until the first stable ancestor rules anyone out, every other member
        // is still undecided; the list is only built once it shrinks.
        let mut everyone = true;
        let mut survivors: Vec<usize> = Vec::new();
        let mut alive_mark = 0u32;
        let own_chain = group.chains.get(own)?.clone();
        let mut recorded = Vec::new();
        for ancestor in &own_chain {
            let evidence = &self.observed.nodes.get(*ancestor)?.evidence;
            let identity = ancestor_identity(evidence)?;
            if FullPredicate::of_ancestor(&identity).compare(&LivePredicate::observed(evidence))
                != IdentityMatch::Match
            {
                return None;
            }
            if is_stable(&identity) {
                if group.features.is_none() {
                    let size = group.chains.iter().map(Vec::len).sum::<usize>();
                    if !self.spend(size) {
                        return None;
                    }
                    group.features = Some(self.features(group));
                }
                let features = group.features.as_ref()?;
                let (found, open) = if let Some(name) = identity.name.as_deref() {
                    (features.names.get(name), &features.open_names)
                } else if let Some(description) = identity.description.as_deref() {
                    (
                        features.descriptions.get(description),
                        &features.open_descriptions,
                    )
                } else {
                    let identifier = identity.native_id.as_ref()?;
                    (
                        features.identifiers.get(identifier),
                        &features.open_identifiers,
                    )
                };
                let candidates: Vec<usize> =
                    found.into_iter().flatten().chain(open).copied().collect();
                group.generation = group.generation.wrapping_add(1);
                let mark = group.generation;
                let observed = self.observed;
                let chains = &group.chains;
                let mut checked = 0usize;
                let mut kept = Vec::new();
                if everyone || candidates.len() < survivors.len() {
                    for member in candidates {
                        if member == own || group.seen[member] == mark {
                            continue;
                        }
                        group.seen[member] = mark;
                        let undecided = everyone || group.alive[member] == alive_mark;
                        if undecided {
                            checked = checked.saturating_add(chains[member].len());
                            if has_possible(&identity, observed, &chains[member]) {
                                kept.push(member);
                            }
                        }
                    }
                } else {
                    for member in candidates {
                        group.seen[member] = mark;
                    }
                    for member in &survivors {
                        if group.seen[*member] == mark {
                            checked = checked.saturating_add(chains[*member].len());
                            if has_possible(&identity, observed, &chains[*member]) {
                                kept.push(*member);
                            }
                        }
                    }
                }
                if !self.spend(checked.saturating_add(survivors.len()).saturating_add(1)) {
                    return None;
                }
                group.generation = group.generation.wrapping_add(1);
                alive_mark = group.generation;
                for member in &kept {
                    group.alive[*member] = alive_mark;
                }
                survivors = kept;
                everyone = false;
            }
            recorded.push(identity);
            if !everyone && survivors.is_empty() {
                return Some(recorded);
            }
        }
        None
    }
}

#[cfg(test)]
#[path = "ref_ancestry_tests.rs"]
mod tests;
