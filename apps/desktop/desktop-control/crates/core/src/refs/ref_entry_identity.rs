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
    /// element matched this entry's full identity predicate. An entry proven
    /// only together with its ancestors leaves this unset (see `ancestors`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unique_at_capture: bool,
    /// The identity of the element's nearest ancestors, nearest first, below
    /// the observation's root. Recorded only when the element's own predicate
    /// matched more than one element at capture and these ancestors told it
    /// apart from every other match; resolution then requires them too (see
    /// `ref_ancestry`). Empty for every other entry, which resolves by its own
    /// predicate alone, as before.
    ///
    /// Such an entry is stored with `unique_at_capture` unset and this list
    /// under its own key, `proven_with_ancestors`: an older reader that does not
    /// know the key ignores it and sees an unproven entry, which it refuses,
    /// instead of a proven one it would resolve by its own predicate alone. An
    /// entry carrying both a set `unique_at_capture` and this list is
    /// inconsistent and is refused (`ref_ancestry::proof_of`).
    #[serde(
        rename = "proven_with_ancestors",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    pub ancestors: Vec<RefAncestorIdentity>,
    /// Set when the element was proven unique only among the elements the
    /// window showed (a capture that could not read the whole window in time;
    /// see `ref_view`). Resolution then reads the same view again and requires
    /// exactly one match there, at the recorded path and the recorded bounds.
    ///
    /// Stored under its own key, `proven_in_view`, with `unique_at_capture`
    /// unset and `ancestors` empty (the ancestors that told it apart are kept
    /// inside this record), so an older reader that does not know the key sees
    /// an unproven entry and refuses it. An entry carrying this together with
    /// either of the other proofs is inconsistent and is refused.
    #[serde(
        rename = "proven_in_view",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub in_view: Option<RefViewProof>,
    /// Set for an item of a window's standard menu bar, read from the native
    /// menu (`snapshot --surface menubar`) rather than from the accessibility
    /// tree. Only `click` runs such a ref, by the item's command, after the
    /// live menu shows the same item at the recorded names; every path that
    /// resolves a ref to an accessibility element refuses it.
    ///
    /// Stored under its own key, `proven_in_menu`, with `unique_at_capture`
    /// unset and no other proof, so an older reader that does not know the key
    /// sees an unproven entry and refuses it. An entry carrying this together
    /// with another proof or an element token is inconsistent and is refused.
    #[serde(
        rename = "proven_in_menu",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub in_menu: Option<RefMenuProof>,
}

/// Where a standard menu item sat in its window's menu bar when it was read,
/// and the command it runs: the item one level of the menu at a time from the
/// bar down, each by its name as the menu shows it (`&` markers removed, the
/// shortcut left out) and its position among its menu's items, and the
/// command identifier the item sends.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RefMenuProof {
    pub steps: Vec<RefMenuStep>,
    pub command_id: u32,
    /// The menus on the item's way report a chosen item by its position
    /// (`MNS_NOTIFYBYPOS`): running it hands over `WM_MENUCOMMAND` with the
    /// item's live position and menu instead of `WM_COMMAND` with its command.
    /// A run requires the live menus to report the same way. An older reader
    /// that does not know the key refuses such an item all the same: it
    /// refuses every item of a menu that reports by position.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub by_position: bool,
    /// The shortcut the item's text showed, for naming it to a person.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shortcut: Option<String>,
}

/// One level of a menu item's place: its name, its position among the items
/// of its menu, and whether it opens a submenu (every level but the last).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RefMenuStep {
    pub name: String,
    pub position: u32,
    pub submenu: bool,
}

/// What a proof over the window's visible elements recorded: where the element
/// sat in that view, the screen rectangle it covered, its runtime identifier,
/// and the ancestors that told it apart when its own predicate matched more
/// than one visible element.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RefViewProof {
    pub path: crate::refs::RefPath,
    pub bounds: crate::Rect,
    /// The provider's runtime identifier of the element (UI Automation's
    /// `RuntimeId`), so that another element moved into the same place of
    /// the view, reading the same, is not taken for it.
    pub runtime_id: Vec<i32>,
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
