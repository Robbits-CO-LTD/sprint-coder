// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::super::*;
use super::{
    KillOnDrop, copy_probe_binary, copy_system_exe, deadline, full_image_path, matching_pids,
    probe_launch_options, scratch_dir, start_named_windowless, start_windowed_probe,
};
use crate::system::launch_path::resolve_executable;
use agent_desktop_core::{Deadline, DeliveryDisposition, ErrorCode};
use std::sync::Mutex;

static NOTEPAD_LAUNCH_LOCK: Mutex<()> = Mutex::new(());

#[test]
fn scratch_launch_returns_window_for_created_process() {
    let _lock = NOTEPAD_LAUNCH_LOCK.lock().expect("notepad lock");
    crate::tree::fixture::bootstrap();
    let dir = scratch_dir("notepad-scratch");
    let probe = copy_probe_binary(&dir, "launchprobe_host_scratch.exe");
    let image = "launchprobe_host_scratch.exe";
    let window = launch_app_impl(
        probe.to_str().expect("utf8 path"),
        &probe_launch_options(false, 8_000),
        deadline(10_000),
    )
    .expect("launch notepad probe");
    let _guard = KillOnDrop(window.pid);
    assert!(
        matching_pids(image).contains(&window.pid),
        "returned window pid must belong to the probe notepad process"
    );
    assert!(window.process_instance.is_some());
    assert!(window.new_instance && !window.attached, "{window:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A launch without `--activate` must not take the foreground or cover the
/// window that was in front. **Invert-verified**: without `ForegroundGuard`
/// the probe's window lands above the window that was in front (and takes the
/// foreground when this process may set it), and this fails.
#[test]
fn a_background_launch_keeps_the_foreground_and_stays_below_it() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GW_HWNDNEXT, GWL_EXSTYLE, GetForegroundWindow, GetWindow, GetWindowLongW, WS_EX_TOPMOST,
    };
    let _lock = NOTEPAD_LAUNCH_LOCK.lock().expect("notepad lock");
    crate::tree::fixture::bootstrap();
    let dir = scratch_dir("background");
    let probe = copy_probe_binary(&dir, "launchprobe_host_background.exe");
    let prior = unsafe { GetForegroundWindow() };
    let result = launch_app_impl(
        probe.to_str().expect("utf8 path"),
        &probe_launch_options(false, 8_000),
        deadline(10_000),
    )
    .expect("launch probe");
    let _guard = KillOnDrop(result.pid);
    let window = result.window.expect("the probe presents a window");
    let handle = crate::system::window::window_ops::parse_handle(&window.id);
    assert_ne!(
        unsafe { GetForegroundWindow() },
        handle,
        "a background launch must not hand the foreground to the launched window"
    );
    let prior_is_topmost =
        unsafe { GetWindowLongW(prior, GWL_EXSTYLE) } as u32 & WS_EX_TOPMOST != 0;
    if !prior.is_null() && !prior_is_topmost {
        // The restack is queued (`SWP_ASYNCWINDOWPOS`), so give it a moment.
        let settle = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let below = loop {
            let mut below = unsafe { GetWindow(prior, GW_HWNDNEXT) };
            while !below.is_null() && below != handle {
                below = unsafe { GetWindow(below, GW_HWNDNEXT) };
            }
            if below == handle || std::time::Instant::now() >= settle {
                break below;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        };
        assert_eq!(
            below, handle,
            "the launched window must sit below the window that was in front"
        );
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// Arguments reach only a process this launch creates, so a launch with
/// them starts a new instance even beside a running one, and says so.
#[test]
fn a_launch_with_arguments_starts_a_new_instance_beside_the_running_one() {
    let _lock = NOTEPAD_LAUNCH_LOCK.lock().expect("notepad lock");
    crate::tree::fixture::bootstrap();
    let dir = scratch_dir("args-new-instance");
    let probe = copy_probe_binary(&dir, "launchprobe_host_args.exe");
    let image = "launchprobe_host_args.exe";
    let first = start_windowed_probe(&probe);
    assert_eq!(matching_pids(image), vec![first.0]);
    let launched = launch_app_impl(
        probe.to_str().expect("utf8 path"),
        &probe_launch_options(true, 8_000),
        deadline(10_000),
    )
    .expect("launch a second instance");
    let _second = KillOnDrop(launched.pid);
    assert_ne!(launched.pid, first.0);
    assert!(launched.new_instance, "{launched:?}");
    assert!(!launched.attached, "{launched:?}");
    let window = launched
        .window
        .as_ref()
        .expect("the new instance presents a window");
    assert_eq!(window.pid, launched.pid);
    assert_eq!(matching_pids(image).len(), 2);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn attach_true_does_not_reuse_same_basename_from_another_path() {
    let _lock = NOTEPAD_LAUNCH_LOCK.lock().expect("notepad lock");
    crate::tree::fixture::bootstrap();
    let dir = scratch_dir("same-basename");
    let intended_dir = dir.join("intended");
    let impostor_dir = dir.join("impostor");
    std::fs::create_dir_all(&intended_dir).expect("intended dir");
    std::fs::create_dir_all(&impostor_dir).expect("impostor dir");
    let image = format!("launchprobe_host_same_{}.exe", std::process::id());
    let intended = copy_probe_binary(&intended_dir, &image);
    let impostor = copy_probe_binary(&impostor_dir, &image);
    let running_impostor = start_windowed_probe(&impostor);
    assert_eq!(matching_pids(&image), vec![running_impostor.0]);

    let launched = launch_app_impl(
        intended.to_str().expect("intended path"),
        &probe_launch_options(true, 8_000),
        deadline(10_000),
    )
    .expect("launch the requested executable instead of attaching to its basename impostor");
    let launched_guard = KillOnDrop(launched.pid);
    assert_ne!(launched.pid, running_impostor.0);
    let actual = full_image_path(launched.pid).expect("launched image path");
    assert_eq!(
        actual.canonicalize().ok(),
        intended.canonicalize().ok(),
        "the returned process must run the requested path"
    );
    assert_eq!(matching_pids(&image).len(), 2);

    drop(launched_guard);
    drop(running_impostor);
    let _ = std::fs::remove_dir_all(&dir);
}

/// `--no-attach` starts a new instance even while the same executable runs,
/// instead of refusing; the result proves the window is the new process's.
#[test]
fn no_attach_starts_a_new_instance_beside_the_running_one() {
    let _lock = NOTEPAD_LAUNCH_LOCK.lock().expect("notepad lock");
    crate::tree::fixture::bootstrap();
    let dir = scratch_dir("notepad-noattach");
    let probe = copy_probe_binary(&dir, "launchprobe_host_noattach.exe");
    let image = "launchprobe_host_noattach.exe";
    let running = start_windowed_probe(&probe);
    let launched = launch_app_impl(
        probe.to_str().expect("utf8 path"),
        &probe_launch_options(false, 8_000),
        deadline(10_000),
    )
    .expect("no-attach launches a new instance");
    let _second = KillOnDrop(launched.pid);
    assert_ne!(launched.pid, running.0);
    assert!(launched.new_instance && !launched.attached, "{launched:?}");
    assert_eq!(
        launched.window.as_ref().map(|window| window.pid),
        Some(launched.pid)
    );
    assert_eq!(matching_pids(image).len(), 2);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A started process that exits without a window while the same executable
/// runs is reported as passed to that running instance (`attached`), never
/// as a new instance; without one running it is not called attached.
#[test]
fn a_started_process_that_exits_beside_a_running_one_is_reported_attached() {
    let dir = scratch_dir("handoff");
    let probe = copy_system_exe("ping.exe", &dir, "launchprobe_handoff.exe");
    let quick = || LaunchOptions {
        args: vec!["-n".into(), "1".into(), "127.0.0.1".into()],
        attach_if_running: false,
        timeout_ms: 5_000,
        ..Default::default()
    };
    let alone = launch_app_impl(
        probe.to_str().expect("utf8 path"),
        &quick(),
        deadline(10_000),
    )
    .expect("a process that exits is a successful launch");
    assert!(!alone.attached && !alone.new_instance, "{alone:?}");
    assert_eq!(
        alone.suggestion.as_deref(),
        Some(launch_handoff::EXITED_WITHOUT_WINDOW)
    );

    let running = start_named_windowless(&probe, &["-n", "60", "127.0.0.1"]);
    let handed = launch_app_impl(
        probe.to_str().expect("utf8 path"),
        &quick(),
        deadline(10_000),
    )
    .expect("a process that exits is a successful launch");
    assert_ne!(handed.pid, running.0);
    assert!(handed.attached && !handed.new_instance, "{handed:?}");
    assert!(handed.window.is_none());
    assert_eq!(
        handed.suggestion.as_deref(),
        Some(launch_attach::HANDED_OFF)
    );
    drop(running);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn attach_true_windowless_does_not_launch_second_process() {
    let dir = scratch_dir("windowless");
    let probe = copy_system_exe("ping.exe", &dir, "launchprobe_ping.exe");
    let image = "launchprobe_ping.exe";
    let _ping = start_named_windowless(&probe, &["-n", "60", "127.0.0.1"]);
    let running = matching_pids(image);
    assert_eq!(running.len(), 1);
    let result = launch_app_impl(
        probe.to_str().expect("utf8 path"),
        &LaunchOptions {
            attach_if_running: true,
            timeout_ms: 300,
            ..Default::default()
        },
        Deadline::after(1_000).expect("deadline"),
    )
    .expect("attaching to a windowless process is a successful launch, not a failure");
    assert!(result.attached && !result.new_instance, "{result:?}");
    assert_eq!(result.suggestion.as_deref(), Some(launch_attach::ATTACHED));
    assert!(
        result.window.is_none(),
        "a windowless process reports no window rather than an error: {result:?}"
    );
    assert_eq!(
        result.pid, running[0],
        "attach returns the already-running process rather than starting one"
    );
    assert_eq!(
        matching_pids(image).len(),
        1,
        "attach must not spawn a second process"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn two_matches_are_ambiguous_before_launch() {
    let _lock = NOTEPAD_LAUNCH_LOCK.lock().expect("notepad lock");
    crate::tree::fixture::bootstrap();
    let dir = scratch_dir("notepad-ambiguous");
    let probe = copy_probe_binary(&dir, "launchprobe_host_ambiguous.exe");
    let image = "launchprobe_host_ambiguous.exe";
    let _one = start_windowed_probe(&probe);
    let _two = start_windowed_probe(&probe);
    let before = matching_pids(image);
    assert!(before.len() >= 2);
    let error = launch_app_impl(
        probe.to_str().expect("utf8 path"),
        &LaunchOptions {
            attach_if_running: true,
            ..Default::default()
        },
        deadline(10_000),
    )
    .expect_err("ambiguous");
    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
    assert_eq!(matching_pids(image).len(), before.len());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn cwd_is_honored_for_create_process() {
    let temp = scratch_dir("cwd");
    let probe = copy_system_exe("cmd.exe", &temp, "launchprobe_cwd.exe");
    let marker = temp.join("cwd.txt");
    let options = LaunchOptions {
        args: vec!["/C".into(), format!("cd > \"{}\"", marker.display())],
        cwd: Some(temp.clone()),
        attach_if_running: false,
        timeout_ms: 0,
        ..Default::default()
    };
    let result = launch_app_impl(
        probe.to_str().expect("utf8 path"),
        &options,
        deadline(10_000),
    )
    .expect("a windowless probe is a successful launch");
    let _guard = KillOnDrop(result.pid);
    assert!(
        result.window.is_none(),
        "the probe presents no window: {result:?}"
    );
    let written = poll_read_marker(&marker, Deadline::after(5_000).expect("deadline"));
    let normalized_written = written.trim().trim_end_matches('\\').to_ascii_lowercase();
    let normalized_temp = temp
        .to_string_lossy()
        .trim_end_matches('\\')
        .to_ascii_lowercase();
    assert_eq!(normalized_written, normalized_temp);
    let _ = std::fs::remove_dir_all(&temp);
}

/// Without `--cwd`, the app starts in its executable's folder, not in this
/// process's directory (the caller's workspace), as it would from Explorer.
#[test]
fn cwd_defaults_to_the_folder_of_the_executable() {
    let temp = scratch_dir("cwd-default");
    let probe = copy_system_exe("cmd.exe", &temp, "launchprobe_cwd_default.exe");
    let marker = temp.join("cwd.txt");
    let options = LaunchOptions {
        args: vec!["/C".into(), format!("cd > \"{}\"", marker.display())],
        cwd: None,
        attach_if_running: false,
        timeout_ms: 0,
        ..Default::default()
    };
    let result = launch_app_impl(
        probe.to_str().expect("utf8 path"),
        &options,
        deadline(10_000),
    )
    .expect("a windowless probe is a successful launch");
    let _guard = KillOnDrop(result.pid);
    let written = poll_read_marker(&marker, Deadline::after(5_000).expect("deadline"));
    let normalized_written = written.trim().trim_end_matches('\\').to_ascii_lowercase();
    let normalized_temp = temp
        .to_string_lossy()
        .trim_end_matches('\\')
        .to_ascii_lowercase();
    assert_eq!(normalized_written, normalized_temp);
    let _ = std::fs::remove_dir_all(&temp);
}

/// The marker is written by a child shell redirecting `cd` output, a step
/// that lands strictly after `CreateProcessW` returns to this test. Reading
/// it once, immediately, races that write; polling under a deadline lets the
/// child finish without turning a slow scheduler into a false failure.
fn poll_read_marker(marker: &std::path::Path, deadline: Deadline) -> String {
    loop {
        if let Ok(contents) = std::fs::read_to_string(marker) {
            if !contents.trim().is_empty() {
                return contents;
            }
        }
        if deadline.remaining().is_zero() {
            return std::fs::read_to_string(marker).expect("cwd marker");
        }
        std::thread::sleep(std::time::Duration::from_millis(50).min(deadline.remaining()));
    }
}

#[test]
fn timeout_zero_checks_once_for_process_without_window() {
    let dir = scratch_dir("timeout0");
    let probe = copy_system_exe("ping.exe", &dir, "launchprobe_timeout.exe");
    let result = launch_app_impl(
        probe.to_str().expect("utf8 path"),
        &LaunchOptions {
            args: vec!["-n".into(), "30".into(), "127.0.0.1".into()],
            attach_if_running: false,
            timeout_ms: 0,
            ..Default::default()
        },
        deadline(10_000),
    )
    .expect("a windowless process is a successful launch");
    let _guard = KillOnDrop(result.pid);
    assert!(
        result.window.is_none(),
        "timeout 0 observes once and reports no window rather than polling: {result:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// The hijack scenario itself needs the literal bare name `notepad.exe`,
/// since it is bare-name resolution against the real system directories that
/// is under test; a uniquely-named probe copy would not exercise it. What it
/// does not need is to hold the process-wide current directory across the
/// launch that follows. Resolution is captured once, under the planted cwd,
/// and the cwd is restored immediately after — before the up-to-8-second
/// window poll runs, and before the already-resolved absolute path is handed
/// to the launch so nothing downstream depends on cwd being anything at all.
#[test]
fn bare_name_never_chooses_planted_binary_in_current_directory() {
    let _lock = NOTEPAD_LAUNCH_LOCK.lock().expect("notepad lock");
    crate::tree::fixture::bootstrap();
    let system_notepad = resolve_executable("notepad.exe").expect("system notepad");
    let plant_dir = scratch_dir("hijack");
    let planted = plant_dir.join("notepad.exe");
    std::fs::write(&planted, b"not a real pe").expect("plant decoy");
    let previous = std::env::current_dir().expect("cwd");
    std::env::set_current_dir(&plant_dir).expect("enter plant dir");
    let resolved = resolve_executable("notepad.exe");
    let _ = std::env::set_current_dir(&previous);
    let resolved = resolved.expect("resolve ignores cwd");
    assert_ne!(
        resolved.canonicalize().ok(),
        planted.canonicalize().ok(),
        "resolver must not select the planted cwd binary"
    );
    assert_eq!(
        resolved.canonicalize().ok(),
        system_notepad.canonicalize().ok()
    );
    let window = launch_app_impl(
        resolved.to_str().expect("utf8 path"),
        &probe_launch_options(false, 8_000),
        deadline(10_000),
    )
    .expect("launch system notepad");
    let _guard = KillOnDrop(window.pid);
    let image = full_image_path(window.pid).expect("image path");
    let image_canon = image.canonicalize().unwrap_or(image);
    let planted_canon = planted.canonicalize().unwrap_or(planted.clone());
    assert_ne!(image_canon, planted_canon);
    assert_eq!(
        image_canon
            .file_name()
            .map(|name| name.to_ascii_lowercase()),
        Some(std::ffi::OsString::from("notepad.exe"))
    );
    let _ = std::fs::remove_dir_all(&plant_dir);
}
