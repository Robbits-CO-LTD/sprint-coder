use std::ffi::c_void;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use windows_sys::Win32::Foundation::{
    CloseHandle, DUPLICATE_SAME_ACCESS, DuplicateHandle, GetLastError, HANDLE,
    INVALID_HANDLE_VALUE, LocalFree, WAIT_ABANDONED, WAIT_OBJECT_0,
};
use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows_sys::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeleteAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
};
use windows_sys::Win32::Security::{FreeSid, PSID, SECURITY_CAPABILITIES};
use windows_sys::Win32::System::Console::{
    GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;
use windows_sys::Win32::System::Threading::{
    CreateMutexW, CreateProcessW, DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT,
    GetCurrentProcess, GetExitCodeProcess, INFINITE, InitializeProcThreadAttributeList,
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
    PROCESS_INFORMATION, ReleaseMutex, STARTF_USESTDHANDLES, STARTUPINFOEXW,
    UpdateProcThreadAttribute, WaitForSingleObject,
};

static PROFILE_NONCE: AtomicU64 = AtomicU64::new(0);

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
    let _ = std::fs::remove_dir_all(&base);
    if std::fs::create_dir_all(&inside).is_err() || std::fs::create_dir_all(&outside).is_err() {
        return Err("appcontainer_probe_setup_failed".to_owned());
    }
    let inside_marker = inside.join("allowed.txt");
    let outside_marker = outside.join("denied.txt");
    let probe_executable = inside.join("probe-runner.exe");
    let current_executable =
        std::env::current_exe().map_err(|_| "appcontainer_probe_executable_failed".to_owned())?;
    if std::fs::copy(current_executable, &probe_executable).is_err() {
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
    let execution = execute_impl(
        &inside,
        &probe_executable.to_string_lossy(),
        &[
            "--windows-probe-child".into(),
            inside_marker.to_string_lossy().into_owned(),
            outside_marker.to_string_lossy().into_owned(),
            port.to_string(),
        ],
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

pub fn run_probe_child(inside_marker: &Path, outside_marker: &Path, port: u16) -> u8 {
    let _ = std::fs::write(inside_marker, b"inside");
    let _ = std::fs::write(outside_marker, b"outside");
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let _ = TcpStream::connect_timeout(&address, Duration::from_secs(1));
    0
}

pub fn execute(root: &Path, executable: &str, argv: &[String]) -> u8 {
    execute_impl(root, executable, argv).unwrap_or(70)
}

fn execute_impl(root: &Path, executable: &str, argv: &[String]) -> Result<u8, String> {
    let Ok(root) = std::fs::canonicalize(root) else {
        return Err("appcontainer_workspace_resolution_failed".to_owned());
    };
    let workspace_profile = appcontainer_workspace_profile(&root);
    let _workspace_mutex = acquire_workspace_mutex(&workspace_profile)?;
    let profile = appcontainer_profile_name(&workspace_profile);
    let Some(sid) = appcontainer_sid(&profile) else {
        return Err("appcontainer_profile_failed".to_owned());
    };
    let sid_string = match sid_string(sid.0) {
        Some(value) => value,
        None => {
            drop(sid);
            let _ = delete_appcontainer_profile(&profile);
            return Err("appcontainer_sid_string_failed".to_owned());
        }
    };
    let executable_path = Path::new(executable);
    let executable_acl_required =
        !is_windows_system_path(executable_path) && !is_path_inside(&root, executable_path);
    let executable_directory = executable_acl_required
        .then(|| executable_path.parent())
        .flatten();
    if !set_workspace_acl(&root, &sid_string)
        || executable_directory.is_some_and(|path| !set_read_tree_acl(path, &sid_string))
    {
        let _ = remove_inherited_acl(&root, &sid_string);
        if let Some(path) = executable_directory {
            let _ = remove_tree_acl(path, &sid_string);
        }
        drop(sid);
        let _ = delete_appcontainer_profile(&profile);
        return Err("appcontainer_acl_failed".to_owned());
    }
    let result = spawn_appcontainer(sid.0, &root, executable, argv);
    let workspace_acl_removed = remove_inherited_acl(&root, &sid_string);
    let executable_acl_removed =
        executable_directory.is_none_or(|path| remove_tree_acl(path, &sid_string));
    drop(sid);
    let profile_deleted = delete_appcontainer_profile(&profile);
    if !workspace_acl_removed || !executable_acl_removed || !profile_deleted {
        return Err("appcontainer_cleanup_failed".to_owned());
    }
    result.map_err(|code| format!("appcontainer_process_failed_{code}"))
}

fn appcontainer_workspace_profile(root: &Path) -> String {
    let mut hasher = DefaultHasher::new();
    root.to_string_lossy().to_lowercase().hash(&mut hasher);
    format!("SprintCoder.ManagedCommand.{:016x}", hasher.finish())
}

fn appcontainer_profile_name(workspace_profile: &str) -> String {
    let counter = PROFILE_NONCE.fetch_add(1, Ordering::Relaxed);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut hasher = DefaultHasher::new();
    std::process::id().hash(&mut hasher);
    counter.hash(&mut hasher);
    timestamp.hash(&mut hasher);
    format!("{workspace_profile}.{:016x}", hasher.finish())
}

fn delete_appcontainer_profile(profile: &str) -> bool {
    let name = wide(profile);
    // SAFETY: name is a live, NUL-terminated UTF-16 profile name created by this runner.
    unsafe { DeleteAppContainerProfile(name.as_ptr()) >= 0 }
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
    let candidate = normalized_windows_path(path);
    let root = normalized_windows_path(&windows_root);
    candidate == root || candidate.starts_with(&format!("{root}\\"))
}

fn is_path_inside(root: &Path, candidate: &Path) -> bool {
    let root = normalized_windows_path(root);
    let candidate = normalized_windows_path(candidate);
    candidate == root || candidate.starts_with(&format!("{root}\\"))
}

fn normalized_windows_path(path: &Path) -> String {
    win32_process_path(&path.to_string_lossy())
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

fn appcontainer_sid(name: &str) -> Option<OwnedSid> {
    let name_wide = wide(name);
    // SAFETY: Every string is NUL-terminated, all output pointers are valid, and both APIs return
    // a SID allocation with ownership transferred to the caller for release via FreeSid.
    unsafe {
        let mut sid: PSID = std::ptr::null_mut();
        let display = wide("Sprint Coder Managed Command");
        let description = wide("Per-workspace command sandbox");
        let created = CreateAppContainerProfile(
            name_wide.as_ptr(),
            display.as_ptr(),
            description.as_ptr(),
            std::ptr::null(),
            0,
            &mut sid,
        );
        const HRESULT_ALREADY_EXISTS: i32 = 0x8007_00b7_u32 as i32;
        if created < 0
            && (created != HRESULT_ALREADY_EXISTS
                || DeriveAppContainerSidFromAppContainerName(name_wide.as_ptr(), &mut sid) < 0)
        {
            return None;
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

fn set_workspace_acl(path: &Path, sid: &str) -> bool {
    // workspace-write is still bounded by the user's existing OS ACLs. Grant at the root so
    // ordinary descendants inherit access, but deliberately do not traverse and rewrite entries
    // whose inheritance was disabled; doing so is O(files) and stalls commands in large repos.
    let grant = format!("*{sid}:(OI)(CI)M");
    let Some(icacls) = trusted_system_executable("icacls.exe") else {
        return false;
    };
    let mut command = Command::new(icacls);
    command.arg(path).args(["/grant", &grant, "/C", "/Q"]);
    command.stdout(Stdio::null()).stderr(Stdio::null());
    command.status().is_ok_and(|status| status.success())
}

fn set_read_tree_acl(path: &Path, sid: &str) -> bool {
    let grant = format!("*{sid}:(OI)(CI)RX");
    let Some(icacls) = trusted_system_executable("icacls.exe") else {
        return false;
    };
    let mut command = Command::new(icacls);
    command
        .arg(path)
        .args(["/grant", &grant, "/C", "/Q", "/T"])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command.status().is_ok_and(|status| status.success())
}

fn remove_inherited_acl(path: &Path, sid: &str) -> bool {
    let Some(icacls) = trusted_system_executable("icacls.exe") else {
        return false;
    };
    let mut command = Command::new(icacls);
    command
        .arg(path)
        .args(["/remove", &format!("*{sid}"), "/C", "/Q"]);
    command.stdout(Stdio::null()).stderr(Stdio::null());
    command.status().is_ok_and(|status| status.success())
}

fn remove_tree_acl(path: &Path, sid: &str) -> bool {
    let Some(icacls) = trusted_system_executable("icacls.exe") else {
        return false;
    };
    let mut command = Command::new(icacls);
    command
        .arg(path)
        .args(["/remove", &format!("*{sid}"), "/C", "/Q", "/T"])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command.status().is_ok_and(|status| status.success())
}

fn trusted_system_executable(name: &str) -> Option<PathBuf> {
    let mut buffer = vec![0u16; 261];
    // SAFETY: buffer is writable for its declared length. GetSystemDirectoryW writes at most that
    // many UTF-16 code units and returns the required length when the buffer is too small.
    let mut length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
    if length == 0 {
        return None;
    }
    if length as usize >= buffer.len() {
        buffer.resize(length as usize + 1, 0);
        // SAFETY: the resized buffer is writable for its declared length.
        length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
        if length == 0 || length as usize >= buffer.len() {
            return None;
        }
    }
    let directory = std::ffi::OsString::from_wide(&buffer[..length as usize]);
    Some(PathBuf::from(directory).join(name))
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
    let mut command_line = wide(windows_command_line(&executable, argv));
    let cwd = wide(&cwd);
    // SAFETY: PROCESS_INFORMATION's all-zero state is the documented output initialization.
    let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: All pointers reference live NUL-terminated or writable buffers; startup contains the
    // initialized two-attribute list; only the three HANDLE_LIST entries may be inherited.
    let ok = unsafe {
        CreateProcessW(
            std::ptr::null(),
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
