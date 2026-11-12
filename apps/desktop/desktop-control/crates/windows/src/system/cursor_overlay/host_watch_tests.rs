// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::{HostRequest, parse};

#[test]
fn the_variable_is_read_as_a_process_id_or_as_nothing_to_watch() {
    assert_eq!(parse(None), HostRequest::Unwatched);
    assert_eq!(parse(Some("4242")), HostRequest::Process(4242));
    assert_eq!(parse(Some(" 4242 ")), HostRequest::Process(4242));
}

/// A value that cannot name a host must not leave a renderer that nothing
/// ends: it is read as a host already gone.
#[test]
fn a_value_that_is_not_a_process_id_is_invalid() {
    for value in ["", "0", "-1", "abc", "4294967296", "12:34"] {
        assert_eq!(parse(Some(value)), HostRequest::Invalid, "{value}");
    }
}

#[cfg(target_os = "windows")]
mod live {
    use super::super::{HostRequest, HostWatch};
    use std::process::{Command, Stdio};

    #[test]
    fn nothing_named_is_never_gone_and_an_invalid_value_is_gone_at_once() {
        assert!(!HostWatch::for_request(HostRequest::Unwatched).host_gone());
        assert!(HostWatch::for_request(HostRequest::Invalid).host_gone());
    }

    #[test]
    fn a_running_host_is_watched_and_reads_gone_once_it_has_exited() {
        let mut host = Command::new("C:\\Windows\\System32\\cmd.exe")
            .args([
                "/d",
                "/c",
                "C:\\Windows\\System32\\ping.exe -n 30 127.0.0.1 >nul",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("a host to watch");
        let watch = HostWatch::for_request(HostRequest::Process(host.id()));
        assert!(!watch.host_gone(), "a running host is not gone");

        host.kill().expect("the host this test started");
        host.wait().expect("the host to exit");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !watch.host_gone() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(watch.host_gone(), "an exited host is gone");
    }

    #[test]
    fn a_host_that_has_already_exited_is_gone_from_the_start() {
        let mut host = Command::new("C:\\Windows\\System32\\cmd.exe")
            .args(["/d", "/c", "exit 0"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("a host that exits");
        let pid = host.id();
        host.wait().expect("the host to exit");
        drop(host);
        assert!(HostWatch::for_request(HostRequest::Process(pid)).host_gone());
    }
}
