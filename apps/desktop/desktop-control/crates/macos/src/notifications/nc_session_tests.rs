// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::{
    NcSession, NcSessionOps, closed_center_policy_error, merge_acting_session_result,
    merge_session_result, nc_pid_from_output,
};
use agent_desktop_core::{AdapterError, ErrorCode, ProcessIdentity};

#[test]
fn nc_pid_preserves_probe_errors() {
    let error = nc_pid_from_output(Err(AdapterError::timeout("pid probe timed out")))
        .expect_err("timeout must not become process-not-found");

    assert_eq!(error.code, ErrorCode::Timeout);
}

#[test]
fn closed_notification_center_is_policy_denied_headlessly() {
    let error = closed_center_policy_error(agent_desktop_core::InteractionPolicy::headless());

    assert_eq!(error.code, ErrorCode::PolicyDenied);
    assert!(error.message.contains("headless"));
    assert!(
        error
            .suggestion
            .as_deref()
            .is_some_and(|value| value.contains("--headed"))
    );
}

#[test]
fn cleanup_retries_only_the_failed_step_with_a_fresh_budget() {
    let mut session = NcSession {
        pid: 7,
        close_pending: true,
        previous_app: Some(ProcessIdentity::new(9_u32, "instance")),
        cleanup_on_drop: false,
    };
    let mut close_attempts = 0;
    let mut restore_attempts = 0;

    let error = session
        .cleanup_with(
            |deadline| {
                assert!(!deadline.is_expired());
                close_attempts += 1;
                Err(AdapterError::timeout("close failed"))
            },
            |_, deadline| {
                assert!(!deadline.is_expired());
                restore_attempts += 1;
                Ok(())
            },
        )
        .expect_err("close failure must be reported");

    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(close_attempts, 1);
    assert_eq!(restore_attempts, 1);
    assert!(session.close_pending);
    assert!(session.previous_app.is_none());

    session
        .cleanup_with(
            |deadline| {
                assert!(!deadline.is_expired());
                close_attempts += 1;
                Ok(())
            },
            |_, _| panic!("successful restoration must not repeat"),
        )
        .unwrap();
    assert_eq!(close_attempts, 2);
    assert!(!session.close_pending);
}

#[test]
fn operation_failure_wins_when_cleanup_also_fails() {
    let operation = AdapterError::new(ErrorCode::ElementNotFound, "operation failed");
    let cleanup = AdapterError::timeout("cleanup failed");

    let error = merge_session_result::<()>(Err(operation), Err(cleanup)).unwrap_err();

    assert_eq!(error.code, ErrorCode::ElementNotFound);
}

#[test]
fn cleanup_failure_replaces_an_apparent_operation_success() {
    let cleanup = AdapterError::timeout("cleanup failed");

    let error = merge_session_result(Ok("value"), Err(cleanup)).unwrap_err();

    assert_eq!(error.code, ErrorCode::Timeout);
}

#[test]
fn explicit_close_returns_success_when_bounded_retry_recovers() {
    let mut session = NcSession {
        pid: 7,
        close_pending: true,
        previous_app: None,
        cleanup_on_drop: true,
    };
    let attempts = std::cell::Cell::new(0);

    let result = session.close_with(
        |_| {
            attempts.set(attempts.get() + 1);
            if attempts.get() == 1 {
                Err(AdapterError::timeout("transient close failure"))
            } else {
                Ok(())
            }
        },
        |_, _| Ok(()),
    );

    assert!(result.is_ok());
    assert_eq!(attempts.get(), 2);
    assert!(!session.cleanup_on_drop);
}

#[test]
fn explicit_close_returns_final_error_without_arming_drop_retry() {
    let mut session = NcSession {
        pid: 7,
        close_pending: true,
        previous_app: None,
        cleanup_on_drop: true,
    };
    let attempts = std::cell::Cell::new(0);

    let error = session
        .close_with(
            |_| {
                attempts.set(attempts.get() + 1);
                Err(AdapterError::timeout(format!(
                    "close attempt {} failed",
                    attempts.get()
                )))
            },
            |_, _| Ok(()),
        )
        .unwrap_err();

    assert_eq!(attempts.get(), 2);
    assert!(error.message.contains("attempt 2"));
    assert!(!session.cleanup_on_drop);
}

#[test]
fn partial_open_failure_closes_center_and_restores_previous_app() {
    let previous = ProcessIdentity::new(9_u32, "instance");
    let mut close_attempts = 0;
    let mut restore_attempts = 0;

    let result = NcSession::open_with(
        Some(previous.clone()),
        agent_desktop_core::Deadline::after(0).unwrap(),
        NcSessionOps {
            open: |_| Ok(()),
            wait_until_ready: |_| Err(AdapterError::timeout("readiness failed")),
            close: |deadline| {
                assert!(!deadline.is_expired());
                close_attempts += 1;
                Ok(())
            },
            reactivate: |app, deadline| {
                assert_eq!(app, &previous);
                assert!(!deadline.is_expired());
                restore_attempts += 1;
                Ok(())
            },
        },
    );
    let error = match result {
        Ok(_) => panic!("readiness failure must be preserved"),
        Err(error) => error,
    };

    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(close_attempts, 1);
    assert_eq!(restore_attempts, 1);
}

#[test]
fn close_delay_does_not_consume_focus_restoration_budget() {
    let mut session = NcSession {
        pid: 7,
        close_pending: true,
        previous_app: Some(ProcessIdentity::new(9_u32, "instance")),
        cleanup_on_drop: false,
    };
    let mut restore_attempted = false;
    let close_deadline = std::cell::Cell::new(None);

    session
        .cleanup_with(
            |deadline| {
                close_deadline.set(Some(deadline));
                std::thread::sleep(std::time::Duration::from_millis(200));
                Err(AdapterError::timeout("close timed out"))
            },
            |_, deadline| {
                restore_attempted = true;
                assert_ne!(Some(deadline), close_deadline.get());
                assert!(!deadline.is_expired());
                Ok(())
            },
        )
        .expect_err("close failure must remain visible");

    assert!(restore_attempted);
    assert!(session.previous_app.is_none());
    session.close_pending = false;
}

#[test]
fn a_refused_cleanup_after_a_completed_operation_is_not_reported_as_not_delivered() {
    let _scope = crate::system::own_window::enter(
        &crate::RefusedWindowOwner::Process {
            pid: 42,
            instance: None,
        },
        "dismiss_notification",
    );
    let refused = crate::system::own_window::check_pid(Some(42)).unwrap_err();
    assert_eq!(
        refused.disposition,
        agent_desktop_core::DeliverySemantics::not_delivered()
    );

    let error = merge_acting_session_result(Ok("dismissed"), Err(refused)).unwrap_err();

    assert_eq!(error.code, ErrorCode::PolicyDenied);
    assert_ne!(
        error.disposition,
        agent_desktop_core::DeliverySemantics::not_delivered()
    );
    let details = error.details.unwrap();
    assert_eq!(details["kind"], "own_window_refused");
    assert_eq!(details["physical_delivery_started"], true);
    assert_eq!(details["operation_completed"], true);
    assert_eq!(details["cleanup_failed"], true);
    assert_eq!(details["operation_result"], "dismissed");
    assert!(!error.message.contains("nothing was sent"));
}

#[test]
fn a_failed_cleanup_after_a_completed_operation_keeps_its_code_and_the_delivery() {
    let cleanup = AdapterError::timeout("cleanup failed")
        .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered());

    let error = merge_acting_session_result(Ok(vec![1, 2]), Err(cleanup)).unwrap_err();

    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(
        error.disposition,
        agent_desktop_core::DeliverySemantics::delivered_unverified()
    );
    let details = error.details.unwrap();
    assert_eq!(details["physical_delivery_started"], true);
    assert_eq!(details["operation_result"], serde_json::json!([1, 2]));
}

#[test]
fn an_acting_operation_failure_still_wins_over_its_cleanup() {
    let operation = AdapterError::new(ErrorCode::ElementNotFound, "operation failed");

    let error = merge_acting_session_result::<()>(
        Err(operation),
        Err(AdapterError::timeout("cleanup failed")),
    )
    .unwrap_err();

    assert_eq!(error.code, ErrorCode::ElementNotFound);
    assert!(merge_acting_session_result(Ok(1), Ok(())).is_ok_and(|value| value == 1));
}

#[test]
fn sprint_coder_is_skipped_not_reactivated_after_the_notification_center() {
    let pid = std::process::id();
    let raw_pid = i32::try_from(pid).unwrap();
    let instance = crate::system::process::process_identity::token_for_pid(raw_pid)
        .unwrap()
        .expect("own instance");
    let own = ProcessIdentity::new(pid, instance);
    let deadline = agent_desktop_core::Deadline::standard().unwrap();

    {
        let _scope = crate::system::own_window::enter(
            &crate::RefusedWindowOwner::Process {
                pid,
                instance: None,
            },
            "list_notifications",
        );
        assert!(super::reactivate_app(&own, deadline).is_ok());
    }
    let _scope = crate::system::own_window::enter(
        &crate::RefusedWindowOwner::Unreadable,
        "list_notifications",
    );
    let error = super::reactivate_app(&own, deadline).unwrap_err();
    assert_eq!(
        error.details.unwrap()["kind"],
        "own_window_variable_unreadable"
    );
}
