// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use agent_desktop_core::{
    Action, ActionOps, ActionResult, ActionStep, AdapterError, InteractionLease, NativeHandle,
    StepMechanism, actions::action_request::ActionRequest,
};

use crate::adapter::{MacOSAdapter, ax_element};

impl ActionOps for MacOSAdapter {
    fn execute_action(
        &self,
        handle: &NativeHandle,
        request: ActionRequest,
        lease: &InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        let _scope = self.acting(request.action.name());
        if handle.is_null() {
            crate::system::own_window::check_front()?;
            return execute_global_action(request, lease);
        }
        crate::system::own_window::check_element(ax_element(handle)?, lease.deadline())?;
        execute_action_impl(handle, request, lease)
    }

    fn scroll_into_view(
        &self,
        handle: &NativeHandle,
        lease: &InteractionLease,
    ) -> Result<(), AdapterError> {
        let _scope = self.acting("scroll_into_view");
        crate::system::own_window::check_element(ax_element(handle)?, lease.deadline())?;
        crate::actions::scroll_into_view::scroll_into_view_impl(
            ax_element(handle)?,
            lease.deadline(),
        )
    }
}

fn execute_action_impl(
    handle: &NativeHandle,
    request: ActionRequest,
    lease: &InteractionLease,
) -> Result<ActionResult, AdapterError> {
    crate::actions::perform_action(ax_element(handle)?, &request, lease.deadline())
}

fn execute_global_action(
    request: ActionRequest,
    lease: &InteractionLease,
) -> Result<ActionResult, AdapterError> {
    let Action::PressKey(combo) = request.action else {
        return Err(AdapterError::not_supported("global element action"));
    };
    crate::input::keyboard::synthesize_key(&combo, None, lease.deadline())?;
    Ok(
        ActionResult::delivered_unverified("press_key").with_steps(vec![
            ActionStep::succeeded("CGEventPost")
                .with_mechanism(StepMechanism::PhysicalSynthetic)
                .with_verified(false),
        ]),
    )
}
