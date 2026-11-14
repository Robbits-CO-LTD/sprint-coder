// Added by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! The check whether a window is read by its visible elements
//! (`reads_visible_elements`) answers within the time it is given, also
//! against a window whose thread answers the pump probe and then stops
//! answering for a while (the case the client's own 2 s bound let through).

use super::reads_visible_elements;
use crate::tree::fixture::bootstrap;
use crate::tree::fixture::fixture_hung_after_probe::HungAfterProbeFixture;
use agent_desktop_core::{Deadline, ProcessId, SnapshotSurface, WindowInfo};
use std::time::{Duration, Instant};

/// How long the fixture's thread stays busy after the probe it answers: past
/// the check's bound (core's 0.5 s) and short of the client's 2 s, so a check
/// bounded by the client alone waits it out.
const BUSY_MS: u32 = 1_600;

/// The check's bound, as core passes it (`VISIBLE_CHECK_CAP`).
const CHECK_MS: u64 = 500;

fn window_of(fixture: &HungAfterProbeFixture) -> WindowInfo {
    WindowInfo {
        id: format!("w-{}", fixture.handle()),
        title: String::new(),
        app: String::new(),
        pid: ProcessId::new(std::process::id()),
        process_instance: None,
        bounds: None,
        state: Default::default(),
    }
}

/// A window of a class that is neither Chromium's nor WPF's is answered "not
/// read that way" from its handle: nothing is sent to it (the fixture never
/// enters its busy spell), and the answer is immediate.
#[test]
fn a_window_of_another_class_is_answered_without_asking_it() {
    bootstrap();
    let fixture = HungAfterProbeFixture::create().expect("the fixture window is created");
    fixture.resume_after(BUSY_MS);
    fixture.hang_after_probe(1).expect("the fixture is armed");

    let started = Instant::now();
    let answer = reads_visible_elements(
        &window_of(&fixture),
        SnapshotSurface::Window,
        Deadline::after(CHECK_MS).expect("a deadline"),
    );

    assert_eq!(answer, None);
    assert!(!fixture.did_hang(), "the window was sent a message");
    assert!(
        started.elapsed() < Duration::from_millis(200),
        "took {:?}",
        started.elapsed()
    );
}

/// A WPF window by its class has its root resolved, and that resolution is
/// bounded by the check's time: against a thread that answers the probe and
/// then stays busy past it, the check gives up within its bound ("not read
/// that way", which keeps the capture's split as before) instead of waiting
/// for the client's 2 s.
#[test]
fn a_wpf_window_that_is_slow_to_answer_is_given_up_within_the_check() {
    bootstrap();
    let class = format!(
        "HwndWrapper[{};;]",
        crate::tree::fixture::fixture_window::unique_class_name()
    );
    let fixture =
        HungAfterProbeFixture::create_with_class(class).expect("the fixture window is created");
    fixture.resume_after(BUSY_MS);
    fixture.hang_after_probe(1).expect("the fixture is armed");

    let started = Instant::now();
    let answer = reads_visible_elements(
        &window_of(&fixture),
        SnapshotSurface::Window,
        Deadline::after(CHECK_MS).expect("a deadline"),
    );
    let took = started.elapsed();

    assert_eq!(answer, None);
    assert!(fixture.did_hang(), "the root was asked for");
    assert!(
        took < Duration::from_millis(CHECK_MS + 400),
        "the check outlived its bound: {took:?}"
    );
}

/// The bound is the check's own: the unbounded resolution against the same
/// window waits for the busy spell (this is what the check did before).
#[test]
fn the_unbounded_root_resolution_waits_out_the_same_window() {
    bootstrap();
    let fixture = HungAfterProbeFixture::create().expect("the fixture window is created");
    fixture.resume_after(BUSY_MS);
    fixture.hang_after_probe(1).expect("the fixture is armed");

    let started = Instant::now();
    let _ = crate::tree::automation::root_from_hwnd(
        fixture.handle(),
        Deadline::after(CHECK_MS).expect("a deadline"),
    );
    let took = started.elapsed();

    assert!(fixture.did_hang());
    assert!(
        took >= Duration::from_millis(u64::from(BUSY_MS) - 300),
        "the unbounded call returned early: {took:?}"
    );
}
