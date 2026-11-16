// Changed by Sprint Coder (new file); see VENDORED.md in apps/desktop/desktop-control.
use super::*;

const READ: u8 = HAS_PID | HAS_LAYER | HAS_BOUNDS;
const USER: i32 = 100;
const WORKED: i32 = 200;
const MINE: i32 = 300;
const OTHER_AGENT: i32 = 301;

fn window(number: u32, pid: i32, layer: i64, bounds: [f64; 4]) -> ListedWindow {
    ListedWindow {
        number,
        pid,
        layer,
        bounds,
        alpha: 1.0,
        flags: READ,
    }
}

fn mine(number: u32) -> ListedWindow {
    ListedWindow {
        flags: READ | OVERLAY | OWN,
        ..window(number, MINE, 0, [0.0, 0.0, 240.0, 240.0])
    }
}

fn other_agent(number: u32) -> ListedWindow {
    ListedWindow {
        flags: READ | OVERLAY,
        ..window(number, OTHER_AGENT, 0, [0.0, 0.0, 240.0, 240.0])
    }
}

const ANCHOR: [f64; 4] = [100.0, 100.0, 800.0, 600.0];

fn above(target: u32, level: i64) -> Placement {
    Placement {
        kind: ABOVE,
        target,
        level,
    }
}

/// With no window named, the overlay goes above every window, as before.
#[test]
fn no_named_window_is_free() {
    let windows = [window(7, WORKED, 0, ANCHOR)];
    assert_eq!(resolve(&windows, false, 7).kind, FREE);
    assert_eq!(resolve(&[], false, 0).kind, FREE);
}

/// A named window that is not on the screen now (closed, minimized, on another
/// Space), or one whose number could not be read, hides the overlay: it never
/// goes to the front of the user's windows instead.
#[test]
fn a_named_window_not_on_the_screen_or_unreadable_hides_the_overlay() {
    let windows = [window(1, USER, 0, ANCHOR), window(7, WORKED, 0, ANCHOR)];
    assert_eq!(resolve(&windows, true, 9).kind, GONE, "not in the list");
    assert_eq!(resolve(&windows, true, 0).kind, GONE, "number 0");
    assert_eq!(resolve(&[], true, 7).kind, GONE, "the list is empty");
    let unread = ListedWindow {
        flags: HAS_PID | HAS_BOUNDS,
        ..window(7, WORKED, 0, ANCHOR)
    };
    assert_eq!(resolve(&[unread], true, 7).kind, GONE, "no layer");
}

/// The overlay goes directly above the named window, at its level, under the
/// user's window that covers it.
#[test]
fn the_overlay_sits_directly_above_the_named_window_under_the_users() {
    let windows = [
        window(1, USER, 0, [0.0, 0.0, 500.0, 500.0]),
        window(7, WORKED, 0, ANCHOR),
    ];
    assert_eq!(resolve(&windows, true, 7), above(7, 0));
}

/// Another window of the same app (same process, same level, inside the named
/// window's frame) in front of it is one the user may be using: the overlay
/// stays directly above the named window, under it, and never above it.
#[test]
fn a_same_level_window_of_the_same_app_inside_the_frame_stays_above_the_overlay() {
    let users_window = window(5, WORKED, 0, [300.0, 100.0, 400.0, 300.0]);
    let windows = [users_window, window(7, WORKED, 0, ANCHOR)];
    let placement = resolve(&windows, true, 7);
    assert_eq!(placement, above(7, 0));
    assert_ne!(placement.target, 5);
    // The same with nothing else on the screen and the window filling the frame.
    let filling = window(5, WORKED, 0, ANCHOR);
    assert_eq!(
        resolve(&[filling, window(7, WORKED, 0, ANCHOR)], true, 7),
        above(7, 0)
    );
}

/// The same app's menu or panel (a higher level) in front does not change the
/// answer: the target is the named window and the level is its level, so the
/// overlay may be hidden under the menu but is never left above a window the
/// user brings to the front.
#[test]
fn a_higher_level_window_of_the_same_app_keeps_the_named_window_and_its_level() {
    let windows = [
        window(1, USER, 0, [0.0, 0.0, 50.0, 50.0]),
        window(3, WORKED, 101, [150.0, 150.0, 200.0, 300.0]),
        window(4, WORKED, 3, [120.0, 120.0, 100.0, 100.0]),
        window(7, WORKED, 0, ANCHOR),
    ];
    assert_eq!(resolve(&windows, true, 7), above(7, 0));
    // The named window's own level is kept, whatever it is.
    let windows = [
        window(3, WORKED, 101, [150.0, 150.0, 200.0, 300.0]),
        window(7, WORKED, 8, ANCHOR),
    ];
    assert_eq!(resolve(&windows, true, 7), above(7, 8));
}

/// Unread records, the renderers' own windows and transparent windows in front
/// do not change the answer either.
#[test]
fn unread_overlay_and_transparent_windows_in_front_do_not_change_the_answer() {
    let unread = ListedWindow {
        flags: HAS_LAYER,
        ..window(1, USER, 0, ANCHOR)
    };
    let unnumbered = window(0, WORKED, 0, [300.0, 100.0, 400.0, 300.0]);
    let transparent = ListedWindow {
        alpha: 0.0,
        ..window(2, WORKED, 0, [300.0, 100.0, 400.0, 300.0])
    };
    let windows = [
        unread,
        unnumbered,
        mine(20),
        other_agent(30),
        transparent,
        window(9, USER, 0, [3000.0, 3000.0, 100.0, 100.0]),
        window(7, WORKED, 0, ANCHOR),
    ];
    assert_eq!(resolve(&windows, true, 7), above(7, 0));
}

/// A named window whose owner, level or frame could not be read hides the
/// overlay, wherever it is in the list.
#[test]
fn a_named_window_that_cannot_be_read_hides_the_overlay() {
    for flags in [
        HAS_LAYER | HAS_BOUNDS,
        HAS_PID | HAS_BOUNDS,
        HAS_PID | HAS_LAYER,
        0,
    ] {
        let unread = ListedWindow {
            flags,
            ..window(7, WORKED, 0, ANCHOR)
        };
        let windows = [window(1, USER, 0, [0.0, 0.0, 50.0, 50.0]), unread];
        assert_eq!(resolve(&windows, true, 7), Placement::GONE, "flags {flags}");
    }
}

/// In place: this renderer's windows directly in front of the target, in the
/// order they are meant to be stacked (the list runs front to back).
#[test]
fn settled_when_my_windows_are_directly_above_the_target_in_order() {
    let windows = [
        window(1, USER, 0, ANCHOR),
        mine(22),
        mine(21),
        mine(20),
        window(7, WORKED, 0, ANCHOR),
    ];
    assert!(settled(&windows, 7, &[20, 21, 22]));
    // The cursor (22) under an effect (20) is not in place.
    assert!(!settled(&windows, 7, &[22, 21, 20]));
    // A shown window missing from the run is not in place.
    assert!(!settled(&windows, 7, &[20, 21, 22, 23]));
    assert!(!settled(&windows, 7, &[]));
    assert!(!settled(&windows, 9, &[20, 21, 22]));
}

/// A window of another process between the target and mine is not in place.
#[test]
fn not_settled_when_another_window_is_between_or_mine_is_elsewhere() {
    let windows = [
        mine(21),
        window(1, USER, 0, ANCHOR),
        mine(20),
        window(7, WORKED, 0, ANCHOR),
    ];
    assert!(!settled(&windows, 7, &[20, 21]));
    let windows = [
        mine(20),
        window(1, USER, 0, ANCHOR),
        window(7, WORKED, 0, ANCHOR),
    ];
    assert!(!settled(&windows, 7, &[20]));
}

/// Two renderers that name the same window: whichever placed itself last sits
/// directly above the target, the other above it, and each counts itself in
/// place while passing over the other's windows, in any interleaving.
#[test]
fn two_renderers_naming_the_same_window_both_count_as_settled() {
    let mine_over_other = [
        mine(22),
        mine(20),
        other_agent(32),
        other_agent(30),
        window(7, WORKED, 0, ANCHOR),
    ];
    assert!(settled(&mine_over_other, 7, &[20, 22]));
    let other_over_mine = [
        other_agent(32),
        other_agent(30),
        mine(22),
        mine(20),
        window(7, WORKED, 0, ANCHOR),
    ];
    assert!(settled(&other_over_mine, 7, &[20, 22]));
    let interleaved = [
        other_agent(32),
        mine(22),
        other_agent(30),
        mine(20),
        window(7, WORKED, 0, ANCHOR),
    ];
    assert!(settled(&interleaved, 7, &[20, 22]));
    // Both resolve to the same target: the named window.
    assert_eq!(resolve(&interleaved, true, 7), above(7, 0));
}

/// The entry points read the records the Objective-C side writes.
#[test]
fn the_entry_points_read_the_records() {
    let windows = [
        window(5, WORKED, 0, [300.0, 100.0, 400.0, 300.0]),
        window(7, WORKED, 0, ANCHOR),
    ];
    let mut output = Placement::GONE;
    unsafe { sc_cursor_overlay_resolve(windows.as_ptr(), windows.len(), true, 7, &mut output) };
    assert_eq!(output, above(7, 0));
    unsafe { sc_cursor_overlay_resolve(std::ptr::null(), 0, true, 7, &mut output) };
    assert_eq!(output.kind, GONE);
    let stacked = [mine(20), window(7, WORKED, 0, ANCHOR)];
    let shown = [20_u32];
    assert!(unsafe { sc_cursor_overlay_settled(stacked.as_ptr(), 2, 7, shown.as_ptr(), 1) });
    assert!(!unsafe { sc_cursor_overlay_settled(stacked.as_ptr(), 2, 7, std::ptr::null(), 0) });
}
