// Added by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! Keeps the person's foreground window in front while a background action runs.
//!
//! This process is started by Sprint Coder, and a process started by the
//! foreground process inherits the right to set the foreground
//! (`system::launch` guards a launch against the same right). A semantic
//! action can make its target activate its window in answer: measured on a
//! self-made Win32 window that never activates itself (Issue #1197), the
//! Win32 proxies' Invoke of a button and Toggle of a check box post the click
//! to the target and return, and the target, handling the click, activated
//! its window and took the foreground from another app. So an action that may
//! not take the foreground (`InteractionPolicy::allow_focus_steal` is false)
//! runs with the foreground locked (`LockSetForegroundWindow`), and the lock
//! is kept until the target has handled what it was sent (`settle`). The
//! target still gets the action and still activates its window on its own
//! thread, but the window no longer comes to the front (measured on the same
//! button and check box). Windows drops the lock on its own when the person
//! clicks or presses Alt, and when this process exits.
//!
//! The lock does not stop everything: a proxy that moves the foreground from
//! this process (the lock's owner), and an answer that reaches the target
//! after the lock is gone, still take it (`list_item_click` refuses the two
//! clicks measured to do so). Nothing here moves the foreground. When the
//! target's process is in front after the action and was not before, the
//! result says so (`details.foreground`), whoever moved it (the person may
//! have clicked the target); an answer that comes later still is not seen.

/// The value of `details.foreground` when the target's process came to the
/// front during the action.
pub(crate) const TARGET_IN_FRONT: &str = "target_in_front";

/// Whether the result reports the target in front: it is in front after the
/// call, and was not before. Pure, so the rule is tested without a desktop.
pub(crate) fn target_came_forward(
    target_in_front_before: bool,
    target_in_front_after: bool,
) -> bool {
    target_in_front_after && !target_in_front_before
}

#[cfg(target_os = "windows")]
mod imp {
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
            let locked = unsafe { LockSetForegroundWindow(LSFW_LOCK) } != 0;
            Some(Self { prior, locked })
        }

        /// Waits, while the lock still holds, for the target to handle what
        /// the action sent it (see [`settle`]), then drops the lock; whether
        /// the target's process (`target_pid`, when known) came to the front
        /// during the action. An unknown process answers no.
        pub(crate) fn finish(
            mut self,
            target_pid: Option<u32>,
            deadline: agent_desktop_core::Deadline,
        ) -> bool {
            use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
            if let Some(pid) = target_pid {
                settle(pid, deadline);
            }
            self.unlock();
            let Some(target_pid) = target_pid else {
                return false;
            };
            let now = unsafe { GetForegroundWindow() };
            super::target_came_forward(
                window_pid(self.prior) == Some(target_pid),
                window_pid(now) == Some(target_pid),
            )
        }

        fn unlock(&mut self) {
            use windows_sys::Win32::UI::WindowsAndMessaging::{
                LSFW_UNLOCK, LockSetForegroundWindow,
            };
            if std::mem::take(&mut self.locked) {
                unsafe { LockSetForegroundWindow(LSFW_UNLOCK) };
            }
        }
    }

    impl Drop for ForegroundHold {
        fn drop(&mut self) {
            self.unlock();
        }
    }

    /// The longest the hold waits for the target after the action.
    const SETTLE_CAP: std::time::Duration = std::time::Duration::from_millis(250);

    /// Waits until the target process has handled the input the action sent
    /// it (`WaitForInputIdle`), for at most [`SETTLE_CAP`] and what is left of
    /// `deadline`. A proxy's Invoke posts the click to the target and returns
    /// at once; the target activates its window when it handles the click,
    /// which is after the call, so the lock must still hold then. A process
    /// that cannot be opened, or has no window thread, is not waited for.
    fn settle(pid: u32, deadline: agent_desktop_core::Deadline) {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, WaitForInputIdle,
        };
        let wait = deadline.remaining().min(SETTLE_CAP);
        if wait.is_zero() {
            return;
        }
        let process = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        if process.is_null() {
            return;
        }
        let millis = u32::try_from(wait.as_millis()).unwrap_or(u32::MAX);
        unsafe {
            WaitForInputIdle(process, millis);
            CloseHandle(process);
        }
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

/// Writes `details.foreground` into the result when the target came to the
/// front, keeping the details already there.
pub(crate) fn note_target_in_front(
    result: agent_desktop_core::ActionResult,
    came_forward: bool,
) -> agent_desktop_core::ActionResult {
    if !came_forward {
        return result;
    }
    let mut result = result;
    let mut details = match result.details.take() {
        Some(serde_json::Value::Object(details)) => details,
        _ => serde_json::Map::new(),
    };
    details.insert("foreground".into(), TARGET_IN_FRONT.into());
    result.with_details(details.into())
}

#[cfg(test)]
#[path = "foreground_hold_tests.rs"]
mod tests;
