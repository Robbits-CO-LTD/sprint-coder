use std::ffi::c_void;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::net::{Ipv4Addr, TcpListener};
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::process::{Command, Stdio};
use windows_sys::Win32::Foundation::{
    CloseHandle, DUPLICATE_SAME_ACCESS, DuplicateHandle, GetLastError, HANDLE,
    INVALID_HANDLE_VALUE, LocalFree, WAIT_ABANDONED, WAIT_OBJECT_0,
};
use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows_sys::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
};
use windows_sys::Win32::Security::{FreeSid, PSID, SECURITY_CAPABILITIES};
use windows_sys::Win32::System::Console::{
    GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows_sys::Win32::System::Threading::{
    CreateMutexW, CreateProcessW, DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT,
    GetCurrentProcess, GetExitCodeProcess, INFINITE, InitializeProcThreadAttributeList,
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
    PROCESS_INFORMATION, ReleaseMutex, STARTF_USESTDHANDLES, STARTUPINFOEXW,
    UpdateProcThreadAttribute, WaitForSingleObject,
};

struct OwnedSid(PSID);
impl Drop for OwnedSid {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: Both AppContainer SID creation APIs transfer one SID allocation whose
            // documented release function is FreeSid. OwnedSid has unique ownership.
            unsafe { FreeSid(self.0) };
        }
    }
}

struct WorkspaceMutex(HANDLE);

impl Drop for WorkspaceMutex {
    fn drop(&mut self) {
        // SAFETY: The handle is a successfully acquired mutex owned by this guard. ReleaseMutex
        // relinquishes this thread's ownership and CloseHandle releases the unique handle value.
        unsafe {
            ReleaseMutex(self.0);
            CloseHandle(self.0);
        }
    }
}

struct OwnedHandles([HANDLE; 3]);

impl OwnedHandles {
    fn duplicate_standard_handles() -> Result<Self, u32> {
        // SAFETY: GetCurrentProcess returns the documented pseudo-handle valid in this process.
        let process = unsafe { GetCurrentProcess() };
        let sources = [
            // SAFETY: GetStdHandle accepts these three constant selector values.
            unsafe { GetStdHandle(STD_INPUT_HANDLE) },
            unsafe { GetStdHandle(STD_OUTPUT_HANDLE) },
            unsafe { GetStdHandle(STD_ERROR_HANDLE) },
        ];
        if sources
            .iter()
            .any(|handle| handle.is_null() || *handle == INVALID_HANDLE_VALUE)
        {
            // SAFETY: GetLastError has no preconditions and captures the failing Win32 call.
            return Err(unsafe { GetLastError() });
        }
        let mut duplicates = [std::ptr::null_mut(); 3];
        for (index, source) in sources.into_iter().enumerate() {
            // SAFETY: source and process are valid handles; duplicates[index] is writable storage.
            // The new handle is explicitly inheritable and is closed by OwnedHandles.
            if unsafe {
                DuplicateHandle(
                    process,
                    source,
                    process,
                    &mut duplicates[index],
                    0,
                    1,
                    DUPLICATE_SAME_ACCESS,
                )
            } == 0
            {
                // SAFETY: Only non-null handles from earlier successful iterations are closed.
                for handle in duplicates.into_iter().filter(|handle| !handle.is_null()) {
                    unsafe { CloseHandle(handle) };
                }
                // SAFETY: GetLastError has no preconditions and captures DuplicateHandle failure.
                return Err(unsafe { GetLastError() });
            }
        }
        Ok(Self(duplicates))
    }
}

impl Drop for OwnedHandles {
    fn drop(&mut self) {
        for handle in self.0 {
            // SAFETY: Each entry is a unique handle returned by DuplicateHandle.
            unsafe { CloseHandle(handle) };
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
    let system_root = std::env::var_os("SystemRoot")
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "appcontainer_probe_system_root_failed".to_owned())?;
    let command_source = system_root.join("System32").join("cmd.exe");
    let command_executable = inside.join("probe-cmd.exe");
    if std::fs::copy(command_source, &command_executable).is_err() {
        return Err("appcontainer_probe_executable_failed".to_owned());
    }
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|_| "appcontainer_probe_listener_failed".to_owned())?;
    listener
        .set_nonblocking(true)
        .map_err(|_| "appcontainer_probe_listener_failed".to_owned())?;
    let port = listener
        .local_addr()
        .map_err(|_| "appcontainer_probe_listener_failed".to_owned())?
        .port();
    let curl_source = system_root.join("System32").join("curl.exe");
    let curl_executable = inside.join("probe-curl.exe");
    if std::fs::copy(curl_source, &curl_executable).is_err() {
        let _ = std::fs::remove_dir_all(base);
        return Err("appcontainer_probe_network_executable_failed".to_owned());
    }
    let script = format!(
        "(echo inside>\"{}\" & echo outside>\"{}\") >NUL 2>NUL & \"{}\" --silent --output NUL --max-time 1 http://127.0.0.1:{port}/ >NUL 2>NUL",
        inside_marker.display(),
        outside_marker.display(),
        curl_executable.display(),
    );
    let execution = execute_impl(
        &inside,
        &command_executable.to_string_lossy(),
        &["/D".into(), "/S".into(), "/C".into(), script],
    );
    let result = match execution {
        Ok(_) if !inside_marker.is_file() => {
            Err("appcontainer_probe_workspace_write_failed".to_owned())
        }
        Ok(_) if outside_marker.exists() => {
            Err("appcontainer_probe_outside_write_succeeded".to_owned())
        }
        Ok(_) if listener.accept().is_ok() => {
            Err("appcontainer_probe_network_succeeded".to_owned())
        }
        Ok(_) => Ok(()),
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
    let _workspace_mutex = acquire_workspace_mutex(&profile)?;
    let Some(sid) = appcontainer_sid(&profile) else {
        return Err("appcontainer_profile_failed".to_owned());
    };
    let Some(sid_string) = sid_string(sid.0) else {
        return Err("appcontainer_sid_string_failed".to_owned());
    };
    let executable_path = Path::new(executable);
    let executable_acl_required =
        !is_windows_system_path(executable_path) && !is_path_inside(&root, executable_path);
    let executable_ancestors = if executable_acl_required {
        executable_path
            .parent()
            .into_iter()
            .flat_map(Path::ancestors)
            .filter(|path| path.parent().is_some())
            .map(Path::to_path_buf)
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    if !set_acl(&root, &sid_string, true)
        || (executable_acl_required && !set_acl(executable_path, &sid_string, false))
        || executable_ancestors
            .iter()
            .any(|path| !set_acl(path, &sid_string, false))
    {
        remove_acl(&root, &sid_string, true);
        if executable_acl_required {
            remove_acl(executable_path, &sid_string, false);
        }
        for path in executable_ancestors.iter().rev() {
            remove_acl(path, &sid_string, false);
        }
        return Err("appcontainer_acl_failed".to_owned());
    }
    let result = spawn_appcontainer(sid.0, &root, executable, argv);
    remove_acl(&root, &sid_string, true);
    if executable_acl_required {
        remove_acl(executable_path, &sid_string, false);
    }
    for path in executable_ancestors.iter().rev() {
        remove_acl(path, &sid_string, false);
    }
    result.map_err(|code| format!("appcontainer_process_failed_{code}"))
}

fn acquire_workspace_mutex(profile: &str) -> Result<WorkspaceMutex, String> {
    let name = wide(format!(r"Local\{profile}.AclLease"));
    // SAFETY: The security descriptor is null (current-user defaults), the name is NUL-terminated,
    // and the returned handle is uniquely owned by WorkspaceMutex.
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
    if handle.is_null() {
        return Err("appcontainer_mutex_create_failed".to_owned());
    }
    // SAFETY: handle is a valid mutex handle. An abandoned mutex still grants ownership and is
    // safe to use; it indicates that the previous helper exited before ACL cleanup.
    let wait = unsafe { WaitForSingleObject(handle, INFINITE) };
    if wait != WAIT_OBJECT_0 && wait != WAIT_ABANDONED {
        // SAFETY: Ownership was not acquired, so only the handle itself must be closed.
        unsafe { CloseHandle(handle) };
        return Err("appcontainer_mutex_wait_failed".to_owned());
    }
    Ok(WorkspaceMutex(handle))
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

fn is_path_inside(root: &Path, candidate: &Path) -> bool {
    let root = root
        .to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase();
    let candidate = candidate
        .to_string_lossy()
        .replace('/', "\\")
        .to_lowercase();
    candidate == root || candidate.starts_with(&format!("{root}\\"))
}

fn appcontainer_sid(name: &str) -> Option<OwnedSid> {
    let name_wide = wide(name);
    // SAFETY: Every string is NUL-terminated, all output pointers are valid, and both APIs return
    // a SID allocation with ownership transferred to the caller for release via FreeSid.
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
    // SAFETY: sid comes from a successful AppContainer API. ConvertSidToStringSidW writes one
    // LocalAlloc-owned NUL-terminated UTF-16 pointer, released exactly once with LocalFree.
    unsafe {
        let mut value = std::ptr::null_mut();
        if ConvertSidToStringSidW(sid, &mut value) == 0 {
            return None;
        }
        let mut len = 0usize;
        while len < 256 && *value.add(len) != 0 {
            len += 1;
        }
        if len == 256 {
            LocalFree(value as *mut c_void);
            return None;
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

fn spawn_appcontainer(sid: PSID, cwd: &Path, executable: &str, argv: &[String]) -> Result<u8, u32> {
    let std_handles = OwnedHandles::duplicate_standard_handles()?;
    let mut size = 0usize;
    // SAFETY: A null list is the documented size query. Two attributes are installed below.
    unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 2, 0, &mut size) };
    if size == 0 {
        // SAFETY: GetLastError has no preconditions and captures the size-query failure.
        return Err(unsafe { GetLastError() });
    }
    // PROC_THREAD_ATTRIBUTE_LIST is opaque but pointer-aligned. usize storage provides alignment
    // while the rounded word count provides at least the exact byte size requested by Windows.
    let mut buffer = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
    let list = buffer.as_mut_ptr().cast();
    // SAFETY: list points to aligned writable storage of at least size bytes and lives until after
    // DeleteProcThreadAttributeList and CreateProcessW finish.
    if unsafe { InitializeProcThreadAttributeList(list, 2, 0, &mut size) } == 0 {
        // SAFETY: GetLastError has no preconditions and captures initialization failure.
        return Err(unsafe { GetLastError() });
    }
    let mut capabilities = SECURITY_CAPABILITIES {
        AppContainerSid: sid,
        Capabilities: std::ptr::null_mut(),
        CapabilityCount: 0,
        Reserved: 0,
    };
    let updated = unsafe {
        // SAFETY: list is initialized, capabilities and sid remain alive through CreateProcessW,
        // and the byte size exactly matches SECURITY_CAPABILITIES.
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
        // SAFETY: list was initialized successfully and has not yet been deleted.
        unsafe { DeleteProcThreadAttributeList(list) };
        // SAFETY: GetLastError captures UpdateProcThreadAttribute failure.
        return Err(unsafe { GetLastError() });
    }
    // SAFETY: The list is initialized; the three duplicated handles are valid, explicitly
    // inheritable, and remain alive through CreateProcessW. HANDLE_LIST ensures no other
    // inheritable handle from the runner can cross the AppContainer boundary.
    let handles_updated = unsafe {
        UpdateProcThreadAttribute(
            list,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            std_handles.0.as_ptr().cast_mut().cast(),
            std::mem::size_of_val(&std_handles.0),
            std::ptr::null_mut(),
            std::ptr::null(),
        )
    };
    if handles_updated == 0 {
        // SAFETY: list was initialized successfully and has not yet been deleted.
        unsafe { DeleteProcThreadAttributeList(list) };
        // SAFETY: GetLastError captures HANDLE_LIST installation failure.
        return Err(unsafe { GetLastError() });
    }
    // SAFETY: STARTUPINFOEXW and PROCESS_INFORMATION are plain Win32 output structures whose all-
    // zero representation is their documented initialization state before setting required fields.
    let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = std_handles.0[0];
    startup.StartupInfo.hStdOutput = std_handles.0[1];
    startup.StartupInfo.hStdError = std_handles.0[2];
    startup.lpAttributeList = list;
    let executable = win32_process_path(executable);
    let cwd = win32_process_path(&cwd.to_string_lossy());
    let application = wide(&executable);
    let mut command_line = wide(windows_command_line(&executable, argv));
    let cwd = wide(&cwd);
    // SAFETY: PROCESS_INFORMATION's all-zero state is the documented output initialization.
    let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: All pointers reference live NUL-terminated or writable buffers; startup contains the
    // initialized two-attribute list; only the three HANDLE_LIST entries may be inherited.
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
    // SAFETY: list was initialized successfully and CreateProcessW has consumed its attributes.
    unsafe { DeleteProcThreadAttributeList(list) };
    if ok == 0 {
        // SAFETY: GetLastError captures CreateProcessW failure.
        return Err(unsafe { GetLastError() });
    }
    // SAFETY: CreateProcessW succeeded and returned two uniquely owned valid handles.
    unsafe { CloseHandle(process.hThread) };
    // SAFETY: process.hProcess remains valid until the wait and exit-code read complete.
    unsafe { WaitForSingleObject(process.hProcess, INFINITE) };
    let mut exit_code = 1u32;
    // SAFETY: process.hProcess is valid and exit_code points to writable storage.
    let read = unsafe { GetExitCodeProcess(process.hProcess, &mut exit_code) };
    // SAFETY: This is the unique remaining process handle returned by CreateProcessW.
    unsafe { CloseHandle(process.hProcess) };
    if read == 0 {
        // SAFETY: GetLastError captures GetExitCodeProcess failure.
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

fn win32_process_path(value: &str) -> String {
    if let Some(path) = value.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{path}");
    }
    value.strip_prefix(r"\\?\").unwrap_or(value).to_owned()
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
