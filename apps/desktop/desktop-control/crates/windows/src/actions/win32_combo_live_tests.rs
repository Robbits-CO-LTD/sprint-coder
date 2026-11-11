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
/// Owners that, like an application refreshing its list, insert an item at
/// the top when told the drop-down list closed (`CBN_CLOSEUP`).
static INSERT_ON_CLOSEUP: std::sync::Mutex<Vec<isize>> = std::sync::Mutex::new(Vec::new());
const CBN_CLOSEUP: usize = 8;
const CB_INSERTSTRING: u32 = 0x014A;
const CB_FINDSTRINGEXACT: u32 = 0x0158;
const INSERTED: &str = "Aardvark";
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
    if message == WM_COMMAND && wparam >> 16 == CBN_CLOSEUP && wparam & 0xFFFF == COMBO_ID {
        let inserts = INSERT_ON_CLOSEUP
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .contains(&(window as isize));
        if inserts {
            let text = wide(INSERTED);
            unsafe { SendMessageW(lparam as HWND, CB_INSERTSTRING, 0, text.as_ptr() as LPARAM) };
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
        Self::create_styled(items, CBS_HASSTRINGS)
    }

    fn create_styled(items: &[&'static str], style: u32) -> Self {
        let class_name = unique_class_name();
        let (ready, answer) = mpsc::channel();
        let thread_class = class_name.clone();
        let items = items.to_vec();
        let pump = std::thread::spawn(move || host(&thread_class, &items, style, ready));
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
    style: u32,
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
            WS_CHILD | WS_VISIBLE | WS_VSCROLL | CBS_DROPDOWNLIST | style,
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

/// The UI Automation elements of the box's list items, in list order, reached
/// through the box the way a snapshot reaches them. The system proxy
/// publishes the items only while the drop-down list is open, so the list is
/// opened first (`CB_SHOWDROPDOWN`, which never activates a window); the
/// select under test closes it again.
fn list_items(host: &ComboHost) -> Vec<UIAElement> {
    unsafe { SendMessageW(host.combo as HWND, CB_SHOWDROPDOWN, 1, 0) };
    let client = automation_client().expect("client");
    let walker = client.get_raw_view_walker().expect("walker");
    // Only the box's own drop-down list is read: in the raw view the list's
    // siblings are the desktop's windows, which this test must not walk.
    let mut list = walker.get_first_child(&host.element().0).ok();
    for _ in 0..4 {
        match &list {
            Some(node) if node.get_classname().ok().as_deref() == Some("ComboLBox") => break,
            Some(node) => list = walker.get_next_sibling(node).ok(),
            None => break,
        }
    }
    let list = list.expect("the open list under the box");
    let mut items = Vec::new();
    let mut child = walker.get_first_child(&list).ok();
    while let Some(current) = child {
        assert!(items.len() < 64, "the list is small");
        child = walker.get_next_sibling(&current).ok();
        let element = UIAElement::from(current);
        if crate::actions::select_search::selection_item_available(&element) {
            items.push(element);
        }
    }
    items
}

const CB_SHOWDROPDOWN: u32 = 0x014F;

#[test]
fn an_item_ref_selects_that_very_item_even_when_its_text_is_shared() {
    ensure_test_apartment();
    let host = ComboHost::create(&["Alpha", "Twin", "Beta", "Twin"]);
    let items = list_items(&host);
    assert_eq!(items.len(), 4, "every list item is reachable");
    let steps = select_steps(&items[3], "", deadline(5_000)).expect("select by item ref");
    assert_eq!(steps[0].label(), WIN32_COMBO_SELECT_LABEL);
    assert_eq!(steps[0].verified(), Some(true));
    assert_eq!(host.selected(), 3, "the second Twin, not the first");
    assert_eq!(host.notified(), 1);
    let steps = select_steps(&items[1], "Twin", deadline(5_000)).expect("named self-match");
    assert_eq!(steps[0].verified(), Some(true));
    assert_eq!(host.selected(), 1, "the first Twin");
    assert_eq!(host.notified(), 2);
}

#[test]
fn a_click_on_an_item_ref_selects_that_very_item_even_when_its_text_is_shared() {
    use crate::actions::dispatch::execute_action_impl;
    use agent_desktop_core::{Action, actions::action_request::ActionRequest};
    ensure_test_apartment();
    let host = ComboHost::create(&["Twin", "Alpha", "Twin"]);
    let items = list_items(&host);
    assert_eq!(items.len(), 3);
    let lease = agent_desktop_core::InteractionLease::guarded(deadline(5_000), ()).expect("lease");
    let result = execute_action_impl(
        &items[2].clone().into_native_handle(),
        ActionRequest::headless(Action::Click),
        &lease,
    )
    .expect("click by item ref");
    assert_eq!(result.steps[0].label(), WIN32_COMBO_SELECT_LABEL);
    assert_eq!(host.selected(), 2);
    assert_eq!(host.notified(), 1);
}

impl ComboHost {
    fn insert_on_closeup(&self) {
        INSERT_ON_CLOSEUP
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .push(self.owner);
    }

    /// Whether the selected item carries `text`, asked of the box with the
    /// same search the code under test uses.
    fn selected_is(&self, text: &str) -> bool {
        let Ok(index) = usize::try_from(self.selected()) else {
            return false;
        };
        let text = wide(text);
        let found = unsafe {
            SendMessageW(
                self.combo as HWND,
                CB_FINDSTRINGEXACT,
                index.checked_sub(1).unwrap_or(usize::MAX),
                text.as_ptr() as LPARAM,
            )
        };
        usize::try_from(found).ok() == Some(index)
    }
}

#[test]
fn a_name_is_looked_up_again_when_closing_the_list_changes_the_items() {
    ensure_test_apartment();
    let host = ComboHost::create(&["Alpha", "Beta"]);
    host.insert_on_closeup();
    unsafe { SendMessageW(host.combo as HWND, CB_SHOWDROPDOWN, 1, 0) };
    let steps = select_steps(&host.element(), "Beta", deadline(5_000)).expect("select");
    assert_eq!(steps[0].label(), WIN32_COMBO_SELECT_LABEL);
    assert_eq!(
        host.selected(),
        2,
        "Beta moved down when Aardvark was added"
    );
    assert!(host.selected_is("Beta"));
    assert_eq!(steps[0].verified(), Some(true));
    assert_eq!(host.notified(), 1);
}

#[test]
fn an_item_ref_is_never_verified_on_an_item_that_moved_into_its_place() {
    ensure_test_apartment();
    let host = ComboHost::create(&["Alpha", "Beta"]);
    host.insert_on_closeup();
    let items = list_items(&host);
    assert_eq!(items.len(), 2);
    let steps = select_steps(&items[1], "", deadline(5_000)).expect("select by item ref");
    assert_eq!(steps[0].label(), WIN32_COMBO_SELECT_LABEL);
    assert!(
        steps[0].verified() != Some(true) || host.selected_is("Beta"),
        "verified only when the box really holds Beta"
    );
    if !host.selected_is("Beta") {
        assert_eq!(host.notified(), 0, "a different item is never confirmed");
    }
}

#[test]
fn the_check_of_an_item_reads_no_text_out_of_the_box() {
    ensure_test_apartment();
    let host = ComboHost::create(&["Alpha", "Beta", "Twin", "Twin"]);
    let element = host.element();
    let combo = crate::actions::win32_combo::owning_combo(&element, deadline(5_000))
        .expect("climb")
        .expect("the box");
    let check = |index, text| combo.carries(index, text, deadline(5_000)).expect("ask");
    assert!(check(0, "alpha"), "the first item, compared ignoring case");
    assert!(check(1, "Beta"));
    assert!(!check(1, "Alpha"));
    assert!(
        check(3, "Twin"),
        "the second twin is found at its own position"
    );
    assert!(!check(9, "Twin"), "no item there");
    assert_eq!(
        combo
            .positions_of("Twin", deadline(5_000))
            .expect("positions"),
        vec![2, 3]
    );
}

#[test]
fn an_item_ref_does_not_confirm_a_twin_that_moved_into_its_place() {
    ensure_test_apartment();
    let host = ComboHost::create(&["Twin", "Twin"]);
    host.insert_on_closeup();
    let items = list_items(&host);
    assert_eq!(items.len(), 2);
    let steps = select_steps(&items[1], "", deadline(5_000)).expect("select by item ref");
    assert_eq!(steps[0].label(), WIN32_COMBO_SELECT_LABEL);
    assert_ne!(
        steps[0].verified(),
        Some(true),
        "after Aardvark was added, position 1 is the first Twin"
    );
    assert_eq!(
        host.notified(),
        0,
        "no other item is confirmed to the owner"
    );
}

#[test]
fn an_owner_drawn_box_without_item_text_is_left_to_ui_automation() {
    const CBS_OWNERDRAWFIXED: u32 = 0x0010;
    ensure_test_apartment();
    let host = ComboHost::create_styled(&["Alpha", "Beta"], CBS_OWNERDRAWFIXED);
    unsafe { SendMessageW(host.combo as HWND, CB_SHOWDROPDOWN, 1, 0) };
    let element = host.element();
    let combo = crate::actions::win32_combo::owning_combo(&element, deadline(5_000))
        .expect("climb")
        .expect("the box");
    assert!(!combo.keeps_text());
    let items = list_items(&host);
    assert_eq!(items.len(), 2, "the proxy publishes the owner-drawn items");
    for item in items {
        assert!(
            crate::actions::select::win32_combo_select_item(&item, deadline(5_000))
                .expect("item path")
                .is_none(),
            "the Win32 path never takes a box it cannot check by text"
        );
    }
    assert_eq!(host.notified(), 0);
    unsafe { SendMessageW(host.combo as HWND, CB_SHOWDROPDOWN, 0, 0) };
}
