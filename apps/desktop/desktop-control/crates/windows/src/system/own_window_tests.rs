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
    assert!(refusal("click", Verdict::Allowed, None).is_none());
    for (verdict, kind) in [
        (Verdict::Own, "own_window_refused"),
        (Verdict::Unconfirmed, "own_window_unconfirmed"),
        (Verdict::Unreadable, "own_window_variable_unreadable"),
    ] {
        let error = refusal("click", verdict, None).expect("refused");
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
    let own = refusal("click", Verdict::Own, None).expect("refused");
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
    let menu_item: agent_desktop_core::RefEntry = serde_json::from_value(serde_json::json!({
        "pid": u32::from(window.pid),
        "process_instance": window.process_instance,
        "role": "menuitem",
        "name": "Save",
        "proven_in_menu": {
            "steps": [
                { "name": "File", "position": 0, "submenu": true },
                { "name": "Save", "position": 1, "submenu": false },
            ],
            "command_id": 1002,
        },
        "bounds_hash": null,
        "available_actions": ["click"],
        "source_app": window.app,
        "source_window_id": window.id,
        "source_surface": "menubar",
    }))
    .expect("a menu item ref");
    assert_eq!(
        refused_kind(adapter.run_menu_command(
            &menu_item,
            &window,
            Deadline::standard().unwrap(),
            &lease(),
        )),
        unreadable
    );
    // The default `press_key_for_window` reaches `press_key_for_app` only for the window in
    // front, so it is given that one (key input in a test build is recorded, never sent).
    if let Some(front) = adapter
        .focused_window(Deadline::standard().unwrap())
        .unwrap()
        .filter(|front| front.process_instance.is_some())
    {
        assert_eq!(
            refused_kind(adapter.press_key_for_window(
                &front,
                &key,
                InteractionPolicy::headless(),
                &lease(),
            )),
            unreadable
        );
    }
}

fn pointer_facts(
    point: Option<u32>,
    foreground: Option<u32>,
    may_not_take_foreground: bool,
) -> fake::PointerFacts {
    fake::PointerFacts {
        point: point.into_iter().map(Some).collect(),
        foreground: foreground.into_iter().map(Some).collect(),
        may_not_take_foreground,
        later_points: Vec::new(),
    }
}

/// `None` when it was not refused for its own window; otherwise which window refused it.
fn own_refusal_target(result: Result<impl std::fmt::Debug, AdapterError>) -> Option<String> {
    let error = result.err()?;
    let details = error.details.as_ref()?;
    details["kind"]
        .as_str()
        .filter(|kind| kind.starts_with("own_window"))?;
    Some(details["target"].as_str().unwrap_or("none").to_string())
}

#[test]
fn may_not_take_the_foreground_reads_the_styles_narrowly() {
    let plain = WindowStyles {
        style: 0x10CF_0000, // WS_OVERLAPPEDWINDOW | WS_VISIBLE
        ex_style: 0x0000_0100,
    };
    let with = |ex: u32| WindowStyles {
        style: plain.style,
        ex_style: plain.ex_style | ex,
    };
    let ordinary = ClickedWindows {
        leaf: Some(plain),
        root: Some(plain),
        root_owner: None,
    };
    assert!(!may_not_take_foreground(&ordinary));
    // A topmost window alone, or a layered one alone, still takes the foreground.
    for ex in [WS_EX_TOPMOST, WS_EX_LAYERED] {
        assert!(!may_not_take_foreground(&ClickedWindows {
            root: Some(with(ex)),
            ..ordinary
        }));
    }
    let no_activate = with(WS_EX_NOACTIVATE);
    for windows in [
        ClickedWindows {
            leaf: Some(no_activate),
            ..ordinary
        },
        ClickedWindows {
            root: Some(no_activate),
            ..ordinary
        },
        ClickedWindows {
            root_owner: Some(Some(no_activate)),
            ..ordinary
        },
        ClickedWindows {
            root: Some(with(WS_EX_TOOLWINDOW)),
            ..ordinary
        },
        ClickedWindows {
            root: Some(with(WS_EX_TOPMOST | WS_EX_LAYERED)),
            ..ordinary
        },
        ClickedWindows {
            root: Some(WindowStyles {
                style: plain.style | WS_DISABLED,
                ex_style: plain.ex_style,
            }),
            ..ordinary
        },
        // Styles that cannot be read.
        ClickedWindows {
            leaf: None,
            ..ordinary
        },
        ClickedWindows {
            root: None,
            ..ordinary
        },
        ClickedWindows {
            root_owner: Some(None),
            ..ordinary
        },
    ] {
        assert!(may_not_take_foreground(&windows), "{windows:?}");
    }
}

#[test]
fn pointer_input_that_can_reach_the_window_in_front_is_judged_by_it_too() {
    let own = 500;
    let other = 7;
    let adapter = WindowsAdapter::new().refusing_windows_of(process(own, None));
    let event = |kind: MouseEventKind, modifiers: Vec<agent_desktop_core::Modifier>| MouseEvent {
        kind,
        point: Point { x: 5.0, y: 5.0 },
        button: MouseButton::Left,
        modifiers,
    };
    let click = || MouseEventKind::Click { count: 1 };
    let wheel = || MouseEventKind::Wheel {
        delta_x: 0.0,
        delta_y: -1.0,
    };
    let drag = || DragParams {
        from: Point { x: 5.0, y: 5.0 },
        to: Point { x: 9.0, y: 9.0 },
        duration_ms: None,
        drop_delay_ms: None,
    };
    let mouse = |facts, kind, modifiers| {
        fake::with(facts, || {
            own_refusal_target(adapter.mouse_event(event(kind, modifiers), &lease()))
        })
    };
    let dragged = |facts| fake::with(facts, || own_refusal_target(adapter.drag(drag(), &lease())));
    let front = Some("foreground".to_string());

    // A wheel over another app while Sprint Coder is in front is refused; with another in front not.
    assert_eq!(
        mouse(
            pointer_facts(Some(other), Some(own), false),
            wheel(),
            vec![]
        ),
        front
    );
    assert_eq!(
        mouse(
            pointer_facts(Some(other), Some(other), false),
            wheel(),
            vec![]
        ),
        None
    );
    // A click on a window that may not take the foreground (an on-screen keyboard's key).
    assert_eq!(
        mouse(pointer_facts(Some(other), Some(own), true), click(), vec![]),
        front
    );
    assert_eq!(
        mouse(
            pointer_facts(Some(other), Some(other), true),
            click(),
            vec![]
        ),
        None
    );
    // A click on an ordinary window takes the foreground first: allowed with Sprint Coder in front.
    assert_eq!(
        mouse(
            pointer_facts(Some(other), Some(own), false),
            click(),
            vec![]
        ),
        None
    );
    // Except with modifier keys, which go to the window in front.
    assert_eq!(
        mouse(
            pointer_facts(Some(other), Some(own), false),
            click(),
            vec![agent_desktop_core::Modifier::Ctrl]
        ),
        front
    );
    // A move makes no input for the window in front.
    assert_eq!(
        mouse(
            pointer_facts(Some(other), Some(own), true),
            MouseEventKind::Move,
            vec![]
        ),
        None
    );
    // The window in front unread, when it decides: refused (narrow side).
    assert_eq!(
        mouse(pointer_facts(Some(other), None, true), click(), vec![]),
        front
    );
    // The window at the point is Sprint Coder's: refused by it.
    assert_eq!(
        mouse(
            pointer_facts(Some(own), Some(other), false),
            click(),
            vec![]
        ),
        Some("point".to_string())
    );
    // A drag: either end that may not take the foreground brings in the window in front.
    assert_eq!(dragged(pointer_facts(Some(other), Some(own), true)), front);
    assert_eq!(dragged(pointer_facts(Some(other), Some(own), false)), None);
    assert_eq!(
        dragged(pointer_facts(Some(own), Some(other), false)),
        Some("point".to_string())
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
        spawn_with(WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW)
    }

    /// With these extended styles (never shown either way).
    pub(super) fn spawn_with(ex_style: u32) -> Window {
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
                    ex_style,
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

#[cfg(target_os = "windows")]
#[test]
fn the_styles_of_a_real_window_decide_whether_a_click_may_leave_the_front_alone() {
    // Read from live windows of this process, never shown and never clicked.
    let ordinary = hidden_window::spawn_with(0);
    assert!(!hwnd_may_not_take_foreground(ordinary.hwnd));
    for ex_style in [
        WS_EX_NOACTIVATE,
        WS_EX_TOOLWINDOW,
        WS_EX_TOPMOST | WS_EX_LAYERED,
    ] {
        let window = hidden_window::spawn_with(ex_style);
        assert!(hwnd_may_not_take_foreground(window.hwnd), "{ex_style:#x}");
    }
    // A handle that names no window.
    assert!(hwnd_may_not_take_foreground(0));
    assert!(!ordinary.visible());
}

#[test]
fn a_part_is_judged_by_the_window_in_front_only_in_a_window_that_never_takes_it() {
    let plain = WindowStyles {
        style: 0x10CF_0000,
        ex_style: 0x0000_0100,
    };
    let with = |ex: u32, style: u32| WindowStyles {
        style: plain.style | style,
        ex_style: plain.ex_style | ex,
    };
    let ordinary = ClickedWindows {
        leaf: Some(plain),
        root: Some(plain),
        root_owner: None,
    };
    assert!(!part_window_may_not_take_foreground(Some(&ordinary)));
    // Narrower than for a click at a point: the taskbar (a topmost tool window), the desktop (a
    // tool window), tool palettes, disabled and layered topmost roots are not judged by the front.
    for root in [
        with(WS_EX_TOOLWINDOW | WS_EX_TOPMOST, 0),
        with(WS_EX_TOOLWINDOW, 0),
        with(WS_EX_TOPMOST | WS_EX_LAYERED, 0),
        with(0, WS_DISABLED),
    ] {
        assert!(!part_window_may_not_take_foreground(Some(
            &ClickedWindows {
                root: Some(root),
                ..ordinary
            }
        )));
    }
    let no_activate = with(WS_EX_NOACTIVATE, 0);
    for windows in [
        ClickedWindows {
            leaf: Some(no_activate),
            ..ordinary
        },
        ClickedWindows {
            root: Some(no_activate),
            ..ordinary
        },
        ClickedWindows {
            root_owner: Some(Some(no_activate)),
            ..ordinary
        },
        ClickedWindows {
            leaf: None,
            ..ordinary
        },
        ClickedWindows {
            root_owner: Some(None),
            ..ordinary
        },
    ] {
        assert!(
            part_window_may_not_take_foreground(Some(&windows)),
            "{windows:?}"
        );
    }
    // No window could be read for the part.
    assert!(part_window_may_not_take_foreground(None));
}

#[cfg(target_os = "windows")]
#[test]
fn a_ref_in_a_window_that_never_takes_the_front_is_refused_while_sprint_coder_is_in_front() {
    use crate::tree::automation::automation_client;
    use crate::tree::element::UIAElement;
    use uiautomation::types::Handle;

    crate::tree::fixture::ensure_test_apartment();
    // Sprint Coder stands for a process that is not this one. The windows are this process's,
    // hidden and never activated, and only the window in front is put in place.
    let sprint_coder = u32::MAX - 9;
    let other = u32::MAX - 11;
    let adapter = WindowsAdapter::new().refusing_windows_of(process(sprint_coder, None));
    let front = |pid: u32| fake::PointerFacts {
        foreground: vec![Some(pid)],
        ..Default::default()
    };
    let part = |hwnd: isize| -> NativeHandle {
        let element = automation_client()
            .expect("client")
            .element_from_handle(Handle::from(hwnd))
            .expect("element");
        UIAElement::from(element).into_native_handle()
    };
    let info = |hwnd: isize| WindowInfo {
        id: format!("w-{}", hwnd as usize),
        title: String::new(),
        app: "test.exe".to_string(),
        pid: ProcessId::from(std::process::id()),
        process_instance: None,
        bounds: None,
        state: Default::default(),
    };
    let menu_item = |window: &WindowInfo| -> agent_desktop_core::RefEntry {
        serde_json::from_value(serde_json::json!({
            "pid": std::process::id(),
            "process_instance": null,
            "role": "menuitem",
            "name": "Save",
            "proven_in_menu": {
                "steps": [
                    { "name": "File", "position": 0, "submenu": true },
                    { "name": "Save", "position": 1, "submenu": false },
                ],
                "command_id": 1002,
            },
            "bounds_hash": null,
            "available_actions": ["click"],
            "source_app": window.app,
            "source_window_id": window.id,
            "source_surface": "menubar",
        }))
        .expect("a menu item ref")
    };
    // What each operation is refused by, if by Sprint Coder at all, with `pid` in front.
    let outcomes = |hwnd: isize, pid: u32| -> Vec<Option<String>> {
        let handle = part(hwnd);
        let window = info(hwnd);
        fake::with(front(pid), || {
            vec![
                own_refusal_target(adapter.execute_action(
                    &handle,
                    agent_desktop_core::actions::action_request::ActionRequest::headless(
                        agent_desktop_core::Action::Expand,
                    ),
                    &lease(),
                )),
                own_refusal_target(adapter.scroll_into_view(&handle, &lease())),
                own_refusal_target(adapter.run_menu_command(
                    &menu_item(&window),
                    &window,
                    Deadline::standard().unwrap(),
                    &lease(),
                )),
            ]
        })
    };
    let refused = vec![Some("foreground".to_string()); 3];
    let passed = vec![None; 3];

    // The kind of window an on-screen keyboard is: refused while Sprint Coder is in front.
    let keyboard = hidden_window::spawn_with(WS_EX_NOACTIVATE);
    assert_eq!(outcomes(keyboard.hwnd, sprint_coder), refused);
    assert_eq!(outcomes(keyboard.hwnd, other), passed);
    // An ordinary window and tool windows (the kind the taskbar is): never judged by the front.
    for ex_style in [0, WS_EX_TOOLWINDOW, WS_EX_TOOLWINDOW | WS_EX_TOPMOST] {
        let window = hidden_window::spawn_with(ex_style);
        assert_eq!(outcomes(window.hwnd, sprint_coder), passed, "{ex_style:#x}");
        assert!(!window.visible());
    }
    assert!(!keyboard.visible());
}

/// What the mouse seam recorded (a test build records, never sends) while `body` ran.
#[cfg(target_os = "windows")]
fn recorded_mouse<T>(body: impl FnOnce() -> T) -> (T, Vec<u32>) {
    use crate::input::mouse::mouse_send::mouse_send_fake_sink as sink;
    sink::reset();
    let result = body();
    let flags = sink::recorded()
        .into_iter()
        .map(|event| event.flags)
        .collect();
    sink::reset();
    (result, flags)
}

#[cfg(target_os = "windows")]
fn count_flag(flags: &[u32], flag: u32) -> usize {
    flags
        .iter()
        .filter(|recorded| **recorded & flag != 0)
        .count()
}

#[cfg(target_os = "windows")]
#[test]
fn a_later_click_of_a_sequence_is_judged_again_and_the_rest_is_not_sent() {
    use crate::input::mouse::mouse_send::{MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP};
    use agent_desktop_core::DeliveryDisposition;

    let own = 500;
    let other = 7;
    let adapter = WindowsAdapter::new().refusing_windows_of(process(own, None));
    let clicks = |count: u32, later: Vec<Vec<Option<u32>>>| {
        let facts = fake::PointerFacts {
            point: vec![Some(other)],
            foreground: vec![Some(other)],
            later_points: later,
            ..Default::default()
        };
        recorded_mouse(|| {
            fake::with(facts, || {
                adapter.mouse_event(
                    MouseEvent {
                        kind: MouseEventKind::Click { count },
                        point: Point { x: 5.0, y: 5.0 },
                        button: MouseButton::Left,
                        modifiers: Vec::new(),
                    },
                    &lease(),
                )
            })
        })
    };

    // The first click closes the window at the point, and Sprint Coder is there for the second.
    let (result, flags) = clicks(2, vec![vec![Some(own)]]);
    let error = result.expect_err("the second click is refused");
    assert_eq!(error.code, ErrorCode::PolicyDenied);
    let details = error.details.as_ref().expect("details");
    assert_eq!(details["kind"], "own_window_refused");
    assert_eq!(details["target"], "point");
    assert_eq!(details["clicks_sent"], 1);
    assert_eq!(details["physical_delivery_started"], true);
    assert!(
        details["delivered_events"].as_u64().unwrap_or(0) > 0,
        "{details}"
    );
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::DeliveredUnverified
    );
    assert!(!error.permits_retry_by_default());
    assert!(
        error.message.contains("before this one were sent"),
        "{}",
        error.message
    );
    // One click went (a down and an up), and nothing after it.
    assert_eq!(count_flag(&flags, MOUSEEVENTF_LEFTDOWN), 1);
    assert_eq!(count_flag(&flags, MOUSEEVENTF_LEFTUP), 1);

    // The third of three.
    let (result, flags) = clicks(3, vec![vec![Some(other)], vec![Some(own)]]);
    assert_eq!(
        result.expect_err("refused").details.unwrap()["clicks_sent"],
        2
    );
    assert_eq!(count_flag(&flags, MOUSEEVENTF_LEFTDOWN), 2);

    // Nothing changes: every click goes, as before.
    let (result, flags) = clicks(3, Vec::new());
    assert!(result.is_ok(), "{result:?}");
    assert_eq!(count_flag(&flags, MOUSEEVENTF_LEFTDOWN), 3);
    // A single click is judged once, before anything is sent.
    let (result, flags) = clicks(1, vec![vec![Some(own)]]);
    assert!(result.is_ok(), "{result:?}");
    assert_eq!(count_flag(&flags, MOUSEEVENTF_LEFTDOWN), 1);
}

#[cfg(target_os = "windows")]
#[test]
fn a_later_wheel_event_is_judged_again() {
    use crate::input::mouse::mouse_send::MOUSEEVENTF_WHEEL;

    let own = 500;
    let other = 7;
    let adapter = WindowsAdapter::new().refusing_windows_of(process(own, None));
    let facts = fake::PointerFacts {
        point: vec![Some(other)],
        foreground: vec![Some(other)],
        // The first read is the check before anything; the second is before the second event.
        later_points: vec![vec![Some(own)]],
        ..Default::default()
    };
    let (result, flags) = recorded_mouse(|| {
        fake::with(facts, || {
            adapter.mouse_event(
                MouseEvent {
                    // 25 lines go as 10, 10 and 5.
                    kind: MouseEventKind::Wheel {
                        delta_x: 0.0,
                        delta_y: -25.0,
                    },
                    point: Point { x: 5.0, y: 5.0 },
                    button: MouseButton::Left,
                    modifiers: Vec::new(),
                },
                &lease(),
            )
        })
    });
    let error = result.expect_err("the second wheel event is refused");
    assert_eq!(error.details.as_ref().unwrap()["wheel_events_sent"], 1);
    assert_eq!(count_flag(&flags, MOUSEEVENTF_WHEEL), 1);
}

#[cfg(target_os = "windows")]
#[test]
fn a_drop_on_a_window_that_became_sprint_coder_is_not_made() {
    use crate::input::mouse::mouse_send::{MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP};

    let own = 500;
    let other = 7;
    let adapter = WindowsAdapter::new().refusing_windows_of(process(own, None));
    let drag = |later: Vec<Vec<Option<u32>>>| {
        // Reads: the origin and the destination before anything, then the destination again
        // just before the button is let go.
        let facts = fake::PointerFacts {
            point: vec![Some(other)],
            foreground: vec![Some(other)],
            later_points: later,
            ..Default::default()
        };
        recorded_mouse(|| {
            fake::with(facts, || {
                adapter.drag(
                    DragParams {
                        from: Point { x: 5.0, y: 5.0 },
                        to: Point { x: 9.0, y: 9.0 },
                        duration_ms: Some(16),
                        drop_delay_ms: Some(16),
                    },
                    &lease(),
                )
            })
        })
    };
    // The release point is chosen from the facts at that moment (`drag_release_plan`); the plan
    // is put in place so this test is about the refusal and the result, not the desktop read.
    let refused = |later: Vec<Vec<Option<u32>>>, plan: crate::system::own_window::ReleasePlan| {
        crate::system::own_window::with_fake_release(plan, || drag(later))
    };
    let origin_plan = crate::system::own_window::ReleasePlan {
        target: Some(Point { x: 5.0, y: 5.0 }),
        label: "origin",
        sprint_coder_avoided: true,
    };
    let (result, flags) = refused(
        vec![vec![Some(other)], vec![Some(own)]],
        origin_plan.clone(),
    );
    let error = result.expect_err("the drop is refused");
    let details = error.details.as_ref().expect("details");
    assert_eq!(details["kind"], "own_window_refused");
    // Let go at the origin, which is verified not to be Sprint Coder's: nothing reached it.
    assert_eq!(details["dropped"], false);
    assert_eq!(details["button_released_at"], "origin");
    assert_eq!(details["physical_delivery_started"], true);
    // The button went down once and was let go once; it is never left held.
    assert_eq!(count_flag(&flags, MOUSEEVENTF_LEFTDOWN), 1);
    assert_eq!(count_flag(&flags, MOUSEEVENTF_LEFTUP), 1);
    assert_eq!(flags.last().copied(), Some(MOUSEEVENTF_LEFTUP));

    // The origin became Sprint Coder's too, so the button is let go at a verified safe point.
    let (result, _flags) = refused(
        vec![vec![Some(other)], vec![Some(own)]],
        crate::system::own_window::ReleasePlan {
            target: Some(Point { x: 1.0, y: 1.0 }),
            label: "safe_point",
            sprint_coder_avoided: true,
        },
    );
    let details = result.expect_err("refused").details.expect("details");
    assert_eq!(details["button_released_at"], "safe_point");
    assert_eq!(details["dropped"], false);

    // No point could be verified safe: the button is let go in place rather than held, and
    // whether anything reached Sprint Coder is unknown (`dropped` is null, not false).
    let (result, flags) = refused(
        vec![vec![Some(other)], vec![Some(own)]],
        crate::system::own_window::ReleasePlan {
            target: None,
            label: "in_place_unverified",
            sprint_coder_avoided: false,
        },
    );
    let details = result.expect_err("refused").details.expect("details");
    assert_eq!(details["button_released_at"], "in_place_unverified");
    assert!(details["dropped"].is_null());
    assert_eq!(count_flag(&flags, MOUSEEVENTF_LEFTUP), 1);

    // Unchanged, the drop is made.
    let (result, flags) = drag(Vec::new());
    assert!(result.is_ok(), "{result:?}");
    assert_eq!(count_flag(&flags, MOUSEEVENTF_LEFTUP), 1);
}

#[test]
fn choose_release_takes_the_origin_then_a_safe_edge_then_in_place() {
    use crate::system::own_window::choose_release;
    let p = |x: f64| Point { x, y: 0.0 };
    // The origin is safe: let go there.
    let plan = choose_release(&[(p(0.0), true), (p(1.0), true)]);
    assert_eq!(plan.target, Some(p(0.0)));
    assert_eq!(plan.label, "origin");
    assert!(plan.sprint_coder_avoided);
    // The origin is not, a later edge is: let go at that edge.
    let plan = choose_release(&[(p(0.0), false), (p(1.0), false), (p(2.0), true)]);
    assert_eq!(plan.target, Some(p(2.0)));
    assert_eq!(plan.label, "safe_point");
    assert!(plan.sprint_coder_avoided);
    // None is safe: in place, not held.
    let plan = choose_release(&[(p(0.0), false), (p(1.0), false)]);
    assert_eq!(plan.target, None);
    assert_eq!(plan.label, "in_place_unverified");
    assert!(!plan.sprint_coder_avoided);
}

#[cfg(target_os = "windows")]
#[test]
fn a_later_click_of_a_physical_ref_click_is_judged_again_too() {
    use crate::input::mouse::mouse_send::MOUSEEVENTF_LEFTDOWN;

    // `double-click` and `triple-click` on a ref send their clicks through the same sequence
    // (`physical_click::click_from_gate` -> `synthesize_mouse`), inside `execute_action`.
    let own = 500;
    let other = 7;
    let facts = fake::PointerFacts {
        point: vec![Some(other)],
        foreground: vec![Some(other)],
        later_points: vec![vec![Some(own)]],
        ..Default::default()
    };
    let (result, flags) = recorded_mouse(|| {
        fake::with(facts, || {
            // The part was judged by its owners; the point is read first here, before the
            // second click.
            let _ = fake::point(&fake::get().unwrap());
            while_acting(&process(own, None), "execute_action", || {
                crate::input::mouse::synthesize_mouse(
                    MouseEvent {
                        kind: MouseEventKind::Click { count: 2 },
                        point: Point { x: 5.0, y: 5.0 },
                        button: MouseButton::Left,
                        modifiers: Vec::new(),
                    },
                    Deadline::standard().unwrap(),
                )
            })
        })
    });
    let error = result.expect_err("refused");
    let details = error.details.as_ref().unwrap();
    assert_eq!(details["operation"], "execute_action");
    assert_eq!(details["clicks_sent"], 1);
    assert_eq!(count_flag(&flags, MOUSEEVENTF_LEFTDOWN), 1);
    // Outside an operation of the adapter nothing is judged.
    assert!(recheck_pointer(&Point { x: 5.0, y: 5.0 }, true).is_ok());
}
