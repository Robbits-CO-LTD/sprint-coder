// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! Elements whose own predicate is the same are told apart by their recorded
//! ancestors (`ref_ancestry`): the recorded one resolves, and every case where
//! the ancestors no longer single it out is refused as before.

use std::sync::atomic::Ordering;

use super::test_support::{RuleAdapter, capture_all, node, resolve, tree_with};
use crate::refs::ref_ancestry::{Proof, proof_of};
use crate::{
    AccessibilityNode, ElementIdentifier, ErrorCode, IdentifierKind, RefEntry,
    refs::refs_test_support::HomeGuard,
};

fn with_id(mut node: AccessibilityNode, id: &str) -> AccessibilityNode {
    node.identity.native_id = Some(ElementIdentifier {
        kind: IdentifierKind::AutomationId,
        value: id.into(),
    });
    node
}

fn parent(role: &str, name: &str, children: Vec<AccessibilityNode>) -> AccessibilityNode {
    let mut parent = node(role, name);
    parent.children = children;
    parent
}

/// The shape measured on a WebView2 app: a dialog's "Close" button carries no
/// identifier, and the title bar's "Close" carries `Close`, so the dialog's
/// predicate (role and name) matches both.
fn dialog_and_title_bar(dialog_name: &str) -> AccessibilityNode {
    tree_with(vec![
        parent(
            "document",
            "App",
            vec![parent("window", dialog_name, vec![node("button", "Close")])],
        ),
        with_id(
            parent("group", "", vec![with_id(node("button", "Close"), "Close")]),
            "TitleBar",
        ),
    ])
}

fn close_buttons(root: AccessibilityNode) -> Vec<RefEntry> {
    capture_all(root)
        .into_iter()
        .filter(|entry| entry.identity.name.as_deref() == Some("Close"))
        .collect()
}

fn dialog_close(root: AccessibilityNode) -> RefEntry {
    close_buttons(root)
        .into_iter()
        .find(|entry| entry.identity.native_id.is_none())
        .expect("the dialog's Close has a ref")
}

fn anchored_path(adapter: &RuleAdapter) -> Vec<usize> {
    adapter
        .anchored
        .lock()
        .unwrap()
        .clone()
        .expect("anchor entry")
        .scope
        .path
        .as_slice()
        .to_vec()
}

#[test]
fn a_close_button_its_title_bar_twin_also_matches_is_proven_by_its_dialog() {
    let entry = dialog_close(dialog_and_title_bar("Settings"));

    assert!(
        !entry.identity.unique_at_capture,
        "stored unproven for an older reader"
    );
    assert_eq!(proof_of(&entry), Proof::WithAncestors);
    assert_eq!(entry.identity.ancestors.len(), 1);
    assert_eq!(entry.identity.ancestors[0].role, "window");
    assert_eq!(
        entry.identity.ancestors[0].name.as_deref(),
        Some("Settings")
    );
}

#[test]
fn an_entry_its_own_predicate_proves_records_no_ancestors() {
    let title_bar = close_buttons(dialog_and_title_bar("Settings"))
        .into_iter()
        .find(|entry| entry.identity.native_id.is_some())
        .expect("the title bar's Close has a ref");

    assert!(title_bar.identity.unique_at_capture);
    assert!(title_bar.identity.ancestors.is_empty());
}

#[test]
fn the_recorded_close_button_resolves_to_its_own_place() {
    let _guard = HomeGuard::new();
    let entry = dialog_close(dialog_and_title_bar("Settings"));
    let adapter = RuleAdapter::new(dialog_and_title_bar("Settings"));

    let Ok(_) = resolve(&adapter, &entry) else {
        panic!("the dialog's Close is singled out by its dialog");
    };

    assert_eq!(anchored_path(&adapter), entry.scope.path.as_slice());
    assert_eq!(anchored_path(&adapter), [0, 0, 0]);
}

#[test]
fn the_title_bar_twin_is_never_taken_once_the_dialog_is_gone() {
    let _guard = HomeGuard::new();
    let entry = dialog_close(dialog_and_title_bar("Settings"));
    let adapter = RuleAdapter::new(tree_with(vec![
        parent("document", "App", vec![]),
        with_id(
            parent("group", "", vec![with_id(node("button", "Close"), "Close")]),
            "TitleBar",
        ),
    ]));

    let Err(error) = resolve(&adapter, &entry) else {
        panic!("the remaining Close is not the recorded one");
    };

    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(error.details.unwrap()["kind"], "saved_ref_absent");
    assert_eq!(adapter.anchors.load(Ordering::SeqCst), 0);
}

#[test]
fn a_renamed_ancestor_no_longer_vouches_for_the_element() {
    let _guard = HomeGuard::new();
    let entry = dialog_close(dialog_and_title_bar("Settings"));
    let adapter = RuleAdapter::new(dialog_and_title_bar("Preferences"));

    let Err(error) = resolve(&adapter, &entry) else {
        panic!("a different dialog's Close is not the recorded one");
    };

    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(adapter.anchors.load(Ordering::SeqCst), 0);
}

#[test]
fn a_second_dialog_like_the_first_makes_the_ref_ambiguous() {
    let _guard = HomeGuard::new();
    let entry = dialog_close(dialog_and_title_bar("Settings"));
    let mut live = dialog_and_title_bar("Settings");
    live.children[0]
        .children
        .push(parent("window", "Settings", vec![node("button", "Close")]));
    let adapter = RuleAdapter::new(live);

    let Err(error) = resolve(&adapter, &entry) else {
        panic!("two dialogs read the same, so neither Close can be picked");
    };

    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
    assert_eq!(error.details.unwrap()["kind"], "saved_ref_ambiguous");
    assert_eq!(adapter.anchors.load(Ordering::SeqCst), 0);
}

#[test]
fn twins_under_ancestors_that_read_the_same_stay_unproven() {
    let _guard = HomeGuard::new();
    let rows = tree_with(vec![
        parent("group", "Row", vec![node("button", "Delete")]),
        parent("group", "Row", vec![node("button", "Delete")]),
    ]);
    let entries: Vec<RefEntry> = capture_all(rows.clone())
        .into_iter()
        .filter(|entry| entry.identity.name.as_deref() == Some("Delete"))
        .collect();

    assert_eq!(entries.len(), 2);
    for entry in &entries {
        assert!(!entry.identity.unique_at_capture);
        assert!(entry.identity.ancestors.is_empty());
        let Err(error) = resolve(&RuleAdapter::new(rows.clone()), entry) else {
            panic!("an unproven twin cannot be picked");
        };
        assert_eq!(error.code, ErrorCode::AmbiguousTarget);
        assert_eq!(error.details.unwrap()["kind"], "identity_not_unique");
    }
}

#[test]
fn twin_siblings_under_one_parent_stay_unproven() {
    let entries: Vec<RefEntry> = capture_all(tree_with(vec![parent(
        "group",
        "Panel",
        vec![node("button", "Run"), node("button", "Run")],
    )]))
    .into_iter()
    .filter(|entry| entry.identity.name.as_deref() == Some("Run"))
    .collect();

    assert_eq!(entries.len(), 2);
    assert!(
        entries
            .iter()
            .all(|entry| !entry.identity.unique_at_capture)
    );
}

#[test]
fn identical_buttons_of_two_scroll_bars_each_resolve_to_their_own() {
    let _guard = HomeGuard::new();
    let bars = || {
        tree_with(vec![
            with_id(
                parent(
                    "scrollbar",
                    "Vertical",
                    vec![with_id(node("button", "Up"), "Up")],
                ),
                "VBar",
            ),
            with_id(
                parent("scrollbar", "", vec![with_id(node("button", "Up"), "Up")]),
                "204",
            ),
        ])
    };
    let entries: Vec<RefEntry> = capture_all(bars())
        .into_iter()
        .filter(|entry| entry.identity.name.as_deref() == Some("Up"))
        .collect();

    assert_eq!(entries.len(), 2);
    for (index, entry) in entries.iter().enumerate() {
        assert_eq!(proof_of(entry), Proof::WithAncestors);
        assert_eq!(entry.identity.ancestors.len(), 1);
        let adapter = RuleAdapter::new(bars());
        let Ok(_) = resolve(&adapter, entry) else {
            panic!("each Up is singled out by its own scroll bar");
        };
        assert_eq!(anchored_path(&adapter), [index, 0]);
    }
}

#[test]
fn a_twin_that_moved_into_the_recorded_place_is_not_taken() {
    let _guard = HomeGuard::new();
    let bars = tree_with(vec![
        with_id(
            parent(
                "scrollbar",
                "Vertical",
                vec![with_id(node("button", "Up"), "Up")],
            ),
            "VBar",
        ),
        with_id(
            parent("scrollbar", "", vec![with_id(node("button", "Up"), "Up")]),
            "204",
        ),
    ]);
    let vertical = capture_all(bars)
        .into_iter()
        .find(|entry| entry.identity.name.as_deref() == Some("Up"))
        .expect("the vertical bar's Up has a ref");
    // The vertical bar is gone; the other bar now sits at its place.
    let adapter = RuleAdapter::new(tree_with(vec![with_id(
        parent("scrollbar", "", vec![with_id(node("button", "Up"), "Up")]),
        "204",
    )]));

    let Err(error) = resolve(&adapter, &vertical) else {
        panic!("the other bar's Up is not the recorded one");
    };

    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(adapter.anchors.load(Ordering::SeqCst), 0);
}

/// What a reader that predates `proven_with_ancestors` keeps of an entry: the
/// fields it knows, unknown keys ignored (serde's default).
#[derive(serde::Deserialize)]
struct OlderReaderIdentity {
    role: String,
    name: Option<String>,
    #[serde(default)]
    unique_at_capture: bool,
}

#[test]
fn an_entry_proven_by_its_ancestors_reads_as_unproven_to_an_older_reader() {
    let entry = dialog_close(dialog_and_title_bar("Settings"));
    let written = serde_json::to_value(&entry).unwrap();

    assert!(written.get("unique_at_capture").is_none());
    assert!(written.get("ancestors").is_none());
    assert!(written["proven_with_ancestors"].is_array());
    let older: OlderReaderIdentity = serde_json::from_value(written.clone()).unwrap();
    assert_eq!(older.role, "button");
    assert_eq!(older.name.as_deref(), Some("Close"));
    assert!(
        !older.unique_at_capture,
        "an older reader refuses it as unproven"
    );

    let again: RefEntry = serde_json::from_value(written).unwrap();
    assert_eq!(again, entry);
    assert_eq!(proof_of(&again), Proof::WithAncestors);
}

#[test]
fn an_entry_written_before_ancestors_reads_as_before() {
    let plain = crate::adapter::minimal_ref_entry("button", Some("Run"));
    let written = serde_json::to_value(&plain).unwrap();
    assert!(written.get("proven_with_ancestors").is_none());

    let read: RefEntry = serde_json::from_value(written).unwrap();
    assert!(read.identity.ancestors.is_empty());
    assert_eq!(proof_of(&read), Proof::Own);
}

#[test]
fn an_entry_proven_both_ways_at_once_is_refused() {
    let _guard = HomeGuard::new();
    let mut entry = dialog_close(dialog_and_title_bar("Settings"));
    entry.identity.unique_at_capture = true;
    let adapter = RuleAdapter::new(dialog_and_title_bar("Settings"));

    assert_eq!(proof_of(&entry), Proof::None);
    let Err(error) = resolve(&adapter, &entry) else {
        panic!("an inconsistent record is not trusted either way");
    };
    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
    assert_eq!(error.details.unwrap()["kind"], "identity_not_unique");
    assert_eq!(adapter.anchors.load(Ordering::SeqCst), 0);
}

fn delete_rows(first: &str, second: &str) -> AccessibilityNode {
    tree_with(vec![
        parent("group", first, vec![node("button", "Delete")]),
        parent("group", second, vec![node("button", "Delete")]),
    ])
}

/// Regression: the count picks row A's Delete, then row A disappears before the
/// landing and row B's Delete moves into its path. Its own predicate still
/// matches, so only the ancestors read from the landed element itself refuse it.
#[test]
fn a_twin_that_moves_into_the_path_between_the_count_and_the_landing_is_refused() {
    let _guard = HomeGuard::new();
    let row_a = capture_all(delete_rows("A", "B"))
        .into_iter()
        .find(|entry| entry.identity.name.as_deref() == Some("Delete"))
        .expect("row A's Delete has a ref");
    assert_eq!(proof_of(&row_a), Proof::WithAncestors);
    let mut adapter = RuleAdapter::new(delete_rows("A", "B"));
    adapter.ancestor_tree = Some(tree_with(vec![parent(
        "group",
        "B",
        vec![node("button", "Delete")],
    )]));

    let Err(error) = resolve(&adapter, &row_a) else {
        panic!("row B's Delete must not be acted on as row A's");
    };

    assert_eq!(adapter.anchors.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.ancestor_reads.load(Ordering::SeqCst), 1);
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(
        error.details.unwrap()["kind"],
        "saved_ref_ancestors_changed"
    );
}

#[test]
fn the_landed_element_under_its_recorded_ancestors_passes_the_check() {
    let _guard = HomeGuard::new();
    let row_a = capture_all(delete_rows("A", "B"))
        .into_iter()
        .find(|entry| entry.identity.name.as_deref() == Some("Delete"))
        .expect("row A's Delete has a ref");
    let adapter = RuleAdapter::new(delete_rows("A", "B"));

    let Ok(handle) = resolve(&adapter, &row_a) else {
        panic!("row A's Delete is still under row A");
    };
    assert_eq!(adapter.ancestor_reads.load(Ordering::SeqCst), 1);
    assert!(
        crate::refs::ref_ancestry::confirm_handle_ancestors(
            &adapter,
            &row_a,
            &handle,
            crate::Deadline::standard().unwrap(),
        )
        .is_ok(),
        "the check before dispatch passes on the same element"
    );
}

#[test]
fn the_check_before_dispatch_refuses_a_landed_twin_and_skips_entries_without_ancestors() {
    let _guard = HomeGuard::new();
    let row_a = capture_all(delete_rows("A", "B"))
        .into_iter()
        .find(|entry| entry.identity.name.as_deref() == Some("Delete"))
        .expect("row A's Delete has a ref");
    let mut adapter = RuleAdapter::new(delete_rows("A", "B"));
    *adapter.anchored.lock().unwrap() = Some(row_a.clone());
    adapter.ancestor_tree = Some(delete_rows("B", "A"));
    let handle = crate::NativeHandle::new("anchor");
    let deadline = crate::Deadline::standard().unwrap();

    let Err(error) =
        crate::refs::ref_ancestry::confirm_handle_ancestors(&adapter, &row_a, &handle, deadline)
    else {
        panic!("the element at the path now sits under row B");
    };
    assert_eq!(error.code, ErrorCode::StaleRef);

    let plain = crate::adapter::minimal_ref_entry("button", Some("Run"));
    let reads = adapter.ancestor_reads.load(Ordering::SeqCst);
    assert!(
        crate::refs::ref_ancestry::confirm_handle_ancestors(&adapter, &plain, &handle, deadline)
            .is_ok()
    );
    assert_eq!(adapter.ancestor_reads.load(Ordering::SeqCst), reads);
}
