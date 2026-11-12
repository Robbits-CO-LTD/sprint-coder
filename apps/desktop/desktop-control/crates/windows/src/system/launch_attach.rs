// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use std::path::{Path, PathBuf};

use agent_desktop_core::{
    AdapterError, Deadline, ErrorCode, ProcessId, system::launch_options::LaunchOptions,
    system::launch_result::LaunchResult,
};

use super::super::app_ops::{ProcessRow, process_snapshot};
use super::super::launch_path::{image_file_name, resolve_executable};
use super::super::process_identity;
use super::launch_handoff::Process;

/// What a launch knows before it starts anything: the executable it would
/// start, the running instance it attached to instead (if it did), and the
/// processes of that same executable that were already running, held open
/// so a reused pid is never mistaken for one of them.
pub(super) struct Prepared {
    pub(super) executable: PathBuf,
    pub(super) attached: Option<LaunchResult>,
    pub(super) running: Vec<Process>,
}

/// Whether this launch may attach to a running instance instead of starting
/// one. Only a bare launch may: arguments, environment and a working
/// directory reach only a process this launch creates, so attaching would
/// report success while silently dropping them, and `--no-attach` asks for a
/// new instance outright.
pub(super) fn may_attach(options: &LaunchOptions) -> bool {
    options.attach_if_running
        && options.args.is_empty()
        && options.env.is_empty()
        && options.cwd.is_none()
}

pub(super) fn prepare(
    id: &str,
    options: &LaunchOptions,
    deadline: Deadline,
) -> Result<Prepared, AdapterError> {
    let executable = resolve_executable(id)?;
    let matches = matching_processes(image_file_name(id))?;
    let mut exact_matches = Vec::new();
    let mut running = Vec::new();
    for row in matches {
        let Some(process) = ProcessPin::open(row.pid) else {
            continue;
        };
        let Some(image_path) = process.image_path() else {
            continue;
        };
        if same_executable_path(&executable, &image_path) {
            // Opened while the pin still holds the pid, so it is the same process.
            running.extend(Process::open(row.pid));
            exact_matches.push(row);
        }
    }
    if !may_attach(options) {
        return Ok(Prepared {
            executable,
            attached: None,
            running,
        });
    }
    if exact_matches.len() > 1 {
        return Err(super::ambiguous_apps(&exact_matches));
    }
    if let Some(row) = exact_matches.pop() {
        let token = process_identity::token_for_pid(row.pid)?.ok_or_else(|| {
            AdapterError::new(
                ErrorCode::AppUnresponsive,
                "Running process has no exact process instance token",
            )
        })?;
        let window = super::observe_window(row.pid, &token, options, deadline)?;
        let mut attached = super::launch_result(id, row.pid, token, window);
        attached.attached = true;
        attached.suggestion = Some(ATTACHED.to_string());
        return Ok(Prepared {
            executable,
            attached: Some(attached),
            running: Vec::new(),
        });
    }
    Ok(Prepared {
        executable,
        attached: None,
        running: Vec::new(),
    })
}

/// The guidance a launch reports when it attached to an instance that was
/// already running instead of starting one.
pub(super) const ATTACHED: &str = "The app was already running, so nothing was started: this \
     result names that running instance, whose windows the user may already have open. Pass \
     --no-attach to start a new instance of your own.";

/// The guidance a launch reports when the process it started exited without
/// a window of its own while an instance of the same executable was running.
pub(super) const HANDED_OFF: &str = "The launched process exited without a window of its own \
     while an instance of the same app was already running: the app most likely passed the \
     launch to that running instance (a single-instance app). Its windows belong to the running \
     instance, which the user may already have open; none of them was started by this launch.";

pub(super) fn matching_processes(image: &str) -> Result<Vec<ProcessRow>, AdapterError> {
    Ok(process_snapshot()?
        .into_iter()
        .filter(|row| row.name.eq_ignore_ascii_case(image))
        .collect())
}

fn same_executable_path(expected: &Path, actual: &Path) -> bool {
    std::fs::canonicalize(expected)
        .ok()
        .zip(std::fs::canonicalize(actual).ok())
        .is_some_and(|(expected, actual)| expected == actual)
}

#[cfg(target_os = "windows")]
struct ProcessPin(windows_sys::Win32::Foundation::HANDLE);

#[cfg(target_os = "windows")]
impl ProcessPin {
    fn open(pid: ProcessId) -> Option<Self> {
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };

        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, u32::from(pid)) };
        (!handle.is_null()).then_some(Self(handle))
    }

    fn image_path(&self) -> Option<PathBuf> {
        use std::os::windows::ffi::OsStringExt;
        use windows_sys::Win32::System::Threading::QueryFullProcessImageNameW;

        let mut buffer = vec![0_u16; 32_768];
        let mut size = buffer.len() as u32;
        let ok = unsafe { QueryFullProcessImageNameW(self.0, 0, buffer.as_mut_ptr(), &mut size) };
        if ok == 0 || size == 0 {
            return None;
        }
        Some(PathBuf::from(std::ffi::OsString::from_wide(
            &buffer[..size as usize],
        )))
    }
}

#[cfg(target_os = "windows")]
impl Drop for ProcessPin {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
}

#[cfg(not(target_os = "windows"))]
struct ProcessPin;

#[cfg(not(target_os = "windows"))]
impl ProcessPin {
    fn open(_pid: ProcessId) -> Option<Self> {
        None
    }

    fn image_path(&self) -> Option<PathBuf> {
        None
    }
}
