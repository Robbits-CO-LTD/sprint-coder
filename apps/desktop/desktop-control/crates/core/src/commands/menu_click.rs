// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! Running a menu item ref (`refs::ref_menu`): `click` only, never through the
//! accessibility tree.

use serde_json::Value;

use crate::{
    AppError, actions::action::Action, actions::action_request::ActionRequest,
    adapter::PlatformAdapter, context::CommandContext, refs::RefEntry, refs::ref_ancestry::Proof,
};

/// Runs `request` on the menu item `entry` names. Anything but a headless
/// click is refused before anything is read; the window must still be the
/// one the ref was read from, by its id, pid and process instance; the
/// adapter then confirms the live menu and sends the item's command.
pub(crate) fn execute(
    adapter: &dyn PlatformAdapter,
    entry: &RefEntry,
    request: ActionRequest,
    context: &CommandContext,
) -> Result<Value, AppError> {
    if crate::refs::ref_ancestry::proof_of(entry) != Proof::InMenu
        || !matches!(request.action, Action::Click)
        || request.policy.is_headed()
    {
        return Err(crate::refs::ref_menu::menu_ref_refused(entry).into());
    }
    let deadline = crate::ref_action::ref_action_wait::operation_deadline(&request)?;
    let lease = super::helpers::acquire_interaction_lease(adapter)?;
    let window = crate::refs::resolve_saved_ref::recorded_window(adapter, entry, deadline)?;
    let result = adapter.run_menu_command(entry, &window, deadline, &lease)?;
    drop(lease);
    let value = serde_json::to_value(result)?;
    super::helpers::apply_post_action_wait(value, Some(entry), adapter, context)
}

#[cfg(test)]
#[path = "menu_click_tests.rs"]
mod tests;
