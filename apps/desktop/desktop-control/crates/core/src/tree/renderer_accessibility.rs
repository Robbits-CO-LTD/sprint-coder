// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use crate::{
    AppError, PlatformAdapter,
    locator::live_locator::{ObservationRequest, ObservationRoot, ObservedTree},
};

/// A renderer that has not published its accessibility tree yet is discovered
/// by walking the tree and failing, so every retry here costs a full
/// observation. Polling that at a fixed short interval spends the whole budget
/// re-walking a tree that is not ready — on a large renderer it burns dozens of
/// complete walks and returns nothing. The wait backs off instead, so a
/// renderer that activates quickly is still caught quickly while one that never
/// activates is retried a handful of times rather than continuously.
const INITIAL_ACTIVATION_RETRY: std::time::Duration = std::time::Duration::from_millis(25);
const MAX_ACTIVATION_RETRY: std::time::Duration = std::time::Duration::from_millis(400);

/// Observes through the adapter, settling a renderer that has not published
/// its accessibility tree yet. `lease` is the interaction lease the caller
/// already holds, if any: activation reuses it rather than queueing behind the
/// same process's non-reentrant lease until the deadline expires.
pub(crate) fn observe_tree(
    adapter: &dyn PlatformAdapter,
    root: ObservationRoot<'_>,
    request: &ObservationRequest,
    lease: Option<&crate::InteractionLease>,
) -> Result<ObservedTree, AppError> {
    let mut request = *request;
    // The settle belongs to this observation alone: whatever a caller's
    // request carried, it starts unactivated.
    request.observation_mode.settle = None;
    let mut retry_delay = INITIAL_ACTIVATION_RETRY;
    loop {
        match adapter.observe_tree(root, &request) {
            Ok(tree) => return Ok(tree),
            Err(error) if error.requires_renderer_accessibility_activation() => {
                request.observation_mode.settle = Some(match request.observation_mode.settle {
                    None => {
                        request.deadline = activate(adapter, root, request.deadline, lease)?;
                        crate::locator::live_locator::SettleProgress {
                            activated_at: std::time::Instant::now(),
                            previous_thin_nodes: None,
                        }
                    }
                    Some(progress) => settle_after_walk(progress, &error),
                });
                let remaining = request.deadline.remaining();
                if remaining.is_zero() {
                    return Err(request.deadline.timeout_error().into());
                }
                std::thread::sleep(remaining.min(retry_delay));
                retry_delay = retry_delay.saturating_mul(2).min(MAX_ACTIVATION_RETRY);
            }
            Err(error) => return Err(AppError::Adapter(error)),
        }
    }
}

/// The settle after one more thin walk past the activation: the walk's size,
/// as the adapter reported it, becomes the one the next walk is compared with.
/// A walk that reported no size leaves nothing to compare with.
pub(crate) fn settle_after_walk(
    progress: crate::locator::live_locator::SettleProgress,
    error: &crate::AdapterError,
) -> crate::locator::live_locator::SettleProgress {
    crate::locator::live_locator::SettleProgress {
        previous_thin_nodes: error
            .details
            .as_ref()
            .and_then(|details| details.get("nodes_observed"))
            .and_then(serde_json::Value::as_u64),
        ..progress
    }
}

fn activate(
    adapter: &dyn PlatformAdapter,
    root: ObservationRoot<'_>,
    observing: crate::Deadline,
    lease: Option<&crate::InteractionLease>,
) -> Result<crate::Deadline, AppError> {
    let started = std::time::Instant::now();
    switch_on(adapter, root, lease).map_err(|error| match error {
        AppError::Adapter(ref adapter_error) if adapter_error.code == crate::ErrorCode::Timeout => {
            observing.timeout_error().into()
        }
        other => other,
    })?;
    Ok(observing.extended_by(started.elapsed()))
}

fn switch_on(
    adapter: &dyn PlatformAdapter,
    root: ObservationRoot<'_>,
    lease: Option<&crate::InteractionLease>,
) -> Result<(), AppError> {
    let process = root_process(root)?;
    match lease {
        Some(lease) => adapter.activate_renderer_accessibility(process, lease)?,
        None => {
            let acquired = adapter.acquire_interaction_lease(crate::Deadline::standard()?)?;
            adapter.activate_renderer_accessibility(process, &acquired)?;
        }
    }
    Ok(())
}

fn root_process(root: ObservationRoot<'_>) -> Result<crate::ProcessIdentity, AppError> {
    match root {
        ObservationRoot::Window(window) => window
            .process_instance
            .as_deref()
            .map(|instance| crate::ProcessIdentity::new(window.pid, instance)),
        ObservationRoot::Element { entry, .. } => entry
            .process
            .process_instance
            .as_deref()
            .map(|instance| crate::ProcessIdentity::new(entry.process.pid, instance)),
    }
    .ok_or_else(|| {
        crate::AdapterError::stale_ref_because("renderer process instance is unavailable").into()
    })
}

#[cfg(test)]
#[path = "renderer_accessibility_tests.rs"]
mod tests;
