// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use agent_desktop_core::{
    AdapterError, Deadline, DeliverySemantics, ErrorCode, ProcessId, RendererKind, WindowFilter,
    WindowInfo, system::launch_options::LaunchOptions, system::launch_result::LaunchResult,
};
#[cfg(test)]
use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

#[cfg(test)]
use self::launch_attach::matching_processes;
use self::launch_attach::prepare;
use super::launch_path::{
    child_environment_block, image_file_name, launch_identifier, validate_launch_options,
};
use super::process_identity;
#[cfg(target_os = "windows")]
use super::runtime::hresult::win32_last_error;
use super::window::window_ops::list_windows_live;

pub(crate) fn launch_app_impl(
    id: &str,
    options: &LaunchOptions,
    parent_deadline: Deadline,
) -> Result<LaunchResult, AdapterError> {
    let id = &launch_identifier(id).map_err(before_launch)?;
    validate_launch_options(options).map_err(before_launch)?;
    let deadline = if options.timeout_ms == 0 {
        parent_deadline
    } else {
        parent_deadline.capped(Duration::from_millis(options.timeout_ms))
    };
    deadline.ensure_remaining().map_err(before_launch)?;
    let prepared = prepare(id, options, deadline).map_err(before_launch)?;
    if let Some(mut attached) = prepared.attached {
        bring_forward_if_asked(&mut attached, options.activate, deadline);
        return Ok(attached);
    }
    // Read before anything starts, so a window the running instance opens
    // for this launch can be told apart from the ones it already had.
    let handoff = launch_handoff::Handoff::begin(prepared.running);
    let guard = ForegroundGuard::begin(options.activate);
    let (pid, token, process) = create_process(&prepared.executable, options, deadline)?;
    let lineage = launch_handoff::Lineage::new(pid, &token, process);
    let observed = observe_launched_window(pid, &token, lineage, &handoff, options, deadline)?;
    if let Some(guard) = guard {
        guard.finish(&observed.owners, observed.window.as_ref());
    }
    let new_instance = observed.window.is_some() && !observed.handed_off;
    let mut result = launch_result(id, pid, token, observed.window);
    result.new_instance = new_instance;
    if observed.exited_without_window {
        // A descendant still running may yet show the window, so the launch
        // is taken as passed on only when none is left.
        let handed_off =
            observed.handed_off || (handoff.any_running() && !observed.descendants_alive);
        result.attached = handed_off;
        result.handed_off = handed_off;
        result.suggestion = Some(
            match (
                handed_off,
                result.window.is_some(),
                observed.handoff_ambiguous,
            ) {
                (true, true, _) => launch_attach::HANDED_OFF_NEW_WINDOW,
                (true, false, true) => launch_attach::HANDED_OFF_AMBIGUOUS,
                (true, false, false) => launch_attach::HANDED_OFF,
                (false, _, _) => launch_handoff::EXITED_WITHOUT_WINDOW,
            }
            .to_string(),
        );
    }
    result.running_without_window = prepared.running_without_window;
    bring_forward_if_asked(&mut result, options.activate, deadline);
    Ok(result)
}

/// With `--activate`, brings the result's window to the front and records
/// whether it is there (`activated`). Before, `--activate` only skipped
/// keeping the window behind, so a window the app did not raise itself (one
/// a running instance showed for a single-instance app, or the window a
/// launch attached to) stayed behind although the caller asked for it in
/// front. Windows may refuse the foreground to this process (it may take it
/// only while the user's last input went to the process that started it);
/// then `activated` is `false` and nothing else is tried.
fn bring_forward_if_asked(result: &mut LaunchResult, activate: bool, deadline: Deadline) {
    if !activate {
        return;
    }
    result.activated = Some(
        result
            .window
            .as_ref()
            .is_some_and(|window| bring_forward(window, deadline)),
    );
}

#[cfg(target_os = "windows")]
fn bring_forward(window: &WindowInfo, deadline: Deadline) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, IsIconic, SW_RESTORE, SetForegroundWindow, ShowWindowAsync,
    };
    let handle = super::window::window_ops::parse_handle(&window.id);
    // Only the window the result names, still owned by the process it names.
    if handle.is_null() || !window_is_owned_by(handle, &[window.pid]) {
        return false;
    }
    if unsafe { GetForegroundWindow() } == handle {
        return true;
    }
    if unsafe { IsIconic(handle) } != 0 {
        unsafe { ShowWindowAsync(handle, SW_RESTORE) };
    }
    unsafe { SetForegroundWindow(handle) };
    // The switch can land a moment after the call returns.
    let until = std::time::Instant::now() + Duration::from_millis(500).min(deadline.remaining());
    loop {
        if unsafe { GetForegroundWindow() } == handle {
            return true;
        }
        if std::time::Instant::now() >= until {
            return false;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(not(target_os = "windows"))]
fn bring_forward(_window: &WindowInfo, _deadline: Deadline) -> bool {
    false
}

/// What watching a fresh launch found: the window, if one can be tied to the
/// launch; the processes that may own it (the launched one, then any
/// descendant once it exited, and the running instance whose new window was
/// taken); whether the launched process exited with no window of its own or
/// of a descendant; and whether the window is the running instance's.
/// `handoff_ambiguous` is set when several windows the running instances
/// showed could be the one asked for, so none was taken; `descendants_alive`
/// when the watch ended with a descendant of the launch still running, so the
/// launch is not taken as passed to the running instance.
struct LaunchObservation {
    window: Option<WindowInfo>,
    owners: Vec<ProcessId>,
    exited_without_window: bool,
    handed_off: bool,
    handoff_ambiguous: bool,
    descendants_alive: bool,
}

impl LaunchObservation {
    fn none(lineage: &launch_handoff::Lineage, exited: bool) -> Self {
        Self {
            window: None,
            owners: lineage.pids(),
            exited_without_window: exited,
            handed_off: false,
            handoff_ambiguous: false,
            descendants_alive: false,
        }
    }
}

/// Watches a process this launch created for its window. While the process
/// runs, only its own window counts, exactly as before. Once it has exited, a
/// window of a live descendant counts instead (see `launch_handoff`), and a
/// live descendant is waited for until the deadline, as before. While an
/// instance of the same executable that ran before the launch still runs, a
/// window that instance showed after the launch started counts too, when it
/// is the only such window ([`launch_handoff::HandoffLook`]); without a live
/// descendant that watch lasts at most [`launch_handoff::HANDOFF_WINDOW_WAIT`].
/// With nothing to watch, the watch ends at once instead of at the deadline.
fn observe_launched_window(
    pid: ProcessId,
    process_instance: &str,
    mut lineage: launch_handoff::Lineage,
    handoff: &launch_handoff::Handoff,
    options: &LaunchOptions,
    deadline: Deadline,
) -> Result<LaunchObservation, AdapterError> {
    let mut poll_interval = Duration::from_millis(50);
    let mut handoff_deadline: Option<Deadline> = None;
    loop {
        if let Some(window) = observe_window_once(pid, process_instance, deadline)? {
            return Ok(LaunchObservation {
                window: Some(window),
                owners: vec![pid],
                exited_without_window: false,
                handed_off: false,
                handoff_ambiguous: false,
                descendants_alive: false,
            });
        }
        let exited = lineage.launched_has_exited();
        let mut wait_until = deadline;
        let mut descendants_alive = false;
        if exited {
            lineage.refresh();
            let live = lineage.live_descendants();
            descendants_alive = !live.is_empty();
            if descendants_alive {
                let window =
                    launch_handoff::descendant_window(&live, deadline).map_err(after_launch)?;
                if window.is_some() {
                    return Ok(LaunchObservation {
                        window,
                        owners: lineage.pids(),
                        exited_without_window: false,
                        handed_off: false,
                        handoff_ambiguous: false,
                        descendants_alive: false,
                    });
                }
            }
            let instance_runs = handoff.any_running();
            if instance_runs {
                match handoff.look(deadline).map_err(after_launch)? {
                    launch_handoff::HandoffLook::One(window) => {
                        let mut owners = lineage.pids();
                        owners.push(window.pid);
                        return Ok(LaunchObservation {
                            window: Some(window),
                            owners,
                            exited_without_window: true,
                            handed_off: true,
                            handoff_ambiguous: false,
                            descendants_alive: false,
                        });
                    }
                    // Several candidates: none is taken, nor restacked.
                    launch_handoff::HandoffLook::Several => {
                        return Ok(LaunchObservation {
                            handed_off: true,
                            handoff_ambiguous: true,
                            ..LaunchObservation::none(&lineage, true)
                        });
                    }
                    launch_handoff::HandoffLook::None => {}
                }
                let handoff_until = *handoff_deadline
                    .get_or_insert_with(|| deadline.capped(launch_handoff::HANDOFF_WINDOW_WAIT));
                // A live descendant keeps the whole deadline (a launcher whose
                // GUI child is slow to show its window); only without one is
                // the watch held to the short handoff wait.
                if !descendants_alive {
                    wait_until = handoff_until;
                }
            }
            let wait_over = wait_until.remaining().is_zero();
            if launch_handoff::after_exit(descendants_alive, instance_runs, wait_over)
                == launch_handoff::AfterExit::Stop
            {
                return Ok(LaunchObservation {
                    descendants_alive,
                    ..LaunchObservation::none(&lineage, true)
                });
            }
        }
        if !should_poll_after_first_observation(options.timeout_ms)
            || wait_until.remaining().is_zero()
        {
            return Ok(LaunchObservation {
                descendants_alive,
                ..LaunchObservation::none(&lineage, exited)
            });
        }
        std::thread::sleep(poll_interval.min(wait_until.remaining()));
        poll_interval = (poll_interval * 3 / 2).min(Duration::from_millis(250));
    }
}

/// Keeps a launch without `--activate` in the background.
///
/// A process started by a process that may set the foreground inherits that
/// right, so the launched app's first window took the foreground and the
/// user's keystrokes went to it. Starting the app hidden or minimized is not
/// an answer, because later reads (snapshot, screenshot) need a shown window.
/// So the foreground is locked while the app starts (`LockSetForegroundWindow`;
/// Windows also drops the lock when this process exits), and the launched
/// window is then placed just below the window that was in front before the
/// launch. If the app still took the foreground in the moment between the
/// unlock and the check, the foreground is handed back. If the foreground
/// moved off that window while the lock held, the user moved it, so neither
/// step runs (see `may_restore_foreground`).
#[cfg(target_os = "windows")]
struct ForegroundGuard {
    prior: windows_sys::Win32::Foundation::HWND,
    locked: bool,
}

#[cfg(target_os = "windows")]
impl ForegroundGuard {
    fn begin(activate: bool) -> Option<Self> {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetForegroundWindow, LSFW_LOCK, LockSetForegroundWindow,
        };
        if activate {
            return None;
        }
        let prior = unsafe { GetForegroundWindow() };
        let locked = unsafe { LockSetForegroundWindow(LSFW_LOCK) } != 0;
        Some(Self { prior, locked })
    }

    /// `owners` are the processes the launch is tied to: the launched one,
    /// and its descendants when the window came from one of them.
    fn finish(mut self, owners: &[ProcessId], window: Option<&WindowInfo>) {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GWL_EXSTYLE, GetForegroundWindow, GetWindowLongW, IsIconic, IsWindow,
            SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE,
            SetForegroundWindow, SetWindowPos, WS_EX_TOPMOST,
        };
        let foreground_is_prior = unsafe { GetForegroundWindow() } == self.prior;
        let prior_is_minimized = unsafe { IsIconic(self.prior) } != 0;
        let may_restore = may_restore_foreground(foreground_is_prior, prior_is_minimized);
        self.unlock();
        if !may_restore {
            return;
        }
        let prior = self.prior;
        if prior.is_null() || unsafe { IsWindow(prior) } == 0 {
            return;
        }
        let foreground = unsafe { GetForegroundWindow() };
        if foreground != prior && window_is_owned_by(foreground, owners) {
            unsafe { SetForegroundWindow(prior) };
        }
        let Some(window) = window else {
            return;
        };
        let handle = super::window::window_ops::parse_handle(&window.id);
        let prior_is_topmost =
            unsafe { GetWindowLongW(prior, GWL_EXSTYLE) } as u32 & WS_EX_TOPMOST != 0;
        if handle.is_null() || handle == prior || prior_is_topmost {
            return;
        }
        if window_is_owned_by(handle, owners) {
            unsafe {
                SetWindowPos(
                    handle,
                    prior,
                    0,
                    0,
                    0,
                    0,
                    SWP_ASYNCWINDOWPOS
                        | SWP_NOMOVE
                        | SWP_NOSIZE
                        | SWP_NOACTIVATE
                        | SWP_NOOWNERZORDER,
                )
            };
        }
    }

    fn unlock(&mut self) {
        use windows_sys::Win32::UI::WindowsAndMessaging::{LSFW_UNLOCK, LockSetForegroundWindow};
        if std::mem::take(&mut self.locked) {
            unsafe { LockSetForegroundWindow(LSFW_UNLOCK) };
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for ForegroundGuard {
    fn drop(&mut self) {
        self.unlock();
    }
}

/// Whether the guard may hand the foreground back and restack the launched
/// window, read before the lock is dropped.
///
/// While the lock holds, no process can take the foreground on its own, so a
/// foreground that moved off the prior window was moved by the user (a click
/// or Alt, which also drops the lock) or by that window closing or minimizing;
/// either way it is left alone. Without the lock a move cannot be told apart
/// from the launched app taking the foreground, so it is left alone too: the
/// lock fails only when this process may not set the foreground, and then the
/// launched app cannot take it either, nor could it be handed back.
/// A prior window minimized during the launch can stay the foreground, but it
/// sits at the bottom of the z-order, so restacking below it would bury the
/// launched window behind every other one; it is left alone like a closed one.
#[cfg(any(target_os = "windows", test))]
fn may_restore_foreground(foreground_is_prior: bool, prior_is_minimized: bool) -> bool {
    foreground_is_prior && !prior_is_minimized
}

#[cfg(target_os = "windows")]
fn window_pid(handle: windows_sys::Win32::Foundation::HWND) -> Option<ProcessId> {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
    if handle.is_null() {
        return None;
    }
    let mut pid = 0_u32;
    unsafe { GetWindowThreadProcessId(handle, &mut pid) };
    (pid != 0).then(|| ProcessId::from(pid))
}

/// Whether a top-level window belongs to one of `owners`: by the thread that
/// owns it, or, for a frame the shell hosts an app in, by the hosted app's
/// process (the pid the window inventory reports for that frame).
#[cfg(target_os = "windows")]
fn window_is_owned_by(handle: windows_sys::Win32::Foundation::HWND, owners: &[ProcessId]) -> bool {
    let owned = |pid: Option<ProcessId>| pid.is_some_and(|pid| owners.contains(&pid));
    owned(window_pid(handle))
        || (!handle.is_null()
            && owned(super::window::frame_identity::hosted_application_pid(
                handle,
            )))
}

#[cfg(not(target_os = "windows"))]
struct ForegroundGuard;

#[cfg(not(target_os = "windows"))]
impl ForegroundGuard {
    fn begin(_activate: bool) -> Option<Self> {
        None
    }

    fn finish(self, _owners: &[ProcessId], _window: Option<&WindowInfo>) {}
}

fn launch_result(
    id: &str,
    pid: ProcessId,
    process_instance: String,
    window: Option<WindowInfo>,
) -> LaunchResult {
    let renderer = window.as_ref().and_then(detect_renderer_from_window);
    LaunchResult {
        app: window
            .as_ref()
            .map(|window| window.app.clone())
            .unwrap_or_else(|| image_file_name(id).to_string()),
        pid,
        process_instance: Some(process_instance),
        window,
        cdp: None,
        renderer,
        suggestion: None,
        attached: false,
        new_instance: false,
        handed_off: false,
        running_without_window: false,
        activated: None,
    }
}

#[cfg(target_os = "windows")]
fn detect_renderer_from_window(window: &WindowInfo) -> Option<RendererKind> {
    const CHROMIUM_WINDOW_CLASS: &str = "Chrome_WidgetWin_1";
    let handle = super::window::window_ops::parse_handle(&window.id);
    if handle.is_null() {
        return None;
    }
    super::window::window_ops::window_class_name(handle)
        .filter(|class| class == CHROMIUM_WINDOW_CLASS)
        .map(|_| RendererKind::Chromium)
}

#[cfg(not(target_os = "windows"))]
fn detect_renderer_from_window(_window: &WindowInfo) -> Option<RendererKind> {
    None
}

/// One window observation, tolerant of the inventory's mid-walk identity race.
///
/// `list_windows_live` now absorbs that race itself (the shared listing-retry
/// budget every caller on this path shares), retrying internally before ever
/// returning `WINDOW_NOT_FOUND` — so this function no longer re-reads the
/// inventory itself. A launch is exactly the moment that race is most
/// reachable, since a process was just created or terminated, but a race that
/// still survives the shared budget, and a budget that runs out entirely
/// (`TIMEOUT`), both say the desktop could not be read coherently in time —
/// not that this launch failed — so both are reported as no window observed.
/// Every other failure still propagates: a target whose process instance
/// changed underneath the launch is a real answer, not a race.
fn observe_window_once(
    pid: ProcessId,
    process_instance: &str,
    deadline: Deadline,
) -> Result<Option<WindowInfo>, AdapterError> {
    match exact_window(pid, process_instance, deadline) {
        Ok(window) => Ok(window),
        Err(error) if is_unobservable_within_budget(&error) => Ok(None),
        Err(error) => Err(after_launch(error)),
    }
}

fn is_unobservable_within_budget(error: &AdapterError) -> bool {
    matches!(error.code, ErrorCode::WindowNotFound | ErrorCode::Timeout)
}

fn exact_window(
    pid: ProcessId,
    process_instance: &str,
    deadline: Deadline,
) -> Result<Option<WindowInfo>, AdapterError> {
    let windows = list_windows_live(
        &WindowFilter {
            focused_only: false,
            app: None,
        },
        deadline,
    )?;
    let Some(window) = windows.into_iter().find(|window| window.pid == pid) else {
        return Ok(None);
    };
    if window.process_instance.as_deref() != Some(process_instance) {
        return Err(AdapterError::new(
            ErrorCode::AppUnresponsive,
            "Application process instance changed while waiting for its window",
        )
        .with_details(serde_json::json!({ "pid": pid, "complete": false })));
    }
    Ok(Some(window))
}

/// Refuses a relative working directory before it reaches `CreateProcessW`.
///
/// The child's current directory sits early in the default DLL search order,
/// so it picks which copy of a dependency loads; a relative path resolves
/// against whatever directory this process happens to hold, not the caller's.
#[cfg(target_os = "windows")]
fn absolute_cwd(cwd: &Path) -> Result<&Path, AdapterError> {
    if cwd.is_absolute() {
        return Ok(cwd);
    }
    Err(before_launch(AdapterError::new(
        ErrorCode::InvalidArgs,
        "The launch working directory must be an absolute path",
    )))
}

/// The working directory a launch without `--cwd` gives the app: the folder
/// of its executable, as a shortcut without a working directory or a double
/// click in Explorer does. Without it the app inherited this process's own
/// directory (the caller's workspace), and apps that read files next to
/// themselves by relative path failed to start. `None` (inherit, as before)
/// when the executable has no absolute parent that is a directory.
#[cfg(any(target_os = "windows", test))]
fn default_cwd(executable: &Path) -> Option<&Path> {
    executable
        .parent()
        .filter(|folder| folder.is_absolute() && folder.is_dir())
}

#[cfg(target_os = "windows")]
fn create_process(
    executable: &Path,
    options: &LaunchOptions,
    deadline: Deadline,
) -> Result<(ProcessId, String, launch_handoff::Process), AdapterError> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        CREATE_UNICODE_ENVIRONMENT, CreateProcessW, PROCESS_INFORMATION, STARTUPINFOW,
    };

    deadline.ensure_remaining().map_err(before_launch)?;
    let app_wide = to_wide(executable).map_err(before_launch)?;
    let command_line = command_line_for(executable, &options.args).map_err(before_launch)?;
    let mut command_wide = to_wide_str(&command_line).map_err(before_launch)?;
    let cwd_wide = match &options.cwd {
        Some(cwd) => Some(to_wide(absolute_cwd(cwd)?).map_err(before_launch)?),
        None => match default_cwd(executable) {
            Some(folder) => Some(to_wide(folder).map_err(before_launch)?),
            None => None,
        },
    };
    let env_block = child_environment_block(
        &options.env,
        crate::system::interaction_lease::INTERACTION_LEASE_HANDLE_ENV,
    )
    .map_err(before_launch)?;
    let startup = STARTUPINFOW {
        cb: std::mem::size_of::<STARTUPINFOW>() as u32,
        ..Default::default()
    };
    let mut information = PROCESS_INFORMATION::default();
    let flags = if env_block.is_some() {
        CREATE_UNICODE_ENVIRONMENT
    } else {
        0
    };
    let env_ptr = env_block
        .as_ref()
        .map(|block| block.as_ptr().cast())
        .unwrap_or(std::ptr::null());
    let cwd_ptr = cwd_wide
        .as_ref()
        .map(|wide| wide.as_ptr())
        .unwrap_or(std::ptr::null());
    deadline.ensure_remaining().map_err(before_launch)?;
    let ok = unsafe {
        CreateProcessW(
            app_wide.as_ptr(),
            command_wide.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            flags,
            env_ptr,
            cwd_ptr,
            &startup,
            &mut information,
        )
    };
    if ok == 0 {
        return Err(before_launch(win32_last_error(
            "CreateProcessW failed to start the application",
        )));
    }
    let pid = ProcessId::from(information.dwProcessId);
    unsafe { CloseHandle(information.hThread) };
    // Kept, not closed: holding it keeps the pid from being reused while the
    // launch tells its descendants apart (see `launch_handoff`).
    let process = launch_handoff::Process::from_handle(information.hProcess);
    let token = process_identity::token_for_pid(pid)
        .map_err(after_launch)?
        .ok_or_else(|| {
            after_launch(
                AdapterError::new(
                    ErrorCode::AppUnresponsive,
                    "Created process has no exact process instance token",
                )
                .with_details(serde_json::json!({ "pid": pid, "complete": false })),
            )
        })?;
    Ok((pid, token, process))
}

#[cfg(not(target_os = "windows"))]
fn create_process(
    _executable: &Path,
    _options: &LaunchOptions,
    _deadline: Deadline,
) -> Result<(ProcessId, String, launch_handoff::Process), AdapterError> {
    Err(AdapterError::not_supported("launch_app"))
}

fn command_line_for(executable: &Path, args: &[String]) -> Result<String, AdapterError> {
    let mut line = quote_arg(&executable.to_string_lossy());
    for arg in args {
        line.push(' ');
        line.push_str(&quote_arg(arg));
    }
    Ok(line)
}

/// Encodes one argument for the command line the child parses back apart.
///
/// The trailing backslash run is the case that silently corrupts: backslashes
/// are literal except immediately before a quote, so a value ending in one
/// would escape the closing quote this appends, leaving the quoted region open
/// and swallowing every later argument into it. That run is therefore doubled.
/// An embedded quote stays doubled rather than backslash-escaped: that is a
/// valid encoding for the consecutive-quote rule and the form `cmd` accepts,
/// which backslash-escaping is not.
fn quote_arg(value: &str) -> String {
    if !value.is_empty() && !value.chars().any(|c| c.is_whitespace() || c == '"') {
        return value.to_string();
    }
    let mut out = String::from("\"");
    for ch in value.chars() {
        if ch == '"' {
            out.push('"');
        }
        out.push(ch);
    }
    let trailing = value.len() - value.trim_end_matches('\\').len();
    for _ in 0..trailing {
        out.push('\\');
    }
    out.push('"');
    out
}

/// Pass-through kept here, under this module's own name, purely so this
/// module's own tests (`launch_tests.rs`) can call it unqualified through
/// their `use super::*;`; the merge itself lives in `launch_path` beside
/// every other input-shape rule a launch enforces, and `create_process`
/// reaches it through `child_environment_block` rather than this name. Only
/// that test caller remains, so this exists for `#[cfg(test)]` builds alone.
#[cfg(test)]
fn environment_block(overrides: &BTreeMap<String, String>) -> Result<Vec<u16>, AdapterError> {
    super::launch_path::environment_block(overrides)
}

#[cfg(target_os = "windows")]
fn to_wide(path: &Path) -> Result<Vec<u16>, AdapterError> {
    use std::os::windows::ffi::OsStrExt;
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    if wide.contains(&0) {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Launch path contains an interior NUL",
        ));
    }
    wide.push(0);
    Ok(wide)
}

#[cfg(target_os = "windows")]
fn to_wide_str(value: &str) -> Result<Vec<u16>, AdapterError> {
    if value.contains('\0') {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Launch command line contains an interior NUL",
        ));
    }
    let mut wide: Vec<u16> = value.encode_utf16().collect();
    wide.push(0);
    Ok(wide)
}

fn before_launch(error: AdapterError) -> AdapterError {
    error.with_disposition(DeliverySemantics::not_delivered())
}

fn after_launch(error: AdapterError) -> AdapterError {
    error.with_disposition(DeliverySemantics::delivered_unverified())
}

fn should_poll_after_first_observation(timeout_ms: u64) -> bool {
    timeout_ms > 0
}

#[cfg(test)]
#[path = "launch_tests.rs"]
mod tests;

#[cfg(test)]
mod foreground_guard_tests {
    use super::may_restore_foreground;

    #[test]
    fn a_foreground_that_stayed_on_the_prior_window_is_restored() {
        assert!(may_restore_foreground(true, false));
    }

    #[test]
    fn a_foreground_that_moved_off_the_prior_window_is_left_alone() {
        assert!(!may_restore_foreground(false, false));
    }

    #[test]
    fn a_minimized_prior_window_is_left_alone_even_while_it_is_the_foreground() {
        assert!(!may_restore_foreground(true, true));
        assert!(!may_restore_foreground(false, true));
    }
}

#[cfg(all(test, target_os = "windows"))]
#[path = "launch_lease_isolation_tests.rs"]
mod launch_lease_isolation_tests;

#[path = "launch_attach.rs"]
pub(crate) mod launch_attach;

#[path = "launch_handoff.rs"]
mod launch_handoff;
