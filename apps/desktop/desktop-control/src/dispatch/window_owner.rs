// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! The process a window id must still belong to, when the caller says so.
//!
//! A window id is resolved by its handle alone, and a handle can be reused by another app's window
//! after the first one closes. When `SPRINT_CODER_DESKTOP_EXPECTED_WINDOW_OWNER` holds
//! `<pid>:<process instance>` (the instance in the form refmaps record it,
//! `windows-proc-v1:<start time>:<n>`), every command that names a window id first checks that the
//! window with that id belongs, right now, to exactly that process instance, and fails before
//! reading or acting on anything otherwise. A value that cannot be read fails every command.
//! Without the variable nothing changes.

use agent_desktop_core::{
    AdapterError, AppError, Deadline, ErrorCode, PlatformAdapter, WindowFilter, WindowInfo,
};
use serde_json::json;

use crate::cli::Commands;

pub(crate) const EXPECTED_WINDOW_OWNER_VARIABLE: &str =
    "SPRINT_CODER_DESKTOP_EXPECTED_WINDOW_OWNER";

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ExpectedOwner {
    pid: u32,
    instance: String,
}

/// Reads `<pid>:<process instance>`; `None` for anything else.
pub(crate) fn parse_expected_owner(raw: &str) -> Option<ExpectedOwner> {
    let (pid, instance) = raw.split_once(':')?;
    let pid = pid.parse::<u32>().ok().filter(|pid| *pid > 0)?;
    let valid = !instance.is_empty()
        && instance.len() <= 128
        && instance
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b":._-".contains(&byte));
    valid.then(|| ExpectedOwner {
        pid,
        instance: instance.to_string(),
    })
}

/// The window id a command names, for every command that takes one.
pub(crate) fn command_window_id(cmd: &Commands) -> Option<&str> {
    match cmd {
        Commands::Snapshot(args) => args.scope.window_id.as_deref(),
        Commands::Find(args) => args.scope.window_id.as_deref(),
        Commands::Screenshot(args) => args.scope.window_id.as_deref(),
        Commands::ResizeWindow(args) => args.scope.window_id.as_deref(),
        Commands::MoveWindow(args) => args.scope.window_id.as_deref(),
        Commands::Minimize(args) | Commands::Maximize(args) | Commands::Restore(args) => {
            args.scope.window_id.as_deref()
        }
        Commands::FocusWindow(args) => args.window_id.as_deref(),
        Commands::Press(args) => args.window_id.as_deref(),
        Commands::Wait(args) => args.event.window_id.as_deref(),
        _ => None,
    }
}

/// Whether the one listed window with this id belongs to the expected process instance.
pub(crate) fn verify_window_owner(
    window_id: &str,
    windows: &[WindowInfo],
    expected: &ExpectedOwner,
) -> Result<(), AppError> {
    let matching: Vec<&WindowInfo> = windows.iter().filter(|w| w.id == window_id).collect();
    let owned = matches!(matching.as_slice(), [window]
        if u32::from(window.pid) == expected.pid
            && window.process_instance.as_deref() == Some(expected.instance.as_str()));
    if owned {
        return Ok(());
    }
    Err(AdapterError::new(
        ErrorCode::PolicyDenied,
        format!(
            "Window '{window_id}' no longer belongs to the app it was allowed for (another app may now use this window id); nothing was read or changed"
        ),
    )
    .with_details(json!({
        "kind": "window_owner_mismatch",
        "window_id": window_id,
        "found": matching.len(),
    }))
    .with_suggestion("Run 'list-windows' or 'snapshot' again to find the app's window.")
    .into())
}

/// Checks the command's window id against `SPRINT_CODER_DESKTOP_EXPECTED_WINDOW_OWNER`.
pub(crate) fn check(cmd: &Commands, adapter: &dyn PlatformAdapter) -> Result<(), AppError> {
    let Some(raw) = std::env::var_os(EXPECTED_WINDOW_OWNER_VARIABLE) else {
        return Ok(());
    };
    let expected = raw.to_str().and_then(parse_expected_owner).ok_or_else(|| {
        AppError::from(AdapterError::new(
            ErrorCode::PolicyDenied,
            format!("{EXPECTED_WINDOW_OWNER_VARIABLE} cannot be read; nothing was run"),
        ))
    })?;
    let Some(window_id) = command_window_id(cmd) else {
        return Ok(());
    };
    let windows = adapter.list_windows(
        &WindowFilter {
            focused_only: false,
            app: None,
        },
        Deadline::standard()?,
    )?;
    verify_window_owner(window_id, &windows, &expected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_desktop_core::ProcessId;

    fn window(id: &str, pid: u32, instance: Option<&str>) -> WindowInfo {
        WindowInfo {
            id: id.to_string(),
            title: String::new(),
            app: "charmap.exe".to_string(),
            pid: ProcessId::from(pid),
            process_instance: instance.map(str::to_string),
            bounds: None,
            state: Default::default(),
        }
    }

    const INSTANCE: &str = "windows-proc-v1:13438878845:5256581";

    #[test]
    fn reads_only_a_pid_and_a_process_instance() {
        assert_eq!(
            parse_expected_owner(&format!("64724:{INSTANCE}")),
            Some(ExpectedOwner {
                pid: 64724,
                instance: INSTANCE.to_string()
            })
        );
        for raw in [
            "",
            "64724",
            "64724:",
            ":windows-proc-v1:1:2",
            "0:windows-proc-v1:1:2",
            "-1:windows-proc-v1:1:2",
            "x:windows-proc-v1:1:2",
            "64724:windows proc",
            "64724:windows-proc-v1:1:2\n",
        ] {
            assert_eq!(parse_expected_owner(raw), None, "{raw:?}");
        }
    }

    #[test]
    fn passes_only_the_one_window_of_the_expected_process_instance() {
        let expected = parse_expected_owner(&format!("64724:{INSTANCE}")).unwrap();
        let ok = [window("w-1", 64724, Some(INSTANCE)), window("w-2", 1, None)];
        assert!(verify_window_owner("w-1", &ok, &expected).is_ok());
        // Another process now holds the id, the same pid reused by another instance, no instance,
        // no such window, or two windows with the id.
        for windows in [
            vec![window("w-1", 22588, Some("windows-proc-v1:1:1"))],
            vec![window("w-1", 64724, Some("windows-proc-v1:13438878845:1"))],
            vec![window("w-1", 64724, None)],
            vec![window("w-2", 64724, Some(INSTANCE))],
            vec![
                window("w-1", 64724, Some(INSTANCE)),
                window("w-1", 64724, Some(INSTANCE)),
            ],
        ] {
            let error = verify_window_owner("w-1", &windows, &expected).unwrap_err();
            let text = format!("{error:?}");
            assert!(text.contains("PolicyDenied"), "{text}");
            assert!(text.contains("window_owner_mismatch"), "{text}");
        }
    }
}
