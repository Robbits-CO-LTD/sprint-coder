// Added by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! A background click is not sent to a list item whose click brings its
//! window to the front.
//!
//! Measured on self-made windows that never activate themselves (Issue
//! #1197), with another app in front:
//!
//! - The items of a Win32 list box, list view or combo box list are served by
//!   UI Automation's client-side proxies, which run in this process, and their
//!   Invoke emulates a person's click. `click` on a WinForms `ListBox` item and
//!   on a `ListView` item (`InvokePattern.Invoke`) moved keyboard focus into
//!   the list and brought the window to the front, 3 times of 3, with the
//!   foreground locked too (`foreground_hold`): the call comes from this
//!   process, which holds the lock.
//! - A list item with no Invoke is clicked with
//!   `LegacyIAccessible.DoDefaultAction`. On an Electron page, that click on a
//!   `li` brought the window to the front after the call had returned, 2 times
//!   of 2, the lock held 300 ms longer included; on a WPF `ListBoxItem` it was
//!   seen once.
//!
//! `select` on the Win32 items (`SelectionItemPattern.Select`) left the
//! foreground alone, 3 times of 3, and so did `click` on the buttons, text
//! boxes and check boxes beside them. So a click that may not take the
//! foreground (no `--headed`) on such an item is refused before anything is
//! sent (`POLICY_DENIED`, not delivered), with the way to choose the item or
//! press the control inside it instead. The list control itself, an item of a
//! combo box that `win32_combo` chooses with the box's own messages, and a
//! list item with an Invoke of its own (served by its framework, not by a
//! Win32 proxy) are not affected. Other Win32 proxies (tree view, tab,
//! header, toolbar) were not measured and keep the path they had.

/// Whether a window class (its own, or the system class it is built on) is
/// a standard Win32 list whose items' Invoke takes the foreground: the
/// system list box, the combo box's drop-down list, the common-controls list
/// view, and the WinForms superclasses of the list box and the list view
/// (`WindowsForms10.LISTBOX.<app>`, `WindowsForms10.SysListView32.<app>`).
pub(crate) fn is_foreground_taking_list_class(class: &str) -> bool {
    let class = class.to_ascii_lowercase();
    matches!(class.as_str(), "listbox" | "combolbox" | "syslistview32")
        || class.starts_with("windowsforms10.listbox.")
        || class.starts_with("windowsforms10.syslistview32.")
}

/// UI Automation's `ListItem` control type.
const LIST_ITEM_CONTROL_TYPE: i32 = 50_007;

/// Whether a background click on an element is refused: an item of a list
/// above (`in_win32_list`), or a list item (`control_type`) the click would
/// reach through its default action because it has no Invoke. A control type
/// that could not be read (`None`) is not taken for a list item: the element
/// keeps the click path it had.
pub(crate) fn click_takes_foreground(
    in_win32_list: bool,
    control_type: Option<i32>,
    invoke_available: bool,
) -> bool {
    in_win32_list || (control_type == Some(LIST_ITEM_CONTROL_TYPE) && !invoke_available)
}

#[cfg(target_os = "windows")]
mod imp {
    use super::is_foreground_taking_list_class;
    use crate::tree::automation::automation_client;
    use crate::tree::element::UIAElement;
    use crate::tree::properties::property_ids::TreeProperty;
    use crate::tree::properties::read_one;
    use crate::tree::walk::walker_source::parent_step;
    use agent_desktop_core::{AdapterError, Deadline, InteractionPolicy};
    use windows::Win32::Foundation::HWND;

    /// How far up an item the climb looks for the list's own window: an item
    /// of a list view sits one or two levels below it (a group, a row).
    const MAX_CLIMB: usize = 4;

    /// Whether a background click on `element` is refused
    /// ([`super::click_takes_foreground`]). A read that fails keeps the click
    /// path the element had.
    pub(crate) fn background_click_takes_foreground(
        element: &UIAElement,
        invoke_available: bool,
        deadline: Deadline,
    ) -> Result<bool, AdapterError> {
        let in_win32_list = is_foreground_taking_list_item(element, deadline)?;
        let control_type = if in_win32_list || invoke_available {
            None
        } else {
            read_one(element, TreeProperty::ControlType).number()
        };
        Ok(super::click_takes_foreground(
            in_win32_list,
            control_type,
            invoke_available,
        ))
    }

    /// Whether `element` is an item (not the list itself) of a list whose
    /// items' Invoke takes the foreground. The climb stops at the first
    /// element with a window of its own. A read that fails ends the climb as
    /// "not such an item", which keeps the click path the element had.
    fn is_foreground_taking_list_item(
        element: &UIAElement,
        deadline: Deadline,
    ) -> Result<bool, AdapterError> {
        let client = automation_client()?;
        let Ok(walker) = client.get_raw_view_walker() else {
            return Ok(false);
        };
        let mut current = element.clone();
        for depth in 0..MAX_CLIMB {
            deadline.ensure_remaining()?;
            let Ok(handle) = current.0.get_native_window_handle() else {
                return Ok(false);
            };
            let hwnd: HWND = handle.into();
            if !hwnd.0.is_null() {
                // The element with the window is the list itself when the
                // climb has not moved: that is not an item.
                return Ok(depth > 0 && window_is_foreground_taking_list(hwnd.0 as isize));
            }
            match parent_step(&walker, &current) {
                Ok(Some(parent)) => current = parent,
                Ok(None) | Err(()) => return Ok(false),
            }
        }
        Ok(false)
    }

    fn window_is_foreground_taking_list(hwnd: isize) -> bool {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetClassNameW, RealGetWindowClassW};
        let mut own = [0u16; 128];
        let own_length = unsafe {
            GetClassNameW(
                hwnd as *mut std::ffi::c_void,
                own.as_mut_ptr(),
                own.len() as i32,
            )
        };
        let mut real = [0u16; 128];
        let real_length = unsafe {
            RealGetWindowClassW(
                hwnd as *mut std::ffi::c_void,
                real.as_mut_ptr(),
                real.len() as u32,
            )
        };
        let text = |buffer: &[u16], length: i64| {
            String::from_utf16_lossy(&buffer[..usize::try_from(length).unwrap_or(0)])
        };
        is_foreground_taking_list_class(&text(&own, i64::from(own_length)))
            || is_foreground_taking_list_class(&text(&real, i64::from(real_length)))
    }

    /// The refusal of a background click on such an item.
    pub(crate) fn background_click_refusal(policy: InteractionPolicy) -> AdapterError {
        AdapterError::policy_denied_for_policy(
            "Clicking this list item through its accessibility interface brings its window \
             to the front, so it is not done in the background",
            policy,
        )
        .with_suggestion(
            "To choose the item without taking the foreground, run 'select' on the same ref; \
             to press a button or link inside the item, use that control's ref from the \
             snapshot. Clicking the item as a person would takes the foreground: only with \
             --headed",
        )
        .with_details(serde_json::json!({
            "kind": "list_item_click_takes_foreground",
            "foreground_effect": true,
            "retryable": false,
        }))
    }
}

#[cfg(target_os = "windows")]
pub(crate) use imp::{background_click_refusal, background_click_takes_foreground};

#[cfg(test)]
#[path = "list_item_click_tests.rs"]
mod tests;
