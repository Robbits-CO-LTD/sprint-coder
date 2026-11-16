// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::*;
use std::thread;

/// A retire carries no instruction; drawn, it would put up a fresh greeting
/// cursor for the agent that just finished. It ends the renderer instead, as a
/// disable does, before anything reaches the screen.
#[test]
fn a_retire_ends_the_renderer_like_a_disable_and_draws_nothing() {
    let retire = CursorOverlayControl::retire("run-retire".into(), "worker-a".into());
    let disable = CursorOverlayControl::disable("run-retire".into());
    assert!(ends_renderer(&retire));
    assert!(ends_renderer(&disable));
    assert!(!ends_renderer(&CursorOverlayControl::hide(
        "run-retire".into()
    )));
    let mut state = OverlayState::default();
    assert!(!handle(&retire, &mut state).expect("a retire is handled"));
    assert!(!handle(&disable, &mut state).expect("a disable is handled"));
}

fn agent_control(agent: &str) -> CursorOverlayControl {
    let instruction = instruction(Point { x: 1.0, y: 2.0 }, false);
    CursorOverlayControl::present("run-a".into(), instruction).with_agent_id(Some(agent.into()))
}

/// A renderer acts only on its own session and agent; a retire for another
/// agent of the same session is dropped, while a session-wide disable, hide or
/// show (which names no agent) is taken.
#[test]
fn a_renderer_takes_its_own_agents_controls_and_drops_another_agents_retire() {
    let initial = agent_control("worker-a");
    assert!(addressed_to(
        &initial,
        &CursorOverlayControl::retire("run-a".into(), "worker-a".into())
    ));
    assert!(!addressed_to(
        &initial,
        &CursorOverlayControl::retire("run-a".into(), "worker-b".into())
    ));
    assert!(!addressed_to(
        &initial,
        &CursorOverlayControl::retire("run-b".into(), "worker-a".into())
    ));
    assert!(!addressed_to(&initial, &agent_control("worker-b")));
    for shared in [
        CursorOverlayControl::disable("run-a".into()),
        CursorOverlayControl::hide("run-a".into()),
        CursorOverlayControl::show("run-a".into()),
    ] {
        assert!(addressed_to(&initial, &shared));
    }
    assert!(!addressed_to(
        &initial,
        &CursorOverlayControl::disable("run-b".into())
    ));
}

fn in_window(window: Option<&str>, phase: CursorPhase) -> CursorOverlayInstruction {
    instruction(Point { x: 1.0, y: 2.0 }, false)
        .with_window(window.map(str::to_owned))
        .with_phase(phase)
}

/// A resting renderer comes back only for a control that passes its checks. One
/// that fails them (here an agent id that is not one) is refused, so it neither
/// shows the cursor again nor moves it; a renderer that is awake is not woken.
#[test]
fn only_a_control_that_passes_its_checks_wakes_a_resting_renderer() {
    let valid = presented("run-a", in_window(Some("w-7"), CursorPhase::Travel));
    let invalid = presented("run-a", in_window(Some("w-9"), CursorPhase::Travel))
        .with_agent_id(Some("not an agent/id".into()));
    assert!(valid.validate().is_ok());
    assert!(invalid.validate().is_err());
    assert!(wakes(true, &valid));
    assert!(!wakes(true, &invalid));
    assert!(!wakes(false, &valid));
    assert!(wakes(true, &CursorOverlayControl::show("run-a".into())));
}

/// The cursor is drawn at the height of the window the instruction names; a
/// bare coordinate puts it back above every window, and a caret-follow keeps
/// the window of the caret it moves, as on Windows. A named id that is not a
/// window number hides it instead of putting it above every window.
#[test]
fn the_anchor_follows_the_named_window_and_a_caret_follow_keeps_it() {
    assert_eq!(
        next_anchor(
            &in_window(Some("w-4242"), CursorPhase::Travel),
            Anchor::Free
        ),
        Anchor::Window(4242)
    );
    assert_eq!(
        next_anchor(&in_window(None, CursorPhase::Travel), Anchor::Window(4242)),
        Anchor::Free
    );
    assert_eq!(
        next_anchor(
            &in_window(None, CursorPhase::CaretFollow),
            Anchor::Window(4242)
        ),
        Anchor::Window(4242)
    );
    assert_eq!(
        next_anchor(
            &in_window(None, CursorPhase::CaretFollow),
            Anchor::Unreadable
        ),
        Anchor::Unreadable
    );
    assert_eq!(
        next_anchor(
            &in_window(Some("w-7"), CursorPhase::CaretFollow),
            Anchor::Window(4242)
        ),
        Anchor::Window(7)
    );
    for unreadable in [
        "4242",
        "w-",
        "w-abc",
        "w-0",
        "w--1",
        "w-+12",
        "h-12",
        "w-99999999999",
    ] {
        for phase in [CursorPhase::Effect, CursorPhase::CaretFollow] {
            assert_eq!(
                next_anchor(&in_window(Some(unreadable), phase), Anchor::Window(1)),
                Anchor::Unreadable,
                "{unreadable}"
            );
        }
    }
}

/// A named window always reaches the native side as named, so an unreadable
/// one is hidden there and never drawn above every window.
#[test]
fn a_named_window_reaches_the_native_side_as_named() {
    use super::super::bridge::anchor_arguments;
    assert_eq!(anchor_arguments(Anchor::Free), (false, 0));
    assert_eq!(anchor_arguments(Anchor::Window(27560)), (true, 27560));
    assert_eq!(anchor_arguments(Anchor::Unreadable), (true, 0));
}

/// At rest the renderer sleeps until the next host and session check instead
/// of waking every frame; awake it waits a frame.
#[test]
fn a_resting_renderer_sleeps_until_the_next_check() {
    assert_eq!(idle_wait(false, Duration::ZERO), AWAKE_WAIT);
    assert_eq!(idle_wait(true, Duration::ZERO), CHECK_EVERY);
    assert_eq!(
        idle_wait(true, Duration::from_millis(400)),
        Duration::from_millis(600)
    );
    assert_eq!(idle_wait(true, Duration::from_secs(5)), AWAKE_WAIT);
}

/// The periodic check ends the renderer once the host is gone or the session
/// is over, and not otherwise.
#[test]
fn the_periodic_check_ends_with_the_host_or_the_session() {
    use super::super::host_watch::{HostRequest, HostWatch};
    let mut unwatched = HostWatch::for_request(HostRequest::Unwatched);
    assert!(!checks_end_renderer(&mut unwatched, || true));
    assert!(checks_end_renderer(&mut unwatched, || false));
    let mut gone = HostWatch::for_request(HostRequest::Invalid);
    assert!(checks_end_renderer(&mut gone, || true));
}

/// The renderer's rest follows the style's linger (Main gives 30 s), and the
/// default without one.
#[test]
fn the_rest_follows_the_styles_linger() {
    let mut state = OverlayState::default();
    assert_eq!(
        state.style.rest_after_ms(),
        agent_desktop_core::CURSOR_IDLE_REST_MS
    );
    let mut style = CursorOverlayStyle::default();
    style.set_linger_ms(Some(30_000));
    let enable = CursorOverlayControl::enable("run-a".into(), style.validated().unwrap());
    absorb_settings(&enable, &mut state);
    assert_eq!(state.style.rest_after_ms(), 30_000);
}

#[test]
fn accepted_stream_waits_for_a_delayed_control() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path =
        std::path::Path::new("/tmp").join(format!("cd-{}-{unique:x}.sock", std::process::id()));
    let result = std::panic::catch_unwind(|| {
        let listener = UnixListener::bind(&path).unwrap();
        listener.set_nonblocking(true).unwrap();
        let mut client = UnixStream::connect(&path).unwrap();
        let (stream, _) = listener.accept().unwrap();
        prepare_stream(&stream).unwrap();
        let sender = thread::spawn(move || {
            thread::sleep(Duration::from_millis(20));
            let control = CursorOverlayControl::hide("run-delayed".into());
            client
                .write_all(&serde_json::to_vec(&control).unwrap())
                .unwrap();
        });
        assert_eq!(read_control(stream).unwrap().session_id(), "run-delayed");
        sender.join().unwrap();
    });
    let _ = std::fs::remove_file(path);
    result.unwrap();
}

fn state(at: Option<Point>) -> OverlayState {
    OverlayState {
        at,
        ..OverlayState::default()
    }
}

fn screen() -> agent_desktop_core::Rect {
    agent_desktop_core::Rect {
        x: 0.0,
        y: 0.0,
        width: 1920.0,
        height: 1080.0,
    }
}

fn instruction(destination: Point, click: bool) -> CursorOverlayInstruction {
    let config = CursorOverlayConfig::enabled(None, 6).expect("valid config");
    CursorOverlayInstruction::new(destination, &config, click).expect("valid instruction")
}

#[test]
fn sampled_motion_ends_at_the_requested_destination() {
    let destination = Point { x: 900.0, y: 500.0 };
    let frames = motion_frames(
        &state(None),
        &instruction(destination.clone(), false),
        &screen(),
        120,
    );

    assert_eq!(frames.last().map(|pose| &pose.point), Some(&destination));
    let biggest_step = frames
        .windows(2)
        .map(|pair| (pair[1].point.x - pair[0].point.x).hypot(pair[1].point.y - pair[0].point.y))
        .fold(0.0_f64, f64::max);
    assert!(frames.len() >= 20, "the path is sampled per frame");
    assert!(
        biggest_step < 40.0,
        "no visible jump between frames: {biggest_step}"
    );
}

#[test]
fn subsequent_motion_starts_from_the_previous_destination() {
    let start = Point { x: 200.0, y: 300.0 };
    let destination = Point { x: 900.0, y: 500.0 };
    let frames = motion_frames(
        &state(Some(start.clone())),
        &instruction(destination.clone(), false),
        &screen(),
        120,
    );

    assert_eq!(frames.first().map(|pose| &pose.point), Some(&start));
    assert_eq!(frames.last().map(|pose| &pose.point), Some(&destination));
}

#[test]
fn a_click_instruction_adds_ripple_frames_at_the_destination() {
    let destination = Point { x: 900.0, y: 500.0 };
    let moved = motion_frames(
        &state(None),
        &instruction(destination.clone(), false),
        &screen(),
        120,
    );
    let clicked = motion_frames(
        &state(None),
        &instruction(destination.clone(), true),
        &screen(),
        120,
    );

    assert!(clicked.len() > moved.len());
    assert!(clicked.iter().any(|pose| pose.ripple > 0.0));
    assert_eq!(clicked.last().map(|pose| &pose.point), Some(&destination));
}

#[test]
fn click_effect_returns_immediately_to_the_control_loop() {
    let destination = Point { x: 900.0, y: 500.0 };
    let effect =
        instruction(destination.clone(), true).with_phase(agent_desktop_core::CursorPhase::Effect);

    let frames = motion_frames(&state(Some(destination.clone())), &effect, &screen(), 120);

    assert_eq!(frames.len(), 2);
    assert_eq!(frames[0], CursorPose::still(destination.clone()));
    assert_eq!(frames[1].point, destination);
    assert_eq!(frames[1].ripple, 1.0);
}

fn overlay_config() -> CursorOverlayConfig {
    CursorOverlayConfig::enabled(None, 6).expect("valid config")
}

fn drag_instruction(drag_from: Point, destination: Point) -> CursorOverlayInstruction {
    CursorOverlayInstruction::new(destination, &overlay_config(), false)
        .expect("valid instruction")
        .with_drag_from(Some(drag_from))
        .with_phase(agent_desktop_core::CursorPhase::Drag)
}

fn presented(session: &str, instruction: CursorOverlayInstruction) -> CursorOverlayControl {
    CursorOverlayControl::present(session.into(), instruction)
}

#[test]
fn hide_clears_the_remembered_landing_for_the_next_travel() {
    let mut remembered = state(Some(Point { x: 100.0, y: 100.0 }));
    let control = CursorOverlayControl::hide("run-failed-drag".into());

    apply_landing_memory(&control, &mut remembered, None);

    assert_eq!(remembered.at, None);
}

#[test]
fn show_leaves_the_remembered_landing_unchanged() {
    let previous = Point { x: 100.0, y: 100.0 };
    let mut remembered = state(Some(previous.clone()));
    let control = CursorOverlayControl::show("run-resume".into());

    apply_landing_memory(&control, &mut remembered, None);

    assert_eq!(remembered.at, Some(previous));
}

#[test]
fn drag_phase_pins_the_remembered_landing_to_the_grab_origin() {
    let drag_from = Point { x: 100.0, y: 100.0 };
    let instruction = drag_instruction(drag_from.clone(), Point { x: 500.0, y: 400.0 });
    let control = presented("run-drag", instruction.clone());
    let mut remembered = state(None);

    apply_landing_memory(&control, &mut remembered, Some(&instruction));

    assert_eq!(remembered.at, Some(drag_from));
}

#[test]
fn drag_phase_without_a_grab_origin_remembers_the_destination() {
    let destination = Point { x: 500.0, y: 400.0 };
    let instruction = CursorOverlayInstruction::new(destination.clone(), &overlay_config(), false)
        .expect("valid instruction")
        .with_phase(agent_desktop_core::CursorPhase::Drag);
    let control = presented("run-drag", instruction.clone());
    let mut remembered = state(None);

    apply_landing_memory(&control, &mut remembered, Some(&instruction));

    assert_eq!(remembered.at, Some(destination));
}

#[test]
fn travel_phase_remembers_the_destination_as_the_landing() {
    let destination = Point { x: 800.0, y: 300.0 };
    let instruction = instruction(destination.clone(), false);
    let control = presented("run-travel", instruction.clone());
    let mut remembered = state(None);

    apply_landing_memory(&control, &mut remembered, Some(&instruction));

    assert_eq!(remembered.at, Some(destination));
}

#[test]
fn effect_phase_remembers_the_destination_as_the_landing() {
    let destination = Point { x: 800.0, y: 300.0 };
    let instruction =
        instruction(destination.clone(), false).with_phase(agent_desktop_core::CursorPhase::Effect);
    let control = presented("run-effect", instruction.clone());
    let mut remembered = state(None);

    apply_landing_memory(&control, &mut remembered, Some(&instruction));

    assert_eq!(remembered.at, Some(destination));
}

#[test]
fn travel_after_a_failed_drag_starts_near_the_new_destination_not_the_stale_grab_origin() {
    let screen = screen();
    let drag_from = Point { x: 100.0, y: 100.0 };
    let new_destination = Point { x: 800.0, y: 300.0 };

    let drag = drag_instruction(drag_from.clone(), Point { x: 500.0, y: 400.0 });
    let drag_control = presented("run-failed-drag", drag.clone());
    let mut remembered = state(None);

    apply_landing_memory(&drag_control, &mut remembered, Some(&drag));
    assert_eq!(remembered.at, Some(drag_from.clone()));

    let hide_control = CursorOverlayControl::hide("run-failed-drag".into());
    apply_landing_memory(&hide_control, &mut remembered, None);

    let fresh_travel = instruction(new_destination.clone(), false);
    let frames = motion_frames(&remembered, &fresh_travel, &screen, 120);

    let fresh_entry = Point {
        x: (new_destination.x - 180.0).clamp(screen.x, screen.x + screen.width),
        y: (new_destination.y + 108.0).clamp(screen.y, screen.y + screen.height),
    };
    assert_eq!(frames.first().map(|pose| &pose.point), Some(&fresh_entry));
    assert_ne!(frames.first().map(|pose| &pose.point), Some(&drag_from));
    assert_eq!(
        frames.last().map(|pose| &pose.point),
        Some(&new_destination)
    );
}

#[test]
fn travel_after_a_successful_drag_animates_from_the_drag_destination() {
    let screen = screen();
    let drag_from = Point { x: 100.0, y: 100.0 };
    let drag_destination = Point { x: 500.0, y: 400.0 };
    let new_destination = Point { x: 800.0, y: 300.0 };

    let drag = drag_instruction(drag_from.clone(), drag_destination.clone());
    let drag_control = presented("run-drag", drag.clone());
    let mut remembered = state(None);
    apply_landing_memory(&drag_control, &mut remembered, Some(&drag));
    assert_eq!(remembered.at, Some(drag_from.clone()));

    let effect = CursorOverlayInstruction::new(drag_destination.clone(), &overlay_config(), false)
        .expect("valid instruction")
        .with_drag_from(Some(drag_from))
        .with_phase(agent_desktop_core::CursorPhase::Effect);
    let effect_control = presented("run-drag", effect.clone());
    apply_landing_memory(&effect_control, &mut remembered, Some(&effect));
    assert_eq!(remembered.at, Some(drag_destination.clone()));

    let fresh_travel = instruction(new_destination.clone(), false);
    let frames = motion_frames(&remembered, &fresh_travel, &screen, 120);

    assert_eq!(
        frames.first().map(|pose| &pose.point),
        Some(&drag_destination)
    );
    assert_eq!(
        frames.last().map(|pose| &pose.point),
        Some(&new_destination)
    );
}
