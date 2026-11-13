// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use std::time::{Duration, Instant};

use agent_desktop_core::{
    AdapterError, Deadline, ErrorCode, ObservationRequest, ObservationRoot, ObservedTree,
    ProcessId, ProcessIdentity,
};
use serde_json::json;

use super::chromium;
use super::surfaces::surface_root;
use super::walk::walker::{DEFAULT_MAX_RAW_DEPTH, WalkBudget, WalkOutcome};
use super::walk::walker_source::{walk_uia_subtree_for, walk_uia_visible_subtree};

/// Runs one observation: resolve the root, walk it, detect a Chromium shell,
/// and report completeness honestly.
///
/// The walk itself already produces honest boundaries: at a logical or raw
/// depth boundary it has already enumerated the full child list (bounded by
/// the sibling and deadline budgets), so `children_count` is the real count and
/// `subtree_truncated` records that descendants were not walked - the two flags
/// set independently (a boundary node may carry a count with
/// `subtree_truncated: true`). A deadline-starved walk reports the partial
/// tree it observed with `complete: false`, never as a discard.
///
/// This function adds what the walk cannot decide for itself:
///
/// 1. **Enumeration-failure surfacing**: a walk with real faults returns a
///    structured error, never a silently-truncated success.
/// 2. **Liveness-checked observation**: complete and partial trees are only
///    returned after the root's stored identity re-verifies live.
/// 3. **Chromium shell detection**: a full-depth walk of a detected Chromium
///    root that lands on the pre-activation shell returns the
///    activation-required error, which core's loop settles and retries. The
///    marker keeps being returned - re-arming core's retry loop - for as
///    long as the deadline still has room for another walk of the shape
///    just measured; only once that room runs out does a still-thin tree
///    return the plain guidance error core's loop treats as final. A thin
///    tree whose documents hold content and that keeps its size across walks
///    for [`THIN_TREE_SETTLE`] after this observation's settle is the window's
///    whole tree (a genuinely small page) and is returned as observed,
///    whatever the deadline still holds. The
///    "settle already ran" state is scoped per process, so a batch or
///    session observing several processes through one adapter gives every
///    process its own settle rather than the first process's activation
///    suppressing every later one. When the caller already forced renderer
///    accessibility (`--force-electron-a11y`), the adapter still reverifies
///    the root is live before returning the observed tree instead of the
///    guidance error - the flag's contract is to skip activation guidance,
///    not liveness.
pub(crate) fn observe_tree(
    root: ObservationRoot<'_>,
    request: &ObservationRequest,
    adapter: &crate::adapter::WindowsAdapter,
) -> Result<ObservedTree, AdapterError> {
    let request = (*request).validate()?;
    re_verify_root(root)?;
    let element = surface_root(root, request.surface, request.deadline)?;
    let chromium_root = chromium::is_chromium_root(&element);
    let budget = WalkBudget::new(request.max_logical_depth, request.deadline)
        .with_max_raw_depth(request.max_raw_depth.min(DEFAULT_MAX_RAW_DEPTH));
    let visible_only = request.observation_mode.visible_only;
    // Only a Chromium-hosted window is read by its visible elements: its
    // provider reports what scrolled out of view, measured on such windows.
    if visible_only && !chromium::has_chromium_provenance(&element) {
        return Err(AdapterError::new(
            ErrorCode::ActionNotSupported,
            "Reading only the visible elements is supported for Chromium-hosted windows",
        ));
    }
    let walk_started = Instant::now();
    let outcome = if visible_only {
        walk_uia_visible_subtree(&element, &root, budget)?
    } else {
        walk_uia_subtree_for(
            &element,
            &root,
            budget,
            request.observation_mode.identity_only,
        )?
    };
    let mut observed = finish_observation(
        root,
        request,
        adapter,
        CompletedWalk {
            chromium_root,
            outcome,
            walk_duration: walk_started.elapsed(),
        },
        re_verify_root,
    )?;
    if visible_only {
        observed.mark_visible_scope();
    }
    Ok(observed)
}

/// The walk's own output, grouped so `finish_observation` stays within the
/// project's parameter limit - the shell/settle decision below reads all
/// three together and none of them means anything without the others.
struct CompletedWalk {
    chromium_root: bool,
    outcome: WalkOutcome,
    walk_duration: Duration,
}

/// Everything the walk cannot decide for itself, applied to an
/// already-completed [`WalkOutcome`].
///
/// Split out of `observe_tree` so the decision logic - the shell/settle
/// handling and the liveness gate - can be driven directly from a synthetic
/// walk outcome and a fake liveness check, the same way `walker_fake` lets
/// the walker's own correctness branches run without a live UI Automation
/// provider. `observe_tree` supplies the real walk and `re_verify_root`;
/// tests supply a canned outcome and a closure that fails on demand.
fn finish_observation(
    root: ObservationRoot<'_>,
    request: ObservationRequest,
    adapter: &crate::adapter::WindowsAdapter,
    walk: CompletedWalk,
    verify_root: impl FnOnce(ObservationRoot<'_>) -> Result<(), AdapterError>,
) -> Result<ObservedTree, AdapterError> {
    if !walk.outcome.failures.is_empty() {
        return Err(walk_fault_error(&walk.outcome.failures));
    }
    verify_root(root)?;
    // A read of the visible elements alone is small by design and is only
    // asked for after a populated tree was seen, so it is never taken for the
    // pre-activation shell.
    let shell_shaped = !request.observation_mode.visible_only
        && walk.outcome.tree.is_complete()
        && walk.chromium_root
        && chromium::activation_eligible(root, &request)
        && chromium::is_shell_shaped(&walk.outcome.stats, &request);
    if shell_shaped {
        if request.observation_mode.force_renderer_accessibility {
            return Ok(walk.outcome.tree);
        }
        let nodes = walk.outcome.stats.traversal.nodes_visited;
        let content = walk.outcome.tree.has_document_content();
        let settled = |mut tree: ObservedTree| {
            tree.mark_settled_thin_tree(nodes);
            Ok(tree)
        };
        if content && is_recorded_settled_tree(request.observation_mode.settled_thin_nodes, nodes) {
            return settled(walk.outcome.tree);
        }
        // The walk that just ran confirms its size from when it started, so the
        // span the size held is measured to the walk's start, never its end.
        let walk_started = Instant::now()
            .checked_sub(walk.walk_duration)
            .unwrap_or_else(Instant::now);
        if thin_tree_settled(
            request
                .observation_mode
                .settle
                .map(|settle| thin_walk(settle, walk_started)),
            nodes,
            content,
        ) {
            return settled(walk.outcome.tree);
        }
        let process = root_process_identity(root);
        if !adapter.renderer_activation_attempted(&process)
            || has_room_for_another_walk(request.deadline, walk.walk_duration)
        {
            return Err(chromium::activation_required(&walk.outcome.stats));
        }
        return Err(still_thin_after_settle());
    }
    Ok(walk.outcome.tree)
}

/// How long a thin tree with published content must keep one size, within
/// this observation's settle, to be taken for the window's whole tree. A small
/// page (25 elements in a test window) walks under the shell ceiling forever,
/// so without this the settle loop re-walked it until the deadline ran out (38
/// walks under a 20 s snapshot, every one 25 nodes) and the read was never
/// complete. A shell never passes, whatever the time: its documents hold no
/// content ([`ObservedTree::has_document_content`]). The span covers a
/// renderer that published part of a page and the rest later: a size change
/// restarts it. Cold windows were measured publishing 0.25 to 0.6 s after
/// their first walk, a spread of about 0.35 s, so the span is set past it.
/// It is measured between walks (from the end of the first walk at the size to
/// the start of the latest), which can only understate how long the size held.
/// It is fixed, not a share of the deadline.
///
/// This is a measured rule of thumb, not a guarantee: a renderer that
/// published part of a page, held that size for the whole span, and published
/// the rest afterwards is taken for complete. A page whose second half arrives
/// while the settle is still running is caught by the size change (or, before
/// any content, by the content check), which is what the two-step test pages
/// showed.
pub(crate) const THIN_TREE_SETTLE: Duration = Duration::from_millis(500);

/// One thin walk past this observation's settle: how long its size has held
/// (from the end of the first walk at that size to the start of this one;
/// zero when this walk is the first), and the size of the walk before it
/// (`None` for the first).
#[derive(Clone, Copy, Debug)]
struct ThinWalk {
    held: Duration,
    previous_nodes: Option<u64>,
}

fn thin_walk(settle: agent_desktop_core::SettleProgress, walk_started: Instant) -> ThinWalk {
    ThinWalk {
        held: settle.stable_since.map_or(Duration::ZERO, |since| {
            walk_started.saturating_duration_since(since)
        }),
        previous_nodes: settle.previous_thin_nodes,
    }
}

/// Whether a thin walk is the window's whole tree: its documents hold
/// published content, its walk before this one, past this observation's
/// settle, had the same size, and that size has held for at least
/// [`THIN_TREE_SETTLE`]. Two equal walks close together do not pass, and a
/// size change starts the span over. Anything else waits.
fn thin_tree_settled(walk: Option<ThinWalk>, nodes: u64, content: bool) -> bool {
    content
        && walk
            .is_some_and(|walk| walk.previous_nodes == Some(nodes) && walk.held >= THIN_TREE_SETTLE)
}

/// Whether a thin walk is the settled small tree a capture of this same
/// window recorded (core hands the count over only when the ref's recorded
/// window id is the window being observed, in the capture's own process
/// generation; a ref without a window id, or another window of the process,
/// gets nothing): it must come back at exactly that count, and with published
/// content (checked by the caller). A renderer that dropped its tree back to
/// the shell walks at the shell's count (19 on a cold Electron test window,
/// against 25 settled) and holds no content, and is settled as usual.
///
/// Accepted limits: a window that navigated to another page which happens to
/// have the same count and content skips the settle wait too, and a count
/// recorded from a partly published page that stood still past the settle is
/// trusted again by later resolves of that capture's refs. Neither weakens a
/// ref's proof: the resolve still has to find the recorded part exactly once
/// in the tree it read, and the landing is matched by RuntimeId.
fn is_recorded_settled_tree(recorded: Option<u64>, nodes: u64) -> bool {
    recorded == Some(nodes)
}

/// A walk this small can complete near-instantly under a test double, and a
/// deadline this thin is not enough runway for a genuine retry regardless of
/// what the last walk measured - this floors the estimate.
const MIN_WALK_ESTIMATE: Duration = Duration::from_millis(5);

/// Whether the remaining deadline can still absorb another walk of the shape
/// that was just measured.
///
/// Core's loop (`crates/core/src/tree/renderer_accessibility.rs`) retries
/// `observe_tree` on every activation-required error with a 25-400ms
/// backoff, so returning the marker here for as long as there is room turns
/// the settle from a single guess into a real wait for the async Chromium
/// accessibility build a cold start needs. The walk that just ran is the
/// cheapest available estimate of what another attempt costs.
fn has_room_for_another_walk(deadline: Deadline, last_walk: Duration) -> bool {
    deadline.remaining() > last_walk.max(MIN_WALK_ESTIMATE)
}

/// The activation-attempted key for a root: its process, scoped by the
/// process-instance token (the generation the identity check already reads)
/// so a recycled pid never inherits another process's settle state.
fn root_process_identity(root: ObservationRoot<'_>) -> ProcessIdentity {
    match root {
        ObservationRoot::Window(window) => ProcessIdentity::new(
            window.pid,
            window.process_instance.clone().unwrap_or_default(),
        ),
        ObservationRoot::Element { entry, .. } => ProcessIdentity::new(
            entry.process.pid,
            entry.process.process_instance.clone().unwrap_or_default(),
        ),
    }
}

/// The post-settle still-thin error: **not** marked activation-required,
/// so it escapes core's loop and reaches the caller - a Chromium tree that
/// genuinely stays thin after the async build has the guidance `platform_detail`
/// and no target-derived text.
fn still_thin_after_settle() -> AdapterError {
    agent_desktop_core::AdapterError::new(
        ErrorCode::ActionFailed,
        "The Chromium tree is still thin after its accessibility build settled",
    )
    .with_platform_detail(chromium::still_thin_detail())
}

/// Rechecks stored ownership and generation evidence after the UIA read.
fn re_verify_root(root: ObservationRoot<'_>) -> Result<(), AdapterError> {
    match root {
        ObservationRoot::Window(window) => {
            let handle = hwnd_of(&window.id)?;
            let evidence =
                crate::system::window::window_identity::WindowIdentityEvidence::from_info(
                    handle as crate::system::window::window_enum::WindowHandle,
                    window,
                )
                .ok_or_else(window_identity_changed)?;
            evidence.verify_stored()
        }
        ObservationRoot::Element { entry, .. } => {
            verify_process_identity(entry.process.pid, entry.process.process_instance.as_deref())
        }
    }
}

/// Corroborates a root's process against its stored generation token,
/// fail-closed. A stored ref without a token can never be corroborated, so a
/// missing token never passes - it is evidence that must be present, not an
/// optional extra.
fn verify_process_identity(pid: ProcessId, instance: Option<&str>) -> Result<(), AdapterError> {
    match instance {
        Some(instance) => {
            if crate::system::process_identity::matches_instance(pid, instance)? {
                Ok(())
            } else {
                Err(window_identity_changed())
            }
        }
        None => Err(window_identity_changed()),
    }
}

fn hwnd_of(id: &str) -> Result<isize, AdapterError> {
    id.strip_prefix("w-")
        .and_then(|number| number.parse::<isize>().ok())
        .filter(|handle| *handle > 0)
        .ok_or_else(|| AdapterError::new(ErrorCode::InvalidArgs, "Malformed window identifier"))
}

fn window_identity_changed() -> AdapterError {
    AdapterError::new(
        ErrorCode::WindowNotFound,
        "The window's process changed during observation",
    )
    .with_suggestion("Run 'list-windows' to refresh window IDs, then retry.")
}

/// Builds the structured error a walk with real enumeration faults surfaces.
///
/// Shape only: each fault's kind, axis, depth, and child index - never an
/// application name or property value, because this error reaches trace
/// segments.
fn walk_fault_error(failures: &[AdapterError]) -> AdapterError {
    let faults: Vec<serde_json::Value> = failures
        .iter()
        .map(|failure| {
            failure
                .details
                .clone()
                .unwrap_or(json!({ "kind": "walk_fault" }))
        })
        .collect();
    AdapterError::new(
        ErrorCode::ActionFailed,
        "Element tree walk encountered an enumeration failure",
    )
    .with_details(json!({ "faults": faults }))
}

#[cfg(test)]
#[path = "observe_tests.rs"]
mod tests;
