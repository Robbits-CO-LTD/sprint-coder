// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! A walk over child lists the source already holds (the subtree cache) must
//! observe exactly what the live `first_child`/`next_sibling` walk observes:
//! the same nodes, paths, counts and completeness, under the same bounds.

use agent_desktop_core::{LocatorEvidence, ObservationRoot};

use crate::tree::automation::UiaFailure;
use crate::tree::properties::ElementProperties;
use crate::tree::walk::walker::{NodeKey, TreeSource, WalkBudget, WalkOutcome, walk_from_root};
use crate::tree::walk::walker_fake::{FakeTree, budget, walk, window};

/// The fake, answering every child list at once from the same structure its
/// live enumeration walks.
struct Listed<'a>(&'a FakeTree);

impl TreeSource for Listed<'_> {
    type Node = i32;

    fn first_child(&self, _node: &i32) -> Result<i32, UiaFailure> {
        panic!("a walk over held child lists must not enumerate live")
    }

    fn next_sibling(&self, _node: &i32) -> Result<i32, UiaFailure> {
        panic!("a walk over held child lists must not enumerate live")
    }

    fn cached_children(&self, node: &i32) -> Option<Result<Vec<i32>, UiaFailure>> {
        let mut children = Vec::new();
        let mut current = match self.0.first_child(node) {
            Ok(first) => first,
            Err(failure) if failure.is_exhaustion() => return Some(Ok(children)),
            Err(failure) => return Some(Err(failure)),
        };
        loop {
            children.push(current);
            if children.len() > 20_000 {
                return Some(Ok(children));
            }
            match self.0.next_sibling(&current) {
                Ok(next) => current = next,
                Err(failure) if failure.is_exhaustion() => return Some(Ok(children)),
                Err(failure) => return Some(Err(failure)),
            }
        }
    }

    fn identity(&self, node: &i32) -> NodeKey {
        self.0.identity(node)
    }

    fn same_element(&self, left: &i32, right: &i32) -> bool {
        self.0.same_element(left, right)
    }

    fn evidence(&self, node: &i32) -> (ElementProperties, LocatorEvidence, u64) {
        self.0.evidence(node)
    }

    fn is_web_wrapper(&self, node: &i32, properties: &ElementProperties) -> bool {
        self.0.is_web_wrapper(node, properties)
    }
}

fn walk_listed(fake: &FakeTree, budget: WalkBudget) -> WalkOutcome {
    let window = window();
    walk_from_root(&Listed(fake), &1, &ObservationRoot::Window(&window), budget)
        .expect("the walk assembles an observation")
}

fn shape(outcome: &WalkOutcome) -> String {
    format!(
        "{:?}|{:?}|{:?}",
        outcome.tree,
        outcome.stats.traversal,
        outcome
            .failures
            .iter()
            .map(|failure| (&failure.code, &failure.details))
            .collect::<Vec<_>>(),
    )
}

fn assert_same_walk(fake: &FakeTree, budget: WalkBudget) {
    assert_eq!(
        shape(&walk(fake, budget)),
        shape(&walk_listed(fake, budget))
    );
}

#[test]
fn a_held_tree_walks_like_the_live_one() {
    let fake = FakeTree::default()
        .with_children(1, &[2, 3, 4])
        .with_children(3, &[5, 6])
        .with_children(6, &[7]);
    assert_same_walk(&fake, budget(50));
}

#[test]
fn depth_boundaries_count_held_children_like_live_ones() {
    let fake = FakeTree::default()
        .with_children(1, &[2, 3])
        .with_children(2, &[4, 5, 6])
        .with_children(4, &[7]);
    assert_same_walk(&fake, budget(1));
    assert_same_walk(&fake, budget(1).with_max_raw_depth(1));
}

#[test]
fn the_sibling_cap_cuts_a_held_list_like_a_live_one() {
    let children: Vec<i32> = (2..40).collect();
    let fake = FakeTree::default().with_children(1, &children);
    for cap in [1, 10, 38, 39] {
        assert_same_walk(&fake, budget(50).with_max_siblings(cap));
    }
}

#[test]
fn cycles_are_skipped_in_a_held_tree_like_a_live_one() {
    let fake = FakeTree::default()
        .with_chain(&[1, 2, 3])
        .with_children(3, &[1]);
    assert_same_walk(&fake, budget(10));
    let aliased = FakeTree::default().with_chain(&[1, 2, 3, 4]).aliasing(4, 2);
    assert_same_walk(&aliased, budget(10));
}

#[test]
fn wrappers_cost_no_logical_depth_in_a_held_tree() {
    let fake = FakeTree::default()
        .with_chain(&[1, 2, 3, 4])
        .wrapping(2)
        .wrapping(3);
    assert_same_walk(&fake, budget(1));
}

#[test]
fn a_fault_on_a_held_list_is_recorded_and_marks_the_tree_incomplete() {
    let fake = FakeTree::default()
        .with_children(1, &[2, 3])
        .with_children(2, &[4])
        .faulting_on_first_child(2);
    let live = walk(&fake, budget(50));
    let listed = walk_listed(&fake, budget(50));
    assert_eq!(shape(&live), shape(&listed));
    assert!(!listed.tree.is_complete());
    assert_eq!(listed.failures.len(), 1);
}

#[test]
fn an_expired_deadline_keeps_no_held_children_but_an_empty_list_stays_whole() {
    let fake = FakeTree::default().with_children(1, &[2, 3]);
    let source = Listed(&fake);
    let mut walk = super::TreeWalk::new(&source, budget(50));
    let expired = agent_desktop_core::Deadline::after(1).expect("a deadline");
    std::thread::sleep(std::time::Duration::from_millis(5));
    let read = walk.read_cached_children(Ok(vec![2, 3]), 0, expired);
    assert!(read.elements.is_empty());
    assert!(!read.complete);
    let empty = walk.read_cached_children(Ok(Vec::new()), 0, expired);
    assert!(empty.complete);
    let (stats, complete, _) = walk.finish().expect("the walk finishes");
    assert!(!complete);
    assert_eq!(stats.reads.health.deadline_exhausted, 1);
}
