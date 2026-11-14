// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! A find over a window too large to search whole in time answers from the
//! elements the window shows, as a snapshot of such a window does.
//!
//! The answer is a snapshot of the visible elements (the same read, the same
//! allocation and the same proof, `proven_in_view`), searched with the query:
//! its refs act only while the view stays as it is, exactly like the refs of
//! that snapshot, and nothing here proves a ref any other way.
use super::{FindArgs, LOCATOR_TIMEOUT};
use crate::{
    AccessibilityNode, AppError, Deadline, LocatorQuery, WindowInfo,
    adapter::{PlatformAdapter, TreeOptions},
    context::CommandContext,
    locator::live_locator::{LocatorMatchData, ObservationRequest, ObservationRoot},
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

/// How the whole-window search of one find runs.
pub(super) struct WholeAttempt {
    /// The deadline the whole-window search gets.
    pub(super) deadline: Deadline,
    /// Whether the find answers from the visible elements when that search
    /// runs out of time or reaches its read limit.
    pub(super) view: bool,
}

/// Plans the whole-window search: with the find's full deadline, unless this
/// find may answer from the visible elements ([`view_allowed`]) and the window
/// is read that way. Then the search gets [`whole_search_budget`] and the rest
/// stays for the read of the visible elements.
///
/// The window is asked first because a window not read that way (anything not
/// Chromium-hosted, as the adapter decides) must keep the whole deadline: a
/// search cut short there would end in a timeout with nothing to answer from.
pub(super) fn plan(
    args: &FindArgs,
    adapter: &dyn PlatformAdapter,
    window: &WindowInfo,
    deadline: Deadline,
) -> WholeAttempt {
    let whole = WholeAttempt {
        deadline,
        view: false,
    };
    if !answers_in_view(args) || deadline.span() < LOCATOR_TIMEOUT {
        return whole;
    }
    if !reads_view(adapter, window, deadline) {
        return whole;
    }
    let budget = whole_search_budget(deadline.remaining());
    if !view_allowed(deadline, budget) {
        return whole;
    }
    WholeAttempt {
        deadline: deadline.capped(budget),
        view: true,
    }
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

/// The time the whole-window search is given out of `remaining`: three
/// quarters of it, leaving the rest for the read of the visible elements
/// (about 0.4 s on a Chromium page of 5,000 rows). Under the default 5 s that
/// is 3.75 s.
///
/// Unlike a snapshot's whole read (`WHOLE_READ_CAP`), this is not capped: a
/// find records only its matches, so a whole search that finishes late still
/// answers with refs it can keep, and a caller who raised `--timeout-ms` gets
/// the whole-window answer it asked for whenever it comes in time.
pub(super) fn whole_search_budget(remaining: Duration) -> Duration {
    remaining * 3 / 4
}

/// Whether the find may fall back to the visible elements: only when its
/// deadline is at least the default one and the whole-window search was given
/// at least half of that. A caller that shortens the deadline cannot push a
/// window that a default find searches whole onto the narrower proof; it gets
/// the timeout instead, as before.
pub(super) fn view_allowed(deadline: Deadline, whole_budget: Duration) -> bool {
    deadline.span() >= LOCATOR_TIMEOUT && whole_budget >= LOCATOR_TIMEOUT / 2
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

/// The snapshot of the window's visible elements, read in what is left of
/// `deadline`, or `None` when the window is not read that way, the read does
/// not complete in time, or its record would be too large to keep. The caller
/// then reports the whole-window search's own failure.
pub(super) fn read_view(
    adapter: &dyn PlatformAdapter,
    window: &WindowInfo,
    deadline: Deadline,
) -> Result<Option<SnapshotResult>, AppError> {
    let options = view_options();
    let Some(capture) =
        snapshot::window_capture::capture_visible(adapter, &options, window, deadline)
    else {
        return Ok(None);
    };
    let result = snapshot::allocate_capture(&options, window.clone(), capture)?;
    if !result.visible_scope || result.refmap.exceeds_size_limit() {
        return Ok(None);
    }
    Ok(Some(result))
}

/// Saves the snapshot of the visible elements as a snapshot of them is saved,
/// and answers the find from it, marked as covering those elements only.
pub(super) fn respond(
    args: &FindArgs,
    query: &LocatorQuery,
    context: &CommandContext,
    mut view: SnapshotResult,
) -> Result<Value, AppError> {
    let store = RefStore::for_session(context.session_id())?;
    let snapshot_id = view.save_refmap(&store)?;
    trace_artifacts::copy_refmap_if_full(context, &store, &snapshot_id, &view.refmap)?;
    view.bind_snapshot_id(snapshot_id.clone());

    let mut found = Vec::new();
    collect_matches(&view.tree, query, &mut Vec::new(), &mut found);
    let total_matches = found.len();
    context.trace_lazy("locator.resolve", || {
        json!({
            "complete": false,
            "scope": "visible",
            "match_count": total_matches,
            "ref_count": view.refmap.len(),
            "snapshot_id": snapshot_id,
        })
    })?;
    let roles_present = if found.is_empty() {
        roles_in(&view.tree)
    } else {
        Vec::new()
    };
    let matches = found
        .into_iter()
        .map(|(data, bounds)| super::format_match(data, bounds))
        .collect::<Result<Vec<_>, _>>()?;
    let mut response = if args.selection.first {
        super::single_match_response(matches.into_iter().next(), query, roles_present)
    } else {
        let limit = match args.selection.limit {
            None => Some(super::DEFAULT_LIMIT),
            Some(0) => None,
            Some(limit) => Some(limit),
        };
        let truncated = limit.is_some_and(|limit| total_matches > limit);
        let listed = matches
            .into_iter()
            .take(limit.unwrap_or(usize::MAX))
            .collect::<Vec<_>>();
        let is_empty = listed.is_empty();
        let mut response = json!({
            "matches": listed,
            "total_matches": total_matches,
            "truncated": truncated,
        });
        super::attach_roles_present(&mut response, is_empty, query, roles_present);
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

/// Collects every node of the presented view that the query matches, in
/// document order, each with the path of its ancestors' labels (the labels a
/// whole-window find reports).
fn collect_matches(
    node: &AccessibilityNode,
    query: &LocatorQuery,
    path: &mut Vec<String>,
    found: &mut Vec<(LocatorMatchData, Option<crate::Rect>)>,
) {
    if crate::accessibility_node_matches(node, query) {
        found.push((
            LocatorMatchData {
                ref_id: node.ref_id.clone(),
                role: node.role.clone(),
                name: node.identity.name.clone().unwrap_or_default(),
                value: node.identity.value.clone(),
                states: node.presentation.states.clone(),
                interactive: node.ref_id.is_some(),
                path: path.clone(),
            },
            node.presentation.bounds,
        ));
    }
    path.push(node_label(node));
    for child in &node.children {
        collect_matches(child, query, path, found);
    }
    path.pop();
}

fn node_label(node: &AccessibilityNode) -> String {
    node.identity
        .name
        .as_deref()
        .or(node.identity.value.as_deref())
        .filter(|label| !label.trim().is_empty())
        .map(|label| format!("{}:{label}", node.role))
        .unwrap_or_else(|| node.role.clone())
}

/// The roles of the presented view, sorted and once each, for an empty answer
/// to a query that names a role.
fn roles_in(tree: &AccessibilityNode) -> Vec<String> {
    fn walk(node: &AccessibilityNode, roles: &mut std::collections::BTreeSet<String>) {
        roles.insert(node.role.clone());
        for child in &node.children {
            walk(child, roles);
        }
    }
    let mut roles = std::collections::BTreeSet::new();
    walk(tree, &mut roles);
    roles.into_iter().collect()
}

#[cfg(test)]
#[path = "find_view_tests.rs"]
mod tests;
