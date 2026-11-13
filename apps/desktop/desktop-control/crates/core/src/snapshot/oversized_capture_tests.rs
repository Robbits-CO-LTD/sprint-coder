// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! A window read whole whose record of refs is too large to keep.
use super::tokenless_capture_support::*;
use crate::refs::refs_test_support::HomeGuard;
use crate::{AccessibilityNode, Deadline, RefMap, refs::refs_store::RefStore};

/// A window of `rows` buttons, each with a name long enough that a few
/// thousand of them pass the 1 MB the record of refs may take.
fn rows_window(rows: usize) -> AccessibilityNode {
    let pad = "x".repeat(200);
    window(
        (0..rows)
            .map(|row| node("button", &format!("Row {row} {pad}")))
            .collect(),
    )
}

fn capture(adapter: &CaptureAdapter) -> crate::snapshot::SnapshotResult {
    crate::snapshot::build(
        adapter,
        &drill_opts(),
        Some("Fixture"),
        None,
        Deadline::standard().expect("a standard deadline"),
    )
    .expect("the window snapshots")
}

fn entries(refmap: &RefMap) -> Vec<&crate::RefEntry> {
    (1..=refmap.len())
        .filter_map(|index| refmap.get(&format!("@e{index}")))
        .collect()
}

#[test]
fn the_fixture_window_is_too_large_to_record_whole() {
    let _guard = HomeGuard::new();
    let adapter = CaptureAdapter::new(rows_window(6_000));
    let captured = capture(&adapter);
    assert!(captured.refmap.exceeds_size_limit());
}

#[test]
fn a_whole_window_too_large_to_record_presents_the_visible_elements() {
    let _guard = HomeGuard::new();
    let adapter = CaptureAdapter::new(rows_window(6_000));
    adapter.serve_view_of(rows_window(30));

    let captured = capture(&adapter);
    // The whole read, then the read of the visible elements.
    assert_eq!(adapter.captures(), 2);
    assert!(captured.visible_scope);
    assert!(!captured.complete, "a view is never the whole window");
    assert!(captured.identity_unproven.is_none());
    assert!(!captured.refmap.exceeds_size_limit());
    let entries = entries(&captured.refmap);
    assert_eq!(entries.len(), 30, "the 30 visible rows");
    assert!(
        entries.iter().all(|entry| !entry.identity.unique_at_capture
            && entry.identity.ancestors.is_empty()
            && entry.identity.in_view.is_some()),
        "the refs carry the proof of a view, not of the whole window"
    );
    RefStore::new()
        .expect("the snapshot store opens")
        .save_new_snapshot(&captured.refmap)
        .expect("the view's record saves");
}

#[test]
fn a_whole_window_too_large_to_record_is_kept_when_no_view_is_read() {
    let _guard = HomeGuard::new();
    let adapter = CaptureAdapter::new(rows_window(6_000));

    let captured = capture(&adapter);
    // The whole read, then the read of the visible elements this window
    // refuses.
    assert_eq!(adapter.captures(), 2);
    assert!(!captured.visible_scope);
    assert!(captured.refmap.exceeds_size_limit());
    let error = RefStore::new()
        .expect("the snapshot store opens")
        .save_new_snapshot(&captured.refmap)
        .expect_err("the record is refused as before");
    assert_eq!(error.code(), "INTERNAL");
}

#[test]
fn a_view_too_large_to_record_keeps_the_whole_capture() {
    let _guard = HomeGuard::new();
    let adapter = CaptureAdapter::new(rows_window(6_000));
    adapter.serve_view_of(rows_window(6_000));

    let captured = capture(&adapter);
    assert_eq!(adapter.captures(), 2);
    assert!(!captured.visible_scope);
    assert!(captured.refmap.exceeds_size_limit());
}

#[test]
fn a_whole_window_that_records_in_size_reads_no_view() {
    let _guard = HomeGuard::new();
    let adapter = CaptureAdapter::new(rows_window(100));
    adapter.serve_view_of(rows_window(30));

    let captured = capture(&adapter);
    assert_eq!(adapter.captures(), 1);
    assert!(!captured.visible_scope);
    assert_eq!(captured.refmap.len(), 100);
}
