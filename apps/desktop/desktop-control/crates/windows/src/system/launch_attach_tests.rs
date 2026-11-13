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
