// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;
use crate::{
    Action, DeliverySemantics, Rect,
    adapter::{ActionOps, InputOps, NativeHandle, ObservationOps, SystemOps},
};

struct MinimizedWindow {
    minimized: bool,
    asked: AtomicUsize,
}

impl ObservationOps for MinimizedWindow {
    fn minimized_window_refusal(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Option<AdapterError> {
        self.asked.fetch_add(1, Ordering::SeqCst);
        self.minimized.then(|| {
            AdapterError::new(ErrorCode::ActionFailed, "window is minimized")
                .with_details(json!({ "kind": "window_minimized", "retryable": false }))
                .with_disposition(DeliverySemantics::not_delivered())
        })
    }
}

impl ActionOps for MinimizedWindow {}
impl InputOps for MinimizedWindow {}
impl SystemOps for MinimizedWindow {}

fn evidence(offscreen: bool) -> ActionabilityEvidence {
    ActionabilityEvidence {
        nonspatial: false,
        state: crate::ElementState {
            role: "button".into(),
            states: Vec::new(),
            value: None,
            enabled: Some(true),
            hidden: Some(false),
            offscreen: Some(offscreen),
        },
        states_complete: true,
        bounds: Some(Rect {
            x: 10.0,
            y: 10.0,
            width: 40.0,
            height: 20.0,
        }),
        available_actions: vec![crate::actions::capability::CLICK.to_owned()],
    }
}

fn judge(
    adapter: &MinimizedWindow,
    action: Action,
    offscreen: bool,
) -> Result<ActionabilityReport, AdapterError> {
    let handle = NativeHandle::null();
    let evidence = evidence(offscreen);
    check_with_stability(
        StabilityExpectation::permissive(evidence.bounds.and_then(|bounds| bounds.bounds_hash())),
        &evidence,
        &ActionRequest::headless(action),
        Some((&handle, adapter)),
        crate::Deadline::standard().unwrap(),
    )
}

fn adapter(minimized: bool) -> MinimizedWindow {
    MinimizedWindow {
        minimized,
        asked: AtomicUsize::new(0),
    }
}

#[test]
fn a_target_in_a_minimized_window_is_refused_with_the_adapters_proof() {
    for action in [
        Action::Click,
        Action::SetValue("x".into()),
        Action::Toggle,
        Action::Select("x".into()),
        Action::Expand,
    ] {
        let minimized = adapter(true);
        let error = judge(&minimized, action, true).expect_err("a minimized window refuses");
        assert_eq!(error.details.as_ref().unwrap()["kind"], "window_minimized");
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
        assert!(!error.permits_retry_by_default());
        assert!(
            error.details.as_ref().unwrap().get("checks").is_none(),
            "no failed visible check may survive, or the scroll-into-view recovery runs"
        );
        assert_eq!(minimized.asked.load(Ordering::SeqCst), 1);
    }
}

#[test]
fn an_offscreen_target_in_a_shown_window_keeps_the_visibility_refusal() {
    let shown = adapter(false);
    let error = judge(&shown, Action::Click, true).expect_err("offscreen is not actionable");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert!(
        error
            .message
            .contains("visible (live offscreen state is true)")
    );
    assert_eq!(shown.asked.load(Ordering::SeqCst), 1);
}

#[test]
fn a_visible_target_never_asks_about_its_window() {
    let minimized = adapter(true);
    let report = judge(&minimized, Action::Click, false).expect("a visible target is actionable");
    assert!(report.actionable);
    assert_eq!(minimized.asked.load(Ordering::SeqCst), 0);
}
