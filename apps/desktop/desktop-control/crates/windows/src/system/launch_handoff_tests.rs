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
