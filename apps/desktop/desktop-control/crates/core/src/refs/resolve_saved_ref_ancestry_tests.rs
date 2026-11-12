// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! Elements whose own predicate is the same are told apart by their recorded
//! ancestors (`ref_ancestry`): the recorded one resolves, and every case where
//! the ancestors no longer single it out is refused as before.

use std::sync::atomic::Ordering;

use super::test_support::{RuleAdapter, capture_all, node, resolve, tree_with};
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

    assert!(entry.identity.unique_at_capture);
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
        assert!(entry.identity.unique_at_capture);
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

#[test]
fn a_refmap_written_before_ancestors_reads_with_none_and_round_trips() {
    let entry = dialog_close(dialog_and_title_bar("Settings"));
    let mut old = serde_json::to_value(&entry).unwrap();
    old.as_object_mut().unwrap().remove("ancestors");
    let read: RefEntry = serde_json::from_value(old).unwrap();
    assert!(read.identity.ancestors.is_empty());

    let plain = crate::adapter::minimal_ref_entry("button", Some("Run"));
    let written = serde_json::to_value(&plain).unwrap();
    assert!(
        written.get("ancestors").is_none(),
        "an entry without ancestors writes no key"
    );

    let written = serde_json::to_value(&entry).unwrap();
    let again: RefEntry = serde_json::from_value(written).unwrap();
    assert_eq!(again, entry);
}
