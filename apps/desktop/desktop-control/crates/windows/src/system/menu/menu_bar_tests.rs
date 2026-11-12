// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::*;

fn raw(text: Option<&str>, ftype: u32, fstate: u32) -> RawItem {
    RawItem {
        text: text.map(str::to_owned),
        ftype,
        fstate,
        has_bitmap: false,
    }
}

#[test]
fn a_raw_item_becomes_a_menu_item_with_its_state() {
    let plain = item_from_raw(&raw(Some("開く(&O)\tCtrl+O"), 0, 0));
    assert_eq!(plain.text.as_deref(), Some("開く(&O)\tCtrl+O"));
    assert!(!plain.disabled && !plain.checked && !plain.radio && !plain.owner_drawn);

    // MFS_GRAYED and MFS_DISABLED both set one of the two low bits.
    assert!(item_from_raw(&raw(Some("x"), 0, 0x1)).disabled);
    assert!(item_from_raw(&raw(Some("x"), 0, 0x2)).disabled);
    let radio = item_from_raw(&raw(Some("左(&L)"), MFT_RADIOCHECK, MFS_CHECKED));
    assert!(radio.checked && radio.radio);
    assert!(item_from_raw(&raw(None, MFT_SEPARATOR, 0x3)).separator);
}

#[test]
fn an_item_the_application_draws_has_no_readable_name() {
    let drawn = item_from_raw(&raw(Some("junk"), MFT_OWNERDRAW, 0));
    assert!(drawn.owner_drawn);
    assert_eq!(drawn.text, None);
    let picture = RawItem {
        has_bitmap: true,
        ..raw(None, 0, 0)
    };
    assert!(item_from_raw(&picture).owner_drawn);
    let icon_and_text = RawItem {
        has_bitmap: true,
        ..raw(Some("保存(&S)"), 0, 0)
    };
    assert!(!item_from_raw(&icon_and_text).owner_drawn);
}

#[test]
fn a_ref_name_matches_a_top_item_in_the_form_ui_automation_names_it() {
    let texts = vec![
        Some("ファイル(&F)".to_owned()),
        None,
        Some("&Help".to_owned()),
    ];
    assert!(names_top_item(&texts, "ファイル(F)"));
    assert!(names_top_item(&texts, "Help"));
    assert!(!names_top_item(&texts, "編集(E)"));
    assert!(!names_top_item(&texts, ""));
}

#[test]
fn a_window_without_a_menu_bar_is_refused_before_anything_is_sent() {
    let error = no_menu_bar_error();
    assert_eq!(error.code, ErrorCode::ElementNotFound);
    assert_eq!(
        error.disposition,
        agent_desktop_core::DeliverySemantics::not_delivered()
    );
    assert_eq!(error.details.unwrap()["kind"], "no_standard_menu_bar");
}

/// Reads the menu bar of a hidden window this test process creates: the read
/// goes through `GetMenu` and `GetMenuItemInfoW` as for another process's
/// window, and the window is never shown, so the foreground is not touched.
#[cfg(target_os = "windows")]
mod live {
    use super::*;
    use agent_desktop_core::ProcessId;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        AppendMenuW, CreateMenu, CreatePopupMenu, CreateWindowExW, DestroyWindow, MF_GRAYED,
        MF_OWNERDRAW, MF_POPUP, MF_SEPARATOR, MF_STRING, WS_OVERLAPPEDWINDOW,
    };

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    struct HiddenWindow(windows_sys::Win32::Foundation::HWND);
    impl Drop for HiddenWindow {
        fn drop(&mut self) {
            // SAFETY: the window this test created; destroying it frees its menu.
            unsafe { DestroyWindow(self.0) };
        }
    }

    fn window_with_menu(with_menu: bool) -> HiddenWindow {
        // SAFETY: plain menu and window creation on this thread.
        unsafe {
            let menu = if with_menu {
                let bar = CreateMenu();
                let file = CreatePopupMenu();
                AppendMenuW(file, MF_STRING, 1001, wide("開く(&O)...\tCtrl+O").as_ptr());
                AppendMenuW(
                    file,
                    MF_STRING | MF_GRAYED,
                    1003,
                    wide("無効の項目(&D)").as_ptr(),
                );
                AppendMenuW(file, MF_SEPARATOR, 0, std::ptr::null());
                let nest = CreatePopupMenu();
                AppendMenuW(nest, MF_STRING, 1201, wide("子 A(&A)").as_ptr());
                AppendMenuW(file, MF_POPUP, nest as usize, wide("入れ子(&N)").as_ptr());
                AppendMenuW(file, MF_OWNERDRAW, 1004, 0x1234 as *const u16);
                AppendMenuW(bar, MF_POPUP, file as usize, wide("ファイル(&F)").as_ptr());
                bar
            } else {
                std::ptr::null_mut()
            };
            let handle = CreateWindowExW(
                0,
                wide("STATIC").as_ptr(),
                wide("menu bar read test").as_ptr(),
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
            assert!(!handle.is_null(), "the hidden test window is created");
            HiddenWindow(handle)
        }
    }

    fn info(window: &HiddenWindow) -> WindowInfo {
        WindowInfo {
            id: format!("w-{}", window.0 as usize),
            title: String::new(),
            app: "test".to_owned(),
            pid: ProcessId::new(std::process::id()),
            process_instance: None,
            bounds: None,
            state: Default::default(),
        }
    }

    #[test]
    fn reads_the_whole_menu_bar_of_a_window_without_opening_it() {
        let window = window_with_menu(true);
        let bar = read_menu_bar(&info(&window), Deadline::after(2_000).unwrap()).unwrap();
        assert!(bar.complete);
        assert_eq!(bar.items.len(), 1);
        let file = &bar.items[0];
        assert_eq!(file.text.as_deref(), Some("ファイル(&F)"));
        let items = file.submenu.as_ref().expect("the File submenu is read");
        assert_eq!(items.len(), 5);
        assert_eq!(items[0].text.as_deref(), Some("開く(&O)...\tCtrl+O"));
        assert!(items[1].disabled);
        assert!(items[2].separator);
        let nested = items[3]
            .submenu
            .as_ref()
            .expect("the nested submenu is read");
        assert_eq!(nested[0].text.as_deref(), Some("子 A(&A)"));
        assert!(items[4].owner_drawn);
        assert_eq!(items[4].text, None);
    }

    #[test]
    fn a_window_without_a_menu_bar_is_refused() {
        let window = window_with_menu(false);
        let error = read_menu_bar(&info(&window), Deadline::after(2_000).unwrap()).unwrap_err();
        assert_eq!(error.code, ErrorCode::ElementNotFound);
    }

    #[test]
    fn a_window_of_another_process_id_is_refused() {
        let window = window_with_menu(true);
        let mut other = info(&window);
        other.pid = ProcessId::new(std::process::id().wrapping_add(1));
        let error = read_menu_bar(&other, Deadline::after(2_000).unwrap()).unwrap_err();
        assert_eq!(error.code, ErrorCode::WindowNotFound);
    }
}
