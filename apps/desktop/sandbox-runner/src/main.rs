use serde::Serialize;
use std::path::Path;
use std::process::ExitCode;

#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::fs;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::process::Command;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::time::{SystemTime, UNIX_EPOCH};

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
    #[cfg(target_os = "windows")]
    if args.len() == 5 && args[1] == "--probe-child" {
        let Ok(port) = args[4].parse::<u16>() else {
            return ExitCode::from(64);
        };
        return ExitCode::from(windows_backend::probe_child(
            Path::new(&args[2]),
            Path::new(&args[3]),
            port,
        ));
    }
    if args.len() >= 6 && args[1] == "--exec" && args[2] == "workspace-write" && args[4] == "--" {
        return execute_workspace_command(Path::new(&args[3]), &args[5], &args[6..]);
    }
    eprintln!(
        "usage: sprint-coder-sandbox-runner --probe-json | --exec workspace-write ROOT -- EXECUTABLE [ARG...]"
    );
    ExitCode::from(64)
}

#[cfg(target_os = "macos")]
fn execute_workspace_command(root: &Path, executable: &str, argv: &[String]) -> ExitCode {
    use std::os::unix::process::CommandExt;
    let Ok(root) = fs::canonicalize(root) else {
        return ExitCode::from(66);
    };
    let mut policy = format!(
        "(version 1) (allow default) (deny file-write* (require-not (subpath {:?}))) (deny network*)",
        root
    );
    if let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from) {
        for protected in [".ssh", ".aws", ".gnupg", "Library/Keychains"] {
            policy.push_str(&format!(
                " (deny file-read* file-write* (subpath {:?}))",
                home.join(protected)
            ));
        }
    }
    let error = Command::new("/usr/bin/sandbox-exec")
        .args(["-p", &policy, "--", executable])
        .args(argv)
        .exec();
    eprintln!("sandbox exec failed: {error}");
    ExitCode::from(70)
}

#[cfg(target_os = "linux")]
fn execute_workspace_command(root: &Path, executable: &str, argv: &[String]) -> ExitCode {
    use std::os::unix::process::CommandExt;
    let Ok(root) = fs::canonicalize(root) else {
        return ExitCode::from(66);
    };
    let Some(bwrap) = ["/usr/bin/bwrap", "/bin/bwrap"]
        .into_iter()
        .find(|path| Path::new(path).is_file())
    else {
        return ExitCode::from(69);
    };
    let error = Command::new(bwrap)
        .args([
            "--unshare-all",
            "--new-session",
            "--die-with-parent",
            "--ro-bind",
            "/",
            "/",
            "--bind",
        ])
        .arg(&root)
        .arg(&root)
        .args(["--proc", "/proc", "--dev", "/dev", "--chdir"])
        .arg(&root)
        .arg("--")
        .arg(executable)
        .args(argv)
        .exec();
    eprintln!("sandbox exec failed: {error}");
    ExitCode::from(70)
}

#[cfg(target_os = "windows")]
fn execute_workspace_command(_root: &Path, _executable: &str, _argv: &[String]) -> ExitCode {
    ExitCode::from(windows_backend::execute(_root, _executable, _argv))
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn execute_workspace_command(_root: &Path, _executable: &str, _argv: &[String]) -> ExitCode {
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
        backend: "linux-bubblewrap-landlock",
        reason: (!available).then(|| "bubblewrap_probe_failed".to_owned()),
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
    if fs::create_dir_all(&inside).is_err() || fs::create_dir_all(&outside).is_err() {
        return false;
    }
    let inside = fs::canonicalize(&inside).unwrap_or(inside);
    let outside = fs::canonicalize(&outside).unwrap_or(outside);
    let inside_marker = inside.join("allowed.txt");
    let outside_marker = outside.join("denied.txt");
    let status = match backend {
        SandboxBackend::Macos => {
            macos_probe_command(executable, &inside, &inside_marker, &outside_marker)
        }
        SandboxBackend::Linux => {
            linux_probe_command(executable, &inside, &inside_marker, &outside_marker)
        }
    };
    let result = status.is_ok() && inside_marker.is_file() && !outside_marker.exists();
    let _ = fs::remove_dir_all(&base);
    result
}

#[cfg(target_os = "macos")]
fn macos_probe_command(
    executable: &Path,
    inside: &Path,
    inside_marker: &Path,
    outside_marker: &Path,
) -> std::io::Result<std::process::ExitStatus> {
    let policy = format!(
        "(version 1) (allow default) (deny file-write* (require-not (subpath {:?}))) (deny network*)",
        inside
    );
    Command::new(executable)
        .args([
            "-p",
            &policy,
            "--",
            "/bin/sh",
            "-c",
            "printf ok > \"$1\"; printf denied > \"$2\"",
            "probe",
        ])
        .arg(inside_marker)
        .arg(outside_marker)
        .status()
}

#[cfg(target_os = "linux")]
fn linux_probe_command(
    executable: &Path,
    inside: &Path,
    inside_marker: &Path,
    outside_marker: &Path,
) -> std::io::Result<std::process::ExitStatus> {
    Command::new(executable)
        .args([
            "--unshare-all",
            "--new-session",
            "--die-with-parent",
            "--ro-bind",
            "/",
            "/",
            "--bind",
        ])
        .arg(inside)
        .arg(inside)
        .args([
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--",
            "/bin/sh",
            "-c",
            "printf ok > \"$1\"; printf denied > \"$2\"",
            "probe",
        ])
        .arg(inside_marker)
        .arg(outside_marker)
        .status()
}

#[cfg(all(target_os = "macos", not(target_os = "linux")))]
fn linux_probe_command(
    _executable: &Path,
    _inside: &Path,
    _inside_marker: &Path,
    _outside_marker: &Path,
) -> std::io::Result<std::process::ExitStatus> {
    unreachable!()
}

#[cfg(all(target_os = "linux", not(target_os = "macos")))]
fn macos_probe_command(
    _executable: &Path,
    _inside: &Path,
    _inside_marker: &Path,
    _outside_marker: &Path,
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
