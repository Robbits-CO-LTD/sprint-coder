// Changed by Sprint Coder (new file); see VENDORED.md in apps/desktop/desktop-control.
use crate::{AdapterError, Deadline, ErrorCode, adapter::PlatformAdapter};

/// Why a running app lists no window a command can use, as far as the platform
/// can tell from what it reads. The platform words it; the code stays
/// `WINDOW_NOT_FOUND`, so callers that branch on the code are unchanged.
#[derive(Debug, Clone, PartialEq)]
pub struct WindowlessReason {
    /// Said in place of the generic "no matching window" message.
    pub message: String,
    pub suggestion: String,
    pub details: serde_json::Value,
}

impl WindowlessReason {
    pub(crate) fn into_error(self) -> AdapterError {
        AdapterError::new(ErrorCode::WindowNotFound, self.message)
            .with_suggestion(self.suggestion)
            .with_details(self.details)
    }
}

/// The error for a named app that is running but lists no usable window: the
/// adapter's reason when it has one, the generic error otherwise.
pub(crate) fn no_window_error(
    adapter: &dyn PlatformAdapter,
    app: &str,
    deadline: Deadline,
) -> AdapterError {
    adapter.windowless_app_reason(app, deadline).map_or_else(
        || AdapterError::app_has_no_window(app),
        WindowlessReason::into_error,
    )
}

#[cfg(test)]
mod tests {
    use super::WindowlessReason;
    use crate::ErrorCode;

    #[test]
    fn a_reason_keeps_the_window_not_found_code_and_carries_its_words() {
        let error = WindowlessReason {
            message: "message".into(),
            suggestion: "suggestion".into(),
            details: serde_json::json!({ "kind": "k" }),
        }
        .into_error();
        assert_eq!(error.code, ErrorCode::WindowNotFound);
        assert_eq!(error.message, "message");
        assert_eq!(error.suggestion.as_deref(), Some("suggestion"));
        assert_eq!(error.details, Some(serde_json::json!({ "kind": "k" })));
    }
}
