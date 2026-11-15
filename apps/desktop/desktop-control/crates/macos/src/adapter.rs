// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
pub struct MacOSAdapter {
    refused_owner: crate::system::own_window::RefusedWindowOwner,
}

impl MacOSAdapter {
    pub fn refusing_windows_of(
        mut self,
        owner: crate::system::own_window::RefusedWindowOwner,
    ) -> Self {
        self.refused_owner = owner;
        self
    }

    pub(crate) fn acting(&self, operation: &'static str) -> crate::system::own_window::ActingScope {
        crate::system::own_window::enter(&self.refused_owner, operation)
    }

    pub fn new() -> Self {
        Self {
            refused_owner: Default::default(),
        }
    }
}

impl Default for MacOSAdapter {
    fn default() -> Self {
        Self::new()
    }
}

pub(crate) fn ax_element(
    handle: &agent_desktop_core::NativeHandle,
) -> Result<&crate::tree::AXElement, agent_desktop_core::AdapterError> {
    handle
        .downcast_ref::<crate::tree::AXElement>()
        .ok_or_else(|| {
            agent_desktop_core::AdapterError::new(
                agent_desktop_core::ErrorCode::InvalidArgs,
                "Native handle does not contain a macOS accessibility element",
            )
            .with_details(serde_json::json!({
                "kind": "invalid_native_handle",
                "platform": "macos",
                "empty": handle.is_null()
            }))
        })
}

#[cfg(test)]
mod tests {
    use super::ax_element;
    use agent_desktop_core::{ErrorCode, NativeHandle};

    #[test]
    fn empty_handle_is_rejected_without_a_pointer_cast() {
        let empty = NativeHandle::null();
        let Err(error) = ax_element(&empty) else {
            panic!("empty handle must be rejected");
        };

        assert_eq!(error.code, ErrorCode::InvalidArgs);
        assert_eq!(error.details.unwrap()["kind"], "invalid_native_handle");
    }

    #[test]
    fn wrong_platform_payload_is_rejected_without_a_pointer_cast() {
        let wrong = NativeHandle::new(String::from("uia-token"));
        let Err(error) = ax_element(&wrong) else {
            panic!("wrong payload type must be rejected");
        };

        assert_eq!(error.code, ErrorCode::InvalidArgs);
        assert_eq!(error.details.unwrap()["platform"], "macos");
    }
}
