//! Live checks against a real system combo box in a hidden window this test
//! process owns: no other window is touched, and nothing is shown.

use crate::actions::select::select_steps;
use crate::actions::value_write::set_value_steps;
use crate::actions::win32_combo::WIN32_COMBO_SELECT_LABEL;
use crate::system::fixture::test_time::deadline;
use crate::tree::automation::automation_client;
use crate::tree::element::UIAElement;
use crate::tree::fixture::ensure_test_apartment;
use crate::tree::fixture::fixture_window::{
    register_class_with_proc, unique_class_name, unregister_class, wide,
};
use agent_desktop_core::{ActionStepOutcome, ErrorCode, InteractionPolicy};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use uiautomation::patterns::UIValuePattern;
use uiautomation::types::Handle;
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, MSG,
    PostMessageW, PostQuitMessage, SendMessageW, TranslateMessage, WM_CLOSE, WM_COMMAND,
    WM_DESTROY, WS_CHILD, WS_OVERLAPPEDWINDOW, WS_VISIBLE, WS_VSCROLL,
};

const CB_ADDSTRING: u32 = 0x0143;
const CB_GETCURSEL: u32 = 0x0147;
const CBS_DROPDOWNLIST: u32 = 0x0003;
const CBS_HASSTRINGS: u32 = 0x0200;
const CBN_SELCHANGE: usize = 1;
const COMBO_ID: usize = 105;
const ITEMS: [&str; 4] = ["Alpha", "Beta", "Gamma", "Twin"];

/// `CBN_SELCHANGE` notifications the owner received, per test window. Each
/// test owns one window, so the count is keyed by the owner handle.
static NOTIFIED: std::sync::Mutex<Vec<(isize, usize)>> = std::sync::Mutex::new(Vec::new());
static NEXT_TOP: AtomicUsize = AtomicUsize::new(0);

unsafe extern "system" fn owner_proc(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_COMMAND && wparam >> 16 == CBN_SELCHANGE && wparam & 0xFFFF == COMBO_ID {
        let mut notified = NOTIFIED.lock().unwrap_or_else(|poison| poison.into_inner());
        if let Some(entry) = notified
            .iter_mut()
            .find(|(owner, _)| *owner == window as isize)
        {
            entry.1 += 1;
        }
        return 0;
    }
    if message == WM_DESTROY {
        unsafe { PostQuitMessage(0) };
        return 0;
    }
    unsafe { DefWindowProcW(window, message, wparam, lparam) }
}

struct ComboHost {
    owner: isize,
    combo: isize,
    class_name: String,
    pump: Option<std::thread::JoinHandle<()>>,
}

impl ComboHost {
    fn create(items: &[&'static str]) -> Self {
        let class_name = unique_class_name();
        let (ready, answer) = mpsc::channel();
        let thread_class = class_name.clone();
        let items = items.to_vec();
        let pump = std::thread::spawn(move || host(&thread_class, &items, ready));
        let (owner, combo) = answer.recv().expect("host").expect("host window");
        Self {
            owner,
            combo,
            class_name,
            pump: Some(pump),
        }
    }

    fn notified(&self) -> usize {
        NOTIFIED
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .iter()
            .find(|(owner, _)| *owner == self.owner)
            .map_or(0, |(_, count)| *count)
    }

    fn selected(&self) -> isize {
        unsafe { SendMessageW(self.combo as HWND, CB_GETCURSEL, 0, 0) }
    }

    fn element(&self) -> UIAElement {
        let client = automation_client().expect("client");
        UIAElement::from(
            client
                .element_from_handle(Handle::from(self.combo))
                .expect("combo element"),
        )
    }
}

impl Drop for ComboHost {
    fn drop(&mut self) {
        unsafe { PostMessageW(self.owner as HWND, WM_CLOSE, 0, 0) };
        if let Some(pump) = self.pump.take() {
            let _ = pump.join();
        }
        unregister_class(&self.class_name);
    }
}

fn host(
    class_name: &str,
    items: &[&'static str],
    ready: mpsc::Sender<Result<(isize, isize), String>>,
) {
    if let Err(error) = register_class_with_proc(class_name, owner_proc) {
        let _ = ready.send(Err(error));
        return;
    }
    let module = unsafe { GetModuleHandleW(std::ptr::null()) };
    let class = wide(class_name);
    let title = wide("win32 combo fixture");
    let top = 40 * NEXT_TOP.fetch_add(1, Ordering::SeqCst) as i32;
    // Never shown: the window stays hidden for the whole test.
    let owner = unsafe {
        CreateWindowExW(
            0,
            class.as_ptr(),
            title.as_ptr(),
            WS_OVERLAPPEDWINDOW,
            0,
            top,
            320,
            240,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            module,
            std::ptr::null(),
        )
    };
    let combo_class = wide("COMBOBOX");
    let empty = wide("");
    let combo = unsafe {
        CreateWindowExW(
            0,
            combo_class.as_ptr(),
            empty.as_ptr(),
            WS_CHILD | WS_VISIBLE | WS_VSCROLL | CBS_DROPDOWNLIST | CBS_HASSTRINGS,
            8,
            8,
            200,
            160,
            owner,
            COMBO_ID as _,
            module,
            std::ptr::null(),
        )
    };
    if owner.is_null() || combo.is_null() {
        let _ = ready.send(Err("CreateWindowExW produced no window".into()));
        return;
    }
    for item in items {
        let text = wide(item);
        unsafe { SendMessageW(combo, CB_ADDSTRING, 0, text.as_ptr() as LPARAM) };
    }
    NOTIFIED
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .push((owner as isize, 0));
    let _ = ready.send(Ok((owner as isize, combo as isize)));
    let mut message = MSG::default();
    while unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) } > 0 {
        unsafe { TranslateMessage(&message) };
        unsafe { DispatchMessageW(&message) };
    }
    unsafe { DestroyWindow(owner) };
}

#[test]
fn the_proxy_value_write_moves_the_selection_without_telling_the_owner() {
    ensure_test_apartment();
    let host = ComboHost::create(&ITEMS);
    let element = host.element();
    let pattern = element
        .0
        .get_pattern::<UIValuePattern>()
        .expect("the system proxy publishes Value on a drop-down list");
    pattern.set_value("Gamma").expect("proxy SetValue");
    assert_eq!(host.selected(), 2, "the proxy did move the selection");
    assert_eq!(
        host.notified(),
        0,
        "this is the defect: the owner never hears CBN_SELCHANGE"
    );
}

#[test]
fn select_chooses_the_item_and_tells_the_owner_once() {
    ensure_test_apartment();
    let host = ComboHost::create(&ITEMS);
    let steps = select_steps(&host.element(), "gamma", deadline(5_000)).expect("select");
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0].label(), WIN32_COMBO_SELECT_LABEL);
    assert!(matches!(steps[0].outcome, ActionStepOutcome::Succeeded));
    assert_eq!(steps[0].verified(), Some(true));
    assert_eq!(host.selected(), 2);
    assert_eq!(host.notified(), 1);
}

#[test]
fn select_of_a_missing_item_changes_nothing() {
    ensure_test_apartment();
    let host = ComboHost::create(&ITEMS);
    let error =
        select_steps(&host.element(), "zz-missing-item-zz", deadline(5_000)).expect_err("miss");
    assert_eq!(error.code, ErrorCode::ElementNotFound);
    assert!(!error.message.contains("zz-missing-item-zz"));
    assert_eq!(host.selected(), -1);
    assert_eq!(host.notified(), 0);
}

#[test]
fn select_of_a_duplicated_item_is_ambiguous_and_changes_nothing() {
    ensure_test_apartment();
    let host = ComboHost::create(&["Alpha", "Twin", "Beta", "Twin"]);
    let error = select_steps(&host.element(), "Twin", deadline(5_000)).expect_err("twins");
    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
    assert_eq!(host.selected(), -1);
    assert_eq!(host.notified(), 0);
}

#[test]
fn select_without_a_value_on_the_box_explains_how_to_ask() {
    ensure_test_apartment();
    let host = ComboHost::create(&ITEMS);
    let error = select_steps(&host.element(), "", deadline(5_000)).expect_err("no value");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert!(
        error
            .suggestion
            .as_deref()
            .is_some_and(|text| text.contains("select <item ref>"))
    );
    assert_eq!(host.notified(), 0);
}

#[test]
fn set_value_naming_an_item_chooses_it_and_tells_the_owner() {
    ensure_test_apartment();
    let host = ComboHost::create(&ITEMS);
    let steps = set_value_steps(
        &host.element(),
        "Beta",
        InteractionPolicy::headless(),
        deadline(5_000),
    )
    .expect("set-value");
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0].label(), WIN32_COMBO_SELECT_LABEL);
    assert_eq!(steps[0].verified(), Some(true));
    assert_eq!(host.selected(), 1);
    assert_eq!(host.notified(), 1);
}

#[test]
fn set_value_naming_no_item_says_no_item_was_chosen() {
    ensure_test_apartment();
    let host = ComboHost::create(&ITEMS);
    let steps = set_value_steps(
        &host.element(),
        "Zeta",
        InteractionPolicy::headless(),
        deadline(5_000),
    );
    if let Ok(steps) = steps {
        assert!(crate::actions::value_write::left_list_unchosen(&steps));
    }
    assert_eq!(host.notified(), 0);
}
