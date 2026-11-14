// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ObservationCompleteness {
    pub(crate) subtree_complete: bool,
    pub(crate) predecessors_complete: bool,
    /// The node's child list was cut by the rule of the view it was read in
    /// (a read of the visible elements that reads a long list only in part).
    /// The subtree is still the whole of that view, so this alone leaves it
    /// complete; the node is presented as truncated.
    pub(crate) view_cut: bool,
}

impl ObservationCompleteness {
    pub(crate) fn new(subtree_complete: bool) -> Self {
        Self {
            subtree_complete,
            predecessors_complete: true,
            view_cut: false,
        }
    }
}
