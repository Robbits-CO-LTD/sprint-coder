// Changed by Sprint Coder (new file); see VENDORED.md in apps/desktop/desktop-control.
//! Ending the renderer with the host that started the CLI, as the Windows
//! renderer does (`crates/windows/src/system/cursor_overlay/host_watch.rs`).
//!
//! The renderer runs in a process group of its own, so neither the end of the
//! command that started it nor a Stop of that command's group ends it, and a
//! host that exits without ending its sessions would leave it running. A host
//! names its own process id in `HOST_PID_VARIABLE`; the renderer registers for
//! that process's exit (kqueue `EVFILT_PROC` / `NOTE_EXIT`) when it starts,
//! while the host is still waiting on the command that started it, and ends
//! itself once the exit is reported. The registration is bound to the process,
//! not to its id, so a later process given the same id is never mistaken for
//! the host.
//!
//! An id that is present but unreadable, or a process that cannot be watched
//! (already exited, a zombie, or any other registration failure), counts as a
//! host that is already gone: a renderer whose end cannot be observed is not
//! started at all.

use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

/// The process id of the host whose exit ends the renderer.
pub(super) const HOST_PID_VARIABLE: &str = "SPRINT_CODER_DESKTOP_HOST_PID";

/// What the variable asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum HostRequest {
    /// No host was named: the renderer lives for its session alone.
    Unwatched,
    /// The renderer ends with this process.
    Process(libc::pid_t),
    /// A value was given and is not a process id.
    Invalid,
}

pub(super) fn parse(value: Option<&str>) -> HostRequest {
    match value {
        None => HostRequest::Unwatched,
        Some(text) => match text.trim().parse::<libc::pid_t>() {
            Ok(pid) if pid > 0 => HostRequest::Process(pid),
            _ => HostRequest::Invalid,
        },
    }
}

pub(super) enum HostWatch {
    Unwatched,
    /// A kqueue holding the host's `NOTE_EXIT` registration.
    Watching(OwnedFd),
    Gone,
}

impl HostWatch {
    pub(super) fn from_env() -> Self {
        let value = std::env::var(HOST_PID_VARIABLE).ok();
        Self::for_request(parse(value.as_deref()))
    }

    pub(super) fn for_request(request: HostRequest) -> Self {
        match request {
            HostRequest::Unwatched => Self::Unwatched,
            HostRequest::Invalid => Self::Gone,
            HostRequest::Process(pid) => watch(pid).map_or(Self::Gone, Self::Watching),
        }
    }

    /// True once the named host has exited, or could never be watched. The
    /// exit is reported once, so it is kept here once read.
    pub(super) fn host_gone(&mut self) -> bool {
        let exited = match self {
            Self::Unwatched => return false,
            Self::Gone => return true,
            Self::Watching(queue) => exit_reported(queue),
        };
        if exited {
            *self = Self::Gone;
        }
        exited
    }
}

fn watch(pid: libc::pid_t) -> Option<OwnedFd> {
    let raw = unsafe { libc::kqueue() };
    if raw < 0 {
        return None;
    }
    let queue = unsafe { OwnedFd::from_raw_fd(raw) };
    let registration = libc::kevent {
        ident: pid as libc::uintptr_t,
        filter: libc::EVFILT_PROC,
        // A receipt answers the registration itself, success or failure, and
        // leaves the exit event queued for later polls.
        flags: libc::EV_ADD | libc::EV_RECEIPT,
        fflags: libc::NOTE_EXIT,
        data: 0,
        udata: std::ptr::null_mut(),
    };
    let mut receipt = empty_event();
    let immediate = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    let answered = unsafe {
        libc::kevent(
            queue.as_raw_fd(),
            &registration,
            1,
            &mut receipt,
            1,
            &immediate,
        )
    };
    // A process that has exited, zombies included, is refused with ESRCH.
    (answered == 1 && receipt.flags & libc::EV_ERROR != 0 && receipt.data == 0).then_some(queue)
}

fn exit_reported(queue: &OwnedFd) -> bool {
    let mut event = empty_event();
    let immediate = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    let read = unsafe {
        libc::kevent(
            queue.as_raw_fd(),
            std::ptr::null(),
            0,
            &mut event,
            1,
            &immediate,
        )
    };
    match read {
        0 => false,
        1 => event.fflags & libc::NOTE_EXIT != 0 || event.flags & libc::EV_ERROR != 0,
        // An interrupted poll is asked again on the next check; a queue that
        // can no longer be read cannot report the exit, so it counts as gone.
        _ => std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted,
    }
}

fn empty_event() -> libc::kevent {
    libc::kevent {
        ident: 0,
        filter: 0,
        flags: 0,
        fflags: 0,
        data: 0,
        udata: std::ptr::null_mut(),
    }
}

#[cfg(test)]
#[path = "host_watch_tests.rs"]
mod tests;
