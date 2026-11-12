// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use std::sync::{
    Mutex,
    atomic::{AtomicU32, Ordering},
};

use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::locator::live_locator::ObservationRoot;
use crate::refs::ref_alloc::allocate_refs;
use crate::refs::ref_alloc_config::RefAllocConfig;
use crate::refs::ref_alloc_options::RefAllocOptions;
use crate::refs::ref_alloc_scope::RefAllocScope;
use crate::refs::ref_alloc_source::RefAllocSource;
use crate::refs::resolve_saved_ref::resolve_saved_ref as resolve_entry;
use crate::{
    AccessibilityNode, AdapterError, Deadline, NativeHandle, RefEntry, RefMap, WindowInfo,
};

pub(super) struct RuleAdapter {
    pub(super) windows: Vec<WindowInfo>,
    pub(super) shell: Option<WindowInfo>,
    pub(super) observed: AccessibilityNode,
    pub(super) landed: Option<AccessibilityNode>,
    pub(super) windows_listed: AtomicU32,
    pub(super) observations: AtomicU32,
    pub(super) strict: AtomicU32,
    pub(super) anchors: AtomicU32,
    pub(super) anchored: Mutex<Option<RefEntry>>,
    /// The tree the landed element's ancestors are read from, when it is no
    /// longer the tree the whole-window count read (`observed`).
    pub(super) ancestor_tree: Option<AccessibilityNode>,
    pub(super) ancestor_reads: AtomicU32,
}

impl RuleAdapter {
    pub(super) fn new(observed: AccessibilityNode) -> Self {
        Self {
            windows: vec![window()],
            shell: None,
            observed,
            landed: None,
            windows_listed: AtomicU32::new(0),
            observations: AtomicU32::new(0),
            strict: AtomicU32::new(0),
            anchors: AtomicU32::new(0),
            anchored: Mutex::new(None),
            ancestor_tree: None,
            ancestor_reads: AtomicU32::new(0),
        }
    }

    pub(super) fn counts(&self) -> (u32, u32, u32, u32) {
        (
            self.windows_listed.load(Ordering::SeqCst),
            self.observations.load(Ordering::SeqCst),
            self.strict.load(Ordering::SeqCst),
            self.anchors.load(Ordering::SeqCst),
        )
    }
}

impl ObservationOps for RuleAdapter {
    fn list_apps_scoped(
        &self,
        _name: &str,
        _bundle_id: Option<&str>,
        _deadline: Deadline,
    ) -> Result<Vec<crate::AppInfo>, AdapterError> {
        Ok(vec![crate::AppInfo {
            name: "Fixture".into(),
            pid: crate::ProcessId::new(1),
            bundle_id: None,
            process_instance: Some("test-instance".into()),
            presentation: None,
        }])
    }

    fn list_windows(
        &self,
        _filter: &crate::adapter::WindowFilter,
        _deadline: Deadline,
    ) -> Result<Vec<WindowInfo>, AdapterError> {
        self.windows_listed.fetch_add(1, Ordering::SeqCst);
        Ok(self.windows.clone())
    }

    fn observe_tree(
        &self,
        root: ObservationRoot<'_>,
        _request: &crate::locator::live_locator::ObservationRequest,
    ) -> Result<crate::locator::live_locator::ObservedTree, AdapterError> {
        self.observations.fetch_add(1, Ordering::SeqCst);
        match (&self.landed, root) {
            (Some(landed), ObservationRoot::Element { .. }) => {
                crate::adapter::observed_tree(&root, landed.clone())
            }
            (None, ObservationRoot::Element { .. }) => crate::adapter::saved_ref_element_tree(root),
            _ => crate::adapter::observed_tree(&root, self.observed.clone()),
        }
    }

    fn validate_saved_ref_context(
        &self,
        entry: &RefEntry,
        observed_token: Option<&str>,
    ) -> Result<(), AdapterError> {
        if entry.source.source_surface == crate::SnapshotSurface::Menu
            && entry.identity.retained_object.as_deref() != observed_token
        {
            return Err(AdapterError::stale_ref_because("menu context changed")
                .with_details(serde_json::json!({ "retryable": false })));
        }
        Ok(())
    }

    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        self.strict.fetch_add(1, Ordering::SeqCst);
        Ok(NativeHandle::new("strict"))
    }

    fn resolve_shell_surface(
        &self,
        _surface: crate::SnapshotSurface,
        _deadline: Deadline,
    ) -> Result<WindowInfo, AdapterError> {
        match &self.shell {
            Some(window) => Ok(window.clone()),
            None => Err(AdapterError::not_supported("resolve_shell_surface")),
        }
    }

    fn resolve_locator_anchor(
        &self,
        entry: &RefEntry,
        _deadline: Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        self.anchors.fetch_add(1, Ordering::SeqCst);
        *self.anchored.lock().unwrap() = Some(entry.clone());
        Ok(NativeHandle::new("anchor"))
    }

    /// The ancestors of the node at the landed anchor's path, in the tree the
    /// landing saw: `ancestor_tree` when a test changed it after the count.
    fn read_ancestor_evidence(
        &self,
        _entry: &RefEntry,
        _handle: &NativeHandle,
        count: usize,
        _deadline: Deadline,
    ) -> Result<Vec<crate::LocatorEvidence>, AdapterError> {
        self.ancestor_reads.fetch_add(1, Ordering::SeqCst);
        let path = self
            .anchored
            .lock()
            .unwrap()
            .clone()
            .map(|anchor| anchor.scope.path.as_slice().to_vec())
            .unwrap_or_default();
        let tree = self
            .ancestor_tree
            .clone()
            .unwrap_or_else(|| self.observed.clone());
        let observed = crate::adapter::observed_tree(&ObservationRoot::Window(&window()), tree)?;
        let parents = crate::refs::ref_ancestry::parents(&observed);
        let Some(mut index) = observed
            .nodes
            .iter()
            .position(|node| node.path.as_slice() == path.as_slice())
        else {
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

impl ActionOps for RuleAdapter {}
impl InputOps for RuleAdapter {}
impl SystemOps for RuleAdapter {
    fn supported_surfaces(&self) -> Vec<crate::SnapshotSurface> {
        vec![crate::SnapshotSurface::Window, crate::SnapshotSurface::Menu]
    }
}

pub(super) fn window() -> WindowInfo {
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

pub(super) fn entry() -> RefEntry {
    let mut entry = crate::adapter::minimal_ref_entry("button", Some("Run"));
    entry.source.source_app = Some("Fixture".into());
    entry.source.source_window_id = Some("w-1".into());
    entry
}

pub(super) fn node(role: &str, name: &str) -> AccessibilityNode {
    crate::adapter::minimal_accessibility_node(role, name)
}

pub(super) fn tree_with(children: Vec<AccessibilityNode>) -> AccessibilityNode {
    let mut root = node("group", "Window");
    root.children = children;
    root
}

pub(super) fn resolve(
    adapter: &RuleAdapter,
    entry: &RefEntry,
) -> Result<NativeHandle, AdapterError> {
    resolve_entry(adapter, entry, Deadline::standard().unwrap(), None)
}

pub(super) fn capture(root: AccessibilityNode, name: &str) -> RefEntry {
    let mut refmap = RefMap::new();
    let observed = crate::adapter::observed_tree(&ObservationRoot::Window(&window()), root.clone())
        .expect("the fixture observes");
    let proof = crate::refs::ref_capture_proof::CaptureProof::new(&observed);
    let config = RefAllocConfig {
        capture: Some(&proof),
        ..config_without_uniqueness()
    };
    allocate_refs(root, &mut refmap, &config).unwrap();
    (1..=refmap.len())
        .filter_map(|index| refmap.get(&format!("@e{index}")).cloned())
        .find(|entry| entry.identity.name.as_deref() == Some(name))
        .expect("the captured element has a ref")
}

/// Every entry one capture of `root` publishes, in allocation order.
pub(super) fn capture_all(root: AccessibilityNode) -> Vec<RefEntry> {
    let mut refmap = RefMap::new();
    let observed = crate::adapter::observed_tree(&ObservationRoot::Window(&window()), root.clone())
        .expect("the fixture observes");
    let proof = crate::refs::ref_capture_proof::CaptureProof::new(&observed);
    let config = RefAllocConfig {
        capture: Some(&proof),
        ..config_without_uniqueness()
    };
    allocate_refs(root, &mut refmap, &config).unwrap();
    (1..=refmap.len())
        .filter_map(|index| refmap.get(&format!("@e{index}")).cloned())
        .collect()
}

fn config_without_uniqueness() -> RefAllocConfig<'static> {
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
