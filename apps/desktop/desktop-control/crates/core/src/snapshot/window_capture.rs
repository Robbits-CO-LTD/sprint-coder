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
        let budget = whole_read_budget(deadline.remaining());
        let attempt = deadline.capped(budget);
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
                if failure.ran_out && view_fallback_allowed(deadline, budget) {
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
                        // when the cut-short whole read left a tree, it is
                        // presented, unproven, as a shallow walk would be, and
                        // no further walk is started.
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

/// The most a whole-window read is given, whatever the deadline: twice what a
/// default snapshot gives it (3/4 of 3 s). A whole read that is still running
/// past this is on a window too large to prove whole in a useful time (a
/// Chromium page of 1,000 rows reads whole in about 2.5 s; one of 2,000 rows
/// takes about 5 s and then fails, its record over 1 MB), so a long
/// `--timeout-ms` would only delay the switch to the visible elements by the
/// same factor (15 s under a 20 s deadline).
pub(crate) const WHOLE_READ_CAP: std::time::Duration =
    std::time::Duration::from_millis(crate::snapshot::DEFAULT_SNAPSHOT_TIMEOUT_MS * 3 / 4 * 2);

/// The time the whole-window read is given out of `remaining`: three quarters
/// of it, leaving the rest for the read that answers when it cannot finish,
/// and never more than [`WHOLE_READ_CAP`].
pub(crate) fn whole_read_budget(remaining: std::time::Duration) -> std::time::Duration {
    (remaining * 3 / 4).min(WHOLE_READ_CAP)
}

/// Whether a capture may fall back to the window's visible elements: only when
/// the whole window could not be read within at least the default snapshot
/// deadline. A caller that shortens the deadline cannot push a window that a
/// default read proves whole onto the narrower proof; it gets the unproven
/// shallow capture instead, as before.
///
/// `whole_read_budget` is the time the whole-window read was actually given.
/// A deadline shared by several captures (a wait that polls) keeps its long
/// span while little of it is left, so the span alone would let a late poll,
/// whose whole-window read got only a fraction of a default one's time, switch
/// a window that a default read proves whole. The read must have had most of
/// what a default snapshot gives it (measured: about 1.9 s of the 2.25 s, after
/// the window listing; half the default leaves room for a slower listing).
fn view_fallback_allowed(
    deadline: crate::Deadline,
    whole_read_budget: std::time::Duration,
) -> bool {
    let default = std::time::Duration::from_millis(crate::snapshot::DEFAULT_SNAPSHOT_TIMEOUT_MS);
    deadline.span() >= default && whole_read_budget >= default / 2
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
