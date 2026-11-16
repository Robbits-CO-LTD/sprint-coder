// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use agent_desktop_core::{
    AdapterError, CURSOR_ARRIVAL_TIMEOUT_MS, CursorOverlayControl, ErrorCode,
};
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use super::child::{MARKER, SOCKET_ENV};

const MAX_INSTRUCTION_BYTES: usize = 4 * 1024;

/// The file name the upstream build carries.
const IMAGE_NAME: &str = "agent-desktop";
/// The file name the same binary carries when Sprint Coder ships it.
const BUNDLED_IMAGE_NAME: &str = "sprint-coder-desktop-control";

/// Whether `path` is this tool's own binary, which alone may be started again as
/// the renderer (a library host running under another image must not be). Only
/// the final component counts, and the whole of it must be one of the two names
/// exactly: the binary has no extension on macOS, so `….old` is another file.
fn is_own_image(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == IMAGE_NAME || name == BUNDLED_IMAGE_NAME)
}

/// Where `update` sends a control.
#[derive(Debug, PartialEq, Eq)]
enum Route {
    /// To the one agent a retire names, never starting a renderer.
    RetireAgent,
    /// To every renderer of the session.
    Broadcast,
    /// To the renderer of the control's agent, started when there is none.
    Agent,
}

fn route(control: &CursorOverlayControl) -> Route {
    if control.is_retire() {
        Route::RetireAgent
    } else if control.is_disable() || (control.is_transient() && control.agent_id().is_none()) {
        Route::Broadcast
    } else {
        Route::Agent
    }
}

pub(crate) fn update(control: &CursorOverlayControl) -> Result<(), AdapterError> {
    control.validate()?;
    match route(control) {
        Route::RetireAgent => return retire_agent(control),
        Route::Broadcast => return broadcast(control),
        Route::Agent => {}
    }
    if !control.is_transient()
        && !super::child::session_active(control.session_id(), control.agent_id())
    {
        return Ok(());
    }
    let budget = if matches!(control, CursorOverlayControl::Present { .. }) {
        CURSOR_ARRIVAL_TIMEOUT_MS
    } else {
        4_000
    };
    let deadline = Instant::now() + agent_desktop_core::Deadline::after(budget)?.remaining();
    let socket = super::endpoint::path(control.session_id(), control.agent_id())?;
    if send_until(&socket, control, deadline)? {
        return Ok(());
    }
    if control.agent_id().is_none() {
        retire_legacy(control, deadline);
    }
    if control.is_transient() {
        return Ok(());
    }
    let lock_path = super::endpoint::lock_path()?;
    let _lock = startup_lock(&lock_path, deadline)?;
    if send_until(&socket, control, deadline)? {
        return Ok(());
    }
    if !super::child::session_active(control.session_id(), control.agent_id()) {
        return Ok(());
    }
    // A mark an earlier retire of this agent left is for a renderer of that
    // time; the renderer started now is wanted.
    super::endpoint::take_retired_mark(&socket);
    spawn(&socket, control, deadline)
}

/// Takes down the one renderer of the agent a `Retire` names, as the Windows
/// renderer does: a session `Disable` goes to that agent's socket alone, a form
/// every renderer of this protocol ends on. Nothing is discovered or started.
///
/// Under the startup lock, so a renderer another command is starting for the
/// agent has bound (and is told) before this looks. A command stopped while it
/// started one releases the lock with its death, before that renderer binds;
/// so when no one is listening, a mark is left that such a renderer ends on.
fn retire_agent(control: &CursorOverlayControl) -> Result<(), AdapterError> {
    let deadline = Instant::now() + Duration::from_secs(4);
    let socket = super::endpoint::path(control.session_id(), control.agent_id())?;
    let lock_path = super::endpoint::lock_path()?;
    let _lock = startup_lock(&lock_path, deadline)?;
    retire_at(&socket, control, deadline)
}

fn retire_at(
    socket: &Path,
    control: &CursorOverlayControl,
    deadline: Instant,
) -> Result<(), AdapterError> {
    let disable = CursorOverlayControl::disable(control.session_id().to_owned());
    if send_until(socket, &disable, deadline)? {
        return Ok(());
    }
    super::endpoint::leave_retired_mark(socket)
}

/// The descriptors above stderr this process holds open without close-on-exec,
/// read before the renderer is forked. They are what a command's host handed
/// down (a supervisor's pipes): the standard library opens its own with
/// close-on-exec, so only inherited ones are left without it.
fn inherited_descriptors() -> Vec<libc::c_int> {
    let pid = unsafe { libc::getpid() };
    let entry = std::mem::size_of::<libc::proc_fdinfo>();
    let needed =
        unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0) };
    let Ok(needed) = usize::try_from(needed) else {
        return Vec::new();
    };
    // Room for descriptors opened between the calls; a list that fills the
    // buffer may have been cut short, so it is read again into a larger one.
    let mut capacity = needed / entry + 32;
    let entries = loop {
        let mut entries = vec![
            libc::proc_fdinfo {
                proc_fd: 0,
                proc_fdtype: 0
            };
            capacity
        ];
        let Ok(bytes) = libc::c_int::try_from(capacity * entry) else {
            return Vec::new();
        };
        let written = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDLISTFDS,
                0,
                entries.as_mut_ptr().cast(),
                bytes,
            )
        };
        let Ok(written) = usize::try_from(written) else {
            return Vec::new();
        };
        if written < capacity * entry {
            entries.truncate(written / entry);
            break entries;
        }
        capacity *= 2;
    };
    entries
        .into_iter()
        .map(|entry| entry.proc_fd)
        .filter(|fd| *fd > 2)
        .filter(|fd| {
            let flags = unsafe { libc::fcntl(*fd, libc::F_GETFD) };
            flags != -1 && flags & libc::FD_CLOEXEC == 0
        })
        .collect()
}

/// Makes the started process hold no descriptor but its stdin, stdout and
/// stderr. Without this the renderer kept the pipes of the command that
/// started it, and the command's host waited for those to close long after
/// the command had ended. Set to close on exec in the forked child rather
/// than closed, so the standard library's own pipe that reports a failed exec
/// stays as it is; only `fcntl` runs between fork and exec.
fn close_inherited_on_exec(command: &mut Command) {
    let descriptors = inherited_descriptors();
    unsafe {
        command.pre_exec(move || {
            for fd in &descriptors {
                libc::fcntl(*fd, libc::F_SETFD, libc::FD_CLOEXEC);
            }
            Ok(())
        });
    }
}

fn broadcast(control: &CursorOverlayControl) -> Result<(), AdapterError> {
    let lock_path = super::endpoint::lock_path()?;
    let deadline = Instant::now() + Duration::from_secs(4);
    let _lock = startup_lock(&lock_path, deadline)?;
    let (paths, mut first_error) = super::endpoint::discover(control.session_id())?;
    for socket in paths {
        if Instant::now() >= deadline {
            return Err(AdapterError::internal(
                "Timed out stopping macOS cursor overlays",
            ));
        }
        if let Err(error) = send_until(&socket, control, deadline) {
            first_error.get_or_insert(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

fn startup_lock(
    path: &Path,
    deadline: Instant,
) -> Result<agent_desktop_core::FileLock, AdapterError> {
    agent_desktop_core::FileLock::acquire(
        path,
        agent_desktop_core::Deadline::detached_after(
            deadline
                .saturating_duration_since(Instant::now())
                .as_millis() as u64,
        )?,
        "cursor overlay startup lock",
    )
}

fn spawn(
    socket: &Path,
    control: &CursorOverlayControl,
    deadline: Instant,
) -> Result<(), AdapterError> {
    if Instant::now() >= deadline {
        return Err(AdapterError::internal(
            "Cursor overlay startup deadline elapsed",
        ));
    }
    let executable = std::env::current_exe().map_err(|error| {
        AdapterError::internal("Could not locate the cursor overlay executable")
            .with_platform_detail(error.to_string())
    })?;
    if !is_own_image(&executable) {
        return Ok(());
    }
    let payload = serde_json::to_vec(control).map_err(|error| {
        AdapterError::internal("Could not encode macOS cursor overlay control")
            .with_platform_detail(error.to_string())
    })?;
    if payload.len() > MAX_INSTRUCTION_BYTES {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Cursor overlay instruction exceeds the transport limit",
        ));
    }
    let mut command = Command::new(executable);
    close_inherited_on_exec(&mut command);
    let mut child = command
        .env(MARKER, super::endpoint::PROTOCOL_VERSION)
        .env(SOCKET_ENV, socket)
        .process_group(0)
        .current_dir("/")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            AdapterError::internal("Could not start the macOS cursor overlay")
                .with_platform_detail(error.to_string())
        })?;
    let Some(mut stdin) = child.stdin.take() else {
        let exited = terminate_child(&mut child);
        return Err(AdapterError::internal(if exited {
            "Cursor overlay child did not expose its input pipe"
        } else {
            "Cursor overlay child could not be reaped after startup failure"
        }));
    };
    if let Err(error) = stdin.write_all(&payload) {
        if !terminate_child(&mut child) {
            return Err(AdapterError::internal(
                "Cursor overlay child did not exit after startup failure",
            ));
        }
        return Err(
            AdapterError::internal("Could not send the cursor overlay control")
                .with_platform_detail(error.to_string()),
        );
    }
    drop(stdin);
    while Instant::now() < deadline {
        if UnixStream::connect(socket).is_ok() {
            thread::spawn(move || {
                let _ = child.wait();
            });
            return Ok(());
        }
        thread::sleep(Duration::from_millis(10));
    }
    if !terminate_child(&mut child) {
        return Err(AdapterError::internal(
            "Cursor overlay child did not exit after startup failure",
        ));
    }
    Err(AdapterError::internal(
        "macOS cursor overlay did not become ready",
    ))
}

fn terminate_child(child: &mut std::process::Child) -> bool {
    let _ = child.kill();
    let deadline = Instant::now() + Duration::from_secs(2);
    super::super::process::poll_reap(child, deadline)
}

fn retire_legacy(control: &CursorOverlayControl, deadline: Instant) {
    let Ok(socket) = super::endpoint::legacy_path(control.session_id()) else {
        return;
    };
    let disable = CursorOverlayControl::disable(control.session_id().to_owned());
    let _ = send_until(&socket, &disable, deadline);
}

fn send_until(
    socket: &Path,
    control: &CursorOverlayControl,
    deadline: Instant,
) -> Result<bool, AdapterError> {
    let mut stream = match UnixStream::connect(socket) {
        Ok(stream) => stream,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
            ) =>
        {
            return Ok(false);
        }
        Err(error) => {
            return Err(
                AdapterError::internal("Could not connect to the macOS cursor overlay")
                    .with_platform_detail(error.to_string()),
            );
        }
    };
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(AdapterError::internal(
            "Cursor overlay control deadline elapsed",
        ));
    }
    stream
        .set_write_timeout(Some(remaining.min(Duration::from_secs(1))))
        .map_err(|error| {
            AdapterError::internal("Could not bound the cursor overlay control write")
                .with_platform_detail(error.to_string())
        })?;
    let payload = serde_json::to_vec(control).map_err(|error| {
        AdapterError::internal("Could not encode macOS cursor overlay control")
            .with_platform_detail(error.to_string())
    })?;
    if payload.len() > MAX_INSTRUCTION_BYTES {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Cursor overlay instruction exceeds the transport limit",
        ));
    }
    stream.write_all(&payload).map_err(|error| {
        AdapterError::internal("Could not send the cursor overlay control")
            .with_platform_detail(error.to_string())
    })?;
    let travels = control.is_travel();
    if !control.expects_acknowledgement() {
        return Ok(true);
    }
    stream
        .shutdown(std::net::Shutdown::Write)
        .map_err(|error| {
            AdapterError::internal("Could not finish the cursor overlay control")
                .with_platform_detail(error.to_string())
        })?;
    let remaining = deadline.saturating_duration_since(Instant::now());
    let budget = if remaining.is_zero() {
        return Err(AdapterError::internal(
            "Timed out stopping macOS cursor overlays",
        ));
    } else if travels {
        remaining.min(Duration::from_millis(CURSOR_ARRIVAL_TIMEOUT_MS))
    } else {
        remaining
    };
    stream.set_read_timeout(Some(budget)).map_err(|error| {
        AdapterError::internal("Could not bound the cursor overlay acknowledgement")
            .with_platform_detail(error.to_string())
    })?;
    let mut acknowledgement = [0_u8; 1];
    match stream.read_exact(&mut acknowledgement) {
        Ok(()) => Ok(true),
        Err(error)
            if control.instruction().is_some_and(|instruction| {
                instruction.phase() == agent_desktop_core::CursorPhase::Travel
            }) =>
        {
            tracing::warn!(
                session = control.session_id(),
                agent = control.agent_id(),
                %error,
                "cursor overlay travel was not acknowledged; continuing without cursor confirmation"
            );
            Err(
                AdapterError::internal("macOS cursor overlay did not confirm cursor arrival")
                    .with_platform_detail(error.to_string()),
            )
        }
        Err(error)
            if control.instruction().is_some_and(|instruction| {
                instruction.phase() == agent_desktop_core::CursorPhase::Effect
            }) =>
        {
            tracing::warn!(
                session = control.session_id(),
                agent = control.agent_id(),
                %error,
                "cursor overlay effect was not acknowledged; continuing without effect confirmation"
            );
            Err(
                AdapterError::internal("macOS cursor overlay did not confirm cursor effect")
                    .with_platform_detail(error.to_string()),
            )
        }
        Err(error) => Err(AdapterError::internal(
            "macOS cursor overlay did not acknowledge the control",
        )
        .with_platform_detail(error.to_string())),
    }
}

#[cfg(test)]
#[path = "spawn_tests.rs"]
mod tests;
