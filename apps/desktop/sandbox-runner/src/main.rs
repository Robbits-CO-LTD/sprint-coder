use serde::Serialize;
use std::path::Path;
use std::process::{Command, ExitCode};

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
    let available = executable.is_file()
        && Command::new(executable)
            .args(["-p", "(version 1) (allow default)", "--", "/usr/bin/true"])
            .status()
            .is_ok_and(|status| status.success());
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
    let available = executable.is_some_and(|bwrap| {
        Command::new(bwrap)
            .args([
                "--unshare-all",
                "--new-session",
                "--die-with-parent",
                "--ro-bind",
                "/",
                "/",
                "--proc",
                "/proc",
                "--dev",
                "/dev",
                "--",
                "/bin/true",
            ])
            .status()
            .is_ok_and(|status| status.success())
    });
    ProbeResult {
        protocol_version: PROTOCOL_VERSION,
        available,
        backend: "linux-bubblewrap-landlock",
        reason: (!available).then_some("bubblewrap_probe_failed"),
    }
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
