// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::{RendererImage, choose};
use std::ffi::OsStr;
use std::path::PathBuf;

fn absolute(file: &str) -> PathBuf {
    PathBuf::from("C:\\")
        .join("Program Files")
        .join("App")
        .join(file)
}

fn private_copy() -> PathBuf {
    PathBuf::from("C:\\")
        .join("Temp")
        .join("sprint-coder-execution-x")
        .join("bin")
        .join("image-0f5c.exe")
}

#[test]
fn without_a_named_image_the_running_image_is_used_when_it_is_ours() {
    let own = absolute("sprint-coder-desktop-control.exe");
    assert_eq!(choose(&own, None), Ok(RendererImage::Own(own.clone())));
    assert_eq!(
        choose(&own, Some(OsStr::new(""))),
        Ok(RendererImage::Own(own))
    );
}

/// The case Sprint Coder hits: the CLI runs from a copy whose name is not
/// ours, so without the host's variable the renderer is refused.
#[test]
fn a_private_copy_without_a_named_image_is_refused_with_its_stem() {
    let refused = choose(&private_copy(), None).expect_err("a copy is not our image");
    assert!(refused.contains("image-0f5c"), "{refused}");
}

#[cfg(target_os = "windows")]
#[test]
fn a_private_copy_starts_the_named_installed_binary() {
    let installed = absolute("sprint-coder-desktop-control.exe");
    assert_eq!(
        choose(&private_copy(), Some(installed.as_os_str())),
        Ok(RendererImage::Named(installed))
    );
}

#[cfg(target_os = "windows")]
#[test]
fn a_named_image_that_is_not_this_tool_or_not_absolute_is_refused() {
    let other = absolute("notepad.exe");
    assert!(choose(&private_copy(), Some(other.as_os_str())).is_err());
    assert!(
        choose(
            &private_copy(),
            Some(OsStr::new("sprint-coder-desktop-control.exe"))
        )
        .is_err()
    );
}

#[cfg(target_os = "windows")]
mod held {
    use super::super::hold_if_same;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let folder = std::env::temp_dir().join(format!(
            "renderer-image-tests-{}-{name}",
            std::process::id()
        ));
        std::fs::create_dir_all(&folder).expect("a scratch folder");
        folder
    }

    #[test]
    fn the_named_file_is_held_against_writes_and_deletes_when_it_matches() {
        let folder = scratch("match");
        let current = folder.join("image-1.exe");
        let named = folder.join("sprint-coder-desktop-control.exe");
        std::fs::write(&current, b"same bytes").unwrap();
        std::fs::write(&named, b"same bytes").unwrap();

        let handle = hold_if_same(&named, &current).expect("the same bytes are accepted");
        assert!(
            std::fs::OpenOptions::new()
                .write(true)
                .open(&named)
                .is_err()
        );
        assert!(std::fs::remove_file(&named).is_err());
        assert!(std::fs::rename(&named, folder.join("moved.exe")).is_err());
        drop(handle);

        std::fs::remove_dir_all(&folder).unwrap();
    }

    #[test]
    fn a_named_file_with_other_bytes_is_refused() {
        let folder = scratch("differ");
        let current = folder.join("image-1.exe");
        let named = folder.join("sprint-coder-desktop-control.exe");
        std::fs::write(&current, b"our bytes").unwrap();
        std::fs::write(&named, b"other bytes").unwrap();

        assert!(hold_if_same(&named, &current).is_err());
        assert!(hold_if_same(&folder.join("missing.exe"), &current).is_err());

        std::fs::remove_dir_all(&folder).unwrap();
    }
}
