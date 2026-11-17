// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::*;

#[test]
fn protected_processes_match_display_and_bundle_forms() {
    assert!(is_protected_process("Finder"));
    assert!(is_protected_process("Dock"));
    assert!(is_protected_process("com.apple.dock"));
    assert!(is_protected_process("WindowServer"));
    assert!(is_protected_process("loginwindow"));
}

#[test]
fn ordinary_apps_are_not_protected() {
    assert!(!is_protected_process("TextEdit"));
    assert!(!is_protected_process("Safari"));
    assert!(!is_protected_process("com.company.MyApp"));
}

#[test]
fn lookalike_names_containing_protected_substrings_stay_closable() {
    assert!(!is_protected_process("Docker"));
    assert!(!is_protected_process("Docker Desktop"));
    assert!(!is_protected_process("com.docker.docker-desktop"));
    assert!(!is_protected_process("FinderSync"));
    assert!(!is_protected_process("PathFinder"));
    assert!(!is_protected_process("launchdarkly-agent"));
}

#[test]
fn adapter_guard_refuses_protected_processes_with_the_cli_contract() {
    let err = ensure_not_protected("loginwindow").unwrap_err();

    assert_eq!(err.code, agent_desktop_core::ErrorCode::InvalidArgs);
    assert!(err.message.contains("protected"));
    assert!(err.suggestion.is_some());
    assert!(ensure_not_protected("TextEdit").is_ok());
}

#[test]
fn native_termination_rejection_does_not_blame_the_target_application() {
    let error = termination_request_not_accepted("Fixture", 42, false);

    assert_eq!(error.code, agent_desktop_core::ErrorCode::ActionFailed);
    assert!(
        error
            .message
            .contains("native termination API did not accept")
    );
    assert!(!error.message.contains("App 'Fixture' rejected"));
    assert_eq!(error.details.as_ref().unwrap()["pid"], 42);
    assert_eq!(error.details.as_ref().unwrap()["force"], false);
}

#[test]
fn adapter_close_without_a_process_instance_keeps_the_invalid_args_contract() {
    use agent_desktop_core::{InteractionLease, SystemOps};

    let app = AppInfo {
        name: "TextEdit".into(),
        pid: agent_desktop_core::ProcessId::new(42),
        bundle_id: None,
        process_instance: None,
        presentation: None,
    };
    let deadline = Deadline::detached_after(1_000).expect("deadline");
    let lease = InteractionLease::guarded(deadline, ()).expect("lease");

    let error = crate::adapter::MacOSAdapter::new()
        .close_app(&app, false, &lease)
        .unwrap_err();

    assert_eq!(error.code, agent_desktop_core::ErrorCode::InvalidArgs);
    assert!(error.message.contains("process instance"));
}

fn waited() -> AdapterError {
    AdapterError::timeout("Operation exceeded its deadline").with_details(serde_json::json!({
        "kind": "deadline",
        "timeout_ms": 5000,
        "elapsed_ms": 5003,
    }))
}

#[test]
fn a_held_quit_keeps_its_code_and_disposition_and_says_what_to_do() {
    let error = quit_request_pending_error(waited(), "Fixture", 42, false, false);

    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(
        error.disposition,
        agent_desktop_core::DeliverySemantics::delivered_unverified()
    );
    assert_eq!(
        error.message,
        "'Fixture' accepted the request to quit but is still running"
    );
    let suggestion = error.suggestion.as_deref().unwrap();
    assert!(suggestion.contains("may be asking the user something first"));
    assert!(suggestion.contains("whether to save changes"));
    assert!(suggestion.contains("may now be visible to the user"));
    assert!(suggestion.contains("Do not send close-app again and do not force it"));
    assert!(suggestion.contains("Tell the user"));
    assert!(!suggestion.contains("busy or unresponsive"));
    let details = error.details.as_ref().unwrap();
    assert_eq!(details["kind"], "quit_request_pending");
    assert_eq!(details["app"], "Fixture");
    assert_eq!(details["pid"], 42);
    assert_eq!(details["force"], false);
    assert_eq!(details["timeout_ms"], 5000);
    assert_eq!(details["elapsed_ms"], 5003);
    // Unsaid when no sheet or dialog was seen, and never a lock wait Main would run again.
    assert!(details.get("pending_dialog").is_none());
    assert!(details.get("retryable").is_none());
    assert!(!error.is_explicitly_retryable());
}

#[test]
fn a_seen_sheet_or_dialog_is_reported_and_still_worded_as_likely() {
    let error = quit_request_pending_error(waited(), "Fixture", 42, false, true);

    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(error.details.as_ref().unwrap()["pending_dialog"], true);
    let suggestion = error.suggestion.as_deref().unwrap();
    assert!(suggestion.contains("showing a sheet or dialog"));
    assert!(suggestion.contains("probably asking the user something first"));
    assert!(suggestion.contains("Do not send close-app again and do not force it"));
}

#[test]
fn a_held_quit_without_wait_details_still_names_the_app() {
    let error = quit_request_pending_error(
        AdapterError::timeout("Operation exceeded its deadline"),
        "Fixture",
        7,
        false,
        false,
    );

    let details = error.details.as_ref().unwrap();
    assert_eq!(details["pid"], 7);
    assert!(details.get("timeout_ms").is_none());
}
