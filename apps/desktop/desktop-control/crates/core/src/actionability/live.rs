// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::{
    evaluate::{check_with_stability, check_with_stability_or_gap},
    evidence::ActionabilityEvidence,
    report::ActionabilityReport,
    stability::StabilityExpectation,
};
use crate::{
    AdapterError, DeliverySemantics, ErrorCode, IdentityMatch, LocatorEvidence, LocatorField,
    actions::action_request::ActionRequest,
    adapter::{LiveElement, NativeHandle, PlatformAdapter},
    locator::live_locator::LocatorRefEvidence,
    refs::RefEntry,
    refs::ref_full_predicate::FullPredicate,
    refs::ref_identity::{element_token, identity_match},
    refs::ref_live_predicate::LivePredicate,
};

/// Groups the read-only coordinates of a live element check: which element,
/// which handle to read it through, which adapter to read with, and the
/// deadline that bounds the read. Kept separate from the `request` (what
/// action to check against) and `stability` (how settled the element must
/// be) parameters, which vary independently per call.
pub(crate) struct LiveCheckTarget<'a> {
    pub(crate) entry: &'a RefEntry,
    pub(crate) handle: &'a NativeHandle,
    pub(crate) adapter: &'a dyn PlatformAdapter,
    pub(crate) deadline: crate::Deadline,
}

#[cfg(test)]
pub(crate) fn check_live(
    entry: &RefEntry,
    handle: &NativeHandle,
    adapter: &dyn PlatformAdapter,
    request: &ActionRequest,
) -> Result<ActionabilityReport, AdapterError> {
    let deadline = crate::Deadline::standard()?;
    check_live_with_stability(
        &LiveCheckTarget {
            entry,
            handle,
            adapter,
            deadline,
        },
        request,
        StabilityExpectation::permissive(entry.geometry.bounds_hash),
    )
}

pub(crate) fn check_live_with_stability(
    target: &LiveCheckTarget<'_>,
    request: &ActionRequest,
    stability: StabilityExpectation,
) -> Result<ActionabilityReport, AdapterError> {
    let evidence =
        observe(target).map_err(crate::ref_action::mark_pre_dispatch_resolution_failure)?;
    check_with_stability(
        stability,
        &evidence,
        request,
        Some((target.handle, target.adapter)),
        target.deadline,
    )
    .map_err(crate::ref_action::mark_pre_dispatch_resolution_failure)
}

/// [`check_live_with_stability`]'s report-preserving counterpart - see
/// [`check_with_stability_or_gap`] for why `stable_preflight` needs it.
pub(crate) fn check_live_with_stability_or_gap(
    target: &LiveCheckTarget<'_>,
    request: &ActionRequest,
    stability: StabilityExpectation,
) -> Result<ActionabilityReport, AdapterError> {
    let evidence = observe(target)?;
    check_with_stability_or_gap(
        stability,
        &evidence,
        request,
        Some((target.handle, target.adapter)),
        target.deadline,
    )
}

fn observe(target: &LiveCheckTarget<'_>) -> Result<ActionabilityEvidence, AdapterError> {
    // The element about to be acted on is held to the ancestors its entry was
    // proven with as well, not only to its own predicate. They are read first,
    // so the element's own read stays the one closest to the action.
    crate::refs::ref_ancestry::confirm_handle_ancestors(
        target.adapter,
        target.entry,
        target.handle,
        target.deadline,
    )
    .map_err(ancestors_changed_is_retryable)?;
    let live = match target
        .adapter
        .get_live_element(target.handle, target.deadline)
    {
        Ok(live) => live,
        Err(err)
            if matches!(
                err.code,
                ErrorCode::PlatformNotSupported | ErrorCode::ActionNotSupported
            ) =>
        {
            return Err(AdapterError::new(
                ErrorCode::ActionNotSupported,
                "Live element evidence is required for actionability checks",
            )
            .with_details(serde_json::json!({ "source_code": err.code.as_str() }))
            .with_disposition(DeliverySemantics::not_delivered()));
        }
        Err(err) => return Err(err),
    };
    validate_live_identity(target.entry, &live)?;
    // An entry proven among the elements the window showed is held to the
    // screen rectangle it was recorded at, right before the action.
    crate::refs::ref_view::confirm_live_bounds(target.entry, live.bounds)?;
    Ok(ActionabilityEvidence {
        nonspatial: target.adapter.is_nonspatial_target(target.handle),
        state: live.state,
        states_complete: live.states_complete,
        bounds: live.bounds,
        available_actions: live.available_actions,
    })
}

fn validate_live_identity(entry: &RefEntry, live: &LiveElement) -> Result<(), AdapterError> {
    if live.state.role == "unknown" || live.state.role != entry.identity.role {
        return Err(stale_live_element(
            "Resolved element changed role before dispatch",
        ));
    }
    match recorded_identity_match(entry, &live_evidence(live)) {
        IdentityMatch::Match => Ok(()),
        IdentityMatch::NoMatch => Err(stale_live_element(
            "Resolved element changed identity before dispatch",
        )),
        IdentityMatch::Unknown => Err(AdapterError::app_unresponsive(
            entry
                .source
                .source_app
                .as_deref()
                .unwrap_or("target application"),
        )
        .with_details(serde_json::json!({
            "kind": "live_identity_evidence",
            "complete": false,
            "retryable": true,
        }))),
    }
}

/// The identity rule the capture recorded. An entry carrying an element token
/// re-identifies itself through that token; every other entry is held to the
/// whole predicate - role, identifier and stable text - that resolution
/// compares, because an identifier alone still matches after the element it
/// named was replaced by one that kept the identifier and changed its text.
fn recorded_identity_match(entry: &RefEntry, live: &LocatorEvidence) -> IdentityMatch {
    if element_token(entry).is_some() {
        return identity_match(
            entry,
            &live.name,
            &live.value,
            &live.description,
            &live.identifiers,
        );
    }
    FullPredicate::of_entry(entry).compare(&LivePredicate::observed(live))
}

/// The live read as the evidence a predicate compares: the identity slots it
/// holds, with the geometry and state slots of a snapshot observation left
/// unread because no identity rule reads them.
fn live_evidence(live: &LiveElement) -> LocatorEvidence {
    LocatorEvidence {
        role: LocatorField::Known(live.state.role.clone()),
        name: live.identity.name.clone(),
        description: live.identity.description.clone(),
        value: live
            .state
            .value
            .clone()
            .map(LocatorField::Known)
            .unwrap_or(LocatorField::Absent),
        identifiers: live.identity.identifiers.clone(),
        states: LocatorField::Absent,
        ref_evidence: LocatorRefEvidence {
            bounds: LocatorField::Absent,
            window_bounds: LocatorField::Absent,
            available_actions: LocatorField::Known(live.available_actions.clone()),
            descriptors: Default::default(),
            runtime_id: None,
        },
    }
}

/// Ancestors found changed in the check right before the action are, like an
/// element found changed there ([`stale_live_element`]), a reason to resolve
/// the ref again rather than to give up: an action that waits resolves it
/// from the start, and that resolution holds the entry to its full proof
/// again, ancestors included, so a lasting change still stops it there.
pub(crate) fn ancestors_changed_is_retryable(error: AdapterError) -> AdapterError {
    let Some(mut details) = error.details.clone() else {
        return error;
    };
    if details.get("kind").and_then(serde_json::Value::as_str)
        != Some("saved_ref_ancestors_changed")
    {
        return error;
    }
    let Some(object) = details.as_object_mut() else {
        return error;
    };
    object.insert("retryable".into(), serde_json::json!(true));
    error.with_details(details)
}

fn stale_live_element(message: &'static str) -> AdapterError {
    AdapterError::new(ErrorCode::StaleRef, message)
        .with_suggestion(
            "Re-run a snapshot to obtain fresh refs, then retry with the new ref (CLI: snapshot; FFI: ad_snapshot then ad_execute_by_ref with the returned qualified @<snapshot_id>:eN ref)",
        )
        .with_details(serde_json::json!({ "retryable": true }))
        .with_disposition(DeliverySemantics::not_delivered())
}
