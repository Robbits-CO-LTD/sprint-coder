// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use crate::{
    AdapterError, InteractionLease, actions::action_request::ActionRequest,
    actions::action_result::ActionResult, adapter::native_handle::NativeHandle,
};

pub trait ActionOps: Send + Sync {
    /// Runs the standard menu item a menu item ref names (`refs::ref_menu`)
    /// in `window`, which core has already matched to the ref's window and
    /// process instance. The adapter must send nothing that runs the item
    /// unless the live menu still shows it as recorded, and must report a
    /// delivery it cannot observe as unverified. An adapter without native
    /// menus answers with this default.
    fn run_menu_command(
        &self,
        _entry: &crate::RefEntry,
        _window: &crate::WindowInfo,
        _deadline: crate::Deadline,
        _lease: &InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        Err(AdapterError::not_supported("run_menu_command"))
    }

    fn execute_action(
        &self,
        _handle: &NativeHandle,
        _request: ActionRequest,
        _lease: &InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        Err(AdapterError::not_supported("execute_action"))
    }

    fn scroll_into_view(
        &self,
        handle: &NativeHandle,
        lease: &InteractionLease,
    ) -> Result<(), AdapterError> {
        let _ = (handle, lease);
        Err(AdapterError::not_supported("scroll_into_view"))
    }

    /// Prepare a ref for dispatch. An adapter may return a strictly verified
    /// handle when its own scroll supplies independent evidence of the same
    /// native object's movement. Otherwise the caller resolves the original
    /// ref again; scrolling alone never authorizes rebinding a target.
    fn scroll_ref_into_view(
        &self,
        _entry: &crate::RefEntry,
        handle: &NativeHandle,
        lease: &InteractionLease,
    ) -> Result<Option<NativeHandle>, AdapterError> {
        self.scroll_into_view(handle, lease)?;
        Ok(None)
    }
}
