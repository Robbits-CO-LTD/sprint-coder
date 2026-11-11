use super::{
    ComboClass, ItemMatch, after_item_select, ambiguous_item_error, classify_class,
    classify_matches, holds_requested, keeps_item_text, missing_item_error, selchange_wparam,
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
fn the_notification_carries_the_control_id_and_cbn_selchange() {
    assert_eq!(selchange_wparam(105), 0x0001_0069);
    assert_eq!(
        selchange_wparam(-1),
        0x0001_FFFF,
        "only the low word of the id"
    );
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
    assert!(holds_requested(2, 2, 0, Some("Beta"), "beta"));
    assert!(
        !holds_requested(1, 1, 0, Some("Alpha"), "Beta"),
        "the position held, but another item moved into it"
    );
    assert!(!holds_requested(2, 2, 0, None, "Beta"));
    assert!(!holds_requested(1, 2, 0, Some("Beta"), "Beta"));
    assert!(
        !holds_requested(2, 2, 1, Some("Beta"), "Beta"),
        "list still open"
    );
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
