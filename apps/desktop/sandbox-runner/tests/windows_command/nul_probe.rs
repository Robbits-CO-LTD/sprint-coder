//! Read-only diagnostic for issue #733 (origin #694).
//!
//! Inside the product's AppContainer on the hosted windows-2022 runner, an ignored-stdio
//! Node child and an explicit NUL open fail with libuv `EPERM`, while they succeed on the
//! host. libuv hides the Win32 error, so this probe observes it directly:
//!   1. the `GetLastError` of opening `\\.\NUL` / `NUL` with several access masks,
//!   2. the security descriptor (SDDL) of the NUL device, with the ALL APPLICATION
//!      PACKAGES (S-1-15-2-1) / ALL RESTRICTED APPLICATION PACKAGES (S-1-15-2-2) ACEs,
//!   3. the raw OS error of spawning a child with each stdio slot redirected to NUL.
//!
//! It only opens existing devices and reads descriptors. It changes no ACL, policy,
//! registry value or sandbox permission, and it never fails the build: the output is the
//! evidence. Each observation is one `[#733-probe] {json}` line without env or user paths.

use serde_json::{Value, json};
use std::ffi::OsStr;
use std::io::Write;
use std::os::windows::ffi::OsStrExt;
use std::process::{Command, Stdio};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE, LocalFree,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSecurityDescriptorToStringSecurityDescriptorW, GetSecurityInfo, SDDL_REVISION_1,
    SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    DACL_SECURITY_INFORMATION, GROUP_SECURITY_INFORMATION, GetTokenInformation,
    LABEL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, SECURITY_ATTRIBUTES, TOKEN_QUERY,
    TokenIsAppContainer,
};
use windows_sys::Win32::Storage::FileSystem::CreateFileW;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

pub const LINE_PREFIX: &str = "[#733-probe] ";

const GENERIC_READ: u32 = 0x8000_0000;
const GENERIC_WRITE: u32 = 0x4000_0000;
const FILE_GENERIC_READ: u32 = 0x0012_0089;
const FILE_GENERIC_WRITE: u32 = 0x0012_0116;
const FILE_READ_ATTRIBUTES: u32 = 0x80;
const READ_CONTROL: u32 = 0x0002_0000;
const FILE_SHARE_READ_WRITE: u32 = 3;
const OPEN_EXISTING: u32 = 3;

pub fn enabled() -> bool {
    std::env::var_os("GITHUB_ACTIONS").is_some()
        || std::env::var("SPRINT_CODER_NUL_PROBE").is_ok_and(|v| v == "1")
}

fn wide(text: &str) -> Vec<u16> {
    OsStr::new(text).encode_wide().chain(Some(0)).collect()
}

/// Opens an existing device and returns (opened, GetLastError()). The handle is closed.
fn open_nul(path: &str, access: u32, inheritable: bool) -> (bool, u32) {
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: i32::from(inheritable),
    };
    let path = wide(path);
    // SAFETY: `path` is NUL-terminated and `attributes` outlives the call.
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            access,
            FILE_SHARE_READ_WRITE,
            if inheritable {
                &attributes
            } else {
                std::ptr::null()
            },
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        // SAFETY: reads the calling thread's last-error value right after the failed call.
        (false, unsafe { GetLastError() })
    } else {
        // SAFETY: `handle` was returned by a successful CreateFileW above.
        unsafe { CloseHandle(handle) };
        (true, 0)
    }
}

fn opens() -> Vec<Value> {
    // The first three are plain masks; `libuv_*` reproduce the CreateFileW libuv issues for
    // `stdio: 'ignore'` (inheritable handle, FILE_GENERIC_* masks); the rest bisect the mask.
    let masks: [(&str, u32, bool); 8] = [
        ("read", GENERIC_READ, false),
        ("write", GENERIC_WRITE, false),
        ("read_write", GENERIC_READ | GENERIC_WRITE, false),
        ("libuv_stdin", FILE_GENERIC_READ, true),
        (
            "libuv_stdout",
            FILE_GENERIC_WRITE | FILE_READ_ATTRIBUTES,
            true,
        ),
        ("read_attributes", FILE_READ_ATTRIBUTES, false),
        ("read_control", READ_CONTROL, false),
        ("no_access", 0, false),
    ];
    let mut rows = Vec::new();
    for path in [r"\\.\NUL", "NUL"] {
        for (name, access, inheritable) in masks {
            let (ok, win32) = open_nul(path, access, inheritable);
            rows.push(json!({"path": path, "access": name, "ok": ok, "win32": win32}));
        }
    }
    rows
}

fn sddl_of(handle: HANDLE, information: u32) -> Result<String, u32> {
    let mut descriptor = std::ptr::null_mut();
    // SAFETY: out-pointers are valid; the descriptor is released with LocalFree below.
    let status = unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            information,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(status);
    }
    let mut text: *mut u16 = std::ptr::null_mut();
    // SAFETY: `descriptor` came from GetSecurityInfo; `text` is released with LocalFree.
    let converted = unsafe {
        ConvertSecurityDescriptorToStringSecurityDescriptorW(
            descriptor,
            SDDL_REVISION_1,
            information,
            &mut text,
            std::ptr::null_mut(),
        )
    };
    let result = if converted == 0 {
        // SAFETY: last-error of the failed conversion above.
        Err(unsafe { GetLastError() })
    } else {
        let mut len = 0;
        // SAFETY: `text` is a NUL-terminated UTF-16 string from the OS.
        let value = unsafe {
            while *text.add(len) != 0 {
                len += 1;
            }
            String::from_utf16_lossy(std::slice::from_raw_parts(text, len))
        };
        Ok(value)
    };
    // SAFETY: both pointers were allocated by the OS for this call (or are null).
    unsafe {
        if !text.is_null() {
            LocalFree(text.cast());
        }
        LocalFree(descriptor);
    }
    result
}

/// True when an ACE of the SDDL names `sid` (or its alias) as trustee.
fn has_trustee(sddl: &str, names: &[&str]) -> bool {
    sddl.split('(').skip(1).any(|ace| {
        let body = ace.split(')').next().unwrap_or("");
        body.rsplit(';')
            .next()
            .is_some_and(|trustee| names.contains(&trustee))
    })
}

/// Reads the NUL device descriptor through a READ_CONTROL-only handle. Nothing is written.
fn nul_security() -> Value {
    let path = wide(r"\\.\NUL");
    // SAFETY: `path` is NUL-terminated.
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            READ_CONTROL,
            FILE_SHARE_READ_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        // SAFETY: last-error of the failed open above.
        return json!({"opened": false, "win32": unsafe { GetLastError() }});
    }
    let full = OWNER_SECURITY_INFORMATION
        | GROUP_SECURITY_INFORMATION
        | DACL_SECURITY_INFORMATION
        | LABEL_SECURITY_INFORMATION;
    let (scope, result) = match sddl_of(handle, full) {
        Ok(text) => ("owner_group_dacl_label", Ok(text)),
        Err(_) => ("dacl", sddl_of(handle, DACL_SECURITY_INFORMATION)),
    };
    // SAFETY: `handle` was returned by a successful CreateFileW above.
    unsafe { CloseHandle(handle) };
    match result {
        Ok(sddl) => json!({
            "opened": true,
            "scope": scope,
            "all_application_packages_ace": has_trustee(&sddl, &["AC", "S-1-15-2-1"]),
            "all_restricted_application_packages_ace": has_trustee(&sddl, &["S-1-15-2-2"]),
            "sddl": sddl,
        }),
        Err(win32) => json!({"opened": true, "sddl_win32": win32}),
    }
}

fn is_app_container() -> Value {
    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: valid out-pointer; the pseudo process handle needs no close.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        // SAFETY: last-error of the failed call above.
        return json!({"win32": unsafe { GetLastError() }});
    }
    let mut flag: u32 = 0;
    let mut returned = 0;
    // SAFETY: the buffer is a u32, as TokenIsAppContainer requires.
    let ok = unsafe {
        GetTokenInformation(
            token,
            TokenIsAppContainer,
            (&mut flag as *mut u32).cast(),
            4,
            &mut returned,
        )
    };
    // SAFETY: `token` was opened above.
    unsafe { CloseHandle(token) };
    if ok == 0 {
        json!({"query_failed": true})
    } else {
        json!(flag != 0)
    }
}

/// Spawns `cmd.exe /c exit 0` with one stdio slot redirected to NUL by the Rust runtime,
/// which reports the raw OS error of whichever step (NUL open or process creation) failed.
fn spawn_rows() -> Vec<Value> {
    let Some(root) = std::env::var_os("SystemRoot") else {
        return vec![json!({"skipped": "no_system_root"})];
    };
    let cmd = std::path::Path::new(&root).join("System32").join("cmd.exe");
    let mut rows = Vec::new();
    for slot in ["none", "stdin", "stdout", "stderr"] {
        let mut command = Command::new(&cmd);
        command
            .args(["/c", "exit", "0"])
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        match slot {
            "stdin" => command.stdin(Stdio::null()),
            "stdout" => command.stdout(Stdio::null()),
            "stderr" => command.stderr(Stdio::null()),
            _ => &mut command,
        };
        rows.push(match command.status() {
            Ok(status) => json!({"null_slot": slot, "ok": true, "exit": status.code()}),
            Err(error) => json!({"null_slot": slot, "ok": false, "win32": error.raw_os_error()}),
        });
    }
    rows
}

pub fn observe(side: &str) -> Value {
    json!({
        "probe": "#733",
        "side": side,
        "app_container": is_app_container(),
        "opens": opens(),
        "nul_security": nul_security(),
        "spawn": spawn_rows(),
    })
}

pub fn line(value: &Value) -> String {
    format!("{LINE_PREFIX}{value}\n")
}

/// Writes straight to the real stderr: libtest only captures print macros, so the line
/// reaches the CI log without `--nocapture`.
pub fn emit_stderr(value: &Value) {
    let _ = std::io::stderr().write_all(line(value).as_bytes());
}

/// Keeps launch failures useful but free of local paths.
pub fn redact(text: &str) -> String {
    let mut out = text.to_string();
    for secret in [
        std::env::var("USERPROFILE").ok(),
        std::env::current_dir()
            .ok()
            .map(|p| p.display().to_string()),
    ]
    .into_iter()
    .flatten()
    {
        if !secret.is_empty() {
            out = out.replace(&secret, "<path>");
        }
    }
    out.chars().take(400).collect()
}
