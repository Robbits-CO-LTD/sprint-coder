// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! The `menubar` snapshot surface, read from a window's own native menu.
//!
//! A standard menu bar opens only while its window is in front, so its items
//! are not in the accessibility tree of a window behind others, and opening
//! it from behind fails. The platform can still read the menu's items without
//! opening it; this surface presents that read, and nothing is sent to the
//! application while reading (the messages an open menu would send first,
//! which let an application update the items, change what some applications
//! hold, so the read leaves them out and says the states may be stale).
//!
//! An item that can be run - one that opens no submenu, is enabled under
//! enabled menus, can be read, sends a command, and is the only item of its
//! name in each menu on its way down - gets a ref proven in the menu
//! (`refs::ref_menu`), which only `click` runs. In a menu that reports a
//! chosen item by its position (`MNS_NOTIFYBYPOS`), every menu on the item's
//! way must report so too.

use serde_json::{Value, json};

use crate::{
    AccessibilityNode, AdapterError, AppError, ErrorCode, NodeDescriptor, NodeIdentity,
    NodePresentation, RefMenuProof, RefMenuStep, TreeOptions, WindowInfo,
    actions::action::Action,
    adapter::PlatformAdapter,
    context::CommandContext,
    refs::{RefEntry, RefMap, ref_menu},
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
    /// The command identifier the item sends when chosen (0 when it sends
    /// none, and meaningless for an item that opens a submenu).
    pub command_id: u32,
    /// The menu holding the item reports its items by position
    /// (`MNS_NOTIFYBYPOS`, with `WM_MENUCOMMAND`) instead of sending their
    /// commands (`WM_COMMAND`).
    pub in_notify_by_position_menu: bool,
    /// The style of the menu holding the item could not be read, so how it
    /// reports a chosen item is not known; such an item is never run.
    pub notify_style_unread: bool,
    /// The items of the submenu the item opens, when it opens one.
    pub submenu: Option<Vec<NativeMenuItem>>,
    /// The item opens a submenu the read did not reach (its limits ran out,
    /// or the read was of one level only).
    pub submenu_unread: bool,
}

/// A window's menu bar as the adapter read it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NativeMenuBar {
    pub items: Vec<NativeMenuItem>,
    /// Every item was read; false when the read stopped at a limit or the
    /// deadline, leaving some submenus unread.
    pub complete: bool,
    /// The window does not take input now (a modal dialog it opened has
    /// disabled it), so none of its items gets a ref.
    pub window_disabled: bool,
}

/// What a window's native menu says about a menu item a ref names, for the
/// guidance an action that fails on it carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MenuBarKind {
    /// The item is one of the window's standard menu bar items.
    StandardItem,
    /// The item is one of the window's standard menu bar items, but the
    /// application draws every item of the menu it opens itself (Tcl/Tk
    /// does), so none of them can be read or run from behind the window.
    DrawnItems,
    /// The window has no standard menu bar: its menus are drawn by the
    /// application itself.
    NotStandard,
    /// Nothing can be said (another kind of item, or the read failed).
    Unknown,
}

pub(crate) const MENU_BAR_HINT: &str = "These are the window's standard menu items, read from the menu itself without opening it or sending anything to the application. An item with a ref runs with click <ref>: the application receives the item's command as if a person chose it, and the window stays where it is. Before sending, the menu is read again the way an opening menu is (the application is told the menu opens, so it can update it), and the item must still be there by the same names, enabled and sending the same command; otherwise nothing is sent. Items without a ref cannot be run this way (a submenu, a disabled item, or one whose hint says why). Enabled and checked states here are as the application last set them, so the open menu can differ.";

const MENU_BAR_DISABLED_HINT: &str = "The window does not take input now (a dialog it opened, or something else, has disabled it), so no item has a ref: finish or close the dialog, then read the menu bar again.";

const MENU_BAR_DEPTH_HINT: &str = "Some submenus were cut at the depth limit, so their items are not listed; each carries children_count. Run snapshot --surface menubar again with a larger --max-depth (up to 50).";

const OWNER_DRAWN_HINT: &str =
    "The application draws this item itself, so its name cannot be read.";

const DRAWN_MENU_HINT: &str = "The application draws every item of this menu itself (Tcl/Tk menus are drawn this way), so their names cannot be read and none of them can be run from behind the window. Look for a button or toolbar of the window that does the same (snapshot of the window); otherwise running them needs an operation that brings the window to the front.";

const DRAWN_MENUS_BAR_HINT: &str = "Some menus here are drawn by the application itself (their hint says so): their items have no name and no ref, and cannot be run from behind the window.";

const UNREAD_HINT: &str = "This submenu was not read: the read reached its limit first.";

/// Whether a menu has items and none of them shows a readable name: the
/// application draws them all itself, so nothing in it can be matched by name.
pub fn every_item_unnamed(items: &[NativeMenuItem]) -> bool {
    let mut shown = items.iter().filter(|item| !item.separator).peekable();
    shown.peek().is_some() && shown.all(|item| ref_menu::item_name(item).is_none())
}

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

/// The window the refs of a read belong to, and the map they are added to.
pub(crate) struct MenuRefs<'a> {
    pub(crate) window: &'a WindowInfo,
    pub(crate) refmap: &'a mut RefMap,
}

struct Walk<'r, 'w> {
    max_depth: u8,
    count: usize,
    refs: Option<&'r mut MenuRefs<'w>>,
}

/// The presented tree of a menu bar: a `menubar` root over its items, cut at
/// `max_depth` levels below the root, and how many items it holds. With
/// `refs`, every item that can be run gets a ref in `refs.refmap`.
pub(crate) fn build_tree(
    bar: &NativeMenuBar,
    max_depth: u8,
    refs: Option<&mut MenuRefs<'_>>,
) -> (AccessibilityNode, usize) {
    let mut walk = Walk {
        max_depth,
        count: 0,
        refs,
    };
    let mut path = Vec::new();
    let children = items_to_nodes(&bar.items, 1, &mut walk, &mut path);
    let root = AccessibilityNode {
        ref_id: None,
        role: "menubar".to_owned(),
        identity: NodeIdentity::default(),
        presentation: NodePresentation::default(),
        children_count: None,
        subtree_truncated: false,
        children,
    };
    (root, walk.count)
}

/// An ancestor on the way down: the item, the menu holding it, and its
/// position there.
type Step<'b> = (&'b NativeMenuItem, &'b [NativeMenuItem], u32);

fn items_to_nodes<'b>(
    items: &'b [NativeMenuItem],
    depth: u8,
    walk: &mut Walk<'_, '_>,
    path: &mut Vec<Step<'b>>,
) -> Vec<AccessibilityNode> {
    let mut nodes = Vec::new();
    for (position, item) in items.iter().enumerate() {
        if item.separator {
            continue;
        }
        walk.count += 1;
        let position = u32::try_from(position).unwrap_or(u32::MAX);
        nodes.push(item_node(item, items, position, depth, walk, path));
    }
    nodes
}

fn item_node<'b>(
    item: &'b NativeMenuItem,
    siblings: &'b [NativeMenuItem],
    position: u32,
    depth: u8,
    walk: &mut Walk<'_, '_>,
    path: &mut Vec<Step<'b>>,
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
    let opens_submenu = ref_menu::opens_submenu(item);
    if opens_submenu {
        states.push(crate::tree::state::HASPOPUP.to_owned());
    }
    let ancestors: Vec<(&NativeMenuItem, &[NativeMenuItem])> = path
        .iter()
        .map(|(ancestor, menu, _)| (*ancestor, *menu))
        .collect();
    let reason = ref_menu::unrunnable_reason(item, siblings, &ancestors);
    let mut hints: Vec<String> = Vec::new();
    if name.is_none() {
        hints.push(OWNER_DRAWN_HINT.to_owned());
    } else if item.submenu_unread {
        hints.push(UNREAD_HINT.to_owned());
    } else if item.submenu.as_deref().is_some_and(every_item_unnamed) {
        hints.push(DRAWN_MENU_HINT.to_owned());
    } else if let Some(shortcut) = &shortcut {
        hints.push(format!("Shortcut: {shortcut}."));
    }
    if let Some(reason) = reason.filter(|reason| !reason.is_empty()) {
        hints.push(reason.to_owned());
    }
    let mut ref_id = None;
    if reason.is_none()
        && let (Some(refs), Some(name)) = (walk.refs.as_deref_mut(), name.as_ref())
    {
        ref_id = allocate(refs, item, name, shortcut.clone(), position, path, &states);
    }
    let (children, children_count) = match &item.submenu {
        Some(submenu) if depth < walk.max_depth => {
            path.push((item, siblings, position));
            let children = items_to_nodes(submenu, depth + 1, walk, path);
            path.pop();
            (children, None)
        }
        Some(submenu) => {
            let shown = submenu.iter().filter(|child| !child.separator).count();
            (Vec::new(), u32::try_from(shown).ok().filter(|n| *n > 0))
        }
        None => (Vec::new(), None),
    };
    let available_actions = if ref_id.is_some() {
        vec![crate::actions::capability::CLICK.to_owned()]
    } else {
        Vec::new()
    };
    AccessibilityNode {
        ref_id,
        role: "menuitem".to_owned(),
        identity: NodeIdentity {
            name,
            ..NodeIdentity::default()
        },
        presentation: NodePresentation {
            hint: (!hints.is_empty()).then(|| hints.join(" ")),
            states,
            available_actions,
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

/// Adds the ref of a runnable item, or `None` when the entry cannot be
/// recorded (a window without a process instance, a field past its limit).
fn allocate(
    refs: &mut MenuRefs<'_>,
    item: &NativeMenuItem,
    name: &str,
    shortcut: Option<String>,
    position: u32,
    path: &[Step<'_>],
    states: &[String],
) -> Option<String> {
    let mut steps = Vec::with_capacity(path.len() + 1);
    for (ancestor, _, at) in path {
        steps.push(RefMenuStep {
            name: ref_menu::item_name(ancestor)?,
            position: *at,
            submenu: true,
        });
    }
    steps.push(RefMenuStep {
        name: name.to_owned(),
        position,
        submenu: false,
    });
    let window = refs.window;
    let entry = RefEntry {
        process: crate::RefProcess {
            pid: window.pid,
            process_instance: window.process_instance.clone(),
        },
        identity: crate::RefEntryIdentity {
            role: "menuitem".to_owned(),
            name: Some(name.to_owned()),
            in_menu: Some(RefMenuProof {
                steps: steps.clone(),
                command_id: item.command_id,
                // Every menu on the way reports the same way (`unrunnable_reason`).
                by_position: item.in_notify_by_position_menu,
                shortcut,
            }),
            ..crate::RefEntryIdentity::default()
        },
        geometry: crate::RefGeometry {
            bounds: None,
            bounds_hash: None,
            bounds_space: None,
        },
        capabilities: crate::RefCapabilities {
            states: states.to_vec(),
            available_actions: vec![crate::actions::capability::CLICK.to_owned()],
        },
        source: crate::RefSource {
            source_app: Some(window.app.clone()),
            source_window_id: Some(window.id.clone()),
            source_window_title: Some(window.title.clone()),
            source_window_bounds_hash: window.bounds.as_ref().and_then(crate::Rect::bounds_hash),
            source_surface: crate::SnapshotSurface::Menubar,
            renderer_accessibility_forced: false,
        },
        scope: crate::RefScope {
            root_ref: None,
            path_is_absolute: false,
            path: steps
                .iter()
                .map(|step| usize::try_from(step.position).unwrap_or(usize::MAX))
                .collect(),
        },
    };
    refs.refmap.try_allocate(entry).ok()
}

/// Reads the menu bar of the window `app`/`window_id` name, presents it in
/// the snapshot envelope, and saves the refs of its runnable items.
pub(crate) fn run(
    adapter: &dyn PlatformAdapter,
    opts: &TreeOptions,
    app: Option<&str>,
    window_id: Option<&str>,
    timeout_ms: u64,
    context: &CommandContext,
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
    let mut result = capture(&window, &bar, opts.max_depth);
    if !result.refmap.is_empty() {
        let store = crate::refs::refs_store::RefStore::for_session(context.session_id())?;
        let snapshot_id = result.save_refmap(&store)?;
        crate::trace::trace_artifacts::copy_refmap_if_full(
            context,
            &store,
            &snapshot_id,
            &result.refmap,
        )?;
        result.bind_snapshot_id(snapshot_id);
        super::emit_snapshot_saved(context, &result)?;
    }
    Ok(present(&result, bar.window_disabled))
}

/// The snapshot of a menu bar read, with the refs of its runnable items.
pub(crate) fn capture(
    window: &WindowInfo,
    bar: &NativeMenuBar,
    max_depth: u8,
) -> super::SnapshotResult {
    let mut refmap = RefMap::new();
    let mut refs = MenuRefs {
        window,
        refmap: &mut refmap,
    };
    let (tree, nodes_observed) =
        build_tree(bar, max_depth, (!bar.window_disabled).then_some(&mut refs));
    super::SnapshotResult {
        tree,
        refmap,
        window: window.clone(),
        snapshot_id: None,
        complete: bar.complete,
        nodes_observed,
        identity_unproven: None,
        visible_scope: false,
    }
}

/// Whether the presented tree holds a menu whose items the application draws
/// itself (the hint `item_node` gives the item that opens it).
fn has_drawn_menu(node: &AccessibilityNode) -> bool {
    node.presentation
        .hint
        .as_deref()
        .is_some_and(|hint| hint.contains(DRAWN_MENU_HINT))
        || node.children.iter().any(has_drawn_menu)
}

pub(crate) fn present(result: &super::SnapshotResult, window_disabled: bool) -> Value {
    let mut body = match crate::commands::snapshot::format_snapshot_fields(result, None, None) {
        Ok(body) => body,
        Err(_) => json!({}),
    };
    body["surface"] = json!("menubar");
    let mut menu_hint = MENU_BAR_HINT.to_owned();
    if has_drawn_menu(&result.tree) {
        menu_hint = format!("{DRAWN_MENUS_BAR_HINT} {menu_hint}");
    }
    if window_disabled {
        body["window_disabled"] = json!(true);
        menu_hint = format!("{MENU_BAR_DISABLED_HINT} {menu_hint}");
    }
    body["menu_hint"] = json!(menu_hint);
    if body.get("depth_hint").is_some() {
        body["depth_hint"] = json!(MENU_BAR_DEPTH_HINT);
    }
    body
}

/// The guidance added to a click or an expand that failed on a menu item of
/// the window's accessibility tree: when the item is one of the window's
/// standard menu bar items, that its items can be read and run without
/// opening it - unless the application draws every item of its menu itself,
/// when they cannot; when the window has no standard menu bar, that this menu
/// cannot be opened from behind the window. The error's code, message and
/// delivery are kept as they are.
pub(crate) fn annotate_action_error(
    adapter: &dyn PlatformAdapter,
    entry: &RefEntry,
    action: &Action,
    mut error: AdapterError,
) -> AdapterError {
    if !matches!(action, Action::Click | Action::Expand)
        || entry.identity.role != "menuitem"
        || entry.identity.in_menu.is_some()
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
            format!(
                "This is an item of the window's standard menu bar, which opens only while the window is in front. Its items can be read and run without opening it: snapshot --surface menubar --window-id {}, then click the item's ref.",
                entry.source.source_window_id.as_deref().unwrap_or("<id>")
            ),
        ),
        MenuBarKind::DrawnItems => (
            "owner_drawn",
            "This is an item of the window's standard menu bar, which opens only while the window is in front, and the application draws the items of this menu itself, so their names cannot be read and they cannot be run from behind the window (snapshot --surface menubar lists them without a name or a ref). Look for a button or toolbar of the window that does the same (snapshot of the window); otherwise running them needs an operation that brings the window to the front.".to_owned(),
        ),
        MenuBarKind::NotStandard => (
            "not_standard",
            "This menu is not a standard Windows menu (the window has no menu bar of its own), so it cannot be opened or run from behind the window. Opening it needs an operation that brings the window to the front.".to_owned(),
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
pub(crate) mod tests;
