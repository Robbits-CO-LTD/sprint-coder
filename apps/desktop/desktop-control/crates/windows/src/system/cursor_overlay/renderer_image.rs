// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! Which file the renderer is started from.
//!
//! Normally the CLI's own image. A host that runs the CLI from a private,
//! short-lived copy of the binary (Sprint Coder seals every approved run into
//! a copy under a temporary folder and deletes it when the run returns) names
//! the installed binary in `RENDERER_IMAGE_VARIABLE` instead: a renderer
//! started from the copy would carry the copy's throwaway name, would be
//! ended with the run that started it, and would hold the copy's folder open.
//!
//! The named file is used only when it is byte-for-byte the image this
//! process runs, and it is held against writes, renames and deletes until the
//! renderer has been created from it, so what is started is still this tool's
//! own binary and nothing else.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use super::image_identity;

/// The installed binary to start the renderer from, set by the host.
pub(crate) const RENDERER_IMAGE_VARIABLE: &str = "SPRINT_CODER_DESKTOP_CONTROL_IMAGE";

/// Where the renderer is to come from, before the file has been checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RendererImage {
    /// The running image itself.
    Own(PathBuf),
    /// A file the host named; it must have the running image's bytes.
    Named(PathBuf),
}

/// Chooses the source from the running image's path and the host's variable.
///
/// The error names the stem found, so a reader is told what was refused.
pub(crate) fn choose(current: &Path, named: Option<&OsStr>) -> Result<RendererImage, String> {
    if let Some(named) = named.filter(|value| !value.is_empty()) {
        let path = PathBuf::from(named);
        if !path.is_absolute() {
            return Err("the renderer image the host named is not an absolute path".into());
        }
        if !image_identity::is_agent_desktop_image(&path) {
            let stem = image_identity::image_stem(&path).unwrap_or_default();
            return Err(format!(
                "the renderer image the host named is not this tool's binary: '{stem}'"
            ));
        }
        return Ok(RendererImage::Named(path));
    }
    if image_identity::is_agent_desktop_image(current) {
        return Ok(RendererImage::Own(current.to_path_buf()));
    }
    let stem = image_identity::image_stem(current).unwrap_or_default();
    let (upstream, bundled) = (
        image_identity::IMAGE_STEM,
        image_identity::BUNDLED_IMAGE_STEM,
    );
    Err(format!(
        "the overlay renderer is only started from the {upstream} or {bundled} image, not '{stem}'"
    ))
}

/// Opens `named` so that it cannot be written, renamed or deleted while the
/// handle is open, and returns the handle when the file has exactly the bytes
/// of `current`. Keep the handle until the renderer process exists.
#[cfg(target_os = "windows")]
pub(crate) fn hold_if_same(named: &Path, current: &Path) -> Result<std::fs::File, String> {
    use std::io::Read;
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;

    let mut held = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(named)
        .map_err(|error| format!("the renderer image could not be held: {error}"))?;
    let mut theirs = Vec::new();
    held.read_to_end(&mut theirs)
        .map_err(|error| format!("the renderer image could not be read: {error}"))?;
    let ours = std::fs::read(current)
        .map_err(|error| format!("the running image could not be read: {error}"))?;
    if theirs != ours {
        return Err("the renderer image the host named is not the running image".into());
    }
    Ok(held)
}

#[cfg(test)]
#[path = "renderer_image_tests.rs"]
mod tests;
