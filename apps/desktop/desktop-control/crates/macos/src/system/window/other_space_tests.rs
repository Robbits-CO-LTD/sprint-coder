// Changed by Sprint Coder (new file); see VENDORED.md in apps/desktop/desktop-control.
use super::{
    AppSignals, GUIDANCE, WindowSignals, app_reason, launch_suggestion, likely_on_other_space,
    other_space_windows, window_error,
};
use agent_desktop_core::ErrorCode;

fn off_space_window(number: i64) -> WindowSignals {
    WindowSignals {
        number,
        on_screen: false,
        width: 230.0,
        height: 408.0,
        in_accessibility: false,
        minimized: None,
    }
}

fn shown_app() -> AppSignals {
    AppSignals {
        regular: true,
        hidden: Some(false),
        accessibility_complete: true,
    }
}

#[test]
fn an_off_screen_window_accessibility_does_not_list_in_a_shown_app_is_probably_on_another_space() {
    assert!(likely_on_other_space(&off_space_window(7), &shown_app()));
}

#[test]
fn a_window_on_screen_is_not_on_another_space() {
    let window = WindowSignals {
        on_screen: true,
        ..off_space_window(7)
    };
    assert!(!likely_on_other_space(&window, &shown_app()));
}

#[test]
fn a_window_accessibility_lists_is_readable_and_not_on_another_space() {
    // A minimized window, or one of a hidden app, stays in the accessibility list.
    for minimized in [None, Some(true), Some(false)] {
        let window = WindowSignals {
            in_accessibility: true,
            minimized,
            ..off_space_window(7)
        };
        assert!(!likely_on_other_space(&window, &shown_app()));
    }
}

#[test]
fn a_minimized_window_is_not_on_another_space() {
    let window = WindowSignals {
        minimized: Some(true),
        ..off_space_window(7)
    };
    assert!(!likely_on_other_space(&window, &shown_app()));
}

#[test]
fn a_hidden_app_or_one_whose_hidden_state_is_unread_names_no_cause() {
    for hidden in [Some(true), None] {
        let app = AppSignals {
            hidden,
            ..shown_app()
        };
        assert!(!likely_on_other_space(&off_space_window(7), &app));
    }
}

#[test]
fn a_menu_bar_or_background_app_names_no_cause() {
    let app = AppSignals {
        regular: false,
        ..shown_app()
    };
    assert!(!likely_on_other_space(&off_space_window(7), &app));
}

#[test]
fn an_incomplete_accessibility_read_names_no_cause() {
    let app = AppSignals {
        accessibility_complete: false,
        ..shown_app()
    };
    assert!(!likely_on_other_space(&off_space_window(7), &app));
}

#[test]
fn small_helper_windows_are_not_taken_for_the_window_the_user_left() {
    for (width, height) in [(99.0, 400.0), (400.0, 99.0), (0.0, 0.0)] {
        let window = WindowSignals {
            width,
            height,
            ..off_space_window(7)
        };
        assert!(!likely_on_other_space(&window, &shown_app()));
    }
    let edge = WindowSignals {
        width: 100.0,
        height: 100.0,
        ..off_space_window(7)
    };
    assert!(likely_on_other_space(&edge, &shown_app()));
}

#[test]
fn only_the_windows_that_qualify_are_named() {
    let windows = [
        off_space_window(1),
        WindowSignals {
            on_screen: true,
            ..off_space_window(2)
        },
        WindowSignals {
            width: 20.0,
            ..off_space_window(3)
        },
        off_space_window(4),
    ];
    assert_eq!(other_space_windows(&windows, &shown_app()), vec![1, 4]);
    assert!(other_space_windows(&[], &shown_app()).is_empty());
}

#[test]
fn the_app_reason_says_what_was_read_and_what_to_do() {
    assert_eq!(app_reason("Calculator", 42, &[]), None);
    let reason = app_reason("Calculator", 42, &[7, 9]).expect("reason");
    assert!(reason.message.contains("'Calculator' is running"));
    assert!(reason.message.contains("exists off screen"));
    // The message states only what was read; both possible causes are in the guidance.
    assert!(!reason.message.contains("Space"));
    assert_eq!(reason.suggestion, GUIDANCE);
    assert_eq!(
        reason.details,
        serde_json::json!({
            "kind": "window_off_screen_not_exposed",
            "possible_causes": ["other_space", "closed_but_kept"],
            "pid": 42,
            "window_ids": ["w-7", "w-9"],
        })
    );
}

#[test]
fn the_guidance_names_both_causes_and_forbids_a_retry_loop() {
    assert!(GUIDANCE.contains("on another Space"));
    assert!(GUIDANCE.contains("no public way to tell them apart"));
    // Neither cause is called the more likely one: nothing that can be read says which it is.
    assert!(!GUIDANCE.contains("most often"));
    assert!(GUIDANCE.contains("closed or hidden the window but keeps it"));
    assert!(GUIDANCE.contains("Do not retry in a tight loop"));
    assert!(GUIDANCE.contains("do not conclude that the app is broken"));
    assert!(GUIDANCE.contains("Do not activate the app on your own"));
    assert!(GUIDANCE.contains("Tell the user"));
    assert!(GUIDANCE.contains("with their agreement"));
}

#[test]
fn the_launch_suggestion_names_the_windows_and_says_not_to_launch_again() {
    assert_eq!(launch_suggestion(&[]), None);
    let suggestion = launch_suggestion(&[7]).expect("suggestion");
    assert!(suggestion.contains("(w-7)"));
    assert!(suggestion.contains("Do not repeat the launch."));
    assert!(suggestion.ends_with(GUIDANCE));
}

#[test]
fn the_window_error_keeps_its_code_and_kind_and_is_not_retryable() {
    let error = window_error("w-7");
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert!(error.message.contains("it is off screen"));
    assert!(!error.message.contains("Space"));
    assert_eq!(error.suggestion.as_deref(), Some(GUIDANCE));
    assert_eq!(
        error.details,
        Some(serde_json::json!({
            "kind": "window_without_accessibility_element",
            "window_id": "w-7",
            "possible_causes": ["other_space", "closed_but_kept"],
        }))
    );
    assert!(!error.is_explicitly_retryable());
}
