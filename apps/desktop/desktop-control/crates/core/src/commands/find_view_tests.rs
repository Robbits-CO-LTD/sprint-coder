// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! A find over a window too large to search whole answers from its visible
//! elements, with the proof of a snapshot of them and nothing more.
use super::*;
use crate::adapter::{ActionOps, InputOps, NativeHandle, ObservationOps, SystemOps, WindowFilter};
use crate::commands::find::{FindFilterArgs, FindSelectionArgs};
use crate::locator::live_locator::{LocatorField, ObservedTree};
use crate::refs::refs_test_support::HomeGuard;
use crate::wait::deadline::VirtualClock;
use crate::{AdapterError, RefEntry};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};

/// How the fixture answers a read of the whole window.
#[derive(Clone)]
enum WholeRead {
    /// The whole tree, complete.
    Complete(Box<AccessibilityNode>),
    /// Uses up the deadline it was given, then times out.
    RunsOut,
    /// Stops at once at a fixed read limit, as a list of tens of thousands of
    /// rows does.
    ReadLimit,
}

struct ViewAdapter {
    whole: WholeRead,
    /// What a read of the visible elements returns; `None` refuses such a
    /// read, as a window that is not Chromium-hosted does.
    view: Mutex<Option<AccessibilityNode>>,
    /// The read of the visible elements (below the root) times out.
    view_runs_out: bool,
    whole_reads: AtomicU32,
    view_reads: AtomicU32,
    /// When the deadline of each whole read expires.
    whole_expiries: Mutex<Vec<std::time::Instant>>,
}

/// A frozen clock and the instant it was frozen at.
struct Started {
    clock: VirtualClock,
    start: std::time::Instant,
}

impl Started {
    fn now() -> Self {
        let clock = VirtualClock::freeze();
        Self {
            clock,
            start: crate::wait::deadline::now(),
        }
    }
}

impl ViewAdapter {
    fn new(whole: WholeRead, view: Option<AccessibilityNode>) -> Self {
        Self {
            whole,
            view: Mutex::new(view),
            view_runs_out: false,
            whole_reads: AtomicU32::new(0),
            view_reads: AtomicU32::new(0),
            whole_expiries: Mutex::new(Vec::new()),
        }
    }

    /// How long after `start` the last whole read had to answer: the time the
    /// whole search was given.
    fn whole_span(&self, start: std::time::Instant) -> Duration {
        self.whole_expiries
            .lock()
            .unwrap()
            .iter()
            .map(|expiry| expiry.saturating_duration_since(start))
            .max()
            .unwrap_or_default()
    }

    fn show(&self, view: AccessibilityNode) {
        *self.view.lock().unwrap() = Some(view);
    }

    fn whole_reads(&self) -> u32 {
        self.whole_reads.load(Ordering::SeqCst)
    }

    fn view_reads(&self) -> u32 {
        self.view_reads.load(Ordering::SeqCst)
    }
}

fn fixture_window() -> WindowInfo {
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

fn cut(mut node: AccessibilityNode, depth: u8, max: u8) -> AccessibilityNode {
    if depth >= max && !node.children.is_empty() {
        node.children_count = u32::try_from(node.children.len()).ok();
        node.children = Vec::new();
        return node;
    }
    node.children = node
        .children
        .into_iter()
        .map(|child| cut(child, depth + 1, max))
        .collect();
    node
}

impl ObservationOps for ViewAdapter {
    fn list_windows(
        &self,
        _filter: &WindowFilter,
        _deadline: Deadline,
    ) -> Result<Vec<WindowInfo>, AdapterError> {
        Ok(vec![fixture_window()])
    }

    fn observe_tree(
        &self,
        root: ObservationRoot<'_>,
        request: &ObservationRequest,
    ) -> Result<ObservedTree, AdapterError> {
        if let ObservationRoot::Element { entry, .. } = root {
            // The landed element reads as recorded, in the place the view
            // recorded it.
            let mut observed = crate::adapter::saved_ref_element_tree(root)?;
            if let (Some(proof), Some(landed)) =
                (&entry.identity.in_view, observed.nodes.first_mut())
            {
                landed.evidence.ref_evidence.bounds = LocatorField::Known(proof.bounds);
                landed.evidence.ref_evidence.runtime_id = Some(proof.runtime_id.clone());
            }
            return Ok(observed);
        }
        if request.observation_mode.visible_only {
            let Some(view) = self.view.lock().unwrap().clone() else {
                return Err(AdapterError::new(
                    crate::ErrorCode::ActionNotSupported,
                    "this fixture reads no view of visible elements",
                ));
            };
            self.view_reads.fetch_add(1, Ordering::SeqCst);
            if self.view_runs_out && request.max_logical_depth > 0 {
                crate::wait::deadline::sleep(request.deadline.remaining());
                return Err(request.deadline.timeout_error());
            }
            let mut observed =
                crate::adapter::observed_tree(&root, cut(view, 0, request.max_logical_depth))?;
            // Each element on screen, one below the other, with its own
            // runtime id, so a ref can carry the proof of a view.
            for (index, node) in observed.nodes.iter_mut().enumerate() {
                node.evidence.ref_evidence.bounds = LocatorField::Known(crate::Rect {
                    x: 0.0,
                    y: 20.0 * index as f64,
                    width: 200.0,
                    height: 20.0,
                });
                let index = i32::try_from(index).unwrap_or(i32::MAX);
                node.evidence.ref_evidence.runtime_id = Some(vec![42, index]);
            }
            observed.mark_visible_scope();
            return Ok(observed);
        }
        self.whole_reads.fetch_add(1, Ordering::SeqCst);
        self.whole_expiries
            .lock()
            .unwrap()
            .push(crate::wait::deadline::now() + request.deadline.remaining());
        match &self.whole {
            WholeRead::Complete(tree) => crate::adapter::observed_tree(&root, (**tree).clone()),
            WholeRead::RunsOut => {
                crate::wait::deadline::sleep(request.deadline.remaining());
                Err(request.deadline.timeout_error())
            }
            WholeRead::ReadLimit => Err(AdapterError::timeout(
                "Locator traversal reached a deterministic observation budget",
            )
            .with_details(serde_json::json!({ "kind": "locator_budget_limit" }))),
        }
    }

    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::new("strict"))
    }

    fn resolve_locator_anchor(
        &self,
        _entry: &RefEntry,
        _deadline: Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::new("anchor"))
    }
}

impl ActionOps for ViewAdapter {}
impl InputOps for ViewAdapter {}
impl SystemOps for ViewAdapter {
    fn supported_surfaces(&self) -> Vec<crate::SnapshotSurface> {
        vec![crate::SnapshotSurface::Window]
    }
}

fn node(role: &str, name: &str) -> AccessibilityNode {
    crate::adapter::minimal_accessibility_node(role, name)
}

fn rows(names: &[&str]) -> AccessibilityNode {
    let mut list = node("list", "Rows");
    list.children = names.iter().map(|name| node("button", name)).collect();
    let mut root = node("window", "Fixture");
    root.children = vec![node("button", "Go"), list];
    root
}

fn shown_rows() -> AccessibilityNode {
    rows(&["Row 0", "Row 1", "Row 2", "Row 3", "Row 4"])
}

fn find(name: Option<&str>, selection: FindSelectionArgs) -> FindArgs {
    FindArgs {
        app: None,
        window_id: Some("w-1".into()),
        root: None,
        surface: crate::SnapshotSurface::Window,
        filter: FindFilterArgs {
            role: Some("button".into()),
            name: name.map(str::to_owned),
            description: None,
            native_id: None,
            value: None,
            text: None,
            exact: true,
        },
        states: Vec::new(),
        timeout_ms: None,
        selection,
    }
}

fn listing() -> FindSelectionArgs {
    FindSelectionArgs {
        count: false,
        first: false,
        last: false,
        nth: None,
        limit: None,
    }
}

fn run(adapter: &ViewAdapter, args: FindArgs) -> Result<Value, AppError> {
    crate::commands::find::execute(args, adapter, &CommandContext::default())
}

fn saved_entry(ref_id: &str) -> RefEntry {
    crate::commands::helpers::load_ref_entry(ref_id, &CommandContext::default())
        .expect("the ref is saved")
}

fn resolve(adapter: &ViewAdapter, entry: &RefEntry) -> Result<NativeHandle, AdapterError> {
    crate::refs::resolve_saved_ref::resolve_saved_ref(
        adapter,
        entry,
        Deadline::standard().expect("a standard deadline"),
        None,
    )
}

#[test]
fn a_find_that_runs_out_answers_from_the_visible_elements() {
    let _guard = HomeGuard::new();
    let _clock = VirtualClock::freeze();
    let adapter = ViewAdapter::new(WholeRead::RunsOut, Some(shown_rows()));

    let response = run(&adapter, find(Some("Row 3"), listing())).expect("the view answers");

    assert_eq!(response["scope"], "visible");
    assert_eq!(response["scope_hint"], VISIBLE_MATCHES_HINT);
    assert_eq!(response["total_matches"], 1);
    let found = &response["matches"][0];
    assert_eq!(found["name"], "Row 3");
    assert_eq!(found["interactive"], true);
    let ref_id = found["ref_id"].as_str().expect("the match carries a ref");
    let snapshot_id = response["snapshot_id"].as_str().expect("a snapshot id");
    assert!(ref_id.starts_with(&format!("@{snapshot_id}:")), "{ref_id}");
    assert!(
        adapter.whole_reads() >= 1,
        "the whole window is searched first"
    );
}

/// The ref is a ref of a snapshot of the visible elements: proven in that
/// view, never unique in the whole window, and re-identified only by reading
/// the view again.
#[test]
fn a_ref_found_in_view_carries_the_proof_of_a_view() {
    let _guard = HomeGuard::new();
    let _clock = VirtualClock::freeze();
    let adapter = ViewAdapter::new(WholeRead::RunsOut, Some(shown_rows()));

    let response = run(&adapter, find(Some("Row 3"), listing())).expect("the view answers");
    let entry = saved_entry(response["matches"][0]["ref_id"].as_str().unwrap());

    assert!(!entry.identity.unique_at_capture);
    assert!(entry.identity.ancestors.is_empty());
    assert!(entry.identity.in_view.is_some(), "proven in the view");
    assert_eq!(entry.identity.name.as_deref(), Some("Row 3"));
    resolve(&adapter, &entry).expect("the same view re-identifies it");

    // Scrolled: the row is no longer where the view recorded it.
    adapter.show(rows(&["Row 3", "Row 4", "Row 5", "Row 6", "Row 7"]));
    let Err(error) = resolve(&adapter, &entry) else {
        panic!("a scrolled view stops the ref");
    };
    assert_eq!(error.code, crate::ErrorCode::StaleRef, "{error:?}");
}

/// Two shown rows of one name: each is listed, but neither is proven, so
/// neither acts - as in a snapshot of the same view.
#[test]
fn a_match_with_a_twin_in_view_stays_unproven() {
    let _guard = HomeGuard::new();
    let _clock = VirtualClock::freeze();
    let adapter = ViewAdapter::new(WholeRead::RunsOut, Some(rows(&["Row 0", "Row 3", "Row 3"])));

    let response = run(&adapter, find(Some("Row 3"), listing())).expect("the view answers");

    assert_eq!(response["total_matches"], 2);
    for found in response["matches"].as_array().unwrap() {
        let entry = saved_entry(found["ref_id"].as_str().unwrap());
        assert!(entry.identity.in_view.is_none(), "a twin is not proven");
        assert!(!entry.identity.unique_at_capture);
        assert!(
            resolve(&adapter, &entry).is_err(),
            "an unproven ref does not act"
        );
    }
}

#[test]
fn nothing_shown_says_to_scroll_rather_than_that_the_window_has_none() {
    let _guard = HomeGuard::new();
    let _clock = VirtualClock::freeze();
    let adapter = ViewAdapter::new(WholeRead::RunsOut, Some(shown_rows()));

    let listed = run(&adapter, find(Some("Row 4000"), listing())).expect("the view answers");
    assert_eq!(listed["scope"], "visible");
    assert_eq!(listed["total_matches"], 0);
    assert_eq!(listed["scope_hint"], VISIBLE_NO_MATCH_HINT);
    let hint = listed["scope_hint"].as_str().unwrap();
    assert!(hint.contains("does not mean the window has no such element"));
    assert!(hint.contains("Scroll"));
    assert!(listed["roles_present"].as_array().is_some());

    let mut first = listing();
    first.first = true;
    let single = run(&adapter, find(Some("Row 4000"), first)).expect("the view answers");
    assert!(single["match"].is_null());
    assert_eq!(single["scope"], "visible");
    assert_eq!(single["scope_hint"], VISIBLE_NO_MATCH_HINT);
}

#[test]
fn first_and_limit_shape_the_matches_shown() {
    let _guard = HomeGuard::new();
    let _clock = VirtualClock::freeze();
    let adapter = ViewAdapter::new(WholeRead::RunsOut, Some(shown_rows()));

    let mut limited = listing();
    limited.limit = Some(2);
    let response = run(&adapter, find(None, limited)).expect("the view answers");
    assert_eq!(response["matches"].as_array().unwrap().len(), 2);
    assert_eq!(response["total_matches"], 6, "Go and the five rows");
    assert_eq!(response["truncated"], true);

    let mut first = listing();
    first.first = true;
    let response = run(&adapter, find(None, first)).expect("the view answers");
    assert_eq!(response["match"]["name"], "Go");
    assert_eq!(response["scope"], "visible");
    assert_eq!(response["scope_hint"], VISIBLE_MATCHES_HINT);
}

/// The whole search gets three quarters of the default deadline, and the read
/// of the visible elements answers within the rest.
#[test]
fn the_whole_search_and_the_view_share_the_default_deadline() {
    let _guard = HomeGuard::new();
    let clock = Started::now();
    let adapter = ViewAdapter::new(WholeRead::RunsOut, Some(shown_rows()));

    run(&adapter, find(Some("Row 3"), listing())).expect("the view answers");

    // The read itself ends earlier still: a find keeps part of its search's
    // deadline for reading the selected matches.
    let span = adapter.whole_span(clock.start);
    assert!(
        span > LOCATOR_TIMEOUT / 2 && span <= LOCATOR_TIMEOUT * 3 / 4,
        "{span:?}"
    );
    assert!(
        clock.clock.elapsed() <= LOCATOR_TIMEOUT,
        "{:?}",
        clock.clock.elapsed()
    );
}

/// A read limit ends the whole search at once, leaving the view most of the
/// deadline.
#[test]
fn a_read_limit_also_answers_from_the_view() {
    let _guard = HomeGuard::new();
    let _clock = VirtualClock::freeze();
    let adapter = ViewAdapter::new(WholeRead::ReadLimit, Some(shown_rows()));

    let response = run(&adapter, find(Some("Row 3"), listing())).expect("the view answers");
    assert_eq!(response["scope"], "visible");
    assert_eq!(response["total_matches"], 1);
}

/// A window the whole search finishes on is answered whole, as before: no
/// scope, refs proven over the whole window.
#[test]
fn a_window_searched_whole_is_answered_whole() {
    let _guard = HomeGuard::new();
    let adapter = ViewAdapter::new(
        WholeRead::Complete(Box::new(shown_rows())),
        Some(shown_rows()),
    );

    let response = run(&adapter, find(Some("Row 3"), listing())).expect("the whole answers");

    assert!(response.get("scope").is_none());
    assert!(response.get("scope_hint").is_none());
    let entry = saved_entry(response["matches"][0]["ref_id"].as_str().unwrap());
    assert!(entry.identity.unique_at_capture);
    assert!(entry.identity.in_view.is_none());
    assert_eq!(adapter.whole_reads(), 1);
    assert_eq!(
        adapter.view_reads(),
        1,
        "only the probe of the window's root"
    );
}

/// A window not read by its visible elements keeps the whole deadline for its
/// search, and its timeout, as before.
#[test]
fn a_window_not_read_by_its_view_keeps_the_whole_deadline_and_the_timeout() {
    let _guard = HomeGuard::new();
    let clock = Started::now();
    let adapter = ViewAdapter::new(WholeRead::RunsOut, None);

    let error = run(&adapter, find(Some("Row 3"), listing())).expect_err("no view to answer");

    assert_eq!(error.code(), "TIMEOUT");
    assert!(
        adapter.whole_span(clock.start) > LOCATOR_TIMEOUT * 3 / 4,
        "not capped"
    );
}

/// A view that cannot be read in what is left reports the whole search's own
/// failure, with its guidance.
#[test]
fn a_view_that_runs_out_too_keeps_the_timeout() {
    let _guard = HomeGuard::new();
    let _clock = VirtualClock::freeze();
    let mut adapter = ViewAdapter::new(WholeRead::RunsOut, Some(shown_rows()));
    adapter.view_runs_out = true;

    let error = run(&adapter, find(Some("Row 3"), listing())).expect_err("nothing answers");

    assert_eq!(error.code(), "TIMEOUT");
    assert!(
        error
            .suggestion()
            .unwrap_or_default()
            .contains("run snapshot instead"),
        "{:?}",
        error.suggestion()
    );
}

/// A count, a last match and an n-th match are questions about the whole
/// window; they keep the whole search and its timeout, and read no view.
#[test]
fn counts_and_positions_never_answer_from_the_view() {
    let _guard = HomeGuard::new();
    for shape in ["count", "last", "nth"] {
        let clock = Started::now();
        let adapter = ViewAdapter::new(WholeRead::RunsOut, Some(shown_rows()));
        let mut selection = listing();
        match shape {
            "count" => selection.count = true,
            "last" => selection.last = true,
            _ => selection.nth = Some(1),
        }
        let error = run(&adapter, find(Some("Row 3"), selection)).expect_err(shape);
        assert_eq!(error.code(), "TIMEOUT", "{shape}");
        assert_eq!(adapter.view_reads(), 0, "{shape}: not even the probe");
        assert!(
            adapter.whole_span(clock.start) > LOCATOR_TIMEOUT * 3 / 4,
            "{shape}: not capped"
        );
    }
}

/// A deadline shorter than the default cannot push a window onto the
/// narrower proof.
#[test]
fn a_shortened_deadline_never_answers_from_the_view() {
    let _guard = HomeGuard::new();
    let _clock = VirtualClock::freeze();
    let adapter = ViewAdapter::new(WholeRead::RunsOut, Some(shown_rows()));

    let mut args = find(Some("Row 3"), listing());
    args.timeout_ms = Some(3_000);
    let error = run(&adapter, args).expect_err("no view under a short deadline");

    assert_eq!(error.code(), "TIMEOUT");
    assert_eq!(adapter.view_reads(), 0);
}

#[test]
fn only_a_whole_window_listing_or_first_may_answer_from_the_view() {
    assert!(answers_in_view(&find(None, listing())));
    let mut first = listing();
    first.first = true;
    assert!(answers_in_view(&find(None, first)));

    let mut rooted = find(None, listing());
    rooted.root = Some("@s1:e1".into());
    assert!(!answers_in_view(&rooted));
    let mut surface = find(None, listing());
    surface.surface = crate::SnapshotSurface::Sheet;
    assert!(!answers_in_view(&surface));
}

#[test]
fn the_whole_search_budget_is_three_quarters_and_uncapped() {
    assert_eq!(
        whole_search_budget(Duration::from_secs(5)),
        Duration::from_millis(3_750)
    );
    assert_eq!(
        whole_search_budget(Duration::from_secs(20)),
        Duration::from_secs(15),
        "a raised --timeout-ms reaches the whole search"
    );
    let default = Deadline::from_duration(LOCATOR_TIMEOUT).unwrap();
    assert!(view_allowed(default, LOCATOR_TIMEOUT / 2));
    assert!(!view_allowed(
        default,
        LOCATOR_TIMEOUT / 2 - Duration::from_millis(1)
    ));
    let short = Deadline::after(4_999).unwrap();
    assert!(!view_allowed(short, LOCATOR_TIMEOUT));
}
