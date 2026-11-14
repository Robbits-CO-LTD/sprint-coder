// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! Source C of the menu detector: the Chromium/Electron DOM-menu arm.
//!
//! Measured on a real Chromium host (A26-12): its context menu is a DOM menu
//! rendered inside the application's own window - no native menu tracking
//! fires the classic flags, and the menu family surfaces under a non-tool
//! window, so the tool-window pool never sees it. The predicate probes the
//! pid's visible, uncloaked, non-iconic, non-tool, non-zero-sized root-level
//! windows for a `Menu`/`MenuItem` element whose `FrameworkId` is the
//! Chromium framework's - a framework-family gate, not an application name,
//! and the measured reason it exists is that a classic Win32 menu bar lives
//! under exactly the same candidate pool at rest with framework `Win32`. A
//! persistent Chromium-framework menu bar would carry this framework id too;
//! that shape was not measurable on the host the source was measured on (its
//! own menubar exposes no menu-family elements at rest), so it stays an
//! explicitly documented coverage bound rather than a claimed exclusion.

use agent_desktop_core::{AdapterError, Deadline, ProcessId};

use super::enumerate_top_level;

/// The framework token Chromium's UIA provider reports for its elements,
/// measured on the staged host (A26-12): the DOM menu's `Menu` and
/// `MenuItem` elements all read this framework id, while a Win32 menu bar
/// under the same candidate pool reads `Win32`.
#[cfg(target_os = "windows")]
const CHROMIUM_FRAMEWORK_ID: &str = "Chrome";

#[cfg(target_os = "windows")]
pub(super) fn chromium_dom_menu_reachable(
    pid: ProcessId,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    deadline.ensure_remaining()?;
    let candidates = chromium_menu_candidates(pid, deadline)?;
    if candidates.is_empty() {
        return Ok(false);
    }
    let client =
        crate::tree::automation::automation_client().map_err(super::narrow_to_permitted_codes)?;
    let condition = chromium_menu_condition(&client)?;
    for (index, handle) in candidates.into_iter().enumerate() {
        if index > 0 {
            deadline.ensure_remaining()?;
        }
        if super::probe_candidate(&client, &condition, handle)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Source C's locating variant, so the surface arm can root where the
/// detector fires. Without it a wait on `surface-appeared --surface menu`
/// against a Chromium application succeeded and the `snapshot --surface menu`
/// that followed answered `WINDOW_NOT_FOUND`, because only source B could
/// locate anything.
#[cfg(target_os = "windows")]
pub(super) fn locate_chromium_dom_menu(
    pid: ProcessId,
    deadline: Deadline,
) -> Result<Option<(uiautomation::UIElement, isize)>, AdapterError> {
    deadline.ensure_remaining()?;
    let candidates = chromium_menu_candidates(pid, deadline)?;
    if candidates.is_empty() {
        return Ok(None);
    }
    let client =
        crate::tree::automation::automation_client().map_err(super::narrow_to_permitted_codes)?;
    let condition = chromium_menu_condition(&client)?;
    for (index, handle) in candidates.into_iter().enumerate() {
        if index > 0 {
            deadline.ensure_remaining()?;
        }
        if let Some(element) = super::probe_candidate_element(&client, &condition, handle)? {
            return Ok(Some((element, handle)));
        }
    }
    Ok(None)
}

#[cfg(not(target_os = "windows"))]
pub(super) fn locate_chromium_dom_menu(
    _pid: ProcessId,
    deadline: Deadline,
) -> Result<Option<(uiautomation::UIElement, isize)>, AdapterError> {
    deadline.ensure_remaining()?;
    Ok(None)
}

#[cfg(not(target_os = "windows"))]
pub(super) fn chromium_dom_menu_reachable(
    _pid: ProcessId,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    deadline.ensure_remaining()?;
    Ok(false)
}

/// Source C's candidate pool: the mirror image of the tool-window pool
/// source B searches. Only windows actually presented to the user are probed,
/// because a menu the user cannot see cannot be open, which keeps hidden or
/// cloaked helper windows of the same pid from firing the predicate at rest.
///
/// A window confirmed to be a plain WPF window ([`searches_window`]) is left
/// out: the search runs over the whole window inside its process, and on a WPF
/// window holding a 2,000-row list it took about 5.6 s after every click to
/// find nothing. Every other window is searched as before, including one whose
/// framework could not be read in time.
#[cfg(target_os = "windows")]
fn chromium_menu_candidates(
    pid: ProcessId,
    deadline: Deadline,
) -> Result<Vec<isize>, AdapterError> {
    let mut handles = Vec::new();
    enumerate_top_level(|window| {
        if crate::system::window::window_identity::live_window_owner(window.handle) == Some(pid)
            && !window.tool
            && window.visible
            && !window.iconic
            && !window.cloaked
            && !window.is_zero_sized()
        {
            handles.push(window.handle as isize);
        }
        true
    })
    .map_err(super::narrow_to_permitted_codes)?;
    // Read after the enumeration, which must not be re-entered. The process
    // modules are listed once, and only for a WPF window.
    let hosts_web_runtime = std::cell::OnceCell::new();
    handles.retain(|handle| {
        searches_window(
            crate::tree::chromium::window_has_chromium_provenance(*handle),
            root_framework(*handle, deadline).as_deref(),
            || *hosts_web_runtime.get_or_init(|| process_may_host_web_content(pid)),
        )
    });
    Ok(handles)
}

/// The framework of the only windows Source C leaves out.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const WPF_FRAMEWORK: &str = "WPF";

/// The most the framework read of one candidate window may take.
#[cfg(target_os = "windows")]
const FRAMEWORK_READ_CAP: std::time::Duration = std::time::Duration::from_millis(500);

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
/// Whether Source C searches a candidate window. Only a window confirmed to
/// hold no Chromium content is left out, and only for a framework whose windows
/// were measured to need it: a window that is not of Chromium provenance by
/// its windows (`chromium`: its class, or a Chromium content window below it),
/// whose root reports the WPF framework, in a process that loaded no web
/// runtime (`hosts_web_runtime`, asked only then). Chromium can draw into a
/// window without a window of its own (WebView2 in composition mode, as WPF's
/// `WebView2CompositionControl` and WinUI 3 use, or CEF windowless), so a
/// window of any other framework, one whose framework could not be read
/// (`None`), and a WPF window of a process that loaded a web runtime are all
/// searched, as before.
fn searches_window(
    chromium: bool,
    framework: Option<&str>,
    hosts_web_runtime: impl FnOnce() -> bool,
) -> bool {
    chromium || framework != Some(WPF_FRAMEWORK) || hosts_web_runtime()
}

/// The UI Automation framework of a window's root, read within the deadline
/// and [`FRAMEWORK_READ_CAP`]; `None` when it could not be read in time.
#[cfg(target_os = "windows")]
fn root_framework(handle: isize, deadline: Deadline) -> Option<String> {
    let deadline = deadline.capped(FRAMEWORK_READ_CAP);
    let root = crate::tree::automation::root_from_hwnd(handle, deadline).ok()?;
    let client = crate::tree::automation::automation_client().ok()?;
    crate::tree::walk::walker_source::with_transaction_timeout(&client, deadline, || {
        root.0.get_framework_id().ok()
    })
    .flatten()
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
/// The module names of the runtimes that let a process draw Chromium web
/// content without a Chromium window of its own: WebView2 (its loader, the
/// .NET wrapper, and the browser module the host loads for any WebView2) and
/// CEF.
const WEB_RUNTIME_MODULES: [&str; 4] = [
    "embeddedbrowserwebview.dll",
    "webview2loader.dll",
    "microsoft.web.webview2.core.dll",
    "libcef.dll",
];

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
/// Whether `module` names a web runtime module ([`WEB_RUNTIME_MODULES`]),
/// ignoring case.
fn is_web_runtime_module(module: &str) -> bool {
    let module = module.trim().to_ascii_lowercase();
    WEB_RUNTIME_MODULES.contains(&module.as_str())
}

/// Whether the process has loaded a web runtime module, listed from a ToolHelp
/// snapshot of its modules (no message to the target). A list that cannot be
/// taken, or lists nothing, answers true: the window is then searched, as
/// before.
#[cfg(target_os = "windows")]
fn process_may_host_web_content(pid: ProcessId) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, MODULEENTRY32W, Module32FirstW, Module32NextW, TH32CS_SNAPMODULE,
        TH32CS_SNAPMODULE32,
    };
    // SAFETY: a snapshot of the pid's modules; the handle is closed below.
    let snapshot = unsafe {
        CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, u32::from(pid))
    };
    if snapshot == INVALID_HANDLE_VALUE {
        return true;
    }
    let mut entry = MODULEENTRY32W {
        dwSize: std::mem::size_of::<MODULEENTRY32W>() as u32,
        ..Default::default()
    };
    let mut found = false;
    let mut listed_any = false;
    // SAFETY: `entry` is sized as the API asks, and `snapshot` is live.
    let mut ok = unsafe { Module32FirstW(snapshot, &mut entry) };
    while ok != 0 {
        listed_any = true;
        let name = crate::system::process_identity::wide_buffer_to_string(&entry.szModule);
        if is_web_runtime_module(&name) {
            found = true;
            break;
        }
        // SAFETY: as above.
        ok = unsafe { Module32NextW(snapshot, &mut entry) };
    }
    // SAFETY: the snapshot handle this function opened.
    unsafe { CloseHandle(snapshot) };
    found || !listed_any
}

/// Source C's search: the menu family without `MenuBar` - a bar is not an
/// open menu - inside the Chromium framework. The `FrameworkId` gate is what
/// keeps the `MenuItem` half of the family from firing on a classic Win32
/// menu bar's own items, which live under the same visible non-tool windows
/// this source probes.
#[cfg(target_os = "windows")]
fn chromium_menu_condition(
    client: &uiautomation::UIAutomation,
) -> Result<uiautomation::core::UICondition, AdapterError> {
    use uiautomation::types::UIProperty;
    use uiautomation::variants::Variant;

    let framework_condition = client
        .create_property_condition(
            UIProperty::FrameworkId,
            Variant::from(CHROMIUM_FRAMEWORK_ID),
            None,
        )
        .map_err(|error| {
            super::narrow_to_permitted_codes(crate::tree::automation::uia_error(
                &error,
                "build the Chromium framework gate condition",
            ))
        })?;
    let menu_family_without_bar = menu_family_condition_without_bar(client)?;
    client
        .create_and_condition(framework_condition, menu_family_without_bar)
        .map_err(|error| {
            super::narrow_to_permitted_codes(crate::tree::automation::uia_error(
                &error,
                "combine the Chromium menu search condition",
            ))
        })
}

#[cfg(target_os = "windows")]
fn menu_family_condition_without_bar(
    client: &uiautomation::UIAutomation,
) -> Result<uiautomation::core::UICondition, AdapterError> {
    use uiautomation::types::ControlType;

    let menu = super::control_type_condition(client, ControlType::Menu)?;
    let menu_item = super::control_type_condition(client, ControlType::MenuItem)?;
    client
        .create_or_condition(menu, menu_item)
        .map_err(|error| {
            super::narrow_to_permitted_codes(crate::tree::automation::uia_error(
                &error,
                "combine the menu-family search condition",
            ))
        })
}

#[cfg(test)]
mod candidate_tests {
    use super::*;

    /// Only a WPF window confirmed to hold no Chromium content is left out:
    /// Chromium provenance, any other framework, an unread framework, and a
    /// process that loaded a web runtime are all searched, and the module
    /// list is not asked for unless it decides.
    #[test]
    fn only_a_plain_wpf_window_is_left_out_of_the_dom_menu_search() {
        let asked = std::cell::Cell::new(0);
        let runtime = |loaded: bool| {
            let asked = &asked;
            move || {
                asked.set(asked.get() + 1);
                loaded
            }
        };
        assert!(!searches_window(false, Some("WPF"), runtime(false)));
        assert!(searches_window(false, Some("WPF"), runtime(true)));
        assert_eq!(asked.get(), 2);
        for framework in [
            None,
            Some("Win32"),
            Some("WinForm"),
            Some("XAML"),
            Some("wpf"),
        ] {
            assert!(
                searches_window(false, framework, runtime(false)),
                "{framework:?}"
            );
        }
        assert!(searches_window(true, Some("WPF"), runtime(false)));
        assert_eq!(asked.get(), 2, "the modules are asked about only for WPF");
    }

    #[test]
    fn web_runtime_modules_are_matched_by_name_ignoring_case() {
        for module in [
            "EmbeddedBrowserWebView.dll",
            "WebView2Loader.dll",
            "Microsoft.Web.WebView2.Core.dll",
            "libcef.dll",
        ] {
            assert!(is_web_runtime_module(module), "{module}");
        }
        for other in ["PresentationFramework.dll", "webview2loader.dll.mui", ""] {
            assert!(!is_web_runtime_module(other), "{other}");
        }
    }

    /// This test process loads no web runtime, and its module list can be
    /// taken, so it reads as one that hosts no web content.
    #[cfg(target_os = "windows")]
    #[test]
    fn a_process_without_a_web_runtime_reads_as_hosting_none() {
        assert!(!process_may_host_web_content(ProcessId::new(
            std::process::id()
        )));
    }
}
