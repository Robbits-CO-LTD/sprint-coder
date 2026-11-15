// Changed by Sprint Coder (new file); see VENDORED.md in apps/desktop/desktop-control.
//! LaunchServices may resolve bundles inside a workspace. Check the real path before opening.
use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode};
use std::path::{Component, Path, PathBuf};

const CRYPTEX_APPLICATIONS: &str = "/System/Cryptexes/App/System/Applications";

pub(crate) fn allowed(path: &Path, home: Option<&Path>, cryptex: Option<&Path>) -> bool {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return false;
    }
    let standard = [
        Path::new("/Applications"),
        Path::new("/System/Applications"),
        Path::new("/System/Library/CoreServices"),
        Path::new(CRYPTEX_APPLICATIONS),
    ];
    standard
        .into_iter()
        .any(|root| path != root && path.starts_with(root))
        // This OS-owned root is a symlink into the active system Cryptex on current macOS.
        || cryptex.is_some_and(|root| path != root && path.starts_with(root))
        || home.is_some_and(|home| {
            let root = home.join("Applications");
            path != root && path.starts_with(root)
        })
}

pub(crate) fn require(path: &Path) -> Result<PathBuf, AdapterError> {
    let real = path.canonicalize().map_err(|_| refused())?;
    let home = effective_home().and_then(|home| home.canonicalize().ok());
    let cryptex = Path::new(CRYPTEX_APPLICATIONS).canonicalize().ok();
    if allowed(&real, home.as_deref(), cryptex.as_deref()) {
        Ok(real)
    } else {
        Err(refused())
    }
}

pub(crate) fn refused() -> AdapterError {
    AdapterError::new(ErrorCode::PolicyDenied,
        "The application is outside the standard application folders, or its bundle path could not be confirmed; nothing was launched")
        .with_details(serde_json::json!({
            "kind": "launch_location_refused", "physical_delivery_started": false, "retryable": false,
        }))
        .with_suggestion("Use an application installed in a standard application folder.")
        .with_disposition(DeliverySemantics::not_delivered())
}

fn effective_home() -> Option<PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    // The runner deliberately omits HOME. Query the effective user's password entry.
    let mut size = 1024;
    while size <= 1024 * 1024 {
        let mut buffer = vec![0_u8; size];
        let mut entry = std::mem::MaybeUninit::<libc::passwd>::zeroed();
        let mut result = std::ptr::null_mut();
        let status = unsafe {
            libc::getpwuid_r(
                libc::geteuid(),
                entry.as_mut_ptr(),
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                &mut result,
            )
        };
        if status == libc::ERANGE {
            size *= 2;
            continue;
        }
        if status != 0 || result.is_null() {
            return None;
        }
        let entry = unsafe { entry.assume_init() };
        if entry.pw_dir.is_null() {
            return None;
        }
        let bytes = unsafe { std::ffi::CStr::from_ptr(entry.pw_dir) }.to_bytes();
        let home = PathBuf::from(std::ffi::OsStr::from_bytes(bytes));
        return home.is_absolute().then_some(home);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_descendants_of_standard_folders_are_allowed() {
        let home = Some(Path::new("/Users/person"));
        for path in [
            "/Applications/Editor.app",
            "/Applications/Utilities/Terminal.app",
            "/System/Applications/TextEdit.app",
            "/System/Library/CoreServices/Finder.app",
            "/System/Cryptexes/App/System/Applications/Safari.app",
            "/Users/person/Applications/Editor.app",
        ] {
            assert!(allowed(Path::new(path), home, None), "{path}");
        }
        for path in [
            "/Applications",
            "/Applications-other/Editor.app",
            "/tmp/Editor.app",
            "/Users/person/project/Editor.app",
            "/Users/other/Applications/Editor.app",
            "Applications/Editor.app",
            "/Applications/../tmp/Editor.app",
        ] {
            assert!(!allowed(Path::new(path), home, None), "{path}");
        }
        assert!(!allowed(
            Path::new("/Users/person/Applications/Editor.app"),
            None,
            None
        ));
        assert!(allowed(Path::new("/Applications/Editor.app"), None, None));
    }

    #[test]
    fn the_resolved_system_cryptex_root_is_allowed() {
        let root = Path::new("/System/Volumes/Preboot/Cryptexes/App/System/Applications");
        let safari = root.join("Safari.app");
        assert!(!allowed(&safari, None, None));
        assert!(allowed(&safari, None, Some(root)));
        assert!(!allowed(
            Path::new("/System/Volumes/Preboot/Other/App.app"),
            None,
            Some(root)
        ));
    }

    #[test]
    fn canonicalization_rejects_a_symlink_to_an_outside_bundle() {
        use std::os::unix::fs::symlink;
        let base =
            std::env::temp_dir().join(format!("desktop-launch-location-{}", std::process::id()));
        std::fs::create_dir_all(base.join("outside.app")).unwrap();
        symlink(base.join("outside.app"), base.join("linked.app")).unwrap();
        let error = require(&base.join("linked.app")).unwrap_err();
        assert_eq!(error.code, ErrorCode::PolicyDenied);
        assert_eq!(error.details.unwrap()["kind"], "launch_location_refused");
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn effective_user_has_an_absolute_home_without_an_environment_lookup() {
        assert!(effective_home().unwrap().is_absolute());
    }
}
