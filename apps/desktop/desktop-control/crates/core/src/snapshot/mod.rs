// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use crate::{
    AccessibilityNode, AppError, WindowInfo,
    adapter::{PlatformAdapter, TreeOptions, WindowFilter},
    context::CommandContext,
    refs::RefMap,
    refs::ref_alloc::{self, RefAllocConfig},
    refs::ref_alloc_options::RefAllocOptions,
    refs::ref_alloc_scope::RefAllocScope,
    refs::ref_alloc_source::RefAllocSource,
    refs::refs_store::RefStore,
    trace::trace_artifacts,
};
use serde_json::json;

#[derive(Clone)]
pub struct SnapshotResult {
    pub tree: AccessibilityNode,
    pub refmap: RefMap,
    pub window: WindowInfo,
    pub snapshot_id: Option<String>,
    pub complete: bool,
    pub nodes_observed: usize,
    /// Set when the whole-window read that proves tokenless refs failed or was
    /// cut short; it says why, and those refs are refused when used.
    pub identity_unproven: Option<String>,
    /// Set when the capture read only the elements the window showed, because
    /// the whole window could not be read within the deadline: the tree and its
    /// refs cover that view, and the refs stop once the view scrolls or changes.
    pub visible_scope: bool,
}

impl SnapshotResult {
    pub(crate) fn save_refmap(&self, store: &RefStore) -> Result<String, AppError> {
        if self.complete {
            store.save_new_snapshot(&self.refmap)
        } else {
            store.save_new_snapshot_detached(&self.refmap)
        }
    }

    pub(crate) fn bind_snapshot_id(&mut self, snapshot_id: String) {
        crate::refs::ref_token::qualify_tree_refs(&mut self.tree, &snapshot_id);
        self.snapshot_id = Some(snapshot_id);
    }
}

pub fn build(
    adapter: &dyn PlatformAdapter,
    opts: &TreeOptions,
    app_name: Option<&str>,
    window_id: Option<&str>,
    deadline: crate::Deadline,
) -> Result<SnapshotResult, AppError> {
    let windows = surface_windows(adapter, app_name, window_id, opts.surface, deadline)?;
    let (window, capture) = window_capture::first_surface_owner(windows, |window| {
        window_capture::capture_window(adapter, opts, window, deadline)
    })?;
    let result = allocate_capture(opts, window, capture)?;
    if result.visible_scope || !result.refmap.exceeds_size_limit() {
        return Ok(result);
    }
    // The record of this capture is too large to save, so none of its refs
    // could be used: read the visible elements instead. When the window is
    // not read that way, or that read cannot finish, the capture stays as it
    // was and fails to save as before.
    let Some(visible) = window_capture::capture_visible(adapter, opts, &result.window, deadline)
    else {
        return Ok(result);
    };
    let narrowed = allocate_capture(opts, result.window.clone(), visible)?;
    if narrowed.refmap.exceeds_size_limit() {
        return Ok(result);
    }
    Ok(narrowed)
}

/// Allocates the refs of one window capture and builds the snapshot of it.
pub(crate) fn allocate_capture(
    opts: &TreeOptions,
    window: WindowInfo,
    capture: window_capture::WindowCapture,
) -> Result<SnapshotResult, AppError> {
    let identity_unproven = capture.identity_unproven.clone();
    let visible_scope = capture.visible_scope;
    let (raw_tree, complete, nodes_observed, observed) = capture.into_parts()?;
    // A view of the visible elements is never the whole window.
    let complete = complete && !visible_scope;
    let capture_proof = crate::refs::ref_capture_proof::CaptureProof::new(&observed);

    let mut refmap = RefMap::new();
    let config = RefAllocConfig {
        options: RefAllocOptions {
            include_bounds: opts.include_bounds,
            interactive_only: opts.interactive_only,
            compact: opts.compact,
            force_renderer_accessibility: opts.force_renderer_accessibility,
        },
        source: RefAllocSource {
            pid: window.pid,
            app: Some(window.app.as_str()),
            window_id: (!window.is_process_owner()).then_some(window.id.as_str()),
            window_title: Some(window.title.as_str()),
            window_bounds_hash: window.bounds.as_ref().and_then(crate::Rect::bounds_hash),
            process_instance: window.process_instance.as_deref(),
            surface: opts.surface,
        },
        scope: RefAllocScope {
            root_ref_id: None,
            path_prefix: &[],
        },
        capture: Some(&capture_proof),
    };
    let mut tree = ref_alloc::allocate_refs(raw_tree, &mut refmap, &config)?;
    if let Some(nodes) = observed.settled_thin_nodes() {
        refmap.record_settled_thin_tree(nodes, None);
    }

    crate::snapshot::hints::add_structural_hints(&mut tree);

    Ok(SnapshotResult {
        tree,
        refmap,
        window,
        snapshot_id: None,
        complete,
        nodes_observed,
        identity_unproven,
        visible_scope,
    })
}

/// Resolves the window that identifies the process to observe. An app-level
/// surface is not owned by a single window, so several open windows must not be
/// reported as ambiguous when one is requested.
///
/// Kinds naming OS chrome rather than a window's own sub-surface are routed to
/// the adapter's `resolve_shell_surface` seam ahead of the application path,
/// because no application owns them and the window inventory cannot identify
/// them - not even a recorded or requested window id, which a shell container
/// carries too. An adapter that answers with the trait default falls through to
/// the application path, so an adapter's shape never changes by upgrading; every
/// other answer - a missing surface, a build refusal, a timeout - is returned
/// as the adapter supplied it, and a surface that answers with another window
/// leaves the id to the application path.
///
/// `menu-bar-extras` with an app name is that app's own status item and takes the
/// application path, where a background app that lists no window is read through its process.
pub(crate) fn resolve_window_for_surface(
    adapter: &dyn PlatformAdapter,
    app_name: Option<&str>,
    window_id: Option<&str>,
    surface: crate::SnapshotSurface,
    deadline: crate::Deadline,
) -> Result<WindowInfo, AppError> {
    let app_status_item = app_name.is_some() && surface == crate::SnapshotSurface::MenuBarExtras;
    if is_shell_surface(surface) && !app_status_item {
        match adapter.resolve_shell_surface(surface, deadline) {
            Ok(window) if window_id.is_none_or(|id| window.id == id) => return Ok(window),
            Ok(_) => {}
            Err(error)
                if window_id.is_none()
                    && !error.is_default_not_supported("resolve_shell_surface") =>
            {
                return Err(error.into());
            }
            Err(_) => {}
        }
    }
    if window_id.is_some() || (surface == crate::SnapshotSurface::Window && app_name.is_none()) {
        return resolve_window(adapter, app_name, window_id, deadline);
    }
    let windows = windows_for_app(adapter, app_name, deadline)?;
    if let (true, Some(app)) = (windows.is_empty() && is_process_surface(surface), app_name) {
        return crate::system::app_lookup::windowless_app_owner(adapter, app, deadline);
    }
    if let (crate::SnapshotSurface::Window, Some(app)) = (surface, app_name) {
        return select_app_window(windows, app);
    }
    crate::system::window_lookup::select_surface_owner(
        windows,
        crate::AdapterError::new(
            crate::ErrorCode::WindowNotFound,
            format!(
                "No window found to identify the application owning surface '{}'",
                surface.as_str()
            ),
        ),
    )
}

/// Whether the surface names OS chrome rather than a window's own sub-surface:
/// the kinds an adapter may resolve directly, with no owning application and
/// no window in the inventory. Derived from the [`SnapshotSurface`] variant
/// alone - never from a platform check - so the seam stays platform-neutral.
fn is_shell_surface(surface: crate::SnapshotSurface) -> bool {
    matches!(
        surface,
        crate::SnapshotSurface::StartMenu
            | crate::SnapshotSurface::Taskbar
            | crate::SnapshotSurface::SystemTray
            | crate::SnapshotSurface::SystemTrayOverflow
            | crate::SnapshotSurface::ActionCenter
            | crate::SnapshotSurface::QuickSettings
            | crate::SnapshotSurface::Dock
            | crate::SnapshotSurface::MenuBarExtras
    )
}

/// Surfaces a background app with no window still presents, read from its
/// process; the owner then carries an empty window id.
fn is_process_surface(surface: crate::SnapshotSurface) -> bool {
    matches!(
        surface,
        crate::SnapshotSurface::Window
            | crate::SnapshotSurface::Menubar
            | crate::SnapshotSurface::MenuBarExtras
    )
}

fn select_app_window(windows: Vec<WindowInfo>, app: &str) -> Result<WindowInfo, AppError> {
    crate::system::window_lookup::select_window(
        windows,
        crate::AdapterError::app_has_no_window(app),
        "More than one window matches the target",
    )
}

pub(crate) fn surface_windows(
    adapter: &dyn PlatformAdapter,
    app_name: Option<&str>,
    window_id: Option<&str>,
    surface: crate::SnapshotSurface,
    deadline: crate::Deadline,
) -> Result<Vec<WindowInfo>, AppError> {
    use crate::SnapshotSurface::{Alert, Popover, Sheet};
    if window_id.is_none() && matches!(surface, Sheet | Popover | Alert) {
        let mut windows = match app_name {
            Some(_) => windows_for_app(adapter, app_name, deadline)?,
            None => frontmost_process_windows(adapter, surface, deadline)?,
        };
        windows.retain(|window| window.state.accessible);
        let windows = crate::system::window_lookup::surface_owner_order(windows);
        if !windows.is_empty() {
            return Ok(windows);
        }
    }
    Ok(vec![resolve_window_for_surface(
        adapter, app_name, window_id, surface, deadline,
    )?])
}

fn frontmost_process_windows(
    adapter: &dyn PlatformAdapter,
    surface: crate::SnapshotSurface,
    deadline: crate::Deadline,
) -> Result<Vec<WindowInfo>, AppError> {
    let owner = resolve_window_for_surface(adapter, None, None, surface, deadline)?;
    let mut windows = windows_for_app(adapter, Some(owner.app.as_str()), deadline)?;
    windows.retain(|window| window.pid == owner.pid);
    if windows.is_empty() {
        windows.push(owner);
    }
    Ok(windows)
}

fn windows_for_app(
    adapter: &dyn PlatformAdapter,
    app_name: Option<&str>,
    deadline: crate::Deadline,
) -> Result<Vec<WindowInfo>, AppError> {
    let filter = WindowFilter {
        focused_only: app_name.is_none(),
        app: app_name.map(str::to_string),
    };
    Ok(adapter.list_windows(&filter, deadline)?)
}

/// The guidance for a window id that names no window any more. A window can
/// close on its own, and the one a launch reports is sometimes a splash
/// screen the app closes once its main window opens.
pub(crate) const WINDOW_GONE_SUGGESTION: &str = "Run 'list-windows' to see the windows open now \
     and retry with a current ID. A window can close on its own: the one a launch reported may \
     have been a splash screen replaced by the app's main window.";

pub(crate) fn resolve_window(
    adapter: &dyn PlatformAdapter,
    app_name: Option<&str>,
    window_id: Option<&str>,
    deadline: crate::Deadline,
) -> Result<WindowInfo, AppError> {
    let filter = WindowFilter {
        focused_only: app_name.is_none() && window_id.is_none(),
        app: app_name.map(str::to_string),
    };

    let windows = adapter.list_windows(&filter, deadline)?;

    if let Some(wid) = window_id {
        windows.into_iter().find(|w| w.id == wid).ok_or_else(|| {
            AppError::Adapter(
                crate::AdapterError::new(
                    crate::ErrorCode::WindowNotFound,
                    format!("No window with id {wid}"),
                )
                .with_suggestion(WINDOW_GONE_SUGGESTION)
                .unsent(),
            )
        })
    } else if let Some(app) = app_name {
        if windows.is_empty() {
            if let Err(AppError::Adapter(error)) =
                crate::system::app_lookup::resolve_app(Some(app), adapter, deadline)
            {
                if error.code == crate::ErrorCode::AppNotFound {
                    return Err(AppError::Adapter(error));
                }
            }
        }
        select_app_window(windows, app)
    } else {
        crate::system::window_lookup::select_window(
            windows,
            crate::AdapterError::new(crate::ErrorCode::WindowNotFound, "No focused window found"),
            "More than one window matches the target",
        )
    }
}

#[cfg(test)]
pub fn run(
    adapter: &dyn PlatformAdapter,
    opts: &TreeOptions,
    app_name: Option<&str>,
    window_id: Option<&str>,
) -> Result<SnapshotResult, AppError> {
    run_with_context(
        adapter,
        opts,
        &SnapshotTarget {
            app_name,
            window_id,
        },
        &CommandContext::default(),
        DEFAULT_SNAPSHOT_TIMEOUT_MS,
    )
}

/// Which window a full snapshot targets: the focused window when both fields
/// are `None`, a named app's focused window, or an exact window id.
pub struct SnapshotTarget<'a> {
    pub app_name: Option<&'a str>,
    pub window_id: Option<&'a str>,
}

/// The default snapshot observation deadline.
///
/// A16-11 measured a cold Chromium settle at 10-25 s against the previous
/// hardcoded 3 s, so callers can raise it explicitly via `--timeout-ms`; the
/// default stays 3 s for the ecosystems that settle fast.
pub const DEFAULT_SNAPSHOT_TIMEOUT_MS: u64 = 3_000;

/// Runs a full snapshot for `target` and persists its refmap under
/// `context`'s session, using `timeout_ms` as the observation deadline
/// (`DEFAULT_SNAPSHOT_TIMEOUT_MS` for callers with no reason to raise it).
pub fn run_with_context(
    adapter: &dyn PlatformAdapter,
    opts: &TreeOptions,
    target: &SnapshotTarget,
    context: &CommandContext,
    timeout_ms: u64,
) -> Result<SnapshotResult, AppError> {
    let mut result = build(
        adapter,
        opts,
        target.app_name,
        target.window_id,
        crate::Deadline::after(timeout_ms)?,
    )?;
    let store = RefStore::for_session(context.session_id())?;
    let snapshot_id = result.save_refmap(&store)?;
    trace_artifacts::copy_refmap_if_full(context, &store, &snapshot_id, &result.refmap)?;
    result.bind_snapshot_id(snapshot_id);
    emit_snapshot_saved(context, &result)?;
    Ok(result)
}

pub(crate) fn emit_snapshot_saved(
    context: &CommandContext,
    result: &SnapshotResult,
) -> Result<(), AppError> {
    context.trace_lazy("snapshot.saved", || {
        let mut fields = json!({
            "snapshot_id": result.snapshot_id,
            "ref_count": result.refmap.len(),
        });
        if !result.window.app.is_empty() {
            fields["app"] = json!(result.window.app);
        }
        if let Some(reason) = &result.identity_unproven {
            fields["identity_unproven"] = json!(reason);
        }
        fields
    })
}

pub mod hints;
pub mod menu_bar;
pub mod snapshot_ref;
pub mod snapshot_surface;
#[cfg(test)]
#[path = "snapshot_tests.rs"]
mod tests;
pub(crate) mod window_capture;

#[cfg(test)]
#[path = "tokenless_capture_support.rs"]
mod tokenless_capture_support;

#[cfg(test)]
#[path = "tokenless_capture_tests.rs"]
mod tokenless_capture_tests;

#[cfg(test)]
#[path = "oversized_capture_tests.rs"]
mod oversized_capture_tests;

#[cfg(test)]
#[path = "tokenless_drill_tests.rs"]
mod tokenless_drill_tests;

#[cfg(test)]
#[path = "snapshot_deadline_tests.rs"]
mod deadline_tests;

#[cfg(test)]
#[path = "snapshot_window_tests.rs"]
mod window_tests;

#[cfg(test)]
#[path = "snapshot_surface_window_tests.rs"]
mod surface_window_tests;
