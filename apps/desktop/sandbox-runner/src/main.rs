use serde::Serialize;
use std::fs;
use std::path::Path;
use std::process::{Command, ExitCode};
use std::time::{SystemTime, UNIX_EPOCH};

const PROTOCOL_VERSION: u32 = 1;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeResult {
    protocol_version: u32,
    available: bool,
    backend: &'static str,
    reason: Option<&'static str>,
}

fn main() -> ExitCode {
    let args = std::env::args().collect::<Vec<_>>();
    if args.len() != 2 || args[1] != "--probe-json" {
        eprintln!("usage: sprint-coder-sandbox-runner --probe-json");
        return ExitCode::from(64);
    }
    let result = probe();
    match serde_json::to_string(&result) {
        Ok(json) => {
            println!("{json}");
            ExitCode::SUCCESS
        }
        Err(_) => ExitCode::from(70),
    }
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
        reason: (!available).then_some("seatbelt_probe_failed"),
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
        reason: (!available).then_some("bubblewrap_probe_failed"),
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
        "(version 1) (deny default) (allow process-exec) (allow process-fork) (allow file-read*) (allow file-write* (subpath {:?}))",
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
    ProbeResult {
        protocol_version: PROTOCOL_VERSION,
        available: false,
        backend: "windows-restricted-token",
        reason: Some("restricted_token_backend_not_installed"),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn probe() -> ProbeResult {
    ProbeResult {
        protocol_version: PROTOCOL_VERSION,
        available: false,
        backend: "unsupported",
        reason: Some("unsupported_platform"),
    }
}
