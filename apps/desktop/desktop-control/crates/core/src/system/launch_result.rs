// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use serde::{Deserialize, Serialize};

use crate::{
    ProcessId, WindowInfo, system::cdp_endpoint::CdpEndpoint, tree::renderer_kind::RendererKind,
};

/// What a launch can honestly report. The process starting and the application
/// presenting a window are separate outcomes: a background application never
/// shows one, and a document-based application creates its first window only
/// once it is brought forward. Reporting them separately lets a caller wait for
/// the window it actually asked for instead of a deadline. Run `list-apps` for
/// the presentation of an application that reports no window.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchResult {
    pub app: String,
    pub pid: ProcessId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_instance: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<WindowInfo>,
    /// The verified DevTools endpoint, present only when `--cdp` was
    /// requested and the launched process answered `/json/version`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cdp: Option<CdpEndpoint>,
    /// The application's renderer, detected best-effort from its bundle.
    /// `Chromium` means Electron or CEF; absent means undetected, not
    /// "not Chromium" — detection failure never fails the launch itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub renderer: Option<RendererKind>,
    /// Guidance for the calling agent on how to drive this application,
    /// set by core from `renderer` and whether `cdp` is present. Absent
    /// when there is nothing more useful to say than the fields already do.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<String>,
    /// `true` when this launch reached an instance of the app that was
    /// already running instead of one it started: it attached to that
    /// instance (`pid` names it), or the process it started passed the
    /// launch to it and exited (a single-instance app; `pid` names the
    /// exited process). Windows of that instance may be ones the user
    /// already had open, not ones this launch opened.
    #[serde(default)]
    pub attached: bool,
    /// `true` only when `window` is proven to belong to a process this
    /// launch created: the started process, or a descendant tied to it.
    /// `false` proves nothing new, which is not the same as nothing having
    /// started: a started process may still be running without a window.
    #[serde(default)]
    pub new_instance: bool,
}
