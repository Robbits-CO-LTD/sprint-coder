// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::{OwnerClimb, minimized_window_error, owning_shown_root, owning_window_minimized};
use crate::tree::automation::root_from_hwnd;
use crate::tree::fixture::{LocalFixture, bootstrap};
use agent_desktop_core::{Deadline, DeliverySemantics, ErrorCode};
use std::time::Duration;

fn deadline() -> Deadline {
    Deadline::standard().expect("a standard deadline")
}

fn root_of(fixture: &LocalFixture) -> crate::tree::element::UIAElement {
    root_from_hwnd(fixture.handle(), deadline()).expect("the fixture root resolves")
}

#[test]
fn a_restored_window_reports_not_minimized() {
    bootstrap();
    let fixture = LocalFixture::create().expect("the fixture window is created");

    assert_eq!(
        owning_window_minimized(&root_of(&fixture), deadline()),
        Some(false)
    );
}

#[test]
fn a_minimized_window_reports_minimized() {
    bootstrap();
    let fixture = LocalFixture::create().expect("the fixture window is created");
    fixture.minimize();
    std::thread::sleep(Duration::from_millis(250));

    assert_eq!(
        owning_window_minimized(&root_of(&fixture), deadline()),
        Some(true)
    );
}

/// The ancestry a minimized Electron window showed on 2026-11-12, from a web
/// button up: button and document own no window, the content pane owns
/// `Chrome_RenderWidgetHostHWND` (parked under Chromium's hidden window while
/// minimized), unnamed panes own none, and the top-level owns the minimized
/// window itself.
const CONTENT_HWND: isize = 0x3307_34;
const HIDDEN_PARKING_ROOT: isize = 0x1AD_0F32;
const TOP_LEVEL: isize = 0x99C_0A88;

fn electron_ancestry() -> Vec<isize> {
    vec![0, 0, CONTENT_HWND, 0, 0, TOP_LEVEL]
}

fn climb_over(ancestry: &[isize], shown_root: &dyn Fn(isize) -> Option<isize>) -> Option<isize> {
    owning_shown_root(
        0usize,
        &OwnerClimb {
            native_hwnd: &|index: &usize| Ok(ancestry[*index]),
            parent_of: &|index: &usize| Ok((*index + 1 < ancestry.len()).then_some(*index + 1)),
            shown_root,
            deadline: deadline(),
        },
    )
}

/// `GA_ROOT` of the parked content window is the hidden window, which is not
/// shown; only the top-level is.
fn electron_roots(hwnd: isize) -> Option<isize> {
    match hwnd {
        CONTENT_HWND => None,
        TOP_LEVEL => Some(TOP_LEVEL),
        _ => Some(hwnd),
    }
}

#[test]
fn a_parked_chromium_content_window_does_not_stand_in_for_the_top_level() {
    assert_eq!(
        climb_over(&electron_ancestry(), &electron_roots),
        Some(TOP_LEVEL),
        "the climb must skip the hidden parking root and reach the minimized top-level"
    );
}

#[test]
fn a_shown_first_root_is_answered_without_climbing_further() {
    let roots = |hwnd: isize| match hwnd {
        CONTENT_HWND => Some(TOP_LEVEL),
        _ => panic!("the climb went past the first shown root"),
    };
    assert_eq!(
        climb_over(&[0, 0, CONTENT_HWND, 0, 0, HIDDEN_PARKING_ROOT], &roots),
        Some(TOP_LEVEL)
    );
}

#[test]
fn a_climb_that_finds_no_shown_root_answers_unknown() {
    assert_eq!(climb_over(&[0, CONTENT_HWND, 0], &|_| None), None);
}

#[test]
fn a_failed_read_answers_unknown_rather_than_a_window() {
    let answer = owning_shown_root(
        0usize,
        &OwnerClimb {
            native_hwnd: &|_: &usize| Err(()),
            parent_of: &|_: &usize| Ok(Some(1)),
            shown_root: &|hwnd| Some(hwnd),
            deadline: deadline(),
        },
    );
    assert_eq!(answer, None);
}

#[test]
fn the_minimized_refusal_names_the_window_and_was_not_delivered() {
    let error = minimized_window_error(TOP_LEVEL);
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert!(!error.permits_retry_by_default());
    let details = error.details.as_ref().expect("details");
    assert_eq!(details["kind"], "window_minimized");
    assert_eq!(details["window_id"], format!("w-{TOP_LEVEL}"));
    let suggestion = error.suggestion.as_deref().expect("suggestion");
    assert!(suggestion.contains(&format!("restore --window-id w-{TOP_LEVEL}")));
    assert!(suggestion.contains("fresh snapshot"));
}
