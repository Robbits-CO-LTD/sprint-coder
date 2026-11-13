// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::*;
use crate::tree::properties::property_ids::TreeProperty;
use crate::tree::properties::property_outcome::{PropertyOutcome, PropertyValue};

fn window_for(pid: u32, instance: &str) -> agent_desktop_core::WindowInfo {
    agent_desktop_core::WindowInfo {
        id: "w-1".into(),
        title: "x".into(),
        app: "x".into(),
        pid: agent_desktop_core::ProcessId::new(pid),
        process_instance: Some(instance.into()),
        bounds: None,
        state: Default::default(),
    }
}

fn request_with(deadline: Deadline, force_renderer_accessibility: bool) -> ObservationRequest {
    let options = agent_desktop_core::TreeOptions {
        force_renderer_accessibility,
        ..agent_desktop_core::TreeOptions::default()
    };
    ObservationRequest::snapshot(&options, deadline)
}

/// A small, complete `WalkOutcome` unrelated to any live provider: one node,
/// no faults. `finish_observation` takes `chromium_root` and the shell
/// classification as separate inputs, so this same outcome doubles as both a
/// "clean native walk" and a "settled Chromium shell" fixture depending on
/// what the caller passes for `chromium_root`.
fn small_complete_outcome() -> WalkOutcome {
    crate::tree::walk::walker_fake::walk(
        &crate::tree::walk::walker_fake::FakeTree::default(),
        crate::tree::walk::walker_fake::budget(10),
    )
}

#[test]
fn a_malformed_root_window_id_fails_before_walking() {
    let request = ObservationRequest::snapshot(
        &agent_desktop_core::TreeOptions::default(),
        agent_desktop_core::Deadline::after(5_000).unwrap(),
    );
    let window = agent_desktop_core::WindowInfo {
        id: "not-a-window-id".into(),
        title: "x".into(),
        app: "x".into(),
        pid: agent_desktop_core::ProcessId::new(1),
        process_instance: None,
        bounds: None,
        state: Default::default(),
    };

    let error = observe_tree(
        ObservationRoot::Window(&window),
        &request,
        &crate::adapter::WindowsAdapter::new(),
    )
    .expect_err("a malformed id must fail");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
}

#[cfg(target_os = "windows")]
#[test]
fn a_destroyed_hwnd_fails_reverification_as_window_not_found() {
    let window = agent_desktop_core::WindowInfo {
        id: format!("w-{}", 0x7fffffff),
        title: "x".into(),
        app: "x".into(),
        pid: agent_desktop_core::ProcessId::new(1),
        process_instance: None,
        bounds: None,
        state: Default::default(),
    };

    let error = re_verify_root(agent_desktop_core::ObservationRoot::Window(&window))
        .expect_err("a destroyed handle must fail the liveness gate");
    assert_eq!(error.code, ErrorCode::WindowNotFound);
}

#[cfg(target_os = "windows")]
#[test]
fn a_freshly_created_fixture_window_passes_reverification() {
    use agent_desktop_core::ObservationRoot;

    crate::tree::fixture::ensure_test_apartment();
    let fixture = crate::tree::fixture::HostedFixture::spawn().expect("a fixture host starts");
    let window = agent_desktop_core::WindowInfo {
        id: crate::system::window::window_ops::window_id(fixture.handle() as _),
        title: "agent-desktop fixture".into(),
        app: "fixture.exe".into(),
        pid: agent_desktop_core::ProcessId::from(fixture.process_id()),
        process_instance: Some(
            crate::system::process_identity::token_for_pid(agent_desktop_core::ProcessId::from(
                fixture.process_id(),
            ))
            .unwrap()
            .expect("a live fixture process has a token"),
        ),
        bounds: None,
        state: Default::default(),
    };

    let result = re_verify_root(ObservationRoot::Window(&window));
    assert!(
        result.is_ok(),
        "a live fixture root must pass the liveness gate: {result:?}"
    );
}

/// Finding 4(a): a clean-looking complete walk still has to pass the
/// liveness gate. Deleting the `verify_root(root)?` call site in
/// `finish_observation`'s non-shell branch would make this test observe a
/// success where the fake verifier demands a failure.
#[test]
fn a_clean_complete_walk_still_fails_when_root_reverification_fails() {
    let adapter = crate::adapter::WindowsAdapter::new();
    let window = window_for(1, "gen-1");
    let request = request_with(Deadline::after(5_000).unwrap(), false);

    let error = finish_observation(
        ObservationRoot::Window(&window),
        request,
        &adapter,
        CompletedWalk {
            chromium_root: false,
            outcome: small_complete_outcome(),
            walk_duration: Duration::ZERO,
        },
        |_| Err(window_identity_changed()),
    )
    .expect_err("a failing reverification must not be swallowed by a clean-looking walk");

    assert_eq!(error.code, ErrorCode::WindowNotFound);
}

/// Finding 4(b): the force-renderer-accessibility path skips activation
/// guidance, not liveness. Deleting the `verify_root(root)?` call ahead of
/// the force-path's early return would make this test observe a success.
#[test]
fn the_force_path_still_reverifies_before_returning_the_tree() {
    let adapter = crate::adapter::WindowsAdapter::new();
    let window = window_for(1, "gen-1");
    let request = request_with(Deadline::after(5_000).unwrap(), true);

    let error = finish_observation(
        ObservationRoot::Window(&window),
        request,
        &adapter,
        CompletedWalk {
            chromium_root: true,
            outcome: small_complete_outcome(),
            walk_duration: Duration::ZERO,
        },
        |_| Err(window_identity_changed()),
    )
    .expect_err("the force-renderer-accessibility path must not skip liveness");

    assert_eq!(error.code, ErrorCode::WindowNotFound);
}

#[test]
fn a_partial_tree_is_rejected_when_root_ownership_changes() {
    let adapter = crate::adapter::WindowsAdapter::new();
    let window = window_for(1, "gen-1");
    let request = request_with(Deadline::after(5_000).unwrap(), false);
    let fake = crate::tree::walk::walker_fake::FakeTree::default().with_chain(&[1, 2, 3]);
    let outcome = crate::tree::walk::walker_fake::walk(
        &fake,
        crate::tree::walk::walker_fake::budget(10).with_max_raw_depth(1),
    );
    assert!(!outcome.tree.is_complete());

    let error = finish_observation(
        ObservationRoot::Window(&window),
        request,
        &adapter,
        CompletedWalk {
            chromium_root: false,
            outcome,
            walk_duration: Duration::ZERO,
        },
        |_| Err(window_identity_changed()),
    )
    .expect_err("a partial tree must not bypass root ownership verification");

    assert_eq!(error.code, ErrorCode::WindowNotFound);
}

/// Finding 4(c): activation state must not be a single global flag. Two
/// different processes observed sequentially through the same adapter each
/// get their own activation pass - the second must not inherit the first's
/// "already settled" state.
#[test]
fn two_different_pids_through_one_adapter_each_get_their_own_activation_pass() {
    let adapter = crate::adapter::WindowsAdapter::new();
    let first = window_for(1, "gen-1");
    let second = window_for(2, "gen-1");
    let request = request_with(Deadline::after(5_000).unwrap(), false);

    let first_error = finish_observation(
        ObservationRoot::Window(&first),
        request,
        &adapter,
        CompletedWalk {
            chromium_root: true,
            outcome: small_complete_outcome(),
            walk_duration: Duration::ZERO,
        },
        |_| Ok(()),
    )
    .expect_err("a never-attempted process must be offered activation");
    assert!(first_error.requires_renderer_accessibility_activation());

    adapter
        .note_renderer_activation_attempted(root_process_identity(ObservationRoot::Window(&first)));

    let second_error = finish_observation(
        ObservationRoot::Window(&second),
        request,
        &adapter,
        CompletedWalk {
            chromium_root: true,
            outcome: small_complete_outcome(),
            walk_duration: Duration::ZERO,
        },
        |_| Ok(()),
    )
    .expect_err("a different process must not inherit another process's settle state");
    assert!(second_error.requires_renderer_accessibility_activation());
}

/// Finding 1: once a process's settle has run, a still-shell walk must keep
/// re-arming core's retry loop for as long as the deadline has room, rather
/// than surfacing the plain still-thin error after a single retry.
#[test]
fn a_still_shell_walk_with_generous_deadline_loops_the_marker_again() {
    let adapter = crate::adapter::WindowsAdapter::new();
    let window = window_for(1, "gen-1");
    adapter.note_renderer_activation_attempted(root_process_identity(ObservationRoot::Window(
        &window,
    )));
    let request = request_with(Deadline::after(5_000).unwrap(), false);

    let error = finish_observation(
        ObservationRoot::Window(&window),
        request,
        &adapter,
        CompletedWalk {
            chromium_root: true,
            outcome: small_complete_outcome(),
            walk_duration: Duration::ZERO,
        },
        |_| Ok(()),
    )
    .expect_err("a still-thin shell must not silently succeed");

    assert!(
        error.requires_renderer_accessibility_activation(),
        "a generous remaining deadline must keep the settle looping"
    );
}

/// The dual of the case above: once the deadline is nearly exhausted, the
/// loop must stop and hand back the plain guidance error instead of
/// re-arming a retry that has no time left to run.
#[test]
fn a_still_shell_walk_with_an_exhausted_deadline_returns_the_guidance_error() {
    let adapter = crate::adapter::WindowsAdapter::new();
    let window = window_for(1, "gen-1");
    adapter.note_renderer_activation_attempted(root_process_identity(ObservationRoot::Window(
        &window,
    )));
    let deadline = Deadline::after(1).unwrap();
    std::thread::sleep(Duration::from_millis(20));
    let request = request_with(deadline, false);

    let error = finish_observation(
        ObservationRoot::Window(&window),
        request,
        &adapter,
        CompletedWalk {
            chromium_root: true,
            outcome: small_complete_outcome(),
            walk_duration: Duration::ZERO,
        },
        |_| Ok(()),
    )
    .expect_err("a still-thin shell must not silently succeed");

    assert!(
        !error.requires_renderer_accessibility_activation(),
        "an exhausted deadline must stop the loop with plain guidance instead of looping forever"
    );
    assert_eq!(error.code, ErrorCode::ActionFailed);
}

fn thin(held_ms: u64, previous_nodes: Option<u64>) -> Option<ThinWalk> {
    Some(ThinWalk {
        held: Duration::from_millis(held_ms),
        previous_nodes,
    })
}

/// The settle decision itself: a thin tree with content, whose size held
/// across walks of this observation for the settle span.
#[test]
fn a_thin_tree_is_settled_only_with_content_and_a_held_size_after_the_settle_window() {
    let settle = THIN_TREE_SETTLE.as_millis() as u64;
    assert!(thin_tree_settled(thin(settle, Some(25)), 25, true));
    assert!(thin_tree_settled(thin(settle * 10, Some(25)), 25, true));
    assert!(!thin_tree_settled(thin(settle - 1, Some(25)), 25, true));
    assert!(!thin_tree_settled(thin(settle * 10, Some(19)), 25, true));
    assert!(!thin_tree_settled(thin(settle * 10, None), 25, true));
    assert!(!thin_tree_settled(None, 25, true));
}

/// A shell never passes: however long its size held, its documents hold no
/// content.
#[test]
fn a_shell_never_settles_however_long_its_size_held() {
    let settle = THIN_TREE_SETTLE.as_millis() as u64;
    assert!(!thin_tree_settled(
        thin(settle * 1_000, Some(19)),
        19,
        false
    ));
}

/// Drives the core loop's bookkeeping (`settle_after_walk`'s rule, reproduced
/// on a virtual clock) and this predicate over a sequence of thin walks, each
/// `(start_ms, duration_ms, nodes)` after activation, and returns the start of
/// the first walk taken as settled.
fn first_settled_walk(walks: &[(u64, u64, u64)]) -> Option<u64> {
    let mut previous: Option<u64> = None;
    let mut stable_since: Option<u64> = None;
    for &(start, duration, nodes) in walks {
        let held = stable_since.map_or(0, |since| start.saturating_sub(since));
        if thin_tree_settled(thin(held, previous), nodes, true) {
            return Some(start);
        }
        if previous != Some(nodes) {
            stable_since = Some(start + duration);
        }
        previous = Some(nodes);
    }
    None
}

/// The reviewed path: walks about 35, 95, 205 and 415 ms after activation,
/// part of the page (20 nodes) published by 205 ms and the rest (25 nodes) at
/// 600 ms. The two equal partial walks are too close together to pass, and
/// the change at 600 ms starts the span over, so only the whole page settles,
/// a span after it first showed.
#[test]
fn a_page_published_in_two_steps_settles_only_on_the_whole_page() {
    let walks = [
        (25, 10, 19),
        (85, 10, 19),
        (195, 10, 20),
        (405, 10, 20),
        (615, 10, 25),
        (1_025, 10, 25),
        (1_435, 10, 25),
    ];
    let settled = first_settled_walk(&walks).expect("the whole page settles");
    assert_eq!(
        settled, 1_435,
        "settled on a walk of the whole page, a span after it showed"
    );
    assert!(settled >= 625 + THIN_TREE_SETTLE.as_millis() as u64);
}

/// Two equal walks close together never pass, however long ago the settle
/// ran; a page that keeps its size settles once the span has passed.
#[test]
fn equal_walks_close_together_wait_and_a_held_size_settles_after_the_span() {
    let settle = THIN_TREE_SETTLE.as_millis() as u64;
    assert_eq!(
        first_settled_walk(&[(5_000, 10, 25), (5_050, 10, 25)]),
        None
    );
    let walks = [
        (25, 10, 25),
        (85, 10, 25),
        (195, 10, 25),
        (405, 10, 25),
        (815, 10, 25),
    ];
    let settled = first_settled_walk(&walks).expect("a held size settles");
    assert!(settled >= 35 + settle);
    assert_eq!(
        settled, 815,
        "the first walk a span after the size first showed"
    );
}

/// The settle window is a fixed span, not a share of the deadline.
#[test]
fn the_settle_window_is_independent_of_the_deadline_and_shorter_than_a_default_read() {
    assert!(
        THIN_TREE_SETTLE
            < Duration::from_millis(agent_desktop_core::snapshot::DEFAULT_SNAPSHOT_TIMEOUT_MS) / 2
    );
}

fn read(property: TreeProperty, value: PropertyValue) -> (TreeProperty, PropertyOutcome) {
    (property, PropertyOutcome::Known(value))
}

fn control(type_id: i32) -> (TreeProperty, PropertyOutcome) {
    read(TreeProperty::ControlType, PropertyValue::Number(type_id))
}

fn named(name: &str) -> (TreeProperty, PropertyOutcome) {
    read(TreeProperty::Name, PropertyValue::Text(name.into()))
}

const DOCUMENT: i32 = 50030;
const GROUP: i32 = 50026;
const BUTTON: i32 = 50000;

/// The shape a cold Electron window showed: a document holding one empty,
/// unnamed group, beside a document with no children.
fn shell_outcome() -> WalkOutcome {
    let fake = crate::tree::walk::walker_fake::FakeTree::default()
        .with_children(1, &[2, 4])
        .with_children(2, &[3])
        .reading(2, &[control(DOCUMENT)])
        .reading(3, &[control(GROUP)])
        .reading(4, &[control(DOCUMENT)]);
    crate::tree::walk::walker_fake::walk(&fake, crate::tree::walk::walker_fake::budget(10))
}

/// The same window once its page published: the second document holds a
/// named button.
fn page_outcome() -> WalkOutcome {
    let fake = crate::tree::walk::walker_fake::FakeTree::default()
        .with_children(1, &[2, 4])
        .with_children(2, &[3])
        .with_children(4, &[5])
        .reading(2, &[control(DOCUMENT)])
        .reading(3, &[control(GROUP)])
        .reading(4, &[control(DOCUMENT)])
        .reading(5, &[control(BUTTON), named("A-1")]);
    crate::tree::walk::walker_fake::walk(&fake, crate::tree::walk::walker_fake::budget(10))
}

#[test]
fn the_shell_shape_holds_no_content_and_the_page_shape_does() {
    let shell = shell_outcome();
    let page = page_outcome();
    assert!(shell.tree.is_complete() && page.tree.is_complete());
    assert!(!shell.tree.has_document_content());
    assert!(page.tree.has_document_content());
}

fn nodes_of(outcome: &WalkOutcome) -> u64 {
    outcome.stats.traversal.nodes_visited
}

fn shell_walk(outcome: WalkOutcome) -> CompletedWalk {
    CompletedWalk {
        chromium_root: true,
        outcome,
        walk_duration: Duration::ZERO,
    }
}

/// One walk of an observation whose settle is in `settle`, with a capture's
/// recorded count in `recorded`.
fn finish_with(
    adapter: &crate::adapter::WindowsAdapter,
    window: &agent_desktop_core::WindowInfo,
    outcome: WalkOutcome,
    settle: Option<agent_desktop_core::SettleProgress>,
    recorded: Option<u64>,
) -> Result<ObservedTree, AdapterError> {
    let mut request = request_with(Deadline::after(60_000).unwrap(), false);
    request.observation_mode.settle = settle;
    request.observation_mode.settled_thin_nodes = recorded;
    finish_observation(
        ObservationRoot::Window(window),
        request,
        adapter,
        shell_walk(outcome),
        |_| Ok(()),
    )
}

/// A settle that ran two spans ago, whose walks have seen `previous` since
/// then (`None`: no walk yet).
fn settled_long_ago(previous: Option<u64>) -> Option<agent_desktop_core::SettleProgress> {
    let long_ago = std::time::Instant::now()
        .checked_sub(THIN_TREE_SETTLE * 2)
        .expect("the clock reaches back two settle windows");
    Some(agent_desktop_core::SettleProgress {
        activated_at: long_ago,
        previous_thin_nodes: previous,
        stable_since: previous.map(|_| long_ago),
    })
}

/// The reported case: a small page past its observation's settle, whose size
/// held, is returned and marked with its count.
#[test]
fn a_small_page_that_held_its_size_after_this_observations_settle_is_returned() {
    let adapter = crate::adapter::WindowsAdapter::new();
    let window = window_for(1, "gen-1");
    let nodes = nodes_of(&page_outcome());

    let tree = finish_with(
        &adapter,
        &window,
        page_outcome(),
        settled_long_ago(Some(nodes)),
        None,
    )
    .expect("a page that held its size after the settle is the window's tree");
    assert_eq!(tree.settled_thin_nodes(), Some(nodes));
}

/// The second warning: a shell whose size held long past the settle is never
/// taken for the window's tree.
#[test]
fn a_shell_whose_size_held_past_the_settle_keeps_the_loop_going() {
    let adapter = crate::adapter::WindowsAdapter::new();
    let window = window_for(1, "gen-1");
    let nodes = nodes_of(&shell_outcome());

    let error = finish_with(
        &adapter,
        &window,
        shell_outcome(),
        settled_long_ago(Some(nodes)),
        None,
    )
    .expect_err("a shell is never the window's tree");
    assert!(error.requires_renderer_accessibility_activation());
}

/// The first warning: what one observation saw never reaches another. A walk
/// with no settle of its own (a new observation, of this window or another
/// one of the same process, through the same adapter) waits, even when the
/// adapter settled that process before.
#[test]
fn a_walk_without_its_own_settle_waits_whatever_the_process_saw_before() {
    let adapter = crate::adapter::WindowsAdapter::new();
    let window_a = window_for(1, "gen-1");
    let nodes = nodes_of(&page_outcome());
    finish_with(
        &adapter,
        &window_a,
        page_outcome(),
        settled_long_ago(Some(nodes)),
        None,
    )
    .expect("window A settles in its own observation");
    adapter.note_renderer_activation_attempted(root_process_identity(ObservationRoot::Window(
        &window_a,
    )));

    let mut window_b = window_for(1, "gen-1");
    window_b.id = "w-2".into();
    let error = finish_with(&adapter, &window_b, page_outcome(), None, None)
        .expect_err("window B has not settled in its own observation");
    assert!(error.requires_renderer_accessibility_activation());
}

/// A size first seen just now (even long after the settle), or a walk with
/// nothing before it, keeps a same-size page in the loop; so does a size that
/// changed.
#[test]
fn a_fresh_settle_a_first_walk_or_a_changed_size_keeps_the_loop_going() {
    let adapter = crate::adapter::WindowsAdapter::new();
    let window = window_for(1, "gen-1");
    let nodes = nodes_of(&page_outcome());
    let fresh = Some(agent_desktop_core::SettleProgress {
        activated_at: std::time::Instant::now(),
        previous_thin_nodes: Some(nodes),
        stable_since: Some(std::time::Instant::now()),
    });
    let just_seen =
        settled_long_ago(Some(nodes)).map(|settle| agent_desktop_core::SettleProgress {
            stable_since: Some(std::time::Instant::now()),
            ..settle
        });

    for settle in [
        fresh,
        just_seen,
        settled_long_ago(None),
        settled_long_ago(Some(nodes - 1)),
    ] {
        let error = finish_with(&adapter, &window, page_outcome(), settle, None)
            .expect_err("not settled yet");
        assert!(error.requires_renderer_accessibility_activation());
    }
}

/// The recorded-count decision itself: only exactly the recorded count.
#[test]
fn only_exactly_the_recorded_settled_count_skips_the_settle() {
    assert!(is_recorded_settled_tree(Some(25), 25));
    assert!(!is_recorded_settled_tree(Some(25), 19));
    assert!(!is_recorded_settled_tree(Some(25), 26));
    assert!(!is_recorded_settled_tree(None, 25));
}

/// A resolution whose first walk comes back at the recorded count, with
/// content, returns at once with no settle; another count, no record, or a
/// shell at the recorded count waits.
#[test]
fn only_a_page_at_the_recorded_count_returns_without_a_settle() {
    let adapter = crate::adapter::WindowsAdapter::new();
    let window = window_for(1, "gen-1");
    let page = nodes_of(&page_outcome());
    let shell = nodes_of(&shell_outcome());

    let tree = finish_with(&adapter, &window, page_outcome(), None, Some(page))
        .expect("the recorded settled page needs no settle");
    assert_eq!(tree.settled_thin_nodes(), Some(page));

    for (outcome, recorded) in [
        (page_outcome(), Some(page + 6)),
        (page_outcome(), None),
        (shell_outcome(), Some(shell)),
    ] {
        let error = finish_with(&adapter, &window, outcome, None, recorded)
            .expect_err("waits for the settle");
        assert!(error.requires_renderer_accessibility_activation());
    }
}

/// `walk_fault_error` only folds a failure's structured `details` into the
/// aggregate, never its `message`. Pinning that here means a marker string
/// planted in an upstream failure's message can never leak into the
/// aggregated error this crate hands to session trace segments.
#[test]
fn walk_fault_error_never_folds_a_failures_message_text_into_the_aggregate() {
    const MARKER: &str = "zzsecretmarkerzz";
    let failure = AdapterError::new(ErrorCode::ActionFailed, MARKER)
        .with_details(json!({ "kind": "child_enumeration_failed" }));

    let aggregated = walk_fault_error(&[failure]);

    assert!(!aggregated.message.contains(MARKER));
    let serialized = aggregated
        .details
        .as_ref()
        .map(serde_json::Value::to_string)
        .unwrap_or_default();
    assert!(!serialized.contains(MARKER));
}
