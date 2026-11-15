// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! The windows of the app that runs desktop control for an agent are never operated.
//!
//! Sprint Coder runs this executable for its agents and passes its own process in
//! `SPRINT_CODER_DESKTOP_REFUSED_WINDOW_OWNER` (`<pid>` or `<pid>:<process instance>`, the instance
//! in the form refmaps record it, `windows-proc-v1:<start time>:<n>`). Every operation that acts on
//! a window or a part of one (an action on a part, a pointer or key delivery, focusing, moving,
//! closing, a menu command) first reads, at that moment, which process owns what it is about to
//! act on, and refuses before sending anything when that is Sprint Coder: its approval cards and
//! permission controls are the person's, whatever the agent was allowed. Reads (lists, snapshots,
//! screenshots) are not refused. A target whose owner cannot be read at all is refused too, and a
//! value that cannot be read refuses every operation. Without the variable nothing changes.

use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode};
use serde_json::json;

/// The variable Sprint Coder's Main sets for every run it starts.
pub const REFUSED_WINDOW_OWNER_VARIABLE: &str = "SPRINT_CODER_DESKTOP_REFUSED_WINDOW_OWNER";

/// Whose windows every operation refuses.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum RefusedWindowOwner {
    /// No variable: nothing is refused.
    #[default]
    Nobody,
    /// The windows of this process (of this instance of it, when known).
    Process { pid: u32, instance: Option<String> },
    /// The variable is there but cannot be read: every operation is refused.
    Unreadable,
}

/// What the facts read for one operation decide.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Verdict {
    Allowed,
    /// A target the operation would act on belongs to the refused process.
    Own,
    /// No owner of anything the operation would act on could be read.
    Unconfirmed,
    Unreadable,
}

impl RefusedWindowOwner {
    /// Reads the variable of this process.
    pub fn from_environment() -> Self {
        Self::from_variable(std::env::var_os(REFUSED_WINDOW_OWNER_VARIABLE).as_deref())
    }

    /// `<pid>` or `<pid>:<process instance>`; absent is `Nobody`, anything else `Unreadable`.
    pub fn from_variable(raw: Option<&std::ffi::OsStr>) -> Self {
        let Some(raw) = raw else {
            return Self::Nobody;
        };
        let Some(raw) = raw.to_str() else {
            return Self::Unreadable;
        };
        let (pid, instance) = match raw.split_once(':') {
            Some((pid, instance)) => (pid, Some(instance)),
            None => (raw, None),
        };
        let pid = pid
            .bytes()
            .all(|byte| byte.is_ascii_digit())
            .then(|| pid.parse::<u32>().ok())
            .flatten()
            .filter(|pid| *pid > 0);
        let instance_valid = instance.is_none_or(|instance| {
            !instance.is_empty()
                && instance.len() <= 128
                && instance
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b":._-".contains(&byte))
        });
        match pid {
            Some(pid) if instance_valid => Self::Process {
                pid,
                instance: instance.map(str::to_string),
            },
            _ => Self::Unreadable,
        }
    }

    /// Whether anything is refused at all, so a caller reads no facts when nothing is.
    pub(crate) fn is_active(&self) -> bool {
        !matches!(self, Self::Nobody)
    }

    /// Judges the owners read for one operation: refused when any of them is the refused
    /// process (its instance unknown, unreadable or the same), or when none could be read.
    /// `instance_of` reads the current instance of a pid.
    pub(crate) fn judge(
        &self,
        owners: &[Option<u32>],
        instance_of: impl Fn(u32) -> Option<String>,
    ) -> Verdict {
        let (pid, instance) = match self {
            Self::Nobody => return Verdict::Allowed,
            Self::Unreadable => return Verdict::Unreadable,
            Self::Process { pid, instance } => (*pid, instance.as_deref()),
        };
        let known: Vec<u32> = owners.iter().flatten().copied().collect();
        if known.is_empty() {
            return Verdict::Unconfirmed;
        }
        let own = known.iter().any(|owner| {
            *owner == pid
                && instance.is_none_or(|expected| {
                    instance_of(*owner).is_none_or(|current| current == expected)
                })
        });
        if own { Verdict::Own } else { Verdict::Allowed }
    }

    /// Refuses `operation` when the owners `owners` reads (only read when something is
    /// refused) decide so.
    pub(crate) fn check(
        &self,
        operation: &'static str,
        owners: impl FnOnce() -> Vec<Option<u32>>,
    ) -> Result<(), AdapterError> {
        if !self.is_active() {
            return Ok(());
        }
        let owners = owners();
        refusal(operation, self.judge(&owners, current_instance), None).map_or(Ok(()), Err)
    }

    /// Refuses a pointer operation at `points`: by the window at each point, and, when the input
    /// may reach the window in front rather than the one at the point, by the window in front.
    ///
    /// The window in front is read when `reaches_front` says so (a wheel, which reaches the
    /// focused window when scrolling inactive windows is off; modifier keys, which go to the
    /// focused window), or when the window at a point may not take the foreground when clicked
    /// (`point_may_not_take_foreground`): a click there leaves the window in front where it is,
    /// so what the click makes (an on-screen keyboard's keys, an IME candidate) reaches it. A
    /// click on an ordinary window takes the foreground first, so it is judged by the point alone.
    pub(crate) fn check_pointer(
        &self,
        operation: &'static str,
        points: &[&agent_desktop_core::Point],
        reaches_front: bool,
    ) -> Result<(), AdapterError> {
        if !self.is_active() {
            return Ok(());
        }
        let mut owners = Vec::new();
        for point in points {
            let at = point_owners(point);
            // Unread at any point is unread for the whole operation.
            if at.iter().all(Option::is_none) {
                owners.clear();
                break;
            }
            owners.extend(at);
        }
        if let Some(error) = refusal(
            operation,
            self.judge(&owners, current_instance),
            Some("point"),
        ) {
            return Err(error);
        }
        if reaches_front
            || points
                .iter()
                .any(|point| point_may_not_take_foreground(point))
        {
            let front = foreground_owners();
            if let Some(error) = refusal(
                operation,
                self.judge(&front, current_instance),
                Some("foreground"),
            ) {
                return Err(error);
            }
        }
        Ok(())
    }
}

/// The styles of one window that decide whether a click on it takes the foreground.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct WindowStyles {
    pub(crate) style: u32,
    pub(crate) ex_style: u32,
}

const WS_DISABLED: u32 = 0x0800_0000;
const WS_EX_TOPMOST: u32 = 0x0000_0008;
const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
const WS_EX_LAYERED: u32 = 0x0008_0000;
const WS_EX_NOACTIVATE: u32 = 0x0800_0000;

/// The windows a click at a point lands on: the window there, its root and its root owner
/// (`None` for one whose styles could not be read; the root owner is absent when it is the root).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ClickedWindows {
    pub(crate) leaf: Option<WindowStyles>,
    pub(crate) root: Option<WindowStyles>,
    pub(crate) root_owner: Option<Option<WindowStyles>>,
}

/// Whether a click on these windows may leave the window in front where it is. Narrow on doubt:
/// a style that cannot be read counts as may. An ordinary window takes the foreground when
/// clicked; one that says it does not (`WS_EX_NOACTIVATE` on any of them: on-screen and touch
/// keyboards, IME candidate windows, floating palettes), a tool window, a disabled root (a
/// modal's owner) and a layered topmost root (overlays, input panels) may not.
pub(crate) fn may_not_take_foreground(windows: &ClickedWindows) -> bool {
    let (Some(leaf), Some(root)) = (windows.leaf, windows.root) else {
        return true;
    };
    let owner = match windows.root_owner {
        Some(None) => return true,
        Some(Some(owner)) => Some(owner),
        None => None,
    };
    let no_activate = [Some(leaf), Some(root), owner]
        .into_iter()
        .flatten()
        .any(|window| window.ex_style & WS_EX_NOACTIVATE != 0);
    no_activate
        || root.ex_style & WS_EX_TOOLWINDOW != 0
        || root.style & WS_DISABLED != 0
        || (root.ex_style & WS_EX_TOPMOST != 0 && root.ex_style & WS_EX_LAYERED != 0)
}

/// The same question for an action on a part (a ref), read narrower than for a click at a point:
/// only a window that says it never takes the foreground (`WS_EX_NOACTIVATE` on the part's window,
/// its root or its root owner: on-screen and touch keyboards, IME candidate windows), or one whose
/// window or styles cannot be read. Tool windows, disabled and layered topmost roots are left out
/// here: the taskbar (`Shell_TrayWnd`, a topmost tool window) and the desktop (`Progman`, a tool
/// window) are among them, and pressing a taskbar button by its ref while Sprint Coder is in front
/// is ordinary use, which brings another app's window to the front.
pub(crate) fn part_window_may_not_take_foreground(windows: Option<&ClickedWindows>) -> bool {
    let Some(windows) = windows else {
        return true;
    };
    let (Some(leaf), Some(root)) = (windows.leaf, windows.root) else {
        return true;
    };
    let owner = match windows.root_owner {
        Some(None) => return true,
        Some(Some(owner)) => Some(owner),
        None => None,
    };
    [Some(leaf), Some(root), owner]
        .into_iter()
        .flatten()
        .any(|window| window.ex_style & WS_EX_NOACTIVATE != 0)
}

fn current_instance(pid: u32) -> Option<String> {
    crate::system::process_identity::token_for_pid(agent_desktop_core::ProcessId::from(pid))
        .ok()
        .flatten()
}

/// The error a refused operation returns: nothing was sent, and asking again does not help.
/// `target` says, for a pointer operation, which window refused it: the one at the point, or the
/// one in front that the input would reach instead.
pub(crate) fn refusal(
    operation: &'static str,
    verdict: Verdict,
    target: Option<&'static str>,
) -> Option<AdapterError> {
    let (kind, message) = match verdict {
        Verdict::Allowed => return None,
        Verdict::Own if target == Some("foreground") => (
            "own_window_refused",
            "Sprint Coder itself is the window in front, and this input could reach it instead of the window at the point; desktop control never operates Sprint Coder (with any permission or approval), so nothing was sent. Permissions and approvals in Sprint Coder are changed only by the user, on screen. To scroll a window behind it, use 'scroll' on a ref.",
        ),
        Verdict::Own => (
            "own_window_refused",
            "This window belongs to Sprint Coder itself, which desktop control never operates (with any permission or approval); nothing was sent. Permissions and approvals in Sprint Coder are changed only by the user, on screen.",
        ),
        Verdict::Unconfirmed => (
            "own_window_unconfirmed",
            "The owner of the target could not be read, so it could not be confirmed that it is not a Sprint Coder window, which desktop control never operates; nothing was sent.",
        ),
        Verdict::Unreadable => (
            "own_window_variable_unreadable",
            "SPRINT_CODER_DESKTOP_REFUSED_WINDOW_OWNER cannot be read, so no operation runs; nothing was sent.",
        ),
    };
    let mut details = json!({
        "kind": kind,
        "operation": operation,
        "physical_delivery_started": false,
        "retryable": false,
    });
    if let Some(target) = target {
        details["target"] = json!(target);
    }
    Some(
        AdapterError::new(ErrorCode::PolicyDenied, message)
            .with_details(details)
            .with_suggestion(OWN_WINDOW_SUGGESTION)
            .with_disposition(DeliverySemantics::not_delivered()),
    )
}

/// The suggestion of a refusal, also of one made part-way through a sequence.
pub(crate) const OWN_WINDOW_SUGGESTION: &str = "Do not try Sprint Coder's own windows again, by any route. If something there needs doing (a permission, an approval), ask the user to do it.";

/// Whether an error is one of these refusals.
pub(crate) fn is_own_window_refusal(error: &AdapterError) -> bool {
    error
        .details
        .as_ref()
        .and_then(|details| details["kind"].as_str())
        .is_some_and(|kind| kind.starts_with("own_window"))
}

/// A refusal made part-way through a sequence of inputs: those already sent (`sent` of them,
/// under `key`) went, so physical delivery had started; nothing after them is sent. The caller
/// folds in its delivery evidence (`ReleaseState::enrich_error`: delivered, unverified).
pub(crate) fn refused_part_way(mut error: AdapterError, key: &str, sent: usize) -> AdapterError {
    error.message = error.message.replace(
        "nothing was sent",
        "the inputs before this one were sent and nothing after them",
    );
    if let Some(details) = error.details.as_mut().and_then(|d| d.as_object_mut()) {
        details.insert("physical_delivery_started".into(), true.into());
        details.insert(key.into(), sent.into());
    }
    error
}

#[cfg(target_os = "windows")]
mod facts {
    use agent_desktop_core::{Deadline, Point, WindowInfo};
    use windows_sys::Win32::Foundation::{HWND, POINT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GA_ROOT, GA_ROOTOWNER, GetAncestor, GetForegroundWindow, WindowFromPoint,
    };

    use crate::tree::element::UIAElement;

    fn pid_of(window: HWND) -> Option<u32> {
        if window.is_null() {
            return None;
        }
        crate::system::window::window_identity::live_window_owner(window).map(u32::from)
    }

    /// The owners of a window, of its root and of its root owner.
    pub(crate) fn hwnd_owners(hwnd: isize) -> Vec<Option<u32>> {
        let window = hwnd as HWND;
        if window.is_null() {
            return vec![None];
        }
        let mut owners = vec![pid_of(window)];
        for flag in [GA_ROOT, GA_ROOTOWNER] {
            let ancestor = unsafe { GetAncestor(window, flag) };
            if !ancestor.is_null() && ancestor != window {
                owners.push(pid_of(ancestor));
            }
        }
        owners
    }

    fn coordinate(value: f64) -> i32 {
        if !value.is_finite() {
            return 0;
        }
        value.clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32
    }

    /// The owners of the window a pointer event at `point` reaches, at the pixel the point falls
    /// in and at the one it rounds to.
    pub(crate) fn point_owners(point: &Point) -> Vec<Option<u32>> {
        let mut owners = Vec::new();
        let mut seen = Vec::new();
        for (x, y) in [
            (point.x.floor(), point.y.floor()),
            (point.x.round(), point.y.round()),
        ] {
            let pixel = POINT {
                x: coordinate(x),
                y: coordinate(y),
            };
            if seen.contains(&(pixel.x, pixel.y)) {
                continue;
            }
            seen.push((pixel.x, pixel.y));
            let window = unsafe { WindowFromPoint(pixel) };
            owners.extend(hwnd_owners(window as isize));
        }
        owners
    }

    /// The owners of the window in front, where keys sent without a part go.
    pub(crate) fn foreground_owners() -> Vec<Option<u32>> {
        hwnd_owners(unsafe { GetForegroundWindow() } as isize)
    }

    fn styles(window: HWND) -> Option<super::WindowStyles> {
        use windows_sys::Win32::Foundation::{GetLastError, SetLastError};
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GWL_EXSTYLE, GWL_STYLE, GetWindowLongPtrW, IsWindow,
        };
        if window.is_null() || unsafe { IsWindow(window) } == 0 {
            return None;
        }
        let read = |index| {
            unsafe { SetLastError(0) };
            let value = unsafe { GetWindowLongPtrW(window, index) };
            (value != 0 || unsafe { GetLastError() } == 0).then_some(value as u32)
        };
        Some(super::WindowStyles {
            style: read(GWL_STYLE)?,
            ex_style: read(GWL_EXSTYLE)?,
        })
    }

    /// Whether a click at `point` may leave the window in front where it is
    /// (`super::may_not_take_foreground`), at the pixel the point falls in and at the one it
    /// rounds to; true when there is no window there to read.
    pub(crate) fn point_may_not_take_foreground(point: &Point) -> bool {
        [
            (point.x.floor(), point.y.floor()),
            (point.x.round(), point.y.round()),
        ]
        .into_iter()
        .any(|(x, y)| {
            let leaf = unsafe {
                WindowFromPoint(POINT {
                    x: coordinate(x),
                    y: coordinate(y),
                })
            };
            hwnd_may_not_take_foreground(leaf as isize)
        })
    }

    /// The styles of this window, of its root and of its root owner; `None` for no window.
    pub(crate) fn clicked_windows(hwnd: isize) -> Option<super::ClickedWindows> {
        let leaf = hwnd as HWND;
        if leaf.is_null() {
            return None;
        }
        let root = unsafe { GetAncestor(leaf, GA_ROOT) };
        let root = if root.is_null() { leaf } else { root };
        let owner = unsafe { GetAncestor(leaf, GA_ROOTOWNER) };
        Some(super::ClickedWindows {
            leaf: styles(leaf),
            root: styles(root),
            root_owner: (!owner.is_null() && owner != root).then(|| styles(owner)),
        })
    }

    /// The same for a click on this window: read from it, its root and its root owner.
    pub(crate) fn hwnd_may_not_take_foreground(hwnd: isize) -> bool {
        clicked_windows(hwnd).is_none_or(|windows| super::may_not_take_foreground(&windows))
    }

    /// Whether an action on this part may leave the window in front where it is
    /// (`super::part_window_may_not_take_foreground`), read from the first window it lives in.
    pub(crate) fn element_window_may_not_take_foreground(
        element: &UIAElement,
        deadline: Deadline,
    ) -> bool {
        let window = crate::actions::list_item_click::read_element_window(element, deadline)
            .hwnd
            .and_then(clicked_windows);
        super::part_window_may_not_take_foreground(window.as_ref())
    }

    /// The owners of a listed window: the pid it was listed with and the live owner of its handle.
    pub(crate) fn window_owners(window: &WindowInfo) -> Vec<Option<u32>> {
        let mut owners = vec![Some(u32::from(window.pid))];
        if let Ok(hwnd) = crate::system::window::window_ops::parse_window_id(&window.id) {
            owners.extend(hwnd_owners(hwnd));
        }
        owners
    }

    /// The owners of a part: the process its resolution verified, the process UI Automation
    /// reports for it now, and the owners of the first window it lives in.
    pub(crate) fn element_owners(element: &UIAElement, deadline: Deadline) -> Vec<Option<u32>> {
        let mut owners = vec![element.verified_process().map(|(pid, _)| pid)];
        let reported = crate::tree::automation::automation_client()
            .ok()
            .and_then(|client| {
                crate::tree::walk::walker_source::with_transaction_timeout(
                    &client,
                    deadline,
                    || element.0.get_process_id().ok(),
                )
                .flatten()
            })
            .filter(|pid| *pid != 0);
        owners.push(reported);
        if let Some(hwnd) =
            crate::actions::list_item_click::read_element_window(element, deadline).hwnd
        {
            owners.extend(hwnd_owners(hwnd));
        }
        owners
    }
}

#[cfg(not(target_os = "windows"))]
mod facts {
    use agent_desktop_core::{Deadline, Point, WindowInfo};

    use crate::tree::element::UIAElement;

    pub(crate) fn point_owners(_point: &Point) -> Vec<Option<u32>> {
        Vec::new()
    }

    pub(crate) fn foreground_owners() -> Vec<Option<u32>> {
        Vec::new()
    }

    pub(crate) fn point_may_not_take_foreground(_point: &Point) -> bool {
        true
    }

    pub(crate) fn window_owners(window: &WindowInfo) -> Vec<Option<u32>> {
        vec![Some(u32::from(window.pid))]
    }

    pub(crate) fn element_owners(_element: &UIAElement, _deadline: Deadline) -> Vec<Option<u32>> {
        Vec::new()
    }

    pub(crate) fn element_window_may_not_take_foreground(
        _element: &UIAElement,
        _deadline: Deadline,
    ) -> bool {
        true
    }
}

pub(crate) use facts::{element_owners, element_window_may_not_take_foreground, window_owners};
#[cfg(all(test, target_os = "windows"))]
pub(crate) use facts::{hwnd_may_not_take_foreground, hwnd_owners};

/// The facts a test puts in place of the desktop's for pointer operations on this thread.
#[cfg(test)]
pub(crate) mod fake {
    use std::cell::RefCell;

    #[derive(Clone, Debug, Default)]
    pub(crate) struct PointerFacts {
        pub(crate) point: Vec<Option<u32>>,
        pub(crate) foreground: Vec<Option<u32>>,
        pub(crate) may_not_take_foreground: bool,
        /// What the window at the point reads on the second, third... read (the first is
        /// `point`); past its end, the last of them (or `point`). A window that changes part-way
        /// through a sequence of inputs.
        pub(crate) later_points: Vec<Vec<Option<u32>>>,
    }

    thread_local! {
        static FACTS: RefCell<Option<PointerFacts>> = const { RefCell::new(None) };
        static POINT_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    }

    /// Runs `body` with `facts` in place of the desktop's.
    pub(crate) fn with<T>(facts: PointerFacts, body: impl FnOnce() -> T) -> T {
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) {
                FACTS.with(|cell| *cell.borrow_mut() = None);
            }
        }
        FACTS.with(|cell| *cell.borrow_mut() = Some(facts));
        POINT_READS.with(|reads| reads.set(0));
        let _reset = Reset;
        body()
    }

    pub(crate) fn get() -> Option<PointerFacts> {
        FACTS.with(|cell| cell.borrow().clone())
    }

    /// The window at the point for this read.
    pub(crate) fn point(facts: &PointerFacts) -> Vec<Option<u32>> {
        let read = POINT_READS.with(|reads| reads.replace(reads.get() + 1));
        if read == 0 || facts.later_points.is_empty() {
            return facts.point.clone();
        }
        facts.later_points[(read - 1).min(facts.later_points.len() - 1)].clone()
    }
}

/// The owners of the window a pointer event at `point` reaches.
pub(crate) fn point_owners(point: &agent_desktop_core::Point) -> Vec<Option<u32>> {
    #[cfg(test)]
    if let Some(facts) = fake::get() {
        return fake::point(&facts);
    }
    facts::point_owners(point)
}

/// What the adapter is doing on this thread while one of its operations sends a sequence of
/// inputs, so the sequence judges each later input again (`recheck_pointer`).
struct Acting {
    owner: RefusedWindowOwner,
    operation: &'static str,
}

thread_local! {
    static ACTING: std::cell::RefCell<Option<Acting>> = const { std::cell::RefCell::new(None) };
}

/// Runs `body` (one operation of the adapter) with `owner` and `operation` in place for
/// `recheck_pointer`, and puts back what was there before.
pub(crate) fn while_acting<T>(
    owner: &RefusedWindowOwner,
    operation: &'static str,
    body: impl FnOnce() -> T,
) -> T {
    struct Restore(Option<Acting>);
    impl Drop for Restore {
        fn drop(&mut self) {
            let previous = self.0.take();
            ACTING.with(|cell| *cell.borrow_mut() = previous);
        }
    }
    let previous = ACTING.with(|cell| {
        cell.borrow_mut().replace(Acting {
            owner: owner.clone(),
            operation,
        })
    });
    let _restore = Restore(previous);
    body()
}

/// Judges a later input of a sequence at `point` the way the operation's first input was judged
/// (`RefusedWindowOwner::check_pointer`), just before it is sent: an earlier input can change what
/// is there (a click that closes the window at the point leaves the one behind it there). Nothing
/// is refused outside an operation of the adapter.
pub(crate) fn recheck_pointer(
    point: &agent_desktop_core::Point,
    reaches_front: bool,
) -> Result<(), AdapterError> {
    let acting = ACTING.with(|cell| {
        cell.borrow()
            .as_ref()
            .map(|acting| (acting.owner.clone(), acting.operation))
    });
    match acting {
        Some((owner, operation)) => owner.check_pointer(operation, &[point], reaches_front),
        None => Ok(()),
    }
}

/// The owners of the window in front.
pub(crate) fn foreground_owners() -> Vec<Option<u32>> {
    #[cfg(test)]
    if let Some(facts) = fake::get() {
        return facts.foreground;
    }
    facts::foreground_owners()
}

/// Whether a click at `point` may leave the window in front where it is.
pub(crate) fn point_may_not_take_foreground(point: &agent_desktop_core::Point) -> bool {
    #[cfg(test)]
    if let Some(facts) = fake::get() {
        return facts.may_not_take_foreground;
    }
    facts::point_may_not_take_foreground(point)
}

/// The owners of what a handle names: the part, or for the empty handle (keys sent without a
/// part) the window in front. `None` for a handle that is not a part at all, which the action
/// itself refuses without sending anything.
pub(crate) fn handle_owners(
    handle: &agent_desktop_core::NativeHandle,
    deadline: agent_desktop_core::Deadline,
) -> Option<Vec<Option<u32>>> {
    if handle.is_null() {
        return Some(foreground_owners());
    }
    crate::tree::element::uia_element(handle)
        .ok()
        .map(|element| element_owners(element, deadline))
}

/// Whether an action on what a handle names may leave the window in front where it is, so what
/// it makes (an on-screen keyboard's key) reaches that window: for a part, when the window it
/// lives in may not take the foreground (`part_window_may_not_take_foreground`). The empty handle
/// is judged by the window in front already (`handle_owners`), and a handle that is not a part is
/// refused by the action itself.
pub(crate) fn handle_may_leave_front(
    handle: &agent_desktop_core::NativeHandle,
    deadline: agent_desktop_core::Deadline,
) -> bool {
    if handle.is_null() {
        return false;
    }
    crate::tree::element::uia_element(handle)
        .ok()
        .is_some_and(|element| element_window_may_not_take_foreground(element, deadline))
}

impl RefusedWindowOwner {
    /// Refuses an action on a part when Sprint Coder is in front and the part's window may not
    /// take the foreground (`handle_may_leave_front`); read only when something is refused.
    pub(crate) fn check_front_for_part(
        &self,
        operation: &'static str,
        handle: &agent_desktop_core::NativeHandle,
        deadline: agent_desktop_core::Deadline,
    ) -> Result<(), AdapterError> {
        if !self.is_active() || !handle_may_leave_front(handle, deadline) {
            return Ok(());
        }
        self.check_front(operation)
    }

    /// The same for a command run in a listed window's menu (`run_menu_command`), by that window.
    pub(crate) fn check_front_for_window(
        &self,
        operation: &'static str,
        window: &agent_desktop_core::WindowInfo,
    ) -> Result<(), AdapterError> {
        if !self.is_active() || !window_may_leave_front(window) {
            return Ok(());
        }
        self.check_front(operation)
    }

    fn check_front(&self, operation: &'static str) -> Result<(), AdapterError> {
        let front = foreground_owners();
        refusal(
            operation,
            self.judge(&front, current_instance),
            Some("foreground"),
        )
        .map_or(Ok(()), Err)
    }
}

fn window_may_leave_front(window: &agent_desktop_core::WindowInfo) -> bool {
    #[cfg(target_os = "windows")]
    {
        let windows = crate::system::window::window_ops::parse_window_id(&window.id)
            .ok()
            .and_then(facts::clicked_windows);
        part_window_may_not_take_foreground(windows.as_ref())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
        true
    }
}

#[cfg(test)]
#[path = "own_window_tests.rs"]
mod tests;
