// Added by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! What a launch can still learn once the process it started has exited.
//!
//! Some programs only start another process and exit: the Calculator's
//! `calc.exe` asks the shell to activate the packaged app, whose window is then
//! owned by a process nothing links back to the launch (its parent is a shell
//! broker, not `calc.exe`). Waiting for the exited process's window spent the
//! whole timeout every time, so once it has exited the launch watches only the
//! processes it can prove it started: its descendants, linked by parent pid and
//! creation time while a handle on each parent keeps that pid from being
//! reused. When none of them is alive, no window can come from the launch, and
//! it returns at once. A window that merely appeared at the same time is never
//! taken: timing alone cannot tell it from another app opened by someone else.

use agent_desktop_core::{AdapterError, Deadline, ProcessId, WindowFilter, WindowInfo};

/// The guidance a launch reports when its process exited without a window it
/// could tie back to the launch.
pub(super) const EXITED_WITHOUT_WINDOW: &str = "The launched process exited without a window of \
     its own. The app may show its window from another process (for example a packaged app \
     started through the shell). Run `list-windows` to find that window; it was not taken here \
     because nothing ties it to this launch.";

/// The launched process and every descendant proven to be its own.
pub(super) struct Lineage {
    members: Vec<Member>,
}

struct Member {
    pid: ProcessId,
    token: Option<String>,
    process: Process,
}

impl Lineage {
    /// Starts the lineage from the handle `CreateProcessW` returned, so the
    /// launched pid cannot be reused while the launch watches it.
    pub(super) fn new(pid: ProcessId, token: &str, process: Process) -> Self {
        Self {
            members: vec![Member {
                pid,
                token: Some(token.to_string()),
                process,
            }],
        }
    }

    pub(super) fn launched_has_exited(&self) -> bool {
        self.members[0].process.has_exited()
    }

    /// Adds every running process whose parent is a member and that was
    /// created while that member was alive.
    pub(super) fn refresh(&mut self) {
        let rows = parent_rows();
        loop {
            let mut added = false;
            for &(pid, parent) in &rows {
                if self.members.iter().any(|member| member.pid == pid) {
                    continue;
                }
                let Some(parent) = self.members.iter().find(|member| member.pid == parent) else {
                    continue;
                };
                let Some(process) = Process::open(pid) else {
                    continue;
                };
                let (Some(child), Some(lifetime)) = (process.created(), parent.process.lifetime())
                else {
                    continue;
                };
                if !created_within(lifetime, child) {
                    continue;
                }
                let token = super::process_identity::token_for_pid(pid).ok().flatten();
                self.members.push(Member {
                    pid,
                    token,
                    process,
                });
                added = true;
            }
            if !added {
                return;
            }
        }
    }

    /// The descendants still running, each with its process instance.
    pub(super) fn live_descendants(&self) -> Vec<(ProcessId, Option<String>)> {
        self.members[1..]
            .iter()
            .filter(|member| !member.process.has_exited())
            .map(|member| (member.pid, member.token.clone()))
            .collect()
    }

    pub(super) fn pids(&self) -> Vec<ProcessId> {
        self.members.iter().map(|member| member.pid).collect()
    }
}

/// Whether a process created at `child` ticks was created while a parent with
/// this `(created, exited)` lifetime was alive. A process carrying the parent's
/// pid but created outside that span is the child of an earlier or later
/// process that had the same pid, not of this one.
pub(super) fn created_within(parent: (u64, Option<u64>), child: u64) -> bool {
    let (created, exited) = parent;
    child >= created && exited.is_none_or(|exited| child <= exited)
}

/// The first window owned by one of `owners` whose process instance still is
/// the one recorded for that owner. A window whose owner pid now names another
/// process is passed over: it is not the descendant's.
pub(super) fn owned_window(
    windows: Vec<WindowInfo>,
    owners: &[(ProcessId, Option<String>)],
) -> Option<WindowInfo> {
    windows.into_iter().find(|window| {
        owners.iter().any(|(pid, token)| {
            window.pid == *pid && token.is_some() && window.process_instance == *token
        })
    })
}

/// One look at the window inventory for a window of a live descendant.
pub(super) fn descendant_window(
    owners: &[(ProcessId, Option<String>)],
    deadline: Deadline,
) -> Result<Option<WindowInfo>, AdapterError> {
    let filter = WindowFilter {
        focused_only: false,
        app: None,
    };
    match super::list_windows_live(&filter, deadline) {
        Ok(windows) => Ok(owned_window(windows, owners)),
        Err(error) if super::is_unobservable_within_budget(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

/// An owned process handle with the rights to wait on it and read its times.
#[cfg(target_os = "windows")]
pub(super) struct Process(windows_sys::Win32::Foundation::HANDLE);

#[cfg(target_os = "windows")]
impl Process {
    /// Takes ownership of a handle, such as the one `CreateProcessW` returns.
    pub(super) fn from_handle(handle: windows_sys::Win32::Foundation::HANDLE) -> Self {
        Self(handle)
    }

    fn open(pid: ProcessId) -> Option<Self> {
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        };
        let access = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE;
        let handle = unsafe { OpenProcess(access, 0, u32::from(pid)) };
        (!handle.is_null()).then_some(Self(handle))
    }

    fn has_exited(&self) -> bool {
        use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
        use windows_sys::Win32::System::Threading::WaitForSingleObject;
        unsafe { WaitForSingleObject(self.0, 0) == WAIT_OBJECT_0 }
    }

    fn created(&self) -> Option<u64> {
        self.lifetime().map(|(created, _)| created)
    }

    /// Creation and, once exited, exit time in `FILETIME` ticks.
    fn lifetime(&self) -> Option<(u64, Option<u64>)> {
        use windows_sys::Win32::Foundation::FILETIME;
        use windows_sys::Win32::System::Threading::GetProcessTimes;
        let mut created = FILETIME::default();
        let mut exited = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        let ok =
            unsafe { GetProcessTimes(self.0, &mut created, &mut exited, &mut kernel, &mut user) };
        if ok == 0 {
            return None;
        }
        let ticks =
            |time: FILETIME| (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime);
        let exited = self.has_exited().then(|| ticks(exited));
        Some((ticks(created), exited))
    }
}

#[cfg(target_os = "windows")]
impl Drop for Process {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
}

/// Every process's pid and parent pid, from one ToolHelp snapshot. A snapshot
/// that cannot be taken reads as no processes: the launch then finds no
/// descendant and reports no window rather than failing a launch that started.
#[cfg(target_os = "windows")]
fn parent_rows() -> Vec<(ProcessId, ProcessId)> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Vec::new();
    }
    let mut rows = Vec::new();
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) };
    while ok != 0 {
        rows.push((
            ProcessId::from(entry.th32ProcessID),
            ProcessId::from(entry.th32ParentProcessID),
        ));
        ok = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    unsafe { CloseHandle(snapshot) };
    rows
}

#[cfg(not(target_os = "windows"))]
pub(super) struct Process;

#[cfg(not(target_os = "windows"))]
impl Process {
    fn open(_pid: ProcessId) -> Option<Self> {
        None
    }

    fn has_exited(&self) -> bool {
        false
    }

    fn created(&self) -> Option<u64> {
        None
    }

    fn lifetime(&self) -> Option<(u64, Option<u64>)> {
        None
    }
}

#[cfg(not(target_os = "windows"))]
fn parent_rows() -> Vec<(ProcessId, ProcessId)> {
    Vec::new()
}

#[cfg(test)]
#[path = "launch_handoff_tests.rs"]
mod tests;
