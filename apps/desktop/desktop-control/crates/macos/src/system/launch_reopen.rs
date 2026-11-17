// Changed by Sprint Coder (new file); see VENDORED.md in apps/desktop/desktop-control.
//! A running app with no window: many macOS apps keep running after their last window was
//! closed (TextEdit, Preview, Mail, Notes), and show a window again only when asked to reopen,
//! as a click on their Dock icon asks. `launch` without `--activate` asks such an app once,
//! through the same open a background launch uses (never activating), and then waits for a
//! window as a fresh launch does, while `launch_front` watches the front: the app may bring
//! itself forward when it answers. It does not ask a hidden app, nor one with a minimized window
//! (the request could unhide it or restore that window, changing the user's window layout), nor
//! when that cannot be told.

use agent_desktop_core::{
    AdapterError, ErrorCode, WindowlessReason, system::launch_options::LaunchOptions,
};

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

/// Why a running app without a window was not asked for one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NotSent {
    /// Not a plain attach of a regular app (one with a Dock icon): said nothing, as before.
    NotAsked,
    /// The app is hidden (`AXHidden`).
    Hidden,
    /// The app has a minimized window.
    Minimized,
    /// Whether it is hidden, its windows, or whether one is minimized could not be read.
    Unknown,
    /// The launch was told not to wait (`--timeout 0`), so it could not watch the front.
    ZeroTimeout,
}

/// What a launch did for a running app that had no window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Reopen {
    NotSent(NotSent),
    /// The app was asked once.
    Sent,
}

/// The suggestion of a launch whose running app showed a window after it was asked to.
pub(crate) const REOPENED_WINDOW: &str = "The app was running without a window, so this launch \
     asked it to open one, the way a click on its Dock icon does, without bringing it to the \
     front. The app showed no window before this launch and showed `window` in answer. It may \
     be a window the app had kept, with the user's content in it: treat what is in it as the \
     user's and do only what the user asked. Check `window.is_focused` before telling the user \
     where it opened. Do not repeat the launch.";

/// The suggestion of a launch whose running app showed no window after it was asked to.
pub(crate) const REOPENED_NO_WINDOW: &str = "The app is running, and this launch asked it to \
     open a window (the way a click on its Dock icon does, without bringing it to the front), \
     but no window appeared. Waiting will not help, and repeating the launch will not either: \
     do not retry it in a loop. Tell the user that the app is running without a window. With \
     the user's agreement, `launch` with `--activate` brings the app to the front, which may \
     make it open a window.";

/// The suggestion of a launch with a zero timeout of a running app without a window.
pub(crate) const ZERO_TIMEOUT_NOT_REOPENED: &str = "The app is running but shows no window, and \
     this launch did not ask it to open one because the timeout is 0: without waiting it could \
     not watch whether the app brings itself to the front in answer. Run `launch` again once \
     with the same app name and without `--timeout 0`.";

/// Said first in the suggestion of an error that came after the app was asked for a window.
pub(crate) const ASKED_BEFORE_ERROR: &str = "This launch had already asked the running app to \
     open a window (without bringing it to the front) when this failed. Do not repeat the \
     launch: run `list-windows` for the app first.";

/// The suggestion of a launch whose running app has only a minimized window.
pub(crate) const MINIMIZED_NOT_REOPENED: &str = "The app is running and shows no window, but it \
     has a minimized window, so this launch did not ask it to open one: that would restore the \
     minimized window and change the user's window layout. Do not restore it on your own. Tell \
     the user; with their agreement, `launch` with `--activate` brings the app and that window \
     to the front.";

/// The suggestion of a launch whose running app is hidden.
pub(crate) const HIDDEN_NOT_REOPENED: &str = "The app is running but hidden (as with Cmd+H) and \
     shows no window, so this launch did not ask it to open one: that could unhide it and \
     change the user's window layout. Do not unhide it on your own, and do not repeat the \
     launch. Tell the user; with their agreement, `launch` with `--activate` brings the app to \
     the front.";

/// The suggestion of a launch that could not tell whether asking the app for a window is safe.
pub(crate) const NOT_REOPENED: &str = "The app is running but shows no window, and this launch \
     did not ask it to open one: whether the app is hidden, or whether it has a minimized \
     window, could not be read. Waiting will not help: do not repeat the launch or retry it in \
     a loop. Tell the user; with their agreement, `launch` with `--activate` brings the app to \
     the front.";

/// The `details.kind` of a running app that shows no window at all.
pub(crate) const NO_WINDOW_KIND: &str = "app_running_without_window";

/// The `details.kind` of a running hidden app that shows no window.
pub(crate) const HIDDEN_KIND: &str = "app_hidden_without_window";

/// The suggestion of `snapshot --app` and `list-windows --app` for a running app that shows no
/// window at all (no window on screen, none minimized, none on another Space, not hidden).
pub(crate) const NO_WINDOW_GUIDANCE: &str = "Waiting will not make one appear: many apps keep \
     running after their last window was closed. Run `launch` once with the same app name: it \
     asks the app to open a window without bringing it to the front. If that returns no \
     window, or a `launch` of this app already returned none, do not run it again: tell the \
     user.";

/// The suggestion of `snapshot --app` and `list-windows --app` for a hidden app with no window.
pub(crate) const HIDDEN_GUIDANCE: &str = "Waiting will not make one appear, and `launch` does not \
     ask a hidden app for a window. Do not unhide it on your own. Tell the user; with their \
     agreement, `launch` with `--activate` brings the app to the front.";

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
/// usable window (`has_window` is false), for a plain attach (not `--activate`, not
/// `--no-attach` or `--url`, which never attach, and with no bundle id limit), of a regular app
/// (one with a Dock icon, whose click this mirrors), read to be not hidden (`hidden`, `AXHidden`;
/// `None` when it cannot be read) and proven to have no minimized window. `hidden` and
/// `minimized` are read only when everything before them allows the request.
pub(crate) fn may_reopen(
    options: &LaunchOptions,
    has_window: bool,
    regular: bool,
    hidden: impl FnOnce() -> Option<bool>,
    minimized: impl FnOnce() -> Minimized,
) -> Result<(), NotSent> {
    if has_window
        || !options.attach_if_running
        || options.activate
        || !options.bundle_ids.is_empty()
        || !regular
    {
        return Err(NotSent::NotAsked);
    }
    // Without a wait, a front the app takes in answer could not be seen, let alone given back.
    if options.timeout_ms == 0 {
        return Err(NotSent::ZeroTimeout);
    }
    match hidden() {
        Some(false) => {}
        Some(true) => return Err(NotSent::Hidden),
        None => return Err(NotSent::Unknown),
    }
    match minimized() {
        Minimized::None => Ok(()),
        Minimized::Some => Err(NotSent::Minimized),
        Minimized::Unknown => Err(NotSent::Unknown),
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

/// The windows the app shows now, the baseline of the front's watch over the request: only
/// the shown ones, so a window the app kept off screen and shows again in answer counts as its
/// new window (a hand-off counts every window, since there the instance only shows its own new
/// one). `None` when they cannot be read.
pub(crate) fn shown_numbers(windows: Option<Vec<super::launch::WindowSeen>>) -> Option<Vec<i64>> {
    Some(
        windows?
            .into_iter()
            .filter(|window| window.shown)
            .map(|window| window.number)
            .collect(),
    )
}

/// The error `error` that came after the app was asked for a window, saying so first; its code
/// and everything else stay.
pub(crate) fn after_request(mut error: AdapterError) -> AdapterError {
    error.suggestion = Some(match error.suggestion.take() {
        Some(suggestion) => format!("{ASKED_BEFORE_ERROR} {suggestion}"),
        None => ASKED_BEFORE_ERROR.to_owned(),
    });
    error
}

/// What the open of the request returned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Opened {
    /// The instance that was running: it got the request.
    Same,
    /// Another process, while the instance that was running is gone: the app quit just before,
    /// and the open started it anew, as a launch of an app that does not run does.
    Fresh,
}

/// What the open of the request returned (`launched`), against the instance that was running
/// (`expected`); `runs` tells whether that instance still runs (`None` when it cannot be read,
/// taken as running). Another process while that instance may still run is an error that says
/// a new instance was started and is left running.
pub(crate) fn opened(
    expected: (i32, &str),
    launched: &(i32, String),
    runs: impl FnOnce() -> Option<bool>,
) -> Result<Opened, AdapterError> {
    if launched.0 == expected.0 && launched.1 == expected.1 {
        return Ok(Opened::Same);
    }
    if runs() == Some(false) {
        return Ok(Opened::Fresh);
    }
    Err(AdapterError::new(
        ErrorCode::AppUnresponsive,
        format!(
            "Asking the running app for a window started a new instance of it (pid {}) instead; \
             that new instance was not stopped and is still running",
            launched.0
        ),
    )
    .with_details(serde_json::json!({
        "expected_pid": expected.0,
        "returned_pid": launched.0,
        "complete": false,
        "kind": "reopen_started_new_instance",
    }))
    .with_suggestion(
        "Do not repeat the launch. Run `list-windows` for the app to see its windows, and tell \
         the user that a second instance of the app was started.",
    ))
}

/// The suggestion of a launch for what was done, when it has a window (`has_window`) or none
/// and no other explanation (the other-Space one is chosen before this, in `suggestion`).
pub(crate) fn reopen_suggestion(reopen: Reopen, has_window: bool) -> Option<&'static str> {
    match (reopen, has_window) {
        (Reopen::Sent, true) => Some(REOPENED_WINDOW),
        (Reopen::NotSent(_), true) => None,
        (Reopen::Sent, false) => Some(REOPENED_NO_WINDOW),
        (Reopen::NotSent(NotSent::ZeroTimeout), false) => Some(ZERO_TIMEOUT_NOT_REOPENED),
        (Reopen::NotSent(NotSent::Minimized), false) => Some(MINIMIZED_NOT_REOPENED),
        (Reopen::NotSent(NotSent::Hidden), false) => Some(HIDDEN_NOT_REOPENED),
        (Reopen::NotSent(NotSent::Unknown), false) => Some(NOT_REOPENED),
        (Reopen::NotSent(NotSent::NotAsked), false) => None,
    }
}

/// What the other-Space answer of a launch says first: that the app was asked for a window.
pub(crate) fn asked_prefix(reopen: Reopen) -> Option<&'static str> {
    match reopen {
        Reopen::Sent => Some(crate::system::window::other_space::ASKED_NO_WINDOW),
        Reopen::NotSent(_) => None,
    }
}

/// The suggestion of an attach to a running app without a usable window, from what was done
/// (`reopen`) and whether a window came: without one, the other-Space explanation when the app
/// has such windows (`other_space`, read only then: the numbers, `None` when not read), with the
/// asked sentence first; otherwise the text for what was done. For a Chromium app, core's hint
/// (which core adds only to a result without a suggestion) is appended to any such text.
pub(crate) fn suggestion(
    reopen: Reopen,
    has_window: bool,
    other_space: impl FnOnce() -> Option<Vec<i64>>,
    chromium: bool,
) -> Option<String> {
    let text = (!has_window)
        .then(other_space)
        .flatten()
        .and_then(|numbers| {
            crate::system::window::other_space::launch_suggestion(&numbers, asked_prefix(reopen))
        })
        .or_else(|| reopen_suggestion(reopen, has_window).map(str::to_owned))?;
    Some(if chromium {
        format!(
            "{text} {}",
            agent_desktop_core::commands::launch::CHROMIUM_CDP_HINT
        )
    } else {
        text
    })
}

/// The reason a running regular app `app` (process `pid`) that shows no window gives, from
/// whether it is hidden (`AXHidden`; `None` when that cannot be read, which names no reason).
pub(crate) fn windowless_reason(
    app: &str,
    pid: i32,
    hidden: Option<bool>,
) -> Option<WindowlessReason> {
    match hidden? {
        false => Some(WindowlessReason {
            message: format!("Application '{app}' is running but shows no window."),
            suggestion: NO_WINDOW_GUIDANCE.to_owned(),
            details: serde_json::json!({ "kind": NO_WINDOW_KIND, "pid": pid }),
        }),
        true => Some(WindowlessReason {
            message: format!(
                "Application '{app}' is running but hidden (as with Cmd+H), and shows no window."
            ),
            suggestion: HIDDEN_GUIDANCE.to_owned(),
            details: serde_json::json!({ "kind": HIDDEN_KIND, "pid": pid }),
        }),
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
/// that shows no window on screen, and whose `AXHidden` can be read.
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
    let pid = single_windowless_regular(&pids, |pid| {
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
    })?;
    windowless_reason(app, pid, read_hidden(pid, deadline))
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

/// The `AXHidden` of the app `pid`, or `None` when it cannot be read.
#[cfg(target_os = "macos")]
pub(crate) fn read_hidden(pid: i32, deadline: std::time::Instant) -> Option<bool> {
    crate::system::window::other_space::read_hidden(&crate::tree::element_for_pid(pid), deadline)
}

#[cfg(test)]
#[path = "launch_reopen_tests.rs"]
mod tests;
