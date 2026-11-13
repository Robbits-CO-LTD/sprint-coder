// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::*;

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

fn history(since_ms: u64, previous_nodes: Option<u64>) -> crate::adapter::ThinWalkHistory {
    crate::adapter::ThinWalkHistory {
        since_activation: Duration::from_millis(since_ms),
        previous_nodes,
    }
}

/// The settle decision itself: only a thin tree whose size held across two
/// walks after the settle, once the settle is old enough, counts as settled.
#[test]
fn a_thin_tree_is_settled_only_when_its_size_held_after_the_settle_window() {
    let settle = THIN_TREE_SETTLE.as_millis() as u64;
    assert!(thin_tree_settled(history(settle, Some(25)), 25));
    assert!(thin_tree_settled(history(settle * 10, Some(25)), 25));
    assert!(!thin_tree_settled(history(settle - 1, Some(25)), 25));
    assert!(!thin_tree_settled(history(settle * 10, Some(19)), 25));
    assert!(!thin_tree_settled(history(settle * 10, None), 25));
}

/// The settle window is a fixed span, not a share of the deadline: a long
/// deadline must not keep a small page in the loop.
#[test]
fn the_settle_window_is_independent_of_the_deadline_and_shorter_than_a_default_read() {
    assert!(
        THIN_TREE_SETTLE
            < Duration::from_millis(agent_desktop_core::snapshot::DEFAULT_SNAPSHOT_TIMEOUT_MS) / 2
    );
}

fn shell_walk(outcome: WalkOutcome) -> CompletedWalk {
    CompletedWalk {
        chromium_root: true,
        outcome,
        walk_duration: Duration::ZERO,
    }
}

fn finish(
    adapter: &crate::adapter::WindowsAdapter,
    window: &agent_desktop_core::WindowInfo,
    outcome: WalkOutcome,
) -> Result<ObservedTree, AdapterError> {
    let request = request_with(Deadline::after(60_000).unwrap(), false);
    finish_observation(
        ObservationRoot::Window(window),
        request,
        adapter,
        shell_walk(outcome),
        |_| Ok(()),
    )
}

fn finish_recorded(
    adapter: &crate::adapter::WindowsAdapter,
    window: &agent_desktop_core::WindowInfo,
    outcome: WalkOutcome,
    recorded: Option<u64>,
) -> Result<ObservedTree, AdapterError> {
    let mut request = request_with(Deadline::after(60_000).unwrap(), false);
    request.observation_mode.settled_thin_nodes = recorded;
    finish_observation(
        ObservationRoot::Window(window),
        request,
        adapter,
        shell_walk(outcome),
        |_| Ok(()),
    )
}

fn small_nodes() -> u64 {
    small_complete_outcome().stats.traversal.nodes_visited
}

/// The recorded-count decision itself: only exactly the recorded count.
#[test]
fn only_exactly_the_recorded_settled_count_skips_the_settle() {
    assert!(is_recorded_settled_tree(Some(25), 25));
    assert!(!is_recorded_settled_tree(Some(25), 19));
    assert!(!is_recorded_settled_tree(Some(25), 26));
    assert!(!is_recorded_settled_tree(None, 25));
}

/// A resolution of a ref captured from a settled small tree, whose first walk
/// comes back at the recorded count, returns that tree at once, with no settle
/// run for the process, and marks it settled again.
#[test]
fn a_first_walk_at_the_recorded_count_returns_without_a_settle() {
    let adapter = crate::adapter::WindowsAdapter::new();
    let window = window_for(1, "gen-1");

    let tree = finish_recorded(
        &adapter,
        &window,
        small_complete_outcome(),
        Some(small_nodes()),
    )
    .expect("the recorded settled tree needs no settle");
    assert_eq!(tree.settled_thin_nodes(), Some(small_nodes()));
    assert!(
        !adapter.renderer_activation_attempted(&root_process_identity(ObservationRoot::Window(
            &window
        )))
    );
}

/// A walk at another count (a renderer back at its shell) or with no record
/// is settled as for any first read.
#[test]
fn a_walk_at_another_count_or_without_a_record_is_settled_as_usual() {
    let adapter = crate::adapter::WindowsAdapter::new();
    let window = window_for(1, "gen-1");

    let other = finish_recorded(
        &adapter,
        &window,
        small_complete_outcome(),
        Some(small_nodes() + 6),
    )
    .expect_err("another count is not the recorded tree");
    assert!(other.requires_renderer_accessibility_activation());

    let none = finish_recorded(&adapter, &window, small_complete_outcome(), None)
        .expect_err("no record waits for the settle");
    assert!(none.requires_renderer_accessibility_activation());
}

/// The tree the settle accepts carries the mark a capture records.
#[test]
fn a_tree_taken_after_the_settle_is_marked_with_its_count() {
    let adapter = crate::adapter::WindowsAdapter::new();
    let window = window_for(1, "gen-1");
    settled_long_ago(&adapter, &window);

    finish(&adapter, &window, small_complete_outcome()).expect_err("first walk");
    let tree = finish(&adapter, &window, small_complete_outcome()).expect("settled");
    assert_eq!(tree.settled_thin_nodes(), Some(small_nodes()));
}

fn settled_long_ago(
    adapter: &crate::adapter::WindowsAdapter,
    window: &agent_desktop_core::WindowInfo,
) {
    let at = std::time::Instant::now()
        .checked_sub(THIN_TREE_SETTLE * 2)
        .expect("the clock reaches back two settle windows");
    adapter.note_renderer_activation_at(root_process_identity(ObservationRoot::Window(window)), at);
}

/// The reported case: a small page under the shell ceiling, settled long
/// enough ago, returns its tree on the second walk of the same size instead of
/// looping until a long deadline runs out.
#[test]
fn a_small_page_that_held_its_size_after_the_settle_is_returned_complete() {
    let adapter = crate::adapter::WindowsAdapter::new();
    let window = window_for(1, "gen-1");
    settled_long_ago(&adapter, &window);

    let first = finish(&adapter, &window, small_complete_outcome())
        .expect_err("the first walk after the settle has nothing to compare with");
    assert!(first.requires_renderer_accessibility_activation());

    finish(&adapter, &window, small_complete_outcome())
        .expect("a thin tree that held its size after the settle is the window's tree");
}

/// A build that is still landing changes the walk's size, so it keeps the
/// settle loop going however old the settle is.
#[test]
fn a_thin_tree_that_changed_size_keeps_the_settle_looping() {
    let adapter = crate::adapter::WindowsAdapter::new();
    let window = window_for(1, "gen-1");
    settled_long_ago(&adapter, &window);
    let grown = || {
        crate::tree::walk::walker_fake::walk(
            &crate::tree::walk::walker_fake::FakeTree::default().with_chain(&[1, 2, 3]),
            crate::tree::walk::walker_fake::budget(10),
        )
    };
    assert_ne!(
        grown().stats.traversal.nodes_visited,
        small_complete_outcome().stats.traversal.nodes_visited
    );
    assert!(grown().tree.is_complete());

    finish(&adapter, &window, small_complete_outcome()).expect_err("first walk");
    let changed = finish(&adapter, &window, grown())
        .expect_err("a walk whose size changed is a build still landing");
    assert!(changed.requires_renderer_accessibility_activation());
}

/// A settle that ran just now does not take a same-size thin tree for the
/// window's tree yet: the build may not have landed.
#[test]
fn a_fresh_settle_keeps_a_same_size_thin_tree_in_the_loop() {
    let adapter = crate::adapter::WindowsAdapter::new();
    let window = window_for(1, "gen-1");
    adapter.note_renderer_activation_attempted(root_process_identity(ObservationRoot::Window(
        &window,
    )));

    finish(&adapter, &window, small_complete_outcome()).expect_err("first walk");
    let second = finish(&adapter, &window, small_complete_outcome())
        .expect_err("a settle younger than the settle window keeps looping");
    assert!(second.requires_renderer_accessibility_activation());
}

/// A walk of a process whose settle never ran records nothing: the first
/// thin walk after the settle still has nothing to compare with.
#[test]
fn a_walk_before_the_settle_is_not_counted_as_a_settled_walk() {
    let adapter = crate::adapter::WindowsAdapter::new();
    let window = window_for(1, "gen-1");

    finish(&adapter, &window, small_complete_outcome()).expect_err("before the settle");
    settled_long_ago(&adapter, &window);
    let first_after = finish(&adapter, &window, small_complete_outcome())
        .expect_err("the walk before the settle must not count");
    assert!(first_after.requires_renderer_accessibility_activation());
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
