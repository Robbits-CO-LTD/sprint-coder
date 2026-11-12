// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::*;

#[test]
fn a_check_item_flips_and_a_radio_item_becomes_the_checked_one() {
    assert_eq!(expected_check(true, false), Some(false));
    assert_eq!(expected_check(false, true), Some(true));
    // An unchecked plain item may not be checkable, and a checked radio item
    // stays checked: neither change can be told, so neither is verified.
    assert_eq!(expected_check(false, false), None);
    assert_eq!(expected_check(true, true), None);
}

/// Runs menu item refs against hidden windows this test process creates, each
/// on a thread of its own with its own message loop, as another application's
/// window is: a message sent to it waits for that thread, and what reaches the
/// window is recorded in the order its procedure handles it. No window is
/// ever shown.
#[cfg(target_os = "windows")]
mod live {
    use super::*;
    use agent_desktop_core::{ErrorCode, ProcessId};
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        AppendMenuW, CheckMenuItem, CreateMenu, CreatePopupMenu, CreateWindowExW, DefWindowProcW,
        DestroyWindow, DispatchMessageW, EnableMenuItem, GetMenu, GetMessageW, GetSubMenu,
        InsertMenuW, MF_BYCOMMAND, MF_BYPOSITION, MF_CHECKED, MF_GRAYED, MF_POPUP, MF_STRING, MSG,
        ModifyMenuW, PostMessageW, PostQuitMessage, RegisterClassW, WM_APP, WM_CLOSE, WM_COMMAND,
        WM_DESTROY, WM_INITMENU, WM_INITMENUPOPUP, WM_UNINITMENUPOPUP, WNDCLASSW,
        WS_OVERLAPPEDWINDOW,
    };

    /// Keeps the window's thread busy for a while, as an application busy
    /// with something else is: its next message waits until then.
    const WM_BUSY: u32 = WM_APP + 1;

    /// What every test window handled: its handle, the message, `wParam`.
    static HANDLED: Mutex<Vec<(usize, u32, usize)>> = Mutex::new(Vec::new());
    /// The window that, on the next closing message it handles, posts itself
    /// `WM_BUSY`: so the application is busy right when the command arrives.
    static BUSY_AFTER_CLOSING: AtomicUsize = AtomicUsize::new(0);

    /// What a test window's application does to its menu while it is told the
    /// menu opens or closes. The old menu is kept alive, never destroyed.
    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    enum Change {
        /// Replaces the bar on `WM_INITMENU`.
        BarOnOpen(Variant),
        /// Replaces the File submenu on its `WM_INITMENUPOPUP`.
        SubmenuOnOpen(Variant),
        /// Replaces the bar on `WM_UNINITMENUPOPUP`.
        BarOnClose(Variant),
        /// Disables the window on `WM_UNINITMENUPOPUP`, as a dialog it opens would.
        DisableOnClose,
    }

    /// How 上書き保存 (1002) reads in the replacement File menu.
    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    enum Variant {
        Missing,
        Disabled,
        /// 1002 is another item, 全部削除.
        OtherItem,
    }

    static CHANGES: Mutex<Vec<(usize, Change)>> = Mutex::new(Vec::new());

    fn take_change(hwnd: usize, applies: impl Fn(Change) -> bool) -> Option<Change> {
        let mut changes = CHANGES.lock().unwrap();
        let at = changes
            .iter()
            .position(|(window, change)| *window == hwnd && applies(*change))?;
        Some(changes.remove(at).1)
    }

    unsafe fn replacement_file(
        variant: Variant,
    ) -> windows_sys::Win32::UI::WindowsAndMessaging::HMENU {
        // SAFETY: plain menu creation.
        unsafe {
            let file = CreatePopupMenu();
            AppendMenuW(file, MF_STRING, 1001, wide("開く(&O)...\tCtrl+O").as_ptr());
            match variant {
                Variant::Missing => {}
                Variant::Disabled => {
                    AppendMenuW(
                        file,
                        MF_STRING | MF_GRAYED,
                        1002,
                        wide("上書き保存(&S)\tCtrl+S").as_ptr(),
                    );
                }
                Variant::OtherItem => {
                    AppendMenuW(file, MF_STRING, 1002, wide("全部削除(&D)").as_ptr());
                }
            }
            file
        }
    }

    unsafe fn replacement_bar(
        variant: Variant,
    ) -> windows_sys::Win32::UI::WindowsAndMessaging::HMENU {
        // SAFETY: plain menu creation.
        unsafe {
            let bar = CreateMenu();
            AppendMenuW(
                bar,
                MF_POPUP,
                replacement_file(variant) as usize,
                wide("ファイル(&F)").as_ptr(),
            );
            bar
        }
    }

    unsafe extern "system" fn procedure(
        hwnd: HWND,
        message: u32,
        wparam: usize,
        lparam: isize,
    ) -> isize {
        if [
            WM_INITMENU,
            WM_INITMENUPOPUP,
            WM_UNINITMENUPOPUP,
            WM_COMMAND,
            WM_BUSY,
        ]
        .contains(&message)
        {
            HANDLED
                .lock()
                .unwrap()
                .push((hwnd as usize, message, wparam));
        }
        // SAFETY: changes to this test's own window and menus, on its own thread.
        unsafe {
            let window = hwnd as usize;
            match message {
                WM_INITMENU => {
                    if let Some(Change::BarOnOpen(variant)) =
                        take_change(window, |change| matches!(change, Change::BarOnOpen(_)))
                    {
                        windows_sys::Win32::UI::WindowsAndMessaging::SetMenu(
                            hwnd,
                            replacement_bar(variant),
                        );
                    }
                }
                WM_INITMENUPOPUP => {
                    if let Some(Change::SubmenuOnOpen(variant)) =
                        take_change(window, |change| matches!(change, Change::SubmenuOnOpen(_)))
                    {
                        let bar = GetMenu(hwnd);
                        // RemoveMenu keeps the old submenu alive, detached.
                        windows_sys::Win32::UI::WindowsAndMessaging::RemoveMenu(
                            bar,
                            0,
                            MF_BYPOSITION,
                        );
                        InsertMenuW(
                            bar,
                            0,
                            MF_BYPOSITION | MF_POPUP | MF_STRING,
                            replacement_file(variant) as usize,
                            wide("ファイル(&F)").as_ptr(),
                        );
                    }
                }
                WM_UNINITMENUPOPUP => {
                    match take_change(window, |change| {
                        matches!(change, Change::BarOnClose(_) | Change::DisableOnClose)
                    }) {
                        Some(Change::BarOnClose(variant)) => {
                            windows_sys::Win32::UI::WindowsAndMessaging::SetMenu(
                                hwnd,
                                replacement_bar(variant),
                            );
                        }
                        Some(Change::DisableOnClose) => {
                            windows_sys::Win32::UI::Input::KeyboardAndMouse::EnableWindow(hwnd, 0);
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        match message {
            // 3001 opens a modal dialog after a moment: the window is disabled
            // while a nested message loop runs, as a dialog's would.
            WM_COMMAND if wparam == 3001 => {
                std::thread::sleep(std::time::Duration::from_millis(200));
                // SAFETY: this test's own window and thread's messages.
                unsafe {
                    windows_sys::Win32::UI::Input::KeyboardAndMouse::EnableWindow(hwnd, 0);
                    let until = std::time::Instant::now() + std::time::Duration::from_millis(800);
                    let mut message: MSG = std::mem::zeroed();
                    while std::time::Instant::now() < until {
                        while windows_sys::Win32::UI::WindowsAndMessaging::PeekMessageW(
                            &mut message,
                            std::ptr::null_mut(),
                            0,
                            0,
                            windows_sys::Win32::UI::WindowsAndMessaging::PM_REMOVE,
                        ) != 0
                        {
                            // A dialog's loop hands the end of the thread's loop back,
                            // so the test window still closes when a test fails.
                            if message.message
                                == windows_sys::Win32::UI::WindowsAndMessaging::WM_QUIT
                            {
                                PostQuitMessage(0);
                                return 0;
                            }
                            DispatchMessageW(&message);
                        }
                        std::thread::sleep(std::time::Duration::from_millis(10));
                    }
                    windows_sys::Win32::UI::Input::KeyboardAndMouse::EnableWindow(hwnd, 1);
                }
                0
            }
            WM_UNINITMENUPOPUP
                if BUSY_AFTER_CLOSING
                    .compare_exchange(hwnd as usize, 0, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok() =>
            {
                // SAFETY: posts to this test's own window.
                unsafe { PostMessageW(hwnd, WM_BUSY, 0, 0) };
                0
            }
            WM_BUSY => {
                std::thread::sleep(std::time::Duration::from_millis(300));
                0
            }
            WM_COMMAND => 0,
            WM_DESTROY => {
                // SAFETY: ends this window's own message loop.
                unsafe { PostQuitMessage(0) };
                0
            }
            // SAFETY: the default handling of a message to this test's window.
            _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
        }
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    static CLASS: std::sync::Once = std::sync::Once::new();
    const CLASS_NAME: &str = "ScgMenuRunTestWindow";

    /// File > 開く (1001), 上書き保存 (1002), 入れ子 > 子 A (1201); Help > About (3001).
    unsafe fn test_menu() -> windows_sys::Win32::UI::WindowsAndMessaging::HMENU {
        // SAFETY: plain menu creation.
        unsafe {
            let bar = CreateMenu();
            let file = CreatePopupMenu();
            AppendMenuW(file, MF_STRING, 1001, wide("開く(&O)...\tCtrl+O").as_ptr());
            AppendMenuW(
                file,
                MF_STRING,
                1002,
                wide("上書き保存(&S)\tCtrl+S").as_ptr(),
            );
            let nest = CreatePopupMenu();
            AppendMenuW(nest, MF_STRING, 1201, wide("子 A(&A)").as_ptr());
            AppendMenuW(file, MF_POPUP, nest as usize, wide("入れ子(&N)").as_ptr());
            AppendMenuW(bar, MF_POPUP, file as usize, wide("ファイル(&F)").as_ptr());
            let help = CreatePopupMenu();
            AppendMenuW(help, MF_STRING, 3001, wide("バージョン情報(&A)").as_ptr());
            AppendMenuW(bar, MF_POPUP, help as usize, wide("ヘルプ(&H)").as_ptr());
            bar
        }
    }

    /// A hidden window on a thread of its own, closed and joined on drop.
    struct Remote {
        hwnd: usize,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl Remote {
        fn new(with_menu: bool) -> Self {
            let (sent, received) = std::sync::mpsc::channel();
            let thread = std::thread::spawn(move || {
                // SAFETY: class registration, window creation and the message
                // loop of this thread's own window.
                unsafe {
                    CLASS.call_once(|| {
                        let name = wide(CLASS_NAME);
                        let mut class: WNDCLASSW = std::mem::zeroed();
                        class.lpfnWndProc = Some(procedure);
                        class.lpszClassName = name.as_ptr();
                        RegisterClassW(&class);
                        std::mem::forget(name);
                    });
                    let menu = if with_menu {
                        test_menu()
                    } else {
                        std::ptr::null_mut()
                    };
                    let hwnd = CreateWindowExW(
                        0,
                        wide(CLASS_NAME).as_ptr(),
                        wide("menu run test").as_ptr(),
                        WS_OVERLAPPEDWINDOW,
                        0,
                        0,
                        200,
                        100,
                        std::ptr::null_mut(),
                        menu,
                        std::ptr::null_mut(),
                        std::ptr::null(),
                    );
                    sent.send(hwnd as usize).unwrap();
                    let mut message: MSG = std::mem::zeroed();
                    while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
                        DispatchMessageW(&message);
                    }
                }
            });
            let hwnd = received.recv().unwrap();
            assert_ne!(hwnd, 0, "the hidden test window is created");
            Self {
                hwnd,
                thread: Some(thread),
            }
        }

        fn handle(&self) -> HWND {
            self.hwnd as HWND
        }

        fn info(&self) -> WindowInfo {
            let pid = ProcessId::new(std::process::id());
            WindowInfo {
                id: format!("w-{}", self.hwnd),
                title: String::new(),
                app: "test".to_owned(),
                pid,
                process_instance: crate::system::process_identity::token_for_pid(pid).unwrap(),
                bounds: None,
                state: Default::default(),
            }
        }

        fn file_menu(&self) -> windows_sys::Win32::UI::WindowsAndMessaging::HMENU {
            // SAFETY: reads this test's own menu.
            unsafe { GetSubMenu(GetMenu(self.handle()), 0) }
        }

        /// What this window handled so far, in order.
        fn handled(&self) -> Vec<(u32, usize)> {
            HANDLED
                .lock()
                .unwrap()
                .iter()
                .filter(|(hwnd, _, _)| *hwnd == self.hwnd)
                .map(|(_, message, wparam)| (*message, *wparam))
                .collect()
        }

        /// The commands this window handled, once `count` of them arrived or
        /// after a short wait.
        fn commands(&self, count: usize) -> Vec<usize> {
            let until = std::time::Instant::now() + std::time::Duration::from_millis(2_000);
            loop {
                let commands: Vec<usize> = self
                    .handled()
                    .into_iter()
                    .filter(|(message, _)| *message == WM_COMMAND)
                    .map(|(_, wparam)| wparam)
                    .collect();
                if commands.len() >= count || std::time::Instant::now() > until {
                    return commands;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }

        /// Asserts that no command reached the window.
        fn assert_nothing_sent(&self) {
            std::thread::sleep(std::time::Duration::from_millis(200));
            assert!(self.commands(0).is_empty(), "nothing may be handed over");
        }
    }

    impl Drop for Remote {
        fn drop(&mut self) {
            // SAFETY: asks this test's own window to close; its thread ends its loop.
            unsafe { PostMessageW(self.handle(), WM_CLOSE, 0, 0) };
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    /// A menu item ref as `snapshot --surface menubar` records it.
    fn entry(window: &WindowInfo, steps: &[(&str, u32)], command_id: u32) -> RefEntry {
        let last = steps.len() - 1;
        let steps: Vec<serde_json::Value> = steps
            .iter()
            .enumerate()
            .map(|(index, (name, position))| {
                serde_json::json!({ "name": name, "position": position, "submenu": index != last })
            })
            .collect();
        serde_json::from_value(serde_json::json!({
            "pid": window.pid.get(),
            "process_instance": window.process_instance,
            "role": "menuitem",
            "name": steps[last]["name"],
            "proven_in_menu": { "steps": steps, "command_id": command_id },
            "bounds_hash": null,
            "available_actions": ["click"],
            "source_app": window.app,
            "source_window_id": window.id,
            "source_surface": "menubar",
        }))
        .unwrap()
    }

    fn save(window: &WindowInfo) -> RefEntry {
        entry(window, &[("ファイル(F)", 0), ("上書き保存(S)", 1)], 1002)
    }

    fn run(window: &WindowInfo, entry: &RefEntry) -> Result<ActionResult, AdapterError> {
        let deadline = Deadline::after(3_000).unwrap();
        let lease = InteractionLease::guarded(deadline, ()).unwrap();
        run_menu_command(entry, window, deadline, &lease)
    }

    #[test]
    fn a_recorded_item_is_run_by_handing_over_its_command() {
        let remote = Remote::new(true);
        let window = remote.info();
        let result = run(&window, &save(&window)).unwrap();
        assert_eq!(
            result.disposition(),
            DeliverySemantics::delivered_unverified()
        );
        assert_eq!(remote.commands(1), vec![1002]);
        let nested = entry(
            &window,
            &[("ファイル(F)", 0), ("入れ子(N)", 2), ("子 A(A)", 0)],
            1201,
        );
        run(&window, &nested).unwrap();
        assert_eq!(remote.commands(2), vec![1002, 1201]);
    }

    /// The command of one click reaches the window before the opening messages
    /// of the next, even while the application is too busy to take messages
    /// when the command is handed over: the command is a sent message, and a
    /// thread handles the messages sent to it in the order sent. A posted
    /// command would wait in the queue behind them.
    #[test]
    fn the_next_click_never_overtakes_the_command_of_the_one_before() {
        let remote = Remote::new(true);
        let window = remote.info();
        BUSY_AFTER_CLOSING.store(remote.hwnd, Ordering::SeqCst);
        run(&window, &save(&window)).unwrap();
        let open = entry(&window, &[("ファイル(F)", 0), ("開く(O)...", 0)], 1001);
        run(&window, &open).unwrap();
        assert_eq!(remote.commands(2), vec![1002, 1001]);
        let handled = remote.handled();
        let command = handled
            .iter()
            .position(|message| *message == (WM_COMMAND, 1002))
            .unwrap();
        let next_opening = handled
            .iter()
            .enumerate()
            .filter(|(_, (message, _))| *message == WM_INITMENU)
            .nth(1)
            .map(|(index, _)| index)
            .unwrap();
        assert!(
            command < next_opening,
            "the first command must be handled before the next click opens the menu: {handled:?}"
        );
        assert!(handled.contains(&(WM_BUSY, 0)), "the window was kept busy");
    }

    #[test]
    fn a_moved_item_that_reads_the_same_is_run_and_never_its_new_neighbour() {
        let remote = Remote::new(true);
        let window = remote.info();
        // An item inserted above moves 上書き保存 from position 1 to 2.
        unsafe {
            InsertMenuW(
                remote.file_menu(),
                0,
                MF_BYPOSITION | MF_STRING,
                1000,
                wide("新規(&N)").as_ptr(),
            )
        };
        run(&window, &save(&window)).unwrap();
        assert_eq!(remote.commands(1), vec![1002]);
    }

    fn refused(remote: &Remote, entry: &RefEntry, reason: &str) {
        let error = run(&remote.info(), entry).unwrap_err();
        assert_eq!(error.code, ErrorCode::StaleRef, "{error:?}");
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
        assert_eq!(error.details.unwrap()["reason"], reason);
        remote.assert_nothing_sent();
    }

    #[test]
    fn an_item_disabled_renamed_or_sending_another_command_now_is_not_run() {
        let remote = Remote::new(true);
        let save = save(&remote.info());
        unsafe { EnableMenuItem(remote.file_menu(), 1002, MF_BYCOMMAND | MF_GRAYED) };
        refused(&remote, &save, "disabled");
        unsafe {
            ModifyMenuW(
                remote.file_menu(),
                1002,
                MF_BYCOMMAND | MF_STRING,
                1002,
                wide("名前を付けて保存(&A)").as_ptr(),
            )
        };
        refused(&remote, &save, "missing");
        unsafe {
            ModifyMenuW(
                remote.file_menu(),
                1002,
                MF_BYCOMMAND | MF_STRING,
                1104,
                wide("上書き保存(&S)").as_ptr(),
            )
        };
        refused(&remote, &save, "command_changed");
    }

    #[test]
    fn a_twin_of_the_recorded_name_stops_the_run() {
        let remote = Remote::new(true);
        unsafe {
            AppendMenuW(
                remote.file_menu(),
                MF_STRING,
                1009,
                wide("上書き保存(S)").as_ptr(),
            )
        };
        refused(&remote, &save(&remote.info()), "ambiguous");
    }

    /// A checked item is read again after its command, from the menu only:
    /// the window is told its menu opens once, before the command, and never
    /// after it.
    #[test]
    fn after_the_command_nothing_more_is_sent_to_the_window() {
        let remote = Remote::new(true);
        let window = remote.info();
        unsafe { CheckMenuItem(remote.file_menu(), 1002, MF_BYCOMMAND | MF_CHECKED) };
        let result = run(&window, &save(&window)).unwrap();
        // Nothing here unchecks it, so the change cannot be seen: not verified.
        assert_eq!(
            result.disposition(),
            DeliverySemantics::delivered_unverified()
        );
        assert_eq!(remote.commands(1), vec![1002]);
        let handled: Vec<u32> = remote
            .handled()
            .into_iter()
            .map(|(message, _)| message)
            .collect();
        assert_eq!(
            handled,
            vec![
                WM_INITMENU,
                WM_INITMENUPOPUP,
                WM_UNINITMENUPOPUP,
                WM_COMMAND
            ]
        );
    }

    #[test]
    fn a_disabled_window_is_not_run() {
        let remote = Remote::new(true);
        let window = remote.info();
        // As a modal dialog the window opened leaves it.
        unsafe {
            windows_sys::Win32::UI::Input::KeyboardAndMouse::EnableWindow(remote.handle(), 0)
        };
        let error = run(&window, &save(&window)).unwrap_err();
        assert_eq!(error.code, ErrorCode::ActionFailed);
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
        assert_eq!(error.details.unwrap()["kind"], "window_disabled");
        remote.assert_nothing_sent();
        unsafe {
            windows_sys::Win32::UI::Input::KeyboardAndMouse::EnableWindow(remote.handle(), 1)
        };
        run(&window, &save(&window)).unwrap();
        assert_eq!(remote.commands(1), vec![1002]);
    }

    #[test]
    fn a_deadline_that_has_passed_sends_nothing() {
        let remote = Remote::new(true);
        let window = remote.info();
        let deadline = Deadline::after(1).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        let lease = InteractionLease::guarded(Deadline::after(1_000).unwrap(), ()).unwrap();
        let error = run_menu_command(&save(&window), &window, deadline, &lease).unwrap_err();
        assert_eq!(error.code, ErrorCode::Timeout);
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
        remote.assert_nothing_sent();
    }

    #[test]
    fn a_window_of_another_process_or_with_no_menu_is_not_run() {
        let remote = Remote::new(true);
        let window = remote.info();
        let mut other = window.clone();
        other.pid = ProcessId::new(std::process::id().wrapping_add(1));
        assert!(run(&other, &save(&window)).is_err());
        let mut stale = save(&window);
        stale.process.process_instance = Some("windows-proc-v1:1:1".to_owned());
        assert!(run(&window, &stale).is_err());
        remote.assert_nothing_sent();
        let bare = Remote::new(false);
        let error = run(&bare.info(), &save(&bare.info())).unwrap_err();
        assert_eq!(error.details.unwrap()["reason"], "no_menu_bar");
        bare.assert_nothing_sent();
    }

    fn change(remote: &Remote, change: Change) {
        CHANGES.lock().unwrap().push((remote.hwnd, change));
    }

    /// The application swaps its menu (the bar, or the File submenu) while it
    /// is told the menu opens or closes, and keeps the old one alive: matching
    /// the detached menu would succeed, while the window shows one where
    /// 上書き保存 is gone, disabled, or 1002 is another item. Nothing is sent.
    #[test]
    fn a_menu_the_application_replaced_while_told_is_never_run() {
        for replaced in [
            Change::BarOnOpen(Variant::Missing),
            Change::BarOnOpen(Variant::Disabled),
            Change::BarOnOpen(Variant::OtherItem),
            Change::SubmenuOnOpen(Variant::Missing),
            Change::SubmenuOnOpen(Variant::Disabled),
            Change::SubmenuOnOpen(Variant::OtherItem),
            Change::BarOnClose(Variant::OtherItem),
        ] {
            let remote = Remote::new(true);
            let window = remote.info();
            change(&remote, replaced);
            let error = run(&window, &save(&window)).unwrap_err();
            assert_eq!(error.code, ErrorCode::StaleRef, "{replaced:?}: {error:?}");
            assert_eq!(error.disposition, DeliverySemantics::not_delivered());
            assert_eq!(
                error.details.unwrap()["reason"],
                "menu_replaced",
                "{replaced:?}"
            );
            remote.assert_nothing_sent();
        }
    }

    /// The window is checked once more right before the command: one disabled
    /// by the closing messages (a dialog the application opened then) gets
    /// nothing.
    #[test]
    fn a_window_disabled_while_the_menu_closes_gets_no_command() {
        let remote = Remote::new(true);
        let window = remote.info();
        change(&remote, Change::DisableOnClose);
        let error = run(&window, &save(&window)).unwrap_err();
        assert_eq!(error.details.unwrap()["kind"], "window_disabled");
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
        remote.assert_nothing_sent();
    }

    /// A command that opens a modal dialog, handed over but not yet handled,
    /// and at once the next click: its opening messages wait behind the
    /// command, the dialog then disables the window, and the next click stops
    /// before its own command.
    #[test]
    fn the_click_after_a_command_that_opens_a_dialog_runs_nothing() {
        let remote = Remote::new(true);
        let window = remote.info();
        let about = entry(&window, &[("ヘルプ(H)", 1), ("バージョン情報(A)", 0)], 3001);
        run(&window, &about).unwrap();
        let error = run(&window, &save(&window)).unwrap_err();
        assert!(
            [ErrorCode::ActionFailed, ErrorCode::AppUnresponsive].contains(&error.code),
            "{error:?}"
        );
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
        std::thread::sleep(std::time::Duration::from_millis(1_200));
        assert_eq!(remote.commands(1), vec![3001], "only the first command ran");
    }

    /// A window of the calling thread would run the handler inside the call
    /// itself, so it is refused before anything is sent.
    #[test]
    fn a_window_of_this_thread_is_refused() {
        unsafe {
            let hwnd = CreateWindowExW(
                0,
                wide("STATIC").as_ptr(),
                wide("same thread").as_ptr(),
                WS_OVERLAPPEDWINDOW,
                0,
                0,
                200,
                100,
                std::ptr::null_mut(),
                test_menu(),
                std::ptr::null_mut(),
                std::ptr::null(),
            );
            let pid = ProcessId::new(std::process::id());
            let window = WindowInfo {
                id: format!("w-{}", hwnd as usize),
                title: String::new(),
                app: "test".to_owned(),
                pid,
                process_instance: crate::system::process_identity::token_for_pid(pid).unwrap(),
                bounds: None,
                state: Default::default(),
            };
            let error = run(&window, &save(&window)).unwrap_err();
            assert_eq!(error.details.unwrap()["kind"], "menu_window_same_thread");
            DestroyWindow(hwnd);
        }
    }
}
