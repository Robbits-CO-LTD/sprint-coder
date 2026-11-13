// Added by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::*;

/// A process with no window of its own (a helper, or a root whose window
/// does not matter to the count).
fn candidate(pid: u32, parent: Option<u32>, created: Option<u64>) -> Candidate {
    with_window(pid, parent, created, Some(false))
}

fn with_window(
    pid: u32,
    parent: Option<u32>,
    created: Option<u64>,
    has_window: Option<bool>,
) -> Candidate {
    Candidate {
        pid: ProcessId::from(pid),
        parent: parent.map(ProcessId::from),
        created,
        has_window,
    }
}

/// A top-level window of `owner` with the given state; the handle is never
/// read by the count.
fn top(owner: u32, visible: bool, cloaked: bool, iconic: bool, tool: bool) -> TopWindow {
    TopWindow {
        window: EnumeratedWindow {
            handle: std::ptr::null_mut(),
            visible,
            iconic,
            cloaked,
            tool,
            rect: agent_desktop_core::Rect {
                x: 0.0,
                y: 0.0,
                width: if iconic { 0.0 } else { 400.0 },
                height: if iconic { 0.0 } else { 300.0 },
            },
        },
        owner: ProcessId::from(owner),
        hosted: None,
    }
}

#[test]
fn a_cloaked_window_on_another_desktop_still_counts_as_a_window_of_its_own() {
    let windows = [top(300, true, true, false, false)];
    assert!(owns_a_shown_window(ProcessId::from(300), &windows));
}

#[test]
fn a_minimized_or_tool_window_still_counts_as_a_window_of_its_own() {
    assert!(owns_a_shown_window(
        ProcessId::from(300),
        &[top(300, true, false, true, false)]
    ));
    assert!(owns_a_shown_window(
        ProcessId::from(300),
        &[top(300, true, false, false, true)]
    ));
}

#[test]
fn hidden_windows_alone_make_no_window_of_its_own() {
    // A Chromium helper's message windows: hidden, and some of them cloaked
    // or tool windows too; plus a visible window of another process.
    let windows = [
        top(301, false, false, false, false),
        top(301, false, true, false, true),
        top(100, true, false, false, false),
    ];
    assert!(!owns_a_shown_window(ProcessId::from(301), &windows));
    assert!(!owns_a_shown_window(ProcessId::from(999), &[]));
}

#[test]
fn a_window_a_shell_frame_hosts_for_the_process_counts_as_its_own() {
    let mut frame = top(50, true, false, false, false);
    frame.hosted = Some(ProcessId::from(300));
    assert!(owns_a_shown_window(ProcessId::from(300), &[frame]));
}

#[test]
fn children_whose_only_windows_are_cloaked_or_minimized_are_instances_of_their_own() {
    // A (100) started B (300, its window cloaked on another desktop) and
    // C (400, minimized), plus a hidden-window helper (101).
    let windows = [
        top(100, true, false, false, false),
        top(101, false, false, false, false),
        top(300, true, true, false, false),
        top(400, true, false, true, false),
    ];
    let candidates: Vec<Candidate> = [
        (100, 4, 1_000),
        (101, 100, 1_100),
        (300, 100, 2_000),
        (400, 100, 3_000),
    ]
    .into_iter()
    .map(|(pid, parent, created)| {
        with_window(
            pid,
            Some(parent),
            Some(created),
            Some(owns_a_shown_window(ProcessId::from(pid), &windows)),
        )
    })
    .collect();
    assert_eq!(instance_roots(&candidates), pids(&[100, 300, 400]));
}

#[test]
fn a_child_with_a_window_of_its_own_is_an_instance_of_its_own() {
    // Instance A (100, with its window) started B (300) from the same
    // executable as a "new window"; B shows a window of its own.
    let candidates = [
        with_window(100, Some(4), Some(1_000), Some(true)),
        candidate(101, Some(100), Some(1_100)),
        candidate(102, Some(100), Some(1_150)),
        candidate(103, Some(100), Some(1_180)),
        with_window(300, Some(100), Some(2_000), Some(true)),
    ];
    assert_eq!(instance_roots(&candidates), pids(&[100, 300]));
}

#[test]
fn helpers_below_a_child_instance_are_counted_inside_that_child() {
    let candidates = [
        with_window(100, Some(4), Some(1_000), Some(true)),
        with_window(300, Some(100), Some(2_000), Some(true)),
        candidate(301, Some(300), Some(2_100)),
        candidate(302, Some(300), Some(2_200)),
    ];
    assert_eq!(instance_roots(&candidates), pids(&[100, 300]));
}

#[test]
fn a_child_whose_windows_could_not_be_read_is_an_instance_of_its_own() {
    let candidates = [
        with_window(100, Some(4), Some(1_000), None),
        with_window(101, Some(100), Some(1_100), None),
        with_window(102, Some(100), Some(1_200), None),
    ];
    assert_eq!(instance_roots(&candidates), pids(&[100, 101, 102]));
}

fn pids(values: &[u32]) -> Vec<ProcessId> {
    values.iter().copied().map(ProcessId::from).collect()
}

#[test]
fn one_electron_app_with_three_helpers_is_one_instance() {
    // The browser process (started by the shell, pid 4) and its GPU,
    // renderer and utility processes, all from the same executable.
    let candidates = [
        with_window(1324, Some(4), Some(1_000), Some(true)),
        candidate(58064, Some(1324), Some(1_200)),
        candidate(33872, Some(1324), Some(1_300)),
        candidate(23344, Some(1324), Some(1_400)),
    ];
    assert_eq!(instance_roots(&candidates), pids(&[1324]));
}

#[test]
fn a_helper_listed_before_its_parent_is_still_counted_inside_it() {
    let candidates = [
        candidate(58064, Some(1324), Some(1_200)),
        candidate(1324, Some(4), Some(1_000)),
    ];
    assert_eq!(instance_roots(&candidates), pids(&[1324]));
}

#[test]
fn two_separate_instances_with_helpers_are_two_instances() {
    let candidates = [
        candidate(100, Some(4), Some(1_000)),
        candidate(101, Some(100), Some(1_100)),
        candidate(200, Some(4), Some(2_000)),
        candidate(201, Some(200), Some(2_100)),
        candidate(202, Some(200), Some(2_200)),
    ];
    assert_eq!(instance_roots(&candidates), pids(&[100, 200]));
}

#[test]
fn a_parent_pid_reused_by_a_later_process_is_not_the_parent() {
    // 300's real parent exited and its pid 100 was reused by a process
    // created after 300, so 300 is an instance of its own.
    let candidates = [
        candidate(100, Some(4), Some(5_000)),
        candidate(300, Some(100), Some(1_000)),
    ];
    assert_eq!(instance_roots(&candidates), pids(&[100, 300]));
}

#[test]
fn a_child_created_at_the_same_tick_as_its_parent_is_not_taken_as_its_child() {
    let candidates = [
        candidate(100, Some(4), Some(1_000)),
        candidate(101, Some(100), Some(1_000)),
    ];
    assert_eq!(instance_roots(&candidates), pids(&[100, 101]));
}

#[test]
fn a_parent_that_is_another_executable_leaves_the_process_a_root() {
    // 500 was started by a launcher (pid 40) that is not a candidate.
    let candidates = [
        candidate(500, Some(40), Some(1_000)),
        candidate(501, Some(500), Some(1_100)),
    ];
    assert_eq!(instance_roots(&candidates), pids(&[500]));
}

#[test]
fn an_unknown_time_or_parent_counts_as_an_instance_of_its_own() {
    let candidates = [
        candidate(100, Some(4), Some(1_000)),
        candidate(101, Some(100), None),
        candidate(102, None, Some(1_200)),
    ];
    assert_eq!(instance_roots(&candidates), pids(&[100, 101, 102]));

    let unknown_parent_time = [
        candidate(100, Some(4), None),
        candidate(101, Some(100), Some(1_100)),
    ];
    assert_eq!(instance_roots(&unknown_parent_time), pids(&[100, 101]));
}

#[test]
fn a_process_naming_itself_as_parent_is_a_root() {
    let candidates = [candidate(100, Some(100), Some(1_000))];
    assert_eq!(instance_roots(&candidates), pids(&[100]));
}

#[test]
fn no_running_process_is_no_instance() {
    assert!(instance_roots(&[]).is_empty());
}

#[test]
fn the_ambiguity_suggestion_lists_each_instance_and_the_way_out() {
    let error = ambiguous_instances(&[
        (ProcessId::from(100), Some("Profile A".to_string())),
        (ProcessId::from(200), None),
    ]);
    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
    let suggestion = error.suggestion.as_deref().expect("has a suggestion");
    assert!(suggestion.contains("2 instances"), "{suggestion}");
    assert!(
        suggestion.contains("pid 100 (\"Profile A\")"),
        "{suggestion}"
    );
    assert!(suggestion.contains("pid 200"), "{suggestion}");
    assert!(suggestion.contains("--no-attach"), "{suggestion}");
}
