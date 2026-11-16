// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use agent_desktop_core::{
    AdapterError, CursorMotion, CursorMotionProfile, CursorOverlayConfig, CursorOverlayControl,
    CursorOverlayInstruction, CursorOverlayStyle, CursorPhase, CursorPose, ErrorCode, Point,
};
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::bridge;

pub(super) const MARKER: &str = "AGENT_DESKTOP_CURSOR_OVERLAY_CHILD";
pub(super) const SOCKET_ENV: &str = "AGENT_DESKTOP_CURSOR_OVERLAY_SOCKET";
const MAX_INSTRUCTION_BYTES: u64 = 4 * 1024;

#[derive(Default)]
struct OverlayState {
    style: CursorOverlayStyle,
    motion: CursorMotionProfile,
    moves: u64,
    at: Option<Point>,
    resting: bool,
    /// The window the cursor is drawn at the height of, as the last
    /// instruction named it.
    anchor: Anchor,
}

/// The window an instruction names for the cursor.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) enum Anchor {
    /// None (a bare coordinate, the greeting): drawn above every window.
    #[default]
    Free,
    /// This CoreGraphics window number: drawn at its height while it is on the
    /// screen, hidden while it is not.
    Window(u32),
    /// A window was named but its id is not a window number: hidden, as a
    /// window that cannot be confirmed on the screen is.
    Unreadable,
}

/// How often the shown cursor is put back at its window's height, as the
/// Windows renderer does between actions.
const RESTACK_EVERY: Duration = Duration::from_millis(1_500);
/// How often the host and the session are checked.
const CHECK_EVERY: Duration = Duration::from_secs(1);
/// How long an awake renderer waits for the next control between frames.
const AWAKE_WAIT: Duration = Duration::from_millis(8);

pub(crate) fn entry_from_env() -> Option<Result<(), AdapterError>> {
    match std::env::var(MARKER) {
        Err(_) => None,
        Ok(value) if value == super::endpoint::PROTOCOL_VERSION => Some(run()),
        Ok(_) => Some(Err(AdapterError::internal(
            "Invalid cursor overlay child protocol marker",
        ))),
    }
}

fn run() -> Result<(), AdapterError> {
    // Registered first, while the host is still waiting on the command that
    // started this renderer, so its id still names the host.
    let mut host = super::host_watch::HostWatch::from_env();
    if host.host_gone() {
        return Ok(());
    }
    let initial = read_control(std::io::stdin())?;
    if !session_active(initial.session_id(), initial.agent_id()) {
        return Ok(());
    }
    let socket = socket_path(&initial)?;
    prepare_socket(&socket)?;
    // A retire that found no renderer listening (this one, not yet bound)
    // leaves a mark: a renderer started for an agent that has since finished
    // draws nothing.
    if super::endpoint::take_retired_mark(&socket) {
        return cleanup(socket);
    }
    let mut state = OverlayState::default();
    if !handle(&initial, &mut state)? {
        return cleanup(socket);
    }
    let listener = UnixListener::bind(&socket).map_err(|error| {
        AdapterError::internal("Could not bind the cursor overlay session socket")
            .with_platform_detail(error.to_string())
    })?;
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600)).map_err(|error| {
        AdapterError::internal("Could not protect the cursor overlay session socket")
            .with_platform_detail(error.to_string())
    })?;
    listener.set_nonblocking(true).map_err(|error| {
        AdapterError::internal("Could not configure the cursor overlay session socket")
            .with_platform_detail(error.to_string())
    })?;
    // Checked again once bound: a retire that came between the check above and
    // the bind found no one to tell, and its mark is there by now.
    if super::endpoint::take_retired_mark(&socket) {
        drop(listener);
        return cleanup(socket);
    }
    let mut quiet_since = std::time::Instant::now();
    let mut checked_session = quiet_since;
    let mut restacked = quiet_since;
    loop {
        if checked_session.elapsed() >= CHECK_EVERY {
            if checks_end_renderer(&mut host, || {
                session_active(initial.session_id(), initial.agent_id())
            }) {
                return cleanup(socket);
            }
            checked_session = std::time::Instant::now();
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                if prepare_stream(&stream).is_err() {
                    continue;
                }
                let Ok(control) = read_control(&mut stream) else {
                    continue;
                };
                if !addressed_to(&initial, &control) {
                    continue;
                }
                // A retire reaches only its own agent's renderer (checked above)
                // and ends it as a disable does.
                if ends_renderer(&control) {
                    drop(listener);
                    cleanup(socket)?;
                    let _ = stream.write_all(&[1]);
                    return Ok(());
                }
                if state.resting && control.is_caret_follow() {
                    let _ = stream.write_all(&[1]);
                    continue;
                }
                quiet_since = std::time::Instant::now();
                if std::mem::take(&mut state.resting) {
                    // The window this control names is set before the cursor
                    // comes back, so it never shows for a moment where the
                    // last one (or none, above every window) put it. Only a
                    // control that passes its checks may move it, as in `handle`.
                    if control.validate().is_ok() {
                        adopt_anchor(&control, &mut state);
                    }
                    bridge::show();
                    restacked = std::time::Instant::now();
                }
                let outcome = handle(&control, &mut state);
                if outcome.is_ok() && control.expects_acknowledgement() {
                    let _ = stream.write_all(&[1]);
                }
                if outcome.is_err() {
                    continue;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                bridge::idle();
                if !state.resting
                    && !bridge::drag_active()
                    && quiet_since.elapsed().as_millis() >= u128::from(state.style.rest_after_ms())
                {
                    bridge::rest();
                    state.resting = true;
                }
                if !state.resting && restacked.elapsed() >= RESTACK_EVERY {
                    bridge::restack();
                    restacked = std::time::Instant::now();
                }
                wait_for_connection(
                    &listener,
                    idle_wait(state.resting, checked_session.elapsed()),
                );
            }
            Err(error) => {
                let _ = cleanup(socket);
                return Err(
                    AdapterError::internal("Cursor overlay session socket failed")
                        .with_platform_detail(error.to_string()),
                );
            }
        }
    }
}

/// Whether the periodic check ends the renderer: the host has exited, or the
/// session (or this agent's place in it) is over.
fn checks_end_renderer(
    host: &mut super::host_watch::HostWatch,
    session_active: impl FnOnce() -> bool,
) -> bool {
    host.host_gone() || !session_active()
}

/// How long the idle loop waits for the next control. Awake, a frame; at rest
/// nothing is drawn, so it sleeps until the next host and session check (a
/// control still wakes it at once).
fn idle_wait(resting: bool, since_check: Duration) -> Duration {
    if resting {
        CHECK_EVERY.saturating_sub(since_check).max(AWAKE_WAIT)
    } else {
        AWAKE_WAIT
    }
}

/// Whether a control sent to this renderer's socket is for it: its session,
/// and its own agent, except a session-wide hide, show or disable (which names
/// no agent). A retire always names its agent, so one for another agent is
/// dropped.
fn addressed_to(initial: &CursorOverlayControl, control: &CursorOverlayControl) -> bool {
    control.session_id() == initial.session_id()
        && (control.agent_id() == initial.agent_id()
            || (control.agent_id().is_none() && (control.is_transient() || control.is_disable())))
}

/// The window an instruction puts the cursor at the height of: the window it
/// names (`w-<number>`), or none for a bare coordinate - except a caret-follow,
/// which only moves the caret an earlier instruction placed and keeps its
/// window, as the Windows renderer does. A named id that is not a window
/// number hides the cursor rather than putting it above every window.
fn next_anchor(instruction: &CursorOverlayInstruction, previous: Anchor) -> Anchor {
    let Some(id) = instruction.window() else {
        return if instruction.phase() == CursorPhase::CaretFollow {
            previous
        } else {
            Anchor::Free
        };
    };
    id.strip_prefix("w-")
        .filter(|number| number.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|number| number.parse::<u32>().ok())
        .filter(|number| *number != 0)
        .map_or(Anchor::Unreadable, Anchor::Window)
}

/// Takes the window a control's instruction names as the one the cursor is
/// drawn at the height of, and tells the renderer. A control without an
/// instruction keeps the window it has.
fn adopt_anchor(control: &CursorOverlayControl, state: &mut OverlayState) {
    if let Some(instruction) = control.instruction() {
        state.anchor = next_anchor(instruction, state.anchor);
        bridge::set_anchor(state.anchor);
    }
}

/// Waits up to `timeout` for the next control, waking as soon as one
/// connects, so a control is drawn within the frame it was sent in rather
/// than after a fixed sleep.
fn wait_for_connection(listener: &std::os::unix::net::UnixListener, timeout: Duration) {
    let mut ready = libc::pollfd {
        fd: std::os::fd::AsRawFd::as_raw_fd(listener),
        events: libc::POLLIN,
        revents: 0,
    };
    let millis = libc::c_int::try_from(timeout.as_millis()).unwrap_or(libc::c_int::MAX);
    unsafe { libc::poll(&mut ready, 1, millis) };
}

fn prepare_stream(stream: &UnixStream) -> std::io::Result<()> {
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_secs(1)))?;
    stream.set_write_timeout(Some(Duration::from_secs(1)))
}

/// Whether a control ends the renderer rather than drawing: a disable, or a
/// retire (which carries no instruction and would otherwise be drawn as a
/// fresh greeting cursor).
fn ends_renderer(control: &CursorOverlayControl) -> bool {
    control.is_disable() || control.is_retire()
}

fn handle(control: &CursorOverlayControl, state: &mut OverlayState) -> Result<bool, AdapterError> {
    control.validate()?;
    if ends_renderer(control) {
        return Ok(false);
    }
    if let Some(image_changed) = absorb_settings(control, state) {
        bridge::apply_style(&state.style, image_changed);
    }
    if control.is_hide() {
        bridge::hide();
        apply_landing_memory(control, state, None);
        return Ok(true);
    }
    if control.is_show() {
        bridge::show();
        apply_landing_memory(control, state, None);
        return Ok(true);
    }
    let owned;
    let instruction = if let Some(instruction) = control.instruction() {
        adopt_anchor(control, state);
        instruction
    } else {
        let greeting_over_image = control.is_enable() && state.style.image().is_some();
        let label = control.label().filter(|_| !greeting_over_image);
        let config = CursorOverlayConfig::enabled(label.map(str::to_owned), 12)?;
        owned = CursorOverlayInstruction::new(bridge::initial_point()?, &config, false)?;
        &owned
    };
    render(instruction, state)?;
    apply_landing_memory(control, state, Some(instruction));
    advance_moves(control, state);
    Ok(true)
}

fn absorb_settings(control: &CursorOverlayControl, state: &mut OverlayState) -> Option<bool> {
    if let Some(motion) = control.motion() {
        state.motion = motion.clone();
    }
    if control.is_enable() {
        state.moves = 0;
    }
    absorb_style(control, state)
}

fn advance_moves(control: &CursorOverlayControl, state: &mut OverlayState) {
    if control
        .instruction()
        .is_some_and(|instruction| instruction.phase() == CursorPhase::Travel)
    {
        state.moves = state.moves.wrapping_add(1);
    }
}

fn absorb_style(control: &CursorOverlayControl, state: &mut OverlayState) -> Option<bool> {
    let style = control.style()?;
    let image_changed = state.style.images() != style.images();
    state.style = style.clone();
    Some(image_changed)
}

fn apply_landing_memory(
    control: &CursorOverlayControl,
    state: &mut OverlayState,
    instruction: Option<&CursorOverlayInstruction>,
) {
    if control.is_hide() {
        state.at = None;
        return;
    }
    if control.is_show() {
        return;
    }
    let Some(instruction) = instruction else {
        return;
    };
    if bridge::is_caret(instruction) {
        return;
    }
    state.at = Some(if instruction.phase() == CursorPhase::Drag {
        instruction
            .drag_from()
            .unwrap_or(instruction.destination())
            .clone()
    } else {
        instruction.destination().clone()
    });
}

fn render(
    instruction: &CursorOverlayInstruction,
    state: &OverlayState,
) -> Result<(), AdapterError> {
    if bridge::apply_caret(instruction, state.at.as_ref()) {
        return Ok(());
    }
    if instruction.phase() == CursorPhase::Drag {
        let from = instruction.drag_from().unwrap_or(instruction.destination());
        let (screen, fps, reduce_motion) = bridge::screen_at(from)?;
        bridge::run(
            &[CursorPose::still(from.clone())],
            fps,
            instruction,
            reduce_motion,
            &screen,
        )?;
        bridge::begin_drag(from, state.style.ripple() && !reduce_motion);
        return Ok(());
    }
    if instruction.phase() == CursorPhase::Effect {
        bridge::end_drag(instruction.destination(), instruction.drag_from().is_some());
    }
    let (screen, fps, reduce_motion) = bridge::screen_at(instruction.destination())?;
    let shown = if state.style.highlight() {
        instruction.clone()
    } else {
        instruction.clone().with_target(None)
    };
    let frames = frames_for(state, &shown, &screen, fps, reduce_motion);
    bridge::run(&frames, fps, &shown, reduce_motion, &screen)
}

fn frames_for(
    state: &OverlayState,
    instruction: &CursorOverlayInstruction,
    screen: &agent_desktop_core::Rect,
    fps: u32,
    reduce_motion: bool,
) -> Vec<CursorPose> {
    if reduce_motion {
        vec![CursorPose::still(instruction.destination().clone())]
    } else {
        motion_frames(state, instruction, screen, fps)
    }
}

fn motion_frames(
    state: &OverlayState,
    instruction: &CursorOverlayInstruction,
    screen: &agent_desktop_core::Rect,
    fps: u32,
) -> Vec<CursorPose> {
    let destination = instruction.destination();
    if instruction.phase() == CursorPhase::Effect {
        let mut frames = vec![CursorPose::still(destination.clone())];
        if instruction.is_click() && state.style.ripple() {
            frames.push(CursorPose {
                point: destination.clone(),
                ripple: 1.0,
            });
        }
        return frames;
    }
    let start = state.at.clone().unwrap_or_else(|| Point {
        x: (destination.x - 180.0).clamp(screen.x, screen.x + screen.width),
        y: (destination.y + 108.0).clamp(screen.y, screen.y + screen.height),
    });
    let motion = CursorMotion::shaped(start, destination.clone(), &state.motion, state.moves)
        .with_impact(instruction.is_click())
        .with_ripple(state.style.ripple());
    let frame_ms = 1_000.0 / f64::from(fps);
    let frame_count = (motion.total_ms() as f64 / frame_ms).ceil() as u64;
    (0..=frame_count)
        .map(|frame| {
            let elapsed = ((frame as f64 * frame_ms).round() as u64).min(motion.total_ms());
            motion.pose(elapsed)
        })
        .collect()
}

fn read_control(reader: impl Read) -> Result<CursorOverlayControl, AdapterError> {
    let mut payload = Vec::new();
    reader
        .take(MAX_INSTRUCTION_BYTES + 1)
        .read_to_end(&mut payload)
        .map_err(|error| {
            AdapterError::internal("Could not read cursor overlay control")
                .with_platform_detail(error.to_string())
        })?;
    if payload.len() as u64 > MAX_INSTRUCTION_BYTES {
        return Err(AdapterError::internal(
            "Cursor overlay instruction exceeds the transport limit",
        ));
    }
    let control: CursorOverlayControl = serde_json::from_slice(&payload).map_err(|error| {
        AdapterError::internal("Could not decode cursor overlay control")
            .with_platform_detail(error.to_string())
    })?;
    control.validate()?;
    Ok(control)
}

fn socket_path(control: &CursorOverlayControl) -> Result<PathBuf, AdapterError> {
    let expected = super::endpoint::path(control.session_id(), control.agent_id())?;
    let supplied = std::env::var_os(SOCKET_ENV)
        .map(PathBuf::from)
        .ok_or_else(|| AdapterError::internal("Cursor overlay child socket is missing"))?;
    if supplied != expected {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Cursor overlay child socket does not match its session",
        ));
    }
    Ok(expected)
}

pub(super) fn session_active(session_id: &str, agent_id: Option<&str>) -> bool {
    agent_desktop_core::session::read_manifest(session_id)
        .ok()
        .flatten()
        .is_some_and(|manifest| {
            manifest.ended_at.is_none()
                && manifest.cursor_overlay.is_enabled()
                && !(manifest.cursor_overlay.is_multi_agent() && agent_id.is_none())
        })
}

fn prepare_socket(path: &Path) -> Result<(), AdapterError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(
            AdapterError::internal("Could not replace stale cursor overlay socket")
                .with_platform_detail(error.to_string()),
        ),
    }
}

fn cleanup(path: PathBuf) -> Result<(), AdapterError> {
    bridge::stop();
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(
            AdapterError::internal("Could not remove cursor overlay socket")
                .with_platform_detail(error.to_string()),
        ),
    }
}

#[cfg(test)]
#[path = "child_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "child_motion_tests.rs"]
mod motion_tests;

#[cfg(test)]
#[path = "child_image_tests.rs"]
mod image_tests;
