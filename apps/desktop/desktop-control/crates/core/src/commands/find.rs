// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
#[cfg(test)]
use crate::AccessibilityNode;
#[cfg(test)]
use crate::commands::query;
use crate::{
    AppError, IdentityPredicate, LocatorQuery, StatePredicate, adapter::PlatformAdapter,
    context::CommandContext, tree::search_text,
};
use serde_json::Value;

const DEFAULT_LIMIT: usize = 50;

/// Match-criteria fields: how a candidate element is identified. Grouped out
/// of [`FindArgs`] to keep it under the repo's field-count limit.
pub struct FindFilterArgs {
    pub role: Option<String>,
    pub name: Option<String>,
    pub description: Option<String>,
    pub native_id: Option<String>,
    pub value: Option<String>,
    pub text: Option<String>,
    pub exact: bool,
}

/// Result-shaping fields: which of the matches to return. Mutually exclusive
/// at the CLI/batch layer (enforced by [`validate_find_mode`]).
pub struct FindSelectionArgs {
    pub count: bool,
    pub first: bool,
    pub last: bool,
    pub nth: Option<usize>,
    pub limit: Option<usize>,
}

pub struct FindArgs {
    pub app: Option<String>,
    pub window_id: Option<String>,
    pub root: Option<String>,
    pub surface: crate::SnapshotSurface,
    pub filter: FindFilterArgs,
    pub states: Vec<StatePredicate>,
    pub selection: FindSelectionArgs,
    pub timeout_ms: Option<u64>,
}

pub fn execute(
    args: FindArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    validate_find_mode(&args)?;
    super::surface_scope::reject_root_with_surface("find", args.root.as_deref(), args.surface)?;
    adapter.check_surface_support(args.surface)?;
    let query = locator_query_from_args(&args)?;
    query.validate_states().map_err(AppError::Adapter)?;

    live::execute(&args, &query, adapter, context).map_err(name_the_traversal_remedy)
}

/// A traversal that ran out of budget on a large tree is not evidence the
/// target is unresponsive, which is what the shared timeout suggestion says.
/// The caller has two real levers here - a bigger budget, or a narrower
/// search - so this names them instead of sending them to inspect a healthy
/// app. Applied at this boundary rather than in the shared constructor,
/// which every other command reaches and whose wording is asserted on
/// elsewhere.
///
/// A search that stopped at a fixed read limit (`locator_budget_limit`: a
/// container with more children than a search reads, such as a list of tens of
/// thousands of rows) ends the same way under any deadline, so it is not told
/// to raise `--timeout-ms`. Either way, a window too large to search whole is
/// pointed at `snapshot`, which reads the elements shown on screen of such a
/// Chromium-hosted window. A find that could answer from those elements itself
/// (see `find_view.rs`) does, so a timeout that reaches here is one it did not
/// or could not answer that way.
fn name_the_traversal_remedy(error: AppError) -> AppError {
    let AppError::Adapter(adapter_error) = error else {
        return error;
    };
    if adapter_error.code != crate::ErrorCode::Timeout {
        return AppError::Adapter(adapter_error);
    }
    let read_limit = adapter_error
        .details
        .as_ref()
        .and_then(|details| details.get("kind"))
        .and_then(serde_json::Value::as_str)
        == Some("locator_budget_limit");
    let suggestion = if read_limit {
        FIND_READ_LIMIT_SUGGESTION
    } else {
        FIND_TIMEOUT_SUGGESTION
    };
    AppError::Adapter(adapter_error.with_suggestion(suggestion))
}

const FIND_TIMEOUT_SUGGESTION: &str = "The search ran out of budget before it could answer. Raise --timeout-ms, or narrow the search with --root, --surface, or a more specific role and name. A window with thousands of elements, such as a long list, may not be searched whole in any useful time. When such a window is Chromium-hosted (Electron, WebView2), a find without --root, --surface, --count, --last, or --nth, given at least the default --timeout-ms, searches the elements shown on screen instead; this one did not or could not, so run snapshot instead, which reads only the elements shown on screen of such a window, and use a ref from it.";

const FIND_READ_LIMIT_SUGGESTION: &str = "The search stopped at a limit on how much it reads (a container with more children than a search reads, such as a very long list), so a larger --timeout-ms does not help. Narrow the search with --root at a container outside that list. When such a window is Chromium-hosted (Electron, WebView2), a find without --root, --surface, --count, --last, or --nth searches the elements shown on screen instead; this one did not or could not, so run snapshot instead, which reads only the elements shown on screen of such a window, and use a ref from it.";

pub fn parse_state_flag(raw: &str) -> Result<StatePredicate, AppError> {
    let (token, expected) = match raw.split_once('=') {
        Some((token, value)) => {
            let expected = match value {
                "true" | "1" => Some(true),
                "false" | "0" => Some(false),
                _ => {
                    return Err(AppError::invalid_input_with_suggestion(
                        format!("Invalid state flag value '{value}' in '{raw}'"),
                        "Use TOKEN, TOKEN=true, or TOKEN=false.",
                    ));
                }
            };
            (token, expected)
        }
        None => (raw, None),
    };
    Ok(StatePredicate {
        token: token.to_string(),
        expected,
    })
}

fn locator_query_from_args(args: &FindArgs) -> Result<LocatorQuery, AppError> {
    Ok(LocatorQuery {
        identity: IdentityPredicate {
            role: args.filter.role.clone(),
            name: args.filter.name.as_deref().map(search_text::normalize),
            description: args
                .filter
                .description
                .as_deref()
                .map(search_text::normalize),
            native_id: args.filter.native_id.clone(),
            value: args.filter.value.as_deref().map(search_text::normalize),
        },
        has_text: args.filter.text.as_deref().map(search_text::normalize),
        exact: args.filter.exact,
        states: args.states.clone(),
        ..LocatorQuery::default()
    })
}

fn validate_find_mode(args: &FindArgs) -> Result<(), AppError> {
    let selector_count = [
        args.selection.count,
        args.selection.first,
        args.selection.last,
        args.selection.nth.is_some(),
    ]
    .into_iter()
    .filter(|selected| *selected)
    .count();
    if selector_count > 1 || (selector_count == 1 && args.selection.limit.is_some()) {
        return Err(AppError::invalid_input_with_suggestion(
            "find accepts only one result-shaping mode",
            "Use one of --count, --first, --last, --nth, or --limit.",
        ));
    }
    Ok(())
}

#[cfg(test)]
fn collect_snapshot_matches(
    node: &AccessibilityNode,
    query: &LocatorQuery,
    path: &mut Vec<String>,
    matches: &mut Vec<Value>,
    max_matches: Option<usize>,
) -> bool {
    if max_matches.is_some_and(|limit| matches.len() >= limit) {
        return true;
    }
    if query::node_matches(node, query) {
        let interactive = node.ref_id.is_some();
        matches.push(
            serde_json::to_value(crate::locator::live_locator::LocatorMatchData {
                ref_id: node.ref_id.clone(),
                role: node.role.clone(),
                name: node.identity.name.clone().unwrap_or_default(),
                value: node.identity.value.clone(),
                states: node.presentation.states.clone(),
                interactive,
                path: path.clone(),
            })
            .unwrap(),
        );
        if max_matches.is_some_and(|limit| matches.len() >= limit) {
            return true;
        }
    }

    let label = node
        .identity
        .name
        .as_deref()
        .or(node.identity.value.as_deref())
        .map(|label| format!("{}:{label}", node.role))
        .unwrap_or_else(|| node.role.clone());
    path.push(label);

    for child in &node.children {
        if collect_snapshot_matches(child, query, path, matches, max_matches) {
            path.pop();
            return true;
        }
    }

    path.pop();
    false
}

#[path = "find_live.rs"]
mod live;

#[cfg(test)]
#[path = "find_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "find_live_test_support.rs"]
mod test_support;

#[cfg(test)]
#[path = "find_rooted_tests.rs"]
mod rooted_tests;

#[cfg(test)]
#[path = "find_live_tests.rs"]
mod live_tests;
