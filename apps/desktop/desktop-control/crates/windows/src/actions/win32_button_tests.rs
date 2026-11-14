// Added by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::{HANDLER_STILL_RUNNING, Recheck, SendEnd, outcome_of, send_end_of};
use agent_desktop_core::{DeliveryDisposition, ErrorCode};

fn fine() -> Recheck {
    Recheck {
        is_window: true,
        is_button: true,
        owner_matches: true,
        enabled: true,
        hung: false,
    }
}

#[test]
fn a_failed_send_is_read_from_its_error() {
    assert_eq!(send_end_of(true, 0), SendEnd::Handled);
    assert_eq!(send_end_of(true, 1460), SendEnd::Handled);
    assert_eq!(send_end_of(false, 1460), SendEnd::TimedOut);
    assert_eq!(send_end_of(false, 5), SendEnd::Refused);
    assert_eq!(send_end_of(false, 1400), SendEnd::Refused);
    assert_eq!(send_end_of(false, 0), SendEnd::Unknown);
    assert_eq!(send_end_of(false, 87), SendEnd::Unknown);
}

#[test]
fn a_handled_or_timed_out_click_was_delivered() {
    assert!(outcome_of(fine(), Some(SendEnd::Handled)).expect("delivered"));
    // A handler still running (a modal dialog it opened) got the click: it is
    // never reported as not delivered, which would invite a second click.
    assert!(outcome_of(fine(), Some(SendEnd::TimedOut)).expect("delivered"));
    assert_eq!(HANDLER_STILL_RUNNING, "still_running");
}

#[test]
fn nothing_is_sent_to_a_window_that_changed_or_cannot_take_it() {
    for (recheck, code) in [
        (
            Recheck {
                is_window: false,
                ..fine()
            },
            ErrorCode::StaleRef,
        ),
        (
            Recheck {
                is_button: false,
                ..fine()
            },
            ErrorCode::StaleRef,
        ),
        (
            Recheck {
                owner_matches: false,
                ..fine()
            },
            ErrorCode::StaleRef,
        ),
        (
            Recheck {
                enabled: false,
                ..fine()
            },
            ErrorCode::ActionFailed,
        ),
        (
            Recheck {
                hung: true,
                ..fine()
            },
            ErrorCode::AppUnresponsive,
        ),
    ] {
        let error = outcome_of(recheck, Some(SendEnd::Handled)).expect_err("refused");
        assert_eq!(error.code, code);
        assert_eq!(
            error.disposition.delivery(),
            DeliveryDisposition::NotDelivered
        );
    }
}

#[test]
fn a_refused_send_did_not_deliver_and_an_unclear_one_is_unknown() {
    let refused = outcome_of(fine(), Some(SendEnd::Refused)).expect_err("refused");
    assert_eq!(refused.code, ErrorCode::PermDenied);
    assert_eq!(
        refused.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
    for end in [Some(SendEnd::Unknown), None] {
        let unclear = outcome_of(fine(), end).expect_err("unclear");
        assert_ne!(
            unclear.disposition.delivery(),
            DeliveryDisposition::NotDelivered
        );
    }
}

/// A message-only window (`HWND_MESSAGE`) on a thread of its own: never
/// shown, never activated, no input synthesized. Its window procedure records
/// the order it handles a posted "busy" message (`WM_APP`, which sleeps) and
/// `BM_CLICK` (which sleeps for `CLICK_MS`, then records).
#[cfg(target_os = "windows")]
mod message_only {
    use std::sync::Mutex;
    use std::sync::mpsc;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        BM_CLICK, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
        HWND_MESSAGE, MSG, PostQuitMessage, PostThreadMessageW, RegisterClassW, WM_APP, WM_QUIT,
        WNDCLASSW,
    };

    pub(super) static EVENTS: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());
    pub(super) static CLICK_MS: Mutex<u64> = Mutex::new(0);

    unsafe extern "system" fn proc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
        if msg == BM_CLICK {
            let ms = *CLICK_MS.lock().unwrap();
            std::thread::sleep(std::time::Duration::from_millis(ms));
            EVENTS.lock().unwrap().push("click handled");
            return 0;
        }
        if msg == WM_APP {
            std::thread::sleep(std::time::Duration::from_millis(w as u64));
            EVENTS.lock().unwrap().push("busy done");
            return 0;
        }
        if msg == WM_APP + 1 {
            unsafe { DestroyWindow(hwnd) };
            unsafe { PostQuitMessage(0) };
            return 0;
        }
        unsafe { DefWindowProcW(hwnd, msg, w, l) }
    }

    pub(super) struct Target {
        pub(super) hwnd: isize,
        thread: u32,
        join: Option<std::thread::JoinHandle<()>>,
    }

    impl Drop for Target {
        fn drop(&mut self) {
            unsafe {
                windows_sys::Win32::UI::WindowsAndMessaging::PostMessageW(
                    self.hwnd as HWND,
                    WM_APP + 1,
                    0,
                    0,
                )
            };
            unsafe { PostThreadMessageW(self.thread, WM_QUIT, 0, 0) };
            if let Some(join) = self.join.take() {
                let _ = join.join();
            }
        }
    }

    pub(super) fn spawn() -> Target {
        let (tx, rx) = mpsc::channel();
        let join = std::thread::spawn(move || {
            let class: Vec<u16> = "SprintCoderButtonOrderTest\0".encode_utf16().collect();
            let mut wc: WNDCLASSW = unsafe { std::mem::zeroed() };
            wc.lpfnWndProc = Some(proc);
            wc.lpszClassName = class.as_ptr();
            unsafe { RegisterClassW(&wc) };
            let hwnd = unsafe {
                CreateWindowExW(
                    0,
                    class.as_ptr(),
                    class.as_ptr(),
                    0,
                    0,
                    0,
                    0,
                    0,
                    HWND_MESSAGE,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null(),
                )
            };
            tx.send((hwnd as isize, unsafe { GetCurrentThreadId() }))
                .unwrap();
            let mut msg: MSG = unsafe { std::mem::zeroed() };
            while unsafe { GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) } > 0 {
                unsafe { DispatchMessageW(&msg) };
            }
        });
        let (hwnd, thread) = rx.recv().unwrap();
        assert_ne!(hwnd, 0, "the message-only window is created");
        Target {
            hwnd,
            thread,
            join: Some(join),
        }
    }
}

/// One test drives all three cases, so the shared event log is not raced by
/// another test of this module.
#[cfg(target_os = "windows")]
#[test]
fn a_sent_click_returns_only_after_the_handler_even_behind_a_busy_thread() {
    use agent_desktop_core::Deadline;
    use message_only::{CLICK_MS, EVENTS, spawn};
    use windows_sys::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_APP};
    let target = spawn();

    // (a) The send waits for the handler: its mark is there when it returns.
    EVENTS.lock().unwrap().clear();
    *CLICK_MS.lock().unwrap() = 50;
    let end = super::send_bm_click(target.hwnd, Deadline::after(2_000).unwrap());
    assert_eq!(end, Some(SendEnd::Handled));
    assert_eq!(*EVENTS.lock().unwrap(), vec!["click handled"]);

    // (b) The thread is busy with a posted message when the click is sent:
    // the send still returns only after the click was handled.
    EVENTS.lock().unwrap().clear();
    *CLICK_MS.lock().unwrap() = 0;
    unsafe { PostMessageW(target.hwnd as _, WM_APP, 150, 0) };
    std::thread::sleep(std::time::Duration::from_millis(20));
    let end = super::send_bm_click(target.hwnd, Deadline::after(2_000).unwrap());
    assert_eq!(end, Some(SendEnd::Handled));
    assert_eq!(*EVENTS.lock().unwrap(), vec!["busy done", "click handled"]);

    // (c) A handler that outlasts the wait: timed out, i.e. delivered and
    // still running, never "not delivered".
    EVENTS.lock().unwrap().clear();
    *CLICK_MS.lock().unwrap() = 400;
    let end = super::send_bm_click(target.hwnd, Deadline::after(100).unwrap());
    assert_eq!(end, Some(SendEnd::TimedOut));
    assert!(outcome_of(fine(), end).expect("delivered"));
    std::thread::sleep(std::time::Duration::from_millis(450));
    assert_eq!(*EVENTS.lock().unwrap(), vec!["click handled"]);
}

#[cfg(target_os = "windows")]
#[test]
fn the_click_is_routed_to_the_button_only_while_a_target_is_set() {
    assert!(super::sent_click().is_none());
    let target = super::ButtonTarget {
        hwnd: 0,
        pid: std::process::id(),
        deadline: agent_desktop_core::Deadline::after(1_000).unwrap(),
    };
    let (answer, timed_out) = super::with_button_delivery(Some(target), super::sent_click);
    let error = answer.expect("routed").expect_err("no such window");
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert!(!timed_out);
    assert!(super::sent_click().is_none(), "cleared after the action");
}
