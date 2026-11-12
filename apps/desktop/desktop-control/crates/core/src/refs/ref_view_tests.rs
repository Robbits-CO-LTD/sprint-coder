// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! Refs proven among the visible elements: what a capture records, and how a
//! resolution reading the same view again holds the entry to its path, its
//! runtime identifier and its bounds, without ever falling back to the
//! whole-window rule.

use std::sync::{
    Mutex,
    atomic::{AtomicBool, AtomicI32, AtomicU32, Ordering},
};

use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::locator::live_locator::{ObservationRequest, ObservationRoot, ObservedTree};
use crate::refs::ref_alloc::allocate_refs;
use crate::refs::ref_alloc_config::RefAllocConfig;
use crate::refs::ref_alloc_options::RefAllocOptions;
use crate::refs::ref_alloc_scope::RefAllocScope;
use crate::refs::ref_alloc_source::RefAllocSource;
use crate::refs::ref_ancestry::{Proof, proof_of};
use crate::{
    AccessibilityNode, AdapterError, Deadline, ErrorCode, NativeHandle, Rect, RefEntry, RefMap,
    WindowInfo,
};

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

fn node(role: &str, name: &str, y: f64) -> AccessibilityNode {
    let mut node = crate::adapter::minimal_accessibility_node(role, name);
    node.presentation.bounds = Some(Rect {
        x: 10.0,
        y,
        width: 50.0,
        height: 20.0,
    });
    node
}

/// A row group named `row` (or unnamed when empty) holding one "Open" button.
fn row(name: &str, y: f64) -> AccessibilityNode {
    let mut group = node("group", name, y);
    group.children = vec![node("button", "Open", y)];
    group
}

fn list(rows: Vec<AccessibilityNode>) -> AccessibilityNode {
    let mut root = node("group", "Window", 0.0);
    root.children = rows;
    root
}

/// Gives every observed node a runtime identifier made of the generation and
/// its place, so a later generation stands for other elements in the same
/// places.
fn with_runtime_ids(mut observed: ObservedTree, generation: i32) -> ObservedTree {
    for (index, node) in observed.nodes.iter_mut().enumerate() {
        let index = i32::try_from(index).unwrap();
        node.evidence.ref_evidence.runtime_id = Some(vec![42, generation, index]);
    }
    observed
}

fn view_of(tree: AccessibilityNode, generation: i32) -> ObservedTree {
    let observed =
        crate::adapter::observed_tree(&ObservationRoot::Window(&window()), tree).unwrap();
    let mut observed = with_runtime_ids(observed, generation);
    observed.mark_visible_scope();
    observed
}

fn base_config() -> RefAllocConfig<'static> {
    RefAllocConfig {
        options: RefAllocOptions {
            include_bounds: false,
            interactive_only: false,
            compact: false,
            force_renderer_accessibility: false,
        },
        source: RefAllocSource {
            pid: crate::ProcessId::new(1),
            app: Some("Fixture"),
            window_id: Some("w-1"),
            window_title: Some("Fixture"),
            window_bounds_hash: None,
            process_instance: Some("test-instance"),
            surface: crate::SnapshotSurface::Window,
        },
        scope: RefAllocScope {
            root_ref_id: None,
            path_prefix: &[],
        },
        capture: None,
    }
}

/// Every entry one capture over `observed` publishes, in allocation order.
fn capture_over(tree: AccessibilityNode, observed: &ObservedTree) -> Vec<RefEntry> {
    let proof = crate::refs::ref_capture_proof::CaptureProof::new(observed);
    let config = RefAllocConfig {
        capture: Some(&proof),
        ..base_config()
    };
    let mut refmap = RefMap::new();
    allocate_refs(tree, &mut refmap, &config).unwrap();
    (1..=refmap.len())
        .filter_map(|index| refmap.get(&format!("@e{index}")).cloned())
        .collect()
}

fn open_under(entries: &[RefEntry], row: &str) -> RefEntry {
    entries
        .iter()
        .find(|entry| {
            entry.identity.name.as_deref() == Some("Open")
                && crate::refs::ref_ancestry::recorded_ancestors(entry)
                    .first()
                    .and_then(|ancestor| ancestor.name.as_deref())
                    == Some(row)
        })
        .cloned()
        .expect("the row's button has a proven ref")
}

fn rows(names: &[&str]) -> AccessibilityNode {
    list(
        names
            .iter()
            .enumerate()
            .map(|(index, name)| row(name, 100.0 + 25.0 * index as f64))
            .collect(),
    )
}

#[test]
fn a_view_capture_records_a_view_proof_and_never_the_whole_window_proofs() {
    let tree = rows(&["Mail 0", "Mail 1", "Mail 2"]);
    let observed = view_of(tree.clone(), 1);
    let entries = capture_over(tree, &observed);
    let entry = open_under(&entries, "Mail 1");
    let view = entry.identity.in_view.as_ref().expect("a view proof");
    assert!(!entry.identity.unique_at_capture);
    assert!(entry.identity.ancestors.is_empty());
    assert_eq!(view.ancestors.len(), 1);
    assert_eq!(view.path.as_slice(), &[1, 0]);
    assert_eq!(view.runtime_id, vec![42, 1, 4]);
    assert_eq!(view.bounds.y, 125.0);
    assert_eq!(proof_of(&entry), Proof::InView);
    assert!(
        entries
            .iter()
            .all(|entry| !entry.identity.unique_at_capture)
    );
}

#[test]
fn the_same_tree_read_whole_keeps_the_whole_window_proof() {
    let tree = rows(&["Mail 0", "Mail 1"]);
    let observed =
        crate::adapter::observed_tree(&ObservationRoot::Window(&window()), tree.clone()).unwrap();
    let entries = capture_over(tree, &observed);
    let entry = entries
        .iter()
        .find(|entry| entry.identity.name.as_deref() == Some("Open"))
        .unwrap();
    assert!(entry.identity.in_view.is_none());
    assert_eq!(proof_of(entry), Proof::WithAncestors);
}

#[test]
fn rows_that_read_the_same_in_the_view_stay_unproven() {
    let tree = rows(&["", ""]);
    let observed = view_of(tree.clone(), 1);
    let entries = capture_over(tree, &observed);
    for entry in entries
        .iter()
        .filter(|entry| entry.identity.name.as_deref() == Some("Open"))
    {
        assert!(entry.identity.in_view.is_none());
        assert_eq!(proof_of(entry), Proof::None);
    }
}

#[test]
fn a_node_without_runtime_id_or_area_or_with_a_token_gets_no_view_proof() {
    let tree = rows(&["Mail 0", "Mail 1"]);
    let mut observed = view_of(tree.clone(), 1);
    for node in &mut observed.nodes {
        node.evidence.ref_evidence.runtime_id = None;
    }
    let entries = capture_over(tree.clone(), &observed);
    assert!(entries.iter().all(|entry| proof_of(entry) == Proof::None));

    let mut flat = tree.clone();
    flat.children[0].children[0].presentation.bounds = Some(Rect {
        x: 0.0,
        y: 0.0,
        width: 0.0,
        height: 0.0,
    });
    let observed = view_of(flat.clone(), 1);
    let entries = capture_over(flat, &observed);
    assert!(
        entries
            .iter()
            .filter(|entry| entry.identity.name.as_deref() == Some("Open"))
            .any(|entry| entry.identity.in_view.is_none())
    );

    let mut tokened = tree;
    tokened.children[0].children[0].identity.retained_object = Some("axtok1:token".into());
    let observed = view_of(tokened.clone(), 1);
    let entries = capture_over(tokened, &observed);
    assert!(
        entries
            .iter()
            .filter(|entry| entry.identity.retained_object.is_some())
            .all(|entry| entry.identity.in_view.is_none())
    );
}

#[test]
fn a_view_proof_next_to_another_proof_is_refused() {
    let tree = rows(&["Mail 0", "Mail 1"]);
    let observed = view_of(tree.clone(), 1);
    let entry = open_under(&capture_over(tree, &observed), "Mail 0");
    let mut both = entry.clone();
    both.identity.unique_at_capture = true;
    assert_eq!(proof_of(&both), Proof::None);
    let mut doubled = entry.clone();
    doubled.identity.ancestors = doubled.identity.in_view.clone().unwrap().ancestors;
    assert_eq!(proof_of(&doubled), Proof::None);
}

#[test]
fn an_older_reader_sees_a_view_proven_entry_as_unproven() {
    let tree = rows(&["Mail 0", "Mail 1"]);
    let observed = view_of(tree.clone(), 1);
    let entry = open_under(&capture_over(tree, &observed), "Mail 0");
    let json = serde_json::to_value(&entry).unwrap();
    assert!(json.get("proven_in_view").is_some());
    assert!(json.get("proven_with_ancestors").is_none());
    assert!(json.get("unique_at_capture").is_none());
    let back: RefEntry = serde_json::from_value(json.clone()).unwrap();
    assert_eq!(back, entry);
    // A reader that does not know the key drops it.
    let mut older = json;
    older.as_object_mut().unwrap().remove("proven_in_view");
    let older: RefEntry = serde_json::from_value(older).unwrap();
    assert_eq!(proof_of(&older), Proof::None);
}

#[test]
fn malformed_view_proofs_are_rejected_on_load() {
    let tree = rows(&["Mail 0", "Mail 1"]);
    let observed = view_of(tree.clone(), 1);
    let entry = open_under(&capture_over(tree, &observed), "Mail 0");
    assert!(crate::refs::refs_validate::validate_ref_entry(&entry).is_ok());
    let cases: [fn(&mut crate::RefViewProof); 4] = [
        |view| view.runtime_id.clear(),
        |view| view.runtime_id = vec![1; 33],
        |view| view.bounds.width = 0.0,
        |view| view.path = std::iter::repeat_n(0, 257).collect(),
    ];
    for case in cases {
        let mut bad = entry.clone();
        case(bad.identity.in_view.as_mut().unwrap());
        assert!(crate::refs::refs_validate::validate_ref_entry(&bad).is_err());
    }
    let mut bad = entry;
    bad.identity.in_view.as_mut().unwrap().ancestors = vec![Default::default(); 65];
    assert!(crate::refs::refs_validate::validate_ref_entry(&bad).is_err());
}

/// An adapter serving one tree as a view of visible elements (or, when
/// `whole` is set, as a whole window), in a generation of runtime ids.
struct ViewAdapter {
    tree: Mutex<AccessibilityNode>,
    generation: AtomicI32,
    whole: AtomicBool,
    anchored: Mutex<Option<RefEntry>>,
    view_reads: AtomicU32,
    whole_reads: AtomicU32,
    /// Bounds the landed element reports, when a test moves it after the read.
    landed_y: Mutex<Option<f64>>,
}

impl ViewAdapter {
    fn new(tree: AccessibilityNode) -> Self {
        Self {
            tree: Mutex::new(tree),
            generation: AtomicI32::new(1),
            whole: AtomicBool::new(false),
            anchored: Mutex::new(None),
            view_reads: AtomicU32::new(0),
            whole_reads: AtomicU32::new(0),
            landed_y: Mutex::new(None),
        }
    }

    fn current(&self) -> ObservedTree {
        let observed = crate::adapter::observed_tree(
            &ObservationRoot::Window(&window()),
            self.tree.lock().unwrap().clone(),
        )
        .unwrap();
        with_runtime_ids(observed, self.generation.load(Ordering::SeqCst))
    }

    fn landed_index(&self) -> Option<usize> {
        let anchored = self.anchored.lock().unwrap().clone()?;
        self.current()
            .nodes
            .iter()
            .position(|node| node.path == anchored.scope.path)
    }
}

impl ObservationOps for ViewAdapter {
    fn list_windows(
        &self,
        _filter: &crate::adapter::WindowFilter,
        _deadline: Deadline,
    ) -> Result<Vec<WindowInfo>, AdapterError> {
        Ok(vec![window()])
    }

    fn observe_tree(
        &self,
        root: ObservationRoot<'_>,
        request: &ObservationRequest,
    ) -> Result<ObservedTree, AdapterError> {
        if let ObservationRoot::Element { .. } = root {
            let current = self.current();
            let index = self
                .landed_index()
                .ok_or_else(|| AdapterError::internal("nothing landed"))?;
            let node = &current.nodes[index];
            let mut landed = crate::adapter::minimal_accessibility_node(
                node.evidence.role.known().unwrap(),
                node.evidence.name.known().map(String::as_str).unwrap_or(""),
            );
            landed.presentation.bounds = node.evidence.ref_evidence.bounds.known().copied();
            if let (Some(y), Some(bounds)) = (
                *self.landed_y.lock().unwrap(),
                landed.presentation.bounds.as_mut(),
            ) {
                bounds.y = y;
            }
            return crate::adapter::observed_tree(&root, landed);
        }
        let mut observed = self.current();
        if request.observation_mode.visible_only && !self.whole.load(Ordering::SeqCst) {
            self.view_reads.fetch_add(1, Ordering::SeqCst);
            observed.mark_visible_scope();
        } else {
            self.whole_reads.fetch_add(1, Ordering::SeqCst);
        }
        Ok(observed)
    }

    fn resolve_locator_anchor(
        &self,
        entry: &RefEntry,
        _deadline: Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        *self.anchored.lock().unwrap() = Some(entry.clone());
        Ok(NativeHandle::new("anchor"))
    }

    fn read_ancestor_evidence(
        &self,
        _entry: &RefEntry,
        _handle: &NativeHandle,
        count: usize,
        _deadline: Deadline,
    ) -> Result<Vec<crate::LocatorEvidence>, AdapterError> {
        let observed = self.current();
        let parents = crate::refs::ref_ancestry::parents(&observed);
        let Some(mut index) = self.landed_index() else {
            return Ok(Vec::new());
        };
        let mut ancestors = Vec::new();
        while ancestors.len() < count {
            match parents[index] {
                Some(parent) if parents[parent].is_some() => {
                    ancestors.push(observed.nodes[parent].evidence.clone());
                    index = parent;
                }
                _ => break,
            }
        }
        Ok(ancestors)
    }
}

impl ActionOps for ViewAdapter {}
impl InputOps for ViewAdapter {}
impl SystemOps for ViewAdapter {
    fn supported_surfaces(&self) -> Vec<crate::SnapshotSurface> {
        vec![crate::SnapshotSurface::Window]
    }
}

fn captured(adapter: &ViewAdapter, row: &str) -> RefEntry {
    let tree = adapter.tree.lock().unwrap().clone();
    let mut observed = adapter.current();
    observed.mark_visible_scope();
    let mut entry = open_under(&capture_over(tree, &observed), row);
    entry.source.source_app = Some("Fixture".into());
    entry
}

fn resolve(adapter: &ViewAdapter, entry: &RefEntry) -> Result<NativeHandle, AdapterError> {
    crate::refs::resolve_saved_ref::resolve_saved_ref(
        adapter,
        entry,
        Deadline::standard().unwrap(),
        None,
    )
}

fn refused(adapter: &ViewAdapter, entry: &RefEntry) -> AdapterError {
    match resolve(adapter, entry) {
        Ok(_) => panic!("the entry resolved"),
        Err(error) => error,
    }
}

fn kind(error: &AdapterError) -> Option<&str> {
    error
        .details
        .as_ref()
        .and_then(|details| details.get("kind"))
        .and_then(serde_json::Value::as_str)
}

#[test]
fn an_unchanged_view_resolves_the_recorded_element_through_a_view_read() {
    let adapter = ViewAdapter::new(rows(&["Mail 0", "Mail 1", "Mail 2"]));
    let entry = captured(&adapter, "Mail 1");
    resolve(&adapter, &entry).expect("the recorded element resolves");
    assert_eq!(adapter.view_reads.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.whole_reads.load(Ordering::SeqCst), 0);
    let anchored = adapter.anchored.lock().unwrap().clone().unwrap();
    assert_eq!(anchored.scope.path.as_slice(), &[1, 0]);
    assert!(anchored.identity.in_view.is_some());
}

#[test]
fn a_view_proof_is_never_judged_by_a_whole_window_read() {
    let adapter = ViewAdapter::new(rows(&["Mail 0", "Mail 1"]));
    let entry = captured(&adapter, "Mail 1");
    adapter.whole.store(true, Ordering::SeqCst);
    let error = refused(&adapter, &entry);
    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
    assert!(adapter.anchored.lock().unwrap().is_none());
}

#[test]
fn a_scrolled_view_stops_the_ref() {
    let adapter = ViewAdapter::new(rows(&["Mail 0", "Mail 1", "Mail 2"]));
    let entry = captured(&adapter, "Mail 1");
    // Scrolled by one row: the same rows sit 25 pixels higher.
    let mut scrolled = rows(&["Mail 0", "Mail 1", "Mail 2"]);
    for (index, row) in scrolled.children.iter_mut().enumerate() {
        let y = 75.0 + 25.0 * index as f64;
        row.presentation.bounds.as_mut().unwrap().y = y;
        row.children[0].presentation.bounds.as_mut().unwrap().y = y;
    }
    *adapter.tree.lock().unwrap() = scrolled;
    let error = refused(&adapter, &entry);
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(kind(&error), Some("saved_ref_view_changed"));
}

#[test]
fn a_row_scrolled_out_of_the_view_is_absent() {
    let adapter = ViewAdapter::new(rows(&["Mail 0", "Mail 1", "Mail 2"]));
    let entry = captured(&adapter, "Mail 0");
    *adapter.tree.lock().unwrap() = rows(&["Mail 1", "Mail 2", "Mail 3"]);
    let error = refused(&adapter, &entry);
    assert_eq!(error.code, ErrorCode::StaleRef);
}

#[test]
fn another_element_reading_the_same_in_the_recorded_place_is_not_taken() {
    // The same names in the same places with the same bounds, but other
    // elements: what a twin scrolled into the recorded slot looks like.
    let adapter = ViewAdapter::new(rows(&["Mail 0", "Mail 3", "Mail 2"]));
    let entry = captured(&adapter, "Mail 3");
    adapter.generation.store(2, Ordering::SeqCst);
    let error = refused(&adapter, &entry);
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(kind(&error), Some("saved_ref_view_changed"));
    assert!(adapter.anchored.lock().unwrap().is_none());
}

#[test]
fn a_row_inserted_above_moves_the_path_and_stops_the_ref() {
    let adapter = ViewAdapter::new(rows(&["Mail 0", "Mail 1"]));
    let entry = captured(&adapter, "Mail 1");
    let mut moved = rows(&["New", "Mail 0", "Mail 1"]);
    // Keep the recorded element's bounds where they were, so only the path
    // tells the change.
    moved.children[2].children[0].presentation.bounds =
        Some(entry.identity.in_view.clone().unwrap().bounds);
    *adapter.tree.lock().unwrap() = moved;
    let error = refused(&adapter, &entry);
    assert_eq!(error.code, ErrorCode::StaleRef);
}

#[test]
fn a_twin_appearing_in_the_view_is_ambiguous() {
    let adapter = ViewAdapter::new(rows(&["Mail 0", "Mail 1"]));
    let entry = captured(&adapter, "Mail 1");
    *adapter.tree.lock().unwrap() = rows(&["Mail 0", "Mail 1", "Mail 1"]);
    let error = refused(&adapter, &entry);
    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
}

#[test]
fn a_landed_element_that_moved_after_the_read_is_refused() {
    let adapter = ViewAdapter::new(rows(&["Mail 0", "Mail 1"]));
    let entry = captured(&adapter, "Mail 1");
    *adapter.landed_y.lock().unwrap() = Some(500.0);
    let error = refused(&adapter, &entry);
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(kind(&error), Some("saved_ref_view_changed"));
}

#[test]
fn landing_a_view_proven_entry_takes_the_full_view_resolution() {
    let adapter = ViewAdapter::new(rows(&["Mail 0", "Mail 1"]));
    let entry = captured(&adapter, "Mail 1");
    crate::refs::resolve_saved_ref::land_saved_ref(&adapter, &entry, Deadline::standard().unwrap())
        .expect("lands");
    assert_eq!(adapter.view_reads.load(Ordering::SeqCst), 1);
}

#[test]
fn a_view_proof_with_an_element_token_is_refused() {
    let adapter = ViewAdapter::new(rows(&["Mail 0", "Mail 1"]));
    let mut entry = captured(&adapter, "Mail 1");
    entry.identity.retained_object = Some("axtok1:token".into());
    let error = refused(&adapter, &entry);
    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
}

#[test]
fn live_bounds_must_equal_the_recorded_ones() {
    let adapter = ViewAdapter::new(rows(&["Mail 0", "Mail 1"]));
    let entry = captured(&adapter, "Mail 1");
    let recorded = entry.identity.in_view.clone().unwrap().bounds;
    assert!(super::confirm_live_bounds(&entry, Some(recorded)).is_ok());
    let moved = Rect {
        x: recorded.x + 1.0,
        ..recorded
    };
    let error = super::confirm_live_bounds(&entry, Some(moved)).unwrap_err();
    assert_eq!(kind(&error), Some("saved_ref_view_changed"));
    assert!(super::confirm_live_bounds(&entry, None).is_err());
    let mut plain = entry;
    plain.identity.in_view = None;
    assert!(super::confirm_live_bounds(&plain, None).is_ok());
}

/// A find rooted at a view-proven entry would count the visible elements only
/// and report that as the whole subtree, so it is refused with its own error.
#[test]
fn a_find_rooted_at_a_view_proven_entry_is_refused() {
    use crate::commands::find::{FindArgs, FindFilterArgs, FindSelectionArgs, execute};
    let _guard = crate::refs::refs_test_support::HomeGuard::new();
    let adapter = ViewAdapter::new(rows(&["Mail 0", "Mail 1"]));
    let entry = captured(&adapter, "Mail 1");
    let mut stored = RefMap::new();
    stored.allocate(entry);
    let snapshot = crate::refs::refs_store::RefStore::new()
        .unwrap()
        .save_new_snapshot(&stored)
        .unwrap();
    let args = FindArgs {
        app: None,
        window_id: None,
        root: Some(format!("@{snapshot}:e1")),
        surface: crate::SnapshotSurface::Window,
        filter: FindFilterArgs {
            role: Some("button".into()),
            name: None,
            description: None,
            native_id: None,
            value: None,
            text: None,
            exact: false,
        },
        states: Vec::new(),
        timeout_ms: None,
        selection: FindSelectionArgs {
            count: true,
            first: false,
            last: false,
            nth: None,
            limit: None,
        },
    };
    let error = execute(args, &adapter, &crate::CommandContext::default())
        .expect_err("a rooted find over a view is refused");
    assert!(
        format!("{error:?}").contains("rooted_find_in_view_unsupported"),
        "{error:?}"
    );
    assert_eq!(adapter.whole_reads.load(Ordering::SeqCst), 0);
}
