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
//! - A range longer than the evidence bound is not truncated into a value.
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

/// The document range's text as the field's value, or `None` when it is the
/// field's own name (what a provider answers for an empty field) or too long
/// to carry as evidence.
pub(crate) fn value_from_document_text(text: String, name: Option<&str>) -> Option<String> {
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
    use super::{text_stands_in_for_value, value_from_document_text};
    use crate::tree::element::uia_element;
    use crate::tree::live_read::{LiveRead, corroborate_verified_process};
    use crate::tree::properties::MAX_EVIDENCE_CHARS;
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
        let limit = i32::try_from(MAX_EVIDENCE_CHARS + 1).unwrap_or(i32::MAX);
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
