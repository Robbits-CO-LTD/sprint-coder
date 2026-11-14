// Added by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::{HANDLER_UNKNOWN, Recheck, SendEnd, outcome_of, send_end_of};
use agent_desktop_core::{DeliveryDisposition, ErrorCode, RetryDisposition};

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
    // An invalid window after the send began: the handler may have run and
    // closed the window or ended its process in it, so it is not "refused".
    assert_eq!(send_end_of(false, 1400), SendEnd::Unknown);
    assert_eq!(send_end_of(false, 0), SendEnd::Unknown);
    assert_eq!(send_end_of(false, 87), SendEnd::Unknown);
}

#[test]
fn only_a_send_that_returned_from_the_handler_was_delivered() {
    assert!(outcome_of(fine(), Some(SendEnd::Handled)).expect("delivered"));
}

/// A timed-out send is neither delivered nor not delivered: the handler may
/// not have started, or may still run. It is a timeout of uncertain delivery,
/// which is not retried on its own, as a timed-out UI Automation call is.
fn assert_uncertain_timeout(error: &agent_desktop_core::AdapterError) {
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::DeliveryUncertain
    );
    assert_eq!(error.disposition.retry(), RetryDisposition::Unsafe);
    assert_eq!(
        error.details.as_ref().expect("details")["click_handler"],
        HANDLER_UNKNOWN
    );
}

#[test]
fn a_timed_out_click_is_of_uncertain_delivery() {
    let error = outcome_of(fine(), Some(SendEnd::TimedOut)).expect_err("uncertain");
    assert_uncertain_timeout(&error);
}

#[test]
fn the_three_ways_a_send_can_end() {
    // Delivered: only a send that returned.
    assert_eq!(send_end_of(true, 0), SendEnd::Handled);
    // Not delivered: only UIPI's refusal.
    assert_eq!(send_end_of(false, 5), SendEnd::Refused);
    // Not known: the rest, the timeout and the window that went away
    // (the handler may have closed it, or ended its process) included.
    for error in [0, 87, 1400, 1460] {
        assert!(
            matches!(
                send_end_of(false, error),
                SendEnd::TimedOut | SendEnd::Unknown
            ),
            "{error}"
        );
    }
}

#[cfg(target_os = "windows")]
#[test]
fn the_delivery_is_marked_only_when_a_click_was_sent() {
    use agent_desktop_core::{ActionResult, AdapterError};
    let mark = |result| crate::actions::dispatch::note_button_delivery(result, 0);
    // A check of a box already checked sent nothing: no mark.
    let none = mark(Ok(ActionResult::delivered_unverified("check"))).expect("ok");
    assert!(none.details.is_none());
    let sent = crate::actions::dispatch::note_button_delivery(
        Ok(ActionResult::delivered_unverified("click")),
        1,
    )
    .expect("ok");
    assert_eq!(
        sent.details.expect("details")["delivery"],
        "win32_bm_click_sent"
    );
    // A send that timed out was still sent: the error says so.
    let error = crate::actions::dispatch::note_button_delivery(
        Err(AdapterError::new(ErrorCode::Timeout, "t")),
        1,
    )
    .expect_err("err");
    assert_eq!(
        error.details.expect("details")["delivery"],
        "win32_bm_click_sent"
    );
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
    pub(super) static DESTROY_IN_CLICK: Mutex<bool> = Mutex::new(false);

    unsafe extern "system" fn proc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
        if msg == BM_CLICK {
            let ms = *CLICK_MS.lock().unwrap();
            std::thread::sleep(std::time::Duration::from_millis(ms));
            EVENTS.lock().unwrap().push("click handled");
            if *DESTROY_IN_CLICK.lock().unwrap() {
                unsafe { DestroyWindow(hwnd) };
            }
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

    // (c) The handler started and outlasts the wait: a timeout of uncertain
    // delivery, never "not delivered", never "delivered".
    EVENTS.lock().unwrap().clear();
    *CLICK_MS.lock().unwrap() = 400;
    let end = super::send_bm_click(target.hwnd, Deadline::after(100).unwrap());
    assert_eq!(end, Some(SendEnd::TimedOut));
    assert_uncertain_timeout(&outcome_of(fine(), end).expect_err("uncertain"));
    std::thread::sleep(std::time::Duration::from_millis(450));
    assert_eq!(*EVENTS.lock().unwrap(), vec!["click handled"]);

    // (c2) The thread is held longer than the wait before the handler can
    // start: the same answer, as the timeout cannot tell the two apart.
    EVENTS.lock().unwrap().clear();
    *CLICK_MS.lock().unwrap() = 0;
    unsafe { PostMessageW(target.hwnd as _, WM_APP, 300, 0) };
    std::thread::sleep(std::time::Duration::from_millis(20));
    let end = super::send_bm_click(target.hwnd, Deadline::after(100).unwrap());
    assert_eq!(end, Some(SendEnd::TimedOut));
    assert!(
        EVENTS.lock().unwrap().is_empty(),
        "the handler had not started when the wait ran out"
    );
    assert_uncertain_timeout(&outcome_of(fine(), end).expect_err("uncertain"));
    std::thread::sleep(std::time::Duration::from_millis(400));
    // Here the click was dropped: a send that gave up before the handler
    // started is not handed over. In (c) the handler ran to its end. Both
    // came back as the same timeout, so it can say neither.
    assert_eq!(*EVENTS.lock().unwrap(), vec!["busy done"]);

    // (d) The handler closes the button's own window (a "Close" button): the
    // send still answers that the handler ran. Last, as the window is gone.
    EVENTS.lock().unwrap().clear();
    *CLICK_MS.lock().unwrap() = 0;
    *message_only::DESTROY_IN_CLICK.lock().unwrap() = true;
    let end = super::send_bm_click(target.hwnd, Deadline::after(2_000).unwrap());
    *message_only::DESTROY_IN_CLICK.lock().unwrap() = false;
    assert_eq!(end, Some(SendEnd::Handled));
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
    let (answer, sent) = super::with_button_delivery(Some(target), super::sent_click);
    let error = answer.expect("routed").expect_err("no such window");
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(sent, 0, "nothing was sent to a window that is not there");
    assert!(super::sent_click().is_none(), "cleared after the action");
}
