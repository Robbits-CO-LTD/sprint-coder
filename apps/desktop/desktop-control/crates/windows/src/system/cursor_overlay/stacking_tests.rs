use super::{Anchor, InsertAfter, Kind, Neighbour, Placement, insert_after, placement};

const ORDINARY: Anchor = Anchor::Live { topmost: false };

fn window(handle: isize, kind: Kind) -> Neighbour {
    Neighbour {
        handle,
        kind,
        topmost: false,
    }
}

fn topmost(handle: isize, kind: Kind) -> Neighbour {
    Neighbour {
        handle,
        kind,
        topmost: true,
    }
}

#[test]
fn a_cursor_with_no_window_named_stays_above_everything() {
    assert_eq!(
        placement(Anchor::Unnamed, [window(2, Kind::Other)], true),
        Placement::TopOfTopmost
    );
}

#[test]
fn a_covered_window_puts_its_cursor_under_the_window_that_covers_it() {
    // A, then the operator's window B over it, then the taskbar.
    let above = [window(20, Kind::Other), topmost(30, Kind::Other)];

    assert_eq!(placement(ORDINARY, above, true), Placement::Below(20));
    assert_eq!(placement(ORDINARY, above, false), Placement::Below(20));
}

#[test]
fn the_cursor_goes_above_the_popups_and_menus_the_window_owns() {
    // A, its owned popup, an invisible window, then B.
    let above = [
        window(11, Kind::Family),
        window(12, Kind::Passable),
        window(20, Kind::Other),
    ];

    assert_eq!(
        placement(ORDINARY, above, false),
        Placement::Below(12),
        "directly above the popup, which is the top of the family"
    );
}

#[test]
fn a_cursor_already_directly_above_its_window_is_left_where_it_is() {
    let above = [
        window(12, Kind::Passable),
        window(99, Kind::Own),
        window(20, Kind::Other),
    ];

    assert_eq!(placement(ORDINARY, above, false), Placement::Stay);
}

#[test]
fn a_cursor_in_the_topmost_band_comes_down_even_when_only_passable_windows_lie_between() {
    let above = [window(12, Kind::Passable), topmost(99, Kind::Own)];

    assert_eq!(
        placement(ORDINARY, above, true),
        Placement::TopOfOrdinary { under: None }
    );
}

#[test]
fn a_cursor_below_a_popup_its_window_opened_is_moved_above_it() {
    // The cursor sat directly above A, then A opened a popup above it.
    let above = [
        window(99, Kind::Own),
        window(11, Kind::Family),
        window(20, Kind::Other),
    ];

    assert_eq!(placement(ORDINARY, above, false), Placement::Below(20));
}

#[test]
fn the_highest_ordinary_window_puts_its_cursor_at_the_top_of_the_ordinary_band() {
    // A is in front: only the topmost band (the taskbar) is above it.
    assert_eq!(
        placement(ORDINARY, [topmost(30, Kind::Other)], true),
        Placement::TopOfOrdinary { under: Some(30) }
    );
    assert_eq!(
        placement(ORDINARY, [], true),
        Placement::TopOfOrdinary { under: None }
    );
}

#[test]
fn a_topmost_window_keeps_its_cursor_in_the_topmost_band_above_it() {
    assert_eq!(
        placement(
            Anchor::Live { topmost: true },
            [topmost(30, Kind::Other)],
            false
        ),
        Placement::TopOfTopmost
    );
    // An ordinary window with an always-on-top popup of its own.
    assert_eq!(
        placement(
            ORDINARY,
            [window(20, Kind::Passable), topmost(11, Kind::Family)],
            false
        ),
        Placement::TopOfTopmost
    );
}

#[test]
fn a_window_that_is_gone_takes_its_cursor_under_everything() {
    assert_eq!(placement(Anchor::Gone, [], true), Placement::Bottom);
}

#[test]
fn another_agents_cursor_on_the_same_window_is_passed_over_not_stopped_at() {
    // A, another agent's overlay directly above it, then B.
    let above = [window(50, Kind::Passable), window(20, Kind::Other)];

    assert_eq!(
        placement(ORDINARY, above, false),
        Placement::Below(50),
        "directly above A, under the other agent's cursor and well under B"
    );
}

/// "B, overlay, A", then the operator brings A to the front of the ordinary
/// band: only the taskbar is above A, and the overlay, already ordinary, is
/// under A. `HWND_NOTOPMOST` does nothing to an ordinary window, so the
/// overlay is put directly below the taskbar, which ends the ordinary band.
#[test]
fn a_window_brought_to_the_front_over_its_ordinary_cursor_takes_the_cursor_up_with_it() {
    let decided = placement(ORDINARY, [topmost(30, Kind::Other)], false);

    assert_eq!(decided, Placement::TopOfOrdinary { under: Some(30) });
    assert_eq!(insert_after(decided, false), Some(InsertAfter::Window(30)));
    assert_ne!(
        insert_after(decided, false),
        Some(InsertAfter::NoTopmost),
        "a no-op for an overlay that is already ordinary"
    );
}

#[test]
fn with_no_topmost_window_above_an_ordinary_cursor_falls_back_to_hwnd_top() {
    assert_eq!(
        insert_after(Placement::TopOfOrdinary { under: None }, false),
        Some(InsertAfter::Top)
    );
}

#[test]
fn a_topmost_cursor_is_brought_down_to_the_top_of_the_ordinary_band_with_hwnd_notopmost() {
    for under in [None, Some(30)] {
        assert_eq!(
            insert_after(Placement::TopOfOrdinary { under }, true),
            Some(InsertAfter::NoTopmost)
        );
    }
}

/// Every other placement is the same call from either band: each of these
/// moves the window whatever band it starts in.
#[test]
fn every_other_placement_is_one_call_that_moves_the_cursor_from_either_band() {
    for own_topmost in [false, true] {
        assert_eq!(insert_after(Placement::Stay, own_topmost), None);
        assert_eq!(
            insert_after(Placement::TopOfTopmost, own_topmost),
            Some(InsertAfter::Topmost)
        );
        assert_eq!(
            insert_after(Placement::Bottom, own_topmost),
            Some(InsertAfter::Bottom)
        );
        assert_eq!(
            insert_after(Placement::Below(20), own_topmost),
            Some(InsertAfter::Window(20))
        );
    }
}

/// Two agents' cursors on one window settle in one order rather than
/// trading places on every frame.
#[test]
fn two_cursors_on_the_front_window_settle_rather_than_trading_places() {
    // The first moved to the top of the ordinary band, directly above A.
    let second = placement(
        ORDINARY,
        [window(51, Kind::Passable), topmost(30, Kind::Other)],
        false,
    );
    assert_eq!(second, Placement::Below(51), "under the first, above A");
    // Now A, the second, the first: the first sees only passable windows
    // between A and itself, and stays.
    let first = placement(
        ORDINARY,
        [
            window(52, Kind::Passable),
            window(51, Kind::Own),
            topmost(30, Kind::Other),
        ],
        false,
    );
    assert_eq!(first, Placement::Stay);
}
