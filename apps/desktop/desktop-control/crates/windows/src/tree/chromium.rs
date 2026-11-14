// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use agent_desktop_core::{AdapterError, LocatorStats, ObservationRequest, ObservationRoot};

use super::element::UIAElement;
#[cfg(target_os = "windows")]
use super::properties::property_ids::TreeProperty;
#[cfg(target_os = "windows")]
use super::properties::read_one;

/// The top-level window class Chromium ships (A4-4 observed it on Obsidian's
/// top-level and render-host windows). Detection keys on this class alone -
/// an app allowlist would be the macOS renderer-probe anti-pattern this crate
/// deliberately refuses.
const CHROMIUM_WINDOW_CLASS: &str = "Chrome_WidgetWin_1";

/// The pre-activation shell shape A16-11 censused: a full-depth walk of a
/// not-yet-settled Chromium root lands in the tens of nodes, against a settled
/// tree of 165. A shell under this line is the connection-triggered-build's
/// before state, not a genuinely small window.
const SHELL_NODE_CEILING: usize = 32;

/// Whether the root window is Chromium/Electron provenance.
///
/// Read from the root element's `ClassName` (a one-property live read, never a
/// second walk). This is what gates the wrapper skip and the activation
/// settle.
#[cfg(target_os = "windows")]
pub(crate) fn is_chromium_root(root: &UIAElement) -> bool {
    let class = read_one(root, TreeProperty::ClassName);
    matches!(
        class.text(),
        agent_desktop_core::LocatorField::Known(name) if is_chromium_class(&name)
    )
}

/// Whether a window's class names a Chromium top level: exactly
/// [`CHROMIUM_WINDOW_CLASS`], ignoring surrounding white space. The window
/// Chromium draws web content into ([`CHROMIUM_CONTENT_CLASS`]) is not a top
/// level, and a class that only resembles it is another toolkit's.
pub(crate) fn is_chromium_class(class: &str) -> bool {
    class.trim() == CHROMIUM_WINDOW_CLASS
}

/// The non-Windows twin, so the crate's `#![cfg]`-free internal callers compile
/// on the Linux cross-check lane. No real element exists there, so no window is
/// Chromium.
#[cfg(not(target_os = "windows"))]
pub(crate) fn is_chromium_root(_root: &UIAElement) -> bool {
    false
}

/// The class of the window Chromium draws web content into. An Electron
/// window holds it as a child of its own `Chrome_WidgetWin_1` top level; a
/// WebView2 control holds it under a `Chrome_WidgetWin_1` child of the host
/// application's top level, whose own class is the host's (a Tauri window
/// measured `Tauri Window`, with the content nested nine levels down).
const CHROMIUM_CONTENT_CLASS: &str = "Chrome_RenderWidgetHostHWND";

/// Whether the root's tree is of Chromium provenance: a Chromium top level
/// ([`is_chromium_root`]), or a window that holds Chromium web content in a
/// child window (WebView2 in a Tauri, WinForms or WPF window).
///
/// The child windows are listed with `EnumChildWindows` and read with
/// `GetClassNameW`, neither of which sends the target a message, so a busy
/// target cannot hold this up. An element that is not a window (a drill-down
/// root) keeps the class read alone.
#[cfg(target_os = "windows")]
pub(crate) fn has_chromium_provenance(root: &UIAElement) -> bool {
    is_chromium_root(root) || holds_chromium_content(root)
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn has_chromium_provenance(_root: &UIAElement) -> bool {
    false
}

/// [`has_chromium_provenance`] with a failed read kept apart from a "no":
/// `Err` when the root's class or window handle could not be read, so a
/// caller that must not guess (a ref resolved in the view it was proven in)
/// can say it could not tell. The child windows are listed as there, without
/// sending the target a message.
#[cfg(target_os = "windows")]
pub(crate) fn chromium_provenance_checked(root: &UIAElement) -> Result<bool, ()> {
    use windows::Win32::Foundation::HWND;
    let class = root.0.get_classname().map_err(drop)?;
    if is_chromium_class(&class) {
        return Ok(true);
    }
    let handle: HWND = root.0.get_native_window_handle().map_err(drop)?.into();
    Ok(!handle.0.is_null() && has_child_window_of_class(handle.0, CHROMIUM_CONTENT_CLASS))
}

#[cfg(target_os = "windows")]
fn holds_chromium_content(root: &UIAElement) -> bool {
    use windows::Win32::Foundation::HWND;
    let Ok(handle) = root.0.get_native_window_handle() else {
        return false;
    };
    let handle: HWND = handle.into();
    !handle.0.is_null() && has_child_window_of_class(handle.0, CHROMIUM_CONTENT_CLASS)
}

/// [`has_chromium_provenance`] of a top-level window by its handle alone: its
/// class is Chromium's top-level class, or a window below it is the one
/// Chromium draws web content into. Read with `GetClassNameW` and
/// `EnumChildWindows`, which send the window no message.
#[cfg(target_os = "windows")]
pub(crate) fn window_has_chromium_provenance(handle: isize) -> bool {
    let Some(class) = window_class_name(handle) else {
        return false;
    };
    chromium_provenance_of(&class, || window_holds_chromium_content(handle))
}

/// A window's class, read with `GetClassNameW` (which sends the window no
/// message); `None` for a null handle or one whose class could not be read
/// (a destroyed window).
#[cfg(target_os = "windows")]
pub(crate) fn window_class_name(handle: isize) -> Option<String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetClassNameW;
    let window = handle as *mut std::ffi::c_void;
    if window.is_null() {
        return None;
    }
    let mut buffer = [0u16; 256];
    // SAFETY: `buffer` is writable for the length passed.
    let length = unsafe { GetClassNameW(window, buffer.as_mut_ptr(), buffer.len() as i32) };
    let length = usize::try_from(length).ok().filter(|length| *length > 0)?;
    Some(String::from_utf16_lossy(&buffer[..length]))
}

/// Whether a window below `handle` is the one Chromium draws web content into,
/// listed with `EnumChildWindows` (no message is sent to the target).
#[cfg(target_os = "windows")]
pub(crate) fn window_holds_chromium_content(handle: isize) -> bool {
    let window = handle as *mut std::ffi::c_void;
    !window.is_null() && has_child_window_of_class(window, CHROMIUM_CONTENT_CLASS)
}

/// [`window_has_chromium_provenance`]'s verdict from the window's class and,
/// only when the class is not Chromium's, whether it holds Chromium content.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn chromium_provenance_of(class: &str, holds_content: impl FnOnce() -> bool) -> bool {
    is_chromium_class(class) || holds_content()
}

/// Whether any window below `parent` has the class `class`. Stops at the
/// first match.
#[cfg(target_os = "windows")]
pub(crate) fn has_child_window_of_class(parent: *mut std::ffi::c_void, class: &str) -> bool {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{EnumChildWindows, GetClassNameW};

    struct Search {
        class: Vec<u16>,
        found: bool,
    }
    unsafe extern "system" fn visit(window: HWND, state: isize) -> i32 {
        // SAFETY: `state` is the `Search` the caller below keeps alive for the
        // whole enumeration.
        let search = unsafe { &mut *(state as *mut Search) };
        let mut buffer = [0u16; 256];
        // SAFETY: `buffer` is writable for the length passed.
        let length = unsafe { GetClassNameW(window, buffer.as_mut_ptr(), buffer.len() as i32) };
        if length > 0 && buffer[..length as usize] == search.class[..] {
            search.found = true;
            return 0;
        }
        1
    }
    let mut search = Search {
        class: class.encode_utf16().collect(),
        found: false,
    };
    // SAFETY: `visit` only reads the window it is given and writes `search`,
    // which outlives this call.
    unsafe { EnumChildWindows(parent, Some(visit), &mut search as *mut Search as isize) };
    search.found
}

/// Whether a full-depth walk of a detected-Chromium root landed on the shell
/// shape.
///
/// A depth-clamped observation never claims this: the walk stopped above the
/// web content by design (the #117 lesson), so its small tree says nothing
/// about the renderer (a depth-clamped walk never demands activation). This is
/// only consulted for a **full-depth** walk.
pub(crate) fn is_shell_shaped(stats: &LocatorStats, request: &ObservationRequest) -> bool {
    reached_full_depth(stats, request) && stats.traversal.nodes_visited <= SHELL_NODE_CEILING as u64
}

/// Whether a walk genuinely ran out of tree rather than being depth-clamped.
///
/// This mirrors macOS's `observation_reached_tree_end` (the #117 lesson): a
/// depth-clamped observation stops above the web content by design, so its
/// small tree says nothing about whether the renderer is activated. Only a
/// walk that ran to a natural end can conclude the tree is genuinely thin.
fn reached_full_depth(stats: &LocatorStats, request: &ObservationRequest) -> bool {
    stats.traversal.max_logical_depth < request.max_logical_depth
}

/// Whether this observation is eligible to trigger renderer activation, the
/// macOS `activation_eligible` gating (`crates/macos/src/tree/query/mod.rs`):
/// a window-rooted, full-depth observation of a Chromium shell.
///
/// An Element-rooted or non-Window-surface walk never demands activation - a
/// drill-down into a shell-shaped subtree returns its thin tree rather than
/// looping the settle.
pub(crate) fn activation_eligible(root: ObservationRoot<'_>, request: &ObservationRequest) -> bool {
    matches!(root, ObservationRoot::Window(_))
        && request.surface == agent_desktop_core::SnapshotSurface::Window
}

/// Builds the activation-required error that core's loop turns into a settle
/// retry. The marker is in `renderer_accessibility_activation_required`.
pub(crate) fn activation_required(stats: &LocatorStats) -> AdapterError {
    let mut error = agent_desktop_core::AdapterError::renderer_accessibility_activation_required(
        "The Chromium renderer has not published its accessibility tree yet",
    );
    if let Some(details) = error
        .details
        .as_mut()
        .and_then(serde_json::Value::as_object_mut)
    {
        details.insert(
            "nodes_observed".into(),
            serde_json::json!(stats.traversal.nodes_visited),
        );
    }
    error
}

/// The `platform_detail` guidance a tree still thin after settle carries.
///
/// Names Chromium's `--force-renderer-accessibility` switch, and recommends
/// raising `--timeout-ms` when the observation is cut short before the build
/// completes. No target-derived text enters here.
pub(crate) fn still_thin_detail() -> String {
    "The tree is still thin after Chromium's accessibility build settled. \
     If this application is Chromium-based, it may require the \
     --force-renderer-accessibility switch; if the observation is being cut \
     before the build completes, increase snapshot --timeout-ms."
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_desktop_core::{
        Deadline, LocatorStats, ObservationRequest, ObservationRoot, SnapshotSurface, TreeOptions,
        WindowInfo,
    };

    fn request(max_depth: u8) -> ObservationRequest {
        let options = TreeOptions {
            max_depth,
            ..TreeOptions::default()
        };
        ObservationRequest::snapshot(&options, Deadline::after(5_000).unwrap())
    }

    fn stats(nodes: u64, max_logical_depth: u8) -> LocatorStats {
        let mut stats = LocatorStats::default();
        stats.traversal.nodes_visited = nodes;
        stats.traversal.max_logical_depth = max_logical_depth;
        stats
    }

    fn window_root() -> ObservationRoot<'static> {
        let window: &'static WindowInfo = Box::leak(Box::new(WindowInfo {
            id: "w-1".into(),
            title: String::new(),
            app: String::new(),
            pid: agent_desktop_core::ProcessId::new(1),
            process_instance: None,
            bounds: None,
            state: Default::default(),
        }));
        ObservationRoot::Window(window)
    }

    /// The #117 lesson pinned: a depth-clamped walk of a Chromium root never
    /// claims the shell shape, so it never demands activation.
    #[test]
    fn a_depth_clamped_walk_never_looks_shell_shaped() {
        let request = request(3);
        let stats = stats(12, 3);

        assert!(!is_shell_shaped(&stats, &request));
    }

    #[test]
    fn a_full_depth_shell_is_shell_shaped() {
        let request = request(50);
        let stats = stats(12, 12);

        assert!(is_shell_shaped(&stats, &request));
    }

    #[test]
    fn a_full_depth_settled_tree_is_not_shell_shaped() {
        let request = request(50);
        let stats = stats(165, 20);

        assert!(!is_shell_shaped(&stats, &request));
    }

    /// Depth is not this predicate's business: `reached_full_depth` and
    /// `is_shell_shaped` decide that, and the tests above drive them. This one
    /// covers the two clauses `activation_eligible` does consult - the root
    /// kind and the requested surface.
    #[test]
    fn activation_is_eligible_only_for_window_rooted_window_surface_observations() {
        let request = request(50);
        assert!(activation_eligible(window_root(), &request));

        let focused = ObservationRequest::snapshot(
            &TreeOptions {
                surface: SnapshotSurface::Focused,
                ..TreeOptions::default()
            },
            Deadline::after(5_000).unwrap(),
        );
        assert!(!activation_eligible(window_root(), &focused));
    }

    /// The other clause of the same predicate: an element-rooted observation
    /// is never eligible, whatever its surface.
    ///
    /// A drill-down into a shell-shaped subtree must return its thin tree
    /// rather than demanding activation, because the settle it would demand
    /// has already run for that window - core's loop would re-walk the same
    /// subtree indefinitely. Testing only window roots leaves this clause
    /// deletable with the suite green.
    #[test]
    fn an_element_rooted_observation_is_never_eligible_for_activation() {
        let request = request(50);
        let entry: &'static agent_desktop_core::RefEntry =
            Box::leak(Box::new(agent_desktop_core::RefEntry {
                process: agent_desktop_core::RefProcess {
                    pid: agent_desktop_core::ProcessId::new(1),
                    process_instance: None,
                },
                identity: agent_desktop_core::RefEntryIdentity {
                    retained_object: None,
                    role: "button".into(),
                    name: None,
                    value: None,
                    description: None,
                    native_id: None,
                    unique_at_capture: false,
                    ancestors: Vec::new(),
                    in_view: None,
                    in_menu: None,
                },
                geometry: agent_desktop_core::RefGeometry {
                    bounds_space: None,
                    bounds: None,
                    bounds_hash: None,
                },
                capabilities: agent_desktop_core::RefCapabilities {
                    states: Vec::new(),
                    available_actions: Vec::new(),
                },
                source: agent_desktop_core::RefSource {
                    source_app: None,
                    source_window_id: None,
                    source_window_title: None,
                    source_window_bounds_hash: None,
                    source_surface: SnapshotSurface::Window,
                    renderer_accessibility_forced: false,
                    settled_thin_nodes: None,
                },
                scope: agent_desktop_core::RefScope {
                    root_ref: None,
                    path_is_absolute: true,
                    path: agent_desktop_core::refs::RefPath::default(),
                },
            }));
        let handle: &'static agent_desktop_core::NativeHandle =
            Box::leak(Box::new(agent_desktop_core::NativeHandle::new(())));

        let element_root = ObservationRoot::Element {
            handle,
            entry,
            root_ref: None,
        };

        assert_eq!(
            request.surface,
            SnapshotSurface::Window,
            "the surface clause must be satisfied, so only the root clause can refuse this"
        );
        assert!(!activation_eligible(element_root, &request));
    }

    /// A top-level window is of Chromium provenance by its own class, or else
    /// by Chromium content below it, which is looked for only when the class
    /// is another toolkit's.
    #[test]
    fn a_window_is_of_chromium_provenance_by_its_class_or_its_content() {
        let looked = std::cell::Cell::new(false);
        assert!(chromium_provenance_of("Chrome_WidgetWin_1", || {
            looked.set(true);
            false
        }));
        assert!(!looked.get(), "a Chromium class needs no search below it");
        assert!(chromium_provenance_of("Tauri Window", || true));
        assert!(!chromium_provenance_of(
            "HwndWrapper[DefaultDomain;;]",
            || false
        ));
        assert!(!chromium_provenance_of("", || false));
    }

    /// Only Chromium's own top-level class reads as Chromium: the content
    /// window's class, a near miss, and an empty class do not, so no other
    /// toolkit's window is read by its visible elements on a class alone.
    #[test]
    fn only_the_chromium_top_level_class_reads_as_chromium() {
        assert!(is_chromium_class("Chrome_WidgetWin_1"));
        assert!(is_chromium_class(" Chrome_WidgetWin_1 "));
        for other in [
            "",
            "Chrome_WidgetWin_0",
            "chrome_widgetwin_1",
            "Chrome_WidgetWin_1x",
            "Chrome_RenderWidgetHostHWND",
            "HwndWrapper[DefaultDomain;;]",
            "Tauri Window",
        ] {
            assert!(!is_chromium_class(other), "{other:?}");
        }
    }
}

#[cfg(all(test, target_os = "windows"))]
#[path = "chromium_provenance_tests.rs"]
mod provenance_tests;
