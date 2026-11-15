use super::{Anchor, Kind, Neighbour, Placement, placement};

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

    assert_eq!(placement(ORDINARY, above, true), Placement::TopOfOrdinary);
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
        Placement::TopOfOrdinary
    );
    assert_eq!(placement(ORDINARY, [], true), Placement::TopOfOrdinary);
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
