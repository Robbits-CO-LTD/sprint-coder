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

/// Runs menu item refs against a hidden window this test process creates.
/// Messages sent to it are answered on this thread at once (the window's
/// procedure is the system's static control); a posted command waits in this
/// thread's queue, where the test reads it back. The window is never shown.
#[cfg(target_os = "windows")]
mod live {
    use super::*;
    use agent_desktop_core::{ErrorCode, ProcessId};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        AppendMenuW, CreateMenu, CreatePopupMenu, CreateWindowExW, DestroyWindow, EnableMenuItem,
        GetMenu, GetSubMenu, InsertMenuW, MF_BYCOMMAND, MF_BYPOSITION, MF_GRAYED, MF_POPUP,
        MF_STRING, MSG, ModifyMenuW, PM_REMOVE, PeekMessageW, WM_COMMAND, WS_OVERLAPPEDWINDOW,
    };

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    struct Hidden(windows_sys::Win32::Foundation::HWND);
    impl Drop for Hidden {
        fn drop(&mut self) {
            drain(self);
            // SAFETY: the window this test created; destroying it frees its menu.
            unsafe { DestroyWindow(self.0) };
        }
    }

    /// File > 開く (1001), 上書き保存 (1002), 入れ子 > 子 A (1201); Help > About (3001).
    fn window() -> Hidden {
        // SAFETY: plain menu and window creation on this thread.
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
            let handle = CreateWindowExW(
                0,
                wide("STATIC").as_ptr(),
                wide("menu run test").as_ptr(),
                WS_OVERLAPPEDWINDOW,
                0,
                0,
                200,
                100,
                std::ptr::null_mut(),
                bar,
                std::ptr::null_mut(),
                std::ptr::null(),
            );
            assert!(!handle.is_null());
            Hidden(handle)
        }
    }

    fn info(window: &Hidden) -> WindowInfo {
        let pid = ProcessId::new(std::process::id());
        WindowInfo {
            id: format!("w-{}", window.0 as usize),
            title: String::new(),
            app: "test".to_owned(),
            pid,
            process_instance: crate::system::process_identity::token_for_pid(pid).unwrap(),
            bounds: None,
            state: Default::default(),
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

    /// The commands waiting in this thread's queue for the window.
    fn drain(window: &Hidden) -> Vec<usize> {
        let mut commands = Vec::new();
        let mut message: MSG = unsafe { std::mem::zeroed() };
        // SAFETY: reads and removes this thread's queued messages for the window.
        while unsafe { PeekMessageW(&mut message, window.0, 0, 0, PM_REMOVE) } != 0 {
            if message.message == WM_COMMAND {
                commands.push(message.wParam);
            }
        }
        commands
    }

    fn run(window: &WindowInfo, entry: &RefEntry) -> Result<ActionResult, AdapterError> {
        let deadline = Deadline::after(3_000).unwrap();
        let lease = InteractionLease::guarded(deadline, ()).unwrap();
        run_menu_command(entry, window, deadline, &lease)
    }

    fn file_menu(window: &Hidden) -> windows_sys::Win32::UI::WindowsAndMessaging::HMENU {
        // SAFETY: reads this test's own menu.
        unsafe { GetSubMenu(GetMenu(window.0), 0) }
    }

    #[test]
    fn a_recorded_item_is_run_by_posting_its_command() {
        let hidden = window();
        let window = info(&hidden);
        let result = run(
            &window,
            &entry(&window, &[("ファイル(F)", 0), ("上書き保存(S)", 1)], 1002),
        )
        .unwrap();
        assert_eq!(
            result.disposition(),
            DeliverySemantics::delivered_unverified()
        );
        assert_eq!(drain(&hidden), vec![1002]);
        let nested = entry(
            &window,
            &[("ファイル(F)", 0), ("入れ子(N)", 2), ("子 A(A)", 0)],
            1201,
        );
        run(&window, &nested).unwrap();
        assert_eq!(drain(&hidden), vec![1201]);
    }

    #[test]
    fn a_moved_item_that_reads_the_same_is_run_and_never_its_new_neighbour() {
        let hidden = window();
        let window = info(&hidden);
        // An item inserted above moves 上書き保存 from position 1 to 2.
        unsafe {
            InsertMenuW(
                file_menu(&hidden),
                0,
                MF_BYPOSITION | MF_STRING,
                1000,
                wide("新規(&N)").as_ptr(),
            )
        };
        run(
            &window,
            &entry(&window, &[("ファイル(F)", 0), ("上書き保存(S)", 1)], 1002),
        )
        .unwrap();
        assert_eq!(drain(&hidden), vec![1002]);
    }

    fn refused(window: &WindowInfo, hidden: &Hidden, entry: &RefEntry, reason: &str) {
        let error = run(window, entry).unwrap_err();
        assert_eq!(error.code, ErrorCode::StaleRef, "{error:?}");
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
        assert_eq!(error.details.unwrap()["reason"], reason);
        assert!(drain(hidden).is_empty(), "nothing may be posted");
    }

    #[test]
    fn an_item_disabled_renamed_or_sending_another_command_now_is_not_run() {
        let hidden = window();
        let window = info(&hidden);
        let save = entry(&window, &[("ファイル(F)", 0), ("上書き保存(S)", 1)], 1002);
        unsafe { EnableMenuItem(file_menu(&hidden), 1002, MF_BYCOMMAND | MF_GRAYED) };
        refused(&window, &hidden, &save, "disabled");
        unsafe {
            ModifyMenuW(
                file_menu(&hidden),
                1002,
                MF_BYCOMMAND | MF_STRING,
                1002,
                wide("名前を付けて保存(&A)").as_ptr(),
            )
        };
        refused(&window, &hidden, &save, "missing");
        unsafe {
            ModifyMenuW(
                file_menu(&hidden),
                1002,
                MF_BYCOMMAND | MF_STRING,
                1104,
                wide("上書き保存(&S)").as_ptr(),
            )
        };
        refused(&window, &hidden, &save, "command_changed");
    }

    #[test]
    fn a_twin_of_the_recorded_name_stops_the_run() {
        let hidden = window();
        let window = info(&hidden);
        unsafe {
            AppendMenuW(
                file_menu(&hidden),
                MF_STRING,
                1009,
                wide("上書き保存(S)").as_ptr(),
            )
        };
        let save = entry(&window, &[("ファイル(F)", 0), ("上書き保存(S)", 1)], 1002);
        refused(&window, &hidden, &save, "ambiguous");
    }

    #[test]
    fn a_window_of_another_process_or_with_no_menu_is_not_run() {
        let hidden = window();
        let window = info(&hidden);
        let save = entry(&window, &[("ファイル(F)", 0), ("上書き保存(S)", 1)], 1002);
        let mut other = window.clone();
        other.pid = ProcessId::new(std::process::id().wrapping_add(1));
        assert!(run(&other, &save).is_err());
        let mut stale = save.clone();
        stale.process.process_instance = Some("windows-proc-v1:1:1".to_owned());
        assert!(run(&window, &stale).is_err());
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::SetMenu(hidden.0, std::ptr::null_mut())
        };
        let error = run(&window, &save).unwrap_err();
        assert_eq!(error.details.unwrap()["reason"], "no_menu_bar");
        assert!(drain(&hidden).is_empty());
    }
}
