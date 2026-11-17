// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use agent_desktop_core::{AdapterError, Deadline, ErrorCode};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use super::clipboard_helper_identity::HelperIdentity;
use super::clipboard_helper_protocol as protocol;

const CLEANUP_RESERVE: Duration = Duration::from_millis(100);
const POLL_INTERVAL: Duration = Duration::from_millis(5);

/// Where the helper runs and how a failed run ends it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Termination {
    /// Upstream: a process group of its own, ended as a group.
    OwnGroup,
    /// Sprint Coder: the caller's process group, so a signal to that group (Sprint Coder's Stop)
    /// ends the helper with the CLI; a failed run ends only the helper's own pid. The helper starts
    /// no processes of its own.
    CallerGroup,
}

pub(crate) fn run(
    command: &mut Command,
    input: &[u8],
    deadline: Deadline,
    identity: Option<&HelperIdentity>,
    termination: Termination,
) -> Result<Vec<u8>, AdapterError> {
    let absolute = Instant::now()
        .checked_add(deadline.remaining())
        .ok_or_else(|| AdapterError::timeout("Clipboard helper deadline overflowed"))?;
    let work_deadline = absolute
        .checked_sub(CLEANUP_RESERVE)
        .filter(|limit| *limit > Instant::now())
        .ok_or_else(|| deadline.timeout_error())?;
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if termination == Termination::OwnGroup {
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(spawn_error)?;
    let pid = i32::try_from(child.id()).map_err(|_| {
        let _ = child.kill();
        let _ = child.wait();
        AdapterError::internal("Clipboard helper PID exceeds the macOS pid_t range")
    })?;
    let process_group = match termination {
        Termination::OwnGroup => Target::Group(pid),
        Termination::CallerGroup => Target::Child,
    };
    let Some(stdin) = child.stdin.take() else {
        return cleanup_bare(
            child,
            process_group,
            absolute,
            AdapterError::internal("Clipboard helper stdin is unavailable"),
        );
    };
    let Some(stdout) = child.stdout.take() else {
        drop(stdin);
        return cleanup_bare(
            child,
            process_group,
            absolute,
            AdapterError::internal("Clipboard helper output FD is unavailable"),
        );
    };
    let writer = spawn_writer(stdin, input.to_vec());
    let reader = spawn_reader(stdout);
    if let Some(identity) = identity
        && let Err(error) = identity.revalidate()
    {
        return cleanup(child, process_group, writer, reader, absolute, error);
    }
    let status = match wait_status(&mut child, work_deadline) {
        Ok(status) => status,
        Err(error) => return cleanup(child, process_group, writer, reader, absolute, error),
    };
    let write_result = receive(&writer, work_deadline, "writing request");
    let read_result = receive(&reader, work_deadline, "reading response");
    match (write_result, read_result) {
        (Ok(()), Ok(output)) => {
            join_thread(writer.1)?;
            join_thread(reader.1)?;
            if !status.success() && output.is_empty() {
                return Err(mark_dispatched(AdapterError::new(
                    ErrorCode::AppUnresponsive,
                    format!("macOS clipboard helper exited with {status}"),
                )));
            }
            Ok(output)
        }
        (write, read) => cleanup(
            child,
            process_group,
            writer,
            reader,
            absolute,
            write
                .err()
                .or_else(|| read.err())
                .unwrap_or_else(|| AdapterError::internal("Clipboard helper I/O failed")),
        ),
    }
}

fn spawn_error(error: std::io::Error) -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionNotSupported,
        "The packaged macOS clipboard helper could not be started",
    )
    .with_platform_detail(error.to_string())
    .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered())
}

fn wait_status(child: &mut Child, deadline: Instant) -> Result<ExitStatus, AdapterError> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(POLL_INTERVAL),
            Ok(None) => return Err(AdapterError::timeout("macOS clipboard helper timed out")),
            Err(error) => {
                return Err(AdapterError::internal(format!(
                    "Inspect macOS clipboard helper: {error}"
                )));
            }
        }
    }
}

type IoThread<T> = (
    mpsc::Receiver<std::io::Result<T>>,
    std::thread::JoinHandle<()>,
);

fn spawn_writer(mut stdin: impl Write + Send + 'static, input: Vec<u8>) -> IoThread<()> {
    spawn_io(move || stdin.write_all(&input))
}

fn spawn_reader(mut output: impl Read + Send + 'static) -> IoThread<Vec<u8>> {
    spawn_io(move || {
        let mut bytes = Vec::new();
        output
            .by_ref()
            .take((protocol::MAX_RESPONSE_BYTES + 1) as u64)
            .read_to_end(&mut bytes)?;
        if bytes.len() > protocol::MAX_RESPONSE_BYTES {
            return Err(std::io::Error::other(
                "clipboard helper response exceeds limit",
            ));
        }
        Ok(bytes)
    })
}

fn spawn_io<T: Send + 'static>(
    operation: impl FnOnce() -> std::io::Result<T> + Send + 'static,
) -> IoThread<T> {
    let (sender, receiver) = mpsc::sync_channel(1);
    let thread = std::thread::spawn(move || {
        let _ = sender.send(operation());
    });
    (receiver, thread)
}

fn receive<T>(thread: &IoThread<T>, deadline: Instant, phase: &str) -> Result<T, AdapterError> {
    thread
        .0
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .map_err(|_| AdapterError::timeout(format!("Timed out {phase} for clipboard helper")))?
        .map_err(|error| AdapterError::internal(format!("Clipboard helper {phase}: {error}")))
}

/// What a failed run kills: the helper's own group, or only the helper (never the caller's group,
/// which holds the CLI itself).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Target {
    Group(i32),
    Child,
}

fn cleanup(
    mut child: Child,
    process_group: Target,
    writer: IoThread<()>,
    reader: IoThread<Vec<u8>>,
    deadline: Instant,
    error: AdapterError,
) -> Result<Vec<u8>, AdapterError> {
    kill_and_reap(&mut child, process_group, deadline);
    finish_thread(writer, deadline);
    finish_thread(reader, deadline);
    Err(mark_dispatched(error))
}

fn cleanup_bare(
    mut child: Child,
    process_group: Target,
    deadline: Instant,
    error: AdapterError,
) -> Result<Vec<u8>, AdapterError> {
    kill_and_reap(&mut child, process_group, deadline);
    Err(mark_dispatched(error))
}

fn kill_and_reap(child: &mut Child, process_group: Target, deadline: Instant) {
    match process_group {
        Target::Group(group) => unsafe {
            libc::kill(-group, libc::SIGKILL);
        },
        Target::Child => {
            let _ = child.kill();
        }
    }
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

fn finish_thread<T>(thread: IoThread<T>, deadline: Instant) {
    if thread
        .0
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .is_ok()
    {
        let _ = thread.1.join();
    }
}

fn join_thread(thread: std::thread::JoinHandle<()>) -> Result<(), AdapterError> {
    thread.join().map_err(|_| {
        mark_dispatched(AdapterError::internal(
            "Clipboard helper I/O thread panicked",
        ))
    })
}

pub(crate) fn mark_dispatched(mut error: AdapterError) -> AdapterError {
    let mut details = error.details.take().unwrap_or_else(|| json!({}));
    if let Some(object) = details.as_object_mut() {
        object.insert("helper_dispatched".into(), Value::Bool(true));
    }
    error.with_details(details)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hard_deadline_kills_the_helper_process_group() {
        let pgid_file = std::env::temp_dir().join(format!("ad-clip-pgid-{}", std::process::id()));
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "echo $$ > \"$1\"; sleep 60 & wait", "sh"]);
        command.arg(&pgid_file);
        let error = run(
            &mut command,
            &[],
            Deadline::after(800).unwrap(),
            None,
            Termination::OwnGroup,
        )
        .unwrap_err();

        assert_eq!(error.code, ErrorCode::Timeout);
        assert_eq!(error.details.unwrap()["helper_dispatched"], true);
        let pgid: i32 = std::fs::read_to_string(&pgid_file)
            .expect("helper reported its process group")
            .trim()
            .parse()
            .expect("process group id");
        let _ = std::fs::remove_file(&pgid_file);
        let give_up = Instant::now() + Duration::from_secs(10);
        while group_has_live_member(pgid) && Instant::now() < give_up {
            std::thread::sleep(POLL_INTERVAL);
        }
        assert!(
            !group_has_live_member(pgid),
            "helper process group {pgid} survived the deadline"
        );
    }

    fn group_has_live_member(pgid: i32) -> bool {
        unsafe { libc::kill(-pgid, 0) == 0 }
    }

    fn process_is_alive(pid: i32) -> bool {
        unsafe { libc::kill(pid, 0) == 0 }
    }

    fn fixture_dir(label: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "clipboard-helper-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn wait_for_pid(file: &std::path::Path) -> i32 {
        let give_up = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(pid) = std::fs::read_to_string(file)
                .ok()
                .and_then(|text| text.trim().parse().ok())
            {
                return pid;
            }
            assert!(Instant::now() < give_up, "the stand-in never started");
            std::thread::sleep(POLL_INTERVAL);
        }
    }

    fn wait_until_gone(pid: i32) -> bool {
        let give_up = Instant::now() + Duration::from_secs(10);
        while process_is_alive(pid) && Instant::now() < give_up {
            std::thread::sleep(POLL_INTERVAL);
        }
        !process_is_alive(pid)
    }

    #[test]
    fn a_caller_group_helper_shares_the_group_and_a_deadline_ends_only_the_helper() {
        let dir = fixture_dir("caller-deadline");
        let pid_file = dir.join("helper.pid");
        let mut command = Command::new("/bin/sh");
        // `exec` keeps the stand-in a single process, as the helper is.
        command.args(["-c", "echo $$ > \"$1\"; exec /bin/sleep 60", "sh"]);
        command.arg(&pid_file);
        let running = std::thread::spawn(move || {
            run(
                &mut command,
                &[],
                Deadline::after(1_500).unwrap(),
                None,
                Termination::CallerGroup,
            )
        });
        let pid = wait_for_pid(&pid_file);
        // Not moved to a group of its own: a signal to the caller's group reaches it.
        assert_eq!(unsafe { libc::getpgid(pid) }, unsafe { libc::getpgrp() });
        let error = running.join().unwrap().unwrap_err();
        assert_eq!(error.code, ErrorCode::Timeout);
        assert_eq!(error.details.unwrap()["helper_dispatched"], true);
        // The deadline ended the helper's pid alone; this process, in the same group, lives on.
        assert!(
            wait_until_gone(pid),
            "the helper {pid} survived the deadline"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    const STOP_WORKER_DIR: &str = "SPRINT_CODER_CLIPBOARD_STOP_TEST_DIR";
    const STOP_WORKER_MODE: &str = "SPRINT_CODER_CLIPBOARD_STOP_TEST_MODE";
    const STOP_TEST: &str = "input::clipboard::clipboard_helper_process::tests::a_stop_sent_to_the_callers_group_ends_a_helper_waiting_before_its_change";

    /// Stands in for the CLI: runs a helper stand-in that waits for `go` before its "change".
    fn stop_worker(dir: &str, mode: &str) {
        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            "echo $$ > \"$1/helper.pid\"; while [ ! -e \"$1/go\" ]; do /bin/sleep 0.05; done; echo changed > \"$1/changed\"",
            "sh",
            dir,
        ]);
        let termination = if mode == "caller" {
            Termination::CallerGroup
        } else {
            Termination::OwnGroup
        };
        let _ = run(
            &mut command,
            &[],
            Deadline::after(10_000).unwrap(),
            None,
            termination,
        );
    }

    #[test]
    fn a_stop_sent_to_the_callers_group_ends_a_helper_waiting_before_its_change() {
        if let (Ok(dir), Ok(mode)) = (
            std::env::var(STOP_WORKER_DIR),
            std::env::var(STOP_WORKER_MODE),
        ) {
            stop_worker(&dir, &mode);
            return;
        }
        for (mode, ends_with_the_stop) in [("caller", true), ("own", false)] {
            let dir = fixture_dir(&format!("stop-{mode}"));
            // The worker leads a group of its own, as Sprint Coder starts the CLI.
            let mut worker = Command::new(std::env::current_exe().unwrap())
                .args([STOP_TEST, "--exact", "--nocapture", "--test-threads=1"])
                .env(STOP_WORKER_DIR, &dir)
                .env(STOP_WORKER_MODE, mode)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .process_group(0)
                .spawn()
                .unwrap();
            let worker_group = i32::try_from(worker.id()).unwrap();
            let helper = wait_for_pid(&dir.join("helper.pid"));
            // Sprint Coder's forced Stop: SIGKILL to the CLI's process group.
            unsafe { libc::kill(-worker_group, libc::SIGKILL) };
            worker.wait().unwrap();
            if ends_with_the_stop {
                assert!(
                    wait_until_gone(helper),
                    "{mode}: the helper outlived the Stop"
                );
                std::fs::write(dir.join("go"), b"").unwrap();
                std::thread::sleep(Duration::from_millis(400));
                assert!(
                    !dir.join("changed").exists(),
                    "{mode}: the change ran after the Stop"
                );
            } else {
                // Upstream's own group is out of the Stop's reach: the helper lives on and, once
                // let go, still makes its change. This is what the caller group prevents.
                std::thread::sleep(Duration::from_millis(200));
                assert!(
                    process_is_alive(helper),
                    "{mode}: expected the helper to survive"
                );
                std::fs::write(dir.join("go"), b"").unwrap();
                let give_up = Instant::now() + Duration::from_secs(5);
                while !dir.join("changed").exists() && Instant::now() < give_up {
                    std::thread::sleep(POLL_INTERVAL);
                }
                unsafe { libc::kill(-helper, libc::SIGKILL) };
                assert!(
                    dir.join("changed").exists(),
                    "{mode}: expected the change to run"
                );
                assert!(wait_until_gone(helper));
            }
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn post_dispatch_thread_failure_is_never_unmarked() {
        let error = join_thread(std::thread::spawn(|| panic!("fault"))).unwrap_err();

        assert_eq!(error.details.unwrap()["helper_dispatched"], true);
    }
}
