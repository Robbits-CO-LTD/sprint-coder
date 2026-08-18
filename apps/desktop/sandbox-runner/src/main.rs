use serde::Serialize;
use std::path::Path;
use std::process::ExitCode;

#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::fs;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::process::Command;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(target_os = "linux")]
use std::io::{self, Seek, Write};
#[cfg(target_os = "linux")]
use std::os::fd::{FromRawFd, IntoRawFd};

const PROTOCOL_VERSION: u32 = 1;

#[cfg(target_os = "windows")]
mod windows_backend;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeResult {
    protocol_version: u32,
    available: bool,
    backend: &'static str,
    reason: Option<String>,
}

fn main() -> ExitCode {
    let args = std::env::args().collect::<Vec<_>>();
    if args.len() == 2 && args[1] == "--probe-json" {
        let result = probe();
        return match serde_json::to_string(&result) {
            Ok(json) => {
                println!("{json}");
                ExitCode::SUCCESS
            }
            Err(_) => ExitCode::from(70),
        };
    }
    if args.len() >= 8
        && args[1] == "--exec"
        && args[2] == "workspace-write"
        && args[4] == "--protected-home"
        && args[6] == "--"
    {
        return execute_workspace_command(
            Path::new(&args[3]),
            Path::new(&args[5]),
            &args[7],
            &args[8..],
        );
    }
    #[cfg(target_os = "linux")]
    if args.len() >= 5 && args[1] == "--landlock-exec" && args[3] == "--" {
        return execute_landlocked_command(Path::new(&args[2]), &args[4], &args[5..]);
    }
    eprintln!(
        "usage: sprint-coder-sandbox-runner --probe-json | --exec workspace-write ROOT --protected-home HOME -- EXECUTABLE [ARG...]"
    );
    ExitCode::from(64)
}

#[cfg(target_os = "macos")]
fn execute_workspace_command(
    root: &Path,
    protected_home: &Path,
    executable: &str,
    argv: &[String],
) -> ExitCode {
    use std::os::unix::process::CommandExt;
    let Ok(root) = fs::canonicalize(root) else {
        return ExitCode::from(66);
    };
    let Ok(protected_home) = fs::canonicalize(protected_home) else {
        return ExitCode::from(66);
    };
    let mut policy = format!(
        "(version 1) (allow default) (deny file-write* (require-all (require-not (subpath {:?})) (require-not (literal \"/dev/null\")) (require-not (literal \"/dev/tty\")))) (deny network*)",
        root
    );
    for protected in [
        ".ssh",
        ".aws",
        ".gnupg",
        ".azure",
        ".kube",
        ".docker",
        ".codex",
        ".claude",
        "Library/Keychains",
        "Library/Application Support/Sprint Coder",
    ] {
        policy.push_str(&format!(
            " (deny file-read* file-write* (subpath {:?}))",
            protected_home.join(protected)
        ));
    }
    let error = Command::new("/usr/bin/sandbox-exec")
        .args(["-p", &policy, "--", executable])
        .args(argv)
        .exec();
    eprintln!("sandbox exec failed: {error}");
    ExitCode::from(70)
}

#[cfg(target_os = "linux")]
fn execute_workspace_command(
    root: &Path,
    protected_home: &Path,
    executable: &str,
    argv: &[String],
) -> ExitCode {
    use std::os::unix::process::CommandExt;
    let Ok(root) = fs::canonicalize(root) else {
        return ExitCode::from(66);
    };
    let Ok(protected_home) = fs::canonicalize(protected_home) else {
        return ExitCode::from(66);
    };
    let Some(bwrap) = ["/usr/bin/bwrap", "/bin/bwrap"]
        .into_iter()
        .find(|path| Path::new(path).is_file())
    else {
        return ExitCode::from(69);
    };
    let Ok(seccomp) = create_seccomp_filter() else {
        return ExitCode::from(69);
    };
    let seccomp_fd = seccomp.into_raw_fd();
    let Ok(helper) = std::env::current_exe() else {
        return ExitCode::from(70);
    };
    let mut command = Command::new(bwrap);
    command.args([
        "--unshare-all",
        "--new-session",
        "--die-with-parent",
        "--ro-bind",
        "/",
        "/",
        "--bind",
    ]);
    command.arg(&root).arg(&root);
    for protected in linux_protected_paths(&protected_home) {
        command.arg("--tmpfs").arg(protected);
    }
    let error = command
        .args(["--proc", "/proc", "--dev", "/dev", "--chdir"])
        .arg(&root)
        .arg("--seccomp")
        .arg(seccomp_fd.to_string())
        .arg("--")
        .arg(helper)
        .arg("--landlock-exec")
        .arg(&root)
        .arg("--")
        .arg(executable)
        .args(argv)
        .exec();
    eprintln!("sandbox exec failed: {error}");
    ExitCode::from(70)
}

#[cfg(target_os = "linux")]
fn execute_landlocked_command(root: &Path, executable: &str, argv: &[String]) -> ExitCode {
    use std::os::unix::process::CommandExt;
    let Ok(root) = fs::canonicalize(root) else {
        return ExitCode::from(66);
    };
    if apply_landlock(&root).is_err() {
        return ExitCode::from(69);
    }
    let error = Command::new(executable).args(argv).exec();
    eprintln!("landlocked exec failed: {error}");
    ExitCode::from(70)
}

#[cfg(target_os = "linux")]
fn linux_protected_paths(home: &Path) -> Vec<std::path::PathBuf> {
    [
        ".ssh",
        ".aws",
        ".gnupg",
        ".azure",
        ".kube",
        ".docker",
        ".codex",
        ".claude",
        ".config/gcloud",
        ".config/gh",
        ".config/Sprint Coder",
        ".config/sprint-coder",
        ".local/share/Sprint Coder",
        ".local/share/sprint-coder",
    ]
    .into_iter()
    .map(|path| home.join(path))
    .filter(|path| path.is_dir())
    .collect()
}

#[cfg(target_os = "linux")]
const LANDLOCK_ACCESS_FS_EXECUTE: u64 = 1 << 0;
#[cfg(target_os = "linux")]
const LANDLOCK_ACCESS_FS_WRITE_FILE: u64 = 1 << 1;
#[cfg(target_os = "linux")]
const LANDLOCK_ACCESS_FS_READ_FILE: u64 = 1 << 2;
#[cfg(target_os = "linux")]
const LANDLOCK_ACCESS_FS_READ_DIR: u64 = 1 << 3;
#[cfg(target_os = "linux")]
const LANDLOCK_ACCESS_FS_REMOVE_DIR: u64 = 1 << 4;
#[cfg(target_os = "linux")]
const LANDLOCK_ACCESS_FS_REMOVE_FILE: u64 = 1 << 5;
#[cfg(target_os = "linux")]
const LANDLOCK_ACCESS_FS_MAKE_CHAR: u64 = 1 << 6;
#[cfg(target_os = "linux")]
const LANDLOCK_ACCESS_FS_MAKE_DIR: u64 = 1 << 7;
#[cfg(target_os = "linux")]
const LANDLOCK_ACCESS_FS_MAKE_REG: u64 = 1 << 8;
#[cfg(target_os = "linux")]
const LANDLOCK_ACCESS_FS_MAKE_SOCK: u64 = 1 << 9;
#[cfg(target_os = "linux")]
const LANDLOCK_ACCESS_FS_MAKE_FIFO: u64 = 1 << 10;
#[cfg(target_os = "linux")]
const LANDLOCK_ACCESS_FS_MAKE_BLOCK: u64 = 1 << 11;
#[cfg(target_os = "linux")]
const LANDLOCK_ACCESS_FS_MAKE_SYM: u64 = 1 << 12;
#[cfg(target_os = "linux")]
const LANDLOCK_ACCESS_FS_REFER: u64 = 1 << 13;
#[cfg(target_os = "linux")]
const LANDLOCK_ACCESS_FS_TRUNCATE: u64 = 1 << 14;
#[cfg(target_os = "linux")]
const LANDLOCK_READ_ACCESS: u64 =
    LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR;
#[cfg(target_os = "linux")]
const LANDLOCK_WRITE_ACCESS: u64 = LANDLOCK_ACCESS_FS_WRITE_FILE
    | LANDLOCK_ACCESS_FS_REMOVE_DIR
    | LANDLOCK_ACCESS_FS_REMOVE_FILE
    | LANDLOCK_ACCESS_FS_MAKE_DIR
    | LANDLOCK_ACCESS_FS_MAKE_REG
    | LANDLOCK_ACCESS_FS_MAKE_SOCK
    | LANDLOCK_ACCESS_FS_MAKE_FIFO
    | LANDLOCK_ACCESS_FS_MAKE_SYM
    | LANDLOCK_ACCESS_FS_REFER
    | LANDLOCK_ACCESS_FS_TRUNCATE;
#[cfg(target_os = "linux")]
const LANDLOCK_ALL_ACCESS: u64 = LANDLOCK_READ_ACCESS | LANDLOCK_WRITE_ACCESS;
#[cfg(target_os = "linux")]
const LANDLOCK_HANDLED_ACCESS: u64 =
    LANDLOCK_ALL_ACCESS | LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_BLOCK;

#[cfg(target_os = "linux")]
#[repr(C)]
struct LandlockRulesetAttr {
    handled_access_fs: u64,
}

#[cfg(target_os = "linux")]
#[repr(C)]
struct LandlockPathBeneathAttr {
    allowed_access: u64,
    parent_fd: i32,
}

#[cfg(target_os = "linux")]
fn apply_landlock(root: &Path) -> io::Result<()> {
    const LANDLOCK_CREATE_RULESET_VERSION: libc::c_uint = 1;
    const LANDLOCK_RULE_PATH_BENEATH: libc::c_int = 1;

    // SAFETY: A null attribute with VERSION is the documented ABI query.
    let abi = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            std::ptr::null::<LandlockRulesetAttr>(),
            0,
            LANDLOCK_CREATE_RULESET_VERSION,
        )
    };
    if abi < 3 {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Landlock ABI 3 is required",
        ));
    }
    let attr = LandlockRulesetAttr {
        handled_access_fs: LANDLOCK_HANDLED_ACCESS,
    };
    // SAFETY: attr points to a valid ruleset attribute for the supplied size.
    let ruleset_fd = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            &attr,
            std::mem::size_of::<LandlockRulesetAttr>(),
            0,
        )
    } as i32;
    if ruleset_fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let result = add_landlock_path_rule(
        ruleset_fd,
        Path::new("/"),
        LANDLOCK_READ_ACCESS,
        LANDLOCK_RULE_PATH_BENEATH,
    )
    .and_then(|()| {
        add_landlock_path_rule(
            ruleset_fd,
            root,
            LANDLOCK_ALL_ACCESS,
            LANDLOCK_RULE_PATH_BENEATH,
        )
    })
    .and_then(|()| {
        add_landlock_path_rule(
            ruleset_fd,
            Path::new("/dev"),
            LANDLOCK_READ_ACCESS | LANDLOCK_ACCESS_FS_WRITE_FILE,
            LANDLOCK_RULE_PATH_BENEATH,
        )
    })
    .and_then(|()| {
        // SAFETY: prctl and restrict_self use constant arguments and the valid ruleset fd.
        unsafe {
            if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                return Err(io::Error::last_os_error());
            }
            if libc::syscall(libc::SYS_landlock_restrict_self, ruleset_fd, 0) != 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    });
    // SAFETY: ruleset_fd is a valid, still-owned descriptor.
    unsafe { libc::close(ruleset_fd) };
    result
}

#[cfg(target_os = "linux")]
fn add_landlock_path_rule(
    ruleset_fd: i32,
    path: &Path,
    allowed_access: u64,
    rule_type: libc::c_int,
) -> io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))?;
    // SAFETY: path is NUL terminated and remains alive for the call.
    let parent_fd = unsafe { libc::open(path.as_ptr(), libc::O_PATH | libc::O_CLOEXEC) };
    if parent_fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let attr = LandlockPathBeneathAttr {
        allowed_access,
        parent_fd,
    };
    // SAFETY: both descriptors and attr are valid for LANDLOCK_RULE_PATH_BENEATH.
    let status =
        unsafe { libc::syscall(libc::SYS_landlock_add_rule, ruleset_fd, rule_type, &attr, 0) };
    // SAFETY: parent_fd is owned by this function.
    unsafe { libc::close(parent_fd) };
    if status == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
#[repr(C)]
#[derive(Clone, Copy)]
struct BpfInstruction {
    code: u16,
    jt: u8,
    jf: u8,
    k: u32,
}

#[cfg(target_os = "linux")]
fn create_seccomp_filter() -> io::Result<std::fs::File> {
    const BPF_LD_W_ABS: u16 = 0x20;
    const BPF_JMP_JEQ_K: u16 = 0x15;
    const BPF_JMP_JGE_K: u16 = 0x35;
    const BPF_RET_K: u16 = 0x06;
    const SECCOMP_RET_KILL_PROCESS: u32 = 0x8000_0000;
    const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;
    const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
    #[cfg(target_arch = "x86_64")]
    const AUDIT_ARCH: u32 = 0xc000_003e;
    #[cfg(target_arch = "aarch64")]
    const AUDIT_ARCH: u32 = 0xc000_00b7;
    #[cfg(target_arch = "riscv64")]
    const AUDIT_ARCH: u32 = 0xc000_00f3;
    #[cfg(not(any(
        target_arch = "x86_64",
        target_arch = "aarch64",
        target_arch = "riscv64"
    )))]
    return Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "unsupported seccomp architecture",
    ));

    let mut instructions = vec![
        BpfInstruction {
            code: BPF_LD_W_ABS,
            jt: 0,
            jf: 0,
            k: 4,
        },
        BpfInstruction {
            code: BPF_JMP_JEQ_K,
            jt: 1,
            jf: 0,
            k: AUDIT_ARCH,
        },
        BpfInstruction {
            code: BPF_RET_K,
            jt: 0,
            jf: 0,
            k: SECCOMP_RET_KILL_PROCESS,
        },
        BpfInstruction {
            code: BPF_LD_W_ABS,
            jt: 0,
            jf: 0,
            k: 0,
        },
    ];
    #[cfg(target_arch = "x86_64")]
    instructions.extend([
        BpfInstruction {
            code: BPF_JMP_JGE_K,
            jt: 0,
            jf: 1,
            k: 0x4000_0000,
        },
        BpfInstruction {
            code: BPF_RET_K,
            jt: 0,
            jf: 0,
            k: SECCOMP_RET_KILL_PROCESS,
        },
    ]);
    for syscall in [
        libc::SYS_mount,
        libc::SYS_umount2,
        libc::SYS_pivot_root,
        libc::SYS_chroot,
        libc::SYS_mknod,
        libc::SYS_mknodat,
        libc::SYS_ptrace,
        libc::SYS_bpf,
        libc::SYS_perf_event_open,
        libc::SYS_kexec_load,
        libc::SYS_init_module,
        libc::SYS_finit_module,
        libc::SYS_delete_module,
        libc::SYS_open_by_handle_at,
        libc::SYS_unshare,
        libc::SYS_setns,
    ] {
        instructions.extend([
            BpfInstruction {
                code: BPF_JMP_JEQ_K,
                jt: 0,
                jf: 1,
                k: syscall as u32,
            },
            BpfInstruction {
                code: BPF_RET_K,
                jt: 0,
                jf: 0,
                k: SECCOMP_RET_ERRNO | libc::EPERM as u32,
            },
        ]);
    }
    instructions.push(BpfInstruction {
        code: BPF_RET_K,
        jt: 0,
        jf: 0,
        k: SECCOMP_RET_ALLOW,
    });

    let name = c"sprint-coder-seccomp";
    // SAFETY: memfd_create copies the valid static name and returns an owned fd.
    let fd = unsafe { libc::memfd_create(name.as_ptr(), 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fd was returned owned by memfd_create.
    let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
    // SAFETY: BpfInstruction is repr(C) and fully initialized.
    let bytes = unsafe {
        std::slice::from_raw_parts(
            instructions.as_ptr().cast::<u8>(),
            instructions.len() * std::mem::size_of::<BpfInstruction>(),
        )
    };
    file.write_all(bytes)?;
    file.flush()?;
    file.rewind()?;
    Ok(file)
}

#[cfg(target_os = "windows")]
fn execute_workspace_command(
    _root: &Path,
    _protected_home: &Path,
    _executable: &str,
    _argv: &[String],
) -> ExitCode {
    ExitCode::from(windows_backend::execute(_root, _executable, _argv))
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn execute_workspace_command(
    _root: &Path,
    _protected_home: &Path,
    _executable: &str,
    _argv: &[String],
) -> ExitCode {
    ExitCode::from(69)
}

#[cfg(target_os = "macos")]
fn probe() -> ProbeResult {
    let executable = Path::new("/usr/bin/sandbox-exec");
    let available =
        executable.is_file() && probe_filesystem_boundary(executable, SandboxBackend::Macos);
    ProbeResult {
        protocol_version: PROTOCOL_VERSION,
        available,
        backend: "macos-seatbelt",
        reason: (!available).then(|| "seatbelt_probe_failed".to_owned()),
    }
}

#[cfg(target_os = "linux")]
fn probe() -> ProbeResult {
    let executable = ["/usr/bin/bwrap", "/bin/bwrap"]
        .into_iter()
        .find(|candidate| Path::new(candidate).is_file());
    let available = executable
        .is_some_and(|bwrap| probe_filesystem_boundary(Path::new(bwrap), SandboxBackend::Linux));
    ProbeResult {
        protocol_version: PROTOCOL_VERSION,
        available,
        backend: "linux-bubblewrap-landlock-seccomp",
        reason: (!available).then(|| "bubblewrap_landlock_seccomp_probe_failed".to_owned()),
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[allow(dead_code)]
enum SandboxBackend {
    Macos,
    Linux,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn probe_filesystem_boundary(executable: &Path, backend: SandboxBackend) -> bool {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let base = std::env::temp_dir().join(format!(
        "sprint-coder-sandbox-probe-{}-{nonce}",
        std::process::id()
    ));
    let inside = base.join("inside");
    let outside = base.join("outside");
    let protected = base.join(".ssh");
    if fs::create_dir_all(&inside).is_err()
        || fs::create_dir_all(&outside).is_err()
        || fs::create_dir_all(&protected).is_err()
        || fs::write(protected.join("secret.txt"), b"secret").is_err()
    {
        return false;
    }
    let inside = fs::canonicalize(&inside).unwrap_or(inside);
    let outside = fs::canonicalize(&outside).unwrap_or(outside);
    let protected = fs::canonicalize(&protected).unwrap_or(protected);
    let inside_marker = inside.join("allowed.txt");
    let outside_marker = outside.join("denied.txt");
    let status = match backend {
        SandboxBackend::Macos => macos_probe_command(
            executable,
            &inside,
            &inside_marker,
            &outside_marker,
            &protected,
        ),
        SandboxBackend::Linux => linux_probe_command(
            executable,
            &inside,
            &inside_marker,
            &outside_marker,
            &protected,
        ),
    };
    let result = status.is_ok_and(|status| status.success())
        && inside_marker.is_file()
        && !outside_marker.exists();
    let _ = fs::remove_dir_all(&base);
    result
}

#[cfg(target_os = "macos")]
fn macos_probe_command(
    executable: &Path,
    inside: &Path,
    inside_marker: &Path,
    outside_marker: &Path,
    protected: &Path,
) -> std::io::Result<std::process::ExitStatus> {
    let policy = format!(
        "(version 1) (allow default) (deny file-write* (require-all (require-not (subpath {:?})) (require-not (literal \"/dev/null\")) (require-not (literal \"/dev/tty\")))) (deny file-read* (subpath {:?})) (deny network*)",
        inside, protected
    );
    Command::new(executable)
        .args([
            "-p",
            &policy,
            "--",
            "/bin/sh",
            "-c",
            "printf ok > \"$1\"; printf denied > \"$2\"; ! cat \"$3/secret.txt\" >/dev/null 2>&1",
            "probe",
        ])
        .arg(inside_marker)
        .arg(outside_marker)
        .arg(protected)
        .status()
}

#[cfg(target_os = "linux")]
fn linux_probe_command(
    _executable: &Path,
    inside: &Path,
    inside_marker: &Path,
    outside_marker: &Path,
    protected: &Path,
) -> std::io::Result<std::process::ExitStatus> {
    let helper = std::env::current_exe()?;
    Command::new(helper)
        .args(["--exec", "workspace-write"])
        .arg(inside)
        .arg("--protected-home")
        .arg(protected.parent().unwrap_or(protected))
        .args([
            "--",
            "/bin/sh",
            "-c",
            "printf ok > \"$1\"; printf denied > \"$2\"; test ! -e \"$3/secret.txt\"",
            "probe",
        ])
        .arg(inside_marker)
        .arg(outside_marker)
        .arg(protected)
        .status()
}

#[cfg(all(target_os = "macos", not(target_os = "linux")))]
fn linux_probe_command(
    _executable: &Path,
    _inside: &Path,
    _inside_marker: &Path,
    _outside_marker: &Path,
    _protected: &Path,
) -> std::io::Result<std::process::ExitStatus> {
    unreachable!()
}

#[cfg(all(target_os = "linux", not(target_os = "macos")))]
fn macos_probe_command(
    _executable: &Path,
    _inside: &Path,
    _inside_marker: &Path,
    _outside_marker: &Path,
    _protected: &Path,
) -> std::io::Result<std::process::ExitStatus> {
    unreachable!()
}

#[cfg(target_os = "windows")]
fn probe() -> ProbeResult {
    let result = windows_backend::restricted_token_probe();
    ProbeResult {
        protocol_version: PROTOCOL_VERSION,
        available: result.is_ok(),
        backend: "windows-appcontainer",
        reason: result.err(),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn probe() -> ProbeResult {
    ProbeResult {
        protocol_version: PROTOCOL_VERSION,
        available: false,
        backend: "unsupported",
        reason: Some("unsupported_platform".to_owned()),
    }
}
