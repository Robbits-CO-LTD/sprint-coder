// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use crate::{
    AppError, WindowInfo,
    adapter::{PlatformAdapter, TreeOptions},
    locator::live_locator::{ObservationRequest, ObservationRoot, ObservedTree},
};

/// One window capture: the observation every ref is counted against, plus the
/// logical depth the presented tree is cut at when that observation reaches
/// deeper than the caller asked for.
pub(crate) struct WindowCapture {
    pub(crate) observed: ObservedTree,
    presentation_depth: Option<u8>,
    /// Why the whole-window read that would prove this capture's tokenless
    /// refs failed or came back cut short, so those refs stay unproven.
    pub(crate) identity_unproven: Option<String>,
    /// The observation holds only the elements the window showed (see
    /// [`capture_window`]); its refs are proven in that view alone.
    pub(crate) visible_scope: bool,
}

impl WindowCapture {
    pub(crate) fn into_parts(
        self,
    ) -> Result<(crate::AccessibilityNode, bool, usize, ObservedTree), AppError> {
        let Self {
            mut observed,
            presentation_depth,
            ..
        } = self;
        let (tree, complete, nodes_observed) = match presentation_depth {
            Some(depth) => observed.project_window(depth)?,
            None => observed.project_partial()?,
        };
        Ok((tree, complete, nodes_observed, observed))
    }
}

/// Observes one window, and for a presentation whose shallow walk leaves refs
/// that can only re-identify themselves by their recorded identity, observes
/// the whole window instead and presents a cut of that one observation.
///
/// A shallow walk never sees the nodes below its depth, so the census that
/// proves a ref unique cannot run over it, and every ref it allocates is
/// refused at resolution. A ref carrying an element token re-identifies itself,
/// so a capture made of those keeps its single shallow walk. A whole-window
/// read that fails or comes back incomplete keeps that shallow tree and proves
/// nothing, rather than counting a narrower window or failing a capture whose
/// shallow walk already succeeded.
pub(crate) fn capture_window(
    adapter: &dyn PlatformAdapter,
    opts: &TreeOptions,
    window: &WindowInfo,
    deadline: crate::Deadline,
) -> Result<WindowCapture, AppError> {
    let depth = ObservationRequest::snapshot_logical_depth(opts);
    let shallow = depth < crate::refs::resolve_saved_ref::WHOLE_WINDOW_DEPTH;
    let mut unproven = None;
    if shallow && !adapter.retains_element_tokens() {
        let attempt = deadline.capped(deadline.remaining() * 3 / 4);
        match whole_window(adapter, opts, window, attempt) {
            Ok(observed) => {
                return Ok(WindowCapture {
                    observed,
                    presentation_depth: Some(depth),
                    identity_unproven: None,
                    visible_scope: false,
                });
            }
            Err(failure) => {
                if failure.ran_out && view_fallback_allowed(deadline) {
                    // A third stays for the shallow walk that answers when this
                    // read cannot finish either.
                    let share = deadline.capped(deadline.remaining() * 2 / 3);
                    match visible_window(adapter, opts, window, share) {
                        VisibleRead::Proven(observed) => {
                            return Ok(WindowCapture {
                                observed,
                                presentation_depth: Some(depth),
                                identity_unproven: None,
                                visible_scope: true,
                            });
                        }
                        // The read ran out on a window that is read this way:
                        // a call cut short there can keep its provider busy, so
                        // no further walk is started; the cut-short whole read
                        // is presented, unproven, as a shallow walk would be.
                        VisibleRead::Failed => {
                            if let Some(observed) = failure.partial {
                                return Ok(WindowCapture {
                                    observed,
                                    presentation_depth: Some(depth),
                                    identity_unproven: Some(failure.reason),
                                    visible_scope: false,
                                });
                            }
                        }
                        VisibleRead::Unsupported => {}
                    }
                }
                unproven = Some(failure.reason)
            }
        }
    }
    let observed = observe_window(adapter, opts, window, deadline)?;
    if !needs_whole_window(&observed) {
        return Ok(WindowCapture {
            observed,
            presentation_depth: None,
            identity_unproven: None,
            visible_scope: false,
        });
    }
    let unproven = match unproven {
        Some(reason) => reason,
        None if !shallow => "the window read was cut short".to_owned(),
        None => match whole_window(adapter, opts, window, deadline) {
            Ok(whole) => {
                return Ok(WindowCapture {
                    observed: whole,
                    presentation_depth: Some(depth),
                    identity_unproven: None,
                    visible_scope: false,
                });
            }
            Err(failure) => failure.reason,
        },
    };
    Ok(WindowCapture {
        observed,
        presentation_depth: None,
        identity_unproven: Some(unproven),
        visible_scope: false,
    })
}

/// Whether a capture may fall back to the window's visible elements: only when
/// the whole window could not be read within at least the default snapshot
/// deadline. A caller that shortens the deadline cannot push a window that a
/// default read proves whole onto the narrower proof; it gets the unproven
/// shallow capture instead, as before.
fn view_fallback_allowed(deadline: crate::Deadline) -> bool {
    deadline.span()
        >= std::time::Duration::from_millis(crate::snapshot::DEFAULT_SNAPSHOT_TIMEOUT_MS)
}

/// How a read of the window's visible elements ended.
enum VisibleRead {
    /// Complete, over the visible elements only.
    Proven(ObservedTree),
    /// The adapter does not read this window that way (only Chromium-hosted
    /// windows are read so), and said so without reading.
    Unsupported,
    /// The read was attempted and did not complete.
    Failed,
}

fn visible_window(
    adapter: &dyn PlatformAdapter,
    opts: &TreeOptions,
    window: &WindowInfo,
    deadline: crate::Deadline,
) -> VisibleRead {
    match crate::refs::resolve_saved_ref::observe_visible_window(adapter, opts, window, deadline) {
        Ok(observed) if !observed.is_visible_scope() => VisibleRead::Unsupported,
        Ok(observed) if observed.is_exhaustive() => VisibleRead::Proven(observed),
        Ok(_) => VisibleRead::Failed,
        Err(error) if error.code == crate::ErrorCode::ActionNotSupported => {
            VisibleRead::Unsupported
        }
        Err(_) => VisibleRead::Failed,
    }
}

pub(crate) fn first_surface_owner<T>(
    windows: Vec<WindowInfo>,
    mut observe: impl FnMut(&WindowInfo) -> Result<T, AppError>,
) -> Result<(WindowInfo, T), AppError> {
    let mut windows = windows.into_iter().peekable();
    while let Some(window) = windows.next() {
        match observe(&window) {
            Err(AppError::Adapter(error))
                if error.code == crate::ErrorCode::ElementNotFound && windows.peek().is_some() => {}
            result => return result.map(|observed| (window, observed)),
        }
    }
    Err(
        crate::AdapterError::new(crate::ErrorCode::WindowNotFound, "No window to observe")
            .unsent()
            .into(),
    )
}

/// Why the whole-window read could not prove tokenless refs, and whether it
/// ran out of time or room (the only failure a visible-element read may stand
/// in for).
struct WholeWindowFailure {
    reason: String,
    ran_out: bool,
    /// What a read cut short did observe.
    partial: Option<ObservedTree>,
}

/// The whole-window read that proves tokenless refs, or why it cannot.
fn whole_window(
    adapter: &dyn PlatformAdapter,
    opts: &TreeOptions,
    window: &WindowInfo,
    deadline: crate::Deadline,
) -> Result<ObservedTree, WholeWindowFailure> {
    match crate::refs::resolve_saved_ref::observe_whole_window(
        adapter, opts, window, deadline, None,
    ) {
        Ok(whole) if whole.is_exhaustive() => Ok(whole),
        Ok(partial) => Err(WholeWindowFailure {
            reason: "the whole-window read was cut short".to_owned(),
            ran_out: true,
            partial: Some(partial),
        }),
        Err(error) => Err(WholeWindowFailure {
            ran_out: error.code == crate::ErrorCode::Timeout,
            reason: error.message,
            partial: None,
        }),
    }
}

fn observe_window(
    adapter: &dyn PlatformAdapter,
    opts: &TreeOptions,
    window: &WindowInfo,
    deadline: crate::Deadline,
) -> Result<ObservedTree, AppError> {
    let observation_options = opts.with_ref_identity_bounds();
    let request = ObservationRequest::snapshot(&observation_options, deadline).validate()?;
    crate::tree::renderer_accessibility::observe_tree(
        adapter,
        ObservationRoot::Window(window),
        &request,
        None,
    )
}

/// Whether the presentation allocation builds from this observation keeps an
/// entry that can only re-identify itself through the capture proof: a ref or a
/// skeleton drill anchor whose identity carries no element token. Only a whole
/// window proves such an entry unique, so a capture that would present one is
/// re-observed. A presentation whose selected entries all carry a token resolves
/// through the tokens and keeps its single shallow walk.
fn needs_whole_window(observed: &ObservedTree) -> bool {
    if observed.is_exhaustive() {
        return false;
    }
    let mut presented = observed.clone();
    presented
        .project_partial()
        .is_ok_and(|(presented, _, _)| crate::refs::ref_alloc::selects_tokenless_entry(&presented))
}

#[cfg(test)]
#[path = "window_capture_tests.rs"]
mod tests;
