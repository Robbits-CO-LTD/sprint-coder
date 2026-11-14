// Added by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! A background click, toggle, check or uncheck of a Win32 button is sent as
//! `BM_CLICK` with `SendMessageTimeoutW`, from this process, while the
//! foreground is locked (`foreground_hold`).
//!
//! UI Automation's Win32 proxies deliver the Invoke of a push button, the
//! Toggle of a check box, and the default action of a button by posting
//! `BM_CLICK` to it (measured on a self-made window: the message arrives
//! posted, and the call returns at once). The button's window procedure
//! handles the posted click later, and activating its window then took the
//! foreground (5 of 5). A wait after the post can only make it likely that
//! the click was handled while the lock still held: a sent message is handed
//! out before posted ones, so a thread busy at the time can answer it first
//! (the review of PR #1276 measured it on a loaded CPU, 19 to 26 of 200).
//!
//! Sending the same message instead does not return until the window
//! procedure has handled it, the click handler included, so the first attempt
//! to activate the window is always made while the lock holds. The message is
//! the same one the proxy posts, to the same window, so what the button does
//! is the same (push, check box, three-state, radio, split and command-link
//! buttons, and owner-drawn ones, all handle `BM_CLICK` in their own window
//! procedure); only the delivery changes, from posted to sent. The pattern
//! the proxy offers is still what decides whether the action applies (the
//! chain asks for it first, as before), and whether a check box is already in
//! the asked state is still read through it.
//!
//! Before the click is sent, the window is checked again: it is still a
//! window, still of the button's class, of the process the ref was proven
//! for, enabled, and not hung. A failed check sends nothing
//! (`not_delivered`). A send that times out (the handler is still running, a
//! modal dialog it opened, say) was delivered: the result says so, and that
//! whether it took effect is not known (`details.click_handler:
//! "still_running"`); it is never reported as not delivered, which would
//! invite a second click.

/// `details.click_handler` when the send timed out before the handler was done.
pub(crate) const HANDLER_STILL_RUNNING: &str = "still_running";

/// The longest a click waits for the button's handler.
pub(crate) const SEND_CAP: std::time::Duration = std::time::Duration::from_millis(3_000);

/// What the window looked like just before the click.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Recheck {
    pub(crate) is_window: bool,
    pub(crate) is_button: bool,
    pub(crate) owner_matches: bool,
    pub(crate) enabled: bool,
    pub(crate) hung: bool,
}

/// How a send ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SendEnd {
    /// The handler ran and returned.
    Handled,
    /// The wait ran out; the message was handed over and may still run.
    TimedOut,
    /// The system refused to deliver it (another integrity level, the
    /// window went away): nothing reached the button.
    Refused,
    /// Failed for another reason: whether it reached the button is not known.
    Unknown,
}

/// The Win32 error a failed send set, to [`SendEnd`].
pub(crate) fn send_end_of(sent: bool, last_error: u32) -> SendEnd {
    const ERROR_ACCESS_DENIED: u32 = 5;
    const ERROR_INVALID_WINDOW_HANDLE: u32 = 1400;
    const ERROR_TIMEOUT: u32 = 1460;
    match (sent, last_error) {
        (true, _) => SendEnd::Handled,
        (false, ERROR_TIMEOUT) => SendEnd::TimedOut,
        (false, ERROR_ACCESS_DENIED | ERROR_INVALID_WINDOW_HANDLE) => SendEnd::Refused,
        (false, _) => SendEnd::Unknown,
    }
}

/// The answer to give the click chain: delivered (`Ok(true)`), or an error
/// that says what reached the button.
pub(crate) fn outcome_of(
    recheck: Recheck,
    end: Option<SendEnd>,
) -> Result<bool, agent_desktop_core::AdapterError> {
    use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode};
    let not_sent = |code: ErrorCode, message: &str| {
        Err(AdapterError::new(code, message.to_string())
            .with_disposition(DeliverySemantics::not_delivered()))
    };
    if !recheck.is_window || !recheck.is_button || !recheck.owner_matches {
        return not_sent(
            ErrorCode::StaleRef,
            "The button's window is gone or is no longer the button the ref was taken from",
        );
    }
    if !recheck.enabled {
        return not_sent(ErrorCode::ActionFailed, "The button is not enabled");
    }
    if recheck.hung {
        return not_sent(ErrorCode::AppUnresponsive, "The app is not responding");
    }
    match end {
        Some(SendEnd::Handled | SendEnd::TimedOut) => Ok(true),
        Some(SendEnd::Refused) => not_sent(
            ErrorCode::PermDenied,
            "Windows refused to deliver the click to the button (it may run with higher rights)",
        ),
        Some(SendEnd::Unknown) | None => Err(AdapterError::new(
            ErrorCode::ActionFailed,
            "The click could not be confirmed as delivered to the button",
        )
        .with_disposition(DeliverySemantics::unknown())),
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{Recheck, SEND_CAP, SendEnd, outcome_of, send_end_of};
    use agent_desktop_core::{AdapterError, Deadline};
    use std::cell::Cell;

    /// The button a background action is sending to, for the length of it.
    #[derive(Debug, Clone, Copy)]
    pub(crate) struct ButtonTarget {
        pub(crate) hwnd: isize,
        pub(crate) pid: u32,
        pub(crate) deadline: Deadline,
    }

    thread_local! {
        static TARGET: Cell<Option<ButtonTarget>> = const { Cell::new(None) };
        static TIMED_OUT: Cell<bool> = const { Cell::new(false) };
    }

    /// Runs `action` with clicks of this thread sent to `target`'s window
    /// instead of through the proxy's pattern, and says whether a send timed
    /// out. `None` runs it as before.
    pub(crate) fn with_button_delivery<T>(
        target: Option<ButtonTarget>,
        action: impl FnOnce() -> T,
    ) -> (T, bool) {
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) {
                TARGET.with(|cell| cell.set(None));
            }
        }
        TARGET.with(|cell| cell.set(target));
        TIMED_OUT.with(|cell| cell.set(false));
        let _reset = Reset;
        let value = action();
        (value, TIMED_OUT.with(Cell::get))
    }

    /// The click, when this thread is sending to a button: `Some` with what
    /// the chain is to be told, or `None` to use the proxy's pattern.
    pub(crate) fn sent_click() -> Option<Result<bool, AdapterError>> {
        let target = TARGET.with(Cell::get)?;
        Some(send_click(target))
    }

    fn send_click(target: ButtonTarget) -> Result<bool, AdapterError> {
        let recheck = recheck(target);
        if !(recheck.is_window
            && recheck.is_button
            && recheck.owner_matches
            && recheck.enabled
            && !recheck.hung)
        {
            return outcome_of(recheck, None);
        }
        let end = send_bm_click(target.hwnd, target.deadline);
        if end == Some(SendEnd::TimedOut) {
            TIMED_OUT.with(|cell| cell.set(true));
        }
        outcome_of(recheck, end)
    }

    fn recheck(target: ButtonTarget) -> Recheck {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::IsWindowEnabled;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetWindowThreadProcessId, IsHungAppWindow, IsWindow,
        };
        let hwnd = target.hwnd as windows_sys::Win32::Foundation::HWND;
        let is_window = unsafe { IsWindow(hwnd) } != 0;
        let mut pid = 0u32;
        if is_window {
            unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        }
        Recheck {
            is_window,
            is_button: is_window
                && crate::actions::list_item_click::is_win32_button_window(target.hwnd),
            owner_matches: pid != 0 && pid == target.pid,
            enabled: is_window && unsafe { IsWindowEnabled(hwnd) } != 0,
            hung: is_window && unsafe { IsHungAppWindow(hwnd) } != 0,
        }
    }

    /// Sends `BM_CLICK` and waits for the handler, at most [`SEND_CAP`] and
    /// what is left of `deadline`. `None` when no time is left (nothing sent).
    pub(crate) fn send_bm_click(hwnd: isize, deadline: Deadline) -> Option<SendEnd> {
        use windows_sys::Win32::Foundation::{GetLastError, SetLastError};
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            BM_CLICK, SMTO_ABORTIFHUNG, SMTO_ERRORONEXIT, SendMessageTimeoutW,
        };
        let wait = deadline.remaining().min(SEND_CAP);
        if wait.is_zero() {
            return None;
        }
        let millis = u32::try_from(wait.as_millis()).unwrap_or(u32::MAX).max(1);
        let mut answer = 0usize;
        unsafe { SetLastError(0) };
        let sent = unsafe {
            SendMessageTimeoutW(
                hwnd as windows_sys::Win32::Foundation::HWND,
                BM_CLICK,
                0,
                0,
                SMTO_ABORTIFHUNG | SMTO_ERRORONEXIT,
                millis,
                &mut answer,
            )
        } != 0;
        Some(send_end_of(sent, unsafe { GetLastError() }))
    }
}

#[cfg(target_os = "windows")]
pub(crate) use imp::{ButtonTarget, sent_click, with_button_delivery};

#[cfg(all(test, target_os = "windows"))]
pub(crate) use imp::send_bm_click;

#[cfg(test)]
#[path = "win32_button_tests.rs"]
mod tests;
