// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! Ending the renderer with the host that started the CLI.
//!
//! The renderer outlives every command, and a host may release the commands'
//! processes without ending them, so nothing else would remove a cursor whose
//! session the agent never ended. A host names its own process id in
//! `HOST_PID_VARIABLE`; the renderer opens that process when it starts, while
//! the host is still waiting on the command that started it, and ends itself
//! once the process has exited. Holding the handle keeps the id from naming a
//! different process later.
//!
//! An id that is present but unreadable, or a process that cannot be opened,
//! counts as a host that is already gone: a renderer whose end cannot be
//! observed is not started at all.

/// The process id of the host whose exit ends the renderer.
pub(crate) const HOST_PID_VARIABLE: &str = "SPRINT_CODER_DESKTOP_HOST_PID";

/// What the variable asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HostRequest {
    /// No host was named: the renderer lives for its session alone.
    Unwatched,
    /// The renderer ends with this process.
    Process(u32),
    /// A value was given and is not a process id.
    Invalid,
}

pub(crate) fn parse(value: Option<&str>) -> HostRequest {
    match value {
        None => HostRequest::Unwatched,
        Some(text) => match text.trim().parse::<u32>() {
            Ok(pid) if pid != 0 => HostRequest::Process(pid),
            _ => HostRequest::Invalid,
        },
    }
}

#[cfg(target_os = "windows")]
pub(crate) use imp::HostWatch;

#[cfg(target_os = "windows")]
mod imp {
    use super::{HOST_PID_VARIABLE, HostRequest, parse};
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
    };

    pub(crate) enum HostWatch {
        Unwatched,
        Watching(HANDLE),
        Gone,
    }

    impl HostWatch {
        pub(crate) fn from_env() -> Self {
            let value = std::env::var(HOST_PID_VARIABLE).ok();
            Self::for_request(parse(value.as_deref()))
        }

        pub(crate) fn for_request(request: HostRequest) -> Self {
            match request {
                HostRequest::Unwatched => Self::Unwatched,
                HostRequest::Invalid => Self::Gone,
                HostRequest::Process(pid) => {
                    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
                    if handle.is_null() {
                        Self::Gone
                    } else {
                        Self::Watching(handle)
                    }
                }
            }
        }

        /// True once the named host has exited, or could never be watched.
        pub(crate) fn host_gone(&self) -> bool {
            match self {
                Self::Unwatched => false,
                Self::Gone => true,
                Self::Watching(handle) => {
                    let state = unsafe { WaitForSingleObject(*handle, 0) };
                    state != WAIT_TIMEOUT
                }
            }
        }
    }

    impl Drop for HostWatch {
        fn drop(&mut self) {
            if let Self::Watching(handle) = self {
                unsafe { CloseHandle(*handle) };
            }
        }
    }
}

#[cfg(test)]
#[path = "host_watch_tests.rs"]
mod tests;
