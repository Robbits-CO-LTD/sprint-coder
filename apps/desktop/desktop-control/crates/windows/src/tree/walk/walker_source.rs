// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use agent_desktop_core::{AdapterError, ObservationRoot};

use super::walker::{WalkBudget, WalkOutcome, walk_from_root};
use crate::tree::element::UIAElement;

#[cfg(target_os = "windows")]
mod imp {
    use crate::tree::automation::{UiaFailure, automation_client, failure_of, uia_error};
    use crate::tree::element::UIAElement;
    use crate::tree::name_evidence::read_label;
    use crate::tree::properties::property_ids::TreeProperty;
    use crate::tree::properties::{read_cached_set, read_live_set, read_one, rect_has_area};
    use crate::tree::walk::cache::{
        build_children_cache_request, build_set_cache_request, build_subtree_cache_request,
        build_walk_cache_request, policy_for_root,
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
        let length = unsafe { array.Length() }.map_err(fault)?;
        let mut elements = Vec::with_capacity(usize::try_from(length).unwrap_or(0));
        for index in 0..length {
            let element = unsafe { array.GetElement(index) }.map_err(fault)?;
            elements.push(UIAElement::from(uiautomation::UIElement::from(element)));
        }
        Ok(elements)
    }

    /// Runs one call with the client's transaction timeout lowered to the
    /// deadline's remaining time, and puts the client's own bound back after.
    /// `None` when there is no time left or the bound cannot be set, so the
    /// call never runs longer than the deadline allows.
    fn with_transaction_timeout<T>(
        client: &UIAutomation,
        deadline: Deadline,
        call: impl FnOnce() -> T,
    ) -> Option<T> {
        use windows::Win32::UI::Accessibility::{IUIAutomation, IUIAutomation2};
        use windows::core::Interface;
        let remaining = u32::try_from(deadline.remaining().as_millis())
            .unwrap_or(u32::MAX)
            .min(crate::tree::automation::TRANSACTION_TIMEOUT_MS);
        if remaining == 0 {
            return None;
        }
        let bounded: IUIAutomation2 = AsRef::<IUIAutomation>::as_ref(client).cast().ok()?;
        unsafe { bounded.SetTransactionTimeout(remaining) }.ok()?;
        let result = call();
        let restored = unsafe {
            bounded.SetTransactionTimeout(crate::tree::automation::TRANSACTION_TIMEOUT_MS)
        };
        if restored.is_err() {
            tracing::warn!("could not restore the UI Automation transaction timeout");
        }
        Some(result)
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
        /// For a path descent: the request that fetches one node's whole child
        /// list in one call, and the deadline that call is bounded by.
        children: Option<(UICacheRequest, Deadline)>,
    }

    impl UiaTreeSource {
        /// A source for descending a stored child-index path: each level's
        /// child list is fetched in one call (see [`TreeSource::cached_children`])
        /// instead of a cross-process call per sibling up to the wanted index.
        /// A list that cannot be fetched that way is enumerated live as before.
        /// The list carries structure only (fetching the walk set for every
        /// sibling cost more than stepping through them on a 304-item WPF
        /// list); the caller reads the landed element with `prepare_root`.
        pub fn for_descent(root: &UIAElement, deadline: Deadline) -> Result<Self, AdapterError> {
            let mut source = Self::for_root(root)?;
            source.children = Some((build_children_cache_request(&source.client, &[])?, deadline));
            Ok(source)
        }

        /// A source for a whole-window walk, whose root can be prepared with
        /// the subtree request (see [`Self::prepare_whole_root`]) whatever the
        /// provider class: the per-node policy weighs one cache build per node
        /// against live reads, while the subtree request is one call for the
        /// whole window. Measured on Character Map with its font list open
        /// (387 nodes, client-side proxies, `Skip`), the identity walk took
        /// 1.0 s live and 0.09 s from one subtree build; on a WPF window with
        /// 646 nodes (`Batch`), 1.4-1.7 s per node and 0.8 s from one build.
        /// Both produced the same tree and the same snapshot output as the
        /// per-node walk.
        ///
        /// A root of Chromium provenance keeps the per-node walk and the walk
        /// set: its lazily built tree and its wrapper test (which reads the
        /// actions the walk set carries) were not measured against this.
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
            if !source.chromium_provenance {
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
        /// cross-process call per node. The call is bounded by the remaining
        /// deadline (the client's transaction timeout is lowered to it for this
        /// call alone), and any failure falls back to [`Self::prepare_root`]
        /// and the live per-node walk, which then meets the same deadline.
        pub fn prepare_whole_root(
            &self,
            root: &UIAElement,
            deadline: agent_desktop_core::Deadline,
        ) -> Result<UIAElement, AdapterError> {
            if let Some(request) = &self.subtree {
                let prefetched = with_transaction_timeout(&self.client, deadline, || {
                    root.0.build_updated_cache(request).ok()
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
                chromium_provenance: crate::tree::chromium::is_chromium_root(root),
                subtree: None,
                subtree_prefetched: std::cell::Cell::new(false),
                properties: &TreeProperty::WALK_SET,
                children: None,
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
    }

    impl TreeSource for UiaTreeSource {
        type Node = UIAElement;

        fn first_child(&self, node: &UIAElement) -> Result<UIAElement, UiaFailure> {
            match &self.cache {
                Some(request) => self.walker.get_first_child_build_cache(&node.0, request),
                None => self.walker.get_first_child(&node.0),
            }
            .map(UIAElement::from)
            .map_err(|error| failure_of(&error))
        }

        fn next_sibling(&self, node: &UIAElement) -> Result<UIAElement, UiaFailure> {
            match &self.cache {
                Some(request) => self.walker.get_next_sibling_build_cache(&node.0, request),
                None => self.walker.get_next_sibling(&node.0),
            }
            .map(UIAElement::from)
            .map_err(|error| failure_of(&error))
        }

        /// Only a walk whose root was prepared with the subtree request has
        /// child lists in the cache; every node of that walk comes from the
        /// cached tree, so a null list there is a real "no children" answer.
        /// A descent source fetches the one list it is asked for; when that
        /// fetch fails it answers `None`, and the caller enumerates live, so
        /// a fault is classified exactly as before.
        fn cached_children(
            &self,
            node: &UIAElement,
        ) -> Option<Result<Vec<UIAElement>, UiaFailure>> {
            use windows::Win32::UI::Accessibility::IUIAutomationElement;
            if !self.subtree_prefetched.get() {
                let (request, deadline) = self.children.as_ref()?;
                let fetched = with_transaction_timeout(&self.client, *deadline, || {
                    node.0.build_updated_cache(request).ok()
                })??;
                let element: &IUIAutomationElement = fetched.as_ref();
                // A null list is left to the live enumeration: a descent only
                // asks a node that its stored path continues below, so that
                // costs one call in the rare case, and never a wrong answer.
                return match unsafe { element.GetCachedChildren() } {
                    Ok(array) => cached_array(&array).ok().map(Ok),
                    Err(_) => None,
                };
            }
            let element: &IUIAutomationElement = node.0.as_ref();
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
            (
                properties.clone(),
                properties.locator_evidence(vocabulary),
                failed,
            )
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

        pub fn for_descent(
            root: &UIAElement,
            _deadline: agent_desktop_core::Deadline,
        ) -> Result<Self, AdapterError> {
            Self::for_root(root)
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
