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
//! it returns at once. A window of another app that merely appeared at the same
//! time is never taken: timing alone cannot tell it from one opened by someone
//! else.
//!
//! A single-instance app (a browser on its default profile, many editors) is
//! different: its new process finds the instance of the same executable that
//! was already running, asks it for a window and exits. That window belongs to
//! the running instance, so nothing above can find it, and the launch used to
//! report no window although one opened. When the launched process exited
//! without a window while such an instance runs ([`Handoff`]), the launch also
//! watches that instance, for a short while ([`HANDOFF_WINDOW_WAIT`]), for a
//! top-level window that was not shown before the launch started anything (a
//! new window, or a hidden one such as a tray app's main window that it shows
//! now), and reports it as the running instance's window (`handed_off`), never as a
//! window of a process the launch started (`new_instance` stays false).

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use agent_desktop_core::{AdapterError, Deadline, ProcessId, WindowFilter, WindowInfo};

/// The guidance a launch reports when its process exited without a window it
/// could tie back to the launch.
pub(super) const EXITED_WITHOUT_WINDOW: &str = "The launched process exited without a window of \
     its own. The app may show its window from another process (for example a packaged app \
     started through the shell). Run `list-windows` to find that window; it was not taken here \
     because nothing ties it to this launch.";

/// How long a launch that was passed to a running instance watches that
/// instance for the new window it asked for, at most. The launch's own
/// deadline still bounds it. An instance that shows an existing window
/// instead opens none, so the watch must not run to the whole deadline.
pub(super) const HANDOFF_WINDOW_WAIT: Duration = Duration::from_secs(5);

/// A process of the launch target's executable that was running before the
/// launch started anything, held open so its pid is never mistaken for a
/// later process that reused it.
pub(super) struct RunningInstance {
    pub(super) pid: ProcessId,
    pub(super) token: Option<String>,
    pub(super) process: Process,
}

/// The running instances a launch may be passed to, and the ids of every
/// top-level window that was shown before the launch started its process.
pub(super) struct Handoff {
    instances: Vec<RunningInstance>,
    /// `None` when there is no instance, or the windows could not be read:
    /// then no window can be told apart as newly shown, and none is taken.
    before: Option<HashSet<String>>,
    /// Whether several of the instances already showed windows (see
    /// [`several_instances_show_windows`]).
    several_instances: bool,
    /// When each window an instance showed after the launch started was first
    /// seen, read while the launched process still runs too (`note`), so the
    /// time since a window appeared is known when the launch is found to have
    /// been passed on, however long the launched process took to exit.
    first_seen: RefCell<HashMap<String, Instant>>,
}

impl Handoff {
    /// Reads the windows shown now; call it before the process starts.
    pub(super) fn begin(instances: Vec<RunningInstance>) -> Self {
        let shown = if instances.is_empty() {
            None
        } else {
            shown_windows()
        };
        let pids: Vec<ProcessId> = instances.iter().map(|instance| instance.pid).collect();
        let several_instances = shown
            .as_ref()
            .is_some_and(|(_, owners)| several_instances_show_windows(owners, &pids));
        Self {
            instances,
            before: shown.map(|(ids, _)| ids),
            several_instances,
            first_seen: RefCell::new(HashMap::new()),
        }
    }

    /// Whether an instance that was running before the launch still runs.
    pub(super) fn any_running(&self) -> bool {
        self.instances
            .iter()
            .any(|instance| !instance.process.has_exited())
    }

    /// One read of the windows, only to record when each window an instance
    /// showed after the launch started was first seen.
    pub(super) fn note(&self, deadline: Deadline) -> Result<(), AdapterError> {
        self.look(deadline).map(|_| ())
    }

    /// When the window `id` was first seen by `note` or `look`, if it was.
    pub(super) fn first_seen(&self, id: &str) -> Option<Instant> {
        self.first_seen.borrow().get(id).copied()
    }

    /// One look for the window a still-running instance showed for the launch.
    /// Every such window seen is recorded with the time it was first seen.
    pub(super) fn look(&self, deadline: Deadline) -> Result<HandoffLook, AdapterError> {
        let Some(before) = &self.before else {
            return Ok(HandoffLook::None);
        };
        let targets: Vec<(ProcessId, Option<String>)> = self
            .instances
            .iter()
            .filter(|instance| !instance.process.has_exited())
            .map(|instance| (instance.pid, instance.token.clone()))
            .collect();
        if targets.is_empty() {
            return Ok(HandoffLook::None);
        }
        let filter = WindowFilter {
            focused_only: false,
            app: None,
        };
        match super::list_windows_live(&filter, deadline) {
            Ok(windows) => Ok({
                record_first_seen(
                    &mut self.first_seen.borrow_mut(),
                    fresh_window_ids(&windows, &targets, before),
                    Instant::now(),
                );
                pick_handoff_window(windows, &targets, before, self.several_instances)
            }),
            Err(error) if super::is_unobservable_within_budget(&error) => Ok(HandoffLook::None),
            Err(error) => Err(error),
        }
    }
}

/// The ids of the windows of `targets` (same pid and process instance) that
/// were not shown before the launch.
pub(super) fn fresh_window_ids<'a>(
    windows: &'a [WindowInfo],
    targets: &[(ProcessId, Option<String>)],
    before: &HashSet<String>,
) -> Vec<&'a str> {
    windows
        .iter()
        .filter(|window| !before.contains(&window.id))
        .filter(|window| {
            targets.iter().any(|(pid, token)| {
                window.pid == *pid && token.is_some() && window.process_instance == *token
            })
        })
        .map(|window| window.id.as_str())
        .collect()
}

/// Records `now` for each id not recorded yet: the first time it was seen.
pub(super) fn record_first_seen(
    first_seen: &mut HashMap<String, Instant>,
    ids: Vec<&str>,
    now: Instant,
) {
    for id in ids {
        first_seen.entry(id.to_string()).or_insert(now);
    }
}
/// What a launch does after the process it started exited without a window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AfterExit {
    Stop,
    KeepWatching,
}

/// A live descendant is watched until the deadline, as before, whether or not
/// an instance of the same executable runs: a launcher whose GUI child is
/// slow to show its window must still get that window as its own. While one
/// is watched, a window a running instance showed still ends the watch at
/// once (the launch was passed on). Without a live descendant, a running
/// instance is watched until [`HANDOFF_WINDOW_WAIT`] is over, and with
/// neither the watch stops.
pub(super) fn after_exit(
    live_descendants: bool,
    instance_runs: bool,
    handoff_wait_over: bool,
) -> AfterExit {
    match (live_descendants, instance_runs, handoff_wait_over) {
        (true, _, _) | (false, true, false) => AfterExit::KeepWatching,
        _ => AfterExit::Stop,
    }
}

/// What one look at a running instance's windows found.
#[derive(Debug, Clone)]
pub(super) enum HandoffLook {
    /// No window the instances showed after the launch started.
    None,
    /// Exactly one, which is taken as the window the launch asked for.
    One(WindowInfo),
    /// More than one, or the instances are several with windows of their own
    /// (several profiles of a browser): which one the launch reached cannot
    /// be told, so none is taken.
    Several,
}

/// Two looks are equal when they found the same window, by id.
impl PartialEq for HandoffLook {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::None, Self::None) | (Self::Several, Self::Several) => true,
            (Self::One(a), Self::One(b)) => a.id == b.id,
            _ => false,
        }
    }
}

/// Picks the window a launch was passed to: only when exactly one window of
/// `targets` was not shown before the launch, and the targets do not include
/// several instances that already showed windows (`several_instances`).
pub(super) fn pick_handoff_window(
    windows: Vec<WindowInfo>,
    targets: &[(ProcessId, Option<String>)],
    before: &HashSet<String>,
    several_instances: bool,
) -> HandoffLook {
    let mut fresh: Vec<WindowInfo> = windows
        .into_iter()
        .filter(|window| !before.contains(&window.id))
        .filter(|window| {
            targets.iter().any(|(pid, token)| {
                window.pid == *pid && token.is_some() && window.process_instance == *token
            })
        })
        .collect();
    match (fresh.len(), several_instances) {
        (0, _) => HandoffLook::None,
        (1, false) => HandoffLook::One(fresh.remove(0)),
        _ => HandoffLook::Several,
    }
}

/// Whether more than one of `targets` already showed a window before the
/// launch: then each may be the instance the launch is passed to (a browser
/// with two profiles open), and a window either of them shows cannot be tied
/// to this launch.
pub(super) fn several_instances_show_windows(
    shown_owners: &HashSet<ProcessId>,
    targets: &[ProcessId],
) -> bool {
    targets
        .iter()
        .filter(|pid| shown_owners.contains(pid))
        .count()
        > 1
}

/// The ids of every top-level window the window inventory would list now
/// or a minimized one (`launch_attach::is_shown`), or `None` when they could
/// not be enumerated. A
/// window that was hidden (a tray app's main window) is left out, so the
/// instance showing it for the launch counts as showing a window. Beside the
/// ids, the processes that own those windows (or the app a shell frame hosts).
fn shown_windows() -> Option<(HashSet<String>, HashSet<ProcessId>)> {
    use super::super::window::{frame_identity, window_enum, window_identity, window_ops};
    let mut ids = HashSet::new();
    let mut owners = HashSet::new();
    window_enum::enumerate_top_level(|window| {
        if super::launch_attach::is_shown(&window) {
            ids.insert(window_ops::window_id(window.handle));
            owners.extend(window_identity::live_window_owner(window.handle));
            owners.extend(frame_identity::hosted_application_pid(window.handle));
        }
        true
    })
    .ok()?;
    Some((ids, owners))
}

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

    pub(super) fn open(pid: ProcessId) -> Option<Self> {
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        };
        let access = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE;
        let handle = unsafe { OpenProcess(access, 0, u32::from(pid)) };
        (!handle.is_null()).then_some(Self(handle))
    }

    pub(super) fn has_exited(&self) -> bool {
        use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
        use windows_sys::Win32::System::Threading::WaitForSingleObject;
        unsafe { WaitForSingleObject(self.0, 0) == WAIT_OBJECT_0 }
    }

    pub(super) fn created(&self) -> Option<u64> {
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
pub(super) fn parent_rows() -> Vec<(ProcessId, ProcessId)> {
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
    pub(super) fn open(_pid: ProcessId) -> Option<Self> {
        None
    }

    pub(super) fn has_exited(&self) -> bool {
        false
    }

    pub(super) fn created(&self) -> Option<u64> {
        None
    }

    fn lifetime(&self) -> Option<(u64, Option<u64>)> {
        None
    }
}

#[cfg(not(target_os = "windows"))]
pub(super) fn parent_rows() -> Vec<(ProcessId, ProcessId)> {
    Vec::new()
}

#[cfg(test)]
#[path = "launch_handoff_tests.rs"]
mod tests;
