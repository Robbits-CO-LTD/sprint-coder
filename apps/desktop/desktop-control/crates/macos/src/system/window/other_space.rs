// Changed by Sprint Coder (new file); see VENDORED.md in apps/desktop/desktop-control.
//! A window that exists but cannot be read because it is, most likely, on a
//! Space the user is not on (for example while the user works in a full-screen
//! app). The window server still lists such a window, as off screen, but
//! accessibility does not show it to the app's window list until the user
//! returns to its Space. macOS has no public way to say which Space a window is
//! on, and a window the app closed but keeps reads the same way, so the two are
//! always named together as the possible causes, from what can be read:
//! the window is off screen, of a real size, and missing from the app's
//! accessibility windows, which were read in full; the app is not hidden; and
//! the window is not minimized (a minimized window and the windows of a hidden
//! app stay in that list).

use agent_desktop_core::{AdapterError, ErrorCode, WindowlessReason};

/// Smaller windows are an app's helper or status windows, never the window the
/// user would switch back to (the same size `launch` counts as a shown window).
const MIN_WINDOW_POINTS: f64 = 100.0;

/// The `details.possible_causes` value (nothing that can be read says which of the two it is),
/// and the `details.kind` of the app errors.
pub(crate) const POSSIBLE_CAUSES: [&str; 2] = ["other_space", "closed_but_kept"];
const APP_KIND: &str = "window_off_screen_not_exposed";

/// The two causes and what not to do, shared by every answer that names this cause.
macro_rules! causes {
    () => {
        "Either the window is on another Space, which macOS does not expose through \
         accessibility until the user returns to that Space (this happens while the user works \
         in a full-screen app), or the app has closed or hidden the window but keeps it. macOS \
         offers no public way to tell them apart. Do not retry in a tight loop, and do not \
         conclude that the app is broken. Do not activate the app on your own to reach the \
         window: on another Space that would switch the user away from what they are doing. "
    };
}

/// What to tell the user, the last part of every answer that names this cause.
macro_rules! tell_the_user {
    () => {
        "Tell the user what you found: a window on another Space becomes readable when they \
         return to it; if no window of the app is open on any Space, ask the user to open one, \
         or bring the app forward with their agreement (for example `launch` with `--activate`)."
    };
}

/// What to do before any `launch` (`snapshot --app`, `list-windows --app`, `--window-id`). A
/// window the app closed but keeps (or never showed) reads the same way, so it is named too, and
/// `launch` asks such an app to show it again (`launch_reopen`).
pub(crate) const GUIDANCE: &str = concat!(
    causes!(),
    "If `launch` has not been run for this app yet, run it once with the app's name: for an app \
     that only closed its window, it asks the app to show one without bringing it to the front; \
     for a window on another Space, it changes nothing. ",
    tell_the_user!()
);

/// What to do after a `launch`, which already asked the app for a window when it could.
pub(crate) const LAUNCH_GUIDANCE: &str = concat!(causes!(), tell_the_user!());

/// Said first in a `launch` result that asked the app for a window and saw none.
pub(crate) const ASKED_NO_WINDOW: &str = "This launch asked the app to open a window without \
     bringing it to the front, and none appeared.";

/// One window of the app as the window server and accessibility read it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct WindowSignals {
    pub(crate) number: i64,
    pub(crate) on_screen: bool,
    pub(crate) width: f64,
    pub(crate) height: f64,
    /// Listed in the app's accessibility windows.
    pub(crate) in_accessibility: bool,
    /// `AXMinimized`, when accessibility lists the window and answers.
    pub(crate) minimized: Option<bool>,
}

/// The app as the workspace and accessibility read it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AppSignals {
    /// A regular app (one with a Dock icon). Menu-bar and background apps keep
    /// windows they show only now and then, so theirs are never named.
    pub(crate) regular: bool,
    /// `AXHidden` of the app; `None` when it could not be read.
    pub(crate) hidden: Option<bool>,
    /// Whether every accessibility window of the app was read and identified,
    /// so a window missing from the list is really not in it.
    pub(crate) accessibility_complete: bool,
}

/// Whether `window` is, most likely, on a Space the user is not on.
pub(crate) fn likely_on_other_space(window: &WindowSignals, app: &AppSignals) -> bool {
    app.regular
        && app.hidden == Some(false)
        && app.accessibility_complete
        && !window.on_screen
        && !window.in_accessibility
        && window.minimized != Some(true)
        && window.width >= MIN_WINDOW_POINTS
        && window.height >= MIN_WINDOW_POINTS
}

/// The numbers of the windows that are, most likely, on another Space.
pub(crate) fn other_space_windows(windows: &[WindowSignals], app: &AppSignals) -> Vec<i64> {
    windows
        .iter()
        .filter(|window| likely_on_other_space(window, app))
        .map(|window| window.number)
        .collect()
}

/// Window ids in the form `list-windows` gives.
fn window_ids(numbers: &[i64]) -> Vec<String> {
    numbers.iter().map(|number| format!("w-{number}")).collect()
}

/// The reason a running app lists no usable window, when its windows are
/// probably on another Space; `None` when no window is.
pub(crate) fn app_reason(app: &str, pid: i32, numbers: &[i64]) -> Option<WindowlessReason> {
    if numbers.is_empty() {
        return None;
    }
    Some(WindowlessReason {
        message: format!(
            "Application '{app}' is running, but its window cannot be read now: the window \
             exists off screen and is not exposed through accessibility."
        ),
        suggestion: GUIDANCE.to_owned(),
        details: serde_json::json!({
            "kind": APP_KIND,
            "possible_causes": POSSIBLE_CAUSES,
            "pid": pid,
            "window_ids": window_ids(numbers),
        }),
    })
}

/// The suggestion of a `launch` whose app runs but whose window is probably on
/// another Space; `None` when no window is. `asked` is said first when the launch asked the app
/// for a window (`ASKED_NO_WINDOW`).
pub(crate) fn launch_suggestion(numbers: &[i64], asked: Option<&str>) -> Option<String> {
    (!numbers.is_empty()).then(|| {
        format!(
            "{}The app is running, but its window ({}) cannot be read now: it exists off screen \
             and is not exposed through accessibility. Do not repeat the launch. \
             {LAUNCH_GUIDANCE}",
            asked.map(|asked| format!("{asked} ")).unwrap_or_default(),
            window_ids(numbers).join(", ")
        )
    })
}

/// The error for a window asked for by id that exists but is probably on
/// another Space. Keeps the code and `details.kind` of a window without an
/// accessibility element, and adds the cause.
pub(crate) fn window_error(id: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionNotSupported,
        format!(
            "Window '{id}' exists but cannot be read now: it is off screen and not exposed \
             through accessibility"
        ),
    )
    .with_details(serde_json::json!({
        "kind": "window_without_accessibility_element",
        "window_id": id,
        "possible_causes": POSSIBLE_CAUSES,
    }))
    .with_suggestion(GUIDANCE)
}

/// The process to explain, from the windows each process of the app has that
/// are probably on another Space: only when exactly one process has any, since
/// with more the answer would have to pick one of them.
pub(crate) fn single_qualifying(
    found: impl IntoIterator<Item = (i32, Vec<i64>)>,
) -> Option<(i32, Vec<i64>)> {
    let mut found = found.into_iter().filter(|(_, numbers)| !numbers.is_empty());
    let first = found.next()?;
    found.next().is_none().then_some(first)
}

/// Reads the windows of `pid` that are probably on another Space. `None` when
/// what is needed could not be read, which names no cause.
#[cfg(target_os = "macos")]
pub(crate) fn read_for_pid(pid: i32, deadline: std::time::Instant) -> Option<Vec<i64>> {
    let owners = crate::system::app::workspace_apps::window_owner_snapshot_until(deadline).ok()?;
    read_for_owner(&owners, pid, deadline)
}

/// As `read_for_pid`, with the workspace snapshot already read.
#[cfg(target_os = "macos")]
fn read_for_owner(
    owners: &crate::system::app::workspace_apps::WindowOwnerSnapshot,
    pid: i32,
    deadline: std::time::Instant,
) -> Option<Vec<i64>> {
    let regular = owners.owner(pid).is_some_and(|owner| {
        owner.activation_policy == crate::system::app::workspace_apps::ActivationPolicy::Regular
    });
    if !regular {
        return Some(Vec::new());
    }
    let records = crate::system::window::cg_window::window_records_until(
        deadline,
        crate::system::window::cg_window::WindowRecordScope::Pid(pid),
    )
    .ok()?;
    if !records.iter().any(|record| !record.visible) {
        return Some(Vec::new());
    }
    let app = crate::tree::element_for_pid(pid);
    let (listed, accessibility_complete) = read_accessibility_windows(&app, deadline);
    let signals = AppSignals {
        regular,
        hidden: read_hidden(&app, deadline),
        accessibility_complete,
    };
    let windows = records
        .iter()
        .filter(|record| record.window_number > 0)
        .map(|record| WindowSignals {
            number: record.window_number,
            on_screen: record.visible,
            width: record.bounds.width,
            height: record.bounds.height,
            in_accessibility: listed.contains_key(&record.window_number),
            minimized: listed.get(&record.window_number).copied().flatten(),
        })
        .collect::<Vec<_>>();
    Some(other_space_windows(&windows, &signals))
}

/// The reason the running app `app` lists no usable window, when exactly one of
/// its processes has windows that are probably on another Space.
#[cfg(target_os = "macos")]
pub(crate) fn reason_for_app(app: &str, deadline: std::time::Instant) -> Option<WindowlessReason> {
    let owners = crate::system::app::workspace_apps::window_owner_snapshot_until(deadline).ok()?;
    let found = owners
        .matching_pids(app)
        .into_iter()
        .filter_map(|pid| Some((pid, read_for_owner(&owners, pid, deadline)?)));
    let (pid, numbers) = single_qualifying(found)?;
    app_reason(app, pid, &numbers)
}

#[cfg(target_os = "macos")]
pub(crate) fn read_hidden(
    app: &crate::tree::AXElement,
    deadline: std::time::Instant,
) -> Option<bool> {
    crate::tree::surface_read::boolean(app, "AXHidden", deadline)
        .ok()
        .flatten()
}

/// The app's accessibility windows by number, with `AXMinimized` when it
/// answers, and whether every window was read and identified.
#[cfg(target_os = "macos")]
pub(crate) fn read_accessibility_windows(
    app: &crate::tree::AXElement,
    deadline: std::time::Instant,
) -> (rustc_hash::FxHashMap<i64, Option<bool>>, bool) {
    let mut listed = rustc_hash::FxHashMap::default();
    let Ok(windows) = crate::tree::surface_read::elements(app, "AXWindows", deadline) else {
        return (listed, false);
    };
    for window in windows {
        match crate::system::window::window_resolve::ax_window_id_with_deadline(&window, deadline) {
            Ok(Some(number)) => {
                let minimized =
                    crate::tree::surface_read::boolean(&window, "AXMinimized", deadline)
                        .ok()
                        .flatten();
                listed.insert(number, minimized);
            }
            // A window that cannot be identified may be the one missing.
            Ok(None) | Err(_) => return (listed, false),
        }
    }
    (listed, true)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn reason_for_app(
    _app: &str,
    _deadline: std::time::Instant,
) -> Option<WindowlessReason> {
    None
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn read_for_pid(_pid: i32, _deadline: std::time::Instant) -> Option<Vec<i64>> {
    None
}

#[cfg(test)]
#[path = "other_space_tests.rs"]
mod tests;
