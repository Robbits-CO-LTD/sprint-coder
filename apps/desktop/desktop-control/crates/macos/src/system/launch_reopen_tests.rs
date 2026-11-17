// Changed by Sprint Coder (new file); see VENDORED.md in apps/desktop/desktop-control.
use super::*;
use agent_desktop_core::ErrorCode;
use std::cell::Cell;

fn attach() -> LaunchOptions {
    LaunchOptions::default()
}

#[test]
fn minimized_is_proven_none_only_from_a_complete_read_where_every_window_answered() {
    assert_eq!(minimized_from([], true), Minimized::None);
    assert_eq!(
        minimized_from([Some(false), Some(false)], true),
        Minimized::None
    );
    assert_eq!(
        minimized_from([Some(false), Some(true)], true),
        Minimized::Some
    );
    assert_eq!(minimized_from([None, Some(true)], true), Minimized::Some);
    assert_eq!(
        minimized_from([Some(false), None], true),
        Minimized::Unknown
    );
    assert_eq!(minimized_from([], false), Minimized::Unknown);
    assert_eq!(minimized_from([Some(true)], false), Minimized::Unknown);
}

#[test]
fn only_a_plain_attach_of_a_regular_app_without_a_minimized_window_is_reopened() {
    assert_eq!(
        may_reopen(&attach(), false, true, || Minimized::None),
        Ok(())
    );
    assert_eq!(
        may_reopen(&attach(), false, true, || Minimized::Some),
        Err(Reopen::NotSent { minimized: true })
    );
    assert_eq!(
        may_reopen(&attach(), false, true, || Minimized::Unknown),
        Err(Reopen::NotSent { minimized: false })
    );
    assert_eq!(
        may_reopen(&attach(), false, false, || Minimized::None),
        Err(Reopen::NotSent { minimized: false })
    );
    // An app that has a usable window is never asked.
    assert_eq!(
        may_reopen(&attach(), true, true, || Minimized::None),
        Err(Reopen::NotSent { minimized: false })
    );
    let activate = LaunchOptions {
        activate: true,
        ..attach()
    };
    let no_attach = LaunchOptions {
        attach_if_running: false,
        ..attach()
    };
    // `--url` never attaches and limits the bundle ids.
    let url = LaunchOptions {
        attach_if_running: false,
        bundle_ids: vec!["com.google.Chrome".into()],
        ..attach()
    };
    let limited = LaunchOptions {
        bundle_ids: vec!["com.apple.TextEdit".into()],
        ..attach()
    };
    for options in [activate, no_attach, url, limited] {
        assert_eq!(
            may_reopen(&options, false, true, || Minimized::None),
            Err(Reopen::NotSent { minimized: false }),
            "{options:?}"
        );
    }
}

#[test]
fn the_minimized_windows_are_read_only_when_everything_else_allows_the_reopen() {
    let reads = Cell::new(0);
    let read = || {
        reads.set(reads.get() + 1);
        Minimized::None
    };
    let activate = LaunchOptions {
        activate: true,
        ..attach()
    };
    let _ = may_reopen(&activate, false, true, read);
    let _ = may_reopen(&attach(), false, false, read);
    let _ = may_reopen(&attach(), true, true, read);
    assert_eq!(reads.get(), 0);
    let _ = may_reopen(&attach(), false, true, read);
    assert_eq!(reads.get(), 1);
}

#[test]
fn the_reopen_never_activates_never_starts_a_new_instance_and_drops_what_the_caller_added() {
    let options = LaunchOptions {
        args: vec!["--x".into()],
        env: [("K".to_owned(), "V".to_owned())].into_iter().collect(),
        timeout_ms: 1_234,
        ..attach()
    };
    let reopen = reopen_options(&options);
    assert!(!reopen.activate);
    assert!(reopen.attach_if_running);
    assert!(!crate::system::launch_workspace::creates_new_instance(
        &reopen
    ));
    assert!(reopen.args.is_empty() && reopen.env.is_empty() && reopen.cwd.is_none());
    assert!(reopen.bundle_ids.is_empty() && reopen.cdp_port.is_none());
    assert_eq!(reopen.timeout_ms, 1_234);
}

#[test]
fn the_app_is_asked_once_and_only_when_allowed() {
    let sends = Cell::new(0);
    let waits = Cell::new(0);
    let send = || {
        sends.set(sends.get() + 1);
        Ok(())
    };
    let wait = || {
        waits.set(waits.get() + 1);
        Ok(Some("w-1"))
    };
    assert_eq!(
        reopen_once(Ok(()), true, send, wait).unwrap(),
        (Some("w-1"), Reopen::Sent { waited: true })
    );
    assert_eq!((sends.get(), waits.get()), (1, 1));

    let not_sent = Reopen::NotSent { minimized: true };
    assert_eq!(
        reopen_once(Err(not_sent), true, send, wait).unwrap(),
        (None, not_sent)
    );
    assert_eq!((sends.get(), waits.get()), (1, 1));

    let zero = reopen_once(Ok(()), false, send, || Ok(None::<&str>)).unwrap();
    assert_eq!(zero, (None, Reopen::Sent { waited: false }));
    assert_eq!(sends.get(), 2);
}

#[test]
fn a_refused_open_is_returned_and_nothing_is_waited_for() {
    let waits = Cell::new(0);
    let refused = reopen_once(
        Ok(()),
        true,
        || Err(AdapterError::new(ErrorCode::PermDenied, "Launch refused")),
        || {
            waits.set(waits.get() + 1);
            Ok(Some(()))
        },
    )
    .unwrap_err();
    assert_eq!(refused.code, ErrorCode::PermDenied);
    assert_eq!(waits.get(), 0);
}

#[test]
fn each_outcome_says_what_was_done() {
    let sent = Reopen::Sent { waited: true };
    let not_waited = Reopen::Sent { waited: false };
    let minimized = Reopen::NotSent { minimized: true };
    let not_sent = Reopen::NotSent { minimized: false };
    assert_eq!(reopen_suggestion(sent, true), Some(REOPENED_WINDOW));
    assert_eq!(reopen_suggestion(not_waited, true), Some(REOPENED_WINDOW));
    assert_eq!(reopen_suggestion(sent, false), Some(REOPENED_NO_WINDOW));
    assert_eq!(
        reopen_suggestion(not_waited, false),
        Some(REOPENED_NOT_WAITED)
    );
    assert_eq!(
        reopen_suggestion(minimized, false),
        Some(MINIMIZED_NOT_REOPENED)
    );
    assert_eq!(reopen_suggestion(not_sent, false), Some(NOT_REOPENED));
    assert_eq!(reopen_suggestion(not_sent, true), None);
}

#[test]
fn the_texts_say_what_was_asked_what_to_do_and_never_to_wait_or_loop() {
    assert!(REOPENED_WINDOW.contains("without bringing it to the front"));
    assert!(REOPENED_WINDOW.contains("not a window the user was using"));
    assert!(REOPENED_WINDOW.contains("Do not repeat the launch"));

    assert!(REOPENED_NO_WINDOW.contains("asked it to open a window"));
    assert!(REOPENED_NO_WINDOW.contains("no window appeared"));
    assert!(REOPENED_NO_WINDOW.contains("Waiting will not help"));
    assert!(REOPENED_NO_WINDOW.contains("do not retry it in a loop"));
    assert!(REOPENED_NO_WINDOW.contains("Tell the user"));
    assert!(REOPENED_NO_WINDOW.contains("With the user's agreement, `launch` with `--activate`"));

    assert!(REOPENED_NOT_WAITED.contains("did not wait"));
    assert!(REOPENED_NOT_WAITED.contains("`list-windows`"));
    assert!(REOPENED_NOT_WAITED.contains("do not repeat the launch"));

    assert!(MINIMIZED_NOT_REOPENED.contains("did not ask"));
    assert!(MINIMIZED_NOT_REOPENED.contains("Do not restore it on your own"));

    assert!(NOT_REOPENED.contains("did not ask it to open one"));
    assert!(NOT_REOPENED.contains("Waiting will not help"));
    assert!(NOT_REOPENED.contains("Tell the user"));

    for text in [
        REOPENED_WINDOW,
        REOPENED_NO_WINDOW,
        REOPENED_NOT_WAITED,
        MINIMIZED_NOT_REOPENED,
        NOT_REOPENED,
        NO_WINDOW_GUIDANCE,
    ] {
        assert!(!text.contains("Wait for the app"), "{text}");
        assert!(!text.contains("  "), "{text}");
    }
}

#[test]
fn a_running_app_with_no_window_is_told_to_launch_once() {
    let reason = no_window_reason("TextEdit", 42);
    assert_eq!(
        reason.message,
        "Application 'TextEdit' is running but shows no window."
    );
    assert_eq!(reason.suggestion, NO_WINDOW_GUIDANCE);
    assert!(NO_WINDOW_GUIDANCE.contains("Waiting will not make one appear"));
    assert!(NO_WINDOW_GUIDANCE.contains("Run `launch` once"));
    assert!(NO_WINDOW_GUIDANCE.contains("without bringing it to the front"));
    // Never a cycle back to `launch` after a launch already returned no window.
    assert!(NO_WINDOW_GUIDANCE.contains(
        "If that returns no window, or a `launch` of this app already returned none, do not run \
         it again: tell the user."
    ));
    assert_eq!(
        reason.details,
        serde_json::json!({ "kind": NO_WINDOW_KIND, "pid": 42 })
    );
}

#[test]
fn only_the_single_process_of_a_regular_app_read_to_show_no_window_is_explained() {
    let none = |_| Some(false);
    assert_eq!(single_windowless_regular(&[(7, true)], none), Some(7));
    assert_eq!(
        single_windowless_regular(&[(7, true)], |_| Some(true)),
        None
    );
    assert_eq!(single_windowless_regular(&[(7, true)], |_| None), None);
    assert_eq!(single_windowless_regular(&[(7, false)], none), None);
    assert_eq!(single_windowless_regular(&[], none), None);
    assert_eq!(
        single_windowless_regular(&[(7, true), (8, true)], none),
        None
    );
}
