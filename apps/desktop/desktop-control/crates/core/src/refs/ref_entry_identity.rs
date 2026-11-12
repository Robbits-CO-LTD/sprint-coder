// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct RefEntryIdentity {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retained_object: Option<String>,
    pub role: String,
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_id: Option<crate::ElementIdentifier>,
    /// Set when the capture read complete evidence and exactly one observed
    /// element matched this entry's full identity predicate, together with
    /// `ancestors` when that list is not empty.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unique_at_capture: bool,
    /// The identity of the element's nearest ancestors, nearest first, below
    /// the observation's root. Recorded only when the element's own predicate
    /// matched more than one element at capture and these ancestors told it
    /// apart from every other match; resolution then requires them too (see
    /// `ref_ancestry`). Empty for every other entry, which resolves by its own
    /// predicate alone, as before.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ancestors: Vec<RefAncestorIdentity>,
}

/// One ancestor's identity fields, compared under the same rule as the
/// element's own: the role always, and the stable name, description and native
/// identifier where they were recorded.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct RefAncestorIdentity {
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_id: Option<crate::ElementIdentifier>,
}
