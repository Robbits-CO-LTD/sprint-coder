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

/// A live name slot as an index key.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum NameKey<'a> {
    Known(&'a str),
    Absent,
    Unknown,
}

/// Every node one predicate matches (its "group"), with each member's
/// ancestors below the root and the per-level indexes used to rule members
/// out without comparing each of them.
struct Group<'a> {
    members: Vec<usize>,
    chains: Vec<Vec<usize>>,
    /// Members whose whole chain of ancestors reads exactly like another
    /// member's: no recorded ancestor can ever tell those two apart.
    shadowed: Vec<bool>,
    levels: Vec<Option<Level<'a>>>,
}

/// The members that have an ancestor at one level, indexed by that
/// ancestor's role and stable name. Members whose ancestor role is unread are
/// kept apart, since a recorded role cannot rule them out.
struct Level<'a> {
    by_role_and_name: HashMap<(&'a str, NameKey<'a>), Vec<usize>>,
    by_role: HashMap<&'a str, Vec<usize>>,
    unread_role: Vec<usize>,
}

/// Proves entries by their ancestors for one complete observation, with the
/// same answers as the entry-by-entry rule (`distinguishing_ancestors`): the
/// ancestor chains, the nodes each predicate matches and the per-level indexes
/// are built once and shared by every entry of the window, and an entry with a
/// twin whose ancestors all read the same is settled at once, since nothing
/// can ever tell the two apart. The work it does is counted against a limit;
/// past the limit every remaining entry stays unproven.
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
        let mut group = self.groups.remove(&key).flatten()?;
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
        let deepest = chains.iter().map(Vec::len).max().unwrap_or(0);
        Some(Group {
            members,
            chains,
            shadowed,
            levels: (0..deepest).map(|_| None).collect(),
        })
    }

    fn level(&self, group: &Group<'a>, level: usize) -> Level<'a> {
        let mut index = Level {
            by_role_and_name: HashMap::new(),
            by_role: HashMap::new(),
            unread_role: Vec::new(),
        };
        for (position, chain) in group.chains.iter().enumerate() {
            let observed: &'a ObservedTree = self.observed;
            let Some(evidence) = chain
                .get(level)
                .and_then(|node| observed.nodes.get(*node))
                .map(|node| &node.evidence)
            else {
                continue;
            };
            match crate::refs::ref_identity::meaningful_field(&evidence.role) {
                LocatorField::Known(role) => {
                    let name = match stable_name_field(role, &evidence.name, &evidence.value) {
                        LocatorField::Known(name) => NameKey::Known(name),
                        LocatorField::Absent => NameKey::Absent,
                        LocatorField::Unknown => NameKey::Unknown,
                    };
                    index
                        .by_role_and_name
                        .entry((role, name))
                        .or_default()
                        .push(position);
                    index.by_role.entry(role).or_default().push(position);
                }
                LocatorField::Absent => {}
                LocatorField::Unknown => index.unread_role.push(position),
            }
        }
        index
    }

    /// The rule of `distinguishing_ancestors` for one member: the ancestors are
    /// recorded one level at a time, the entry's own ancestor must match its
    /// record at every level, and the other members are ruled out as soon as
    /// one recorded level definitely differs from theirs (a member with no
    /// ancestor at that level is ruled out too). Only the members the level's
    /// index cannot rule out by role and name are compared.
    fn prove_in(
        &mut self,
        group: &mut Group<'a>,
        index: usize,
    ) -> Option<Vec<RefAncestorIdentity>> {
        let own = group.members.iter().position(|member| *member == index)?;
        if group.members.len() < 2 || group.shadowed.get(own).copied().unwrap_or(true) {
            return None;
        }
        let mut survivors: Vec<usize> = (0..group.members.len())
            .filter(|position| *position != own)
            .collect();
        let mut alive = vec![false; group.members.len()];
        for position in &survivors {
            alive[*position] = true;
        }
        let own_chain = group.chains.get(own)?.clone();
        let mut recorded = Vec::new();
        for (level, ancestor) in own_chain.iter().enumerate() {
            let evidence = &self.observed.nodes.get(*ancestor)?.evidence;
            let identity = ancestor_identity(evidence)?;
            let predicate = FullPredicate::of_ancestor(&identity);
            if predicate.compare(&LivePredicate::observed(evidence)) != IdentityMatch::Match {
                return None;
            }
            if group.levels.get(level)?.is_none() {
                if !self.spend(group.members.len()) {
                    return None;
                }
                let built = self.level(group, level);
                group.levels[level] = Some(built);
            }
            let at = group.levels.get(level)?.as_ref()?;
            let mut possible: Vec<usize> = at.unread_role.clone();
            match identity.name.as_deref() {
                Some(name) => {
                    for key in [NameKey::Known(name), NameKey::Unknown] {
                        if let Some(found) = at.by_role_and_name.get(&(identity.role.as_str(), key))
                        {
                            possible.extend(found);
                        }
                    }
                }
                None => {
                    if let Some(found) = at.by_role.get(identity.role.as_str()) {
                        possible.extend(found);
                    }
                }
            }
            if !self.spend(possible.len().min(survivors.len()).saturating_add(1)) {
                return None;
            }
            let observed = self.observed;
            let chains = &group.chains;
            let still = |position: usize| {
                let verdict = match chains
                    .get(position)
                    .and_then(|chain| chain.get(level))
                    .and_then(|node| observed.nodes.get(*node))
                {
                    Some(node) => predicate.compare(&LivePredicate::observed(&node.evidence)),
                    None => IdentityMatch::NoMatch,
                };
                verdict != IdentityMatch::NoMatch
            };
            let mut kept = Vec::new();
            if possible.len() < survivors.len() {
                for position in possible {
                    if alive[position] && still(position) {
                        kept.push(position);
                    }
                }
            } else {
                let mut listed = vec![false; group.members.len()];
                for position in &possible {
                    listed[*position] = true;
                }
                for position in &survivors {
                    if listed[*position] && still(*position) {
                        kept.push(*position);
                    }
                }
            }
            for position in &survivors {
                alive[*position] = false;
            }
            for position in &kept {
                alive[*position] = true;
            }
            recorded.push(identity);
            if kept.is_empty() {
                return Some(recorded);
            }
            survivors = kept;
        }
        None
    }
}

#[cfg(test)]
#[path = "ref_ancestry_tests.rs"]
mod tests;
