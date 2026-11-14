// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::{
    VISIBLE_CHECK_CAP, WHOLE_READ_CAP, needs_whole_window, visible_share, whole_read_budget,
};
use std::time::Duration;

/// The default snapshot keeps the share it always had: three quarters.
#[test]
fn a_default_deadline_gives_the_whole_read_three_quarters() {
    let default = Duration::from_millis(crate::snapshot::DEFAULT_SNAPSHOT_TIMEOUT_MS);
    assert_eq!(budget(default), default * 3 / 4);
    assert_eq!(
        budget(Duration::from_millis(4_000)),
        Duration::from_millis(3_000)
    );
}

/// A long deadline does not stretch the whole read: 10 s and 20 s both stop
/// at the same cap, so the switch to the visible elements comes no later.
#[test]
fn a_long_deadline_caps_the_whole_read_independently_of_its_length() {
    assert_eq!(WHOLE_READ_CAP, Duration::from_millis(4_500));
    assert_eq!(budget(Duration::from_millis(10_000)), WHOLE_READ_CAP);
    assert_eq!(budget(Duration::from_millis(20_000)), WHOLE_READ_CAP);
    assert_eq!(budget(Duration::from_secs(3_600)), WHOLE_READ_CAP);
}

/// The cap never starves the fallback gate: a capped read still had more than
/// the half of a default deadline `view_fallback_allowed` asks of it.
#[test]
fn the_cap_leaves_the_view_fallback_reachable() {
    let default = Duration::from_millis(crate::snapshot::DEFAULT_SNAPSHOT_TIMEOUT_MS);
    assert!(WHOLE_READ_CAP >= default / 2);
    assert!(WHOLE_READ_CAP >= budget(default));
}

/// The whole read's time for a full default deadline or more, which a read of
/// the visible elements that can follow does not change.
fn budget(remaining: Duration) -> Duration {
    let budget = whole_read_budget(remaining, Duration::ZERO);
    assert_eq!(budget, whole_read_budget(remaining, FLOOR), "{remaining:?}");
    budget
}

/// The floor the Windows adapter answers for a WPF window.
const FLOOR: Duration = Duration::from_millis(750);

/// Past the window listing, a default snapshot has about 2.55 s left. A read
/// of the visible elements that needs a floor (a WPF window) is left at least
/// that; a zero floor (a Chromium-hosted window, or a window not read that
/// way) keeps three quarters for the whole read, as before.
#[test]
fn the_floor_for_the_visible_read_applies_only_where_one_is_asked_for() {
    let remaining = Duration::from_millis(2_550);
    assert_eq!(
        whole_read_budget(remaining, Duration::ZERO),
        remaining * 3 / 4,
        "a zero floor splits as before"
    );
    assert_eq!(whole_read_budget(remaining, FLOOR), remaining - FLOOR);
}

/// The check whether a window is read by its visible elements gets a short cap
/// of its own, the same as the probe a find makes.
#[test]
fn the_check_for_a_view_has_a_short_cap() {
    assert_eq!(VISIBLE_CHECK_CAP, Duration::from_millis(500));
}

/// The visible read gets all that is left when the whole read left a tree to
/// answer with in its place, and two thirds when it did not (a shallow walk
/// then answers).
#[test]
fn the_visible_read_keeps_a_third_only_when_no_tree_is_left_to_answer() {
    let deadline = crate::Deadline::after(900).expect("a deadline");
    let all = visible_share(deadline, true).remaining();
    let part = visible_share(deadline, false).remaining();
    assert!(all > Duration::from_millis(850), "{all:?}");
    assert!(part <= Duration::from_millis(600), "{part:?}");
}
use crate::locator::live_locator::{ObservationRoot, ObservedTree};
use crate::{AccessibilityNode, WindowInfo};

fn window() -> WindowInfo {
    WindowInfo {
        id: "w-1".into(),
        title: "Fixture".into(),
        app: "Fixture".into(),
        pid: crate::ProcessId::new(1),
        process_instance: Some("test-instance".into()),
        bounds: None,
        state: crate::WindowState::default(),
    }
}

fn node(role: &str, name: &str) -> AccessibilityNode {
    crate::adapter::minimal_accessibility_node(role, name)
}

fn tokened(role: &str, name: &str, token: &str) -> AccessibilityNode {
    let mut node = node(role, name);
    node.identity.retained_object = Some(format!("axtok1:{token}"));
    node
}

fn observed(root: AccessibilityNode) -> ObservedTree {
    let window = window();
    crate::adapter::observed_tree(&ObservationRoot::Window(&window), root)
        .expect("the fixture observes")
}

/// A window whose walk stopped at a container: the container keeps the count of
/// what it hid, so a shallow presentation can still offer it as a drill target.
fn cut_window(anchor: AccessibilityNode, ref_able: AccessibilityNode) -> AccessibilityNode {
    let mut hidden = node("group", "Hidden");
    hidden.children = vec![ref_able];
    let mut anchor = anchor;
    anchor.children_count = Some(1);
    anchor.children = Vec::new();
    let mut root = node("window", "Fixture");
    root.children = vec![anchor, hidden];
    root
}

#[test]
fn a_cut_capture_of_tokenless_refs_needs_the_whole_window() {
    let observed = observed(cut_window(node("group", "Sidebar"), node("button", "Save")));

    assert!(needs_whole_window(&observed));
}

#[test]
fn a_cut_capture_whose_refs_carry_tokens_needs_no_second_walk() {
    let observed = observed(cut_window(
        tokened("group", "Sidebar", "sidebar"),
        tokened("button", "Save", "save"),
    ));

    assert!(!needs_whole_window(&observed));
}

/// A cut boundary with nothing a later resolve could re-identify it by is not a
/// drill target, so it is not an entry the census would prove: the capture keeps
/// its single walk even though that boundary omits descendants.
#[test]
fn a_cut_boundary_that_cannot_anchor_a_drill_needs_no_second_walk() {
    let observed = observed(cut_window(
        node("group", ""),
        tokened("button", "Save", "save"),
    ));

    assert!(!needs_whole_window(&observed));
}

#[test]
fn a_capture_that_reached_the_whole_window_needs_no_second_walk() {
    let mut save = node("button", "Save");
    save.children = vec![node("group", "Icon")];
    let mut root = node("window", "Fixture");
    root.children = vec![save];

    assert!(!needs_whole_window(&observed(root)));
}
