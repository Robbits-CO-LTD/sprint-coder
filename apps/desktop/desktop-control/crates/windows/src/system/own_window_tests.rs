// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::*;
use agent_desktop_core::{
    ActionOps, AppInfo, Deadline, DeliveryDisposition, DragParams, InputOps, InteractionLease,
    InteractionPolicy, KeyCombo, MouseButton, MouseEvent, MouseEventKind, NativeHandle, Point,
    ProcessId, ProcessIdentity, SystemOps, WindowInfo, WindowOp,
};
use std::ffi::OsStr;

use crate::adapter::WindowsAdapter;

const INSTANCE: &str = "windows-proc-v1:13438878845:5256581";

fn process(pid: u32, instance: Option<&str>) -> RefusedWindowOwner {
    RefusedWindowOwner::Process {
        pid,
        instance: instance.map(str::to_string),
    }
}

#[test]
fn reads_a_pid_alone_or_with_its_process_instance() {
    assert_eq!(
        RefusedWindowOwner::from_variable(None),
        RefusedWindowOwner::Nobody
    );
    assert_eq!(
        RefusedWindowOwner::from_variable(Some(OsStr::new("64724"))),
        process(64724, None)
    );
    assert_eq!(
        RefusedWindowOwner::from_variable(Some(OsStr::new(&format!("64724:{INSTANCE}")))),
        process(64724, Some(INSTANCE))
    );
    for raw in [
        "",
        "0",
        "-1",
        "+5",
        " 5",
        "x",
        "64724:",
        ":windows-proc-v1:1:2",
        "0:windows-proc-v1:1:2",
        "64724:windows proc",
        "64724:windows-proc-v1:1:2\n",
        "99999999999",
    ] {
        assert_eq!(
            RefusedWindowOwner::from_variable(Some(OsStr::new(raw))),
            RefusedWindowOwner::Unreadable,
            "{raw:?}"
        );
    }
}

#[test]
fn refuses_the_process_unless_its_pid_now_belongs_to_another_instance() {
    let same = |_: u32| Some(INSTANCE.to_string());
    let other = |_: u32| Some("windows-proc-v1:1:1".to_string());
    let unread = |_: u32| None;
    let with_instance = process(500, Some(INSTANCE));
    let pid_only = process(500, None);

    assert_eq!(with_instance.judge(&[Some(500)], same), Verdict::Own);
    // The instance cannot be read now: still refused.
    assert_eq!(with_instance.judge(&[Some(500)], unread), Verdict::Own);
    // The pid was reused by another process after Sprint Coder ended.
    assert_eq!(with_instance.judge(&[Some(500)], other), Verdict::Allowed);
    assert_eq!(pid_only.judge(&[Some(500)], other), Verdict::Own);
    // Any one owner of the target is enough: the part, its window, its root.
    assert_eq!(
        pid_only.judge(&[Some(7), None, Some(500)], unread),
        Verdict::Own
    );
    assert_eq!(
        pid_only.judge(&[Some(7), None, Some(8)], unread),
        Verdict::Allowed
    );
    // Nothing could be read about the target at all.
    assert_eq!(pid_only.judge(&[], unread), Verdict::Unconfirmed);
    assert_eq!(pid_only.judge(&[None, None], unread), Verdict::Unconfirmed);
    assert_eq!(
        RefusedWindowOwner::Unreadable.judge(&[Some(7)], unread),
        Verdict::Unreadable
    );
    assert_eq!(
        RefusedWindowOwner::Nobody.judge(&[Some(500)], same),
        Verdict::Allowed
    );
    assert_eq!(
        RefusedWindowOwner::Nobody.judge(&[], same),
        Verdict::Allowed
    );
}

#[test]
fn nothing_is_read_when_nothing_is_refused() {
    let read = std::cell::Cell::new(false);
    RefusedWindowOwner::Nobody
        .check("test", || {
            read.set(true);
            Vec::new()
        })
        .expect("nothing refused");
    assert!(!read.get());
}

#[test]
fn a_refusal_says_nothing_was_sent_and_offers_no_retry() {
    assert!(refusal("click", Verdict::Allowed).is_none());
    for (verdict, kind) in [
        (Verdict::Own, "own_window_refused"),
        (Verdict::Unconfirmed, "own_window_unconfirmed"),
        (Verdict::Unreadable, "own_window_variable_unreadable"),
    ] {
        let error = refusal("click", verdict).expect("refused");
        assert_eq!(error.code, ErrorCode::PolicyDenied);
        assert_eq!(
            error.disposition.delivery(),
            DeliveryDisposition::NotDelivered
        );
        assert!(!error.permits_retry_by_default(), "{kind}");
        let details = error.details.as_ref().expect("details");
        assert_eq!(details["kind"], kind);
        assert_eq!(details["operation"], "click");
        assert_eq!(details["physical_delivery_started"], false);
        assert!(
            error.message.contains("Sprint Coder")
                || error.message.contains(REFUSED_WINDOW_OWNER_VARIABLE),
            "{}",
            error.message
        );
    }
    let own = refusal("click", Verdict::Own).expect("refused");
    assert!(own.message.contains("only by the user"), "{}", own.message);
}

fn lease() -> InteractionLease {
    InteractionLease::guarded(Deadline::standard().expect("deadline"), ()).expect("lease")
}

fn refused_kind(result: Result<impl std::fmt::Debug, AdapterError>) -> String {
    let error = result.expect_err("refused");
    assert_eq!(error.code, ErrorCode::PolicyDenied, "{error:?}");
    error
        .details
        .as_ref()
        .and_then(|details| details["kind"].as_str())
        .unwrap_or_default()
        .to_string()
}

/// Targets that name nothing real, so a method that skipped the check would fail harmlessly
/// instead of acting, and the test would see a different error.
fn nowhere_window() -> WindowInfo {
    WindowInfo {
        id: "w-0".to_string(),
        title: String::new(),
        app: "nowhere.exe".to_string(),
        pid: ProcessId::from(u32::MAX - 3),
        process_instance: Some(INSTANCE.to_string()),
        bounds: None,
        state: Default::default(),
    }
}

#[test]
fn every_operation_that_acts_is_refused_when_the_variable_cannot_be_read() {
    let adapter = WindowsAdapter::new().refusing_windows_of(RefusedWindowOwner::Unreadable);
    let window = nowhere_window();
    let app = AppInfo {
        name: "nowhere.exe".to_string(),
        pid: window.pid,
        bundle_id: None,
        process_instance: Some(INSTANCE.to_string()),
        presentation: None,
    };
    let key = KeyCombo {
        key: "a".into(),
        modifiers: vec![],
    };
    let point = Point { x: -1.0, y: -1.0 };
    let unreadable = "own_window_variable_unreadable";
    assert_eq!(
        refused_kind(adapter.execute_action(
            &NativeHandle::null(),
            agent_desktop_core::actions::action_request::ActionRequest::headless(
                agent_desktop_core::Action::PressKey(key.clone())
            ),
            &lease(),
        )),
        unreadable
    );
    assert_eq!(
        refused_kind(adapter.scroll_into_view(&NativeHandle::null(), &lease())),
        unreadable
    );
    for kind in [
        MouseEventKind::Move,
        MouseEventKind::Click { count: 1 },
        MouseEventKind::Wheel {
            delta_x: 0.0,
            delta_y: 1.0,
        },
    ] {
        assert_eq!(
            refused_kind(adapter.mouse_event(
                MouseEvent {
                    kind,
                    point: point.clone(),
                    button: MouseButton::Left,
                    modifiers: Vec::new(),
                },
                &lease(),
            )),
            unreadable
        );
    }
    assert_eq!(
        refused_kind(adapter.drag(
            DragParams {
                from: point.clone(),
                to: point.clone(),
                duration_ms: None,
                drop_delay_ms: None,
            },
            &lease(),
        )),
        unreadable
    );
    assert_eq!(
        refused_kind(adapter.focus_window(&window, &lease())),
        unreadable
    );
    for op in [
        WindowOp::Move { x: 0.0, y: 0.0 },
        WindowOp::Resize {
            width: 10.0,
            height: 10.0,
        },
        WindowOp::Minimize,
        WindowOp::Maximize,
        WindowOp::Restore,
    ] {
        assert_eq!(
            refused_kind(adapter.window_op(&window, op, &lease())),
            unreadable
        );
    }
    assert_eq!(
        refused_kind(adapter.close_app(&app, false, &lease())),
        unreadable
    );
    assert_eq!(
        refused_kind(adapter.close_app(&app, true, &lease())),
        unreadable
    );
    assert_eq!(
        refused_kind(adapter.press_key_for_app(
            ProcessIdentity::new(window.pid, INSTANCE),
            &key,
            InteractionPolicy::headless(),
            &lease(),
        )),
        unreadable
    );
}

#[test]
fn naming_a_process_refuses_keys_and_closing_for_it_alone() {
    let own = std::process::id();
    let adapter = WindowsAdapter::new().refusing_windows_of(process(own, None));
    let key = KeyCombo {
        key: "a".into(),
        modifiers: vec![],
    };
    let mut window = nowhere_window();
    window.pid = ProcessId::from(own);
    assert_eq!(
        refused_kind(adapter.press_key_for_app(
            ProcessIdentity::new(own, INSTANCE),
            &key,
            InteractionPolicy::headless(),
            &lease(),
        )),
        "own_window_refused"
    );
    let app = AppInfo {
        name: "self.exe".to_string(),
        pid: ProcessId::from(own),
        bundle_id: None,
        process_instance: None,
        presentation: None,
    };
    assert_eq!(
        refused_kind(adapter.close_app(&app, true, &lease())),
        "own_window_refused"
    );
    // A window listed for this process is refused on its pid even when its handle reads nothing.
    assert_eq!(
        refused_kind(adapter.focus_window(&window, &lease())),
        "own_window_refused"
    );
}

/// A hidden top-level window of the test process, on a thread of its own: never shown, never
/// activated, and no input is synthesized at it.
#[cfg(target_os = "windows")]
mod hidden_window {
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
        GetWindowRect, IsWindowVisible, MSG, PostThreadMessageW, RegisterClassW, WM_QUIT,
        WNDCLASSW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_OVERLAPPEDWINDOW,
    };

    unsafe extern "system" fn proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }

    pub(super) struct Window {
        pub(super) hwnd: isize,
        thread: u32,
        join: Option<std::thread::JoinHandle<()>>,
    }

    impl Window {
        pub(super) fn rect(&self) -> (i32, i32, i32, i32) {
            let mut rect: RECT = unsafe { std::mem::zeroed() };
            unsafe { GetWindowRect(self.hwnd as HWND, &mut rect) };
            (rect.left, rect.top, rect.right, rect.bottom)
        }

        pub(super) fn visible(&self) -> bool {
            unsafe { IsWindowVisible(self.hwnd as HWND) != 0 }
        }
    }

    impl Drop for Window {
        fn drop(&mut self) {
            unsafe { PostThreadMessageW(self.thread, WM_QUIT, 0, 0) };
            if let Some(join) = self.join.take() {
                let _ = join.join();
            }
        }
    }

    pub(super) fn spawn() -> Window {
        let (tx, rx) = std::sync::mpsc::channel();
        let join = std::thread::spawn(move || {
            let class: Vec<u16> = "SprintCoderOwnWindowTest\0".encode_utf16().collect();
            let mut wc: WNDCLASSW = unsafe { std::mem::zeroed() };
            wc.lpfnWndProc = Some(proc);
            wc.lpszClassName = class.as_ptr();
            unsafe { RegisterClassW(&wc) };
            // No WS_VISIBLE, and never shown.
            let hwnd = unsafe {
                CreateWindowExW(
                    WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
                    class.as_ptr(),
                    class.as_ptr(),
                    WS_OVERLAPPEDWINDOW,
                    -32000,
                    -32000,
                    160,
                    90,
                    std::ptr::null_mut(),
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
            unsafe { DestroyWindow(hwnd) };
        });
        let (hwnd, thread) = rx.recv().unwrap();
        assert_ne!(hwnd, 0, "the hidden window is created");
        Window {
            hwnd,
            thread,
            join: Some(join),
        }
    }
}

#[cfg(target_os = "windows")]
#[test]
fn a_window_of_the_refused_process_is_refused_and_any_other_owner_is_not() {
    let window = hidden_window::spawn();
    let own = std::process::id();
    let token = crate::system::process_identity::token_for_pid(ProcessId::from(own))
        .unwrap()
        .expect("own instance");
    // The facts read at the time of the operation: the handle's owner is this process.
    assert!(hwnd_owners(window.hwnd).contains(&Some(own)));
    let info = WindowInfo {
        id: format!("w-{}", window.hwnd as usize),
        title: String::new(),
        app: "test.exe".to_string(),
        // The listed pid is not trusted alone: the live owner of the handle refuses it.
        pid: ProcessId::from(u32::MAX - 3),
        process_instance: Some(token.clone()),
        bounds: None,
        state: Default::default(),
    };
    let before = window.rect();
    for refused in [process(own, Some(&token)), process(own, None)] {
        let adapter = WindowsAdapter::new().refusing_windows_of(refused);
        assert_eq!(
            refused_kind(adapter.window_op(&info, WindowOp::Move { x: 10.0, y: 10.0 }, &lease())),
            "own_window_refused"
        );
    }
    assert_eq!(window.rect(), before, "the refused move moved nothing");
    // Another process named, or the pid now another instance: not refused here.
    for allowed in [
        RefusedWindowOwner::Nobody,
        process(u32::MAX - 7, None),
        process(own, Some("windows-proc-v1:1:1")),
    ] {
        let adapter = WindowsAdapter::new().refusing_windows_of(allowed);
        let moved = adapter.window_op(
            &info,
            WindowOp::Move {
                x: -31990.0,
                y: -31990.0,
            },
            &lease(),
        );
        if let Err(error) = &moved {
            let kind = error
                .details
                .as_ref()
                .and_then(|details| details["kind"].as_str());
            assert!(
                kind.is_none_or(|kind| !kind.starts_with("own_window")),
                "{error:?}"
            );
        }
    }
    assert!(!window.visible(), "the window was never shown");
}

#[cfg(target_os = "windows")]
#[test]
fn a_part_of_a_window_of_the_refused_process_is_refused() {
    use crate::tree::automation::automation_client;
    use crate::tree::element::UIAElement;
    use uiautomation::types::Handle;

    crate::tree::fixture::ensure_test_apartment();
    let window = hidden_window::spawn();
    let own = std::process::id();
    let element = automation_client()
        .expect("client")
        .element_from_handle(Handle::from(window.hwnd))
        .expect("element");
    let handle: NativeHandle = UIAElement::from(element).into_native_handle();
    let owners = handle_owners(&handle, Deadline::standard().unwrap()).expect("a part");
    assert!(owners.contains(&Some(own)), "{owners:?}");
    let adapter = WindowsAdapter::new().refusing_windows_of(process(own, None));
    for action in [
        agent_desktop_core::Action::Click,
        agent_desktop_core::Action::SetFocus,
        agent_desktop_core::Action::SetValue("x".into()),
        agent_desktop_core::Action::Toggle,
        agent_desktop_core::Action::Expand,
        agent_desktop_core::Action::TypeText("x".into()),
    ] {
        assert_eq!(
            refused_kind(adapter.execute_action(
                &handle,
                agent_desktop_core::actions::action_request::ActionRequest::headless(action),
                &lease(),
            )),
            "own_window_refused"
        );
    }
    assert_eq!(
        refused_kind(adapter.scroll_into_view(&handle, &lease())),
        "own_window_refused"
    );
    assert!(!window.visible(), "the window was never shown");
}
