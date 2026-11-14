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
        let remaining = deadline.remaining();
        // Whether a read of the visible elements can follow a whole read that
        // runs out, judged before that read so it can leave the time for it.
        // The check is a read of the window's root alone, bounded by
        // [`VISIBLE_CHECK_CAP`]; one that cannot answer in that time counts
        // as "not read that way", which keeps the split as before.
        let floor = if view_fallback_allowed(deadline, whole_read_share(remaining)) {
            adapter.reads_visible_elements(window, opts.surface, deadline.capped(VISIBLE_CHECK_CAP))
        } else {
            None
        };
        // That check reads the window itself, and a busy one answers it
        // slowly: the whole read is given its time out of what is left after
        // the check, so the time the check took never comes out of what is
        // kept for the read of the visible elements. Whether the capture may
        // fall back is still judged on the time before the check, as before.
        let budget = whole_read_budget(deadline.remaining(), floor.unwrap_or_default());
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
                if failure.ran_out && view_fallback_allowed(deadline, whole_read_share(remaining)) {
                    let share = visible_share(deadline, failure.partial.is_some());
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
/// takes about 5 s, and its record is over 1 MB, too large to keep), so a long
/// `--timeout-ms` would only delay the switch to the visible elements by the
/// same factor (15 s under a 20 s deadline).
pub(crate) const WHOLE_READ_CAP: std::time::Duration =
    std::time::Duration::from_millis(crate::snapshot::DEFAULT_SNAPSHOT_TIMEOUT_MS * 3 / 4 * 2);

/// The time the whole-window read is given out of `remaining`: three quarters
/// of it, leaving the rest for the read that answers when it cannot finish,
/// and never more than [`WHOLE_READ_CAP`]. When a read of the visible
/// elements follows that needs at least `floor` (the adapter says how much,
/// `reads_visible_elements`), the rest is never less than `floor`. A zero
/// floor (a Chromium-hosted window, whose visible elements the rest has
/// always been enough for, or a window not read that way) splits as before.
pub(crate) fn whole_read_budget(
    remaining: std::time::Duration,
    floor: std::time::Duration,
) -> std::time::Duration {
    whole_read_share(remaining).min(remaining.saturating_sub(floor))
}

/// The most the check whether a window is read by its visible elements may
/// take (`reads_visible_elements`, a read of the window's root alone). A
/// check that does not answer in this time counts as "not read that way",
/// which leaves the split, and the whole search of a find, as before.
pub(crate) const VISIBLE_CHECK_CAP: std::time::Duration = std::time::Duration::from_millis(500);

/// Three quarters of `remaining`, never more than [`WHOLE_READ_CAP`]: the
/// whole-window read's time before a floor is set aside, which is what
/// [`view_fallback_allowed`] judges, so a floor does not change which captures
/// may fall back to the visible elements.
fn whole_read_share(remaining: std::time::Duration) -> std::time::Duration {
    (remaining * 3 / 4).min(WHOLE_READ_CAP)
}

/// The part of what is left of `deadline` the read of the visible elements gets
/// after the whole-window read ran out. When that read left a tree, a visible
/// read that cannot finish either answers with it and starts no further walk,
/// so the read gets all that is left. Otherwise a third stays for the shallow
/// walk that answers in its place.
fn visible_share(deadline: crate::Deadline, whole_read_left_a_tree: bool) -> crate::Deadline {
    if whole_read_left_a_tree {
        deadline
    } else {
        deadline.capped(deadline.remaining() * 2 / 3)
    }
}

/// Whether a capture may fall back to the window's visible elements: only when
/// the whole window could not be read within at least the default snapshot
/// deadline. A caller that shortens the deadline cannot push a window that a
/// default read proves whole onto the narrower proof; it gets the unproven
/// shallow capture instead, as before.
///
/// `whole_read_budget` is the whole-window read's share before a floor is set
/// aside ([`whole_read_share`]). A deadline shared by several captures (a wait
/// that polls) keeps its long span while little of it is left, so the span
/// alone would let a late poll, whose whole-window read got only a fraction of
/// a default one's time, switch a window that a default read proves whole. The
/// share must be most of what a default snapshot gives it (measured: about
/// 1.9 s of the 2.25 s, after the window listing; half the default leaves room
/// for a slower listing).
///
/// The read itself can get less than that share where the adapter asks for a
/// floor: a WPF window (`reads_visible_elements` answers 1 s for it) left
/// 2.0 to 2.25 s after the listing gives its whole read 1.0 to 1.25 s. Such a
/// window is judged on its share all the same: a WPF window that a whole read
/// would prove in 1.5 s but not in 1.0 s holds a few hundred elements at most
/// (about 4 ms each, measured), while the WPF windows this switch is for (a
/// list of 200 rows or more of a button and a text) cannot be read whole in a
/// default deadline at all (measured: 200, 2,000 and 20,000 rows).
fn view_fallback_allowed(
    deadline: crate::Deadline,
    whole_read_budget: std::time::Duration,
) -> bool {
    let default = std::time::Duration::from_millis(crate::snapshot::DEFAULT_SNAPSHOT_TIMEOUT_MS);
    deadline.span() >= default && whole_read_budget >= default / 2
}

/// A capture of the window's visible elements alone, taken in place of a
/// capture whose record is too large to keep (over
/// [`crate::refs::MAX_REFMAP_BYTES`]): such a capture cannot be saved, so no
/// ref of it could be used, and the visible elements are the narrowest view
/// that still proves its refs. `None` when the adapter does not read this
/// window that way, or the read did not complete in `deadline`; the caller then
/// keeps the capture it had, which fails to save as before.
///
/// Its refs carry the proof of any other view of the visible elements
/// (`proven_in_view`), so they act only while the view stays as it is.
pub(crate) fn capture_visible(
    adapter: &dyn PlatformAdapter,
    opts: &TreeOptions,
    window: &WindowInfo,
    deadline: crate::Deadline,
) -> Option<WindowCapture> {
    match visible_window(adapter, opts, window, deadline) {
        VisibleRead::Proven(observed) => Some(WindowCapture {
            observed,
            presentation_depth: Some(ObservationRequest::snapshot_logical_depth(opts)),
            identity_unproven: None,
            visible_scope: true,
        }),
        VisibleRead::Unsupported | VisibleRead::Failed => None,
    }
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
