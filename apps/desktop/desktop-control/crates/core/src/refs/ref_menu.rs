// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! Refs to items of a window's standard menu bar (`proven_in_menu`).
//!
//! Such a ref is read from the window's native menu (`snapshot --surface
//! menubar`), not from the accessibility tree, and names an item by its place
//! in the menu: the name of each level from the bar down and the command the
//! item sends. It is never resolved to an accessibility element - every path
//! that would (`resolve_saved_ref`, `land_saved_ref`, `observe_saved_ref`,
//! `read_saved_root`, the adapter's anchor landing) refuses it - and only
//! `click` runs it, through the adapter's `run_menu_command`.
//!
//! Before anything is sent, the live menu must show, at every level, exactly
//! one item with the recorded name, each but the last opening a submenu and
//! none disabled, and the last sending the recorded command and being neither
//! disabled, nor drawn by the application, nor opening a submenu. Positions
//! are recorded but not required: some applications rebuild a menu when it
//! opens, which moves items, and a moved item that still reads the same and
//! sends the same command is the same item. Two items with the recorded name
//! in one level stop it, so a moved item can never be taken for another.

use serde_json::json;

use crate::{
    AdapterError, AppError, DeliverySemantics, ErrorCode, NativeMenuItem, RefEntry, RefMenuProof,
    RefMenuStep,
};

/// The most levels a recorded menu place may have: the native read stops at
/// sixteen levels below the bar.
pub const MAX_MENU_STEPS: usize = 16;

const MAX_MENU_TEXT_BYTES: usize = 1_024;

/// The shape a stored menu proof must have; anything else is refused when the
/// refmap is read, before any ref of it is used.
pub(crate) fn validate_menu_proof(entry: &RefEntry) -> Result<(), AppError> {
    let Some(proof) = &entry.identity.in_menu else {
        return Ok(());
    };
    let last = proof.steps.len().wrapping_sub(1);
    let steps_ok = !proof.steps.is_empty()
        && proof.steps.len() <= MAX_MENU_STEPS
        && proof.steps.iter().enumerate().all(|(index, step)| {
            !step.name.trim().is_empty()
                && step.name.len() <= MAX_MENU_TEXT_BYTES
                && step.submenu == (index != last)
        });
    let ok = steps_ok
        && proof.command_id != 0
        && proof
            .shortcut
            .as_ref()
            .is_none_or(|shortcut| shortcut.len() <= MAX_MENU_TEXT_BYTES)
        && entry.identity.role == "menuitem"
        && entry.source.source_surface == crate::SnapshotSurface::Menubar
        && entry.source.source_window_id.is_some();
    if ok {
        Ok(())
    } else {
        Err(AppError::invalid_input("RefEntry menu proof is malformed"))
    }
}

/// The refusal for a menu item ref used by anything but `click`, or reaching
/// a path that resolves refs to accessibility elements.
pub fn menu_ref_refused(entry: &RefEntry) -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionNotSupported,
        "This ref names an item of a window's standard menu bar, which only click runs",
    )
    .with_suggestion(
        "Run the item with click <ref> (without --headed). To read or act on the window's other \
         elements, take snapshot of the window instead.",
    )
    .with_details(json!({
        "kind": "menu_item_ref",
        "role": entry.identity.role,
        "retryable": false,
    }))
    .with_disposition(DeliverySemantics::not_delivered())
}

/// Why the live menu no longer shows the recorded item.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MenuMismatch {
    /// No item of the level has the recorded name.
    Missing,
    /// Two or more items of the level have the recorded name.
    Ambiguous,
    /// The item opens a submenu where it did not, or no longer opens one.
    KindChanged,
    /// The item, or a menu above it, is disabled now.
    Disabled,
    /// The item sends another command now.
    CommandChanged,
    /// The menu now reports its items by position (`MNS_NOTIFYBYPOS`).
    NotifyByPosition,
    /// The window has no menu bar now.
    NoMenuBar,
    /// The application replaced its menu bar, or a submenu on the way, while
    /// it was told the menu opens or closes: the menu that was matched is no
    /// longer the one the window shows.
    Replaced,
}

impl MenuMismatch {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Missing => "missing",
            Self::Ambiguous => "ambiguous",
            Self::KindChanged => "kind_changed",
            Self::Disabled => "disabled",
            Self::CommandChanged => "command_changed",
            Self::NotifyByPosition => "notify_by_position",
            Self::NoMenuBar => "no_menu_bar",
            Self::Replaced => "menu_replaced",
        }
    }
}

/// The refusal for a menu item the live menu does not show as recorded:
/// nothing was sent.
pub fn menu_mismatch_error(entry: &RefEntry, mismatch: MenuMismatch) -> AdapterError {
    let window = entry.source.source_window_id.as_deref().unwrap_or("<id>");
    AdapterError::stale_ref_because(
        "The window's menu no longer shows the item this ref was taken from, so nothing was sent",
    )
    .with_suggestion(format!(
        "Read the menu again with snapshot --surface menubar --window-id {window} and use the new \
         ref. Some applications change their menu items when the menu opens."
    ))
    .with_details(json!({
        "kind": "menu_item_changed",
        "reason": mismatch.as_str(),
        "retryable": false,
    }))
    .with_disposition(DeliverySemantics::not_delivered())
}

/// The name an item shows, when it can be read.
pub fn item_name(item: &NativeMenuItem) -> Option<String> {
    if item.owner_drawn || item.separator {
        return None;
    }
    let name = crate::menu_item_name(item.text.as_deref()?);
    (!name.is_empty()).then_some(name)
}

pub fn opens_submenu(item: &NativeMenuItem) -> bool {
    item.submenu.is_some() || item.submenu_unread
}

/// The one item of a live menu level the recorded step names: exactly one
/// item with the recorded name, opening a submenu exactly when the step does,
/// and enabled.
pub fn match_step(items: &[NativeMenuItem], step: &RefMenuStep) -> Result<usize, MenuMismatch> {
    let mut found = None;
    for (index, item) in items.iter().enumerate() {
        if item_name(item).as_deref() == Some(step.name.as_str()) {
            if found.is_some() {
                return Err(MenuMismatch::Ambiguous);
            }
            found = Some(index);
        }
    }
    let index = found.ok_or(MenuMismatch::Missing)?;
    let item = &items[index];
    if item.in_notify_by_position_menu {
        return Err(MenuMismatch::NotifyByPosition);
    }
    if opens_submenu(item) != step.submenu {
        return Err(MenuMismatch::KindChanged);
    }
    if item.disabled {
        return Err(MenuMismatch::Disabled);
    }
    Ok(index)
}

/// Whether the item the last step matched is the recorded command.
pub fn confirm_leaf(item: &NativeMenuItem, proof: &RefMenuProof) -> Result<(), MenuMismatch> {
    if item.owner_drawn || item.separator || opens_submenu(item) {
        return Err(MenuMismatch::KindChanged);
    }
    if item.disabled {
        return Err(MenuMismatch::Disabled);
    }
    if item.command_id != proof.command_id {
        return Err(MenuMismatch::CommandChanged);
    }
    Ok(())
}

/// Why a menu item read at capture gets no ref, or `None` when it gets one.
/// `path` holds the item's ancestors, bar side first, with each one's menu.
pub(crate) fn unrunnable_reason(
    item: &NativeMenuItem,
    siblings: &[NativeMenuItem],
    path: &[(&NativeMenuItem, &[NativeMenuItem])],
) -> Option<&'static str> {
    if opens_submenu(item) || item.separator {
        return Some("");
    }
    if item_name(item).is_none() {
        return Some("");
    }
    if item.disabled {
        return Some("");
    }
    if path
        .iter()
        .any(|(ancestor, _)| item_name(ancestor).is_none())
    {
        return Some("A menu above this item has no readable name, so it cannot be run by ref.");
    }
    if path.iter().any(|(ancestor, _)| ancestor.disabled) {
        return Some("Its menu is disabled, so this item cannot be run.");
    }
    if item.command_id == 0 || item.command_id > 0xFFFF {
        return Some("This item sends no command, so it cannot be run by ref.");
    }
    if item.in_notify_by_position_menu
        || path
            .iter()
            .any(|(ancestor, _)| ancestor.in_notify_by_position_menu)
    {
        return Some(
            "This menu reports its items by position, which running by ref does not support.",
        );
    }
    let unique = |item: &NativeMenuItem, menu: &[NativeMenuItem]| {
        let name = item_name(item);
        name.is_some() && menu.iter().filter(|other| item_name(other) == name).count() == 1
    };
    if !unique(item, siblings) || path.iter().any(|(ancestor, menu)| !unique(ancestor, menu)) {
        return Some(
            "Another item of this menu, or of a menu above it, has the same name, so this item \
             cannot be run by ref.",
        );
    }
    None
}

#[cfg(test)]
#[path = "ref_menu_tests.rs"]
mod tests;
