// Added by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! The view of the elements a window shows, for providers whose conditional
//! tree walker cannot give it.
//!
//! A read of the visible elements (`ObservationMode::visible_only`) walks one
//! of two views, chosen per window by [`visible_view_for`]:
//!
//! - [`VisibleView::Onscreen`], for Chromium-hosted windows: the conditional
//!   walker `IsOffscreen == false` (`walker_source::visible_view_walker`). Its
//!   provider evaluates the condition on its own side and reports offscreen
//!   every element scrolled out of view, descendants included.
//! - [`VisibleView::Shown`], for WPF windows: the raw view, where an element
//!   the provider reports offscreen is left out together with everything
//!   below it, and where a child list is read up to its first
//!   [`SHOWN_CHILD_CAP`] children ([`ShownView`]).
//!
//! WPF needs the second form. Measured on a non-virtualized WPF `ListBox`
//! (.NET Framework 4.8 and .NET 10): a row scrolled out of view reports
//! `IsOffscreen` true, and the value follows a scroll, but the text and the
//! button inside that row keep reporting false. The conditional walker shows
//! such a descendant under the nearest onscreen ancestor, so its view of a
//! 2,000-row list held 3,982 elements and took 5.4 s, and finding the end of
//! a list under a condition took about 2.5 ms of the target's time per row
//! left (4.9 s for 1,982 rows). Stepping over a row with one plain call takes
//! about 1.1 ms (2.2 s for 2,000 rows, 22 s for 20,000), so no read that steps
//! over every row fits a snapshot; hence the cap. The target's UI thread kept
//! answering within a few tens of milliseconds through all of these.
//!
//! The view is a deterministic function of what the provider answers: capture
//! and resolution walk it the same way, a path counts positions in it, and a
//! view proof also holds the element to its runtime identifier and exact
//! bounds, so a provider that reported an element wrongly would only widen or
//! narrow the view, never let a ref land on another element. A list cut at the
//! cap is marked (`children_cut`), and the snapshot says that its further
//! items are not read this way.

use crate::tree::automation::UiaFailure;
use crate::tree::walk::walker::{NodeKey, TreeSource};

/// How many children of one element the shown view reads: the elements past
/// this point in a child list are not part of it, however they are reported.
/// Each child costs one call (about 1.1 ms on the WPF list above), and the
/// view is read once at capture and again for every action on one of its
/// refs, within what is left of a default snapshot after the whole-window
/// read gave up (about 0.4 s).
pub(crate) const SHOWN_CHILD_CAP: usize = 100;

/// Which view a read of a window's visible elements walks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum VisibleView {
    /// The conditional `IsOffscreen == false` walker.
    Onscreen,
    /// The raw view without offscreen subtrees, child lists capped.
    Shown,
}

/// The UI Automation framework name WPF's provider reports.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const WPF_FRAMEWORK: &str = "WPF";

/// The least time the shown view's read needs after a whole-window read ran
/// out (`PlatformAdapter::reads_visible_elements`): the visible elements of a
/// WPF window holding a 2,000-row list (85 of them) took 0.48 to 0.75 s to
/// read, against the 0.52 to 0.58 s a default snapshot leaves after its whole
/// read, so the switch failed about half the time without it. The onscreen
/// view (Chromium) asks for none: what is left has been enough for it.
///
/// Changed by Sprint Coder (750 ms -> 1 s): measured again right after a
/// whole read ran out, the same read took 0.60 to 0.76 s on 2,000 and 20,000
/// rows (the target is still busy with the cut-short read), so a 750 ms floor
/// left the switch failing in 5 of 8 default snapshots on 2,000 rows and 2 of
/// 3 on 20,000.
pub(crate) const SHOWN_READ_FLOOR: std::time::Duration = std::time::Duration::from_millis(1_000);

impl VisibleView {
    /// The least time this view's read needs after a whole read ran out.
    pub(crate) fn read_floor(self) -> std::time::Duration {
        match self {
            Self::Onscreen => std::time::Duration::ZERO,
            Self::Shown => SHOWN_READ_FLOOR,
        }
    }
}

/// The view the visible elements of a window are read in, or `None` when the
/// window is not read that way (only frameworks whose offscreen reporting was
/// measured are): Chromium provenance first, so a WPF window that holds
/// WebView2 content keeps the view it had, then a WPF root. Every other
/// framework (WinForms, Win32, WinUI, ...) is refused.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn visible_view_for(
    chromium_provenance: bool,
    framework_id: Option<&str>,
) -> Option<VisibleView> {
    if chromium_provenance {
        Some(VisibleView::Onscreen)
    } else if framework_id == Some(WPF_FRAMEWORK) {
        Some(VisibleView::Shown)
    } else {
        None
    }
}

/// The start of the class of every window WPF creates for a top level
/// (`HwndWrapper[<domain>;;<guid>]`, from `HwndSource`).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const WPF_WINDOW_CLASS_PREFIX: &str = "HwndWrapper[";

/// What a top-level window's handle alone says about the view its visible
/// elements are read in, before anything asks the target: read from the
/// window's class and its child windows, neither of which sends it a message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowViewHint {
    /// Of Chromium provenance: read in [`VisibleView::Onscreen`], the same
    /// answer [`checked_view_of`] gives its root (that check reads the same
    /// class and child windows, through the root).
    Onscreen,
    /// A WPF window by its class: whether it is read in the shown view still
    /// depends on the framework its root reports, which only the target's
    /// provider can answer.
    WpfCandidate,
    /// Neither: not read by its visible elements.
    NotRead,
}

/// [`WindowViewHint`] of a window whose class is `class`, Chromium provenance
/// first as in [`visible_view_for`] (`holds_chromium_content` is asked only
/// when the class is not Chromium's).
///
/// A window whose class is neither Chromium's nor WPF's is not read by its
/// visible elements even if its root were to report the WPF framework: no
/// such window was seen (every WPF top level is an `HwndWrapper[` window), and
/// this is the narrow side - the window keeps the read it had before
/// [`VisibleView::Shown`] existed.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn window_view_hint_of(
    class: &str,
    holds_chromium_content: impl FnOnce() -> bool,
) -> WindowViewHint {
    if crate::tree::chromium::chromium_provenance_of(class, holds_chromium_content) {
        WindowViewHint::Onscreen
    } else if class.starts_with(WPF_WINDOW_CLASS_PREFIX) {
        WindowViewHint::WpfCandidate
    } else {
        WindowViewHint::NotRead
    }
}

/// [`window_view_hint_of`] of a live top-level window, `NotRead` when its class
/// cannot be read (a destroyed window).
#[cfg(target_os = "windows")]
pub(crate) fn window_view_hint(handle: isize) -> WindowViewHint {
    match crate::tree::chromium::window_class_name(handle) {
        Some(class) => window_view_hint_of(&class, || {
            crate::tree::chromium::window_holds_chromium_content(handle)
        }),
        None => WindowViewHint::NotRead,
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn window_view_hint(_handle: isize) -> WindowViewHint {
    WindowViewHint::NotRead
}

/// What the check of a window's view found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ViewCheck {
    /// The root was read: the view it is read in, or `None` for none.
    Read(Option<VisibleView>),
    /// The root's class, window or framework could not be read within the
    /// check's time: which view applies is not known.
    Unread,
}

impl ViewCheck {
    /// The view, taking a check that could not answer for "no view" (the
    /// narrow answer where the alternative is the way the window was read
    /// before: a capture keeps its split, an observation refuses).
    pub(crate) fn or_none(self) -> Option<VisibleView> {
        match self {
            Self::Read(view) => view,
            Self::Unread => None,
        }
    }
}

/// The view a ref proven among the visible elements is resolved in: the shown
/// view for a window read in it, the onscreen view for any other window read
/// (as before the shown view existed), and `None` when the check could not
/// answer, so that a resolution reports an identity it could not confirm
/// (which may be retried) rather than descending a guessed view and settling
/// the ref stale.
pub(crate) fn proof_view(check: ViewCheck) -> Option<VisibleView> {
    match check {
        ViewCheck::Read(Some(VisibleView::Shown)) => Some(VisibleView::Shown),
        ViewCheck::Read(_) => Some(VisibleView::Onscreen),
        ViewCheck::Unread => None,
    }
}

/// The most the check of a window's view may take: three reads of the root
/// (class, window handle, framework). The same cap as core's
/// `VISIBLE_CHECK_CAP`, which bounds the whole question from its side.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const VIEW_CHECK_CAP: std::time::Duration = std::time::Duration::from_millis(500);

/// [`visible_view_for`] of a live root, its reads bounded by what is left of
/// `deadline` and never more than [`VIEW_CHECK_CAP`] (the client's own bound
/// is far longer, up to 20 s). The framework is read only when the root is
/// not of Chromium provenance. A read that fails, or does not answer in time,
/// is [`ViewCheck::Unread`], never taken for another framework.
#[cfg(target_os = "windows")]
pub(crate) fn checked_view_of(
    root: &crate::tree::element::UIAElement,
    deadline: agent_desktop_core::Deadline,
) -> ViewCheck {
    let Ok(client) = crate::tree::automation::automation_client() else {
        return ViewCheck::Unread;
    };
    let read = || -> Result<Option<VisibleView>, ()> {
        if crate::tree::chromium::chromium_provenance_checked(root)? {
            return Ok(visible_view_for(true, None));
        }
        let framework = root.0.get_framework_id().map_err(drop)?;
        Ok(visible_view_for(false, Some(&framework)))
    };
    match crate::tree::walk::walker_source::with_transaction_timeout(
        &client,
        deadline.capped(VIEW_CHECK_CAP),
        read,
    ) {
        Some(Ok(view)) => ViewCheck::Read(view),
        Some(Err(())) | None => ViewCheck::Unread,
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn checked_view_of(
    _root: &crate::tree::element::UIAElement,
    _deadline: agent_desktop_core::Deadline,
) -> ViewCheck {
    ViewCheck::Read(None)
}

/// What the shown view needs from the source it filters.
pub(crate) trait OffscreenReport: TreeSource {
    /// Whether the provider reports `node` offscreen: `Ok(true)` when it
    /// answered so, `Ok(false)` when it answered otherwise or answered no
    /// value (a provider without the property reports nothing offscreen, the
    /// same on every read). `Err` is a read that failed: what it would have
    /// answered is not known, so the element is neither kept nor skipped.
    fn reported_offscreen(&self, node: &Self::Node) -> Result<bool, UiaFailure>;
}

/// One element of the shown view, with its position in its parent's raw
/// child list (which the cap counts).
#[derive(Clone)]
pub(crate) struct ShownNode<N> {
    pub(crate) element: N,
    raw_index: usize,
}

impl<N> ShownNode<N> {
    /// The view's root: the element itself, not a member of any child list.
    pub(crate) fn root(element: N) -> Self {
        Self {
            element,
            raw_index: 0,
        }
    }
}

/// The shown view over `inner` (see the module notes). Positions count the
/// elements of the view, so a walk and a path descent over it agree.
pub(crate) struct ShownView<'a, S: OffscreenReport> {
    inner: &'a S,
    cap: usize,
    deadline: agent_desktop_core::Deadline,
    /// Whether the child list enumerated last was cut at the cap. A child list
    /// is always enumerated to its end before another is started (the walk
    /// reads a node's whole list before it visits any child, and a descent
    /// reads one list per level), and `first_child` starts it over.
    cut: std::cell::Cell<bool>,
}

impl<'a, S: OffscreenReport> ShownView<'a, S> {
    pub(crate) fn new(inner: &'a S, deadline: agent_desktop_core::Deadline) -> Self {
        Self::with_cap(inner, SHOWN_CHILD_CAP, deadline)
    }

    pub(crate) fn with_cap(
        inner: &'a S,
        cap: usize,
        deadline: agent_desktop_core::Deadline,
    ) -> Self {
        Self {
            inner,
            cap,
            deadline,
            cut: std::cell::Cell::new(false),
        }
    }

    /// The first element of the view at or after `element` in its raw list.
    /// Offscreen siblings are stepped over one call each, never more than the
    /// cap allows; an element at the cap ends the list and marks it cut.
    fn shown_from(
        &self,
        mut element: S::Node,
        mut raw_index: usize,
    ) -> Result<ShownNode<S::Node>, UiaFailure> {
        loop {
            if raw_index >= self.cap {
                self.cut.set(true);
                return Err(END_OF_LIST);
            }
            // A read that failed ends the step as a failure: the element is
            // neither put in the view nor stepped over, so no position after
            // it is counted from a guess.
            if !self.inner.reported_offscreen(&element)? {
                return Ok(ShownNode { element, raw_index });
            }
            if self.deadline.is_expired() {
                return Err(OUT_OF_TIME);
            }
            element = self.inner.next_sibling(&element)?;
            raw_index += 1;
        }
    }
}

/// The benign end-of-list answer (`UiaFailure::is_exhaustion`).
const END_OF_LIST: UiaFailure = UiaFailure::Sentinel(crate::tree::automation::ERR_NONE);

/// What a step over offscreen siblings answers when the deadline passed in
/// the middle of it: a timeout, never the end of the list.
const OUT_OF_TIME: UiaFailure = UiaFailure::Hresult(crate::system::runtime::hresult::UIA_E_TIMEOUT);

impl<S: OffscreenReport> TreeSource for ShownView<'_, S> {
    type Node = ShownNode<S::Node>;

    fn first_child(&self, node: &Self::Node) -> Result<Self::Node, UiaFailure> {
        self.cut.set(false);
        let first = self.inner.first_child(&node.element)?;
        self.shown_from(first, 0)
    }

    fn next_sibling(&self, node: &Self::Node) -> Result<Self::Node, UiaFailure> {
        let next = self.inner.next_sibling(&node.element)?;
        self.shown_from(next, node.raw_index + 1)
    }

    fn children_cut(&self) -> bool {
        self.cut.get()
    }

    fn identity(&self, node: &Self::Node) -> NodeKey {
        self.inner.identity(&node.element)
    }

    fn same_element(&self, left: &Self::Node, right: &Self::Node) -> bool {
        self.inner.same_element(&left.element, &right.element)
    }

    fn evidence(
        &self,
        node: &Self::Node,
    ) -> (
        crate::tree::properties::ElementProperties,
        agent_desktop_core::LocatorEvidence,
        u64,
    ) {
        self.inner.evidence(&node.element)
    }

    fn is_web_wrapper(
        &self,
        node: &Self::Node,
        properties: &crate::tree::properties::ElementProperties,
    ) -> bool {
        self.inner.is_web_wrapper(&node.element, properties)
    }
}

#[cfg(test)]
#[path = "shown_view_tests.rs"]
mod tests;
