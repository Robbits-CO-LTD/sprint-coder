// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! An action whose interaction lease could not be had in its first round sent
//! nothing, and says so (`not_delivered`, retry safe). A failure after the
//! lease, and a lease lost in a later round, stay as they were.

use super::*;
use crate::{
    AdapterError, DeliverySemantics, ErrorCode, Rect,
    actions::action::Action,
    actions::action_request::ActionRequest,
    actions::action_result::ActionResult,
    actions::capability,
    adapter::{ActionOps, InputOps, LiveElement, NativeHandle, ObservationOps, SystemOps},
    refs::RefEntry,
    snapshot::snapshot_surface::SnapshotSurface,
    tree::element_state::ElementState,
};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU32, Ordering},
};

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    /// Every lease times out on its lock, as another process holds it.
    LeaseLocked,
    /// The lease times out with a disposition of the adapter's own.
    LeaseUncertain,
    /// The lease is had; the dispatch then times out.
    DispatchTimesOut,
    /// The first leased resolve refuses (retryable, nothing sent), and the
    /// second round's lease times out on its lock.
    LeaseLostInALaterRound,
}

struct LeaseAdapter {
    mode: Mode,
    leases: AtomicU32,
    leased_resolves: AtomicU32,
    dispatches: AtomicU32,
    lease_held: Arc<AtomicBool>,
}

struct HeldLease(Arc<AtomicBool>);

impl Drop for HeldLease {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn lock_timeout(deadline: crate::Deadline) -> AdapterError {
    deadline.timeout_error().with_details(serde_json::json!({
        "kind": "lock_timeout",
        "purpose": "desktop interaction lease",
    }))
}

impl ObservationOps for LeaseAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        if self.mode == Mode::LeaseLostInALaterRound && self.lease_held.load(Ordering::SeqCst) {
            let call = self.leased_resolves.fetch_add(1, Ordering::SeqCst) + 1;
            if call == 1 {
                return Err(AdapterError::ambiguous_target("two live candidates")
                    .with_details(serde_json::json!({ "retryable": true })));
            }
        }
        Ok(NativeHandle::null())
    }

    fn get_live_element(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<LiveElement, AdapterError> {
        Ok(LiveElement {
            identity: crate::adapter::live_identity("Run"),
            state: ElementState {
                role: "button".into(),
                states: Vec::new(),
                value: None,
                enabled: Some(true),
                hidden: Some(false),
                offscreen: Some(false),
            },
            states_complete: true,
            bounds: Some(bounds()),
            available_actions: vec![capability::CLICK.into()],
        })
    }

    fn get_element_bounds(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<Rect>, AdapterError> {
        Ok(Some(bounds()))
    }

    fn hit_test(
        &self,
        _handle: &NativeHandle,
        _point: crate::Point,
        _deadline: crate::Deadline,
    ) -> Result<crate::adapter::hit_test::HitTestResult, AdapterError> {
        Ok(crate::adapter::hit_test::HitTestResult::ReachesTarget)
    }
    crate::adapter::saved_ref_scope!("button", Some("Run"));
}

impl ActionOps for LeaseAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        _request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        self.dispatches.fetch_add(1, Ordering::SeqCst);
        if self.mode == Mode::DispatchTimesOut {
            return Err(AdapterError::timeout("the click did not return in time"));
        }
        Ok(ActionResult::delivered_unverified("click"))
    }
}

impl InputOps for LeaseAdapter {}

impl SystemOps for LeaseAdapter {
    fn acquire_interaction_lease(
        &self,
        deadline: crate::Deadline,
    ) -> Result<crate::InteractionLease, AdapterError> {
        let round = self.leases.fetch_add(1, Ordering::SeqCst) + 1;
        match self.mode {
            Mode::LeaseLocked => Err(lock_timeout(deadline)),
            Mode::LeaseUncertain => {
                Err(lock_timeout(deadline).with_disposition(DeliverySemantics::uncertain()))
            }
            Mode::LeaseLostInALaterRound if round > 1 => Err(lock_timeout(deadline)),
            _ => {
                self.lease_held.store(true, Ordering::SeqCst);
                crate::InteractionLease::guarded(deadline, HeldLease(Arc::clone(&self.lease_held)))
            }
        }
    }
}

fn adapter(mode: Mode) -> LeaseAdapter {
    LeaseAdapter {
        mode,
        leases: AtomicU32::new(0),
        leased_resolves: AtomicU32::new(0),
        dispatches: AtomicU32::new(0),
        lease_held: Arc::new(AtomicBool::new(false)),
    }
}

fn execute(adapter: &LeaseAdapter, timeout_ms: u64) -> Result<ActionResult, AdapterError> {
    execute_with_auto_wait(
        RefActionWaitCtx {
            adapter,
            entry: &entry(),
            ref_id: "@e1",
            context: &CommandContext::default(),
        },
        ActionRequest::headless(Action::Click).with_timeout_ms(Some(timeout_ms)),
        crate::ref_action::ref_action_single::dispatch_resolved,
    )
}

#[test]
fn a_lease_lost_before_anything_was_sent_reports_not_delivered_and_retry_safe() {
    let adapter = adapter(Mode::LeaseLocked);
    let error = execute(&adapter, 300).unwrap_err();

    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    let encoded = serde_json::to_value(error.disposition).expect("a disposition serializes");
    assert_eq!(encoded["delivery"], "not_delivered");
    assert_eq!(encoded["retry"], "safe");
    assert_eq!(
        error.details.as_ref().expect("details")["kind"],
        "lock_timeout",
        "the lock's own report is kept, which is what the host's one retry reads"
    );
    assert_eq!(adapter.dispatches.load(Ordering::SeqCst), 0);
}

#[test]
fn a_lease_lost_without_a_wait_reports_not_delivered_too() {
    let adapter = adapter(Mode::LeaseLocked);
    let error = execute(&adapter, 0).unwrap_err();

    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert_eq!(adapter.dispatches.load(Ordering::SeqCst), 0);
}

#[test]
fn a_disposition_the_adapter_chose_for_its_lease_is_kept() {
    let adapter = adapter(Mode::LeaseUncertain);
    let error = execute(&adapter, 300).unwrap_err();

    assert_eq!(error.disposition, DeliverySemantics::uncertain());
}

#[test]
fn a_failure_after_the_lease_was_had_stays_unknown() {
    let adapter = adapter(Mode::DispatchTimesOut);
    let error = execute(&adapter, 300).unwrap_err();

    assert_eq!(adapter.dispatches.load(Ordering::SeqCst), 1);
    assert_ne!(
        error.disposition,
        DeliverySemantics::not_delivered(),
        "a dispatch that timed out may have landed; retrying it could act twice"
    );
}

#[test]
fn a_lease_lost_in_a_later_round_stays_unknown() {
    let adapter = adapter(Mode::LeaseLostInALaterRound);
    let error = execute(&adapter, 2_000).unwrap_err();

    assert_eq!(
        adapter.leases.load(Ordering::SeqCst),
        2,
        "the loop took a second round"
    );
    assert_eq!(adapter.dispatches.load(Ordering::SeqCst), 0);
    assert_eq!(
        error.disposition,
        DeliverySemantics::unknown(),
        "a round after a leased dispatch is not known to have sent nothing"
    );
}

fn bounds() -> Rect {
    Rect {
        x: 10.0,
        y: 10.0,
        width: 20.0,
        height: 20.0,
    }
}

fn entry() -> RefEntry {
    let bounds = bounds();
    RefEntry {
        process: crate::RefProcess {
            pid: crate::ProcessId::new(1),
            process_instance: Some("test-instance".into()),
        },
        identity: crate::RefEntryIdentity {
            retained_object: None,
            role: "button".into(),
            name: Some("Run".into()),
            value: None,
            description: None,
            native_id: None,
            unique_at_capture: true,
            ancestors: Vec::new(),
            in_view: None,
            in_menu: None,
        },
        geometry: crate::RefGeometry {
            bounds_space: None,
            bounds: Some(bounds),
            bounds_hash: bounds.bounds_hash(),
        },
        capabilities: crate::RefCapabilities {
            states: Vec::new(),
            available_actions: vec![capability::CLICK.into()],
        },
        source: crate::RefSource {
            source_app: None,
            source_window_id: None,
            source_window_title: None,
            source_window_bounds_hash: None,
            source_surface: SnapshotSurface::Window,
            renderer_accessibility_forced: false,
            settled_thin_nodes: None,
        },
        scope: crate::RefScope {
            root_ref: None,
            path_is_absolute: false,
            path: smallvec::SmallVec::new(),
        },
    }
}
