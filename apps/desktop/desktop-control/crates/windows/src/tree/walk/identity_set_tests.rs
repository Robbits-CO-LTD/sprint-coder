// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! The identity walk reads `TreeProperty::IDENTITY_SET` alone. These tests pin
//! that the evidence a saved ref is compared by - role, name, value,
//! description and native identifier - comes out the same from that set as
//! from the full walk set, whatever the properties outside it hold.

use agent_desktop_core::Rect;

use crate::tree::name_evidence::LabelOutcome;
use crate::tree::properties::ElementProperties;
use crate::tree::properties::property_ids::TreeProperty;
use crate::tree::properties::property_outcome::{PropertyOutcome, PropertyValue};
use crate::tree::walk::walker::walk_vocabulary;

const FLAG_PROPERTIES: [TreeProperty; 9] = [
    TreeProperty::ToggleAvailable,
    TreeProperty::ExpandCollapseAvailable,
    TreeProperty::SelectionAvailable,
    TreeProperty::ValueAvailable,
    TreeProperty::WindowAvailable,
    TreeProperty::GridItemAvailable,
    TreeProperty::TableItemAvailable,
    TreeProperty::IsDialog,
    TreeProperty::ValueIsReadOnly,
];

fn text(value: &str) -> PropertyOutcome {
    PropertyOutcome::Known(PropertyValue::Text(value.to_string()))
}

fn flag(value: bool) -> PropertyOutcome {
    PropertyOutcome::Known(PropertyValue::Flag(value))
}

/// What a property outside the identity set holds: nothing, or a value of its
/// own kind, so a test fails if any identity field reads it.
fn noise(property: TreeProperty, loud: bool) -> PropertyOutcome {
    if !loud {
        return PropertyOutcome::Absent;
    }
    match property {
        TreeProperty::BoundingRectangle => PropertyOutcome::Known(PropertyValue::Bounds(Rect {
            x: 1.0,
            y: 2.0,
            width: 30.0,
            height: 40.0,
        })),
        TreeProperty::LegacyValue
        | TreeProperty::LegacyDefaultAction
        | TreeProperty::LocalizedControlType
        | TreeProperty::AriaRole => text("noise"),
        TreeProperty::LegacyState
        | TreeProperty::ToggleState
        | TreeProperty::ExpandCollapseState => PropertyOutcome::Known(PropertyValue::Number(1)),
        _ => flag(true),
    }
}

/// The full walk-set reads and their projection onto the identity set, which
/// is what a cached or live read of only that set yields.
fn both(
    identity: &[(TreeProperty, PropertyOutcome)],
    loud: bool,
) -> (ElementProperties, ElementProperties) {
    let full = TreeProperty::WALK_SET
        .iter()
        .filter(|property| !property.is_element_valued())
        .map(|&property| {
            let outcome = identity
                .iter()
                .find(|(candidate, _)| *candidate == property)
                .map(|(_, outcome)| outcome.clone())
                .unwrap_or_else(|| {
                    if TreeProperty::IDENTITY_SET.contains(&property) {
                        PropertyOutcome::Absent
                    } else {
                        noise(property, loud)
                    }
                });
            (property, outcome)
        })
        .collect::<Vec<_>>();
    let projected = full
        .iter()
        .filter(|(property, _)| TreeProperty::IDENTITY_SET.contains(property))
        .cloned()
        .collect::<Vec<_>>();
    (
        ElementProperties::from_reads(full),
        ElementProperties::from_reads(projected),
    )
}

fn identity_of(properties: &ElementProperties, label: &LabelOutcome) -> String {
    let vocabulary = walk_vocabulary(properties, label);
    let evidence = properties.locator_evidence(vocabulary.clone());
    format!(
        "{:?}|{:?}|{:?}|{:?}|{:?}|{}",
        vocabulary.role,
        vocabulary.name,
        vocabulary.description,
        evidence.value,
        evidence.identifiers,
        properties.is_secure()
    )
}

fn assert_same(identity: &[(TreeProperty, PropertyOutcome)], label: &LabelOutcome) {
    for loud in [false, true] {
        let (full, projected) = both(identity, loud);
        assert_eq!(
            identity_of(&full, label),
            identity_of(&projected, label),
            "identity evidence differs for {identity:?} (noise: {loud}, label: {label:?})"
        );
    }
}

#[test]
fn every_role_refinement_reads_only_the_identity_set() {
    for control_type in 50_000..=50_041 {
        for mask in 0..(1u32 << FLAG_PROPERTIES.len()) {
            let mut identity = vec![
                (
                    TreeProperty::ControlType,
                    PropertyOutcome::Known(PropertyValue::Number(control_type)),
                ),
                (TreeProperty::Name, text("Save")),
            ];
            for (bit, property) in FLAG_PROPERTIES.iter().enumerate() {
                identity.push((*property, flag(mask & (1 << bit) != 0)));
            }
            assert_same(&identity, &LabelOutcome::Unlabelled);
        }
    }
}

#[test]
fn every_name_value_description_and_identifier_shape_reads_only_the_identity_set() {
    let names = [
        text("Save"),
        text(""),
        PropertyOutcome::Absent,
        PropertyOutcome::Unknown,
    ];
    let values = [
        text("Save"),
        text("12\r"),
        PropertyOutcome::Absent,
        PropertyOutcome::Unknown,
    ];
    let descriptions = [
        text("hint"),
        PropertyOutcome::Absent,
        PropertyOutcome::Unknown,
    ];
    let ids = [
        text("id1"),
        text(" "),
        PropertyOutcome::Absent,
        PropertyOutcome::Unknown,
    ];
    let classes = [text("RichEdit20W"), text("Button")];
    let secure = [flag(false), flag(true), PropertyOutcome::Unknown];
    let labels = [
        LabelOutcome::Unlabelled,
        LabelOutcome::Text("Label".to_string()),
        LabelOutcome::Withheld,
        LabelOutcome::Failed,
    ];
    // Button, ComboBox, Edit, Text, Document, Pane.
    for control_type in [50_000, 50_003, 50_004, 50_020, 50_030, 50_033] {
        for name in &names {
            for value in &values {
                for full_description in &descriptions {
                    for help in &descriptions {
                        for id in &ids {
                            for class in &classes {
                                for password in &secure {
                                    let identity = vec![
                                        (
                                            TreeProperty::ControlType,
                                            PropertyOutcome::Known(PropertyValue::Number(
                                                control_type,
                                            )),
                                        ),
                                        (TreeProperty::Name, name.clone()),
                                        (TreeProperty::Value, value.clone()),
                                        (TreeProperty::FullDescription, full_description.clone()),
                                        (TreeProperty::HelpText, help.clone()),
                                        (TreeProperty::AutomationId, id.clone()),
                                        (TreeProperty::ClassName, class.clone()),
                                        (TreeProperty::IsPassword, password.clone()),
                                        (TreeProperty::ValueAvailable, flag(true)),
                                        (TreeProperty::ValueIsReadOnly, flag(false)),
                                    ];
                                    for label in &labels {
                                        assert_same(&identity, label);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn the_identity_set_is_part_of_the_walk_set() {
    for property in TreeProperty::IDENTITY_SET {
        assert!(
            TreeProperty::WALK_SET.contains(&property),
            "{} is read by the identity walk but not by the walk",
            property.as_str()
        );
    }
}
