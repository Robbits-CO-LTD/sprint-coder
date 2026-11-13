// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! Reads a window's own Win32 menu bar (the `HMENU` `GetMenu` returns)
//! without opening it.
//!
//! A standard menu bar opens only while its window is in front, so from
//! behind it the UI Automation tree shows only its top items, which refuse to
//! open. The menu itself can be read from another process at any time:
//! `GetMenuItemInfoW` returns each item's text, state and submenu. Nothing is
//! sent to the application - not even `WM_INITMENU`/`WM_INITMENUPOPUP`, which
//! an opening menu sends first: measured on 7-Zip File Manager, those
//! messages rebuild its menus (items added and removed) and the change stays
//! after the read, so a read that sent them would change what the
//! application holds. States are therefore as the application last set them.

use agent_desktop_core::{
    AdapterError, Deadline, ErrorCode, MenuBarKind, NativeMenuBar, NativeMenuItem, RefEntry,
    WindowInfo,
};

/// The most levels of submenus read below the bar. Real menus go three or
/// four deep; the cap stops a menu that lists itself as its own submenu.
const MAX_MENU_DEPTH: usize = 16;

/// The most items read in all, the cap an observation of a window has.
const MAX_MENU_ITEMS: usize = 50_000;

/// The most items read from one menu.
const MAX_ITEMS_PER_MENU: usize = 4_096;

/// One item as `GetMenuItemInfoW` returned it, before it becomes a
/// [`NativeMenuItem`]; kept platform-neutral so the conversion is testable.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct RawItem {
    pub(crate) text: Option<String>,
    pub(crate) ftype: u32,
    pub(crate) fstate: u32,
    pub(crate) has_bitmap: bool,
    /// The item's identifier (wID): the command it sends, or, for an item
    /// that opens a submenu, a value with no meaning.
    pub(crate) id: u32,
}

const MFT_BITMAP: u32 = 0x0004;
const MFT_OWNERDRAW: u32 = 0x0100;
const MFT_RADIOCHECK: u32 = 0x0200;
const MFT_SEPARATOR: u32 = 0x0800;
const MFS_DISABLED: u32 = 0x0003;
const MFS_CHECKED: u32 = 0x0008;

/// The item a raw read describes, without its submenu.
pub(crate) fn item_from_raw(raw: &RawItem) -> NativeMenuItem {
    let owner_drawn = raw.ftype & MFT_OWNERDRAW != 0;
    let picture = raw.ftype & MFT_BITMAP != 0;
    let text = raw
        .text
        .clone()
        .filter(|text| !owner_drawn && !picture && !text.is_empty());
    NativeMenuItem {
        owner_drawn: owner_drawn
            || (picture && text.is_none())
            || (raw.has_bitmap && text.is_none()),
        text,
        separator: raw.ftype & MFT_SEPARATOR != 0,
        disabled: raw.fstate & MFS_DISABLED != 0,
        checked: raw.fstate & MFS_CHECKED != 0,
        radio: raw.ftype & MFT_RADIOCHECK != 0,
        command_id: raw.id,
        in_notify_by_position_menu: false,
        notify_style_unread: false,
        submenu: None,
        submenu_unread: false,
    }
}

/// Whether a saved ref's name is one of the bar's top items' names.
pub(crate) fn names_top_item(bar_texts: &[Option<String>], name: &str) -> bool {
    let name = name.trim();
    !name.is_empty()
        && bar_texts
            .iter()
            .flatten()
            .any(|text| agent_desktop_core::menu_item_name(text) == name)
}

/// The refusal for a window whose menus are not a standard menu bar.
pub(crate) fn no_menu_bar_error() -> AdapterError {
    AdapterError::new(
        ErrorCode::ElementNotFound,
        "This window has no standard Windows menu bar",
    )
    .with_suggestion(
        "Its menus, if it has any, are drawn by the application itself (Qt and other toolkits \
         draw their own), so their items cannot be listed, opened or run from behind the window. \
         A snapshot of the window shows only what the window shows now (such as the top items \
         of its menu bar); opening a menu needs an operation that brings the window to the \
         front.",
    )
    .with_details(serde_json::json!({ "kind": "no_standard_menu_bar" }))
    .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered())
}

#[cfg(target_os = "windows")]
mod live {
    use super::*;
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetMenu, GetMenuInfo, GetMenuItemCount, GetMenuItemInfoW, GetWindowThreadProcessId, HMENU,
        IsMenu, IsWindow, MENUINFO, MENUITEMINFOW, MIIM_BITMAP, MIIM_FTYPE, MIIM_ID, MIIM_STATE,
        MIIM_STRING, MIIM_SUBMENU, MIM_STYLE, MNS_NOTIFYBYPOS,
    };

    use crate::system::window::window_ops::parse_window_id;

    /// The bar of the window `window_id` names, when that window still
    /// belongs to process `pid`.
    pub(crate) fn bar_of(window_id: &str, pid: u32) -> Result<Option<HMENU>, AdapterError> {
        let handle = parse_window_id(window_id)? as HWND;
        let mut owner = 0u32;
        // SAFETY: plain reads of a window handle that may be stale; both
        // answer "no window" for one that no longer exists.
        let alive = unsafe { IsWindow(handle) } != 0
            && unsafe { GetWindowThreadProcessId(handle, &mut owner) } != 0;
        if !alive || owner != pid {
            return Err(AdapterError::new(
                ErrorCode::WindowNotFound,
                "The window is gone or now belongs to another process",
            )
            .with_suggestion("Run 'list-windows' to see available window IDs.")
            .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered()));
        }
        // SAFETY: `GetMenu` of a top-level window returns its menu bar or
        // null; `IsMenu` rejects a value that is not a menu.
        let menu = unsafe { GetMenu(handle) };
        Ok((!menu.is_null() && unsafe { IsMenu(menu) } != 0).then_some(menu))
    }

    fn read_raw(menu: HMENU, position: u32) -> Option<(RawItem, HMENU)> {
        let mut info: MENUITEMINFOW = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<MENUITEMINFOW>() as u32;
        info.fMask = MIIM_FTYPE | MIIM_STATE | MIIM_SUBMENU | MIIM_STRING | MIIM_BITMAP | MIIM_ID;
        // SAFETY: the first call has a null buffer and only reports the text's
        // length in `cch`.
        if unsafe { GetMenuItemInfoW(menu, position, 1, &mut info) } == 0 {
            return None;
        }
        let length = info.cch as usize;
        let text = if length > 0 && info.fType & (MFT_OWNERDRAW | MFT_BITMAP | MFT_SEPARATOR) == 0 {
            let mut buffer = vec![0u16; length + 1];
            info.dwTypeData = buffer.as_mut_ptr();
            info.cch = (length + 1) as u32;
            // SAFETY: the buffer holds `cch` UTF-16 units, as the call is told.
            if unsafe { GetMenuItemInfoW(menu, position, 1, &mut info) } == 0 {
                return None;
            }
            let written = (info.cch as usize).min(length);
            Some(String::from_utf16_lossy(&buffer[..written]))
        } else {
            None
        };
        Some((
            RawItem {
                text,
                ftype: info.fType,
                fstate: info.fState,
                has_bitmap: !info.hbmpItem.is_null(),
                id: info.wID,
            },
            info.hSubMenu,
        ))
    }

    struct Budget {
        left: usize,
        deadline: Deadline,
        complete: bool,
    }

    /// Whether the menu reports its items by position (`MNS_NOTIFYBYPOS`)
    /// instead of sending their commands; `None` when its style cannot be
    /// read, which no item is run under.
    pub(crate) fn notifies_by_position(menu: HMENU) -> Option<bool> {
        let mut info: MENUINFO = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<MENUINFO>() as u32;
        info.fMask = MIM_STYLE;
        // SAFETY: a plain read into a sized struct.
        let read = unsafe { GetMenuInfo(menu, &mut info) };
        (read != 0).then_some(info.dwStyle & MNS_NOTIFYBYPOS != 0)
    }

    /// Marks how the item's menu reports a chosen item, as read.
    fn mark_style(item: &mut NativeMenuItem, notify: Option<bool>) {
        item.in_notify_by_position_menu = notify == Some(true);
        item.notify_style_unread = notify.is_none();
    }

    /// One level of a menu: each item without its submenu (an item that
    /// opens one is marked `submenu_unread`), with the submenu's handle;
    /// `None` when an item cannot be read or the menu is longer than any read
    /// takes.
    pub(crate) fn read_level(menu: HMENU) -> Option<Vec<(NativeMenuItem, HMENU)>> {
        // SAFETY: as in `read_menu`.
        let count = usize::try_from(unsafe { GetMenuItemCount(menu) }).ok()?;
        if count > MAX_ITEMS_PER_MENU {
            return None;
        }
        let notify = notifies_by_position(menu);
        let mut items = Vec::with_capacity(count);
        for position in 0..count {
            let (raw, submenu) = read_raw(menu, position as u32)?;
            let mut item = item_from_raw(&raw);
            mark_style(&mut item, notify);
            if !submenu.is_null() {
                item.submenu_unread = true;
                item.command_id = 0;
            }
            items.push((item, submenu));
        }
        Some(items)
    }

    fn read_menu(menu: HMENU, depth: usize, budget: &mut Budget) -> Vec<NativeMenuItem> {
        let notify = notifies_by_position(menu);
        // SAFETY: `menu` came from `GetMenu` or `GetMenuItemInfoW`; a menu
        // destroyed meanwhile answers -1.
        let count = unsafe { GetMenuItemCount(menu) };
        let count = usize::try_from(count).unwrap_or(0);
        if count > MAX_ITEMS_PER_MENU {
            budget.complete = false;
        }
        let mut items = Vec::new();
        for position in 0..count.min(MAX_ITEMS_PER_MENU) {
            if budget.left == 0 || budget.deadline.is_expired() {
                budget.complete = false;
                break;
            }
            budget.left -= 1;
            let Some((raw, submenu)) = read_raw(menu, position as u32) else {
                budget.complete = false;
                continue;
            };
            let mut item = item_from_raw(&raw);
            mark_style(&mut item, notify);
            if !submenu.is_null() {
                item.command_id = 0;
                if depth + 1 >= MAX_MENU_DEPTH || budget.left == 0 || budget.deadline.is_expired() {
                    item.submenu_unread = true;
                    budget.complete = false;
                } else {
                    item.submenu = Some(read_menu(submenu, depth + 1, budget));
                }
            }
            items.push(item);
        }
        items
    }

    pub(crate) fn read_menu_bar(
        window: &WindowInfo,
        deadline: Deadline,
    ) -> Result<NativeMenuBar, AdapterError> {
        if window.is_process_owner() {
            return Err(AdapterError::app_has_no_window(&window.app));
        }
        let Some(bar) = bar_of(&window.id, window.pid.get())? else {
            return Err(no_menu_bar_error());
        };
        let mut budget = Budget {
            left: MAX_MENU_ITEMS,
            deadline,
            complete: true,
        };
        let items = read_menu(bar, 0, &mut budget);
        let handle = crate::system::window::window_ops::parse_window_id(&window.id)?;
        // SAFETY: a plain read of a window handle.
        let window_disabled = unsafe {
            windows_sys::Win32::UI::Input::KeyboardAndMouse::IsWindowEnabled(
                handle as *mut std::ffi::c_void,
            )
        } == 0;
        Ok(NativeMenuBar {
            items,
            complete: budget.complete,
            window_disabled,
        })
    }

    pub(crate) fn menu_bar_kind(entry: &RefEntry) -> MenuBarKind {
        let Some(window_id) = entry.source.source_window_id.as_deref() else {
            return MenuBarKind::Unknown;
        };
        let bar = match bar_of(window_id, entry.process.pid.get()) {
            Ok(Some(bar)) => bar,
            Ok(None) => return MenuBarKind::NotStandard,
            Err(_) => return MenuBarKind::Unknown,
        };
        let Some(name) = entry.identity.name.as_deref() else {
            return MenuBarKind::Unknown;
        };
        // SAFETY: as in `read_menu`.
        let count = usize::try_from(unsafe { GetMenuItemCount(bar) }).unwrap_or(0);
        let top: Vec<(RawItem, HMENU)> = (0..count.min(MAX_ITEMS_PER_MENU))
            .filter_map(|position| read_raw(bar, position as u32))
            .collect();
        let texts: Vec<Option<String>> = top.iter().map(|(raw, _)| raw.text.clone()).collect();
        if !names_top_item(&texts, name) {
            return MenuBarKind::Unknown;
        }
        // The menus the named top items open, read one level, quietly: when
        // the application draws every item of them itself (Tcl/Tk does), none
        // can be read or run from the menubar surface.
        let mut drawn = top
            .iter()
            .filter(|(raw, _)| {
                raw.text
                    .as_deref()
                    .is_some_and(|text| agent_desktop_core::menu_item_name(text) == name.trim())
            })
            .map(|(_, submenu)| *submenu)
            .filter(|submenu| !submenu.is_null())
            .map(|submenu| {
                read_level(submenu).is_some_and(|items| {
                    let items: Vec<NativeMenuItem> =
                        items.into_iter().map(|(item, _)| item).collect();
                    agent_desktop_core::every_menu_item_unnamed(&items)
                })
            })
            .peekable();
        if drawn.peek().is_some() && drawn.all(|all_drawn| all_drawn) {
            MenuBarKind::DrawnItems
        } else {
            MenuBarKind::StandardItem
        }
    }
}

#[cfg(target_os = "windows")]
pub(crate) use live::{bar_of, menu_bar_kind, read_level, read_menu_bar};

#[cfg(not(target_os = "windows"))]
pub(crate) fn read_menu_bar(
    _window: &WindowInfo,
    _deadline: Deadline,
) -> Result<NativeMenuBar, AdapterError> {
    Err(AdapterError::not_supported("read_menu_bar"))
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn menu_bar_kind(_entry: &RefEntry) -> MenuBarKind {
    MenuBarKind::Unknown
}

#[cfg(test)]
#[path = "menu_bar_tests.rs"]
mod tests;
