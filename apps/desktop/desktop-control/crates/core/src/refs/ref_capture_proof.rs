// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use std::collections::HashMap;
use std::sync::OnceLock;

use crate::{
    ElementIdentifier, IdentityMatch, RefEntry,
    locator::live_locator::{LocatorEvidence, LocatorField, ObservationSource, ObservedTree},
    refs::ref_full_predicate::{DESCRIPTION, FullPredicate, NAME, NATIVE_ID},
    refs::ref_identity::stable_name,
    refs::ref_live_predicate::LivePredicate,
    tree::accname::non_blank,
};

const ROLE: u8 = DESCRIPTION << 1;
const MASKS: usize = (NATIVE_ID | NAME | DESCRIPTION) as usize + 1;

/// One whole-window observation, counted once into the field subsets its
/// entries record, so every tokenless entry published from it is proven by the
/// rule `proves_node` applies rather than by a fresh scan per entry.
///
/// The count is the comparison resolution runs: `FullPredicate::of_entry` of the
/// entry being published, measured against the evidence every node reported, so
/// an identifier chosen by a query or a field that went unread counts the way it
/// will count later.
pub(crate) struct CaptureProof<'a> {
    observed: &'a ObservedTree,
    start: Option<usize>,
    buckets: [OnceLock<HashMap<LiveKey<'a>, usize>>; MASKS],
    unread: Vec<(u8, LivePredicate<'a>)>,
    whole_window: bool,
    /// The observation covers only the elements the window showed, so what
    /// it proves holds in that view alone (`RefEntryIdentity::in_view`).
    in_view: bool,
    ancestry: std::cell::RefCell<Option<crate::refs::ref_ancestry::AncestryProver<'a>>>,
}

impl<'a> CaptureProof<'a> {
    pub(crate) fn new(observed: &'a ObservedTree) -> Self {
        let whole_window =
            matches!(observed.source, ObservationSource::Window { .. }) && observed.is_exhaustive();
        Self {
            observed,
            whole_window,
            in_view: observed.is_visible_scope(),
            start: observed.roots.first().map(|root| *root as usize),
            buckets: std::array::from_fn(|_| OnceLock::new()),
            unread: observed
                .nodes
                .iter()
                .filter_map(|node| {
                    let bits = unread_bits(&node.evidence);
                    (bits != 0).then(|| (bits, LivePredicate::observed(&node.evidence)))
                })
                .collect(),
            ancestry: std::cell::RefCell::new(None),
        }
    }

    /// Starts allocation paths at the node whose observed path is `prefix`, as a
    /// drill does: the prefix is that node's own path, and the rest of an
    /// allocation path counts positions in the projected tree below it.
    pub(crate) fn rooted_at(mut self, prefix: &[usize]) -> Self {
        self.start = self
            .observed
            .nodes
            .iter()
            .position(|node| node.path.as_slice() == prefix);
        self
    }

    /// Whether `entry`, allocated at `path`, is proven. The path is read the way
    /// allocation wrote it: the start node's own path, then child positions in
    /// the projection, which skips no child the observation kept even when the
    /// native indices have gaps.
    pub(crate) fn proves(&self, entry: &RefEntry, path: &[usize]) -> bool {
        self.node_at(path)
            .is_some_and(|index| self.proves_node(entry, index))
    }

    /// Marks `entry`, allocated at `path`, proven or not, as [`Self::establish`].
    pub(crate) fn establish_at(&self, entry: &mut RefEntry, path: &[usize]) {
        match self.node_at(path) {
            Some(index) => self.establish(entry, index),
            None => {
                entry.identity.unique_at_capture = false;
                entry.identity.ancestors = Vec::new();
                entry.identity.in_view = None;
            }
        }
    }

    /// Marks `entry` proven when its own predicate proves it (as
    /// [`Self::proves_node`]), or else when its predicate together with its
    /// nearest ancestors matches this node and no other of the same complete
    /// whole-window observation; those ancestors are then recorded on the
    /// entry, and resolution requires them as well (`ref_ancestry`).
    pub(crate) fn establish(&self, entry: &mut RefEntry, index: usize) {
        entry.identity.ancestors = Vec::new();
        entry.identity.in_view = None;
        if self.in_view {
            self.establish_in_view(entry, index);
            return;
        }
        entry.identity.unique_at_capture = self.proves_node(entry, index);
        if entry.identity.unique_at_capture || !self.whole_window {
            return;
        }
        let proven = self
            .ancestry
            .borrow_mut()
            .get_or_insert_with(|| crate::refs::ref_ancestry::AncestryProver::new(self.observed))
            .prove(entry, index);
        if let Some(ancestors) = proven {
            entry.identity.ancestors = ancestors;
            // Left unset: an older reader that ignores the ancestors must see
            // an unproven entry (see `RefEntryIdentity::ancestors`).
            entry.identity.unique_at_capture = false;
        }
    }

    /// [`Self::establish`] over a view of the visible elements: the same two
    /// rules (the entry's own predicate, then its nearest ancestors), counted
    /// over that view only, recorded as a view proof with the element's path
    /// in the view and its screen bounds. Never `unique_at_capture`, which
    /// would stand for the whole window.
    fn establish_in_view(&self, entry: &mut RefEntry, index: usize) {
        entry.identity.unique_at_capture = false;
        if crate::refs::ref_identity::element_token(entry).is_some() {
            return;
        }
        let Some(node) = self.observed.nodes.get(index) else {
            return;
        };
        let Some(bounds) = crate::refs::ref_view::view_bounds(&node.evidence) else {
            return;
        };
        let Some(runtime_id) = crate::refs::ref_view::view_runtime_id(&node.evidence) else {
            return;
        };
        let ancestors = if self.counts_once(entry, index) {
            Some(Vec::new())
        } else if self.whole_window {
            self.ancestry
                .borrow_mut()
                .get_or_insert_with(|| {
                    crate::refs::ref_ancestry::AncestryProver::new(self.observed)
                })
                .prove(entry, index)
        } else {
            None
        };
        if let Some(ancestors) = ancestors {
            entry.identity.in_view = Some(crate::RefViewProof {
                path: node.path.clone(),
                bounds,
                runtime_id,
                ancestors,
            });
        }
    }

    fn node_at(&self, path: &[usize]) -> Option<usize> {
        let mut index = self.start?;
        let prefix = self.observed.nodes.get(index)?.path.as_slice();
        let steps = path.strip_prefix(prefix)?;
        for step in steps {
            index = *self.observed.nodes.get(index)?.children.get(*step)? as usize;
        }
        Some(index)
    }

    /// Whether `entry` was proven unique at the node it was built from: the
    /// observation must be a complete whole-window read, exactly one of its nodes
    /// must match the entry's full predicate, no node may leave a recorded field
    /// unread, and that one node must be this one.
    pub(crate) fn proves_node(&self, entry: &RefEntry, index: usize) -> bool {
        // A view of the visible elements never proves an element unique in
        // the whole window.
        !self.in_view && self.counts_once(entry, index)
    }

    /// Whether the observation is complete and exactly one of its nodes, this
    /// one, matches the entry's full predicate with no node leaving a recorded
    /// field unread.
    fn counts_once(&self, entry: &RefEntry, index: usize) -> bool {
        if !self.whole_window {
            return false;
        }
        let predicate = FullPredicate::of_entry(entry);
        let fields = predicate.mask();
        if self.buckets[fields as usize]
            .get_or_init(|| count_nodes(self.observed, fields))
            .get(&key_of(&predicate))
            != Some(&index)
        {
            return false;
        }
        !self.unread.iter().any(|(bits, live)| {
            bits & (fields | ROLE) != 0 && predicate.compare(live) == IdentityMatch::Unknown
        })
    }
}

/// The node indices each full predicate of this field subset matched, as a
/// single index per predicate. A predicate two nodes match is stored with the
/// last of them, so it never equals the node an entry was built from.
fn count_nodes(observed: &ObservedTree, fields: u8) -> HashMap<LiveKey<'_>, usize> {
    let mut counted: HashMap<LiveKey<'_>, (usize, usize)> = HashMap::new();
    for (index, node) in observed.nodes.iter().enumerate() {
        for key in keys_of(&node.evidence, fields) {
            let entry = counted.entry(key).or_insert((0, index));
            entry.0 += 1;
            entry.1 = index;
        }
    }
    counted
        .into_iter()
        .filter(|(_, (count, _))| *count == 1)
        .map(|(key, (_, index))| (key, index))
        .collect()
}

fn keys_of<'a>(evidence: &'a LocatorEvidence, fields: u8) -> Vec<LiveKey<'a>> {
    let Some(role) = non_blank(evidence.role.known().map(String::as_str)) else {
        return Vec::new();
    };
    let name = match fields & NAME {
        0 => None,
        _ => match stable_name(
            role,
            evidence.name.known().map(String::as_str),
            evidence.value.known().map(String::as_str),
        ) {
            Some(name) => Some(name),
            None => return Vec::new(),
        },
    };
    let description = match fields & DESCRIPTION {
        0 => None,
        _ => match non_blank(evidence.description.known().map(String::as_str)) {
            Some(description) => Some(description),
            None => return Vec::new(),
        },
    };
    let key = |native_id: Option<&'a ElementIdentifier>| LiveKey {
        role,
        name,
        description,
        native_id,
    };
    if fields & NATIVE_ID == 0 {
        return vec![key(None)];
    }
    evidence
        .identifiers
        .identifiers()
        .iter()
        .map(|native_id| key(Some(native_id)))
        .collect()
}

/// The fields this element could not answer, so a predicate that records one of
/// them reaches `Unknown` here exactly as it will at resolution.
fn unread_bits(evidence: &LocatorEvidence) -> u8 {
    let live = LivePredicate::observed(evidence);
    let mut bits = 0;
    match &live.role {
        LocatorField::Known(role) => {
            if live.stable_name(role).is_unknown() {
                bits |= NAME;
            }
        }
        LocatorField::Unknown => bits |= ROLE,
        LocatorField::Absent => {}
    }
    if live.description.is_unknown() {
        bits |= DESCRIPTION;
    }
    if !live.native_ids_complete {
        bits |= NATIVE_ID;
    }
    bits
}

fn key_of<'b>(predicate: &FullPredicate<'b>) -> LiveKey<'b> {
    LiveKey {
        role: predicate.role,
        name: predicate.name,
        description: predicate.description,
        native_id: predicate.native_id,
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct LiveKey<'a> {
    role: &'a str,
    name: Option<&'a str>,
    description: Option<&'a str>,
    native_id: Option<&'a ElementIdentifier>,
}

#[cfg(test)]
#[path = "ref_capture_proof_tests.rs"]
mod tests;
