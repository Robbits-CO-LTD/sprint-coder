// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::*;
use std::os::unix::fs::PermissionsExt;

#[test]
fn sprint_coders_executable_looks_only_beside_itself_for_its_own_helper_name() {
    let shipped = std::path::Path::new(
        "/Applications/Sprint Coder.app/Contents/Resources/sprint-coder-desktop-control",
    );
    assert_eq!(
        layout_for(Some(shipped)),
        Layout {
            basename: "sprint-coder-desktop-control-helper",
            path_override: false,
            beside_image: false,
        }
    );
    for other in [
        Some(std::path::Path::new("/usr/local/bin/agent-desktop")),
        Some(std::path::Path::new(
            "/tmp/sprint-coder-desktop-control.old",
        )),
        None,
    ] {
        assert_eq!(
            layout_for(other),
            Layout {
                basename: protocol::HELPER_BASENAME,
                path_override: true,
                beside_image: true,
            }
        );
    }
}

#[test]
fn a_helper_under_the_other_name_is_refused() {
    let root = fixture_root();
    let upstream = root.join(protocol::HELPER_BASENAME);
    create_helper(&upstream);
    assert!(HelperIdentity::read(upstream.clone(), SPRINT_CODER_HELPER_BASENAME).is_err());
    let shipped = root.join(SPRINT_CODER_HELPER_BASENAME);
    create_helper(&shipped);
    assert!(HelperIdentity::read(shipped.clone(), protocol::HELPER_BASENAME).is_err());
    let identity = HelperIdentity::read(shipped.clone(), SPRINT_CODER_HELPER_BASENAME).unwrap();
    identity.revalidate().unwrap();
    std::fs::remove_file(upstream).unwrap();
    std::fs::remove_file(shipped).unwrap();
    std::fs::remove_dir(root).unwrap();
}

#[test]
fn a_missing_helper_is_refused_as_not_delivered_before_anything_starts() {
    let root = fixture_root();
    let error = HelperIdentity::read(
        root.join(SPRINT_CODER_HELPER_BASENAME),
        SPRINT_CODER_HELPER_BASENAME,
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert_eq!(
        error.disposition,
        agent_desktop_core::DeliverySemantics::not_delivered()
    );
    let details = error.details.unwrap();
    assert_eq!(details["kind"], "clipboard_helper_not_found");
    assert_eq!(details["helper"], SPRINT_CODER_HELPER_BASENAME);
    std::fs::remove_dir(root).unwrap();
}

#[test]
fn ancestors_admit_only_the_root_owned_admin_group_folder_beyond_the_upstream_rule() {
    const DIR: u32 = 0o040000;
    let me = 501;
    // Added: root:admin, writable by the group but not by everyone (`/Applications`).
    assert!(ancestor_permits(0, ADMIN_GID, DIR | 0o775, me));
    // Still refused.
    assert!(!ancestor_permits(0, 20, DIR | 0o775, me));
    assert!(!ancestor_permits(0, ADMIN_GID, DIR | 0o777, me));
    assert!(!ancestor_permits(0, ADMIN_GID, DIR | 0o757, me));
    assert!(!ancestor_permits(me, ADMIN_GID, DIR | 0o775, me));
    assert!(!ancestor_permits(502, 20, DIR | 0o755, me));
    assert!(!ancestor_permits(502, ADMIN_GID, DIR | 0o775, me));
    // Unchanged: root or this user without shared writes, and sticky shared folders.
    assert!(ancestor_permits(0, 0, DIR | 0o755, me));
    assert!(ancestor_permits(me, 20, DIR | 0o755, me));
    assert!(ancestor_permits(me, 20, DIR | 0o700, me));
    assert!(ancestor_permits(0, 0, DIR | 0o1777, me));
    assert!(ancestor_permits(0, ADMIN_GID, DIR | 0o1777, me));
}

#[test]
fn helper_identity_rejects_replaced_ancestor_after_discovery() {
    let root = fixture_root();
    let bin = root.join("bin");
    std::fs::create_dir(&bin).unwrap();
    let helper = bin.join(protocol::HELPER_BASENAME);
    create_helper(&helper);
    let identity = HelperIdentity::read(helper, protocol::HELPER_BASENAME).unwrap();

    std::fs::rename(&bin, root.join("old-bin")).unwrap();
    std::fs::create_dir(&bin).unwrap();
    let replacement = bin.join(protocol::HELPER_BASENAME);
    create_helper(&replacement);

    assert!(identity.revalidate().is_err());
    std::fs::remove_file(replacement).unwrap();
    std::fs::remove_dir(bin).unwrap();
    let old_bin = root.join("old-bin");
    std::fs::remove_file(old_bin.join(protocol::HELPER_BASENAME)).unwrap();
    std::fs::remove_dir(old_bin).unwrap();
    std::fs::remove_dir(root).unwrap();
}

#[test]
fn helper_identity_rejects_acl_write_access_on_ancestor() {
    let root = fixture_root();
    let bin = root.join("bin");
    std::fs::create_dir(&bin).unwrap();
    set_acl(
        &bin,
        "!#acl 1\ngroup:ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C:everyone:12:allow:write,delete_child\n",
    );
    let helper = bin.join(protocol::HELPER_BASENAME);
    create_helper(&helper);

    assert!(HelperIdentity::read(helper.clone(), protocol::HELPER_BASENAME).is_err());
    std::fs::remove_file(helper).unwrap();
    std::fs::remove_dir(bin).unwrap();
    std::fs::remove_dir(root).unwrap();
}

#[test]
fn helper_identity_rejects_acl_write_access_on_helper() {
    let root = fixture_root();
    let bin = root.join("bin");
    std::fs::create_dir(&bin).unwrap();
    let helper = bin.join(protocol::HELPER_BASENAME);
    create_helper(&helper);
    set_acl(
        &helper,
        "!#acl 1\ngroup:ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C:everyone:12:allow:write\n",
    );

    assert!(HelperIdentity::read(helper.clone(), protocol::HELPER_BASENAME).is_err());
    std::fs::remove_file(helper).unwrap();
    std::fs::remove_dir(bin).unwrap();
    std::fs::remove_dir(root).unwrap();
}

fn fixture_root() -> std::path::PathBuf {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let root = std::env::temp_dir().join(format!(
        "clipboard-helper-identity-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir(&root).unwrap();
    root
}

fn create_helper(path: &std::path::Path) {
    std::fs::write(path, b"controlled helper fixture").unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
}

fn set_acl(path: &std::path::Path, text: &str) {
    unsafe extern "C" {
        fn acl_from_text(text: *const std::ffi::c_char) -> Acl;
        fn acl_set_file(path: *const std::ffi::c_char, kind: c_int, acl: Acl) -> c_int;
    }
    let path = CString::new(path.as_os_str().as_bytes()).unwrap();
    let text = CString::new(text).unwrap();
    let acl = unsafe { acl_from_text(text.as_ptr()) };
    assert!(
        !acl.is_null(),
        "acl_from_text failed: {}",
        std::io::Error::last_os_error()
    );
    assert_eq!(
        unsafe { acl_set_file(path.as_ptr(), ACL_TYPE_EXTENDED, acl) },
        0
    );
    unsafe { acl_free(acl) };
}

#[test]
fn helper_identity_accepts_current_user_acl_on_helper_and_ancestor() {
    let root = fixture_root();
    let helper = root.join(protocol::HELPER_BASENAME);
    create_helper(&helper);
    let username = std::process::Command::new("id")
        .arg("-un")
        .output()
        .unwrap();
    assert!(username.status.success());
    let username = String::from_utf8(username.stdout).unwrap();
    for path in [&root, &helper] {
        let status = std::process::Command::new("chmod")
            .args([
                "+a",
                &format!(
                    "user:{} allow write,append,writeattr,writeextattr,writesecurity",
                    username.trim()
                ),
            ])
            .arg(path)
            .status()
            .unwrap();
        assert!(status.success());
    }
    let identity = HelperIdentity::read(helper.clone(), protocol::HELPER_BASENAME).unwrap();
    identity.revalidate().unwrap();
    std::fs::remove_file(helper).unwrap();
    std::fs::remove_dir(root).unwrap();
}
