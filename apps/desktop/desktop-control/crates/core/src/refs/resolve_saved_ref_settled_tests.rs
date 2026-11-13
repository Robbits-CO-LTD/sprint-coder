// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::recorded_settled_thin_nodes;
use crate::{RefEntry, WindowInfo};

fn entry(pid: u32, instance: Option<&str>, settled: Option<u64>) -> RefEntry {
    RefEntry {
        process: crate::RefProcess {
            pid: crate::ProcessId::new(pid),
            process_instance: instance.map(str::to_string),
        },
        identity: crate::RefEntryIdentity {
            retained_object: None,
            role: "button".into(),
            name: Some("A-1".into()),
            value: None,
            description: None,
            native_id: None,
            unique_at_capture: true,
            ancestors: Vec::new(),
            in_view: None,
            in_menu: None,
        },
        geometry: crate::RefGeometry {
            bounds_space: None,
            bounds: None,
            bounds_hash: None,
        },
        capabilities: crate::RefCapabilities {
            states: vec![],
            available_actions: vec![],
        },
        source: crate::RefSource {
            source_app: None,
            source_window_id: Some("w-1".into()),
            source_window_title: None,
            source_window_bounds_hash: None,
            source_surface: crate::SnapshotSurface::Window,
            renderer_accessibility_forced: false,
            settled_thin_nodes: settled,
        },
        scope: crate::RefScope {
            root_ref: None,
            path_is_absolute: false,
            path: smallvec::SmallVec::new(),
        },
    }
}

fn window(pid: u32, instance: Option<&str>) -> WindowInfo {
    WindowInfo {
        id: "w-1".into(),
        title: "teamA".into(),
        app: "teamaapp.exe".into(),
        pid: crate::ProcessId::new(pid),
        process_instance: instance.map(str::to_string),
        bounds: None,
        state: crate::WindowState::default(),
    }
}

#[test]
fn a_record_of_the_same_process_generation_is_handed_over() {
    let entry = entry(7, Some("gen-1"), Some(25));
    assert_eq!(
        recorded_settled_thin_nodes(&entry, &window(7, Some("gen-1"))),
        Some(25)
    );
}

#[test]
fn no_record_hands_over_nothing() {
    let entry = entry(7, Some("gen-1"), None);
    assert_eq!(
        recorded_settled_thin_nodes(&entry, &window(7, Some("gen-1"))),
        None
    );
}

#[test]
fn another_process_generation_or_pid_hands_over_nothing() {
    let entry = entry(7, Some("gen-1"), Some(25));
    assert_eq!(
        recorded_settled_thin_nodes(&entry, &window(7, Some("gen-2"))),
        None
    );
    assert_eq!(
        recorded_settled_thin_nodes(&entry, &window(8, Some("gen-1"))),
        None
    );
}

/// The record holds for the window it was taken on: another window of the
/// same process generation, or an entry with no window id (resolved through
/// any window of its process), never gets the count.
#[test]
fn another_window_of_the_same_process_or_no_window_id_hands_over_nothing() {
    let entry = entry(7, Some("gen-1"), Some(25));
    let mut other = window(7, Some("gen-1"));
    other.id = "w-2".into();
    assert_eq!(recorded_settled_thin_nodes(&entry, &other), None);

    let mut unwindowed = entry.clone();
    unwindowed.source.source_window_id = None;
    assert_eq!(
        recorded_settled_thin_nodes(&unwindowed, &window(7, Some("gen-1"))),
        None
    );
}

#[test]
fn a_missing_instance_token_on_either_side_hands_over_nothing() {
    assert_eq!(
        recorded_settled_thin_nodes(&entry(7, None, Some(25)), &window(7, Some("gen-1"))),
        None
    );
    assert_eq!(
        recorded_settled_thin_nodes(&entry(7, Some("gen-1"), Some(25)), &window(7, None)),
        None
    );
}

/// The record is an optional key: absent when there is none, kept across a
/// round trip, and a refmap written before it existed reads as no record.
#[test]
fn the_record_is_an_optional_key_on_the_wire() {
    let without = serde_json::to_value(entry(7, Some("gen-1"), None)).unwrap();
    assert!(without.get("settled_thin_nodes").is_none());
    let back: RefEntry = serde_json::from_value(without).unwrap();
    assert_eq!(back.source.settled_thin_nodes, None);

    let with = serde_json::to_value(entry(7, Some("gen-1"), Some(25))).unwrap();
    assert_eq!(with["settled_thin_nodes"], 25);
    let back: RefEntry = serde_json::from_value(with).unwrap();
    assert_eq!(back.source.settled_thin_nodes, Some(25));
}

/// A capture records the count on the entries it allocated, and only those.
#[test]
fn a_capture_records_the_count_on_its_own_entries_only() {
    let mut refmap = crate::RefMap::new();
    let window_ref = refmap.allocate(entry(7, Some("gen-1"), None));
    let mut drilled = entry(7, Some("gen-1"), None);
    drilled.scope.root_ref = Some(window_ref.clone());
    let drilled_ref = refmap.allocate(drilled);

    refmap.record_settled_thin_tree(25, Some(&window_ref));
    assert_eq!(
        refmap.get(&drilled_ref).unwrap().source.settled_thin_nodes,
        Some(25)
    );
    assert_eq!(
        refmap.get(&window_ref).unwrap().source.settled_thin_nodes,
        None
    );

    refmap.record_settled_thin_tree(30, None);
    assert_eq!(
        refmap.get(&window_ref).unwrap().source.settled_thin_nodes,
        Some(30)
    );
}
