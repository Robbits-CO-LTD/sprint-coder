// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
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

/// The same app's menu or panel (a higher level) is not passed: the overlay
/// keeps the named window's level, so when the user brings their own window to
/// the front it is never left above it. It may be hidden under that menu.
#[test]
fn a_higher_level_window_of_the_same_app_is_not_passed_and_the_level_is_kept() {
    let windows = [
        window(1, USER, 0, [0.0, 0.0, 50.0, 50.0]),
        window(3, WORKED, 101, [150.0, 150.0, 200.0, 300.0]),
        window(4, WORKED, 3, [120.0, 120.0, 100.0, 100.0]),
        window(7, WORKED, 0, ANCHOR),
    ];
    let placement = resolve(&windows, true, 7);
    assert_eq!(placement, above(7, 0));
    // A higher-level window of the same app that covers nothing is passed over
    // by the walk, but still never sets the level.
    let windows = [
        window(3, WORKED, 101, [2000.0, 2000.0, 10.0, 10.0]),
        window(5, WORKED, 0, [200.0, 200.0, 300.0, 200.0]),
        window(7, WORKED, 0, ANCHOR),
    ];
    assert_eq!(resolve(&windows, true, 7), above(5, 0));
}

/// The named window's sheets and popovers (same process, same level, inside its
/// frame) are passed, and the overlay goes above them. So is another document
/// window of the same app that happens to lie inside it.
#[test]
fn a_same_level_window_of_the_same_app_inside_the_frame_is_passed() {
    let sheet = window(5, WORKED, 0, [300.0, 100.0, 400.0, 300.0]);
    let windows = [sheet, window(7, WORKED, 0, ANCHOR)];
    assert_eq!(resolve(&windows, true, 7), above(5, 0));
    // Up to a point outside the frame still counts as inside.
    let edge = window(5, WORKED, 0, [99.5, 99.5, 801.0, 601.0]);
    assert_eq!(
        resolve(&[edge, window(7, WORKED, 0, ANCHOR)], true, 7),
        above(5, 0)
    );
    // Outside the frame it is another window over the named one.
    let outside = window(5, WORKED, 0, [50.0, 50.0, 400.0, 300.0]);
    assert_eq!(
        resolve(&[outside, window(7, WORKED, 0, ANCHOR)], true, 7),
        above(7, 0)
    );
    // Another app's window inside the frame is not family.
    let foreign = window(5, USER, 0, [300.0, 100.0, 400.0, 300.0]);
    assert_eq!(
        resolve(&[foreign, window(7, WORKED, 0, ANCHOR)], true, 7),
        above(7, 0)
    );
}

/// The walk stops at the first other window over what it passed, skipping the
/// renderers' own windows, transparent windows and windows that cover nothing.
#[test]
fn the_walk_skips_overlays_transparent_and_distant_windows_and_stops_at_a_cover() {
    let transparent = ListedWindow {
        alpha: 0.0,
        ..window(2, USER, 0, ANCHOR)
    };
    let windows = [
        window(5, WORKED, 0, [300.0, 100.0, 400.0, 300.0]),
        window(1, USER, 0, [0.0, 0.0, 200.0, 200.0]),
        mine(20),
        other_agent(30),
        transparent,
        window(9, USER, 0, [3000.0, 3000.0, 100.0, 100.0]),
        window(7, WORKED, 0, ANCHOR),
    ];
    // The sheet is in front of the user's window that covers the named one, so
    // the walk stops before reaching it.
    assert_eq!(resolve(&windows, true, 7), above(7, 0));
}

/// A window whose owner or frame could not be read is skipped, as before.
#[test]
fn an_unread_entry_in_front_is_skipped() {
    let unread = ListedWindow {
        flags: HAS_LAYER,
        ..window(1, USER, 0, ANCHOR)
    };
    let windows = [
        unread,
        window(5, WORKED, 0, [300.0, 100.0, 400.0, 300.0]),
        window(7, WORKED, 0, ANCHOR),
    ];
    assert_eq!(resolve(&windows, true, 7), above(5, 0));
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
    // Both resolve to the same target, since the walk skips renderer windows.
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
    unsafe {
        agent_desktop_cursor_overlay_resolve(windows.as_ptr(), windows.len(), true, 7, &mut output)
    };
    assert_eq!(output, above(5, 0));
    unsafe { agent_desktop_cursor_overlay_resolve(std::ptr::null(), 0, true, 7, &mut output) };
    assert_eq!(output.kind, GONE);
    let stacked = [mine(20), window(7, WORKED, 0, ANCHOR)];
    let shown = [20_u32];
    assert!(unsafe {
        agent_desktop_cursor_overlay_settled(stacked.as_ptr(), 2, 7, shown.as_ptr(), 1)
    });
    assert!(!unsafe {
        agent_desktop_cursor_overlay_settled(stacked.as_ptr(), 2, 7, std::ptr::null(), 0)
    });
}
