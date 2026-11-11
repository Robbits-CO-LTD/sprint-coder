//! Choosing an item in a standard Win32 combo box so that its owner hears of it.
//!
//! The UI Automation proxy for the system `ComboBox` class writes a selection
//! with `CB_SETCURSEL` / `CB_SELECTSTRING` (`SelectionItem.Select`,
//! `Value.SetValue`). Neither message sends `CBN_SELCHANGE`, so the box shows
//! the new item while the dialog that owns it never learns of the change and
//! nothing the item controls happens. Invoking an item of the open drop-down
//! list instead goes through the proxy's click emulation, which brings the
//! window to the front and moves the keyboard focus into it.
//!
//! This module chooses the item with the box's own messages and then sends
//! the owner the `CBN_SELCHANGE` notification that a keyboard selection sends.
//! An open drop-down list is closed first with `CB_SHOWDROPDOWN`, which the box
//! reports to its owner as a dismissed list, as Esc would. No input is
//! synthesized and neither the focus nor the foreground window changes.
//!
//! The box is recognised by the system class its window is built on
//! (`RealGetWindowClassW`), so a toolkit's superclass of `ComboBox` counts
//! too. The selection is never written through the box's UI Automation
//! provider here, so the owner hears of it exactly once, whichever provider
//! serves the box. Owner-drawn boxes that keep no item text
//! (`CBS_OWNERDRAW*` without `CBS_HASSTRINGS`) cannot be matched by name here
//! and are left to the UI Automation path.

use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode};

pub(crate) const WIN32_COMBO_SELECT_LABEL: &str = "Win32ComboBox.SelectAndNotify";

/// Ancestors climbed from an item to its box: item, list, box, plus one spare.
const MAX_CLIMB: usize = 4;

const CBS_OWNERDRAWFIXED: u32 = 0x0010;
const CBS_OWNERDRAWVARIABLE: u32 = 0x0020;
const CBS_HASSTRINGS: u32 = 0x0200;
const CBN_SELCHANGE: u16 = 1;

/// What a window class says about the climb from an element to its box.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ComboClass {
    /// The box itself.
    Box,
    /// The drop-down list of a box; the box is further up.
    DropList,
    /// Any other window: the element does not belong to a Win32 combo box.
    Other,
}

pub(crate) fn classify_class(class: &str) -> ComboClass {
    if class.eq_ignore_ascii_case("ComboBox") {
        ComboClass::Box
    } else if class.eq_ignore_ascii_case("ComboLBox") {
        ComboClass::DropList
    } else {
        ComboClass::Other
    }
}

/// Whether the box keeps the text of its items, which is what
/// `CB_FINDSTRINGEXACT` compares.
pub(crate) fn keeps_item_text(style: u32) -> bool {
    style & (CBS_OWNERDRAWFIXED | CBS_OWNERDRAWVARIABLE) == 0 || style & CBS_HASSTRINGS != 0
}

/// How many items carry the requested text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ItemMatch {
    Missing,
    Unique(usize),
    Ambiguous,
}

/// `first` is `CB_FINDSTRINGEXACT` from the top; `again` is the same search
/// started after `first`, which wraps round to `first` when it is the only one.
pub(crate) fn classify_matches(first: isize, again: isize) -> ItemMatch {
    let Ok(index) = usize::try_from(first) else {
        return ItemMatch::Missing;
    };
    if again < 0 || again == first {
        ItemMatch::Unique(index)
    } else {
        ItemMatch::Ambiguous
    }
}

/// `WM_COMMAND`'s `wParam` for a box's `CBN_SELCHANGE`: the control id in the
/// low word, the notification code in the high word.
pub(crate) fn selchange_wparam(control_id: i32) -> usize {
    (usize::from(CBN_SELCHANGE) << 16) | usize::from(control_id as u16)
}

fn missing_item_error(chars: usize) -> AdapterError {
    AdapterError::new(
        ErrorCode::ElementNotFound,
        format!("No item of the combo box matched the requested value ({chars} chars)"),
    )
    .with_disposition(DeliverySemantics::not_delivered())
    .with_suggestion("Use find or snapshot to inspect the available items.")
}

fn ambiguous_item_error() -> AdapterError {
    AdapterError::ambiguous_target("Multiple items of the combo box share the requested text")
        .with_details(serde_json::json!({ "kind": "ambiguous_select_value" }))
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{
        AdapterError, ComboClass, DeliverySemantics, ErrorCode, ItemMatch, MAX_CLIMB,
        ambiguous_item_error, classify_class, classify_matches, keeps_item_text,
        missing_item_error, selchange_wparam,
    };
    use crate::actions::chain::{DeliveryOutcome, after_delivery};
    use crate::tree::automation::automation_client;
    use crate::tree::element::UIAElement;
    use crate::tree::walk::walker_source::parent_step;
    use agent_desktop_core::Deadline;
    use windows::Win32::Foundation::HWND;
    use windows_sys::Win32::Foundation::HWND as HWND_SYS;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, EnumThreadWindows, GWL_STYLE, GetClassNameW, GetDlgCtrlID, GetParent,
        GetWindowLongW, GetWindowThreadProcessId, RealGetWindowClassW, SMTO_ABORTIFHUNG,
        SendMessageTimeoutW, WM_COMMAND,
    };

    const CB_FINDSTRINGEXACT: u32 = 0x0158;
    const CB_GETCURSEL: u32 = 0x0147;
    const CB_SETCURSEL: u32 = 0x014E;
    const CB_SHOWDROPDOWN: u32 = 0x014F;
    const CB_GETDROPPEDSTATE: u32 = 0x0157;
    /// One message never waits longer than this, whatever the action budget.
    const MESSAGE_CAP_MS: u64 = 2_000;

    /// A standard Win32 combo box, by window handle.
    pub(crate) struct Win32Combo {
        hwnd: isize,
    }

    /// The Win32 combo box `element` is, or belongs to (its edit part, its
    /// drop-down list, or an item of that list). `None` for anything else.
    pub(crate) fn owning_combo(
        element: &UIAElement,
        deadline: Deadline,
    ) -> Result<Option<Win32Combo>, AdapterError> {
        let client = automation_client()?;
        let Ok(walker) = client.get_raw_view_walker() else {
            return Ok(None);
        };
        let mut current = element.clone();
        for _ in 0..MAX_CLIMB {
            deadline.ensure_remaining()?;
            let Ok(handle) = current.0.get_native_window_handle() else {
                return Ok(None);
            };
            let hwnd: HWND = handle.into();
            let hwnd = hwnd.0 as isize;
            if hwnd != 0 {
                match window_class(hwnd) {
                    ComboClass::Box => return Ok(Some(Win32Combo { hwnd })),
                    ComboClass::DropList => {
                        if let Some(owner) = box_of_list(hwnd) {
                            return Ok(Some(Win32Combo { hwnd: owner }));
                        }
                    }
                    ComboClass::Other => return Ok(None),
                }
            }
            match parent_step(&walker, &current) {
                Ok(Some(parent)) => current = parent,
                Ok(None) | Err(()) => return Ok(None),
            }
        }
        Ok(None)
    }

    #[repr(C)]
    struct ComboBoxInfo {
        size: u32,
        item: [i32; 4],
        button: [i32; 4],
        button_state: u32,
        combo: *mut std::ffi::c_void,
        edit: *mut std::ffi::c_void,
        list: *mut std::ffi::c_void,
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetComboBoxInfo(combo: *mut std::ffi::c_void, info: *mut ComboBoxInfo) -> i32;
    }

    /// The box a drop-down list belongs to. The list is a child of the
    /// desktop with no owner, and the UI Automation parent of a list item does
    /// not always lead back to the box, so the box is found among the windows
    /// of the list's thread: the one whose `GetComboBoxInfo` names this list.
    fn box_of_list(list: isize) -> Option<isize> {
        struct Search {
            list: isize,
            found: Option<isize>,
        }
        unsafe extern "system" fn visit_child(window: HWND_SYS, state: isize) -> i32 {
            let search = unsafe { &mut *(state as *mut Search) };
            if classify_class(&base_class_name(window as isize)) == ComboClass::Box {
                let mut info = ComboBoxInfo {
                    size: size_of::<ComboBoxInfo>() as u32,
                    item: [0; 4],
                    button: [0; 4],
                    button_state: 0,
                    combo: std::ptr::null_mut(),
                    edit: std::ptr::null_mut(),
                    list: std::ptr::null_mut(),
                };
                if unsafe { GetComboBoxInfo(window, &mut info) } != 0
                    && info.list as isize == search.list
                {
                    search.found = Some(window as isize);
                    return 0;
                }
            }
            1
        }
        unsafe extern "system" fn visit_top(window: HWND_SYS, state: isize) -> i32 {
            unsafe { EnumChildWindows(window, Some(visit_child), state) };
            let search = unsafe { &*(state as *const Search) };
            i32::from(search.found.is_none())
        }
        let thread = unsafe { GetWindowThreadProcessId(list as HWND_SYS, std::ptr::null_mut()) };
        if thread == 0 {
            return None;
        }
        let mut search = Search { list, found: None };
        unsafe { EnumThreadWindows(thread, Some(visit_top), &mut search as *mut Search as isize) };
        search.found
    }

    impl Win32Combo {
        /// Which item carries `text`, or `None` when the box keeps no item
        /// text to compare against.
        pub(crate) fn find_item(
            &self,
            text: &str,
            deadline: Deadline,
        ) -> Result<Option<ItemMatch>, AdapterError> {
            let style = unsafe { GetWindowLongW(self.window(), GWL_STYLE) } as u32;
            if !keeps_item_text(style) {
                return Ok(None);
            }
            let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
            let text_ptr = wide.as_ptr() as isize;
            let first = self.send(CB_FINDSTRINGEXACT, usize::MAX, text_ptr, deadline)?;
            if first < 0 {
                return Ok(Some(ItemMatch::Missing));
            }
            let again = self.send(CB_FINDSTRINGEXACT, first as usize, text_ptr, deadline)?;
            Ok(Some(classify_matches(first, again)))
        }

        /// Chooses the item carrying `text` and tells the owner, or `None`
        /// when the box keeps no item text.
        pub(crate) fn select_text(
            &self,
            text: &str,
            deadline: Deadline,
        ) -> Result<Option<DeliveryOutcome>, AdapterError> {
            match self.find_item(text, deadline)? {
                None => Ok(None),
                Some(ItemMatch::Missing) => Err(missing_item_error(text.chars().count())),
                Some(ItemMatch::Ambiguous) => Err(ambiguous_item_error()),
                Some(ItemMatch::Unique(index)) => self.select_index(index, deadline).map(Some),
            }
        }

        /// Whether `element` is the box itself rather than one of its parts.
        pub(crate) fn is_box(&self, element: &UIAElement) -> bool {
            element.0.get_native_window_handle().is_ok_and(|handle| {
                let hwnd: HWND = handle.into();
                hwnd.0 as isize == self.hwnd
            })
        }

        /// The position the box currently holds, `None` when nothing is
        /// selected.
        pub(crate) fn selected_index(
            &self,
            deadline: Deadline,
        ) -> Result<Option<usize>, AdapterError> {
            Ok(usize::try_from(self.send(CB_GETCURSEL, 0, 0, deadline)?).ok())
        }

        /// Closes an open drop-down list, selects `index`, and sends the owner
        /// `CBN_SELCHANGE`. Verified when the box then holds `index` with its
        /// list closed.
        pub(crate) fn select_index(
            &self,
            index: usize,
            deadline: Deadline,
        ) -> Result<DeliveryOutcome, AdapterError> {
            if self.send(CB_GETDROPPEDSTATE, 0, 0, deadline)? != 0 {
                self.send(CB_SHOWDROPDOWN, 0, 0, deadline)?;
            }
            let selected = self.send(CB_SETCURSEL, index, 0, deadline)?;
            if usize::try_from(selected).ok() != Some(index) {
                return Ok(DeliveryOutcome::NotDelivered);
            }
            self.notify_selection_change(deadline)
                .map_err(after_delivery)?;
            let held = self
                .send(CB_GETCURSEL, 0, 0, deadline)
                .map_err(after_delivery)?;
            let dropped = self
                .send(CB_GETDROPPEDSTATE, 0, 0, deadline)
                .map_err(after_delivery)?;
            Ok(DeliveryOutcome::from_delivery(
                true,
                usize::try_from(held).ok() == Some(index) && dropped == 0,
            ))
        }

        fn notify_selection_change(&self, deadline: Deadline) -> Result<(), AdapterError> {
            let window = self.window();
            let owner = unsafe { GetParent(window) };
            if owner.is_null() {
                return Err(AdapterError::new(
                    ErrorCode::ActionFailed,
                    "The combo box has no owner window to notify of the selection",
                ));
            }
            let id = unsafe { GetDlgCtrlID(window) };
            send_timeout(
                owner as isize,
                WM_COMMAND,
                selchange_wparam(id),
                self.hwnd,
                deadline,
            )
            .map(|_| ())
        }

        fn send(
            &self,
            message: u32,
            wparam: usize,
            lparam: isize,
            deadline: Deadline,
        ) -> Result<isize, AdapterError> {
            send_timeout(self.hwnd, message, wparam, lparam, deadline)
        }

        fn window(&self) -> *mut std::ffi::c_void {
            self.hwnd as *mut std::ffi::c_void
        }
    }

    fn send_timeout(
        hwnd: isize,
        message: u32,
        wparam: usize,
        lparam: isize,
        deadline: Deadline,
    ) -> Result<isize, AdapterError> {
        deadline.ensure_remaining()?;
        let timeout = deadline.remaining_ms().clamp(1, MESSAGE_CAP_MS);
        let mut answer: usize = 0;
        let sent = unsafe {
            SendMessageTimeoutW(
                hwnd as *mut std::ffi::c_void,
                message,
                wparam,
                lparam,
                SMTO_ABORTIFHUNG,
                u32::try_from(timeout).unwrap_or(u32::MAX),
                &mut answer,
            )
        };
        if sent == 0 {
            return Err(AdapterError::new(
                ErrorCode::AppUnresponsive,
                "The combo box did not answer a window message in time",
            )
            .with_platform_detail(format!("SendMessageTimeoutW(0x{message:04X}) failed"))
            .with_disposition(DeliverySemantics::uncertain()));
        }
        Ok(answer as isize)
    }

    /// How a window takes part in a combo box. The drop-down list is told by
    /// its own class name (`ComboLBox`; its base class is `ListBox`), the box
    /// by the system class it is built on.
    fn window_class(hwnd: isize) -> ComboClass {
        let mut buffer = [0u16; 64];
        let length = unsafe {
            GetClassNameW(
                hwnd as *mut std::ffi::c_void,
                buffer.as_mut_ptr(),
                buffer.len() as i32,
            )
        };
        let own = String::from_utf16_lossy(&buffer[..usize::try_from(length).unwrap_or(0)]);
        match classify_class(&own) {
            ComboClass::DropList => ComboClass::DropList,
            _ => classify_class(&base_class_name(hwnd)),
        }
    }

    /// The system class a window is built on: `RealGetWindowClassW` answers
    /// `ComboBox` for a toolkit's superclass of the box too, which runs the
    /// same window procedure and notifies its owner the same way.
    fn base_class_name(hwnd: isize) -> String {
        let mut buffer = [0u16; 64];
        let length = unsafe {
            RealGetWindowClassW(
                hwnd as *mut std::ffi::c_void,
                buffer.as_mut_ptr(),
                buffer.len() as u32,
            )
        };
        String::from_utf16_lossy(&buffer[..usize::try_from(length).unwrap_or(0)])
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::{AdapterError, ItemMatch};
    use crate::actions::chain::DeliveryOutcome;
    use crate::tree::element::UIAElement;
    use agent_desktop_core::Deadline;

    pub(crate) struct Win32Combo;

    pub(crate) fn owning_combo(
        _element: &UIAElement,
        _deadline: Deadline,
    ) -> Result<Option<Win32Combo>, AdapterError> {
        Ok(None)
    }

    impl Win32Combo {
        pub(crate) fn find_item(
            &self,
            _text: &str,
            _deadline: Deadline,
        ) -> Result<Option<ItemMatch>, AdapterError> {
            Ok(None)
        }

        pub(crate) fn select_text(
            &self,
            _text: &str,
            _deadline: Deadline,
        ) -> Result<Option<DeliveryOutcome>, AdapterError> {
            Ok(None)
        }

        pub(crate) fn is_box(&self, _element: &UIAElement) -> bool {
            false
        }

        pub(crate) fn selected_index(
            &self,
            _deadline: Deadline,
        ) -> Result<Option<usize>, AdapterError> {
            Ok(None)
        }

        pub(crate) fn select_index(
            &self,
            _index: usize,
            _deadline: Deadline,
        ) -> Result<DeliveryOutcome, AdapterError> {
            Ok(DeliveryOutcome::NotDelivered)
        }
    }
}

pub(crate) use imp::owning_combo;

#[cfg(test)]
#[path = "win32_combo_tests.rs"]
mod tests;

#[cfg(all(test, target_os = "windows"))]
#[path = "win32_combo_live_tests.rs"]
mod live_tests;
