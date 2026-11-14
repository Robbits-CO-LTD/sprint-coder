// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! A find over a window too large to search whole in time answers from the
//! elements the window shows, as a snapshot of such a window does.
//!
//! The answer is a snapshot of the visible elements (the same read, the same
//! allocation and the same proof, `proven_in_view`), with the query evaluated
//! over that read as a whole-window find evaluates it: its refs act only while
//! the view stays as it is, exactly like the refs of that snapshot, and nothing
//! here proves a ref any other way.
use super::{FindArgs, LOCATOR_TIMEOUT};
use crate::{
    AccessibilityNode, AppError, Deadline, LocatorQuery, WindowInfo,
    adapter::{PlatformAdapter, TreeOptions},
    context::CommandContext,
    locator::live_locator::{
        LocatorMaterialization, LocatorResolution, LocatorResolveRequest, ObservationRequest,
        ObservationRoot, ObservedObservation, ObservedTree, evaluate_locator_tree,
        observation_deadline, resolve_query_from,
    },
    refs::refs_store::RefStore,
    snapshot::{self, SnapshotResult},
    trace::trace_artifacts,
};
use serde_json::{Value, json};
use std::time::Duration;

/// The most the probe that asks whether the window is read by its visible
/// elements may take. It reads the window's root alone; a probe that does not
/// answer in this time counts as "not read that way", which leaves the whole
/// search its full deadline, as before.
const PROBE_CAP: Duration = Duration::from_millis(500);

/// Whether this find answers from the visible elements of `window` when its
/// whole-window search does not finish: a find of that shape
/// ([`answers_in_view`]), under at least the default deadline
/// ([`view_allowed`]), of a window the adapter reads that way.
///
/// The window is asked first, by a read of its root alone, so that a window not
/// read that way (anything not Chromium-hosted, as the adapter decides) keeps
/// its whole-window search exactly as before ([`search_whole`] is only used
/// for a window that is).
pub(super) fn plan(
    args: &FindArgs,
    adapter: &dyn PlatformAdapter,
    window: &WindowInfo,
    deadline: Deadline,
) -> bool {
    answers_in_view(args) && view_allowed(deadline) && reads_view(adapter, window, deadline)
}

/// Whether a find of this shape may answer from the visible elements: a search
/// of the whole window (no `--root`, no `--surface`) that lists matches or
/// takes the first. A count, a last match or an n-th match is a question about
/// the whole window, which the visible elements alone would answer wrong, so
/// those keep the whole-window search and its timeout.
pub(super) fn answers_in_view(args: &FindArgs) -> bool {
    args.root.is_none()
        && args.surface == crate::SnapshotSurface::Window
        && !args.selection.count
        && !args.selection.last
        && args.selection.nth.is_none()
}

/// Whether the find may fall back to the visible elements: only when its
/// deadline is at least the default one. A caller that shortens the deadline
/// cannot push a window that a default find searches whole onto the narrower
/// proof; it gets the timeout instead, as before.
pub(super) fn view_allowed(deadline: Deadline) -> bool {
    deadline.span() >= LOCATOR_TIMEOUT
}

/// The whole-window search of a find that may answer from the view.
///
/// It runs as every whole-window search does, under the find's full deadline,
/// and its observation gets the time it always got: the deadline less what a
/// search keeps for reading its selected matches (`observation_deadline`, 1 s
/// of the default 5 s). The one difference is what happens once that time has
/// passed without an answer: this search starts no further observation, so
/// that time is left for the read of the visible elements rather than spent on
/// another observation of a window that could not be read whole in time. A
/// search that finishes within that time answers exactly as before, so a window
/// that a find searched whole before is still searched whole.
pub(super) fn search_whole(
    adapter: &dyn PlatformAdapter,
    query: &LocatorQuery,
    window: &WindowInfo,
    request: &LocatorResolveRequest,
) -> Result<LocatorResolution, AppError> {
    let observe_until = observation_deadline(request);
    let root = ObservationRoot::Window(window);
    resolve_query_from(adapter, query, request, |deadline| {
        if observe_until.is_expired() {
            return Err(AppError::Adapter(observe_until.timeout_error()));
        }
        let deadline = deadline.capped(observe_until.remaining());
        let observation =
            ObservationRequest::locator_for_root(query, request, root, deadline).validate()?;
        crate::tree::renderer_accessibility::observe_tree(adapter, root, &observation, None)
            .map(ObservedObservation::whole)
    })
}

/// Whether the adapter reads this window by its visible elements, asked with a
/// read of the window's root alone. An adapter that does not read a window
/// that way refuses before it reads anything.
fn reads_view(adapter: &dyn PlatformAdapter, window: &WindowInfo, deadline: Deadline) -> bool {
    let options = TreeOptions {
        max_depth: 0,
        ..TreeOptions::default()
    };
    let Ok(mut request) =
        ObservationRequest::snapshot(&options, deadline.capped(PROBE_CAP)).validate()
    else {
        return false;
    };
    request.observation_mode.visible_only = true;
    crate::tree::renderer_accessibility::observe_tree(
        adapter,
        ObservationRoot::Window(window),
        &request,
        None,
    )
    .is_ok_and(|observed| observed.is_visible_scope())
}

/// The options of the snapshot of the visible elements a find answers from:
/// those of a default snapshot, presented to the full depth a find searches.
fn view_options() -> TreeOptions {
    TreeOptions {
        max_depth: crate::refs::resolve_saved_ref::WHOLE_WINDOW_DEPTH,
        ..TreeOptions::default()
    }
}

/// A find answered from the window's visible elements: the snapshot of them
/// (its refs and their proof), and the query evaluated over the observation that
/// snapshot was allocated from.
pub(super) struct View {
    snapshot: SnapshotResult,
    /// The observation, as read: the query was evaluated over it, and it maps
    /// each matched node to the ref the snapshot allocated for that node.
    observed: ObservedTree,
    resolution: LocatorResolution,
}

/// The snapshot of the window's visible elements, read in what is left of
/// `deadline`, with the query evaluated over the same observation, or `None`
/// when the window is not read that way, the read does not complete in time,
/// the query cannot be answered over it, or its record would be too large to
/// keep. The caller then reports the whole-window search's own failure.
///
/// The query is evaluated by the evaluator a whole-window find runs, over the
/// observed evidence (an empty value that was read stays apart from one not
/// reported, and every identifier counts), never over the tree a snapshot
/// presents. The record of refs is that of a default snapshot of the view, so
/// its size, its matching and its proof are those of such a snapshot.
pub(super) fn read_view(
    args: &FindArgs,
    query: &LocatorQuery,
    adapter: &dyn PlatformAdapter,
    window: &WindowInfo,
    deadline: Deadline,
) -> Result<Option<View>, AppError> {
    let options = view_options();
    let Some(capture) =
        snapshot::window_capture::capture_visible(adapter, &options, window, deadline)
    else {
        return Ok(None);
    };
    // Taken before the snapshot is allocated, which moves fields out of it.
    let observed = capture.observed.clone();
    let request = LocatorResolveRequest {
        materialization: LocatorMaterialization::None,
        ..super::resolve_request(args, deadline)
    };
    let resolution = evaluate_locator_tree(observed.clone(), query, &request)?;
    if !resolution.meta.selection_complete {
        return Ok(None);
    }
    let snapshot = snapshot::allocate_capture(&options, window.clone(), capture)?;
    if !snapshot.visible_scope || snapshot.refmap.exceeds_size_limit() {
        return Ok(None);
    }
    Ok(Some(View {
        snapshot,
        observed,
        resolution,
    }))
}

/// Saves the snapshot of the visible elements as a snapshot of them is saved,
/// and answers the find from it in the shape a whole-window find answers,
/// marked as covering those elements only.
pub(super) fn respond(
    args: &FindArgs,
    query: &LocatorQuery,
    context: &CommandContext,
    view: View,
) -> Result<Value, AppError> {
    let View {
        snapshot: mut view,
        observed,
        resolution,
    } = view;
    let store = RefStore::for_session(context.session_id())?;
    let snapshot_id = view.save_refmap(&store)?;
    trace_artifacts::copy_refmap_if_full(context, &store, &snapshot_id, &view.refmap)?;
    view.bind_snapshot_id(snapshot_id.clone());

    let refs = refs_by_node(&observed, &view.tree);
    let meta = resolution.meta;
    context.trace_lazy("locator.resolve", || {
        json!({
            "complete": false,
            "scope": "visible",
            "match_count": meta.total_matches,
            "ref_count": view.refmap.len(),
            "snapshot_id": snapshot_id,
        })
    })?;
    // As a whole-window find: a match with a ref carries it, one without
    // carries its rectangle on screen instead (`format_match`).
    let matches = resolution
        .matches
        .into_iter()
        .map(|found| {
            let mut data = found.data;
            data.ref_id = refs.get(found.document_order as usize).cloned().flatten();
            data.interactive = data.ref_id.is_some();
            super::format_match(data, found.screen_bounds)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut response = if args.selection.first {
        super::single_match_response(matches.into_iter().next(), query, meta.roles_present)
    } else {
        let is_empty = matches.is_empty();
        let mut response = json!({
            "matches": matches,
            "total_matches": meta.total_matches,
            "truncated": meta.truncated,
        });
        super::attach_roles_present(&mut response, is_empty, query, meta.roles_present);
        response
    };
    super::attach_snapshot_id(&mut response, Some(&snapshot_id));
    let found_any = match response.get("matches") {
        Some(listed) => listed.as_array().is_some_and(|listed| !listed.is_empty()),
        None => !response["match"].is_null(),
    };
    response["scope"] = json!("visible");
    response["scope_hint"] = json!(if found_any {
        VISIBLE_MATCHES_HINT
    } else {
        VISIBLE_NO_MATCH_HINT
    });
    Ok(response)
}

/// What a find answered from the visible elements tells its reader when it
/// found matches.
pub(super) const VISIBLE_MATCHES_HINT: &str = "The window has too many elements to search whole in time, so only the elements it shows on screen were searched: matches scrolled out of view are not listed, and total_matches counts the shown ones only. These refs work only while the view stays as it is: after scrolling, or when the window changes, run find again and use the new refs.";

/// What a find answered from the visible elements tells its reader when
/// nothing shown matched. It must not read as "the window has no such element".
pub(super) const VISIBLE_NO_MATCH_HINT: &str = "No element shown on screen matches. The window has too many elements to search whole in time, so only the elements it shows on screen were searched: this does not mean the window has no such element. Scroll the part of the window that may hold it into view, then run find again. If almost nothing is shown, the window is probably covered by another window, which makes it report its elements as off screen: bring it forward, then run find again.";

/// The ref the snapshot allocated for each observed node, by node index.
///
/// That a ref lands on its own node rests on how the presented tree is built,
/// not on the proof of a view (`proven_in_view` only says a ref names the node
/// it was allocated for). `ObservedTree::project_window` (through
/// `project_shallow`) presents one node per observed node, with the observed
/// children in their order (a node cut at the depth limit keeps none), and
/// `ref_alloc::allocate_refs` keeps every child in place because
/// [`view_options`] leaves `compact` and `interactive_only` off. The two trees
/// are walked together on that rule. A mismatch it can see (a role or a child
/// count differs) leaves everything below unpaired, so a match there carries
/// no ref; a swap between nodes of one shape would not be seen, which is why
/// the presentation must keep that order.
fn refs_by_node(observed: &ObservedTree, presented: &AccessibilityNode) -> Vec<Option<String>> {
    fn pair(
        observed: &ObservedTree,
        index: usize,
        presented: &AccessibilityNode,
        refs: &mut [Option<String>],
    ) {
        let Some(node) = observed.nodes.get(index) else {
            return;
        };
        let role = node.evidence.role.known().map_or("unknown", String::as_str);
        if role != presented.role {
            return;
        }
        refs[index].clone_from(&presented.ref_id);
        if presented.children.len() != node.children.len() {
            return;
        }
        for (child, presented_child) in node.children.iter().zip(&presented.children) {
            pair(observed, *child as usize, presented_child, refs);
        }
    }
    let mut refs = vec![None; observed.nodes.len()];
    if let [root] = observed.roots.as_slice() {
        pair(observed, *root as usize, presented, &mut refs);
    }
    refs
}

#[cfg(test)]
#[path = "find_view_tests.rs"]
mod tests;
