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

/// With no renderer listening for the agent, a retire has nothing to take down
/// and starts nothing.
#[test]
fn a_retire_with_no_renderer_listening_succeeds_without_starting_one() {
    let path = private_socket_path("none");
    let retire = CursorOverlayControl::retire("run-retire".into(), "worker-a".into());
    retire_at(&path, &retire, Instant::now() + Duration::from_secs(1))
        .expect("nothing to take down");
    assert!(!path.exists(), "a retire never creates the agent's socket");
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
