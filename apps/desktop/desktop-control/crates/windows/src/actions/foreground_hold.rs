// Added by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! Keeps the person's foreground window in front while a background action runs.
//!
//! This process is started by Sprint Coder, and a process started by the
//! foreground process inherits the right to set the foreground
//! (`system::launch` guards a launch against the same right). Measured on a
//! self-made Win32 window that never activates itself (Issue #1197, PR #1276;
//! 5 runs each, a fresh window each run): UI Automation's Win32 proxies post
//! the click of a button's Invoke and of a check box's Toggle (`BM_CLICK`
//! arrives posted, and the call returns at once), and the target, handling
//! it, activated its window and took the foreground: 5 of 5 without the lock
//! below, and 5 of 5 with the lock dropped as soon as the call returned.
//!
//! So an action that may not take the foreground
//! (`InteractionPolicy::allow_focus_steal` is false) runs with the foreground
//! locked (`LockSetForegroundWindow`), and the lock is dropped only after the
//! target's window threads have answered two sent `WM_NULL` messages in turn
//! (`settle`): a thread answers a sent message only when it next asks for
//! messages, so the second answer comes after the posted click the thread had
//! already taken. With that, the same button and check box took the
//! foreground 0 of 5 times each, and so did a click handler that calls
//! `SetForegroundWindow` itself, one that does so after sleeping 400 ms, and
//! one that does so from a timer 300 ms later (the later calls failed: the
//! window had already been kept from activating).
//!
//! What this does not promise, so the result says it instead:
//! - The wait is bounded (`SETTLE_CAP` and the action's deadline). A target
//!   that has not answered by then may still handle the click after the
//!   unlock (`details.foreground_settle: "incomplete"`).
//! - The lock cannot be taken while another process holds it
//!   (`ERROR_ACCESS_DENIED`), nor by a process that may not set the
//!   foreground (`details.foreground_lock: "unavailable"`); a click on a Win32
//!   button is then refused before it is sent (`lock_needed`).
//! - A proxy that moves the foreground from this process, the lock's owner,
//!   is not stopped by it (`list_item_click` refuses the measured ones).
//!
//! Nothing here moves the foreground. When the target's process is in front
//! after the action and was not before, the result (or the error) says so
//! (`details.foreground: "target_in_front"`), whoever moved it (the person
//! may have clicked the target). A window counts as the target's when the
//! target's process owns it, owns its root owner, or is the app a shell frame
//! hosts in it. An answer that comes after the action is over is not seen.

/// `details.foreground` when the target's process came to the front.
pub(crate) const TARGET_IN_FRONT: &str = "target_in_front";
/// `details.foreground_lock` when the foreground could not be locked.
pub(crate) const LOCK_UNAVAILABLE: &str = "unavailable";
/// `details.foreground_settle` when the target did not answer within the wait.
pub(crate) const SETTLE_INCOMPLETE: &str = "incomplete";
/// `details.foreground_settle` when the target had no window to wait on.
pub(crate) const SETTLE_NO_WINDOW: &str = "no_window";

/// How the wait for the target after the action ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Settle {
    /// Every window thread of the target answered both messages.
    Settled,
    /// A thread did not answer in time, or the send failed.
    Incomplete,
    /// The target's process showed no top-level window to wait on.
    NoWindow,
    /// Not waited for: no lock was held, or the target's process is unknown.
    NotTried,
}

/// What the hold found, for the result's details.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct HoldReport {
    pub(crate) locked: bool,
    pub(crate) settle: Settle,
    pub(crate) came_forward: bool,
}

impl HoldReport {
    /// The details this report adds; none when the lock held, the wait
    /// completed and the target stayed behind.
    pub(crate) fn entries(self) -> Vec<(&'static str, &'static str)> {
        let mut entries = Vec::new();
        if self.came_forward {
            entries.push(("foreground", TARGET_IN_FRONT));
        }
        if !self.locked {
            entries.push(("foreground_lock", LOCK_UNAVAILABLE));
        }
        match self.settle {
            Settle::Incomplete => entries.push(("foreground_settle", SETTLE_INCOMPLETE)),
            Settle::NoWindow => entries.push(("foreground_settle", SETTLE_NO_WINDOW)),
            Settle::Settled | Settle::NotTried => {}
        }
        entries
    }
}

/// Whether the result reports the target in front: it is in front after the
/// action, and was not before.
pub(crate) fn target_came_forward(
    target_in_front_before: bool,
    target_in_front_after: bool,
) -> bool {
    target_in_front_after && !target_in_front_before
}

/// What was read of whether the element is a Win32 button (its own window's
/// class, or the system class it is built on, is `Button`): the control whose
/// posted click was measured to take the foreground without the lock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ButtonRead {
    Button,
    NotButton,
    /// The element's window could not be read in time.
    Unread,
}

/// Whether an action is refused because the lock could not be taken: only a
/// click or toggle of an element that is, or may be, a Win32 button.
pub(crate) fn lock_needed(locked: bool, posts_a_click: bool, button: ButtonRead) -> bool {
    !locked && posts_a_click && button != ButtonRead::NotButton
}

/// Writes the report into the result's details, or into the error's, keeping
/// the details already there.
pub(crate) fn note_report(
    result: Result<agent_desktop_core::ActionResult, agent_desktop_core::AdapterError>,
    report: HoldReport,
) -> Result<agent_desktop_core::ActionResult, agent_desktop_core::AdapterError> {
    let entries = report.entries();
    if entries.is_empty() {
        return result;
    }
    let merge = |details: Option<serde_json::Value>| {
        let mut map = match details {
            Some(serde_json::Value::Object(map)) => map,
            Some(other) => {
                let mut map = serde_json::Map::new();
                map.insert("details".into(), other);
                map
            }
            None => serde_json::Map::new(),
        };
        for (key, value) in &entries {
            map.insert((*key).into(), (*value).into());
        }
        serde_json::Value::Object(map)
    };
    match result {
        Ok(mut ok) => {
            ok.details = Some(merge(ok.details.take()));
            Ok(ok)
        }
        Err(mut error) => {
            error.details = Some(merge(error.details.take()));
            Err(error)
        }
    }
}

/// The refusal of a click on a Win32 button while the foreground cannot be
/// locked. Nothing was sent; it may be tried again (the lock is free again
/// once the process holding it lets go or exits).
pub(crate) fn lock_unavailable_refusal(
    policy: agent_desktop_core::InteractionPolicy,
    button: ButtonRead,
) -> agent_desktop_core::AdapterError {
    agent_desktop_core::AdapterError::policy_denied_for_policy(
        "The foreground could not be locked, and clicking this Win32 control without the \
         lock brings its window to the front, so it is not done in the background",
        policy,
    )
    .with_suggestion(
        "Nothing was sent. Try again shortly (another program may be holding the foreground \
         lock). Clicking it as a person would takes the foreground: only with --headed",
    )
    .with_details(serde_json::json!({
        "kind": "foreground_lock_unavailable",
        "control_read": match button {
            ButtonRead::Button => "win32_button",
            ButtonRead::Unread => "unread",
            ButtonRead::NotButton => "not_win32_button",
        },
        "foreground_effect": true,
        "retryable": true,
    }))
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{HoldReport, Settle};
    use windows_sys::Win32::Foundation::HWND;

    pub(crate) struct ForegroundHold {
        prior: HWND,
        locked: bool,
    }

    impl ForegroundHold {
        /// Takes the lock for an action that may not take the foreground;
        /// `None` (nothing held) for one that may.
        pub(crate) fn begin(allow_focus_steal: bool) -> Option<Self> {
            use windows_sys::Win32::UI::WindowsAndMessaging::{
                GetForegroundWindow, LSFW_LOCK, LockSetForegroundWindow,
            };
            if allow_focus_steal {
                return None;
            }
            let prior = unsafe { GetForegroundWindow() };
            // The lock belongs to the process: a second `LSFW_LOCK` while it
            // is held fails, so holds that overlap in this process (threads of
            // an FFI host, parallel tests) share one lock, taken by the first
            // and dropped by the last.
            let mut holders = HOLDERS.lock().unwrap_or_else(|poison| poison.into_inner());
            let locked = if *holders > 0 {
                *holders += 1;
                true
            } else if unsafe { LockSetForegroundWindow(LSFW_LOCK) } != 0 {
                *holders = 1;
                true
            } else {
                false
            };
            Some(Self { prior, locked })
        }

        pub(crate) fn locked(&self) -> bool {
            self.locked
        }

        /// Waits, while the lock still holds, for the target's window threads
        /// to handle what the action sent them ([`settle`]), drops the lock,
        /// and reports. `target_pid` is the target's process, when known.
        pub(crate) fn finish(
            mut self,
            target_pid: Option<u32>,
            deadline: agent_desktop_core::Deadline,
        ) -> HoldReport {
            use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
            let settle = match target_pid {
                Some(pid) if self.locked => settle(pid, deadline),
                _ => Settle::NotTried,
            };
            let locked = self.locked;
            self.unlock();
            let came_forward = target_pid.is_some_and(|pid| {
                let now = unsafe { GetForegroundWindow() };
                super::target_came_forward(
                    window_belongs_to(self.prior, pid),
                    window_belongs_to(now, pid),
                )
            });
            HoldReport {
                locked,
                settle,
                came_forward,
            }
        }

        fn unlock(&mut self) {
            use windows_sys::Win32::UI::WindowsAndMessaging::{
                LSFW_UNLOCK, LockSetForegroundWindow,
            };
            if std::mem::take(&mut self.locked) {
                let mut holders = HOLDERS.lock().unwrap_or_else(|poison| poison.into_inner());
                *holders = holders.saturating_sub(1);
                if *holders == 0 {
                    unsafe { LockSetForegroundWindow(LSFW_UNLOCK) };
                }
            }
        }
    }

    /// How many holds of this process share the lock now.
    static HOLDERS: std::sync::Mutex<usize> = std::sync::Mutex::new(0);

    impl Drop for ForegroundHold {
        fn drop(&mut self) {
            self.unlock();
        }
    }

    /// The longest the hold waits for the target after the action.
    const SETTLE_CAP: std::time::Duration = std::time::Duration::from_millis(250);

    /// The most window threads of the target the wait asks.
    const SETTLE_THREADS: usize = 4;

    /// Sends `WM_NULL` twice, one after the other, to one visible top-level
    /// window of each window thread of `pid` (up to [`SETTLE_THREADS`]), with
    /// `SMTO_ABORTIFHUNG` and never longer than [`SETTLE_CAP`] and what is
    /// left of `deadline` in all. A sent message is handled when the thread
    /// next asks for messages, after the posted message it is already
    /// handling, so the second answer comes after a click the thread had
    /// taken by the time the first was answered.
    fn settle(pid: u32, deadline: agent_desktop_core::Deadline) -> Settle {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SMTO_ABORTIFHUNG, SendMessageTimeoutW, WM_NULL,
        };
        let windows = thread_windows(pid);
        if windows.is_empty() {
            return Settle::NoWindow;
        }
        let wait = deadline.capped(SETTLE_CAP);
        for window in windows {
            for _ in 0..2 {
                let left = wait.remaining();
                if left.is_zero() {
                    return Settle::Incomplete;
                }
                let millis = u32::try_from(left.as_millis()).unwrap_or(u32::MAX).max(1);
                let mut answer = 0usize;
                let sent = unsafe {
                    SendMessageTimeoutW(
                        window,
                        WM_NULL,
                        0,
                        0,
                        SMTO_ABORTIFHUNG,
                        millis,
                        &mut answer,
                    )
                };
                if sent == 0 {
                    return Settle::Incomplete;
                }
            }
        }
        Settle::Settled
    }

    /// One visible top-level window per window thread of `pid`. Reads the
    /// window list only; nothing is sent to the windows.
    fn thread_windows(pid: u32) -> Vec<HWND> {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            EnumWindows, GetWindowThreadProcessId, IsWindowVisible,
        };
        struct Search {
            pid: u32,
            threads: Vec<u32>,
            windows: Vec<HWND>,
        }
        unsafe extern "system" fn visit(window: HWND, state: isize) -> i32 {
            let search = unsafe { &mut *(state as *mut Search) };
            let mut owner = 0u32;
            let thread = unsafe { GetWindowThreadProcessId(window, &mut owner) };
            if owner == search.pid
                && thread != 0
                && unsafe { IsWindowVisible(window) } != 0
                && !search.threads.contains(&thread)
            {
                search.threads.push(thread);
                search.windows.push(window);
            }
            i32::from(search.windows.len() < SETTLE_THREADS)
        }
        let mut search = Search {
            pid,
            threads: Vec::new(),
            windows: Vec::new(),
        };
        unsafe { EnumWindows(Some(visit), &mut search as *mut Search as isize) };
        search.windows
    }

    /// Whether `window` is the target's: its own process, the process of its
    /// root owner, or the app a shell frame hosts in it is `pid`.
    fn window_belongs_to(window: HWND, pid: u32) -> bool {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GA_ROOTOWNER, GetAncestor};
        if window.is_null() {
            return false;
        }
        let root = unsafe { GetAncestor(window, GA_ROOTOWNER) };
        window_pid(window) == Some(pid)
            || (!root.is_null() && window_pid(root) == Some(pid))
            || crate::system::window::frame_identity::hosted_application_pid(window)
                .is_some_and(|hosted| u32::from(hosted) == pid)
    }

    fn window_pid(handle: HWND) -> Option<u32> {
        use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
        if handle.is_null() {
            return None;
        }
        let mut pid = 0_u32;
        unsafe { GetWindowThreadProcessId(handle, &mut pid) };
        (pid != 0).then_some(pid)
    }
}

#[cfg(target_os = "windows")]
pub(crate) use imp::ForegroundHold;

#[cfg(test)]
#[path = "foreground_hold_tests.rs"]
mod tests;
