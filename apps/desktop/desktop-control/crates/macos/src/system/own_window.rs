// Changed by Sprint Coder (new file); see VENDORED.md in apps/desktop/desktop-control.
//! Sprint Coder's windows are readable but never operated. The variable and verdicts
//! follow the Windows contract, including PID reuse and unreadable identities.
//! Adapter scopes cover nested actions and cleanup. Native mutation and input boundaries
//! re-read owners immediately before delivery, including each later input in a sequence.

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
        let verdict = if matches!(self, Self::Unreadable) {
            Verdict::Unreadable
        } else {
            self.judge(&owners(), current_instance)
        };
        refusal(operation, verdict, None).map_or(Ok(()), Err)
    }
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

fn current_instance(pid: u32) -> Option<String> {
    i32::try_from(pid).ok().and_then(|pid| {
        crate::system::process::process_identity::token_for_pid(pid)
            .ok()
            .flatten()
    })
}

#[derive(Clone)]
struct Acting {
    owner: RefusedWindowOwner,
    operation: &'static str,
}

thread_local! {
    static ACTING: std::cell::RefCell<Option<Acting>> = const { std::cell::RefCell::new(None) };
}

pub(crate) struct ActingScope {
    previous: Option<Acting>,
    _thread: std::marker::PhantomData<std::rc::Rc<()>>,
}

impl Drop for ActingScope {
    fn drop(&mut self) {
        ACTING.with(|cell| *cell.borrow_mut() = self.previous.take());
    }
}

pub(crate) fn enter(owner: &RefusedWindowOwner, operation: &'static str) -> ActingScope {
    let previous = ACTING.with(|cell| {
        cell.borrow_mut().replace(Acting {
            owner: owner.clone(),
            operation,
        })
    });
    ActingScope {
        previous,
        _thread: std::marker::PhantomData,
    }
}

fn check(owners: impl FnOnce() -> Vec<Option<u32>>) -> Result<(), AdapterError> {
    let acting = ACTING.with(|cell| cell.borrow().clone());
    match acting {
        Some(acting) => acting.owner.check(acting.operation, owners),
        None => Ok(()),
    }
}

pub(crate) fn check_pid(pid: Option<i32>) -> Result<(), AdapterError> {
    check(|| {
        vec![
            pid.and_then(|pid| u32::try_from(pid).ok())
                .filter(|pid| *pid > 0),
        ]
    })
}

pub(crate) fn check_variable() -> Result<(), AdapterError> {
    // A new launch has no target PID yet. Only the unreadable variable refuses it here.
    let acting = ACTING.with(|cell| cell.borrow().clone());
    if let Some(acting) = acting {
        if acting.owner == RefusedWindowOwner::Unreadable {
            return Err(refusal(acting.operation, Verdict::Unreadable, None)
                .unwrap_or_else(|| AdapterError::internal("Missing refusal")));
        }
    }
    Ok(())
}

pub(crate) fn check_named_app(
    identifier: &str,
    deadline: std::time::Instant,
) -> Result<(), AdapterError> {
    check(|| {
        let owner = crate::system::app::workspace_apps::window_owner_snapshot_until(deadline)
            .ok()
            .and_then(|snapshot| {
                let pids = snapshot.matching_pids(identifier);
                if pids.len() == 1 {
                    pids.into_iter().next()
                } else {
                    None
                }
            });
        vec![owner.and_then(|pid| u32::try_from(pid).ok())]
    })
}

pub(crate) fn check_front() -> Result<(), AdapterError> {
    check(|| vec![facts::frontmost_pid()])
}

pub(crate) fn check_key(pid: Option<i32>) -> Result<(), AdapterError> {
    match pid {
        Some(pid) => check_pid(Some(pid)),
        None => check_front(),
    }
}

pub(crate) fn check_point(point: &agent_desktop_core::Point) -> Result<(), AdapterError> {
    check(|| vec![facts::point_owner(point)])
}

pub(crate) fn check_window(window: &agent_desktop_core::WindowInfo) -> Result<(), AdapterError> {
    check(|| vec![facts::window_owner(&window.id)])
}

pub(crate) fn check_element(
    element: &crate::tree::AXElement,
    deadline: impl crate::tree::properties::ax_ipc::AxDeadline,
) -> Result<(), AdapterError> {
    check(|| vec![facts::element_owner(element, deadline)])
}

#[cfg(target_os = "macos")]
mod facts {
    use crate::tree::properties::cf_type::{borrowed_cf_dictionary, borrowed_cf_number};
    use core_foundation::{
        base::CFType, base::TCFType, dictionary::CFDictionary, string::CFString,
    };
    use core_graphics::display::CGDisplay;
    use core_graphics::window::{kCGWindowListOptionAll, kCGWindowListOptionOnScreenOnly};

    type Dictionary = CFDictionary<CFString, CFType>;

    fn number(dict: &Dictionary, key: &str) -> Option<f64> {
        let value = dict.find(CFString::new(key))?;
        borrowed_cf_number(value.as_concrete_TypeRef())?.to_f64()
    }

    fn pid(dict: &Dictionary) -> Option<u32> {
        let value = number(dict, "kCGWindowOwnerPID")?;
        (value.is_finite() && value > 0.0 && value <= i32::MAX as f64 && value.fract() == 0.0)
            .then_some(value as u32)
    }

    pub(super) fn window_owner(id: &str) -> Option<u32> {
        let id = id.strip_prefix("w-")?.parse::<u32>().ok()?;
        let windows = CGDisplay::window_list_info(kCGWindowListOptionAll, None)?;
        for raw in windows.get_all_values() {
            let dict = borrowed_cf_dictionary(raw as _)?;
            if number(&dict, "kCGWindowNumber")? == f64::from(id) {
                return pid(&dict);
            }
        }
        None
    }

    pub(super) fn point_owner(point: &agent_desktop_core::Point) -> Option<u32> {
        let windows = CGDisplay::window_list_info(kCGWindowListOptionOnScreenOnly, None)?;
        // CoreGraphics returns front-to-back order. Include every layer, including panels.
        for raw in windows.get_all_values() {
            let dict = borrowed_cf_dictionary(raw as _)?;
            let bounds = dict.find(CFString::new("kCGWindowBounds"))?;
            let bounds = borrowed_cf_dictionary(bounds.as_concrete_TypeRef())?;
            let rect = agent_desktop_core::Rect {
                x: number(&bounds, "X")?,
                y: number(&bounds, "Y")?,
                width: number(&bounds, "Width")?,
                height: number(&bounds, "Height")?,
            };
            if super::contains(&rect, point) {
                return pid(&dict);
            }
        }
        None
    }

    pub(super) fn frontmost_pid() -> Option<u32> {
        // Workspace reads require no Accessibility permission and cover apps without windows.
        let snapshot = crate::system::app::workspace_apps::window_owner_snapshot_until(
            std::time::Instant::now() + std::time::Duration::from_secs(1),
        )
        .ok()?;
        u32::try_from(snapshot.frontmost()?.pid).ok()
    }

    pub(super) fn element_owner(
        element: &crate::tree::AXElement,
        deadline: impl crate::tree::properties::ax_ipc::AxDeadline,
    ) -> Option<u32> {
        crate::tree::properties::ax_ipc::pid(element, deadline)
            .ok()
            .and_then(|pid| u32::try_from(pid).ok())
            .filter(|pid| *pid > 0)
    }
}

#[cfg(not(target_os = "macos"))]
mod facts {
    pub(super) fn frontmost_pid() -> Option<u32> {
        None
    }
    pub(super) fn point_owner(_: &agent_desktop_core::Point) -> Option<u32> {
        None
    }
    pub(super) fn window_owner(_: &str) -> Option<u32> {
        None
    }
    pub(super) fn element_owner(
        _: &crate::tree::AXElement,
        _: impl crate::tree::properties::ax_ipc::AxDeadline,
    ) -> Option<u32> {
        None
    }
}

fn contains(rect: &agent_desktop_core::Rect, point: &agent_desktop_core::Point) -> bool {
    [rect.x, rect.y, rect.width, rect.height, point.x, point.y]
        .iter()
        .all(|v| v.is_finite())
        && rect.width > 0.0
        && rect.height > 0.0
        && point.x >= rect.x
        && point.x < rect.x + rect.width
        && point.y >= rect.y
        && point.y < rect.y + rect.height
}

#[cfg(test)]
#[path = "own_window_tests.rs"]
mod tests;

pub(crate) fn is_refusal(error: &AdapterError) -> bool {
    error
        .details
        .as_ref()
        .and_then(|details| details["kind"].as_str())
        .is_some_and(|kind| kind.starts_with("own_window"))
}
