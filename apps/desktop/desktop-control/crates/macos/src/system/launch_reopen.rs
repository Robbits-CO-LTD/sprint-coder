// Changed by Sprint Coder (new file); see VENDORED.md in apps/desktop/desktop-control.
//! A running app with no window: many macOS apps keep running after their last window was
//! closed (TextEdit, Preview, Mail, Notes), and show a window again only when asked to reopen,
//! as a click on their Dock icon asks. `launch` without `--activate` asks such an app once,
//! through the same open a background launch uses (never activating), and then waits for a
//! window as a fresh launch does. It does not ask an app with a minimized window (the request
//! would restore it, changing the user's window layout), nor when that cannot be told.

use agent_desktop_core::{AdapterError, WindowlessReason, system::launch_options::LaunchOptions};

/// Whether the app has a minimized window, as its accessibility windows read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Minimized {
    /// Every window was read and identified, and none is minimized (or there is none).
    None,
    /// A window is minimized.
    Some,
    /// The windows could not all be read, or one did not answer whether it is minimized.
    Unknown,
}

/// What a launch did for a running app that had no window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Reopen {
    /// The app was not asked to open a window; `minimized` when that is why.
    NotSent { minimized: bool },
    /// The app was asked once; `waited` is false for a zero timeout, which does not wait.
    Sent { waited: bool },
}

/// The suggestion of a launch whose running app showed a window after it was asked to.
pub(crate) const REOPENED_WINDOW: &str = "The app was running without a window, so this launch \
     asked it to open one, the way a click on its Dock icon does, without bringing it to the \
     front. `window` is the window it then showed: the app showed no window before, so it is \
     not a window the user was using. Check `window.is_focused` before telling the user where it \
     opened. Do not repeat the launch.";

/// The suggestion of a launch whose running app showed no window after it was asked to.
pub(crate) const REOPENED_NO_WINDOW: &str = "The app is running, and this launch asked it to \
     open a window (the way a click on its Dock icon does, without bringing it to the front), \
     but no window appeared. Waiting will not help, and repeating the launch will not either: \
     do not retry it in a loop. Tell the user that the app is running without a window. With \
     the user's agreement, `launch` with `--activate` brings the app to the front, which may \
     make it open a window.";

/// The suggestion of a launch with a zero timeout whose running app was asked for a window.
pub(crate) const REOPENED_NOT_WAITED: &str = "The app was running without a window, and this \
     launch asked it to open one (without bringing it to the front), but did not wait for it \
     because the timeout is 0. Run `list-windows` for the app once to see whether a window \
     appeared; do not repeat the launch. If none appeared, tell the user.";

/// The suggestion of a launch whose running app has only a minimized window.
pub(crate) const MINIMIZED_NOT_REOPENED: &str = "The app is running and shows no window, but it \
     has a minimized window, so this launch did not ask it to open one: that would restore the \
     minimized window and change the user's window layout. Do not restore it on your own. Tell \
     the user; with their agreement, `launch` with `--activate` brings the app and that window \
     to the front.";

/// The suggestion of a launch whose running app shows no window and was not asked for one.
pub(crate) const NOT_REOPENED: &str = "The app is running but shows no window, and this launch \
     did not ask it to open one: it is not an app with a Dock icon, or its windows could not \
     all be read. Waiting will not help: do not repeat the launch or retry it in a loop. Tell \
     the user; with their agreement, `launch` with `--activate` brings the app to the front.";

/// The `details.kind` of a running app that shows no window at all.
pub(crate) const NO_WINDOW_KIND: &str = "app_running_without_window";

/// The suggestion of `snapshot --app` and `list-windows --app` for a running app that shows no
/// window at all (no window on screen, none minimized, none on another Space).
pub(crate) const NO_WINDOW_GUIDANCE: &str = "Waiting will not make one appear: many apps keep \
     running after their last window was closed. Run `launch` once with the same app name: it \
     asks the app to open a window without bringing it to the front. If that returns no \
     window, or a `launch` of this app already returned none, do not run it again: tell the \
     user.";

/// Whether the app has a minimized window, from the `AXMinimized` of each accessibility window
/// (`None` where a window did not answer) and whether every window was read (`complete`).
pub(crate) fn minimized_from(
    states: impl IntoIterator<Item = Option<bool>>,
    complete: bool,
) -> Minimized {
    if !complete {
        return Minimized::Unknown;
    }
    let mut unknown = false;
    for state in states {
        match state {
            Some(true) => return Minimized::Some,
            Some(false) => {}
            None => unknown = true,
        }
    }
    if unknown {
        Minimized::Unknown
    } else {
        Minimized::None
    }
}

/// Whether an attaching launch of a running app asks it to open a window: only when it has no
/// usable window (`has_window` is false), for a plain attach (not `--activate`, not `--no-attach` or `--url`, which never attach, and
/// with no bundle id limit), of a regular app (one with a Dock icon, whose click this mirrors),
/// proven to have no minimized window. `minimized` is read only when everything else allows it.
pub(crate) fn may_reopen(
    options: &LaunchOptions,
    has_window: bool,
    regular: bool,
    minimized: impl FnOnce() -> Minimized,
) -> Result<(), Reopen> {
    if has_window
        || !options.attach_if_running
        || options.activate
        || !options.bundle_ids.is_empty()
        || !regular
    {
        return Err(Reopen::NotSent { minimized: false });
    }
    match minimized() {
        Minimized::None => Ok(()),
        Minimized::Some => Err(Reopen::NotSent { minimized: true }),
        Minimized::Unknown => Err(Reopen::NotSent { minimized: false }),
    }
}

/// The options of the open that asks a running app for a window: the request a click on the
/// Dock icon sends, never activating and never a new instance, with nothing the caller added.
pub(crate) fn reopen_options(options: &LaunchOptions) -> LaunchOptions {
    LaunchOptions {
        timeout_ms: options.timeout_ms,
        attach_if_running: true,
        activate: false,
        ..LaunchOptions::default()
    }
}

/// Asks the app for a window at most once (`send`, only when `allowed`), then looks for it
/// (`wait`, which waits only when `waits`): the window, if one came, and what was done.
pub(crate) fn reopen_once<W>(
    allowed: Result<(), Reopen>,
    waits: bool,
    send: impl FnOnce() -> Result<(), AdapterError>,
    wait: impl FnOnce() -> Result<Option<W>, AdapterError>,
) -> Result<(Option<W>, Reopen), AdapterError> {
    if let Err(not_sent) = allowed {
        return Ok((None, not_sent));
    }
    send()?;
    Ok((wait()?, Reopen::Sent { waited: waits }))
}

/// The suggestion of a launch for what was done, when it has a window (`has_window`) or none
/// and no other explanation (the other-Space one is given before this).
pub(crate) fn reopen_suggestion(reopen: Reopen, has_window: bool) -> Option<&'static str> {
    match (reopen, has_window) {
        (Reopen::Sent { .. }, true) => Some(REOPENED_WINDOW),
        (_, true) => None,
        (Reopen::Sent { waited: true }, false) => Some(REOPENED_NO_WINDOW),
        (Reopen::Sent { waited: false }, false) => Some(REOPENED_NOT_WAITED),
        (Reopen::NotSent { minimized: true }, false) => Some(MINIMIZED_NOT_REOPENED),
        (Reopen::NotSent { minimized: false }, false) => Some(NOT_REOPENED),
    }
}

/// The reason a running regular app `app` (process `pid`) lists no window at all.
pub(crate) fn no_window_reason(app: &str, pid: i32) -> WindowlessReason {
    WindowlessReason {
        message: format!("Application '{app}' is running but shows no window."),
        suggestion: NO_WINDOW_GUIDANCE.to_owned(),
        details: serde_json::json!({ "kind": NO_WINDOW_KIND, "pid": pid }),
    }
}

/// The process to explain: the only process of the app, when it is a regular app and it is
/// read (`shows_window`) to show no window on screen.
pub(crate) fn single_windowless_regular(
    pids: &[(i32, bool)],
    shows_window: impl FnOnce(i32) -> Option<bool>,
) -> Option<i32> {
    match pids {
        [(pid, true)] if shows_window(*pid) == Some(false) => Some(*pid),
        _ => None,
    }
}

/// The reason of `snapshot --app` and `list-windows --app` for a running app with no window,
/// when it is not the other-Space case: only for an app with exactly one process, a regular one
/// that shows no window on screen.
#[cfg(target_os = "macos")]
pub(crate) fn reason_for_app(app: &str, deadline: std::time::Instant) -> Option<WindowlessReason> {
    let owners = crate::system::app::workspace_apps::window_owner_snapshot_until(deadline).ok()?;
    let pids = owners
        .matching_pids(app)
        .into_iter()
        .map(|pid| {
            let regular = owners.owner(pid).is_some_and(|owner| {
                owner.activation_policy
                    == crate::system::app::workspace_apps::ActivationPolicy::Regular
            });
            (pid, regular)
        })
        .collect::<Vec<_>>();
    single_windowless_regular(&pids, |pid| {
        let records = crate::system::window::cg_window::window_records_until(
            deadline,
            crate::system::window::cg_window::WindowRecordScope::Pid(pid),
        )
        .ok()?;
        Some(records.iter().any(|record| {
            record.window_number > 0
                && super::launch::counts_as_shown(
                    record.visible,
                    record.bounds.width,
                    record.bounds.height,
                )
        }))
    })
    .map(|pid| no_window_reason(app, pid))
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn reason_for_app(
    _app: &str,
    _deadline: std::time::Instant,
) -> Option<WindowlessReason> {
    None
}

/// Whether the process `pid` has a minimized window, read from its accessibility windows.
#[cfg(target_os = "macos")]
pub(crate) fn read_minimized(pid: i32, deadline: std::time::Instant) -> Minimized {
    let app = crate::tree::element_for_pid(pid);
    let (listed, complete) =
        crate::system::window::other_space::read_accessibility_windows(&app, deadline);
    minimized_from(listed.into_values(), complete)
}

#[cfg(test)]
#[path = "launch_reopen_tests.rs"]
mod tests;
