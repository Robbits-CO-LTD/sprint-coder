// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use crate::{
    ActionRequest, ActionResult, AdapterError, AppError, Deadline,
    ref_action::ref_action_context::RefActionContext,
    ref_action::ref_action_poll::execute_poll_loop,
    ref_action::ref_action_poll_state::RefActionPollState,
    ref_action::ref_action_single::execute_single_shot,
    ref_action::ref_action_wait_context::RefActionWaitContext,
    ref_action::ref_action_wait_support::enrich_with_process_state,
};

#[cfg(test)]
use crate::{context::CommandContext, refs::RefEntry};
#[cfg(test)]
type RefActionWaitCtx<'a> = RefActionWaitContext<'a>;

pub(crate) fn execute_with_auto_wait(
    context: RefActionWaitContext<'_>,
    request: ActionRequest,
    dispatch: impl Fn(
        RefActionContext<'_>,
        ActionRequest,
        &crate::InteractionLease,
    ) -> Result<ActionResult, AppError>,
) -> Result<ActionResult, AdapterError> {
    let (result, lease, pre, deadline, _lease_started) =
        execute_with_auto_wait_and_lease(context, request, dispatch)?;
    drop(lease);
    crate::ref_action::finish_artifacts(RefActionContext::new(context, deadline), &pre);
    Ok(result)
}

pub(crate) fn execute_with_auto_wait_and_lease(
    context: RefActionWaitContext<'_>,
    request: ActionRequest,
    dispatch: impl Fn(
        RefActionContext<'_>,
        ActionRequest,
        &crate::InteractionLease,
    ) -> Result<ActionResult, AppError>,
) -> Result<
    (
        ActionResult,
        crate::InteractionLease,
        crate::trace::trace_artifacts::ArtifactOutcome,
        Deadline,
        std::time::Instant,
    ),
    AdapterError,
> {
    let deadline = operation_deadline(&request)?;
    let result = execute_with_deadline(context, request, deadline, dispatch);
    result.map_err(|error| {
        if deadline.is_expired() {
            error
        } else {
            enrich_with_process_state(context.adapter, context.entry, error, deadline)
        }
    })
}

fn execute_with_deadline(
    context: RefActionWaitContext<'_>,
    mut request: ActionRequest,
    deadline: Deadline,
    dispatch: impl Fn(
        RefActionContext<'_>,
        ActionRequest,
        &crate::InteractionLease,
    ) -> Result<ActionResult, AppError>,
) -> Result<
    (
        ActionResult,
        crate::InteractionLease,
        crate::trace::trace_artifacts::ArtifactOutcome,
        Deadline,
        std::time::Instant,
    ),
    AdapterError,
> {
    let polls = request.timeout_ms.is_some_and(|timeout_ms| timeout_ms > 0);
    let mut saw_ambiguity = false;
    let mut refusal: Option<AdapterError> = None;
    loop {
        let mut state = if polls {
            execute_poll_loop(context, &request, deadline)
                .map_err(|error| with_refusal(error, refusal.as_ref()))?
        } else {
            RefActionPollState::default()
        };
        state.saw_ambiguity |= saw_ambiguity;
        let pre = crate::ref_action::capture_pre_artifact(
            context.context,
            context.adapter,
            context.entry,
            deadline,
        );
        let cursor = crate::cursor_overlay::hold_cursor(context.context, deadline);
        crate::ref_action::presentation::before_lease(context, &request, deadline, cursor.is_ok());
        let lease = context
            .adapter
            .acquire_interaction_lease(deadline)
            .map_err(|error| {
                let first_round = refusal.is_none();
                state.attach_error_metrics(sent_nothing_without_lease(error, first_round))
            })?;
        if deadline.is_expired() {
            let error = state.attach_error_metrics(deadline.timeout_error());
            return Err(with_refusal(error, refusal.as_ref()));
        }
        if polls {
            request.timeout_ms = Some(deadline.remaining_ms());
        }
        let lease_started = std::time::Instant::now();
        match execute_single_shot(context, request.clone(), deadline, &lease, &dispatch) {
            Ok(mut result) => {
                state.attach_transient_ambiguity(&mut result);
                state.attach_wait_metrics(
                    &mut result,
                    &lease,
                    u64::try_from(lease_started.elapsed().as_millis()).unwrap_or(u64::MAX),
                );
                return Ok((result, lease, pre, deadline, lease_started));
            }
            Err(error) => {
                drop(lease);
                crate::ref_action::finish_artifacts(RefActionContext::new(context, deadline), &pre);
                if !(polls && resolves_again(&error, deadline)) {
                    return Err(error);
                }
                saw_ambiguity |= error.code == crate::ErrorCode::AmbiguousTarget;
                refusal = Some(error);
                crate::wait::deadline::sleep(
                    crate::refs::ref_resolve_deadline::POLL_INTERVAL.min(deadline.remaining()),
                );
            }
        }
    }
}

/// An action whose interaction lease could not be had in the loop's first
/// round sent nothing to its target, so it says so: `not_delivered`, which a
/// caller may retry.
///
/// It is said here rather than by the adapter because it is a fact about this
/// path, not about the lease. Before the first lease, the wait only reads
/// (resolve, actionability, hit tests), the pre-action capture only reads, and
/// the travel before the lease draws only this tool's own cursor overlay.
/// Dispatch, the only step that sends anything to the target, runs under the
/// lease.
///
/// A later round is left as it was (`unknown`). It runs again after a dispatch
/// that refused as `not_delivered` (`resolves_again`), but that dispatch ran
/// under the lease and may already have sent its target something on the way
/// (a preparatory scroll), so "nothing was sent" is not known there.
///
/// Only an `unknown` is settled: a disposition the adapter chose is kept.
fn sent_nothing_without_lease(error: AdapterError, first_round: bool) -> AdapterError {
    if first_round && error.disposition == crate::DeliverySemantics::unknown() {
        error.with_disposition(crate::DeliverySemantics::not_delivered())
    } else {
        error
    }
}

/// Whether a dispatch-time refusal goes back to the wait: the full resolution
/// under the lease failed in a way that may clear, nothing was sent, and the
/// caller's budget is not spent.
fn resolves_again(error: &AdapterError, deadline: Deadline) -> bool {
    error.disposition == crate::DeliverySemantics::not_delivered()
        && error.is_retryable_resolution_failure()
        && !deadline.is_expired()
}

/// Carries the dispatch-time refusal that sent the action back to the wait as
/// `details.refusal`, so a budget that runs out there still reports why the
/// ref was not acted on.
fn with_refusal(mut error: AdapterError, refusal: Option<&AdapterError>) -> AdapterError {
    let Some(refusal) = refusal else {
        return error;
    };
    let mut recorded = serde_json::json!({
        "code": refusal.code.as_str(),
        "message": refusal.message,
    });
    if let (Some(object), Some(details)) = (recorded.as_object_mut(), &refusal.details) {
        object.insert("details".into(), details.clone());
    }
    let mut details = error
        .details
        .take()
        .unwrap_or_else(|| serde_json::json!({}));
    match details.as_object_mut() {
        Some(object) => {
            object.insert("refusal".into(), recorded);
        }
        None => details = serde_json::json!({ "error_details": details, "refusal": recorded }),
    }
    error.with_details(details)
}

pub(crate) fn operation_deadline(request: &ActionRequest) -> Result<Deadline, AdapterError> {
    request
        .timeout_ms
        .filter(|timeout_ms| *timeout_ms > 0)
        .map_or_else(Deadline::standard, Deadline::after)
}

#[cfg(test)]
#[path = "ref_action_wait_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "ref_action_wait_process_state_tests.rs"]
mod process_state_tests;

#[cfg(test)]
#[path = "ref_action_wait_app_not_found_tests.rs"]
mod app_not_found_tests;

#[cfg(test)]
#[path = "ref_action_wait_success_tests.rs"]
mod success_tests;

#[cfg(test)]
#[path = "ref_action_exactly_once_tests.rs"]
mod exactly_once_tests;

#[cfg(test)]
#[path = "ref_action_focus_order_tests.rs"]
mod focus_order_tests;

#[cfg(test)]
#[path = "ref_action_wait_lease_undelivered_tests.rs"]
mod lease_undelivered_tests;
