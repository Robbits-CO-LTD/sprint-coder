// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! The visible text of an input field that publishes no `Value`.
//!
//! Some edit controls expose their content only through the Text pattern and
//! implement no Value pattern at all. `get --property value` (and `text`,
//! and `wait --value`) read the live `Value`, so on such a field they fell
//! back to the snapshot's value, which was empty too, while the field showed
//! text. This reads the Text pattern's document range instead - only for that
//! case, and never for a secure field.
//!
//! Deliberately narrow, because the Text pattern is not a value:
//!
//! - Only when the provider answered that it has no Value pattern
//!   (`IsValuePatternAvailable` is false). Such a field's `Value` reads `""`,
//!   the property's default, which is why `get` answered an empty value. A
//!   field that *has* the pattern and an empty value is left alone: Chromium
//!   answers an empty field's document range with the field's *label*, and a
//!   Monaco editor's hidden textarea answers it with its "editor is not
//!   accessible" notice; reading the Text pattern there would report the
//!   label as content.
//! - Only for the Edit control type: a document's range is a whole page.
//! - Only when `IsPassword` was read and is false (or the provider has no such
//!   property). A secure field's `Value` reads `Absent` here precisely because
//!   it was withheld (`ElementProperties::from_reads`), so "no Value" alone
//!   would open the gate on a password field; the secure flag is checked
//!   first, and an unread or failed `IsPassword` keeps it closed.
//! - A range equal to the field's name is not taken as content, for the same
//!   label-for-empty reason.
//! - A range longer than the evidence bound is not truncated into a value,
//!   and a read that reached the read limit (which providers count in UTF-16
//!   units, not scalars) is not returned as if it were the whole value.
//!
//! Only the reads that answer a question - `get`, `wait --value` - use it. The
//! post-action check of `set-value` does not need it: `set-value` writes
//! through the Value pattern, so its target always has one.

use super::properties::element_properties::ElementProperties;
use super::properties::property_ids::TreeProperty;
use super::properties::property_outcome::{PropertyOutcome, PropertyValue};

/// `UIA_EditControlTypeId`.
const EDIT_CONTROL_TYPE: i32 = 50_004;

/// Whether the live read allows the Text pattern to stand in for the value.
pub(crate) fn text_stands_in_for_value(properties: &ElementProperties) -> bool {
    if properties.is_secure() || !password_flag_read_false(properties) {
        return false;
    }
    // The provider must have answered that it has no Value pattern. Then the
    // `Value` slot holds no content: UI Automation answers a property the
    // provider does not support with the property's default, `""`, unless
    // asked to ignore defaults, so an empty string here is that default.
    if properties.get(TreeProperty::ValueAvailable).flag() != Some(false) {
        return false;
    }
    let value_is_default = match properties.get(TreeProperty::Value) {
        PropertyOutcome::Absent => true,
        PropertyOutcome::Known(PropertyValue::Text(value)) => value.is_empty(),
        PropertyOutcome::Known(_) | PropertyOutcome::Unknown => false,
    };
    value_is_default
        && properties.get(TreeProperty::ControlType).number() == Some(EDIT_CONTROL_TYPE)
}

/// The answer to a value read: on a field the Text pattern stands in for,
/// the Text read and nothing else - a read that failed or may have been cut
/// is no value, never the `Value` slot's default `""`; on every other field,
/// the live `Value`, whatever the Text pattern said.
pub(crate) fn answered_value(
    properties: &ElementProperties,
    text: Option<String>,
    live_value: Option<String>,
) -> Option<String> {
    if text_stands_in_for_value(properties) {
        text
    } else {
        live_value
    }
}

/// `IsPassword` was actually answered and says "not secure". `Absent` is the
/// provider saying it does not implement the property, which is a real
/// answer; `Unknown`, a missing read and any non-false answer keep the gate
/// closed, the same fail-closed reading `ElementProperties::is_secure` uses.
fn password_flag_read_false(properties: &ElementProperties) -> bool {
    match properties.get(TreeProperty::IsPassword) {
        PropertyOutcome::Known(PropertyValue::Flag(flag)) => !flag,
        PropertyOutcome::Known(PropertyValue::Number(number)) => number == 0,
        PropertyOutcome::Known(_) | PropertyOutcome::Unknown => false,
        PropertyOutcome::Absent => true,
    }
}

/// How much of the document range is asked for, in UTF-16 code units.
///
/// `GetText`'s limit is counted by the provider, and WPF counts UTF-16 code
/// units while the evidence bound counts scalar values. `MAX_EVIDENCE_CHARS`
/// scalars are at most twice as many units, so a range within the bound always
/// fits under this limit, and one more unit tells "all of it" from "cut".
pub(crate) const READ_LIMIT_UNITS: usize = super::properties::MAX_EVIDENCE_CHARS * 2 + 1;

/// Whether a range read with [`READ_LIMIT_UNITS`] may have been cut by the
/// limit: it reached the limit, so the provider may have stopped there. Such a
/// read is never a complete value. A provider that counts scalars instead
/// returns at least as many units when it reaches the limit, and a cut inside
/// a surrogate pair still counts as reaching it (the lone half is decoded as
/// one replacement unit), so either way the read is refused.
pub(crate) fn reached_read_limit(text: &str) -> bool {
    text.encode_utf16().count() >= READ_LIMIT_UNITS
}

/// The document range's text as the field's value, or `None` when it may have
/// been cut by the read limit, is the field's own name (what a provider
/// answers for an empty field), or is too long to carry as evidence.
pub(crate) fn value_from_document_text(text: String, name: Option<&str>) -> Option<String> {
    if reached_read_limit(&text) {
        return None;
    }
    if name.is_some_and(|name| !name.is_empty() && name == text) {
        return None;
    }
    match super::properties::bounded_text(text) {
        PropertyOutcome::Known(PropertyValue::Text(text)) => Some(text),
        _ => None,
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{READ_LIMIT_UNITS, text_stands_in_for_value, value_from_document_text};
    use crate::tree::element::uia_element;
    use crate::tree::live_read::{LiveRead, corroborate_verified_process};
    use agent_desktop_core::{AdapterError, Deadline, NativeHandle};
    use uiautomation::patterns::UITextPattern;

    /// The field's text read through the Text pattern, when the live read
    /// allows it. Any failure on the way is absent evidence (`Ok(None)`),
    /// except a process that died during the read, which is stale.
    pub(crate) fn text_value(
        handle: &NativeHandle,
        read: &LiveRead,
        deadline: Deadline,
    ) -> Result<Option<String>, AdapterError> {
        if !text_stands_in_for_value(&read.properties) || deadline.is_expired() {
            return Ok(None);
        }
        let element = uia_element(handle)?;
        let Ok(pattern) = element.0.get_pattern::<UITextPattern>() else {
            return Ok(None);
        };
        let Ok(range) = pattern.get_document_range() else {
            return Ok(None);
        };
        let limit = i32::try_from(READ_LIMIT_UNITS).unwrap_or(i32::MAX);
        let Ok(text) = range.get_text(limit) else {
            return Ok(None);
        };
        corroborate_verified_process(element)?;
        Ok(value_from_document_text(
            text,
            read.evidence.name.known().map(String::as_str),
        ))
    }
}

#[cfg(target_os = "windows")]
pub(crate) use imp::text_value;

#[cfg(test)]
#[path = "text_value_tests.rs"]
mod tests;
