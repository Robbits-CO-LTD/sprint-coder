use std::ffi::c_void;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::process::{Command, Stdio};
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, LocalFree};
use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows_sys::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
};
use windows_sys::Win32::Security::{FreeSid, PSID, SECURITY_CAPABILITIES};
use windows_sys::Win32::System::Console::{
    GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT,
    GetExitCodeProcess, INFINITE, InitializeProcThreadAttributeList,
    PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, PROCESS_INFORMATION, STARTF_USESTDHANDLES,
    STARTUPINFOEXW, UpdateProcThreadAttribute, WaitForSingleObject,
};

struct OwnedSid(PSID);
impl Drop for OwnedSid {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { FreeSid(self.0) };
        }
    }
}

pub fn restricted_token_probe() -> Result<(), String> {
    let base = std::env::temp_dir().join(format!(
        "sprint-coder-windows-sandbox-{}",
        std::process::id()
    ));
    let inside = base.join("inside");
    let outside = base.join("outside");
    if std::fs::create_dir_all(&inside).is_err() || std::fs::create_dir_all(&outside).is_err() {
        return Err("appcontainer_probe_setup_failed".to_owned());
    }
    let inside_marker = inside.join("allowed.txt");
    let outside_marker = outside.join("denied.txt");
    let script = format!(
        "(echo inside>\"{}\" & echo outside>\"{}\") >NUL 2>NUL",
        inside_marker.display(),
        outside_marker.display()
    );
    let execution = execute_impl(
        &inside,
        r"C:\Windows\System32\cmd.exe",
        &["/D".into(), "/S".into(), "/C".into(), script],
    );
    let result = match execution {
        Ok(0) if inside_marker.is_file() && !outside_marker.exists() => Ok(()),
        Ok(0) if !inside_marker.is_file() => {
            Err("appcontainer_probe_workspace_write_failed".to_owned())
        }
        Ok(0) => Err("appcontainer_probe_outside_write_succeeded".to_owned()),
        Ok(code) => Err(format!("appcontainer_probe_command_failed_{code}")),
        Err(reason) => Err(reason),
    };
    let _ = std::fs::remove_dir_all(base);
    result
}

pub fn execute(root: &Path, executable: &str, argv: &[String]) -> u8 {
    execute_impl(root, executable, argv).unwrap_or(70)
}

fn execute_impl(root: &Path, executable: &str, argv: &[String]) -> Result<u8, String> {
    let Ok(root) = std::fs::canonicalize(root) else {
        return Err("appcontainer_workspace_resolution_failed".to_owned());
    };
    let mut hasher = DefaultHasher::new();
    root.to_string_lossy().to_lowercase().hash(&mut hasher);
    let profile = format!("SprintCoder.ManagedCommand.{:016x}", hasher.finish());
    let Some(sid) = appcontainer_sid(&profile) else {
        return Err("appcontainer_profile_failed".to_owned());
    };
    let Some(sid_string) = sid_string(sid.0) else {
        return Err("appcontainer_sid_string_failed".to_owned());
    };
    let executable_path = Path::new(executable);
    let executable_acl_required = !is_windows_system_path(executable_path);
    if !set_acl(&root, &sid_string, true)
        || (executable_acl_required && !set_acl(executable_path, &sid_string, false))
    {
        remove_acl(&root, &sid_string, true);
        if executable_acl_required {
            remove_acl(executable_path, &sid_string, false);
        }
        return Err("appcontainer_acl_failed".to_owned());
    }
    let result = unsafe { spawn_appcontainer(sid.0, &root, executable, argv) };
    remove_acl(&root, &sid_string, true);
    if executable_acl_required {
        remove_acl(executable_path, &sid_string, false);
    }
    result.map_err(|code| format!("appcontainer_process_failed_{code}"))
}

fn is_windows_system_path(path: &Path) -> bool {
    let Some(windows_root) = std::env::var_os("SystemRoot").map(std::path::PathBuf::from) else {
        return false;
    };
    let candidate = path.to_string_lossy().replace('/', "\\").to_lowercase();
    let root = windows_root
        .to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase();
    candidate == root || candidate.starts_with(&format!("{root}\\"))
}

fn appcontainer_sid(name: &str) -> Option<OwnedSid> {
    let name_wide = wide(name);
    unsafe {
        let mut sid: PSID = std::ptr::null_mut();
        if DeriveAppContainerSidFromAppContainerName(name_wide.as_ptr(), &mut sid) < 0 {
            let display = wide("Sprint Coder Managed Command");
            let description = wide("Per-workspace command sandbox");
            if CreateAppContainerProfile(
                name_wide.as_ptr(),
                display.as_ptr(),
                description.as_ptr(),
                std::ptr::null(),
                0,
                &mut sid,
            ) < 0
            {
                return None;
            }
        }
        (!sid.is_null()).then_some(OwnedSid(sid))
    }
}

fn sid_string(sid: PSID) -> Option<String> {
    unsafe {
        let mut value = std::ptr::null_mut();
        if ConvertSidToStringSidW(sid, &mut value) == 0 {
            return None;
        }
        let mut len = 0usize;
        while *value.add(len) != 0 {
            len += 1;
        }
        let result = String::from_utf16_lossy(std::slice::from_raw_parts(value, len));
        LocalFree(value as *mut c_void);
        Some(result)
    }
}

fn set_acl(path: &Path, sid: &str, recursive: bool) -> bool {
    let grant = if recursive {
        format!("*{sid}:(OI)(CI)M")
    } else {
        format!("*{sid}:RX")
    };
    let mut command = Command::new(r"C:\Windows\System32\icacls.exe");
    command.arg(path).args(["/grant", &grant, "/C", "/Q"]);
    command.stdout(Stdio::null()).stderr(Stdio::null());
    if recursive {
        command.arg("/T");
    }
    command.status().is_ok_and(|status| status.success())
}

fn remove_acl(path: &Path, sid: &str, recursive: bool) {
    let mut command = Command::new(r"C:\Windows\System32\icacls.exe");
    command
        .arg(path)
        .args(["/remove", &format!("*{sid}"), "/C", "/Q"]);
    command.stdout(Stdio::null()).stderr(Stdio::null());
    if recursive {
        command.arg("/T");
    }
    let _ = command.status();
}

unsafe fn spawn_appcontainer(
    sid: PSID,
    cwd: &Path,
    executable: &str,
    argv: &[String],
) -> Result<u8, u32> {
    let mut size = 0usize;
    unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size) };
    if size == 0 {
        return Err(unsafe { GetLastError() });
    }
    let mut buffer = vec![0u8; size];
    let list = buffer.as_mut_ptr().cast();
    if unsafe { InitializeProcThreadAttributeList(list, 1, 0, &mut size) } == 0 {
        return Err(unsafe { GetLastError() });
    }
    let mut capabilities = SECURITY_CAPABILITIES {
        AppContainerSid: sid,
        Capabilities: std::ptr::null_mut(),
        CapabilityCount: 0,
        Reserved: 0,
    };
    let updated = unsafe {
        UpdateProcThreadAttribute(
            list,
            0,
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
            (&mut capabilities as *mut SECURITY_CAPABILITIES).cast(),
            std::mem::size_of::<SECURITY_CAPABILITIES>(),
            std::ptr::null_mut(),
            std::ptr::null(),
        )
    };
    if updated == 0 {
        unsafe { DeleteProcThreadAttributeList(list) };
        return Err(unsafe { GetLastError() });
    }
    let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
    startup.StartupInfo.hStdOutput = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
    startup.StartupInfo.hStdError = unsafe { GetStdHandle(STD_ERROR_HANDLE) };
    startup.lpAttributeList = list;
    let application = wide(executable);
    let mut command_line = wide(windows_command_line(executable, argv));
    let cwd = wide(cwd.as_os_str());
    let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let ok = unsafe {
        CreateProcessW(
            application.as_ptr(),
            command_line.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
            EXTENDED_STARTUPINFO_PRESENT,
            std::ptr::null(),
            cwd.as_ptr(),
            &startup.StartupInfo,
            &mut process,
        )
    };
    unsafe { DeleteProcThreadAttributeList(list) };
    if ok == 0 {
        return Err(unsafe { GetLastError() });
    }
    unsafe { CloseHandle(process.hThread) };
    unsafe { WaitForSingleObject(process.hProcess, INFINITE) };
    let mut exit_code = 1u32;
    let read = unsafe { GetExitCodeProcess(process.hProcess, &mut exit_code) };
    unsafe { CloseHandle(process.hProcess) };
    if read == 0 {
        return Err(unsafe { GetLastError() });
    }
    Ok(exit_code.min(255) as u8)
}

fn windows_command_line(executable: &str, argv: &[String]) -> String {
    std::iter::once(executable)
        .chain(argv.iter().map(String::as_str))
        .map(quote_arg)
        .collect::<Vec<_>>()
        .join(" ")
}

fn quote_arg(value: &str) -> String {
    if !value.is_empty() && !value.chars().any(|c| c == ' ' || c == '\t' || c == '"') {
        return value.to_owned();
    }
    let mut result = String::from("\"");
    let mut slashes = 0;
    for ch in value.chars() {
        if ch == '\\' {
            slashes += 1;
            continue;
        }
        if ch == '"' {
            result.push_str(&"\\".repeat(slashes * 2 + 1));
            result.push('"');
        } else {
            result.push_str(&"\\".repeat(slashes));
            result.push(ch);
        }
        slashes = 0;
    }
    result.push_str(&"\\".repeat(slashes * 2));
    result.push('"');
    result
}

fn wide(value: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    value
        .as_ref()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}
