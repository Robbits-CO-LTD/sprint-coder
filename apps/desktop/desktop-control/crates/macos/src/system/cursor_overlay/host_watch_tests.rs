// Changed by Sprint Coder (new file); see VENDORED.md in apps/desktop/desktop-control.
use super::{HostRequest, HostWatch, parse};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[test]
fn the_variable_is_read_as_a_process_id_or_as_nothing_to_watch() {
    assert_eq!(parse(None), HostRequest::Unwatched);
    assert_eq!(parse(Some("4242")), HostRequest::Process(4242));
    assert_eq!(parse(Some(" 4242 ")), HostRequest::Process(4242));
}

/// A value that cannot name a host must not leave a renderer that nothing
/// ends: it is read as a host already gone. A process id on macOS is a
/// positive `pid_t`, so anything past `i32::MAX` is not one.
#[test]
fn a_value_that_is_not_a_process_id_is_invalid() {
    for value in ["", "0", "-1", "abc", "2147483648", "4294967296", "12:34"] {
        assert_eq!(parse(Some(value)), HostRequest::Invalid, "{value}");
    }
}

#[test]
fn nothing_named_is_never_gone_and_an_invalid_value_is_gone_at_once() {
    assert!(!HostWatch::for_request(HostRequest::Unwatched).host_gone());
    assert!(HostWatch::for_request(HostRequest::Invalid).host_gone());
}

fn sleeper() -> std::process::Child {
    Command::new("/bin/sleep")
        .arg("30")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("a host to watch")
}

fn pid_of(child: &std::process::Child) -> libc::pid_t {
    libc::pid_t::try_from(child.id()).expect("a pid_t")
}

#[test]
fn a_running_host_is_watched_and_stays_gone_once_it_has_exited() {
    let mut host = sleeper();
    let mut watch = HostWatch::for_request(HostRequest::Process(pid_of(&host)));
    assert!(!watch.host_gone(), "a running host is not gone");
    assert!(
        !watch.host_gone(),
        "asking again does not change the answer"
    );

    host.kill().expect("the host this test started");
    host.wait().expect("the host to exit");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !watch.host_gone() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(watch.host_gone(), "an exited host is gone");
    // The kernel reports the exit once; the answer must not fall back to
    // "running" on the next check.
    assert!(watch.host_gone(), "an exited host stays gone");
}

/// The exit is seen before the host is reaped, so a host whose parent has not
/// collected it yet still ends the renderer.
#[test]
fn an_exited_host_is_gone_before_it_is_reaped() {
    let mut host = sleeper();
    let mut watch = HostWatch::for_request(HostRequest::Process(pid_of(&host)));
    host.kill().expect("the host this test started");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !watch.host_gone() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(watch.host_gone(), "an exited, unreaped host is gone");
    host.wait().expect("the host to exit");
}

#[test]
fn a_host_that_has_already_exited_is_gone_from_the_start() {
    let mut host = Command::new("/usr/bin/true")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("a host that exits");
    let pid = pid_of(&host);
    host.wait().expect("the host to exit");
    drop(host);
    assert!(HostWatch::for_request(HostRequest::Process(pid)).host_gone());
}

/// A zombie is a process that has exited: the renderer must not start for it.
#[test]
fn a_zombie_host_is_gone_from_the_start() {
    let mut host = Command::new("/usr/bin/true")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("a host that exits");
    let pid = pid_of(&host);
    // Waits for the exit without reaping it, so the host stays a zombie.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let waited = unsafe {
        libc::waitid(
            libc::P_PID,
            pid as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOWAIT,
        )
    };
    assert_eq!(waited, 0, "the host exited and is left unreaped");
    assert!(HostWatch::for_request(HostRequest::Process(pid)).host_gone());
    host.wait().expect("the host to be reaped");
}
