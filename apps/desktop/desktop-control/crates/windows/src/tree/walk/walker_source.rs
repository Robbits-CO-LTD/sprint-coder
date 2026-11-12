// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use agent_desktop_core::{AdapterError, ObservationRoot};

use super::walker::{WalkBudget, WalkOutcome, walk_from_root};
use crate::tree::element::UIAElement;

/// One navigation answer while counting a tree.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) enum CountStep<N> {
    Node(N),
    /// No such child or sibling.
    End,
    /// The call failed or had no time left: the count proves nothing.
    Failed,
}

/// Counts `root` and the nodes below it, up to `limit`, within `deadline`.
/// `None` when the tree is larger, a step fails, or the deadline passes,
/// including during the last navigation: a count whose last answer came
/// after the deadline does not license what the caller would do next.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn count_nodes<N>(
    root: N,
    limit: usize,
    deadline: agent_desktop_core::Deadline,
    mut first_child: impl FnMut(&N) -> CountStep<N>,
    mut next_sibling: impl FnMut(&N) -> CountStep<N>,
) -> Option<usize> {
    let mut count = 1usize;
    let mut pending = vec![root];
    while let Some(node) = pending.pop() {
        // Checked before every navigation, leaves included: a run of slow
        // "no child" answers must not outlast the counting share.
        if deadline.is_expired() {
            return None;
        }
        let mut child = match first_child(&node) {
            CountStep::Node(child) => child,
            CountStep::End => continue,
            CountStep::Failed => return None,
        };
        loop {
            count += 1;
            if count > limit || deadline.is_expired() {
                return None;
            }
            let next = next_sibling(&child);
            pending.push(child);
            match next {
                CountStep::Node(sibling) => child = sibling,
                CountStep::End => break,
                CountStep::Failed => return None,
            }
        }
    }
    (!deadline.is_expired()).then_some(count)
}

#[cfg(target_os = "windows")]
mod imp {
    use crate::tree::automation::{UiaFailure, automation_client, failure_of, uia_error};
    use crate::tree::element::UIAElement;
    use crate::tree::name_evidence::read_label;
    use crate::tree::properties::property_ids::TreeProperty;
    use crate::tree::properties::{read_cached_set, read_live_set, read_one, rect_has_area};
    use crate::tree::walk::cache::{
        build_set_cache_request, build_subtree_cache_request, build_walk_cache_request,
        policy_for_root,
    };
    use crate::tree::walk::walker::{DEFAULT_MAX_RAW_DEPTH, NodeKey, TreeSource, walk_vocabulary};
    use agent_desktop_core::{AdapterError, Deadline, LocatorField, Rect};
    use uiautomation::UIAutomation;
    use uiautomation::core::{UICacheRequest, UITreeWalker};

    /// The climb toward the root could not be completed with a confident
    /// answer: either the operation budget ran out between two cross-process
    /// walker calls, or a parent read failed with a fault other than
    /// exhaustion. Code review found the two collapsing into the same "no
    /// viewport" answer as reaching the true root, which a caller reads as
    /// licence to treat a genuinely clipped target as unclipped - so both
    /// causes share this one shape, distinct from `Ok(None)`.
    #[derive(Debug)]
    pub struct BudgetExpired;

    /// The provider's runtime identifier of a node, when it publishes one.
    pub fn runtime_id_of(node: &UIAElement) -> Option<Vec<i32>> {
        node.0.get_runtime_id().ok().filter(|id| !id.is_empty())
    }

    /// Whether two proxies address the same element.
    ///
    /// UI Automation hands back a new `IUIAutomationElement` per query, so
    /// asking the client is the only answer available. A free function because
    /// the enumeration walk and the ancestor climbs both need it, and a second
    /// copy is a second chance for the two to disagree.
    pub fn same_element(client: &UIAutomation, left: &UIAElement, right: &UIAElement) -> bool {
        client.compare_elements(&left.0, &right.0).unwrap_or(false)
    }

    /// The identity every cycle guard keys on: the runtime id when the provider
    /// publishes one, and otherwise the marker that sends the guard to
    /// [`same_element`].
    pub fn identity(node: &UIAElement) -> NodeKey {
        match node.0.get_runtime_id() {
            Ok(runtime_id) if !runtime_id.is_empty() => NodeKey::Runtime(runtime_id),
            _ => NodeKey::Unavailable,
        }
    }

    /// One step toward the root.
    ///
    /// Exhaustion is `Ok(None)` - the climb reached the top - while any other
    /// fault is `Err`, so a caller can tell "there is no parent" from "the
    /// parent could not be read" and refuse to decide on the second.
    pub fn parent_step(walker: &UITreeWalker, node: &UIAElement) -> Result<Option<UIAElement>, ()> {
        match walker.get_parent(&node.0) {
            Ok(parent) => Ok(Some(UIAElement::from(parent))),
            Err(error) => {
                if failure_of(&error).is_exhaustion() {
                    Ok(None)
                } else {
                    Err(())
                }
            }
        }
    }

    /// The nearest ancestor that advertises a scrollable viewport.
    ///
    /// Every step is a cross-process call, so the deadline is consulted once per
    /// step and a truncated climb is `Err` rather than a confident "no
    /// viewport" - which a caller would read as licence to skip the clipping
    /// question entirely.
    pub fn nearest_scroll_viewport(
        target: &UIAElement,
        walker: &UITreeWalker,
        deadline: Deadline,
    ) -> Result<Option<UIAElement>, BudgetExpired> {
        let mut current = target.clone();
        for _ in 0..DEFAULT_MAX_RAW_DEPTH as usize {
            if deadline.is_expired() {
                return Err(BudgetExpired);
            }
            let parent = match parent_step(walker, &current) {
                Ok(Some(parent)) => parent,
                Ok(None) => return Ok(None),
                Err(()) => return Err(BudgetExpired),
            };
            if read_one(&parent, TreeProperty::ScrollAvailable).flag() == Some(true) {
                return Ok(Some(parent));
            }
            current = parent;
        }
        Ok(None)
    }

    /// A resolved viewport's rectangle right now.
    ///
    /// Which ancestor clips the target is fixed for the life of one operation;
    /// its rectangle is not. A poller re-reads this and never the climb.
    pub fn viewport_bounds(viewport: &UIAElement) -> Result<Option<Rect>, AdapterError> {
        use windows::Win32::Foundation::HWND;
        use windows_sys::Win32::Foundation::{POINT, RECT};
        use windows_sys::Win32::Graphics::Gdi::ClientToScreen;
        use windows_sys::Win32::UI::WindowsAndMessaging::GetClientRect;

        let handle: HWND = viewport
            .0
            .get_native_window_handle()
            .map_err(|error| uia_error(&error, "read viewport window"))?
            .into();
        if !handle.0.is_null() {
            let mut rect = RECT::default();
            let mut origin = POINT::default();
            if unsafe { GetClientRect(handle.0, &mut rect) } == 0
                || unsafe { ClientToScreen(handle.0, &mut origin) } == 0
            {
                return Err(AdapterError::new(
                    agent_desktop_core::ErrorCode::ActionFailed,
                    "Could not read the native scroll viewport",
                ));
            }
            return Ok(Some(Rect {
                x: f64::from(origin.x),
                y: f64::from(origin.y),
                width: f64::from(rect.right - rect.left),
                height: f64::from(rect.bottom - rect.top),
            }));
        }
        match read_one(viewport, TreeProperty::BoundingRectangle).bounds() {
            LocatorField::Known(bounds) if rect_has_area(&bounds) => Ok(Some(bounds)),
            LocatorField::Absent => Ok(None),
            _ => Err(AdapterError::new(
                agent_desktop_core::ErrorCode::ActionFailed,
                "Could not read the scroll viewport bounds",
            )),
        }
    }

    /// The nearest scroll viewport's rectangle, for a caller that climbs once
    /// and reads once.
    pub fn nearest_scroll_viewport_bounds(
        target: &UIAElement,
        walker: &UITreeWalker,
        deadline: Deadline,
    ) -> Result<Option<Rect>, BudgetExpired> {
        nearest_scroll_viewport(target, walker, deadline)?
            .as_ref()
            .map(viewport_bounds)
            .transpose()
            .map(Option::flatten)
            .map_err(|_| BudgetExpired)
    }

    fn cached_array(
        array: &windows::Win32::UI::Accessibility::IUIAutomationElementArray,
    ) -> Result<Vec<UIAElement>, UiaFailure> {
        let fault = |error: windows::core::Error| UiaFailure::Hresult(error.code().0);
        // SAFETY: `array` is a live interface pointer the client returned on this thread.
        let length = unsafe { array.Length() }.map_err(fault)?;
        let mut elements = Vec::with_capacity(usize::try_from(length).unwrap_or(0));
        for index in 0..length {
            // SAFETY: the same live array, and `index` is below the length it reported.
            let element = unsafe { array.GetElement(index) }.map_err(fault)?;
            elements.push(UIAElement::from(uiautomation::UIElement::from(element)));
        }
        Ok(elements)
    }

    /// The most nodes a whole-tree prefetch may cover. The prefetch is one
    /// call the caller cannot stop: when it times out, the provider keeps
    /// building the answer, and the reads that follow wait behind it. Measured
    /// on a WinForms combo box with 20,000 items dropped down, a prefetch cut
    /// at 0.3 s or 1 s still left the per-node walk unable to read the root
    /// before a 5 s deadline, where the per-node walk alone returned a partial
    /// tree in 4 s. So the tree is counted first, and only a tree this small
    /// is prefetched (Character Map with its font list open is 387 nodes).
    const PREFETCH_NODE_LIMIT: usize = 1_000;

    /// The longest the count before a prefetch may take, and the longest the
    /// prefetch itself may take (the 387-node tree above took about 0.1 s to
    /// count and 0.1 s to fetch).
    const PREFETCH_COUNT_CAP: std::time::Duration = std::time::Duration::from_millis(500);
    const PREFETCH_CALL_CAP: std::time::Duration = std::time::Duration::from_millis(1_000);

    /// The time the count and the prefetch may each take out of `remaining`:
    /// a quarter each at most, so the per-node walk a failed prefetch falls
    /// back to keeps at least half of the deadline.
    pub(crate) fn prefetch_shares(
        remaining: std::time::Duration,
    ) -> (std::time::Duration, std::time::Duration) {
        let quarter = remaining / 4;
        (
            quarter.min(PREFETCH_COUNT_CAP),
            quarter.min(PREFETCH_CALL_CAP),
        )
    }

    /// Counts the raw tree below `root` with plain navigation (no properties)
    /// up to `limit`, within `deadline` (see [`super::count_nodes`]). Each
    /// navigation is one call bounded by what is left of `deadline` when it
    /// starts, so a call begun near the end of the counting share cannot run
    /// on for the share's whole length.
    pub(crate) fn count_within(
        client: &UIAutomation,
        walker: &UITreeWalker,
        root: &UIAElement,
        limit: usize,
        deadline: Deadline,
    ) -> Option<usize> {
        let step = |answer: Option<uiautomation::Result<uiautomation::UIElement>>| match answer {
            Some(Ok(node)) => super::CountStep::Node(node),
            Some(Err(error)) if failure_of(&error).is_exhaustion() => super::CountStep::End,
            Some(Err(_)) | None => super::CountStep::Failed,
        };
        super::count_nodes(
            root.0.clone(),
            limit,
            deadline,
            |node| {
                step(with_transaction_timeout(client, deadline, || {
                    walker.get_first_child(node)
                }))
            },
            |node| {
                step(with_transaction_timeout(client, deadline, || {
                    walker.get_next_sibling(node)
                }))
            },
        )
    }

    /// Runs one call with the client's transaction timeout lowered to the
    /// deadline's remaining time, and puts the bound the client had before
    /// back after, also when the call panics. `None` when there is no time
    /// left or the bound cannot be set, so the call never runs longer than the
    /// deadline allows. A call nested in another keeps the outer bound as the
    /// ceiling and leaves it in place when it returns.
    pub(crate) fn with_transaction_timeout<T>(
        client: &UIAutomation,
        deadline: Deadline,
        call: impl FnOnce() -> T,
    ) -> Option<T> {
        use windows::Win32::UI::Accessibility::{IUIAutomation, IUIAutomation2};
        use windows::core::Interface;

        /// Puts the client's previous bound back when dropped.
        struct Restore {
            client: IUIAutomation2,
            previous: u32,
        }
        impl Drop for Restore {
            fn drop(&mut self) {
                // SAFETY: the same live client on the same thread.
                if unsafe { self.client.SetTransactionTimeout(self.previous) }.is_err() {
                    tracing::warn!("could not restore the UI Automation transaction timeout");
                }
            }
        }

        let bounded: IUIAutomation2 = AsRef::<IUIAutomation>::as_ref(client).cast().ok()?;
        // SAFETY: `bounded` is this thread's live client (COM is initialised for it).
        let previous = unsafe { bounded.TransactionTimeout() }
            .unwrap_or(crate::tree::automation::TRANSACTION_TIMEOUT_MS);
        let remaining = u32::try_from(deadline.remaining().as_millis())
            .unwrap_or(u32::MAX)
            .min(crate::tree::automation::TRANSACTION_TIMEOUT_MS)
            .min(if previous > 0 { previous } else { u32::MAX });
        if remaining == 0 {
            return None;
        }
        // SAFETY: the same live client on the same thread.
        unsafe { bounded.SetTransactionTimeout(remaining) }.ok()?;
        let _restore = Restore {
            client: bounded,
            previous,
        };
        Some(call())
    }

    /// The production enumeration surface: the raw view walker, plus the cache
    /// request the provider class earned.
    pub struct UiaTreeSource {
        client: UIAutomation,
        walker: UITreeWalker,
        cache: Option<UICacheRequest>,
        /// Whether the root is Chromium/Electron provenance (the provenance
        /// gate): the transparent-wrapper depth skip must only fire under
        /// detected Chromium/WebView2 provenance, because the identical
        /// emptiness test would otherwise skip the anonymous `Group`/`Pane`
        /// containers native stacks are full of.
        chromium_provenance: bool,
        /// The request for `properties` widened to the whole subtree, held
        /// only by a whole-window walk.
        subtree: Option<UICacheRequest>,
        /// Whether the root was prepared with `subtree`, so every node this
        /// walk reaches carries its child list in the cache.
        subtree_prefetched: std::cell::Cell<bool>,
        /// The properties each node is read for: the walk set, or the identity
        /// set for a walk that only resolves a saved ref.
        properties: &'static [TreeProperty],
        /// Whether enumeration steps fetch no properties: a path descent only
        /// needs the siblings it steps over to be counted, never read.
        plain_navigation: bool,
        /// Whether this source walks the visible elements only; its evidence
        /// then carries each node's runtime identifier for the view proof.
        visible: bool,
    }

    /// A walker over the elements the window shows: the raw view without every
    /// element its provider reports offscreen. As in any conditional view, an
    /// onscreen element below a skipped one is shown under the nearest onscreen
    /// ancestor, so a path here counts positions in this view only; capture and
    /// resolution both walk it, which keeps their paths and counts in step. The
    /// condition is evaluated by the provider's side of
    /// UI Automation, so the offscreen siblings a step skips cost no call of
    /// their own; one step is bounded by the sibling count it skips (on a
    /// Chromium page of 5,000 rows, a whole walk of the 19 visible rows took
    /// about 0.2 s with no single call above a few tens of milliseconds).
    pub(crate) fn visible_view_walker(client: &UIAutomation) -> Result<UITreeWalker, AdapterError> {
        use uiautomation::types::UIProperty;
        use uiautomation::variants::Variant;
        use windows::Win32::UI::Accessibility::IUIAutomation;
        let onscreen = client
            .create_property_condition(UIProperty::IsOffscreen, Variant::from(false), None)
            .map_err(|error| uia_error(&error, "build the onscreen condition"))?;
        let automation: &IUIAutomation = client.as_ref();
        // SAFETY: `automation` is this thread's live client and `onscreen` a
        // condition it built.
        unsafe { automation.CreateTreeWalker(onscreen.as_ref()) }
            .map(UITreeWalker::from)
            .map_err(|error| {
                AdapterError::new(
                    agent_desktop_core::ErrorCode::ActionFailed,
                    "Could not open the onscreen view tree walker",
                )
                .with_platform_detail(format!("HRESULT {:#010x}", error.code().0))
            })
    }

    impl UiaTreeSource {
        /// A source that walks only the elements the window shows (see
        /// [`visible_view_walker`]), node by node with the walk set: no
        /// subtree prefetch, so no single call has to build a large answer.
        /// Child indices count positions in that view.
        pub fn for_visible_root(root: &UIAElement) -> Result<Self, AdapterError> {
            let mut source = Self::for_root(root)?;
            source.walker = visible_view_walker(&source.client)?;
            source.visible = true;
            Ok(source)
        }

        /// [`Self::for_descent`] in the view [`Self::for_visible_root`] walks,
        /// so a path recorded in that view lands where it was recorded.
        pub fn for_visible_descent(root: &UIAElement) -> Result<Self, AdapterError> {
            let mut source = Self::for_visible_root(root)?;
            source.plain_navigation = true;
            Ok(source)
        }

        /// Runs `call` with the client's per-call bound lowered to what is left
        /// of `deadline` (`with_transaction_timeout`).
        pub fn bounded_by<T>(
            &self,
            deadline: agent_desktop_core::Deadline,
            call: impl FnOnce() -> T,
        ) -> Option<T> {
            with_transaction_timeout(&self.client, deadline, call)
        }

        /// A source for descending a stored child-index path: the siblings it
        /// steps over are navigated without fetching their properties (each
        /// step is still one bounded call, as before), and the caller reads the
        /// landed element itself with `prepare_root`.
        pub fn for_descent(root: &UIAElement) -> Result<Self, AdapterError> {
            let mut source = Self::for_root(root)?;
            source.plain_navigation = true;
            Ok(source)
        }

        /// A source for a whole-window walk. A tree served by client-side
        /// providers (`Skip`, such as Character Map's Win32 controls) may be
        /// prepared with the subtree request (see [`Self::prepare_whole_root`]):
        /// those reads run in this process, and with its font list open (387
        /// nodes) the identity walk took 1.0 s per node and 0.09 s from one
        /// subtree build, with the same tree and the same snapshot output.
        ///
        /// A tree served from the target's own process (`Batch`, such as WPF)
        /// keeps the per-node walk. The subtree build there runs on the
        /// target's UI thread, which keeps building after a timeout (a 20,000
        /// item WPF list kept the target busy for over 40 s), and counting
        /// the tree first is no cheaper there than walking it: on a 646-node
        /// WPF window the count alone ran past its 0.5 s cap. A root of
        /// Chromium provenance keeps the per-node walk and the walk set.
        ///
        /// `identity_only` reads each node for [`TreeProperty::IDENTITY_SET`]
        /// alone.
        pub fn for_whole_root(
            root: &UIAElement,
            identity_only: bool,
        ) -> Result<Self, AdapterError> {
            let mut source = Self::for_root(root)?;
            if identity_only && !source.chromium_provenance {
                source.properties = &TreeProperty::IDENTITY_SET;
                if source.cache.is_some() {
                    source.cache =
                        Some(build_set_cache_request(&source.client, source.properties)?);
                }
            }
            if !source.chromium_provenance && source.cache.is_none() {
                source.subtree = Some(build_subtree_cache_request(
                    &source.client,
                    source.properties,
                )?);
            }
            Ok(source)
        }

        /// Whether this walk's nodes carry their properties in the cache: the
        /// per-node batched walk, or any walk whose root was prepared with the
        /// subtree request.
        fn reads_cache(&self) -> bool {
            self.cache.is_some() || self.subtree_prefetched.get()
        }

        /// Prepares the root with its whole subtree in one call, so the walk
        /// reads the structure and the properties from the cache instead of a
        /// call per node. Only a tree counted at no more than
        /// [`PREFETCH_NODE_LIMIT`] nodes is prefetched, and the count and the
        /// call each get a capped share of the deadline (the client's
        /// transaction timeout is lowered for the call alone). Anything else
        /// falls back to [`Self::prepare_root`] and the per-node walk, with
        /// at least half of the deadline still left for it (`prefetch_shares`).
        pub fn prepare_whole_root(
            &self,
            root: &UIAElement,
            deadline: agent_desktop_core::Deadline,
        ) -> Result<UIAElement, AdapterError> {
            let (counting, calling) = prefetch_shares(deadline.remaining());
            self.prepare_whole_root_with(root, deadline, PREFETCH_NODE_LIMIT, counting, calling)
        }

        /// [`Self::prepare_whole_root`] with its limit and its two time shares
        /// given, so a test can force each way out of the prefetch.
        pub(crate) fn prepare_whole_root_with(
            &self,
            root: &UIAElement,
            deadline: agent_desktop_core::Deadline,
            limit: usize,
            counting: std::time::Duration,
            calling: std::time::Duration,
        ) -> Result<UIAElement, AdapterError> {
            if let Some(request) = &self.subtree {
                // One navigation may not wait past the counting share either:
                // the client's own bound is far longer than that share, so
                // each one is bounded by what is left of it (`count_within`).
                let count = deadline.capped(counting);
                let small = count_within(&self.client, &self.walker, root, limit, count);
                let call = deadline.capped(calling);
                let prefetched = small.and_then(|_| {
                    with_transaction_timeout(&self.client, call, || {
                        root.0.build_updated_cache(request).ok()
                    })
                });
                if let Some(Some(element)) = prefetched {
                    self.subtree_prefetched.set(true);
                    return Ok(UIAElement::from(element));
                }
            }
            self.prepare_root(root)
        }

        pub fn for_root(root: &UIAElement) -> Result<Self, AdapterError> {
            let client = automation_client()?;
            let walker = client
                .get_raw_view_walker()
                .map_err(|error| uia_error(&error, "open the raw view tree walker"))?;
            let cache = if policy_for_root(root).batches() {
                Some(build_walk_cache_request(&client)?)
            } else {
                None
            };
            Ok(Self {
                client,
                walker,
                cache,
                chromium_provenance: crate::tree::chromium::has_chromium_provenance(root),
                subtree: None,
                subtree_prefetched: std::cell::Cell::new(false),
                properties: &TreeProperty::WALK_SET,
                plain_navigation: false,
                visible: false,
            })
        }

        /// Prefetches the walk property set onto the caller's root.
        ///
        /// The root arrives from `ElementFromHandle` or from a stored ref, so
        /// it carries no cache of its own; without this the root alone would
        /// read `Unknown` for every property while its children read fine.
        pub fn prepare_root(&self, root: &UIAElement) -> Result<UIAElement, AdapterError> {
            match &self.cache {
                Some(request) => root
                    .0
                    .build_updated_cache(request)
                    .map(UIAElement::from)
                    .map_err(|error| {
                        uia_error(&error, "prefetch the properties of a root element")
                    }),
                None => Ok(root.clone()),
            }
        }

        /// Whether the root this source walks carries Chromium provenance; the
        /// wrapper-depth skip only fires when this is true.
        #[cfg(test)]
        pub(crate) fn chromium_provenance(&self) -> bool {
            self.chromium_provenance
        }

        /// Whether the root was prepared with the subtree request.
        #[cfg(test)]
        pub(crate) fn prefetched(&self) -> bool {
            self.subtree_prefetched.get()
        }

        /// Holds the subtree request whatever the provider class, so a test
        /// can drive the prefetch on a small fixture of either class.
        #[cfg(test)]
        pub(crate) fn with_subtree_request(mut self) -> Result<Self, AdapterError> {
            self.subtree = Some(build_subtree_cache_request(&self.client, self.properties)?);
            Ok(self)
        }
    }

    impl TreeSource for UiaTreeSource {
        type Node = UIAElement;

        fn first_child(&self, node: &UIAElement) -> Result<UIAElement, UiaFailure> {
            match &self.cache {
                Some(request) if !self.plain_navigation => {
                    self.walker.get_first_child_build_cache(&node.0, request)
                }
                _ => self.walker.get_first_child(&node.0),
            }
            .map(UIAElement::from)
            .map_err(|error| failure_of(&error))
        }

        fn next_sibling(&self, node: &UIAElement) -> Result<UIAElement, UiaFailure> {
            match &self.cache {
                Some(request) if !self.plain_navigation => {
                    self.walker.get_next_sibling_build_cache(&node.0, request)
                }
                _ => self.walker.get_next_sibling(&node.0),
            }
            .map(UIAElement::from)
            .map_err(|error| failure_of(&error))
        }

        /// Only a walk whose root was prepared with the subtree request has
        /// child lists in the cache; every node of that walk comes from the
        /// cached tree, so a null list there is a real "no children" answer.
        fn cached_children(
            &self,
            node: &UIAElement,
        ) -> Option<Result<Vec<UIAElement>, UiaFailure>> {
            use windows::Win32::UI::Accessibility::IUIAutomationElement;
            if !self.subtree_prefetched.get() {
                return None;
            }
            let element: &IUIAutomationElement = node.0.as_ref();
            // SAFETY: `element` is a live interface pointer from this thread's client.
            Some(match unsafe { element.GetCachedChildren() } {
                Ok(array) => cached_array(&array),
                Err(error) if error.code().is_ok() => Ok(Vec::new()),
                Err(error) => Err(UiaFailure::Hresult(error.code().0)),
            })
        }

        fn identity(&self, node: &UIAElement) -> NodeKey {
            identity(node)
        }

        fn same_element(&self, left: &UIAElement, right: &UIAElement) -> bool {
            same_element(&self.client, left, right)
        }

        fn evidence(
            &self,
            node: &UIAElement,
        ) -> (
            crate::tree::properties::ElementProperties,
            agent_desktop_core::LocatorEvidence,
            u64,
        ) {
            let (properties, errors) = if self.reads_cache() {
                read_cached_set(node, self.properties)
            } else {
                read_live_set(node, self.properties)
            };
            let failed = u64::try_from(errors.len()).unwrap_or(u64::MAX);
            let label = read_label(node, self.reads_cache());
            let vocabulary = walk_vocabulary(&properties, &label);
            let mut evidence = properties.locator_evidence(vocabulary);
            if self.visible {
                evidence.ref_evidence.runtime_id = runtime_id_of(node);
            }
            (properties.clone(), evidence, failed)
        }

        fn is_web_wrapper(
            &self,
            _node: &UIAElement,
            properties: &crate::tree::properties::ElementProperties,
        ) -> bool {
            self.chromium_provenance && crate::tree::walk::wrapper::is_web_wrapper(properties)
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use crate::tree::automation::{ERR_NONE, UiaFailure};
    use crate::tree::element::UIAElement;
    use crate::tree::properties::ElementProperties;
    use crate::tree::properties::element_properties::ResolvedVocabulary;
    use crate::tree::walk::walker::{NodeKey, TreeSource};
    use agent_desktop_core::AdapterError;

    /// Canned arm so the walk's entry point, and every module that calls it,
    /// compile and run on a non-Windows lane. It enumerates nothing, which is
    /// the exhaustion answer, so a walk here yields a single complete node.
    pub struct UiaTreeSource;

    impl UiaTreeSource {
        pub fn for_root(_root: &UIAElement) -> Result<Self, AdapterError> {
            Ok(Self)
        }

        pub fn for_whole_root(
            root: &UIAElement,
            _identity_only: bool,
        ) -> Result<Self, AdapterError> {
            Self::for_root(root)
        }

        pub fn for_descent(root: &UIAElement) -> Result<Self, AdapterError> {
            Self::for_root(root)
        }

        pub fn for_visible_root(root: &UIAElement) -> Result<Self, AdapterError> {
            Self::for_root(root)
        }

        pub fn for_visible_descent(root: &UIAElement) -> Result<Self, AdapterError> {
            Self::for_root(root)
        }

        pub fn bounded_by<T>(
            &self,
            _deadline: agent_desktop_core::Deadline,
            call: impl FnOnce() -> T,
        ) -> Option<T> {
            Some(call())
        }

        pub fn prepare_root(&self, root: &UIAElement) -> Result<UIAElement, AdapterError> {
            Ok(root.clone())
        }

        pub fn prepare_whole_root(
            &self,
            root: &UIAElement,
            _deadline: agent_desktop_core::Deadline,
        ) -> Result<UIAElement, AdapterError> {
            self.prepare_root(root)
        }
    }

    impl TreeSource for UiaTreeSource {
        type Node = UIAElement;

        fn first_child(&self, _node: &UIAElement) -> Result<UIAElement, UiaFailure> {
            Err(UiaFailure::Sentinel(ERR_NONE))
        }

        fn next_sibling(&self, _node: &UIAElement) -> Result<UIAElement, UiaFailure> {
            Err(UiaFailure::Sentinel(ERR_NONE))
        }

        fn identity(&self, _node: &UIAElement) -> NodeKey {
            NodeKey::Unavailable
        }

        fn same_element(&self, _left: &UIAElement, _right: &UIAElement) -> bool {
            false
        }

        fn evidence(
            &self,
            _node: &UIAElement,
        ) -> (
            crate::tree::properties::ElementProperties,
            agent_desktop_core::LocatorEvidence,
            u64,
        ) {
            (
                ElementProperties::default(),
                ElementProperties::default().locator_evidence(ResolvedVocabulary::unknown()),
                0,
            )
        }

        fn is_web_wrapper(
            &self,
            _node: &UIAElement,
            _properties: &crate::tree::properties::ElementProperties,
        ) -> bool {
            false
        }
    }
}

pub use imp::UiaTreeSource;

#[cfg(target_os = "windows")]
pub(crate) use imp::{
    BudgetExpired, identity, nearest_scroll_viewport, nearest_scroll_viewport_bounds, parent_step,
    same_element, viewport_bounds,
};

#[cfg(all(test, target_os = "windows"))]
pub(crate) use imp::{count_within, prefetch_shares};

#[cfg(target_os = "windows")]
pub(crate) use imp::with_transaction_timeout;

#[cfg(target_os = "windows")]
pub(crate) use imp::{runtime_id_of, visible_view_walker};

/// The depth from which a walk covers the whole tree below its root: the
/// deepest a walk descends (`DEFAULT_MAX_RAW_DEPTH`), which is also the depth
/// a whole-window observation (snapshot capture proof, saved-ref resolution)
/// asks for. Only such a walk prefetches the subtree, since a shallower walk
/// would fetch nodes it never visits.
const WHOLE_TREE_DEPTH: u8 = super::walker::DEFAULT_MAX_RAW_DEPTH;

/// Walks a live UI Automation subtree from an arbitrary root element.
///
/// The cache policy is chosen once, from the root's provider class, and the
/// root is prefetched to match it, so the whole walk reads through one
/// consistent mechanism.
pub fn walk_uia_subtree(
    root: &UIAElement,
    root_source: &ObservationRoot<'_>,
    budget: WalkBudget,
) -> Result<WalkOutcome, AdapterError> {
    walk_uia_subtree_for(root, root_source, budget, false)
}

/// Walks only the elements the window shows (`UiaTreeSource::for_visible_root`),
/// with each call bounded by what was left of the walk's deadline when the walk
/// began.
pub fn walk_uia_visible_subtree(
    root: &UIAElement,
    root_source: &ObservationRoot<'_>,
    budget: WalkBudget,
) -> Result<WalkOutcome, AdapterError> {
    let source = UiaTreeSource::for_visible_root(root)?;
    let prepared = source.prepare_root(root)?;
    let deadline = budget.deadline;
    source
        .bounded_by(deadline, || {
            walk_from_root(&source, &prepared, root_source, budget)
        })
        .unwrap_or_else(|| Err(deadline.timeout_error()))
}

/// [`walk_uia_subtree`] for an observation that may only resolve a saved ref
/// (`identity_only`), whose nodes are read for the identity evidence alone.
pub fn walk_uia_subtree_for(
    root: &UIAElement,
    root_source: &ObservationRoot<'_>,
    budget: WalkBudget,
    identity_only: bool,
) -> Result<WalkOutcome, AdapterError> {
    let whole =
        budget.max_logical_depth >= WHOLE_TREE_DEPTH && budget.max_raw_depth >= WHOLE_TREE_DEPTH;
    if whole {
        let source = UiaTreeSource::for_whole_root(root, identity_only)?;
        let prepared = source.prepare_whole_root(root, budget.deadline)?;
        return walk_from_root(&source, &prepared, root_source, budget);
    }
    let source = UiaTreeSource::for_root(root)?;
    let prepared = source.prepare_root(root)?;
    walk_from_root(&source, &prepared, root_source, budget)
}

#[cfg(test)]
#[path = "walker_source_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "identity_set_tests.rs"]
mod identity_set_tests;

#[cfg(all(test, target_os = "windows"))]
#[path = "walker_prefetch_tests.rs"]
mod prefetch_tests;
