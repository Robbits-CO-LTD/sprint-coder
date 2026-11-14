// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use std::sync::atomic::Ordering;

use super::tokenless_capture_support::*;
use crate::locator::live_locator::ObservationRequest;
use crate::refs::refs_test_support::HomeGuard;
use crate::{AccessibilityNode, AdapterError, Deadline, ErrorCode, RefMap};

fn entries(refmap: &RefMap) -> Vec<&crate::RefEntry> {
    (1..=64)
        .filter_map(|index| refmap.get(&format!("@e{index}")))
        .collect()
}

fn cut_short(
    _request: &ObservationRequest,
    mut tree: AccessibilityNode,
) -> Result<AccessibilityNode, AdapterError> {
    let mut unread = node("scrollarea", "Unread");
    unread.children_count = Some(3);
    unread.subtree_truncated = true;
    tree.children.push(unread);
    Ok(tree)
}

fn faulted(
    _request: &ObservationRequest,
    _tree: AccessibilityNode,
) -> Result<AccessibilityNode, AdapterError> {
    Err(AdapterError::new(
        ErrorCode::ActionFailed,
        "a node below the shallow depth faulted",
    ))
}

fn needs_forced_renderer(
    request: &ObservationRequest,
    tree: AccessibilityNode,
) -> Result<AccessibilityNode, AdapterError> {
    if request.observation_mode.force_renderer_accessibility {
        return Ok(tree);
    }
    Err(AdapterError::new(
        ErrorCode::ActionFailed,
        "the renderer tree is thin until accessibility is forced",
    ))
}

#[test]
fn a_whole_window_read_cut_short_keeps_the_complete_shallow_tree() {
    let _guard = HomeGuard::new();
    let adapter = CaptureAdapter::new(anchored_window());
    adapter.fault_whole_read(cut_short);

    let captured = snapshot(&adapter);
    // The whole read, the read of the visible elements a cut-short read may
    // fall back to (this adapter cannot read that way, so it proves nothing),
    // and the shallow walk.
    assert_eq!(adapter.captures(), 3);
    assert!(!captured.visible_scope);
    assert!(captured.complete, "the shallow walk finished");
    assert_eq!(
        captured.identity_unproven.as_deref(),
        Some("the whole-window read was cut short")
    );
    let tree = serde_json::to_string(&captured.tree).expect("the tree serializes");
    assert!(
        !tree.contains("Unread"),
        "the cut-short read is not presented"
    );
    assert!(
        entries(&captured.refmap).is_empty(),
        "a read that was cut short proves nothing, so no anchor is handed out"
    );
}

#[test]
fn a_failed_whole_window_read_keeps_the_shallow_tree() {
    let _guard = HomeGuard::new();
    let adapter = CaptureAdapter::new(anchored_window());
    adapter.fault_whole_read(faulted);

    let captured = snapshot(&adapter);
    assert!(captured.complete, "the shallow walk finished");
    assert_eq!(
        captured.identity_unproven.as_deref(),
        Some("a node below the shallow depth faulted")
    );
    assert!(entries(&captured.refmap).is_empty());
}

#[test]
fn the_whole_window_read_carries_the_forced_renderer_hint() {
    let _guard = HomeGuard::new();
    let adapter = CaptureAdapter::new(anchored_window());
    adapter.fault_whole_read(needs_forced_renderer);
    let forced = crate::adapter::TreeOptions {
        force_renderer_accessibility: true,
        ..skeleton_opts()
    };

    let captured = crate::snapshot::build(
        &adapter,
        &forced,
        Some("Fixture"),
        None,
        Deadline::standard().expect("a standard deadline"),
    )
    .expect("the window snapshots");
    assert!(captured.identity_unproven.is_none());
    let (anchor_ref, anchor) = named(&captured.refmap, "Sidebar");
    assert!(
        anchor.identity.unique_at_capture,
        "the forced read is adopted and proves the anchor"
    );
    assert!(anchor.source.renderer_accessibility_forced);
    resolve(&adapter, anchor).expect("resolution reads the window the way the capture did");

    let snapshot_id = save(&captured.refmap);
    let drilled = crate::snapshot::snapshot_ref::run_from_ref(
        &adapter,
        &drill_opts(),
        &anchor_ref,
        Some(&snapshot_id),
    )
    .expect("a drill reads the window the way the capture did");
    let (_, button) = named(&drilled.refmap, "Save");
    assert!(button.source.renderer_accessibility_forced);
    resolve(&adapter, button).expect("a drilled ref reads the window the way the capture did");
}

#[test]
fn an_incomplete_window_offers_no_drill_anchor() {
    let _guard = HomeGuard::new();
    let mut hidden = node("scrollarea", "Feed");
    hidden.children_count = Some(3);
    hidden.subtree_truncated = true;
    let mut sidebar = node("group", "Sidebar");
    sidebar.children = vec![group(vec![node("button", "Save")])];
    let adapter = CaptureAdapter::new(window(vec![group(vec![group(vec![sidebar, hidden])])]));

    let captured = snapshot(&adapter);
    assert!(!captured.complete, "the window was not read whole");
    assert_eq!(
        captured.refmap.len(),
        0,
        "an unread region proves nothing, so no anchor is handed out"
    );
}

#[test]
fn a_shallow_capture_of_tokened_refs_takes_one_walk() {
    let _guard = HomeGuard::new();
    let mut run = node("button", "Run");
    run.identity.retained_object = Some(TOKEN.into());
    let mut deep = node("group", "");
    deep.identity.retained_object = Some("axtok1:deep".into());
    deep.children = vec![node("button", "Deep")];
    let adapter = CaptureAdapter::new(window(vec![run, group(vec![group(vec![deep])])]));

    let captured = snapshot(&adapter);
    assert_eq!(
        adapter.captures(),
        1,
        "a ref that re-identifies itself by token needs no second walk"
    );
    let (_, ref_entry) = named(&captured.refmap, "Run");
    assert_eq!(ref_entry.identity.retained_object.as_deref(), Some(TOKEN));

    resolve(&adapter, ref_entry).expect("a token resolves through the adapter");
    assert_eq!(adapter.strict.load(Ordering::SeqCst), 1);
    assert!(adapter.anchored().is_empty());
}

#[test]
fn a_deep_capture_cut_short_is_flagged_as_unproven() {
    let _guard = HomeGuard::new();
    let mut unread = node("scrollarea", "Feed");
    unread.children_count = Some(3);
    unread.subtree_truncated = true;
    let adapter = CaptureAdapter::new(window(vec![node("button", "Run"), unread]));
    let deep = crate::adapter::TreeOptions {
        max_depth: crate::refs::resolve_saved_ref::WHOLE_WINDOW_DEPTH,
        ..Default::default()
    };

    let captured = crate::snapshot::build(
        &adapter,
        &deep,
        Some("Fixture"),
        None,
        Deadline::standard().expect("a standard deadline"),
    )
    .expect("the window snapshots");

    assert_eq!(
        adapter.captures(),
        1,
        "a deep capture is its own whole read"
    );
    assert_eq!(
        captured.identity_unproven.as_deref(),
        Some("the window read was cut short")
    );
}

#[test]
fn a_cut_short_read_of_a_window_with_a_view_presents_the_visible_elements() {
    let _guard = HomeGuard::new();
    let adapter = CaptureAdapter::new(anchored_window());
    adapter.fault_whole_read(cut_short);
    adapter.serve_view();

    let captured = snapshot(&adapter);
    assert!(captured.visible_scope);
    assert!(!captured.complete, "a view is never the whole window");
    assert!(captured.identity_unproven.is_none());
    assert!(
        entries(&captured.refmap)
            .iter()
            .all(|entry| !entry.identity.unique_at_capture && entry.identity.ancestors.is_empty())
    );
}

static WHOLE_READ_GIVEN_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn cut_short_noting_budget(
    request: &ObservationRequest,
    tree: AccessibilityNode,
) -> Result<AccessibilityNode, AdapterError> {
    let given = u64::try_from(request.deadline.remaining().as_millis()).unwrap_or(u64::MAX);
    WHOLE_READ_GIVEN_MS.store(given, Ordering::SeqCst);
    cut_short(request, tree)
}

/// A long `--timeout-ms` does not stretch the whole read before the switch to
/// the visible elements: under 20 s it is given the cap, not 15 s, and the
/// switch and its proof are the ones a default snapshot makes.
#[test]
fn a_long_deadline_gives_the_whole_read_no_more_than_the_cap() {
    let _guard = HomeGuard::new();
    let adapter = CaptureAdapter::new(anchored_window());
    adapter.fault_whole_read(cut_short_noting_budget);
    adapter.serve_view();

    let captured = snapshot_within(&adapter, 20_000);
    let given = WHOLE_READ_GIVEN_MS.load(Ordering::SeqCst);
    assert!(given > 0, "the whole read ran");
    assert!(
        u128::from(given) <= super::window_capture::WHOLE_READ_CAP.as_millis(),
        "the whole read was given {given} ms"
    );
    assert!(captured.visible_scope);
    assert!(captured.identity_unproven.is_none());
    assert!(
        entries(&captured.refmap)
            .iter()
            .all(|entry| !entry.identity.unique_at_capture && entry.identity.ancestors.is_empty())
    );
}

static FLOOR_READ_GIVEN_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn cut_short_noting_floor(
    request: &ObservationRequest,
    tree: AccessibilityNode,
) -> Result<AccessibilityNode, AdapterError> {
    let given = u64::try_from(request.deadline.remaining().as_millis()).unwrap_or(u64::MAX);
    FLOOR_READ_GIVEN_MS.store(given, Ordering::SeqCst);
    cut_short(request, tree)
}

/// A default snapshot that starts its whole read with 2.5 s left leaves the
/// read of the visible elements at least the floor when the window has one,
/// and keeps three quarters for the whole read of a window that has none. The
/// time the window takes to say whether it has one comes out of the whole
/// read, never out of the floor.
#[test]
fn a_window_with_a_view_leaves_its_visible_read_the_floor() {
    let _guard = HomeGuard::new();
    let given = |view: bool, check_ms: u64| {
        let adapter = CaptureAdapter::new(anchored_window());
        adapter.fault_whole_read(cut_short_noting_floor);
        if view {
            adapter.serve_view();
        }
        adapter.slow_view_check(check_ms);
        let started = std::time::Instant::now()
            .checked_sub(std::time::Duration::from_millis(500))
            .expect("the clock is past its first seconds");
        let deadline = Deadline::at(started, crate::snapshot::DEFAULT_SNAPSHOT_TIMEOUT_MS)
            .expect("a deadline");
        let captured =
            crate::snapshot::build(&adapter, &skeleton_opts(), Some("Fixture"), None, deadline)
                .expect("the window snapshots");
        assert_eq!(captured.visible_scope, view);
        FLOOR_READ_GIVEN_MS.load(Ordering::SeqCst)
    };
    let given_for = |view: bool| given(view, 0);
    let floor = u64::try_from(super::window_capture::ANSWER_READ_FLOOR.as_millis()).unwrap();
    // The window takes 400 ms to say it has a view, so 2.1 s are left when the
    // whole read starts: it gets what is left less the floor, not what was
    // left before the check (which would leave the visible read 350 ms).
    let after_slow_check = given(true, 400);
    assert!(
        after_slow_check <= 2_100 - floor,
        "the whole read was given {after_slow_check} ms"
    );
    assert!(
        after_slow_check >= 2_100 - floor - 100,
        "the whole read was given {after_slow_check} ms"
    );
    let with_view = given_for(true);
    assert!(
        with_view <= 2_500 - floor,
        "the whole read was given {with_view} ms"
    );
    assert!(
        with_view >= 2_500 - floor - 100,
        "the whole read was given {with_view} ms"
    );
    let without = given_for(false);
    assert!(
        without > 2_500 - floor,
        "the whole read was given {without} ms"
    );
    assert!(
        without <= 2_500 * 3 / 4,
        "the whole read was given {without} ms"
    );
}

#[test]
fn a_deadline_shorter_than_the_default_never_falls_back_to_the_view() {
    let _guard = HomeGuard::new();
    let adapter = CaptureAdapter::new(anchored_window());
    adapter.fault_whole_read(cut_short);
    adapter.serve_view();

    let captured = snapshot_within(&adapter, crate::snapshot::DEFAULT_SNAPSHOT_TIMEOUT_MS - 1);
    assert!(!captured.visible_scope);
    assert_eq!(
        captured.identity_unproven.as_deref(),
        Some("the whole-window read was cut short")
    );
    // The whole read and the shallow walk; no read of the view.
    assert_eq!(adapter.captures(), 2);
}

/// A wait polls under one long deadline. Late in it, the whole-window read
/// gets a fraction of the time a default snapshot gives it, so a cut there
/// does not show that the window cannot be read whole: no fallback.
#[test]
fn a_long_deadline_with_little_left_never_falls_back_to_the_view() {
    let _guard = HomeGuard::new();
    let adapter = CaptureAdapter::new(anchored_window());
    adapter.fault_whole_read(cut_short);
    adapter.serve_view();

    let started = std::time::Instant::now()
        .checked_sub(std::time::Duration::from_millis(8_500))
        .expect("the clock is past its first seconds");
    let deadline = Deadline::at(started, 10_000).expect("a deadline");
    let captured =
        crate::snapshot::build(&adapter, &skeleton_opts(), Some("Fixture"), None, deadline)
            .expect("the window snapshots");
    assert!(!captured.visible_scope);
    assert_eq!(
        captured.identity_unproven.as_deref(),
        Some("the whole-window read was cut short")
    );
    assert_eq!(adapter.captures(), 2);
}

#[test]
fn a_whole_window_that_reads_in_time_keeps_the_whole_window_proof() {
    let _guard = HomeGuard::new();
    let adapter = CaptureAdapter::new(anchored_window());
    adapter.serve_view();

    let captured = snapshot(&adapter);
    assert!(!captured.visible_scope);
    assert_eq!(adapter.captures(), 1);
    assert!(
        entries(&captured.refmap)
            .iter()
            .all(|entry| entry.identity.in_view.is_none())
    );
}
