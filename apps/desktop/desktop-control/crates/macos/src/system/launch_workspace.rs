// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use agent_desktop_core::{AdapterError, Deadline, system::launch_options::LaunchOptions};

pub(crate) fn open(
    id: &str,
    options: &LaunchOptions,
    deadline: Deadline,
) -> Result<(i32, String), AdapterError> {
    if deadline.is_expired() {
        return Err(deadline
            .timeout_error()
            .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered()));
    }
    crate::system::cocoa_runtime::ensure_cocoa_multithreaded().map_err(|error| {
        error.with_disposition(agent_desktop_core::DeliverySemantics::not_delivered())
    })?;
    let path = resolved_path(id, None)?;
    let path = super::launch_location::require(&path)?;
    let request = serde_json::to_vec(&serde_json::json!({
        "identifier": id,
        "resolved_path": path,
        "bundle_id": super::launch::looks_like_bundle_id(id),
        "arguments": options.args,
        "environment": options.env,
        "activates": options.activate,
        "prompts": false,
        "substitution": false,
        "new_instance": creates_new_instance(options),
    }))
    .map_err(|error| {
        AdapterError::internal(format!("Encode launch request: {error}"))
            .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered())
    })?;
    unsafe { crate::system::launch_completion::open_and_wait(&request, deadline) }
}

pub(crate) fn creates_new_instance(options: &LaunchOptions) -> bool {
    !options.attach_if_running
}

#[cfg(target_os = "macos")]
pub(crate) fn resolved_path(
    id: &str,
    pid: Option<i32>,
) -> Result<std::path::PathBuf, AdapterError> {
    use std::os::unix::ffi::OsStrExt;
    crate::system::cocoa_runtime::ensure_cocoa_multithreaded()?;
    let raw = unsafe {
        agent_desktop_copy_application_path(
            id.as_ptr(),
            id.len(),
            super::launch::looks_like_bundle_id(id),
            pid.unwrap_or(0),
        )
    };
    if raw.is_null() {
        return Err(super::launch_location::refused());
    }
    let bytes = unsafe { std::ffi::CStr::from_ptr(raw) }.to_bytes();
    let path = std::path::PathBuf::from(std::ffi::OsStr::from_bytes(bytes));
    unsafe { libc::free(raw.cast()) };
    Ok(path)
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn agent_desktop_copy_application_path(
        id: *const u8,
        len: usize,
        bundle_id: bool,
        pid: i32,
    ) -> *mut std::ffi::c_char;
}
