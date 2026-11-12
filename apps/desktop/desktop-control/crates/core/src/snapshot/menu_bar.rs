// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! The `menubar` snapshot surface, read from a window's own native menu.
//!
//! A standard menu bar opens only while its window is in front, so its items
//! are not in the accessibility tree of a window behind others, and opening
//! it from behind fails. The platform can still read the menu's items without
//! opening it; this surface presents that read. It is read only: the items
//! carry no refs and no actions, and nothing is sent to the application
//! (the messages an open menu would send first, which let an application
//! update the items, change what some applications hold, so the read leaves
//! them out and says the states may be stale).

use serde_json::{Value, json};

use crate::{
    AccessibilityNode, AdapterError, AppError, ErrorCode, NodeDescriptor, NodeIdentity,
    NodePresentation, TreeOptions, WindowInfo,
    actions::action::Action,
    adapter::PlatformAdapter,
    refs::{RefEntry, RefMap},
};

/// One item of a native menu, as the application set it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NativeMenuItem {
    /// The item's text with its `&` access-key markers and the tab before its
    /// shortcut, or `None` when it has none to read (an item the application
    /// draws itself, or a picture).
    pub text: Option<String>,
    pub separator: bool,
    pub disabled: bool,
    pub checked: bool,
    pub radio: bool,
    /// The application draws the item itself, so its text cannot be read.
    pub owner_drawn: bool,
    /// The items of the submenu the item opens, when it opens one.
    pub submenu: Option<Vec<NativeMenuItem>>,
    /// The item opens a submenu the read did not reach (its limits ran out).
    pub submenu_unread: bool,
}

/// A window's menu bar as the adapter read it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NativeMenuBar {
    pub items: Vec<NativeMenuItem>,
    /// Every item was read; false when the read stopped at a limit or the
    /// deadline, leaving some submenus unread.
    pub complete: bool,
}

/// What a window's native menu says about a menu item a ref names, for the
/// guidance an action that fails on it carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MenuBarKind {
    /// The item is one of the window's standard menu bar items.
    StandardItem,
    /// The window has no standard menu bar: its menus are drawn by the
    /// application itself.
    NotStandard,
    /// Nothing can be said (another kind of item, or the read failed).
    Unknown,
}

pub(crate) const MENU_BAR_HINT: &str = "These are the window's standard menu items, read from the menu itself without opening it or sending anything to the application. They carry no refs: running a menu item is not available yet. Enabled and checked states are as the application last set them; some applications update them, or change the items, only when the menu is opened, so the open menu can differ.";

const MENU_BAR_DEPTH_HINT: &str = "Some submenus were cut at the depth limit, so their items are not listed; each carries children_count. Run snapshot --surface menubar again with a larger --max-depth (up to 50).";

const OWNER_DRAWN_HINT: &str =
    "The application draws this item itself, so its name cannot be read.";

const UNREAD_HINT: &str = "This submenu was not read: the read reached its limit first.";

/// The item's name as a menu shows it: the text before the tab that starts
/// its shortcut, with each `&` access-key marker removed and `&&` kept as one
/// `&` (the form UI Automation names a standard menu item by).
pub fn menu_item_name(text: &str) -> String {
    let label = text.split('\t').next().unwrap_or_default();
    let mut name = String::with_capacity(label.len());
    let mut chars = label.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '&' {
            if chars.peek() == Some(&'&') {
                chars.next();
                name.push('&');
            }
            continue;
        }
        name.push(c);
    }
    name.trim().to_owned()
}

/// The shortcut a menu item's text shows after its tab, if any.
pub fn menu_item_shortcut(text: &str) -> Option<String> {
    let (_, shortcut) = text.split_once('\t')?;
    let shortcut = shortcut.trim();
    (!shortcut.is_empty()).then(|| shortcut.to_owned())
}

/// The presented tree of a menu bar: a `menubar` root over its items, cut at
/// `max_depth` levels below the root, and how many items it holds.
pub(crate) fn build_tree(bar: &NativeMenuBar, max_depth: u8) -> (AccessibilityNode, usize) {
    let mut count = 0;
    let children = items_to_nodes(&bar.items, 1, max_depth, &mut count);
    let root = AccessibilityNode {
        ref_id: None,
        role: "menubar".to_owned(),
        identity: NodeIdentity::default(),
        presentation: NodePresentation::default(),
        children_count: None,
        subtree_truncated: false,
        children,
    };
    (root, count)
}

fn items_to_nodes(
    items: &[NativeMenuItem],
    depth: u8,
    max_depth: u8,
    count: &mut usize,
) -> Vec<AccessibilityNode> {
    items
        .iter()
        .filter(|item| !item.separator)
        .map(|item| {
            *count += 1;
            item_node(item, depth, max_depth, count)
        })
        .collect()
}

fn item_node(
    item: &NativeMenuItem,
    depth: u8,
    max_depth: u8,
    count: &mut usize,
) -> AccessibilityNode {
    let text = item.text.as_deref().filter(|_| !item.owner_drawn);
    let name = text.map(menu_item_name).filter(|name| !name.is_empty());
    let shortcut = text.and_then(menu_item_shortcut);
    let mut states = Vec::new();
    if item.disabled {
        states.push(crate::tree::state::DISABLED.to_owned());
    }
    if item.checked {
        states.push(crate::tree::state::CHECKED.to_owned());
    }
    let opens_submenu = item.submenu.is_some() || item.submenu_unread;
    if opens_submenu {
        states.push(crate::tree::state::HASPOPUP.to_owned());
    }
    let hint = if name.is_none() {
        Some(OWNER_DRAWN_HINT.to_owned())
    } else if item.submenu_unread {
        Some(UNREAD_HINT.to_owned())
    } else {
        shortcut.map(|shortcut| format!("Shortcut: {shortcut}"))
    };
    let (children, children_count) = match &item.submenu {
        Some(submenu) if depth < max_depth => {
            (items_to_nodes(submenu, depth + 1, max_depth, count), None)
        }
        Some(submenu) => {
            let shown = submenu.iter().filter(|child| !child.separator).count();
            (Vec::new(), u32::try_from(shown).ok().filter(|n| *n > 0))
        }
        None => (Vec::new(), None),
    };
    AccessibilityNode {
        ref_id: None,
        role: "menuitem".to_owned(),
        identity: NodeIdentity {
            name,
            ..NodeIdentity::default()
        },
        presentation: NodePresentation {
            hint,
            states,
            descriptors: NodeDescriptor {
                subrole: item.radio.then(|| "radio".to_owned()),
                ..NodeDescriptor::default()
            },
            ..NodePresentation::default()
        },
        children_count,
        subtree_truncated: item.submenu_unread,
        children,
    }
}

/// Reads the menu bar of the window `app`/`window_id` name and presents it
/// in the snapshot envelope, with no refs and nothing saved.
pub(crate) fn run(
    adapter: &dyn PlatformAdapter,
    opts: &TreeOptions,
    app: Option<&str>,
    window_id: Option<&str>,
    timeout_ms: u64,
) -> Result<Value, AppError> {
    let deadline = crate::Deadline::after(timeout_ms)?;
    let windows = super::surface_windows(
        adapter,
        app,
        window_id,
        crate::SnapshotSurface::Menubar,
        deadline,
    )?;
    let (window, bar) = super::window_capture::first_surface_owner(windows, |window| {
        Ok(adapter.read_menu_bar(window, deadline)?)
    })?;
    Ok(present(&window, &bar, opts.max_depth))
}

pub(crate) fn present(window: &WindowInfo, bar: &NativeMenuBar, max_depth: u8) -> Value {
    let (tree, nodes_observed) = build_tree(bar, max_depth);
    let result = super::SnapshotResult {
        tree,
        refmap: RefMap::new(),
        window: window.clone(),
        snapshot_id: None,
        complete: bar.complete,
        nodes_observed,
        identity_unproven: None,
        visible_scope: false,
    };
    let mut body = match crate::commands::snapshot::format_snapshot_fields(&result, None, None) {
        Ok(body) => body,
        Err(_) => json!({}),
    };
    body["surface"] = json!("menubar");
    body["menu_hint"] = json!(MENU_BAR_HINT);
    if body.get("depth_hint").is_some() {
        body["depth_hint"] = json!(MENU_BAR_DEPTH_HINT);
    }
    body
}

/// The guidance added to a click or an expand that failed on a menu item:
/// when the item is one of the window's standard menu bar items, that its
/// items can be read without opening it; when the window has no standard
/// menu bar, that this menu cannot be opened from behind the window. The
/// error's code, message and delivery are kept as they are.
pub(crate) fn annotate_action_error(
    adapter: &dyn PlatformAdapter,
    entry: &RefEntry,
    action: &Action,
    mut error: AdapterError,
) -> AdapterError {
    if !matches!(action, Action::Click | Action::Expand)
        || entry.identity.role != "menuitem"
        || !matches!(
            error.code,
            ErrorCode::PolicyDenied | ErrorCode::ActionFailed | ErrorCode::ActionNotSupported
        )
    {
        return error;
    }
    // A minimized window is refused for that reason alone; restoring it comes first.
    if error
        .details
        .as_ref()
        .and_then(|details| details.get("kind"))
        .is_some_and(|kind| kind == "window_minimized")
    {
        return error;
    }
    let Ok(deadline) = crate::Deadline::after(500) else {
        return error;
    };
    let (kind, hint) = match adapter.menu_bar_kind(entry, deadline) {
        MenuBarKind::StandardItem => (
            "standard",
            match entry.source.source_window_id.as_deref() {
                Some(id) => format!(
                    "This is an item of the window's standard menu bar, which opens only while the window is in front. Its items can be read without opening it: snapshot --surface menubar --window-id {id}."
                ),
                None => "This is an item of the window's standard menu bar, which opens only while the window is in front. Its items can be read without opening it: snapshot --surface menubar.".to_owned(),
            },
        ),
        MenuBarKind::NotStandard => (
            "not_standard",
            "This menu is not a standard Windows menu (the window has no menu bar of its own), so it cannot be opened from behind the window. Opening it needs an operation that brings the window to the front.".to_owned(),
        ),
        MenuBarKind::Unknown => return error,
    };
    error.suggestion = Some(match error.suggestion.take() {
        Some(existing) if !existing.is_empty() => format!("{existing} {hint}"),
        _ => hint,
    });
    match &mut error.details {
        Some(Value::Object(details)) => {
            details.insert("menu_bar".into(), json!(kind));
        }
        None => error.details = Some(json!({ "menu_bar": kind })),
        Some(_) => {}
    }
    error
}

#[cfg(test)]
#[path = "menu_bar_tests.rs"]
mod tests;
