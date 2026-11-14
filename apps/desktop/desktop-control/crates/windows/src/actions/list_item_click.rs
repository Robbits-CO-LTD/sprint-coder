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
//! foreground alone, 3 times of 3. So a click that may not take the
//! foreground (no `--headed`) on such an item is refused before anything is
//! sent (`POLICY_DENIED`, not delivered), with the way to choose the item or
//! press the control inside it instead. The list control itself, an item of a
//! combo box that `win32_combo` chooses with the box's own messages, and a
//! list item with an Invoke of its own are not affected. Other Win32 proxies
//! (tree view, tab, header, toolbar) were not measured and keep the path
//! they had.
//!
//! The question is answered before the foreground is locked, each read
//! bounded by what is left of the action's deadline. A read that fails or
//! does not answer in time is "could not tell" ([`ClickCheck::Unread`]),
//! never "not such an item": that click is refused too, as an answer that may
//! be retried, while an element read as something else keeps its click path.

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

/// Whether a window class (its own, or its system class) is the Win32
/// button (push button, check box, radio button and their WinForms
/// superclasses, whose system class is `Button`).
pub(crate) fn is_win32_button_class(class: &str) -> bool {
    class.eq_ignore_ascii_case("button")
}

/// UI Automation's `ListItem` control type.
pub(crate) const LIST_ITEM_CONTROL_TYPE: i32 = 50_007;

/// What was read of the element's place under a Win32 list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ListRead {
    /// An item (not the list itself) of a list in
    /// [`is_foreground_taking_list_class`].
    Item,
    /// Read as anything else: the element, its parent or its grandparent
    /// has a window of another class, or none of them has a window (an item
    /// of a Win32 list always sits right under the list, or under a group of
    /// it), or the climb reached the top.
    NotItem,
    /// A read failed or did not answer in time.
    Unread,
}

/// What was read of the element's control type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TypeRead {
    Known(i32),
    /// The provider does not report it.
    Absent,
    /// The read failed or did not answer in time.
    Unread,
    /// Not asked: the answer could not change the decision.
    NotAsked,
}

/// The decision on a background click.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ClickCheck {
    Proceed,
    /// Read as a click that brings the window to the front.
    Refuse,
    /// Could not be told; refused as an answer that may be retried.
    Unread,
}

/// The decision, from what was read. Pure, so every way out is tested.
pub(crate) fn decide_click(list: ListRead, control_type: TypeRead, invoke: bool) -> ClickCheck {
    match list {
        ListRead::Item => ClickCheck::Refuse,
        ListRead::Unread => ClickCheck::Unread,
        ListRead::NotItem if invoke => ClickCheck::Proceed,
        ListRead::NotItem => match control_type {
            TypeRead::Known(LIST_ITEM_CONTROL_TYPE) => ClickCheck::Refuse,
            TypeRead::Known(_) | TypeRead::Absent => ClickCheck::Proceed,
            TypeRead::Unread | TypeRead::NotAsked => ClickCheck::Unread,
        },
    }
}

/// Whether `decide_click` needs the control type for this list answer.
pub(crate) fn needs_control_type(list: ListRead, invoke: bool) -> bool {
    list == ListRead::NotItem && !invoke
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{
        ClickCheck, ListRead, TypeRead, decide_click, is_foreground_taking_list_class,
        is_win32_button_class, needs_control_type,
    };
    use crate::actions::foreground_hold::ButtonRead;
    use crate::tree::automation::{automation_client, failure_of};
    use crate::tree::element::UIAElement;
    use crate::tree::properties::property_ids::TreeProperty;
    use crate::tree::properties::{PropertyOutcome, PropertyValue, read_one};
    use crate::tree::walk::walker_source::with_transaction_timeout;
    use agent_desktop_core::{AdapterError, Deadline, InteractionPolicy};
    use uiautomation::UIAutomation;
    use windows::Win32::Foundation::HWND;

    /// The elements the climb looks at: the element, its parent and its
    /// grandparent (an item of a list view may sit under a group).
    const CLIMB: usize = 3;

    /// The decision on a background click on `element`
    /// ([`super::decide_click`]).
    pub(crate) fn check_background_click(
        element: &UIAElement,
        invoke_available: bool,
        deadline: Deadline,
    ) -> ClickCheck {
        let Ok(client) = automation_client() else {
            return ClickCheck::Unread;
        };
        let list = read_list(&client, element, deadline);
        let control_type = if needs_control_type(list, invoke_available) {
            read_control_type(&client, element, deadline)
        } else {
            TypeRead::NotAsked
        };
        decide_click(list, control_type, invoke_available)
    }

    fn read_list(client: &UIAutomation, element: &UIAElement, deadline: Deadline) -> ListRead {
        let Some(Ok(walker)) =
            with_transaction_timeout(client, deadline, || client.get_raw_view_walker())
        else {
            return ListRead::Unread;
        };
        let mut current = element.clone();
        for depth in 0..CLIMB {
            let Some(handle) =
                with_transaction_timeout(client, deadline, || current.0.get_native_window_handle())
            else {
                return ListRead::Unread;
            };
            let Ok(handle) = handle else {
                return ListRead::Unread;
            };
            let hwnd: HWND = handle.into();
            if !hwnd.0.is_null() {
                // The element with the window is the list itself when the
                // climb has not moved: that is not an item.
                return if depth > 0
                    && classes_match(hwnd.0 as isize, is_foreground_taking_list_class)
                {
                    ListRead::Item
                } else {
                    ListRead::NotItem
                };
            }
            let Some(parent) =
                with_transaction_timeout(client, deadline, || walker.get_parent(&current.0))
            else {
                return ListRead::Unread;
            };
            match parent {
                Ok(parent) => current = UIAElement::from(parent),
                Err(error) if failure_of(&error).is_exhaustion() => return ListRead::NotItem,
                Err(_) => return ListRead::Unread,
            }
        }
        ListRead::NotItem
    }

    fn read_control_type(
        client: &UIAutomation,
        element: &UIAElement,
        deadline: Deadline,
    ) -> TypeRead {
        match with_transaction_timeout(client, deadline, || {
            read_one(element, TreeProperty::ControlType)
        }) {
            Some(PropertyOutcome::Known(PropertyValue::Number(number))) => TypeRead::Known(number),
            Some(PropertyOutcome::Absent) => TypeRead::Absent,
            _ => TypeRead::Unread,
        }
    }

    /// Whether `element`'s own window is a Win32 button, read within
    /// `deadline`.
    pub(crate) fn read_button(element: &UIAElement, deadline: Deadline) -> ButtonRead {
        let Ok(client) = automation_client() else {
            return ButtonRead::Unread;
        };
        match with_transaction_timeout(&client, deadline, || element.0.get_native_window_handle()) {
            Some(Ok(handle)) => {
                let hwnd: HWND = handle.into();
                if !hwnd.0.is_null() && classes_match(hwnd.0 as isize, is_win32_button_class) {
                    ButtonRead::Button
                } else {
                    ButtonRead::NotButton
                }
            }
            _ => ButtonRead::Unread,
        }
    }

    /// Whether the window's own class or its system class matches. Reads the
    /// window's class only; nothing is sent to the window.
    fn classes_match(hwnd: isize, matches: fn(&str) -> bool) -> bool {
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
        matches(&text(&own, i64::from(own_length))) || matches(&text(&real, i64::from(real_length)))
    }

    /// The refusal of a background click on such an item, or on one that
    /// could not be told (`check`).
    pub(crate) fn background_click_refusal(
        policy: InteractionPolicy,
        check: ClickCheck,
    ) -> AdapterError {
        if check == ClickCheck::Unread {
            return AdapterError::policy_denied_for_policy(
                "Whether clicking this element brings its window to the front could not be \
                 read in time, so it is not clicked in the background",
                policy,
            )
            .with_suggestion(
                "Nothing was sent. Try again; if it keeps failing, take a fresh snapshot. \
                 Clicking it as a person would takes the foreground: only with --headed",
            )
            .with_details(serde_json::json!({
                "kind": "list_item_click_unreadable",
                "foreground_effect": "unknown",
                "retryable": true,
            }));
        }
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
pub(crate) use imp::{background_click_refusal, check_background_click, read_button};

#[cfg(test)]
#[path = "list_item_click_tests.rs"]
mod tests;
