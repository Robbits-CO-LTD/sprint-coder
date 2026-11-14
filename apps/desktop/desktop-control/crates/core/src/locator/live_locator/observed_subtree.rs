// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::{LocatorEvidence, ObservationCompleteness};

pub struct ObservedSubtree {
    pub(crate) evidence: LocatorEvidence,
    pub(crate) children: Vec<Self>,
    pub(crate) completeness: ObservationCompleteness,
    pub(crate) children_count: Option<u32>,
    pub(crate) source_child_index: Option<usize>,
    pub(crate) wrapper: bool,
}

impl ObservedSubtree {
    pub fn new(
        evidence: LocatorEvidence,
        children: Vec<Self>,
        subtree_complete: bool,
        children_count: Option<u32>,
    ) -> Self {
        Self {
            evidence,
            children,
            completeness: ObservationCompleteness::new(subtree_complete),
            children_count,
            source_child_index: None,
            wrapper: false,
        }
    }

    /// Preserves this node's index in its platform-native parent child list.
    pub fn with_source_child_index(mut self, source_child_index: usize) -> Self {
        self.source_child_index = Some(source_child_index);
        self
    }

    pub fn with_predecessors_complete(mut self, predecessors_complete: bool) -> Self {
        self.completeness.predecessors_complete = predecessors_complete;
        self
    }

    /// Marks a layout wrapper: the platform's walks charge it raw depth and no
    /// logical depth, so a shallow presentation keeps what a walk would.
    pub fn with_wrapper(mut self, wrapper: bool) -> Self {
        self.wrapper = wrapper;
        self
    }

    /// Marks a node whose child list the view it was read in cut short by its
    /// own rule (a read of the visible elements that reads only the start of a
    /// long list). The subtree stays complete for that view; the node is
    /// presented as truncated so a reader knows its list is not whole.
    pub fn with_view_cut(mut self, view_cut: bool) -> Self {
        self.completeness.view_cut = view_cut;
        self
    }

    pub fn is_complete(&self) -> bool {
        self.completeness.subtree_complete
    }
}
