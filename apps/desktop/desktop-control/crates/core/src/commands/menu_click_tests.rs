// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use std::sync::Mutex;

use super::*;
use crate::{
    ActionOps, ActionResult, AdapterError, Deadline, ErrorCode, InputOps, InteractionLease,
    NativeHandle, ObservationOps, SystemOps, WindowInfo,
    actions::interaction_policy::InteractionPolicy,
    locator::live_locator::{ObservationRequest, ObservationRoot, ObservedTree},
};

/// An adapter that records menu commands and fails the test if a menu item
/// ref ever reaches an accessibility read or landing.
#[derive(Default)]
struct Menus {
    instance: Option<String>,
    ran: Mutex<Vec<u32>>,
}

impl ObservationOps for Menus {
    fn list_windows(
        &self,
        _filter: &crate::WindowFilter,
        _deadline: Deadline,
    ) -> Result<Vec<WindowInfo>, AdapterError> {
        let mut window = crate::snapshot::menu_bar::tests::window();
        if let Some(instance) = &self.instance {
            window.process_instance = Some(instance.clone());
        }
        Ok(vec![window])
    }

    fn observe_tree(
        &self,
        _root: ObservationRoot<'_>,
        _request: &ObservationRequest,
    ) -> Result<ObservedTree, AdapterError> {
        panic!("a menu item ref must never be read through the accessibility tree")
    }

    fn resolve_locator_anchor(
        &self,
        _entry: &RefEntry,
        _deadline: Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        panic!("a menu item ref must never be landed on an accessibility element")
    }

    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        panic!("a menu item ref must never be resolved by an element token")
    }
}

impl ActionOps for Menus {
    fn run_menu_command(
        &self,
        entry: &RefEntry,
        window: &WindowInfo,
        _deadline: Deadline,
        _lease: &InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        assert_eq!(
            Some(window.id.as_str()),
            entry.source.source_window_id.as_deref()
        );
        let id = entry.identity.in_menu.as_ref().unwrap().command_id;
        self.ran.lock().unwrap().push(id);
        Ok(ActionResult::delivered_unverified("click"))
    }

    fn execute_action(
        &self,
        _handle: &NativeHandle,
        _request: ActionRequest,
        _lease: &InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        panic!("a menu item ref must never be dispatched to an element")
    }
}

impl InputOps for Menus {}

impl SystemOps for Menus {
    fn acquire_interaction_lease(
        &self,
        deadline: Deadline,
    ) -> Result<InteractionLease, AdapterError> {
        InteractionLease::guarded(deadline, ())
    }
}

/// A ref read from the test application's menu bar: File > 開く.
fn menu_entry() -> RefEntry {
    let result = crate::snapshot::menu_bar::capture(
        &crate::snapshot::menu_bar::tests::window(),
        &crate::snapshot::menu_bar::tests::sample_bar(),
        10,
    );
    result.refmap.get("@e1").unwrap().clone()
}

fn request(action: Action) -> ActionRequest {
    ActionRequest::headless(action)
}

#[test]
fn a_click_runs_the_command_through_the_adapter_and_nothing_else() {
    let adapter = Menus::default();
    let entry = menu_entry();
    assert_eq!(entry.identity.in_menu.as_ref().unwrap().command_id, 1001);
    let value = execute(
        &adapter,
        &entry,
        request(Action::Click),
        &CommandContext::default(),
    )
    .unwrap();
    assert_eq!(*adapter.ran.lock().unwrap(), vec![1001]);
    assert_eq!(value["action"], "click");
}

#[test]
fn every_other_action_and_a_headed_click_are_refused_before_anything_is_read() {
    let adapter = Menus::default();
    let entry = menu_entry();
    for action in [
        Action::Expand,
        Action::Toggle,
        Action::Check,
        Action::SetValue("x".to_owned()),
        Action::TypeText("x".to_owned()),
        Action::DoubleClick,
        Action::RightClick,
        Action::Hover,
        Action::ScrollTo,
        Action::SetFocus,
        Action::Clear,
        Action::Select("x".to_owned()),
    ] {
        let error = execute(
            &adapter,
            &entry,
            request(action),
            &CommandContext::default(),
        )
        .unwrap_err();
        assert_eq!(error.code(), "ACTION_NOT_SUPPORTED");
    }
    let headed = ActionRequest {
        policy: InteractionPolicy::headed(),
        ..request(Action::Click)
    };
    assert!(execute(&adapter, &entry, headed, &CommandContext::default()).is_err());
    assert!(adapter.ran.lock().unwrap().is_empty());
}

#[test]
fn a_window_now_held_by_another_process_instance_is_refused_before_the_command() {
    let adapter = Menus {
        instance: Some("windows-proc-v1:2:2".to_owned()),
        ..Menus::default()
    };
    let error = execute(
        &adapter,
        &menu_entry(),
        request(Action::Click),
        &CommandContext::default(),
    )
    .unwrap_err();
    assert_ne!(error.code(), "OK");
    assert!(adapter.ran.lock().unwrap().is_empty());
}

#[test]
fn an_inconsistent_menu_proof_is_refused() {
    let adapter = Menus::default();
    let mut entry = menu_entry();
    entry.identity.unique_at_capture = true;
    let error = execute(
        &adapter,
        &entry,
        request(Action::Click),
        &CommandContext::default(),
    )
    .unwrap_err();
    assert_eq!(error.code(), "ACTION_NOT_SUPPORTED");
    assert!(adapter.ran.lock().unwrap().is_empty());
}

#[test]
fn every_path_that_resolves_refs_to_elements_refuses_a_menu_item_ref() {
    let adapter = Menus::default();
    let entry = menu_entry();
    let deadline = || Deadline::after(1_000).unwrap();
    let refused = |error: AdapterError| {
        assert_eq!(error.code, ErrorCode::ActionNotSupported);
        assert_eq!(error.details.unwrap()["kind"], "menu_item_ref");
    };
    refused(
        crate::refs::resolve_saved_ref::resolve_saved_ref(&adapter, &entry, deadline(), None)
            .err()
            .unwrap(),
    );
    refused(
        crate::refs::resolve_saved_ref::land_saved_ref(&adapter, &entry, deadline())
            .err()
            .unwrap(),
    );
    refused(
        crate::refs::resolve_saved_ref::observe_saved_ref(&adapter, &entry, deadline(), None, true)
            .err()
            .unwrap(),
    );
    let read = crate::refs::ref_root_read::read_saved_root(
        &adapter,
        &entry,
        deadline(),
        |_, _| Ok(()),
        |_| true,
    );
    match read {
        Err(crate::AppError::Adapter(error)) => refused(error),
        _ => panic!("a rooted read under a menu item ref must be refused"),
    }
    // A token next to the menu proof is refused the same way, never resolved.
    let mut token = entry.clone();
    token.identity.retained_object = Some("uia:token".to_owned());
    refused(
        crate::refs::resolve_saved_ref::resolve_saved_ref(&adapter, &token, deadline(), None)
            .err()
            .unwrap(),
    );
    assert!(adapter.ran.lock().unwrap().is_empty());
}

#[test]
fn a_saved_menu_item_ref_is_routed_to_the_menu_by_the_ref_action_path() {
    let _home = crate::refs::refs_test_support::HomeGuard::new();
    let adapter = Menus::default();
    let context = CommandContext::default();
    let result = crate::snapshot::menu_bar::capture(
        &crate::snapshot::menu_bar::tests::window(),
        &crate::snapshot::menu_bar::tests::sample_bar(),
        10,
    );
    let store = crate::refs::refs_store::RefStore::for_session(context.session_id()).unwrap();
    let snapshot_id = store.save_new_snapshot(&result.refmap).unwrap();
    let ref_id = format!("@{snapshot_id}:e1");
    let value = crate::commands::click::execute(
        crate::commands::helpers::RefArgs {
            ref_id: ref_id.clone(),
            timeout_ms: None,
        },
        &adapter,
        &context,
    )
    .unwrap();
    assert_eq!(value["action"], "click");
    assert_eq!(*adapter.ran.lock().unwrap(), vec![1001]);
    // `get` and `is` resolve to an element, so they refuse it.
    let error = crate::commands::helpers::resolve_ref_with_context(&ref_id, &adapter, &context)
        .err()
        .unwrap();
    assert_eq!(error.code(), "ACTION_NOT_SUPPORTED");
}
