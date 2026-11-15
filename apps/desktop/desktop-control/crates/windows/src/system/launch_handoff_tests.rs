// Added by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::*;
use agent_desktop_core::WindowState;

fn window(id: &str, pid: u32, instance: Option<&str>) -> WindowInfo {
    WindowInfo {
        id: id.to_string(),
        title: String::new(),
        app: "app.exe".to_string(),
        pid: ProcessId::from(pid),
        process_instance: instance.map(str::to_string),
        bounds: None,
        state: WindowState {
            is_focused: false,
            accessible: true,
            minimized: Some(false),
            visible: Some(true),
        },
    }
}

#[test]
fn a_child_created_while_its_parent_lived_is_the_parents() {
    assert!(created_within((100, None), 100));
    assert!(created_within((100, None), 500));
    assert!(created_within((100, Some(500)), 500));
}

#[test]
fn a_process_created_outside_the_parents_lifetime_is_not_its_child() {
    assert!(
        !created_within((100, None), 99),
        "created before the parent"
    );
    assert!(
        !created_within((100, Some(500)), 501),
        "created after the parent exited, so its parent pid names a reused pid"
    );
}

#[test]
fn only_a_window_of_a_listed_owner_with_the_same_instance_is_taken() {
    let owners = vec![(ProcessId::from(20), Some("instance-20".to_string()))];
    let windows = vec![
        window("w-1", 30, Some("instance-30")),
        window("w-2", 20, Some("instance-other")),
        window("w-3", 20, Some("instance-20")),
    ];

    let found = owned_window(windows, &owners).expect("the owner's window is found");

    assert_eq!(found.id, "w-3");
}

#[test]
fn a_window_of_another_process_is_never_taken() {
    let owners = vec![(ProcessId::from(20), Some("instance-20".to_string()))];
    let windows = vec![window("w-1", 30, Some("instance-30"))];

    assert!(owned_window(windows, &owners).is_none());
}

#[test]
fn an_owner_without_an_instance_cannot_be_matched() {
    let owners = vec![(ProcessId::from(20), None)];
    let windows = vec![window("w-1", 20, None)];

    assert!(owned_window(windows, &owners).is_none());
}

fn ids(list: &[&str]) -> HashSet<String> {
    list.iter().map(|id| id.to_string()).collect()
}

fn one(found: HandoffLook) -> WindowInfo {
    match found {
        HandoffLook::One(window) => window,
        other => panic!("expected one window, got {other:?}"),
    }
}

/// A single-instance app's running instance shows the window the launch asked
/// for: only a window of that instance that was not shown before the launch
/// (new, or hidden until now) is taken, never one it already showed (the
/// user's), nor a new window of another process, nor one whose owner pid now
/// names another process.
#[test]
fn a_handoff_takes_only_a_window_the_running_instance_showed_after_the_launch() {
    let targets = vec![(ProcessId::from(20), Some("instance-20".to_string()))];
    let before = ids(&["w-1", "w-2"]);
    let windows = vec![
        window("w-1", 20, Some("instance-20")),
        window("w-3", 30, Some("instance-30")),
        window("w-4", 20, Some("instance-other")),
        window("w-5", 20, Some("instance-20")),
    ];

    let found = one(pick_handoff_window(windows, &targets, &before, false));

    assert_eq!(found.id, "w-5");
    assert_eq!(found.pid, ProcessId::from(20));
}

#[test]
fn a_handoff_with_only_old_windows_takes_none() {
    let targets = vec![(ProcessId::from(20), Some("instance-20".to_string()))];
    let before = ids(&["w-1"]);
    let windows = vec![
        window("w-1", 20, Some("instance-20")),
        window("w-9", 30, Some("instance-30")),
    ];

    assert_eq!(
        pick_handoff_window(windows, &targets, &before, false),
        HandoffLook::None
    );
}

/// Two windows the running instances showed after the launch (the launch's
/// and one the user opened in another profile at the same time) cannot be
/// told apart, so neither is taken (and neither is restacked).
#[test]
fn two_new_windows_are_not_taken() {
    let targets = vec![
        (ProcessId::from(20), Some("instance-20".to_string())),
        (ProcessId::from(21), Some("instance-21".to_string())),
    ];
    let before = ids(&[]);
    let same_instance = vec![
        window("w-5", 20, Some("instance-20")),
        window("w-6", 20, Some("instance-20")),
    ];
    assert_eq!(
        pick_handoff_window(same_instance, &targets, &before, false),
        HandoffLook::Several
    );
    let two_instances = vec![
        window("w-5", 20, Some("instance-20")),
        window("w-7", 21, Some("instance-21")),
    ];
    assert_eq!(
        pick_handoff_window(two_instances, &targets, &before, false),
        HandoffLook::Several
    );
}

/// When several instances already showed windows (two browser profiles),
/// even a single new window cannot be tied to this launch.
#[test]
fn a_new_window_beside_several_instances_with_windows_is_not_taken() {
    let targets = vec![(ProcessId::from(20), Some("instance-20".to_string()))];
    let windows = vec![window("w-5", 20, Some("instance-20"))];
    assert_eq!(
        pick_handoff_window(windows, &targets, &ids(&[]), true),
        HandoffLook::Several
    );
}

#[test]
fn several_instances_are_counted_only_among_the_targets_with_shown_windows() {
    let owners: HashSet<ProcessId> = [20, 21, 99].into_iter().map(ProcessId::from).collect();
    let pid = |n: u32| ProcessId::from(n);
    assert!(several_instances_show_windows(&owners, &[pid(20), pid(21)]));
    assert!(!several_instances_show_windows(
        &owners,
        &[pid(20), pid(22)]
    ));
    assert!(
        !several_instances_show_windows(&owners, &[pid(20)]),
        "one browser process with its helpers is one instance"
    );
}

/// A live descendant is waited for until the deadline, even while an
/// instance of the same executable runs: a launcher whose GUI child is slow
/// to show its window still gets that window as its own (`new_instance`).
#[test]
fn a_running_descendant_keeps_the_watch_until_the_deadline() {
    assert_eq!(after_exit(true, true, true), AfterExit::KeepWatching);
    assert_eq!(after_exit(true, true, false), AfterExit::KeepWatching);
    assert_eq!(after_exit(true, false, false), AfterExit::KeepWatching);
    assert_eq!(after_exit(true, false, true), AfterExit::KeepWatching);
}

/// Without a live descendant, a running instance is watched only for the
/// short handoff wait, and with neither the watch stops at once.
#[test]
fn without_a_running_descendant_the_handoff_wait_bounds_the_watch() {
    assert_eq!(after_exit(false, true, false), AfterExit::KeepWatching);
    assert_eq!(after_exit(false, true, true), AfterExit::Stop);
    assert_eq!(after_exit(false, false, false), AfterExit::Stop);
    assert_eq!(after_exit(false, false, true), AfterExit::Stop);
}
#[test]
fn the_handoff_wait_is_short_and_bounded() {
    assert!(HANDOFF_WINDOW_WAIT <= Duration::from_secs(10));
    assert!(HANDOFF_WINDOW_WAIT >= Duration::from_secs(1));
}

/// The ids read before a launch are the ids the window inventory reports,
/// so a window that was shown before is recognised as old: every listed
/// window is among them, and they are no more than the listed ones.
#[cfg(target_os = "windows")]
#[test]
fn the_windows_read_before_a_launch_use_the_inventory_ids() {
    let (before, _, all) = shown_windows().expect("top-level windows can be enumerated");
    assert!(
        before.is_subset(&all),
        "every shown window is among all windows"
    );
    assert!(all.len() >= before.len());
    assert!(before.iter().all(|id| id.starts_with("w-")));
    let deadline = Deadline::after(5_000).expect("deadline");
    let filter = WindowFilter {
        focused_only: false,
        app: None,
    };
    let listed = super::super::list_windows_live(&filter, deadline).expect("windows can be listed");
    let unknown: Vec<&str> = listed
        .iter()
        .map(|window| window.id.as_str())
        .filter(|id| !before.contains(*id))
        .collect();
    // A window may open or close between the two reads; almost all match.
    assert!(
        unknown.len() <= 2,
        "listed windows missing from the enumeration: {unknown:?}"
    );
    assert!(
        before.len() <= listed.len() + 2,
        "only shown windows are read: {} read, {} listed",
        before.len(),
        listed.len()
    );
}

#[cfg(target_os = "windows")]
fn system_exe(name: &str) -> std::path::PathBuf {
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    std::path::PathBuf::from(root).join("System32").join(name)
}

#[cfg(target_os = "windows")]
fn lineage_of(child: &std::process::Child) -> Lineage {
    let pid = ProcessId::from(child.id());
    let token = crate::system::process_identity::token_for_pid(pid)
        .expect("token read")
        .expect("token for a live child");
    Lineage::new(pid, &token, Process::open(pid).expect("open the child"))
}

#[cfg(target_os = "windows")]
fn wait_for_exit(lineage: &Lineage) {
    let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !lineage.launched_has_exited() {
        assert!(std::time::Instant::now() < until, "the process exits");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

/// A process that exits without starting anything leaves no descendant to
/// wait for, so a launch can stop at once.
#[cfg(target_os = "windows")]
#[test]
fn a_process_that_exits_alone_leaves_no_live_descendant() {
    use std::process::{Command, Stdio};
    let mut child = Command::new(system_exe("cmd.exe"))
        .args(["/d", "/c", "exit"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("start cmd");
    let mut lineage = lineage_of(&child);
    wait_for_exit(&lineage);
    lineage.refresh();
    assert!(lineage.live_descendants().is_empty());
    let _ = child.wait();
}

/// A process that starts another and exits leaves that child as a live
/// descendant, found through its parent pid after the parent is gone.
#[cfg(target_os = "windows")]
#[test]
fn a_child_started_before_the_parent_exited_is_a_live_descendant() {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    let ping = system_exe("PING.EXE");
    let mut child = Command::new(system_exe("cmd.exe"))
        .raw_arg(format!(
            "/d /c start \"\" /b \"{}\" -n 4 127.0.0.1",
            ping.display()
        ))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("start cmd");
    let mut lineage = lineage_of(&child);
    wait_for_exit(&lineage);
    lineage.refresh();
    let live = lineage.live_descendants();
    for (pid, _) in &live {
        let _ = Command::new(system_exe("taskkill.exe"))
            .args(["/pid", &u32::from(*pid).to_string(), "/f"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.wait();
    assert_eq!(live.len(), 1, "the started child is the one descendant");
    assert!(live[0].1.is_some(), "the descendant's instance is recorded");
}

/// A window's first sight is kept: a later look does not move it, so the
/// grace counts from when the window appeared, however late the launch is
/// found to have been passed on.
#[test]
fn the_first_sight_of_a_window_is_kept() {
    let mut first_seen = HashMap::new();
    let early = Instant::now();
    let late = early + Duration::from_secs(2);
    record_first_seen(&mut first_seen, vec!["w-5"], early);
    record_first_seen(&mut first_seen, vec!["w-5", "w-6"], late);
    assert_eq!(first_seen.get("w-5"), Some(&early));
    assert_eq!(first_seen.get("w-6"), Some(&late));
}

#[test]
fn only_windows_of_the_targets_not_shown_before_are_noted() {
    let targets = vec![(ProcessId::from(20), Some("instance-20".to_string()))];
    let windows = vec![
        window("w-1", 20, Some("instance-20")),
        window("w-5", 20, Some("instance-20")),
        window("w-6", 30, Some("instance-30")),
        window("w-7", 20, Some("instance-other")),
    ];
    assert_eq!(
        fresh_window_ids(&windows, &targets, &ids(&["w-1"])),
        vec!["w-5"]
    );
}

fn focused(mut window: WindowInfo) -> WindowInfo {
    window.state.is_focused = true;
    window
}

/// An app with one window answers the hand-over by bringing that window,
/// which it had before the launch, to the front: it is read as raised. A
/// window that was already in front when the launch began is not.
#[test]
fn a_window_the_instance_had_and_brought_to_the_front_is_read_as_raised() {
    let targets = vec![(ProcessId::from(20), Some("instance-20".to_string()))];
    let before = ids(&["w-1"]);
    let windows = vec![focused(window("w-1", 20, Some("instance-20")))];
    let (raised, only) = read_existing(&windows, &targets, &before, Some("w-99"), false);
    assert_eq!(raised.map(|window| window.id), Some("w-1".to_string()));
    assert_eq!(only.map(|window| window.id), Some("w-1".to_string()));
    let (raised, _) = read_existing(&windows, &targets, &before, Some("w-1"), false);
    assert!(raised.is_none(), "already in front when the launch began");
}

/// The instance's one visible window, shown before the launch, is named as
/// such even when it did not move (the browser that opened nothing).
#[test]
fn the_only_window_of_the_instance_is_named_only_when_it_is_the_only_one() {
    let targets = vec![(ProcessId::from(20), Some("instance-20".to_string()))];
    let before = ids(&["w-1", "w-2"]);
    let one = vec![window("w-1", 20, Some("instance-20"))];
    let (raised, only) = read_existing(&one, &targets, &before, None, false);
    assert!(raised.is_none(), "not in front, so not brought forward");
    assert_eq!(only.map(|window| window.id), Some("w-1".to_string()));
    let two = vec![
        window("w-1", 20, Some("instance-20")),
        window("w-2", 20, Some("instance-20")),
    ];
    assert!(
        read_existing(&two, &targets, &before, None, false)
            .1
            .is_none()
    );
    let another_process = vec![
        window("w-1", 20, Some("instance-20")),
        window("w-9", 30, Some("instance-30")),
    ];
    assert_eq!(
        read_existing(&another_process, &targets, &before, None, false)
            .1
            .map(|window| window.id),
        Some("w-1".to_string()),
        "another app's windows do not count"
    );
}

/// #1297: Chrome showed its browser window (in front) and its profile
/// picker (covered by it); the launch made it bring the picker forward. With
/// two visible windows there is no only window, but the picker is still read
/// as raised: which window came forward does not depend on how many the
/// instance shows.
#[test]
fn the_covered_window_of_two_that_came_forward_is_read_as_raised() {
    let targets = vec![(ProcessId::from(20), Some("instance-20".to_string()))];
    let before = ids(&["w-browser", "w-picker"]);
    let windows = vec![
        focused(window("w-picker", 20, Some("instance-20"))),
        window("w-browser", 20, Some("instance-20")),
    ];
    let (raised, only) = read_existing(&windows, &targets, &before, Some("w-browser"), false);
    assert_eq!(raised.map(|window| window.id), Some("w-picker".to_string()));
    assert!(only.is_none(), "two windows: no only window");
    let still = vec![
        window("w-picker", 20, Some("instance-20")),
        focused(window("w-browser", 20, Some("instance-20"))),
    ];
    assert!(
        read_existing(&still, &targets, &before, Some("w-browser"), false)
            .0
            .is_none(),
        "the window in front when the launch began did not come forward"
    );
}

#[test]
fn a_window_not_shown_before_or_beside_several_instances_is_not_an_existing_one() {
    let targets = vec![(ProcessId::from(20), Some("instance-20".to_string()))];
    let fresh = vec![focused(window("w-5", 20, Some("instance-20")))];
    assert!(
        matches!(
            read_existing(&fresh, &targets, &ids(&[]), None, false),
            (None, None)
        ),
        "a new window is a handed-off window, not an existing one"
    );
    let shown = vec![focused(window("w-1", 20, Some("instance-20")))];
    assert!(matches!(
        read_existing(&shown, &targets, &ids(&["w-1"]), None, true),
        (None, None)
    ));
}

/// A handle that existed before the launch, hidden, is a window the instance
/// already had; only a handle that did not exist is one the launch opened.
/// Unreadable reads as existing, the restricted side.
#[test]
fn a_window_shown_again_is_told_from_a_new_one_by_its_handle() {
    let all = ids(&["w-1", "w-hidden"]);
    assert!(existed_before(Some(&all), "w-hidden"));
    assert!(!existed_before(Some(&all), "w-new"));
    assert!(existed_before(None, "w-new"));
}
