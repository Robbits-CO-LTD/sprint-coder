use super::{
    ComboClass, ItemMatch, after_item_select, ambiguous_item_error, classify_class,
    classify_matches, holds_requested, is_drop_down_list, keeps_item_text, missing_item_error,
    position_still_names_item, search_start, selection_notifications,
};
use crate::actions::chain::DeliveryOutcome;
use agent_desktop_core::{DeliveryDisposition, ErrorCode};

#[test]
fn only_the_system_combo_box_classes_are_recognised() {
    assert_eq!(classify_class("ComboBox"), ComboClass::Box);
    assert_eq!(classify_class("combobox"), ComboClass::Box);
    assert_eq!(classify_class("ComboLBox"), ComboClass::DropList);
    assert_eq!(classify_class("ComboBoxEx32"), ComboClass::Other);
    assert_eq!(
        classify_class("WindowsForms10.COMBOBOX.app.0.1"),
        ComboClass::Other,
        "the caller passes the system base class, never a toolkit's own class name"
    );
    assert_eq!(classify_class("Edit"), ComboClass::Other);
    assert_eq!(classify_class(""), ComboClass::Other);
}

#[test]
fn owner_drawn_boxes_without_item_text_are_left_alone() {
    assert!(keeps_item_text(0x0003), "plain drop-down list");
    assert!(keeps_item_text(0x0313), "owner-drawn with CBS_HASSTRINGS");
    assert!(
        !keeps_item_text(0x0013),
        "owner-drawn fixed without strings"
    );
    assert!(
        !keeps_item_text(0x0023),
        "owner-drawn variable without strings"
    );
}

#[test]
fn a_second_search_that_wraps_to_the_first_hit_means_one_item() {
    assert_eq!(classify_matches(-1, -1), ItemMatch::Missing);
    assert_eq!(classify_matches(4, 4), ItemMatch::Unique(4));
    assert_eq!(classify_matches(0, -1), ItemMatch::Unique(0));
    assert_eq!(classify_matches(4, 9), ItemMatch::Ambiguous);
    assert_eq!(classify_matches(4, 1), ItemMatch::Ambiguous);
}

#[test]
fn the_owner_hears_selendok_then_selchange_with_the_control_id() {
    assert_eq!(
        selection_notifications(105),
        [0x0009_0069, 0x0001_0069],
        "CBN_SELENDOK first, as the box sends it for a keyboard selection"
    );
    assert_eq!(
        selection_notifications(-1),
        [0x0009_FFFF, 0x0001_FFFF],
        "only the low word of the id"
    );
}

#[test]
fn only_a_drop_down_list_refuses_free_text() {
    assert!(is_drop_down_list(0x0003));
    assert!(is_drop_down_list(0x0313), "owner-drawn drop-down list");
    assert!(!is_drop_down_list(0x0002), "drop-down with an edit field");
    assert!(!is_drop_down_list(0x0001), "simple");
}

#[test]
fn errors_never_echo_the_requested_text() {
    let missing = missing_item_error(7);
    assert_eq!(missing.code, ErrorCode::ElementNotFound);
    assert!(missing.message.contains("7 chars"));
    assert_eq!(
        missing.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
    let ambiguous = ambiguous_item_error();
    assert_eq!(ambiguous.code, ErrorCode::AmbiguousTarget);
}

#[test]
fn a_commit_is_verified_only_on_the_requested_item() {
    assert!(holds_requested(2, 2, 0, true));
    assert!(
        !holds_requested(1, 1, 0, false),
        "the position held, but another item moved into it"
    );
    assert!(!holds_requested(1, 2, 0, true));
    assert!(!holds_requested(-1, 0, 0, true));
    assert!(!holds_requested(2, 2, 1, true), "list still open");
}

#[test]
fn a_search_starts_at_the_item_it_checks() {
    assert_eq!(search_start(0), usize::MAX, "-1 searches from the top");
    assert_eq!(search_start(1), 0);
    assert_eq!(search_start(305), 304);
}

#[test]
fn a_position_is_trusted_only_when_closing_changed_nothing_it_could() {
    assert!(position_still_names_item(1, 2, 2, &[0, 1], &[0, 1]));
    assert!(position_still_names_item(3, 4, 4, &[3], &[3]));
    assert!(
        !position_still_names_item(1, 2, 3, &[0, 1], &[1, 2]),
        "an item was added: position 1 may now be the other twin"
    );
    assert!(
        !position_still_names_item(1, 3, 3, &[0, 1], &[1, 2]),
        "same count, but the named items moved"
    );
    assert!(!position_still_names_item(2, 3, 3, &[0, 1], &[0, 1]));
    assert!(!position_still_names_item(0, -1, -1, &[0], &[0]));
}
#[test]
fn a_failure_after_the_items_own_select_is_still_a_delivery() {
    assert_eq!(
        after_item_select(true, DeliveryOutcome::NotDelivered),
        DeliveryOutcome::DeliveredUnverified,
        "the box's selection already moved"
    );
    assert_eq!(
        after_item_select(true, DeliveryOutcome::DeliveredVerified),
        DeliveryOutcome::DeliveredVerified
    );
    assert_eq!(
        after_item_select(false, DeliveryOutcome::DeliveredVerified),
        DeliveryOutcome::DeliveredUnverified
    );
    assert_eq!(
        after_item_select(true, DeliveryOutcome::DeliveredUnverified),
        DeliveryOutcome::DeliveredUnverified
    );
}
