// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::*;
use std::os::unix::net::UnixListener;

/// The name Sprint Coder ships the binary under starts a renderer too, or the
/// shipped binary never draws a cursor. The upstream name still does.
#[test]
fn the_upstream_and_the_bundled_binary_are_both_own_images() {
    let tree = Path::new("/Applications/Sprint Coder.app/Contents/Resources");
    assert!(is_own_image(&tree.join("sprint-coder-desktop-control")));
    assert!(is_own_image(Path::new("/usr/local/bin/agent-desktop")));
    assert!(is_own_image(Path::new("agent-desktop")));
}

/// A host running under another image (a library host, a renamed copy) must
/// never be started again as a renderer.
#[test]
fn another_binary_is_not_an_own_image() {
    for name in [
        "sprint-coder-desktop-control-old",
        "sprint-coder",
        "agent-desktop-ffi",
        "Electron",
        // The names are matched exactly, as the upstream guard does.
        "Sprint-Coder-Desktop-Control",
        // The whole file name counts: a copy with an extension is another file.
        "sprint-coder-desktop-control.old",
        "agent-desktop.bak",
        "sprint-coder-desktop-control.exe",
    ] {
        assert!(
            !is_own_image(&Path::new("/tmp/agent-desktop").join(name)),
            "{name}"
        );
    }
    // Only the final component is the image, not a folder named after it.
    assert!(!is_own_image(Path::new(
        "/tmp/sprint-coder-desktop-control/tool"
    )));
    assert!(!is_own_image(Path::new("")));
}

fn private_socket_path(tag: &str) -> std::path::PathBuf {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::path::PathBuf::from(format!(
        "/tmp/cr-{}-{unique:x}-{tag}.sock",
        std::process::id()
    ))
}

#[test]
fn a_retire_goes_to_its_agent_alone_and_a_disable_to_the_whole_session() {
    let instruction = agent_desktop_core::CursorOverlayInstruction::new(
        agent_desktop_core::Point { x: 1.0, y: 2.0 },
        &agent_desktop_core::CursorOverlayConfig::enabled(None, 8).unwrap(),
        false,
    )
    .unwrap();
    assert_eq!(
        route(&CursorOverlayControl::retire(
            "run".into(),
            "worker-a".into()
        )),
        Route::RetireAgent
    );
    assert_eq!(
        route(&CursorOverlayControl::disable("run".into())),
        Route::Broadcast
    );
    assert_eq!(
        route(&CursorOverlayControl::hide("run".into())),
        Route::Broadcast
    );
    assert_eq!(
        route(&CursorOverlayControl::hide("run".into()).with_agent_id(Some("worker-a".into()))),
        Route::Agent
    );
    assert_eq!(
        route(&CursorOverlayControl::present("run".into(), instruction)),
        Route::Agent
    );
}

/// With no renderer listening for the agent, a retire starts nothing and
/// leaves the mark a renderer still starting for that agent ends on.
#[test]
fn a_retire_with_no_renderer_listening_leaves_the_mark_and_starts_nothing() {
    let path = private_socket_path("none");
    let mark = path.with_extension("retired");
    let retire = CursorOverlayControl::retire("run-retire".into(), "worker-a".into());
    retire_at(&path, &retire, Instant::now() + Duration::from_secs(1))
        .expect("nothing to take down");
    assert!(!path.exists(), "a retire never creates the agent's socket");
    assert!(mark.exists(), "the mark is left");
    // A second retire keeps the one mark.
    retire_at(&path, &retire, Instant::now() + Duration::from_secs(1)).expect("again");
    assert!(super::super::endpoint::take_retired_mark(&path));
    assert!(!mark.exists());
    assert!(!super::super::endpoint::take_retired_mark(&path));
}

/// A socket file a renderer left behind refuses the connection: nobody is
/// listening, so the retire succeeds and leaves the mark.
#[test]
fn a_retire_at_a_stale_socket_succeeds_and_leaves_the_mark() {
    let path = private_socket_path("stale");
    drop(UnixListener::bind(&path).unwrap());
    assert!(path.exists(), "the stale socket file is there");
    let retire = CursorOverlayControl::retire("run-retire".into(), "worker-a".into());
    let result = retire_at(&path, &retire, Instant::now() + Duration::from_secs(1));
    let marked = super::super::endpoint::take_retired_mark(&path);
    let _ = std::fs::remove_file(&path);
    result.expect("nothing listening to take down");
    assert!(marked);
}

/// A descriptor this process holds without close-on-exec (the shape of a
/// command host's pipe) does not reach the process started with the same
/// preparation as the renderer.
#[test]
fn a_started_process_holds_no_inherited_descriptor() {
    let mut created = [0; 2];
    assert_eq!(unsafe { libc::pipe(created.as_mut_ptr()) }, 0);
    // Moved far above the low numbers the other tests of this process open and
    // close at the same time, so none of them can close or reuse these: 900,
    // or just under the open-file limit when it is lower (macOS' default soft
    // limit in a Terminal is 256). `F_DUPFD` gives copies without close-on-exec.
    let base = high_descriptor_base();
    let mut pipe = [0; 2];
    for (index, fd) in created.into_iter().enumerate() {
        pipe[index] = unsafe { libc::fcntl(fd, libc::F_DUPFD, base + index as libc::c_int) };
        assert!(pipe[index] >= base, "a high copy of the pipe");
        unsafe { libc::close(fd) };
        assert_eq!(unsafe { libc::fcntl(pipe[index], libc::F_GETFD) }, 0);
    }
    let probe = |prepared: bool| {
        let mut command = Command::new("/bin/sh");
        if prepared {
            close_inherited_on_exec(&mut command);
        }
        let output = command
            .args(["-c", "for fd in \"$0\" \"$1\"; do if (: <&\"$fd\") 2>/dev/null; then echo open; else echo closed; fi; done"])
            .arg(pipe[0].to_string())
            .arg(pipe[1].to_string())
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .expect("the probe runs");
        String::from_utf8(output.stdout).unwrap()
    };
    let unprepared = probe(false);
    let prepared = probe(true);
    unsafe {
        libc::close(pipe[0]);
        libc::close(pipe[1]);
    }
    assert_eq!(
        unprepared, "open\nopen\n",
        "the probe sees an inherited descriptor"
    );
    assert_eq!(prepared, "closed\nclosed\n");
}

/// The lowest number `a_started_process_holds_no_inherited_descriptor` moves
/// its pipe to: 900, or 16 under the soft open-file limit when that is lower.
fn high_descriptor_base() -> libc::c_int {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    assert_eq!(
        unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) },
        0
    );
    let below_limit = limit.rlim_cur.saturating_sub(16);
    libc::c_int::try_from(below_limit.min(900)).unwrap_or(900)
}

/// A retire reaches the agent's renderer as a session `Disable`, which every
/// renderer of the protocol ends on, and waits for its acknowledgement.
#[test]
fn a_retire_sends_a_session_disable_to_the_agents_renderer() {
    let path = private_socket_path("live");
    let result = std::panic::catch_unwind(|| {
        let listener = UnixListener::bind(&path).unwrap();
        let receiver = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut payload = Vec::new();
            stream.read_to_end(&mut payload).unwrap();
            stream.write_all(&[1]).unwrap();
            serde_json::from_slice::<CursorOverlayControl>(&payload).unwrap()
        });
        let retire = CursorOverlayControl::retire("run-retire".into(), "worker-a".into());
        retire_at(&path, &retire, Instant::now() + Duration::from_secs(2))
            .expect("the renderer acknowledged");
        receiver.join().unwrap()
    });
    let _ = std::fs::remove_file(&path);
    let received = result.unwrap();
    assert!(received.is_disable());
    assert_eq!(received.session_id(), "run-retire");
}

#[test]
fn travel_acknowledgement_obeys_remaining_budget() {
    let error = unacknowledged_failure(agent_desktop_core::CursorPhase::Travel);

    assert_eq!(
        error.message,
        "macOS cursor overlay did not confirm cursor arrival"
    );
}

#[test]
fn drag_requires_acknowledgement_before_tracking_is_considered_ready() {
    let error = unacknowledged_failure(agent_desktop_core::CursorPhase::Drag);

    assert_eq!(
        error.message,
        "macOS cursor overlay did not acknowledge the control"
    );
}

#[test]
fn effect_requires_acknowledgement_before_it_is_considered_delivered() {
    let error = unacknowledged_failure(agent_desktop_core::CursorPhase::Effect);

    assert_eq!(
        error.message,
        "macOS cursor overlay did not confirm cursor effect"
    );
}

fn unacknowledged_failure(phase: agent_desktop_core::CursorPhase) -> AdapterError {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::path::PathBuf::from(format!(
        "/tmp/ca-{}-{unique:x}-{phase:?}.sock",
        std::process::id()
    ));
    let result = std::panic::catch_unwind(|| {
        let listener = UnixListener::bind(&path).unwrap();
        let (release, released) = std::sync::mpsc::channel::<()>();
        let receiver = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut payload = Vec::new();
            stream.read_to_end(&mut payload).unwrap();
            released.recv_timeout(Duration::from_secs(10)).is_ok()
        });
        let instruction = agent_desktop_core::CursorOverlayInstruction::new(
            agent_desktop_core::Point { x: 10.0, y: 20.0 },
            &agent_desktop_core::CursorOverlayConfig::enabled(None, 8).unwrap(),
            false,
        )
        .unwrap()
        .with_phase(phase);
        let control = CursorOverlayControl::present("run-budget".into(), instruction);
        let started = Instant::now();
        let error = send_until(&path, &control, started + Duration::from_millis(30))
            .expect_err("an unacknowledged control must fail");
        release.send(()).unwrap();
        assert!(
            receiver.join().unwrap(),
            "send_until must give up on its own deadline, not when the receiver lets go"
        );
        error
    });
    let _ = std::fs::remove_file(path);
    result.unwrap()
}
