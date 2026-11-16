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
    assert_eq!(exited_launch_pid(&exited(42)), Some(42));
    assert_eq!(exited_launch_pid(&launch_target_gone(42)), Some(42));
    // No pid, or another failure: not a hand-off.
    assert_eq!(exited_launch_pid(&exited(0)), None);
    for error in [
        AdapterError::new(ErrorCode::AppUnresponsive, "exited")
            .with_details(serde_json::json!({ "pid": 42, "complete": false })),
        AdapterError::timeout("busy"),
        crate::system::launch_location::refused(),
        crate::system::launch_completion::bundle_id_refused(),
    ] {
        assert_eq!(exited_launch_pid(&error), None);
    }
}

fn running(pid: u32, instance: &str, bundle_id: &str) -> AppInfo {
    AppInfo {
        name: "Firefox".into(),
        pid: agent_desktop_core::ProcessId::new(pid),
        bundle_id: Some(bundle_id.into()),
        process_instance: Some(instance.into()),
        presentation: None,
    }
}

#[test]
fn only_an_allowed_instance_of_the_same_bundle_may_take_the_launch() {
    let firefox = std::path::Path::new("/Applications/Firefox.app");
    let apps = [
        running(10, "macos-proc-v1:10:1", "org.mozilla.firefox"),
        // Another bundle of the same name (a Nightly build): not the same app.
        running(11, "macos-proc-v1:11:1", "org.mozilla.nightly"),
        // The same bundle, but refused like an attach would be (Sprint Coder itself).
        running(12, "macos-proc-v1:12:1", "org.mozilla.firefox"),
        // The same bundle, but its windows cannot be read: nothing to compare with later.
        running(13, "macos-proc-v1:13:1", "org.mozilla.firefox"),
        AppInfo {
            process_instance: None,
            ..running(14, "", "org.mozilla.firefox")
        },
    ];
    let candidates = handoff_candidates(
        &apps,
        firefox,
        |pid| {
            Some(std::path::PathBuf::from(if pid == 11 {
                "/Applications/Firefox Nightly.app"
            } else {
                "/Applications/Firefox.app"
            }))
        },
        |pid| pid != 12,
        |pid| (pid != 13).then(|| vec![100, 101]),
    );
    assert_eq!(
        candidates,
        [HandoffCandidate {
            pid: 10,
            process_instance: "macos-proc-v1:10:1".into(),
            windows_before: vec![100, 101],
        }]
    );
    // A bundle outside the standard places gives no path, and so no candidate.
    assert!(
        handoff_candidates(&apps[..1], firefox, |_| None, |_| true, |_| Some(vec![])).is_empty()
    );
}

#[test]
fn a_hand_off_is_taken_only_when_the_instance_shows_a_new_window() {
    let candidate = HandoffCandidate {
        pid: 10,
        process_instance: "macos-proc-v1:10:1".into(),
        windows_before: vec![100],
    };
    let candidates = std::slice::from_ref(&candidate);
    // A new window on the third look.
    let mut looks = 0;
    let mut waits = 0;
    let seen = watch_handoff(
        candidates,
        30,
        |_| true,
        |_| {
            looks += 1;
            Some(if looks >= 3 {
                vec![100, 200]
            } else {
                vec![100]
            })
        },
        || waits += 1,
    );
    assert_eq!(seen, HandoffWatch::NewWindow);
    assert_eq!((looks, waits), (3, 2));
    // The same windows the whole time, or one closed: not confirmed.
    assert_eq!(
        watch_handoff(candidates, 5, |_| true, |_| Some(vec![100]), || {}),
        HandoffWatch::NoNewWindow
    );
    assert_eq!(
        watch_handoff(candidates, 5, |_| true, |_| Some(vec![]), || {}),
        HandoffWatch::NoNewWindow
    );
    // Windows that cannot be read do not confirm it.
    assert_eq!(
        watch_handoff(candidates, 5, |_| true, |_| None, || {}),
        HandoffWatch::NoNewWindow
    );
    // The instance is gone: the launch's own outcome stands.
    assert_eq!(
        watch_handoff(candidates, 5, |_| false, |_| Some(vec![100, 200]), || {}),
        HandoffWatch::NoInstance
    );
    assert_eq!(
        watch_handoff(&[], 5, |_| true, |_| Some(vec![1]), || {}),
        HandoffWatch::NoInstance
    );
}

#[test]
fn each_watch_outcome_returns_what_can_be_said() {
    assert!(handoff_outcome(HandoffWatch::NoInstance, "Firefox", 42, None, false).is_none());
    let result = handoff_outcome(
        HandoffWatch::NewWindow,
        "Google Chrome",
        42,
        Some("macos-proc-v1:3:4"),
        false,
    )
    .unwrap()
    .unwrap();
    assert!(result.handed_off && result.attached);
    assert!(!result.new_instance && !result.existing_window && !result.running_without_window);
    assert!(result.window.is_none() && result.activated.is_none());
    assert_eq!(result.pid, agent_desktop_core::ProcessId::new(42));
    assert!(result.suggestion.unwrap().contains("list-windows"));
    // With --activate, the front is not confirmed.
    let activated = handoff_outcome(HandoffWatch::NewWindow, "Google Chrome", 42, None, true)
        .unwrap()
        .unwrap();
    assert_eq!(activated.activated, Some(false));
    // Not confirmed: delivery uncertain, and told not to repeat the launch.
    let error = handoff_outcome(HandoffWatch::NoNewWindow, "Firefox", 42, None, false)
        .unwrap()
        .unwrap_err();
    assert_eq!(
        error.details.as_ref().unwrap()["kind"],
        "launch_handoff_unconfirmed"
    );
    assert_eq!(
        serde_json::to_value(error.disposition).unwrap(),
        serde_json::to_value(DeliverySemantics::uncertain()).unwrap()
    );
    assert!(
        error
            .suggestion
            .unwrap()
            .contains("Do not repeat the launch")
    );
}
