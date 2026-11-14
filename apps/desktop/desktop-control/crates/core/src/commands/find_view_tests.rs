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
    /// Takes this long, then returns the whole tree, complete, when its
    /// deadline allows that long; otherwise uses up the deadline and times out.
    Slow(Duration, Box<AccessibilityNode>),
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
            with_two_identifiers(&mut observed);
            observed.mark_visible_scope();
            return Ok(observed);
        }
        self.whole_reads.fetch_add(1, Ordering::SeqCst);
        self.whole_expiries
            .lock()
            .unwrap()
            .push(crate::wait::deadline::now() + request.deadline.remaining());
        match &self.whole {
            WholeRead::Complete(tree) => {
                let mut observed = crate::adapter::observed_tree(&root, (**tree).clone())?;
                with_two_identifiers(&mut observed);
                Ok(observed)
            }
            WholeRead::RunsOut => {
                crate::wait::deadline::sleep(request.deadline.remaining());
                Err(request.deadline.timeout_error())
            }
            WholeRead::Slow(takes, tree) => {
                if request.deadline.remaining() < *takes {
                    crate::wait::deadline::sleep(request.deadline.remaining());
                    return Err(request.deadline.timeout_error());
                }
                crate::wait::deadline::sleep(*takes);
                crate::adapter::observed_tree(&root, (**tree).clone())
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

/// The time the observation of a whole-window search always gets under the
/// default deadline: the deadline less the 1 s a search keeps for reading the
/// matches it selects.
const OBSERVATION_TIME: Duration = Duration::from_secs(4);

/// The whole search's observation gets the time it always got, and the read
/// of the visible elements answers within the time the search keeps for
/// reading its matches; nothing reads the whole window after that.
#[test]
fn the_whole_search_and_the_view_share_the_default_deadline() {
    let _guard = HomeGuard::new();
    let clock = Started::now();
    let adapter = ViewAdapter::new(WholeRead::RunsOut, Some(shown_rows()));

    run(&adapter, find(Some("Row 3"), listing())).expect("the view answers");

    assert_eq!(adapter.whole_span(clock.start), OBSERVATION_TIME);
    assert!(
        clock.clock.elapsed() <= LOCATOR_TIMEOUT,
        "{:?}",
        clock.clock.elapsed()
    );
}

/// A whole search whose observation finishes late, but within the time an
/// observation always gets, answers whole as before: the fallback never takes
/// time from it.
#[test]
fn a_slow_whole_search_that_finishes_in_time_still_answers_whole() {
    let _guard = HomeGuard::new();
    let clock = Started::now();
    let adapter = ViewAdapter::new(
        WholeRead::Slow(
            OBSERVATION_TIME - Duration::from_millis(100),
            Box::new(shown_rows()),
        ),
        Some(shown_rows()),
    );

    let response = run(&adapter, find(Some("Row 3"), listing())).expect("the whole answers");

    assert!(response.get("scope").is_none(), "{response}");
    assert_eq!(response["total_matches"], 1);
    assert_eq!(adapter.whole_span(clock.start), OBSERVATION_TIME);
    assert_eq!(
        adapter.view_reads(),
        1,
        "only the probe of the window's root"
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
        adapter.whole_span(clock.start) > OBSERVATION_TIME,
        "it reads on into the time kept for the matches, as before"
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
            adapter.whole_span(clock.start) > OBSERVATION_TIME,
            "{shape}: searched as before"
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
fn only_the_default_deadline_or_a_longer_one_may_answer_from_the_view() {
    assert!(view_allowed(
        Deadline::from_duration(LOCATOR_TIMEOUT).unwrap()
    ));
    assert!(view_allowed(Deadline::after(20_000).unwrap()));
    assert!(!view_allowed(Deadline::after(4_999).unwrap()));
}

/// Gives every element named "Field ..." two identifiers, the first one
/// preferred, as an element with both an automation id and another
/// identifier reports them.
fn with_two_identifiers(observed: &mut ObservedTree) {
    for node in &mut observed.nodes {
        let Some(name) = node
            .evidence
            .name
            .known()
            .filter(|name| name.starts_with("Field"))
            .cloned()
        else {
            continue;
        };
        let identifier = |value: String, kind| crate::ElementIdentifier { kind, value };
        node.evidence.identifiers = crate::locator::live_locator::IdentifierEvidence::typed(
            [
                identifier(
                    format!("{name}-primary"),
                    crate::IdentifierKind::AutomationId,
                ),
                identifier(
                    format!("{name}-alt"),
                    crate::IdentifierKind::AxDomIdentifier,
                ),
            ],
            Some(0),
            true,
        );
    }
}

/// A form above the rows: a label without a ref, an empty field and a filled
/// one.
fn form() -> AccessibilityNode {
    let mut empty = node("textfield", "Field A");
    empty.identity.value = Some(String::new());
    let mut filled = node("textfield", "Field B");
    filled.identity.value = Some("typed".into());
    let mut root = shown_rows();
    root.children
        .splice(0..0, [node("statictext", "Name label"), empty, filled]);
    root
}

fn filter() -> FindFilterArgs {
    FindFilterArgs {
        role: None,
        name: None,
        description: None,
        native_id: None,
        value: None,
        text: None,
        exact: false,
    }
}

fn query(filter: FindFilterArgs) -> FindArgs {
    FindArgs {
        filter,
        ..find(None, listing())
    }
}

fn clone_filter(filter: &FindFilterArgs) -> FindFilterArgs {
    FindFilterArgs {
        role: filter.role.clone(),
        name: filter.name.clone(),
        description: filter.description.clone(),
        native_id: filter.native_id.clone(),
        value: filter.value.clone(),
        text: filter.text.clone(),
        exact: filter.exact,
    }
}

/// A match without a ref (static text) carries its rectangle on screen, as in
/// a whole-window find, while the record of refs stays the one a default
/// snapshot of the same view saves: the rectangle is read from the
/// observation, never written into the refs.
#[test]
fn a_match_without_a_ref_shows_its_bounds_and_the_record_stays_a_snapshots() {
    let _guard = HomeGuard::new();
    let _clock = VirtualClock::freeze();
    let adapter = ViewAdapter::new(WholeRead::RunsOut, Some(form()));

    let response = run(
        &adapter,
        query(FindFilterArgs {
            role: Some("statictext".into()),
            ..filter()
        }),
    )
    .expect("the view answers");

    assert_eq!(response["scope"], "visible");
    let label = &response["matches"][0];
    assert_eq!(label["name"], "Name label");
    assert!(label.get("ref_id").is_none_or(Value::is_null), "{label}");
    assert_eq!(label["interactive"], false);
    // The label is the second node the view read (the window is the first).
    assert_eq!(
        label["bounds"],
        json!({ "x": 0.0, "y": 20.0, "width": 200.0, "height": 20.0 })
    );

    // A match with a ref carries no rectangle, as in a whole-window find.
    let rows = run(&adapter, find(Some("Row 3"), listing())).expect("the view answers");
    assert!(rows["matches"][0].get("bounds").is_none());
    assert!(rows["matches"][0]["ref_id"].is_string());

    let snapshot_id = response["snapshot_id"].as_str().unwrap();
    let saved = RefStore::new().unwrap().load_snapshot(snapshot_id).unwrap();
    // A snapshot of the same view (its whole read stops at once here).
    let snapshotted = ViewAdapter::new(WholeRead::ReadLimit, Some(form()));
    let snapshot = crate::snapshot::build(
        &snapshotted,
        // A default snapshot's options; the fixture is shallower than its depth.
        &TreeOptions {
            max_depth: 10,
            ..TreeOptions::default()
        },
        None,
        Some("w-1"),
        Deadline::after(crate::snapshot::DEFAULT_SNAPSHOT_TIMEOUT_MS).unwrap(),
    )
    .expect("the snapshot reads the view");
    assert!(snapshot.visible_scope);
    assert_eq!(
        serde_json::to_value(&saved).unwrap(),
        serde_json::to_value(&snapshot.refmap).unwrap(),
        "the find saves the record a snapshot of the view saves"
    );
}

/// The view is searched by the predicate a whole-window find applies to the
/// observed elements: an empty value that was read is a value
/// (`--value "" --exact`), and an identifier that is not the preferred one
/// still matches.
#[test]
fn the_view_is_searched_by_the_whole_window_predicate() {
    let _guard = HomeGuard::new();
    let _clock = VirtualClock::freeze();
    let viewed = ViewAdapter::new(WholeRead::RunsOut, Some(form()));
    let whole = ViewAdapter::new(WholeRead::Complete(Box::new(form())), None);

    let queries = [
        FindFilterArgs {
            role: Some("textfield".into()),
            value: Some(String::new()),
            exact: true,
            ..filter()
        },
        FindFilterArgs {
            native_id: Some("Field B-alt".into()),
            ..filter()
        },
        FindFilterArgs {
            native_id: Some("Field A-primary".into()),
            ..filter()
        },
        FindFilterArgs {
            role: Some("list".into()),
            text: Some("Row 3".into()),
            ..filter()
        },
        FindFilterArgs {
            role: Some("textfield".into()),
            name: Some("field".into()),
            ..filter()
        },
    ];
    for filter in &queries {
        let label = format!(
            "value={:?} native_id={:?} text={:?} name={:?}",
            filter.value, filter.native_id, filter.text, filter.name
        );
        let in_view = run(&viewed, query(clone_filter(filter))).expect("the view answers");
        let whole_answer =
            run(&whole, query(clone_filter(filter))).expect("the whole window answers");
        assert_eq!(in_view["scope"], "visible", "{label}");
        assert!(whole_answer.get("scope").is_none(), "{label}");
        assert_eq!(
            in_view["total_matches"], whole_answer["total_matches"],
            "{label}"
        );
        assert!(in_view["total_matches"].as_u64() > Some(0), "{label}");
        let shape = |answer: &Value| {
            answer["matches"]
                .as_array()
                .unwrap()
                .iter()
                .map(|found| {
                    (
                        found["role"].clone(),
                        found["name"].clone(),
                        found["value"].clone(),
                        found["path"].clone(),
                        found["interactive"].clone(),
                    )
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(shape(&in_view), shape(&whole_answer), "{label}");
    }
}

/// A ref is paired with its node only where the presented tree lines up with
/// the observation; a node the presentation does not show the same way gets
/// none, and nor does anything below it, rather than another node's ref.
#[test]
fn refs_pair_with_nodes_only_where_the_trees_line_up() {
    let window = fixture_window();
    let root = ObservationRoot::Window(&window);
    let observed = crate::adapter::observed_tree(&root, form()).unwrap();
    let mut presented = form();
    presented.children[1].ref_id = Some("@s:e1".into());
    presented.children[3].role = "group".into();
    presented.children[4].children[0].ref_id = Some("@s:e2".into());
    presented.children[4].children.pop();

    let refs = refs_by_node(&observed, &presented);

    let index_of = |name: &str| {
        observed
            .nodes
            .iter()
            .position(|node| node.evidence.name.known().map(String::as_str) == Some(name))
            .unwrap()
    };
    assert_eq!(refs[index_of("Field A")].as_deref(), Some("@s:e1"));
    assert_eq!(
        refs[index_of("Go")],
        None,
        "a role that differs is not paired"
    );
    assert_eq!(
        refs[index_of("Row 0")],
        None,
        "children that do not line up are not paired"
    );
}
