// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::*;
use crate::tree::properties::MAX_EVIDENCE_CHARS;

fn flag(value: bool) -> PropertyOutcome {
    PropertyOutcome::Known(PropertyValue::Flag(value))
}

fn number(value: i32) -> PropertyOutcome {
    PropertyOutcome::Known(PropertyValue::Number(value))
}

fn text(value: &str) -> PropertyOutcome {
    PropertyOutcome::Known(PropertyValue::Text(value.into()))
}

/// An edit control with no Value pattern, not secure: the one shape the Text
/// pattern may stand in for the value on.
fn edit_without_value(is_password: Option<PropertyOutcome>) -> ElementProperties {
    let mut reads = vec![
        (TreeProperty::ControlType, number(EDIT_CONTROL_TYPE)),
        (TreeProperty::ValueAvailable, flag(false)),
        (TreeProperty::Value, PropertyOutcome::Absent),
    ];
    if let Some(is_password) = is_password {
        reads.push((TreeProperty::IsPassword, is_password));
    }
    ElementProperties::from_reads(reads)
}

#[test]
fn an_edit_with_no_value_pattern_reads_its_text() {
    assert!(text_stands_in_for_value(&edit_without_value(Some(flag(
        false
    )))));
    // UI Automation answers the unsupported Value property with its default.
    let defaulted = ElementProperties::from_reads(vec![
        (TreeProperty::ControlType, number(EDIT_CONTROL_TYPE)),
        (TreeProperty::ValueAvailable, flag(false)),
        (TreeProperty::Value, text("")),
        (TreeProperty::IsPassword, flag(false)),
    ]);
    assert!(text_stands_in_for_value(&defaulted));
    assert!(text_stands_in_for_value(&edit_without_value(Some(number(
        0
    )))));
    // A provider that does not implement IsPassword answered: not a password.
    assert!(text_stands_in_for_value(&edit_without_value(Some(
        PropertyOutcome::Absent
    ))));
}

/// The secure gate. A password field's Value reads `Absent` because it was
/// withheld, the same answer as "no Value pattern", so the Text pattern must
/// not be read on it - nor when its IsPassword answer is unknown, missing or
/// the `VT_I4` shape of "true".
#[test]
fn a_secure_or_unproven_field_never_reads_its_text() {
    for is_password in [
        Some(flag(true)),
        Some(number(1)),
        Some(PropertyOutcome::Unknown),
        Some(text("yes")),
        None,
    ] {
        let properties = edit_without_value(is_password.clone());
        assert!(
            !text_stands_in_for_value(&properties),
            "IsPassword {is_password:?}"
        );
    }
}

/// A secure field whose provider *did* publish a value: the value is
/// withheld to `Absent`, and the Text pattern still is not read.
#[test]
fn a_password_field_whose_value_was_withheld_does_not_read_its_text() {
    let properties = ElementProperties::from_reads(vec![
        (TreeProperty::ControlType, number(EDIT_CONTROL_TYPE)),
        (TreeProperty::ValueAvailable, flag(false)),
        (TreeProperty::Value, text("not-a-real-secret")),
        (TreeProperty::IsPassword, flag(true)),
    ]);
    assert_eq!(properties.get(TreeProperty::Value), PropertyOutcome::Absent);
    assert!(!text_stands_in_for_value(&properties));
}

/// A field with a Value pattern keeps its Value, even an empty one: Chromium
/// answers an empty field's text range with the field's label, and a Monaco
/// editor's textarea with a notice. An unproven pattern availability, a
/// failed Value read, or real content in the Value slot also keep the Value.
#[test]
fn a_field_with_a_value_even_an_empty_one_does_not_read_its_text() {
    for (available, value) in [
        (flag(true), text("")),
        (flag(true), PropertyOutcome::Absent),
        (number(1), text("")),
        (PropertyOutcome::Unknown, text("")),
        (PropertyOutcome::Absent, text("")),
        (flag(false), PropertyOutcome::Unknown),
        (flag(false), text("content")),
    ] {
        let properties = ElementProperties::from_reads(vec![
            (TreeProperty::ControlType, number(EDIT_CONTROL_TYPE)),
            (TreeProperty::ValueAvailable, available.clone()),
            (TreeProperty::Value, value.clone()),
            (TreeProperty::IsPassword, flag(false)),
        ]);
        assert!(
            !text_stands_in_for_value(&properties),
            "{available:?} {value:?}"
        );
    }
}

/// A document's text range is a whole page, not an input's value.
#[test]
fn only_an_edit_control_reads_its_text() {
    for control_type in [
        number(50_030),
        number(50_020),
        PropertyOutcome::Unknown,
        PropertyOutcome::Absent,
    ] {
        let properties = ElementProperties::from_reads(vec![
            (TreeProperty::ControlType, control_type.clone()),
            (TreeProperty::ValueAvailable, flag(false)),
            (TreeProperty::Value, PropertyOutcome::Absent),
            (TreeProperty::IsPassword, flag(false)),
        ]);
        assert!(!text_stands_in_for_value(&properties), "{control_type:?}");
    }
}

#[test]
fn the_document_text_is_the_value_unless_it_is_the_name_or_too_long() {
    assert_eq!(
        value_from_document_text("visible text".into(), Some("Search")),
        Some("visible text".into())
    );
    assert_eq!(
        value_from_document_text("".into(), Some("Search")),
        Some("".into())
    );
    assert_eq!(
        value_from_document_text("Search".into(), Some("Search")),
        None
    );
    assert_eq!(
        value_from_document_text("Search".into(), Some("")),
        Some("Search".into())
    );
    assert_eq!(value_from_document_text("x".into(), None), Some("x".into()));
    let long = "a".repeat(super::super::properties::MAX_EVIDENCE_CHARS + 1);
    assert_eq!(value_from_document_text(long, None), None);
}

/// The review's case: a field holding `"😀" * 1023 + "abcd"`. A provider that
/// counts the read limit in UTF-16 units and stops at it hands back a prefix;
/// that prefix reaches the limit and is refused, never returned as the value.
#[test]
fn a_read_cut_at_the_unit_limit_is_not_returned_as_the_value() {
    let content = format!("{}abcd", "\u{1F600}".repeat(1023));
    // The old limit (MAX_EVIDENCE_CHARS + 1 = 2049 units) cut the final `d`.
    let old_cut: String =
        String::from_utf16(&content.encode_utf16().take(2049).collect::<Vec<_>>())
            .expect("cut between pairs");
    assert_eq!(old_cut.chars().count(), 1026);
    // Read with the new limit, the same content is complete and returned.
    assert!(!reached_read_limit(&content));
    assert_eq!(
        value_from_document_text(content.clone(), None),
        Some(content)
    );
    // Content past the new limit, cut at it, is refused.
    let long = format!("{}abcd", "\u{1F600}".repeat(MAX_EVIDENCE_CHARS));
    let cut: Vec<u16> = long.encode_utf16().take(READ_LIMIT_UNITS).collect();
    let cut = String::from_utf16(&cut).expect("ends after a whole pair");
    assert!(reached_read_limit(&cut));
    assert_eq!(value_from_document_text(cut, None), None);
}

/// Exactly `MAX_EVIDENCE_CHARS` emoji is `2 * MAX_EVIDENCE_CHARS` units, one
/// under the limit: all of it was read, and it is within the bound.
#[test]
fn a_full_bound_of_surrogate_pairs_is_read_whole() {
    let text = "\u{1F600}".repeat(MAX_EVIDENCE_CHARS);
    assert!(!reached_read_limit(&text));
    assert_eq!(value_from_document_text(text.clone(), None), Some(text));
}

/// A provider counting scalars stops at `READ_LIMIT_UNITS` scalars, which is
/// at least that many units, and one scalar past the bound is refused anyway.
#[test]
fn past_the_scalar_bound_or_at_a_scalar_counted_limit_is_refused() {
    let ascii = "a".repeat(MAX_EVIDENCE_CHARS + 1);
    assert!(!reached_read_limit(&ascii));
    assert_eq!(value_from_document_text(ascii, None), None);
    let scalar_cut = "\u{1F600}".repeat(READ_LIMIT_UNITS);
    assert_eq!(value_from_document_text(scalar_cut, None), None);
}

/// A cut inside a surrogate pair leaves a lone half, decoded as one
/// replacement unit: the read still reached the limit and is refused.
#[test]
fn a_cut_inside_a_surrogate_pair_is_refused() {
    let units: Vec<u16> = "\u{1F600}"
        .repeat(MAX_EVIDENCE_CHARS + 1)
        .encode_utf16()
        .take(READ_LIMIT_UNITS)
        .collect();
    assert!(char::decode_utf16(units.iter().copied()).any(|unit| unit.is_err()));
    let lossy = String::from_utf16_lossy(&units);
    assert!(reached_read_limit(&lossy));
    assert_eq!(value_from_document_text(lossy, None), None);
}
