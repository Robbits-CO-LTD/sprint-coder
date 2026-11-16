// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::*;

#[test]
fn no_attach_requests_a_fresh_application_instance() {
    let options = LaunchOptions {
        attach_if_running: false,
        ..Default::default()
    };

    assert!(crate::system::launch_workspace::creates_new_instance(
        &options
    ));
}

#[test]
fn default_launch_allows_attaching_to_a_running_instance() {
    let options = LaunchOptions::default();

    assert!(!crate::system::launch_workspace::creates_new_instance(
        &options
    ));
}

#[test]
fn validates_safe_names_and_bundle_identifiers() {
    assert!(validate_app_identifier("Safari").is_ok());
    assert!(validate_app_identifier("com.apple.Safari").is_ok());
}

#[test]
fn rejects_paths_and_unsafe_bundle_identifiers() {
    for identifier in [
        "../Evil",
        "/abs/path",
        "Foo/Bar",
        "bad\0name",
        "bad\nname",
        "com.apple.$evil",
    ] {
        let error = validate_app_identifier(identifier).expect_err("unsafe identifier");
        assert_eq!(error.code, ErrorCode::InvalidArgs);
        assert!(!error.message.contains(identifier));
        assert_eq!(error.details.expect("details")["app_name"], identifier);
    }
}

#[test]
fn waiting_ends_only_after_a_completed_startup_plus_its_grace() {
    let now = std::time::Instant::now();

    assert!(!grace_over(None, now));
    assert!(!grace_over(now.checked_add(STARTUP_GRACE), now));
    assert!(grace_over(Some(now), now));
}

#[test]
fn app_unresponsive_and_timeout_window_reads_are_not_ready_yet() {
    assert!(window_read_is_not_ready_yet(
        &AdapterError::app_unresponsive("Numbers")
    ));
    assert!(window_read_is_not_ready_yet(&AdapterError::timeout("busy")));
}

#[test]
fn every_other_error_code_ends_the_wait_immediately() {
    assert!(!window_read_is_not_ready_yet(&AdapterError::stale_ref(
        "@e1"
    )));
    assert!(!window_read_is_not_ready_yet(
        &AdapterError::permission_denied()
    ));
}

#[test]
fn exact_native_launch_rejects_a_working_directory() {
    let options = LaunchOptions {
        cwd: Some(std::path::PathBuf::from("/tmp")),
        ..Default::default()
    };

    let error = validate_launch_options(&options).expect_err("cwd is unsupported");

    assert_eq!(error.code, ErrorCode::ActionNotSupported);
}

#[test]
fn launch_options_enforce_bounded_entry_counts() {
    let options = LaunchOptions {
        args: (0..=MAX_ARGUMENT_COUNT)
            .map(|index| index.to_string())
            .collect(),
        ..Default::default()
    };

    let error = validate_launch_options(&options).expect_err("too many args");

    assert_eq!(error.code, ErrorCode::InvalidArgs);
}

#[test]
fn launch_options_enforce_a_bounded_text_budget() {
    let options = LaunchOptions {
        args: vec!["x".repeat(MAX_LAUNCH_TEXT_BYTES + 1)],
        ..Default::default()
    };

    let error = validate_launch_options(&options).expect_err("payload too large");

    assert_eq!(error.code, ErrorCode::InvalidArgs);
}

#[test]
fn activation_reports_false_instead_of_failing_after_the_app_opened() {
    let app = AppInfo {
        name: "fixture".into(),
        pid: agent_desktop_core::ProcessId::new(42),
        bundle_id: None,
        process_instance: Some("macos-proc-v1:1:2".into()),
        presentation: None,
    };
    let window = WindowInfo::for_process(&app);
    // No window: the front is not read at all.
    assert!(!window_is_in_front(None, || panic!(
        "front must not be read"
    )));
    // The front could not be read (time-out, front app changed): not activated, no error.
    assert!(!window_is_in_front(Some(&window), || Err(
        AdapterError::timeout("front read timed out")
    )));
    assert!(!window_is_in_front(Some(&window), || Ok(None)));
    let mut other = window.clone();
    other.id = "w-999999".into();
    assert!(!window_is_in_front(Some(&window), || Ok(Some(other))));
    let front = window.clone();
    assert!(window_is_in_front(Some(&window), || Ok(Some(front))));
}

#[test]
fn only_a_started_process_that_exited_is_read_as_a_possible_hand_off() {
    let exited = |pid: i64| {
        AdapterError::new(ErrorCode::AppUnresponsive, "exited").with_details(serde_json::json!({
            "pid": pid,
            "complete": false,
            "kind": LAUNCHED_PROCESS_EXITED,
        }))
    };
    assert_eq!(exited_launch_pid(&exited(42), None), Some(42));
    assert_eq!(exited_launch_pid(&exited(42), Some(42)), Some(42));
    assert_eq!(
        exited_launch_pid(&launch_target_gone(42), Some(42)),
        Some(42)
    );
    // Another process than the one started, no pid, or another failure: not a hand-off.
    assert_eq!(exited_launch_pid(&exited(42), Some(7)), None);
    assert_eq!(exited_launch_pid(&exited(0), None), None);
    for error in [
        AdapterError::new(ErrorCode::AppUnresponsive, "exited")
            .with_details(serde_json::json!({ "pid": 42, "complete": false })),
        AdapterError::timeout("busy"),
        crate::system::launch_location::refused(),
    ] {
        assert_eq!(exited_launch_pid(&error, Some(42)), None);
    }
}

#[test]
fn a_launch_is_handed_off_only_while_an_instance_from_before_it_still_runs() {
    let before = vec!["macos-proc-v1:1:2".to_owned()];
    assert!(passed_to_running_instance(
        &before,
        &[
            "macos-proc-v1:9:9".to_owned(),
            "macos-proc-v1:1:2".to_owned()
        ]
    ));
    // The instance from before is gone, or only a new one runs: not handed off.
    assert!(!passed_to_running_instance(&before, &[]));
    assert!(!passed_to_running_instance(
        &before,
        &["macos-proc-v1:9:9".to_owned()]
    ));
    assert!(!passed_to_running_instance(
        &[],
        &["macos-proc-v1:1:2".to_owned()]
    ));
}

#[test]
fn a_handed_off_launch_names_no_window_and_says_how_to_find_it() {
    let result = handed_off_result(
        "Google Chrome",
        agent_desktop_core::ProcessId::new(42),
        Some("macos-proc-v1:3:4".into()),
    );
    assert!(result.handed_off && result.attached);
    assert!(!result.new_instance && !result.existing_window && !result.running_without_window);
    assert!(result.window.is_none() && result.activated.is_none());
    assert_eq!(result.pid, agent_desktop_core::ProcessId::new(42));
    assert!(result.suggestion.unwrap().contains("list-windows"));
}
