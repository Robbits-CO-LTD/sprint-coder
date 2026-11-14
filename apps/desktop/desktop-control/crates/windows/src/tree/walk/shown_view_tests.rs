// Added by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::*;
use crate::tree::properties::ElementProperties;
use crate::tree::properties::property_ids::TreeProperty;
use crate::tree::properties::property_outcome::{PropertyOutcome, PropertyValue};
use crate::tree::resolve::resolve_search::descent::{DescentPolicy, DescentVerdict, descend_path};
use crate::tree::walk::walker::{WalkBudget, walk_from_root};
use crate::tree::walk::walker_fake::{FakeTree, deadline, window};
use agent_desktop_core::{AccessibilityNode, Deadline, LocatorEvidence, ObservationRoot};

/// The fake tree with the offscreen report the shown view reads, taken from
/// each node's read set, and a count of the sibling steps it answered.
struct Reported {
    tree: FakeTree,
    steps: std::cell::Cell<usize>,
    /// Nodes whose offscreen report cannot be read (the read fails).
    unreadable: std::collections::HashSet<i32>,
}

impl Reported {
    fn new(tree: FakeTree) -> Self {
        Self {
            tree,
            steps: std::cell::Cell::new(0),
            unreadable: std::collections::HashSet::new(),
        }
    }
}

impl TreeSource for Reported {
    type Node = i32;

    fn first_child(&self, node: &i32) -> Result<i32, UiaFailure> {
        self.tree.first_child(node)
    }

    fn next_sibling(&self, node: &i32) -> Result<i32, UiaFailure> {
        self.steps.set(self.steps.get() + 1);
        self.tree.next_sibling(node)
    }

    fn identity(&self, node: &i32) -> NodeKey {
        self.tree.identity(node)
    }

    fn same_element(&self, left: &i32, right: &i32) -> bool {
        self.tree.same_element(left, right)
    }

    fn evidence(&self, node: &i32) -> (ElementProperties, LocatorEvidence, u64) {
        self.tree.evidence(node)
    }

    fn is_web_wrapper(&self, node: &i32, properties: &ElementProperties) -> bool {
        self.tree.is_web_wrapper(node, properties)
    }
}

impl OffscreenReport for Reported {
    fn reported_offscreen(&self, node: &i32) -> Result<bool, UiaFailure> {
        if self.unreadable.contains(node) {
            return Err(crate::tree::walk::walker_fake::REAL_FAILURE);
        }
        Ok(self
            .tree
            .evidence(node)
            .0
            .get(TreeProperty::IsOffscreen)
            .flag()
            == Some(true))
    }
}

fn named(name: &str) -> (TreeProperty, PropertyOutcome) {
    (
        TreeProperty::Name,
        PropertyOutcome::Known(PropertyValue::Text(name.into())),
    )
}

fn offscreen(flag: bool) -> (TreeProperty, PropertyOutcome) {
    (
        TreeProperty::IsOffscreen,
        PropertyOutcome::Known(PropertyValue::Flag(flag)),
    )
}

/// A node named after its number, reporting `offscreen` as given.
fn node(tree: FakeTree, id: i32, off: bool) -> FakeTree {
    tree.reading(id, &[named(&format!("n{id}")), offscreen(off)])
}

/// The WPF shape measured on a non-virtualized `ListBox`: a window (1) holding
/// a button (2) and a list (3) of `rows` rows (100, 101, ...), each row holding
/// one button (1000 + row) that reports onscreen whatever its row reports.
/// Rows whose index is in `shown` report onscreen; every other row reports
/// offscreen.
fn wpf_list(rows: i32, shown: &[i32]) -> FakeTree {
    let row_ids: Vec<i32> = (0..rows).map(|row| 100 + row).collect();
    let mut tree = FakeTree::default()
        .with_children(1, &[2, 3])
        .with_children(3, &row_ids);
    tree = node(tree, 1, false);
    tree = node(tree, 2, false);
    tree = node(tree, 3, false);
    for row in 0..rows {
        let id = 100 + row;
        tree = node(tree, id, !shown.contains(&row)).with_children(id, &[1000 + row]);
        tree = node(tree, 1000 + row, false);
    }
    tree
}

fn shown_walk(source: &Reported, cap: usize) -> AccessibilityNode {
    let window = window();
    let view = ShownView::with_cap(source, cap, deadline());
    let outcome = walk_from_root(
        &view,
        &ShownNode::root(1),
        &ObservationRoot::Window(&window),
        WalkBudget::new(50, deadline()),
    )
    .expect("the shown view is walked");
    assert!(outcome.failures.is_empty());
    assert!(outcome.tree.is_complete(), "the shown view is read whole");
    outcome
        .tree
        .into_accessibility_tree()
        .expect("a complete view projects")
}

fn names(node: &AccessibilityNode) -> Vec<String> {
    node.children
        .iter()
        .map(|child| child.identity.name.clone().unwrap_or_default())
        .collect()
}

fn list(tree: &AccessibilityNode) -> &AccessibilityNode {
    &tree.children[1]
}

/// Only measured frameworks get a view: Chromium provenance the onscreen view
/// whatever the framework, a WPF root the shown view, anything else none.
#[test]
fn only_chromium_and_wpf_windows_have_a_visible_view() {
    assert_eq!(visible_view_for(true, None), Some(VisibleView::Onscreen));
    assert_eq!(
        visible_view_for(true, Some("WPF")),
        Some(VisibleView::Onscreen)
    );
    assert_eq!(
        visible_view_for(false, Some("WPF")),
        Some(VisibleView::Shown)
    );
    for other in [
        None,
        Some(""),
        Some("wpf"),
        Some(" WPF"),
        Some("WinForm"),
        Some("Win32"),
        Some("XAML"),
        Some("DirectUI"),
        Some("Chrome"),
    ] {
        assert_eq!(visible_view_for(false, other), None, "{other:?}");
    }
}

/// A row reported offscreen is left out with everything below it, though the
/// button inside it reports onscreen (the WPF shape), and the elements outside
/// the list stay in the view.
#[test]
fn an_offscreen_row_is_left_out_with_its_descendants() {
    let source = Reported::new(wpf_list(6, &[0, 1]));
    let tree = shown_walk(&source, SHOWN_CHILD_CAP);

    assert_eq!(names(&tree), ["n2", "n3"]);
    assert_eq!(names(list(&tree)), ["n100", "n101"]);
    assert_eq!(names(&list(&tree).children[0]), ["n1000"]);
    assert!(!list(&tree).subtree_truncated, "the whole list was read");
}

/// The view reads a child list only up to the cap, so a long list costs at most
/// the cap's worth of steps, and a row it shows past the cap is not part of the
/// view; the list is marked cut, while the rest of the tree stays complete.
#[test]
fn a_list_longer_than_the_cap_is_read_to_the_cap_and_marked_cut() {
    let source = Reported::new(wpf_list(300, &[0, 250]));
    let tree = shown_walk(&source, 20);

    assert_eq!(names(list(&tree)), ["n100"]);
    assert!(list(&tree).subtree_truncated);
    assert!(!tree.children[0].subtree_truncated);
    // The window's two children (2 steps, the last finding the end), the list
    // up to the element at the cap (20), and the button of the one row shown
    // (1): never the 280 rows past the cap.
    assert!(source.steps.get() <= 23, "{} steps", source.steps.get());
}

/// A list that ends exactly at the cap ended for real: it is not marked cut.
#[test]
fn a_list_that_ends_at_the_cap_is_not_cut() {
    let source = Reported::new(wpf_list(20, &[0]));
    let tree = shown_walk(&source, 20);

    assert_eq!(names(list(&tree)), ["n100"]);
    assert!(!list(&tree).subtree_truncated);
}

/// Every row of the cap reported offscreen leaves the list empty and cut.
#[test]
fn a_list_scrolled_past_the_cap_shows_nothing_and_is_cut() {
    let source = Reported::new(wpf_list(300, &[150, 151]));
    let tree = shown_walk(&source, 20);

    assert!(list(&tree).children.is_empty());
    assert!(list(&tree).subtree_truncated);
    assert_eq!(names(&tree), ["n2", "n3"]);
}

fn settled(_: UiaFailure) -> DescentVerdict {
    DescentVerdict::Settled
}

const SETTLED: DescentPolicy = DescentPolicy {
    classify: settled,
    descend_context: "test",
    sibling_context: "test",
};

/// A path descent in the shown view counts the same positions the walk
/// recorded: position 1 of the list is the second row shown, not the second
/// row of the list.
#[test]
fn a_descent_in_the_shown_view_lands_where_the_walk_counted() {
    let source = Reported::new(wpf_list(8, &[2, 5]));
    let view = ShownView::new(&source, deadline());
    let budget = WalkBudget::new(50, deadline());

    let landed = descend_path(&view, &ShownNode::root(1), &[1, 1, 0], &budget, &SETTLED)
        .expect("the descent reads")
        .map(|node| node.element);
    assert_eq!(landed, Some(1005));

    let past = descend_path(&view, &ShownNode::root(1), &[1, 2], &budget, &SETTLED)
        .expect("the descent reads");
    assert!(past.is_none(), "the view holds two rows");
}

/// A step over offscreen siblings that runs past the deadline answers a
/// timeout, never the end of the list (which would read as a whole, shorter
/// list).
#[test]
fn a_step_cut_by_the_deadline_is_a_timeout_not_the_end_of_the_list() {
    let source = Reported::new(wpf_list(10, &[9]));
    let expired = Deadline::after(1).expect("a deadline");
    std::thread::sleep(std::time::Duration::from_millis(5));
    let view = ShownView::new(&source, expired);

    let failure = view
        .first_child(&ShownNode::root(3))
        .err()
        .expect("no row is reached in time");
    assert!(!failure.is_exhaustion());
}

/// A row whose offscreen report cannot be read is neither put in the view nor
/// stepped over: the list stops there as a failed step, so neither that row nor
/// any after it is in the walk, and the walk is not whole (no proof rests on
/// it). Guessing either way would shift every later position between the
/// capture and a later read.
#[test]
fn a_row_whose_report_cannot_be_read_stops_the_walk_as_not_whole() {
    let mut source = Reported::new(wpf_list(6, &[0, 1, 3]));
    source.unreadable.insert(102);
    let window = window();
    let view = ShownView::new(&source, deadline());
    let outcome = walk_from_root(
        &view,
        &ShownNode::root(1),
        &ObservationRoot::Window(&window),
        WalkBudget::new(50, deadline()),
    )
    .expect("the walk assembles what it read");

    assert!(!outcome.tree.is_complete());
    assert_eq!(outcome.failures.len(), 1, "the failed step is recorded");
    // Window, button, list, rows 0 and 1 with their buttons: never row 2 or 3.
    assert_eq!(outcome.stats.traversal.nodes_visited, 7);
}

/// A descent in the shown view lands before an unreadable row as before, and a
/// path that would count past it answers the failure, never a landing.
#[test]
fn a_descent_past_a_row_whose_report_cannot_be_read_fails() {
    let mut source = Reported::new(wpf_list(6, &[0, 1, 3]));
    source.unreadable.insert(102);
    let view = ShownView::new(&source, deadline());
    let budget = WalkBudget::new(50, deadline());
    let surfaced = DescentPolicy {
        classify: |_| DescentVerdict::Surfaced,
        descend_context: "test",
        sibling_context: "test",
    };

    let landed = descend_path(&view, &ShownNode::root(1), &[1, 1], &budget, &surfaced)
        .expect("the row before reads")
        .map(|node| node.element);
    assert_eq!(landed, Some(101));
    assert!(descend_path(&view, &ShownNode::root(1), &[1, 2], &budget, &surfaced).is_err());
}
