// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use agent_desktop_core::{
    AdapterError, Deadline, ErrorCode, ProcessId, system::launch_options::LaunchOptions,
    system::launch_result::LaunchResult,
};

use super::super::window::window_enum::EnumeratedWindow;

use super::super::app_ops::{ProcessRow, process_snapshot};
use super::super::launch_path::{image_file_name, resolve_executable};
use super::super::process_identity;
use super::launch_handoff::{Process, RunningInstance};

/// What a launch knows before it starts anything: the executable it would
/// start, the running instance it attached to instead (if it did), and the
/// processes of that same executable that were already running, held open
/// so a reused pid is never mistaken for one of them.
pub(super) struct Prepared {
    pub(super) executable: PathBuf,
    pub(super) attached: Option<LaunchResult>,
    pub(super) running: Vec<RunningInstance>,
    /// `true` when a bare launch found the app running with no window shown
    /// and so starts it instead of attaching (see [`AttachDecision`]).
    pub(super) running_without_window: bool,
}

/// What a bare launch does about the instances already running.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AttachDecision {
    /// Nothing runs: start the app.
    Start,
    /// One instance runs and shows a window (or its windows could not be
    /// read): attach to it, start nothing.
    Attach(ProcessId),
    /// Every running instance shows no window: start the app as a double
    /// click on its icon would, so a single-instance app opens a window.
    StartBesideWindowless,
    /// Several instances run and at least one may show a window.
    Ambiguous,
}

/// Decides from the instance roots and whether each shows a window (`None`
/// when the windows could not be read, which counts as showing one, so doubt
/// keeps the old answer: attach, or refuse as ambiguous).
pub(super) fn attach_decision(roots: &[(ProcessId, Option<bool>)]) -> AttachDecision {
    if roots.is_empty() {
        return AttachDecision::Start;
    }
    if roots.iter().all(|&(_, shows)| shows == Some(false)) {
        return AttachDecision::StartBesideWindowless;
    }
    match roots {
        [(root, _)] => AttachDecision::Attach(*root),
        _ => AttachDecision::Ambiguous,
    }
}

/// Whether `pid` shows a window the user can see or bring back (see
/// [`is_shown`]).
pub(super) fn shows_a_window(pid: ProcessId, windows: &[TopWindow]) -> bool {
    windows
        .iter()
        .any(|top| is_shown(&top.window) && top.belongs_to(pid))
}

/// A window the user can see or bring back: the window inventory's filter
/// (`passes_filter`: shown, with a size, not cloaked, not a tool window), and
/// a minimized window whatever its rect. A window cloaked on another virtual
/// desktop, a tool window, a hidden or zero-sized one is not, nor a
/// message-only window (`EnumWindows` never lists one).
pub(super) fn is_shown(window: &EnumeratedWindow) -> bool {
    super::super::window::window_ops::passes_filter(window)
        || (window.visible && window.iconic && !window.cloaked && !window.tool)
}

fn running_instances(exact_matches: Vec<(ProcessId, Option<Process>)>) -> Vec<RunningInstance> {
    exact_matches
        .into_iter()
        .filter_map(|(pid, process)| {
            // Read while the handle holds the pid, so the token names the
            // process that was matched.
            let process = process?;
            let token = process_identity::token_for_pid(pid).ok().flatten();
            Some(RunningInstance {
                pid,
                token,
                process,
            })
        })
        .collect()
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
    let mut exact_matches: Vec<(ProcessId, Option<Process>)> = Vec::new();
    for row in matches {
        let Some(process) = ProcessPin::open(row.pid) else {
            continue;
        };
        let Some(image_path) = process.image_path() else {
            continue;
        };
        if same_executable_path(&executable, &image_path) {
            // Opened while the pin still holds the pid, so it is the same process.
            exact_matches.push((row.pid, Process::open(row.pid)));
        }
    }
    if !may_attach(options) {
        return Ok(Prepared {
            executable,
            attached: None,
            running: running_instances(exact_matches),
            running_without_window: false,
        });
    }
    // Read while every match is held open, so a pid here still names the
    // process that was matched.
    let parents: HashMap<ProcessId, ProcessId> =
        super::launch_handoff::parent_rows().into_iter().collect();
    let live: Vec<(ProcessId, Option<u64>)> = exact_matches
        .iter()
        .filter(|(_, process)| !process.as_ref().is_some_and(Process::has_exited))
        .map(|(pid, process)| (*pid, process.as_ref().and_then(Process::created)))
        .collect();
    // Read whenever something runs: several processes need telling apart,
    // and whether an instance shows a window decides between attaching and
    // starting. A failed read leaves every window unknown.
    let windows = if live.is_empty() {
        None
    } else {
        top_level_windows()
    };
    let candidates: Vec<Candidate> = live
        .iter()
        .map(|&(pid, created)| Candidate {
            pid,
            parent: parents.get(&pid).copied(),
            created,
            has_window: windows
                .as_deref()
                .map(|windows| owns_a_shown_window(pid, windows)),
        })
        .collect();
    let roots = instance_roots(&candidates);
    let shown: Vec<(ProcessId, Option<bool>)> = roots
        .iter()
        .map(|&pid| {
            (
                pid,
                windows
                    .as_deref()
                    .map(|windows| shows_a_window(pid, windows)),
            )
        })
        .collect();
    match attach_decision(&shown) {
        AttachDecision::Ambiguous => {
            return Err(ambiguous_instances(&with_titles(
                &roots,
                windows.as_deref().unwrap_or_default(),
            )));
        }
        AttachDecision::StartBesideWindowless => {
            return Ok(Prepared {
                executable,
                attached: None,
                running: running_instances(exact_matches),
                running_without_window: true,
            });
        }
        AttachDecision::Start | AttachDecision::Attach(_) => {}
    }
    if let Some(&root) = roots.first() {
        let token = process_identity::token_for_pid(root)?.ok_or_else(|| {
            AdapterError::new(
                ErrorCode::AppUnresponsive,
                "Running process has no exact process instance token",
            )
        })?;
        // Only the root's own window: a helper process's window (if any) is
        // not the instance's main window. One look, not a wait: nothing was
        // started, so no window is on its way. Waiting here spent the whole
        // timeout (30 seconds by default) on every instance that runs with no
        // window, such as a browser kept running in the background.
        let window = super::observe_window_once(root, &token, deadline)?;
        let suggestion = if window.is_some() {
            attached_guidance()
        } else {
            ATTACHED_WITHOUT_WINDOW.to_string()
        };
        let mut attached = super::launch_result(id, root, token, window);
        attached.attached = true;
        attached.suggestion = Some(suggestion);
        return Ok(Prepared {
            executable,
            attached: Some(attached),
            running: Vec::new(),
            running_without_window: false,
        });
    }
    Ok(Prepared {
        executable,
        attached: None,
        running: Vec::new(),
        running_without_window: false,
    })
}

/// One running process of the launch target's executable, as the instance
/// count reads it: its parent pid from ToolHelp, its creation time in
/// `FILETIME` ticks, and whether it owns a window of its own (see
/// [`owns_a_shown_window`]), each unknown when it could not be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Candidate {
    pub(super) pid: ProcessId,
    pub(super) parent: Option<ProcessId>,
    pub(super) created: Option<u64>,
    pub(super) has_window: Option<bool>,
}

/// The running instances among `candidates`, each named by the pid at the
/// root of its process tree, in the order given.
///
/// One Chromium or Electron app runs its GPU, renderer and utility processes
/// from its own executable, so counting processes made one app look like
/// several instances and every second launch failed as ambiguous. A candidate
/// is counted inside another candidate's instance only when it owns no window
/// of its own, its parent pid is that candidate's, and it was created strictly
/// after that candidate. Every candidate is held open while this is read, so a
/// parent that is a candidate has held its pid from its own creation until
/// now; a process created after it with that parent pid can only be its child.
/// A child with a window of its own may be an instance the parent started (a
/// "new window" that runs as its own process), which the caller must choose
/// between, so it counts as an instance; helpers below it are counted inside
/// it. A window that could not be read, a parent pid reused by a process
/// created later than the child, an unknown time, or a parent that is not a
/// candidate (another executable, or one that already exited) leaves the
/// candidate counted as an instance of its own, so doubt makes the launch
/// refuse as ambiguous rather than attach to the wrong instance.
pub(super) fn instance_roots(candidates: &[Candidate]) -> Vec<ProcessId> {
    candidates
        .iter()
        .filter(|candidate| !is_helper_of_a_candidate(candidate, candidates))
        .map(|candidate| candidate.pid)
        .collect()
}

fn is_helper_of_a_candidate(child: &Candidate, candidates: &[Candidate]) -> bool {
    let (Some(parent), Some(child_created), Some(false)) =
        (child.parent, child.created, child.has_window)
    else {
        return false;
    };
    parent != child.pid
        && candidates.iter().any(|candidate| {
            candidate.pid == parent
                && candidate
                    .created
                    .is_some_and(|parent_created| child_created > parent_created)
        })
}

/// A top-level window as the instance count reads it: the process that owns
/// it (and the app a shell frame hosts, if any) and its window state.
#[derive(Debug, Clone, Copy)]
pub(super) struct TopWindow {
    pub(super) window: EnumeratedWindow,
    pub(super) owner: ProcessId,
    pub(super) hosted: Option<ProcessId>,
}

impl TopWindow {
    fn belongs_to(&self, pid: ProcessId) -> bool {
        self.owner == pid || self.hosted == Some(pid)
    }
}

/// Whether `pid` owns a top-level window with the visible style
/// (`IsWindowVisible`).
///
/// Wider on purpose than the windows a launch attaches to (`observe_window`
/// keeps only uncloaked, non-tool windows with a size): an instance whose
/// window sits on another virtual desktop (cloaked), is minimized, has no
/// size or is a tool window is still an instance the caller must choose
/// between. Only a process with no visible-style window at all (the message
/// windows of a Chromium helper are hidden) is taken as a helper.
pub(super) fn owns_a_shown_window(pid: ProcessId, windows: &[TopWindow]) -> bool {
    windows
        .iter()
        .any(|top| top.window.visible && top.belongs_to(pid))
}

/// Every top-level window whose owner can be read, or `None` when the
/// windows could not be enumerated.
///
/// Dropping a window whose owner cannot be read does not let a child with a
/// window of its own pass as a helper. The owner is read with
/// `GetWindowThreadProcessId` alone (`window_identity::live_window_owner`),
/// which opens no process and checks no access: a window of a protected or
/// elevated process still names its pid (measured on this desktop: every
/// window of the five processes this user could not open named its owner).
/// It reads no pid only for a handle that is no longer a window, one
/// destroyed between `EnumWindows` taking its list and this read, so there is
/// no pid left to match against a candidate either. A child whose window
/// closed at that moment is read as a child that has not shown its window
/// yet, the same unavoidable gap as a child counted before its first window.
/// The same holds for the app a shell frame hosts: its pid is read the same
/// way, from the `CoreWindow` inside the frame.
fn top_level_windows() -> Option<Vec<TopWindow>> {
    use super::super::window::{frame_identity, window_enum, window_identity};
    let mut windows = Vec::new();
    window_enum::enumerate_top_level(|window| {
        if let Some(owner) = window_identity::live_window_owner(window.handle) {
            // The frame lookup reads the class and children; only a window
            // that can count needs it.
            let hosted = window
                .visible
                .then(|| frame_identity::hosted_application_pid(window.handle))
                .flatten();
            windows.push(TopWindow {
                window,
                owner,
                hosted,
            });
        }
        true
    })
    .ok()?;
    Some(windows)
}

/// Each instance's root pid with the title of one of its windows (one that
/// is not cloaked first, then any, so a window on another virtual desktop is
/// named too). A title is only a hint for the caller; one that cannot be read
/// is left out.
fn with_titles(roots: &[ProcessId], windows: &[TopWindow]) -> Vec<(ProcessId, Option<String>)> {
    use super::super::window::window_identity::live_window_title;
    roots
        .iter()
        .map(|&pid| {
            let mut own: Vec<&TopWindow> = windows
                .iter()
                .filter(|top| top.window.visible && top.belongs_to(pid))
                .collect();
            own.sort_by_key(|top| top.window.cloaked);
            let title = own.into_iter().find_map(|top| {
                live_window_title(top.window.handle).filter(|title| !title.is_empty())
            });
            (pid, title)
        })
        .collect()
}

/// The refusal when more than one instance of the app is running: a bare
/// launch cannot tell which one the caller means.
pub(super) fn ambiguous_instances(instances: &[(ProcessId, Option<String>)]) -> AdapterError {
    let pids: Vec<ProcessId> = instances.iter().map(|(pid, _)| *pid).collect();
    let listed: Vec<String> = instances
        .iter()
        .map(|(pid, title)| match title {
            Some(title) => format!("pid {} ({title:?})", pid.get()),
            None => format!("pid {}", pid.get()),
        })
        .collect();
    AdapterError::ambiguous_process_target_with_details(
        "More than one application instance matches the launch target",
        &pids,
        serde_json::json!({
            "candidate_pids": pids,
            "instances": instances
                .iter()
                .map(|(pid, title)| serde_json::json!({ "pid": pid, "title": title }))
                .collect::<Vec<_>>(),
        }),
    )
    .with_suggestion(format!(
        "{} instances of this app are running ({}); launch cannot tell which one to attach to. \
         Run `list-windows` and work with the window you mean, or pass --no-attach to start a \
         new instance of your own.",
        instances.len(),
        listed.join(", ")
    ))
}

/// What a launch says about using a window the running instance already
/// had: allowed within the task, without disturbing what the user left there.
const USE_EXISTING_WINDOW: &str = "You may use this window for what the user asked, and only \
     that: if the task is to read, only read; do not change what it shows or any unsaved work, \
     and do not close it.";

/// The guidance a launch reports when it attached to an instance that was
/// already running instead of starting one, and that instance shows a window.
pub(super) const ATTACHED: &str = "Nothing was started: the app was already running with a \
     window open, and `window` is that window, which the user had open before. If the task \
     needs a window of its own, launch again with --no-attach once. A single-instance app (a \
     browser, many editors) then opens the new window in this same running instance, and the \
     result says handed_off; an app that keeps one window opens none, and the result says \
     existing_window.";

/// The guidance a launch reports when it attached to a running instance that
/// shows no window (it runs in the background or in the tray).
pub(super) const ATTACHED_WITHOUT_WINDOW: &str = "Nothing was started and no window is open: \
     the app was already running without a window (in the background or in the tray). To open \
     a window, launch again with --no-attach. A single-instance app (a browser, many editors) \
     then opens the window in this same running instance, and the result says handed_off.";

/// The guidance a launch reports when the process it started passed the
/// launch to the running instance, which then opened the reported window.
pub(super) const HANDED_OFF_NEW_WINDOW: &str = "The launched process passed the launch to the \
     instance of the same app that was already running and exited (a single-instance app). \
     That running instance showed `window`, a window that did not exist before this launch \
     started, so it is most likely the window this launch opened: use it for the task. It is owned by the running instance (`window.pid`) rather than by a process this \
     launch started, which is why new_instance is false; that does not make it one of the \
     user's windows. The instance's other windows may be ones the user had open.";

/// The guidance a launch reports when, passed to the running instance, no new
/// window appeared and the instance brought a window it already had to the
/// front as the launch was handed over.
pub(super) const HANDED_OFF_EXISTING_RAISED: &str = "The launched process passed the launch to \
     the instance of the same app that was already running and exited. No new window \
     appeared: the instance brought `window`, a window it already had before this launch, to \
     the front instead (existing_window). This app likely keeps one window, so do not repeat \
     --no-attach.";

/// The guidance a launch reports when, passed to the running instance, no new
/// window appeared and the instance shows exactly one window, which it
/// already had before the launch.
pub(super) const HANDED_OFF_EXISTING_ONLY: &str = "The launched process passed the launch to \
     the instance of the same app that was already running and exited. No new window appeared \
     within a few seconds, and `window` is the only window that instance shows, one it already \
     had before this launch (existing_window). Whether the app used it for this launch or \
     ignored the launch cannot be told. Do not repeat --no-attach: it may open nothing again.";

/// Added to the guidance when, without `--activate`, the window a running
/// instance showed stayed in front: the app took the foreground and it could
/// not be handed back.
pub(super) const HANDED_OFF_LEFT_IN_FRONT: &str = "That window took the front on its own and \
     could not be put back behind the window that was in front before the launch \
     (`window.is_focused` is true): tell the user it opened in front of their windows.";
/// The guidance a launch reports when it was passed to a running instance
/// but cannot tell which window that instance showed for it.
pub(super) const HANDED_OFF_AMBIGUOUS: &str = "The launched process passed the launch to an \
     instance of the same app that was already running and exited (a single-instance app). \
     Several windows of the running instances appeared, or several instances already had \
     windows open (a browser with more than one profile), so which window this launch opened \
     is not confirmed and none is named here. Run `list-windows` for the app and pick the \
     window by its title; windows that were open before the launch may be ones the user had \
     open.";

/// The guidance a launch reports when the process it started exited without
/// a window of its own while an instance of the same executable was running,
/// and no new window of that instance was seen.
pub(super) const HANDED_OFF: &str = "The launched process exited without a window of its own \
     while an instance of the same app was already running: the app most likely passed the \
     launch to that running instance (a single-instance app). No new window of that instance \
     appeared within a few seconds, so whether it opened one is not confirmed: it may have \
     brought an existing window forward instead, or may still open one. Run `list-windows` \
     for the app to see its windows before launching again; windows that were open before \
     the launch may be ones the user had open.";

/// How a window the running instance already had before the launch came to
/// be the launch's `window` (`existing_window`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ExistingWindow {
    /// Shown before the launch, and brought to the front as the launch was
    /// handed over.
    Raised,
    /// Shown before the launch, and the instance's only visible window when
    /// no new one appeared.
    Only,
    /// Hidden before the launch (its handle already existed), and shown again
    /// for the launch: a tray app's main window, with whatever the user left
    /// in it.
    Revealed,
}

/// The guidance a launch reports when, passed to the running instance, the
/// instance showed again a window it already had but kept hidden.
pub(super) const HANDED_OFF_EXISTING_REVEALED: &str = "The launched process passed the \
     launch to the instance of the same app that was already running and exited. The instance \
     showed `window` again: a window it already had before this launch but kept hidden (an app \
     in the tray shows its main window again), not a new one (existing_window). It may hold \
     what the user left in it.";

/// The full guidance for a window the running instance already had.
pub(super) fn existing_window_guidance(kind: ExistingWindow) -> String {
    let head = match kind {
        ExistingWindow::Raised => HANDED_OFF_EXISTING_RAISED,
        ExistingWindow::Only => HANDED_OFF_EXISTING_ONLY,
        ExistingWindow::Revealed => HANDED_OFF_EXISTING_REVEALED,
    };
    format!("{head} {USE_EXISTING_WINDOW}")
}

/// The guidance for an attached window, with what using it allows.
pub(super) fn attached_guidance() -> String {
    format!(
        "{ATTACHED} If no new window can be had (the app keeps one window): {USE_EXISTING_WINDOW}"
    )
}
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

#[cfg(test)]
#[path = "launch_attach_tests.rs"]
mod tests;

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
