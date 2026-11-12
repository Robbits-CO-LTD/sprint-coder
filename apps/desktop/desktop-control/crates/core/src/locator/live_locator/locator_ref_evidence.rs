// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::LocatorField;
use crate::{NodeDescriptor, Rect};

#[derive(Debug, Clone, PartialEq)]
pub struct LocatorRefEvidence {
    pub bounds: LocatorField<Rect>,
    /// The same node's rectangle in its window, when the toolkit reports no
    /// global position. It does not move when the window does, so it can
    /// identify an element by its whole rectangle.
    pub window_bounds: LocatorField<Rect>,
    pub available_actions: LocatorField<Vec<String>>,
    /// The presentation-only descriptor group, carried here as its
    /// evidence-side home: `LocatorEvidence` and `ObservedNode` are both at
    /// the field cap, so the group rides the observed-node projection here.
    pub descriptors: NodeDescriptor,
    /// The provider's runtime identifier for the node, read only by a walk of
    /// the visible elements: a view proof records it, so an element that took
    /// the recorded element's place in the view is not taken for it.
    pub runtime_id: Option<Vec<i32>>,
}
