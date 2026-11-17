// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use crate::{
    AppError,
    adapter::{PlatformAdapter, WindowFilter},
};
use serde_json::Value;

pub struct ListWindowsArgs {
    pub app: Option<String>,
    pub timeout_ms: Option<u64>,
}

pub fn execute(args: ListWindowsArgs, adapter: &dyn PlatformAdapter) -> Result<Value, AppError> {
    crate::response::result_note::set(None);
    let deadline = crate::Deadline::after(
        args.timeout_ms
            .unwrap_or(crate::DEFAULT_OPERATION_TIMEOUT_MS),
    )?;
    let filter = WindowFilter {
        focused_only: false,
        app: args.app,
    };
    let windows = adapter.list_windows(&filter, deadline)?;
    // An empty list for a named app says nothing about why; when the platform
    // can tell, the reason goes to the envelope, since the list stays an array.
    if let (true, Some(app)) = (windows.is_empty(), filter.app.as_deref()) {
        crate::response::result_note::set(
            adapter
                .windowless_app_reason(app, deadline)
                .map(|reason| format!("{} {}", reason.message, reason.suggestion)),
        );
    }
    Ok(serde_json::to_value(windows)?)
}
