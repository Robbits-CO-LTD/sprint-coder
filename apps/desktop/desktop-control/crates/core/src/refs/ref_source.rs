// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RefSource {
    pub source_app: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_window_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_window_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_window_bounds_hash: Option<u64>,
    #[serde(default, skip_serializing_if = "crate::SnapshotSurface::is_window")]
    pub source_surface: crate::SnapshotSurface,
    /// Whether the capture read the window with Chromium renderer accessibility
    /// forced, so resolution reads it the same way and counts the same evidence.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub renderer_accessibility_forced: bool,
    /// The node count of the window's whole tree when the capture took a small
    /// tree for it only after it stopped changing past a Chromium renderer
    /// settle. A resolution in the same process whose walk comes back at
    /// exactly this count reads that settled tree again and need not wait out
    /// the settle. Absent (and ignored by a build that does not know it) for
    /// every other capture.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settled_thin_nodes: Option<u64>,
}

impl RefSource {
    /// Whether the ref was captured through a process owner (see
    /// [`crate::WindowInfo::for_process`]) rather than a window, on any surface.
    pub fn is_process_owned(&self) -> bool {
        self.source_window_id.is_none() && self.source_window_title.as_deref() == Some("")
    }

    /// Whether the ref was observed from a process owner's application root,
    /// so its path starts there.
    pub fn is_process_rooted(&self) -> bool {
        self.source_surface == crate::SnapshotSurface::Window && self.is_process_owned()
    }
}
