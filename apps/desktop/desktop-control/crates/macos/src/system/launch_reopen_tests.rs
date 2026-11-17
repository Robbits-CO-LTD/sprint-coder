// Changed by Sprint Coder (new file); see VENDORED.md in apps/desktop/desktop-control.
use super::*;
use crate::system::launch::{HandoffCandidate, WindowSeen};
use crate::system::launch_front::{
    FrontOutcome, LeftWhy, OrderedWindow, TakeKind, Target, annotate_for, front_note, just_behind,
};
use crate::system::window::other_space::{ASKED_NO_WINDOW, ASKED_NOT_WAITED, LAUNCH_GUIDANCE};
use agent_desktop_core::{
    ErrorCode, ProcessId, commands::launch::CHROMIUM_CDP_HINT, system::launch_result::LaunchResult,
};
use std::cell::Cell;

fn attach() -> LaunchOptions {
    LaunchOptions::default()
}

fn allowed(
    options: &LaunchOptions,
    regular: bool,
    hidden: Option<bool>,
    minimized: Minimized,
) -> Result<(), NotSent> {
    may_reopen(options, false, regular, || hidden, || minimized)
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
fn only_a_plain_attach_of_a_shown_regular_app_without_a_minimized_window_is_asked() {
    let none = Minimized::None;
    assert_eq!(allowed(&attach(), true, Some(false), none), Ok(()));
    assert_eq!(
        allowed(&attach(), true, Some(false), Minimized::Some),
        Err(NotSent::Minimized)
    );
    assert_eq!(
        allowed(&attach(), true, Some(false), Minimized::Unknown),
        Err(NotSent::Unknown)
    );
    // A hidden app, and one whose `AXHidden` cannot be read, are never asked.
    assert_eq!(
        allowed(&attach(), true, Some(true), none),
        Err(NotSent::Hidden)
    );
    assert_eq!(allowed(&attach(), true, None, none), Err(NotSent::Unknown));
    assert_eq!(
        allowed(&attach(), false, Some(false), none),
        Err(NotSent::NotAsked)
    );
    assert_eq!(
        may_reopen(&attach(), true, true, || Some(false), || none),
        Err(NotSent::NotAsked)
    );
    let activate = LaunchOptions {
        activate: true,
        ..attach()
    };
    let no_attach = LaunchOptions {
        attach_if_running: false,
        ..attach()
    };
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
            allowed(&options, true, Some(false), none),
            Err(NotSent::NotAsked),
            "{options:?}"
        );
    }
}

#[test]
fn hidden_and_minimized_are_read_only_when_everything_before_them_allows_the_request() {
    let hidden_reads = Cell::new(0);
    let minimized_reads = Cell::new(0);
    let hidden = |answer: Option<bool>| {
        let reads = &hidden_reads;
        move || {
            reads.set(reads.get() + 1);
            answer
        }
    };
    let minimized = || {
        minimized_reads.set(minimized_reads.get() + 1);
        Minimized::None
    };
    let activate = LaunchOptions {
        activate: true,
        ..attach()
    };
    let _ = may_reopen(&activate, false, true, hidden(Some(false)), minimized);
    let _ = may_reopen(&attach(), false, false, hidden(Some(false)), minimized);
    let _ = may_reopen(&attach(), true, true, hidden(Some(false)), minimized);
    assert_eq!((hidden_reads.get(), minimized_reads.get()), (0, 0));
    let _ = may_reopen(&attach(), false, true, hidden(Some(true)), minimized);
    let _ = may_reopen(&attach(), false, true, hidden(None), minimized);
    assert_eq!((hidden_reads.get(), minimized_reads.get()), (2, 0));
    let _ = may_reopen(&attach(), false, true, hidden(Some(false)), minimized);
    assert_eq!((hidden_reads.get(), minimized_reads.get()), (3, 1));
}

#[test]
fn the_request_never_activates_never_starts_a_new_instance_and_drops_what_the_caller_added() {
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
fn the_open_ends_as_the_request_a_fresh_start_or_an_error_naming_the_new_instance() {
    let expected = (7, "macos-proc-v1:7:1");
    let same = (7, "macos-proc-v1:7:1".to_owned());
    let other = (9, "macos-proc-v1:9:1".to_owned());
    let asked = Cell::new(0);
    let runs = |answer: Option<bool>| {
        let asked = &asked;
        move || {
            asked.set(asked.get() + 1);
            answer
        }
    };
    assert_eq!(
        opened(expected, &same, runs(Some(true))).unwrap(),
        Opened::Same
    );
    assert_eq!(asked.get(), 0);
    // The app quit just before: the open started it anew.
    assert_eq!(
        opened(expected, &other, runs(Some(false))).unwrap(),
        Opened::Fresh
    );
    // The same pid with another instance token is another process too.
    let reused = (7, "macos-proc-v1:7:2".to_owned());
    assert_eq!(
        opened(expected, &reused, runs(Some(false))).unwrap(),
        Opened::Fresh
    );
    // The running instance may still run (or cannot be read): an error that says so.
    for answer in [Some(true), None] {
        let error = opened(expected, &other, runs(answer)).unwrap_err();
        assert_eq!(error.code, ErrorCode::AppUnresponsive);
        assert!(
            error
                .message
                .contains("started a new instance of it (pid 9)")
        );
        assert!(error.message.contains("is still running"));
        assert_eq!(
            error.details.as_ref().unwrap()["kind"],
            "reopen_started_new_instance"
        );
        assert!(
            error
                .suggestion
                .as_deref()
                .unwrap()
                .starts_with("Do not repeat the launch.")
        );
    }
}

#[test]
fn the_front_watch_counts_a_window_shown_again_in_answer_as_the_apps_new_window() {
    let seen = |number, shown| WindowSeen { number, shown };
    // Window 42 was kept off screen; 43 was shown.
    let before = shown_numbers(Some(vec![seen(42, false), seen(43, true)]));
    assert_eq!(before, Some(vec![43]));
    assert_eq!(shown_numbers(None), None);
    let reopen = [HandoffCandidate {
        pid: 7,
        process_instance: "macos-proc-v1:7:1".into(),
        windows_before: before.unwrap(),
    }];
    let hand_off = [HandoffCandidate {
        windows_before: vec![42, 43],
        ..reopen[0].clone()
    }];
    // The app shows 42 again in front of what the user used (Sprint Coder, pid 1): only with
    // the request's baseline is 42 the taker's, so what was in front is right behind it.
    let order = [
        OrderedWindow { pid: 7, number: 42 },
        OrderedWindow { pid: 1, number: 5 },
    ];
    let target = Target::App(crate::system::launch_front::FrontApp {
        pid: 1,
        instance: Some("macos-proc-v1:1:1".into()),
    });
    assert!(just_behind(&target, &order, &reopen));
    assert!(!just_behind(&target, &order, &hand_off));
}

fn reopened() -> LaunchResult {
    LaunchResult {
        app: "TextEdit".into(),
        pid: ProcessId::new(7),
        process_instance: Some("macos-proc-v1:7:1".into()),
        window: None,
        cdp: None,
        renderer: None,
        suggestion: Some(REOPENED_WINDOW.into()),
        attached: true,
        new_instance: false,
        handed_off: false,
        running_without_window: false,
        existing_window: false,
        activated: None,
    }
}

#[test]
fn a_request_result_says_what_happened_to_the_front_in_the_hand_off_words() {
    let restored = FrontOutcome::Restored(TakeKind::App);
    let left = FrontOutcome::Left(TakeKind::App, LeftWhy::Input);
    for outcome in [restored, left] {
        let result = annotate_for(Ok(reopened()), Some(outcome), true).unwrap();
        assert_eq!(
            result.suggestion.as_deref(),
            Some(format!("{REOPENED_WINDOW} {}", front_note(outcome)).as_str())
        );
        assert!(!result.handed_off && result.attached);
    }
    // No take, or a launch that did not ask: as it was.
    let result = annotate_for(Ok(reopened()), None, true).unwrap();
    assert_eq!(result.suggestion.as_deref(), Some(REOPENED_WINDOW));
    let result = annotate_for(Ok(reopened()), Some(restored), false).unwrap();
    assert_eq!(result.suggestion.as_deref(), Some(REOPENED_WINDOW));
}

#[test]
fn each_outcome_picks_its_text_other_space_first_and_keeps_the_chromium_hint() {
    let sent = Reopen::Sent { waited: true };
    let not_waited = Reopen::Sent { waited: false };
    let no_space = || None;
    let pick = |reopen, has_window| suggestion(reopen, has_window, no_space, false);
    assert_eq!(pick(sent, true).as_deref(), Some(REOPENED_WINDOW));
    assert_eq!(pick(not_waited, true).as_deref(), Some(REOPENED_WINDOW));
    assert_eq!(pick(sent, false).as_deref(), Some(REOPENED_NO_WINDOW));
    assert_eq!(
        pick(not_waited, false).as_deref(),
        Some(REOPENED_NOT_WAITED)
    );
    let not_sent = |why| Reopen::NotSent(why);
    assert_eq!(
        pick(not_sent(NotSent::Minimized), false).as_deref(),
        Some(MINIMIZED_NOT_REOPENED)
    );
    assert_eq!(
        pick(not_sent(NotSent::Hidden), false).as_deref(),
        Some(HIDDEN_NOT_REOPENED)
    );
    assert_eq!(
        pick(not_sent(NotSent::Unknown), false).as_deref(),
        Some(NOT_REOPENED)
    );
    // An app without a Dock icon gets nothing, as before.
    assert_eq!(pick(not_sent(NotSent::NotAsked), false), None);

    // Other Space: read only without a window; asked first when the request was sent.
    let space = || Some(vec![7]);
    let other = suggestion(sent, false, space, false).unwrap();
    assert!(other.starts_with(&format!(
        "{ASKED_NO_WINDOW} The app is running, but its window (w-7)"
    )));
    assert!(other.ends_with(LAUNCH_GUIDANCE));
    assert!(!other.contains("run it once"));
    let zero = suggestion(not_waited, false, space, false).unwrap();
    assert!(zero.starts_with(ASKED_NOT_WAITED));
    let hidden = suggestion(not_sent(NotSent::Minimized), false, space, false).unwrap();
    assert!(hidden.starts_with("The app is running, but its window (w-7)"));
    let read = Cell::new(false);
    let _ = suggestion(
        sent,
        true,
        || {
            read.set(true);
            Some(vec![7])
        },
        false,
    );
    assert!(!read.get());
    // No other-Space window: the text for what was done.
    assert_eq!(
        suggestion(sent, false, || Some(Vec::new()), false).as_deref(),
        Some(REOPENED_NO_WINDOW)
    );

    // Chromium: core's hint is appended, and left to core when there is no text.
    assert_eq!(
        suggestion(sent, true, no_space, true),
        Some(format!("{REOPENED_WINDOW} {CHROMIUM_CDP_HINT}"))
    );
    assert_eq!(
        suggestion(not_sent(NotSent::NotAsked), false, no_space, true),
        None
    );
}

#[test]
fn the_texts_say_what_is_known_and_never_to_wait_or_loop() {
    assert!(REOPENED_WINDOW.contains("without bringing it to the front"));
    assert!(
        REOPENED_WINDOW
            .contains("showed no window before this launch and showed `window` in answer")
    );
    assert!(
        REOPENED_WINDOW
            .contains("treat what is in it as the user's and do only what the user asked")
    );
    assert!(!REOPENED_WINDOW.contains("not a window the user was using"));
    assert!(REOPENED_WINDOW.contains("Do not repeat the launch"));

    assert!(REOPENED_NO_WINDOW.contains("asked it to open a window"));
    assert!(REOPENED_NO_WINDOW.contains("no window appeared"));
    assert!(REOPENED_NO_WINDOW.contains("do not retry it in a loop"));
    assert!(REOPENED_NO_WINDOW.contains("With the user's agreement, `launch` with `--activate`"));
    assert!(REOPENED_NOT_WAITED.contains("did not wait"));
    assert!(MINIMIZED_NOT_REOPENED.contains("Do not restore it on your own"));
    assert!(HIDDEN_NOT_REOPENED.contains("hidden (as with Cmd+H)"));
    assert!(HIDDEN_NOT_REOPENED.contains("Do not unhide it on your own"));
    assert!(HIDDEN_NOT_REOPENED.contains("with their agreement, `launch` with `--activate`"));
    assert!(NOT_REOPENED.contains("could not be read"));
    assert!(HIDDEN_GUIDANCE.contains("`launch` does not ask a hidden app for a window"));
    assert!(!HIDDEN_GUIDANCE.contains("Run `launch`"));

    for text in [
        REOPENED_WINDOW,
        REOPENED_NO_WINDOW,
        REOPENED_NOT_WAITED,
        MINIMIZED_NOT_REOPENED,
        HIDDEN_NOT_REOPENED,
        NOT_REOPENED,
        NO_WINDOW_GUIDANCE,
        HIDDEN_GUIDANCE,
    ] {
        assert!(!text.contains("Wait for the app"), "{text}");
        assert!(!text.contains("  "), "{text}");
    }
}

#[test]
fn a_running_app_with_no_window_is_told_to_launch_once_unless_hidden() {
    let reason = windowless_reason("TextEdit", 42, Some(false)).unwrap();
    assert_eq!(
        reason.message,
        "Application 'TextEdit' is running but shows no window."
    );
    assert_eq!(reason.suggestion, NO_WINDOW_GUIDANCE);
    assert!(NO_WINDOW_GUIDANCE.contains("Run `launch` once"));
    assert!(NO_WINDOW_GUIDANCE.contains(
        "If that returns no window, or a `launch` of this app already returned none, do not run \
         it again: tell the user."
    ));
    assert_eq!(
        reason.details,
        serde_json::json!({ "kind": NO_WINDOW_KIND, "pid": 42 })
    );

    let hidden = windowless_reason("TextEdit", 42, Some(true)).unwrap();
    assert_eq!(
        hidden.message,
        "Application 'TextEdit' is running but hidden (as with Cmd+H), and shows no window."
    );
    assert_eq!(hidden.suggestion, HIDDEN_GUIDANCE);
    assert_eq!(
        hidden.details,
        serde_json::json!({ "kind": HIDDEN_KIND, "pid": 42 })
    );

    // Hidden or not cannot be read: the generic answer stays.
    assert!(windowless_reason("TextEdit", 42, None).is_none());
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
