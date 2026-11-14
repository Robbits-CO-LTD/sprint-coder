// Added by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! A view that steps outside the element whose children it lists (the view of
//! visible elements, once its root left it) must not bring what it reached
//! into the walk or the descent.

use crate::tree::resolve::resolve_search::descent::{DescentPolicy, DescentVerdict, descend_path};
use crate::tree::walk::walker_fake::{FakeTree, budget, walk};

/// The window (1) lists 2 and 3; the view's next step after 3 answers 4, an
/// element of another window holding 40.
fn escaping() -> FakeTree {
    FakeTree::default()
        .with_children(1, &[2, 3, 4])
        .with_children(4, &[40])
        .outside_view(4)
}

/// The sibling outside the list is dropped before it is visited or read, its
/// subtree is never walked, and the list (so the walk) does not count as
/// whole, so no proof can rest on it.
#[test]
fn a_sibling_outside_the_listed_element_is_dropped_and_the_walk_is_not_whole() {
    let outcome = walk(&escaping(), budget(50));

    assert_eq!(outcome.stats.traversal.nodes_visited, 3, "1, 2 and 3 only");
    assert!(!outcome.tree.is_complete());
    assert!(outcome.failures.is_empty());
    assert_eq!(outcome.stats.reads.health.cannot_complete, 1);
}

/// Without the escape the same tree walks whole, so the cut above is the
/// guard's doing.
#[test]
fn the_same_tree_without_an_escape_walks_whole() {
    let tree = FakeTree::default()
        .with_children(1, &[2, 3, 4])
        .with_children(4, &[40]);
    let outcome = walk(&tree, budget(50));

    assert_eq!(outcome.stats.traversal.nodes_visited, 5);
    assert!(outcome.tree.is_complete());
}

fn settled(_: crate::tree::automation::UiaFailure) -> DescentVerdict {
    DescentVerdict::Settled
}

const SETTLED: DescentPolicy = DescentPolicy {
    classify: settled,
    descend_context: "test",
    sibling_context: "test",
};

/// A descent counts only the siblings inside the list: a path to the element
/// the view stepped out to lands nowhere, and one before it still lands.
#[test]
fn a_descent_never_lands_on_a_sibling_outside_the_listed_element() {
    let tree = escaping();
    let budget = budget(50);

    assert_eq!(
        descend_path(&tree, &1, &[1], &budget, &SETTLED).expect("the descent reads"),
        Some(3)
    );
    assert_eq!(
        descend_path(&tree, &1, &[2], &budget, &SETTLED).expect("the descent reads"),
        None
    );
    assert_eq!(
        descend_path(&tree, &1, &[2, 0], &budget, &SETTLED).expect("the descent reads"),
        None
    );
}

/// The window (1) lists 2, 3 and 4, all its own; the check of whether 4
/// belongs to the list does not answer (a provider that timed out).
fn unreadable() -> FakeTree {
    FakeTree::default()
        .with_children(1, &[2, 3, 4])
        .with_children(4, &[40])
        .unreadable_view(4)
}

fn surfaced(_: crate::tree::automation::UiaFailure) -> DescentVerdict {
    DescentVerdict::Surfaced
}

const SURFACED: DescentPolicy = DescentPolicy {
    classify: surfaced,
    descend_context: "test",
    sibling_context: "test",
};

/// A check that could not be read is not an answer that the sibling is
/// outside: the descent reports the failed read (which its caller may retry)
/// instead of a list that ended, so a ref below it is not settled as stale.
/// Siblings before it still land.
#[test]
fn a_descent_reports_a_check_it_could_not_read_instead_of_ending_the_list() {
    let tree = unreadable();
    let budget = budget(50);

    assert_eq!(
        descend_path(&tree, &1, &[1], &budget, &SURFACED).expect("the descent reads"),
        Some(3)
    );
    assert!(descend_path(&tree, &1, &[2], &budget, &SURFACED).is_err());
    assert!(descend_path(&tree, &1, &[2, 0], &budget, &SURFACED).is_err());
}

/// The walk drops the sibling it could not check, never visits it or what is
/// below it, and records the failed step, so the walk does not count as whole.
#[test]
fn a_walk_drops_a_sibling_it_could_not_check_and_records_the_failure() {
    let outcome = walk(&unreadable(), budget(50));

    assert_eq!(outcome.stats.traversal.nodes_visited, 3, "1, 2 and 3 only");
    assert!(!outcome.tree.is_complete());
    assert_eq!(outcome.failures.len(), 1, "a failed step, not a cut list");
}
