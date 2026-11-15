// Changed by Sprint Coder (new file); see VENDORED.md in apps/desktop/desktop-control.
use super::*;
use agent_desktop_core::DeliveryDisposition;
use std::ffi::OsStr;

const INSTANCE: &str = "macos-proc-v1:13438878845:5256581";

fn process(pid: u32, instance: Option<&str>) -> RefusedWindowOwner {
    RefusedWindowOwner::Process {
        pid,
        instance: instance.map(str::to_string),
    }
}

#[test]
fn reads_a_pid_alone_or_with_its_process_instance() {
    assert_eq!(
        RefusedWindowOwner::from_variable(None),
        RefusedWindowOwner::Nobody
    );
    assert_eq!(
        RefusedWindowOwner::from_variable(Some(OsStr::new("64724"))),
        process(64724, None)
    );
    assert_eq!(
        RefusedWindowOwner::from_variable(Some(OsStr::new(&format!("64724:{INSTANCE}")))),
        process(64724, Some(INSTANCE))
    );
    for raw in [
        "",
        "0",
        "-1",
        "+5",
        " 5",
        "x",
        "64724:",
        ":macos-proc-v1:1:2",
        "0:macos-proc-v1:1:2",
        "64724:windows proc",
        "64724:macos-proc-v1:1:2\n",
        "99999999999",
    ] {
        assert_eq!(
            RefusedWindowOwner::from_variable(Some(OsStr::new(raw))),
            RefusedWindowOwner::Unreadable,
            "{raw:?}"
        );
    }
}

#[test]
fn refuses_the_process_unless_its_pid_now_belongs_to_another_instance() {
    let same = |_: u32| Some(INSTANCE.to_string());
    let other = |_: u32| Some("macos-proc-v1:1:1".to_string());
    let unread = |_: u32| None;
    let with_instance = process(500, Some(INSTANCE));
    let pid_only = process(500, None);

    assert_eq!(with_instance.judge(&[Some(500)], same), Verdict::Own);
    // The instance cannot be read now: still refused.
    assert_eq!(with_instance.judge(&[Some(500)], unread), Verdict::Own);
    // The pid was reused by another process after Sprint Coder ended.
    assert_eq!(with_instance.judge(&[Some(500)], other), Verdict::Allowed);
    assert_eq!(pid_only.judge(&[Some(500)], other), Verdict::Own);
    // Any one owner of the target is enough: the part, its window, its root.
    assert_eq!(
        pid_only.judge(&[Some(7), None, Some(500)], unread),
        Verdict::Own
    );
    assert_eq!(
        pid_only.judge(&[Some(7), None, Some(8)], unread),
        Verdict::Allowed
    );
    // Nothing could be read about the target at all.
    assert_eq!(pid_only.judge(&[], unread), Verdict::Unconfirmed);
    assert_eq!(pid_only.judge(&[None, None], unread), Verdict::Unconfirmed);
    assert_eq!(
        RefusedWindowOwner::Unreadable.judge(&[Some(7)], unread),
        Verdict::Unreadable
    );
    assert_eq!(
        RefusedWindowOwner::Nobody.judge(&[Some(500)], same),
        Verdict::Allowed
    );
    assert_eq!(
        RefusedWindowOwner::Nobody.judge(&[], same),
        Verdict::Allowed
    );
}

#[test]
fn nothing_is_read_when_nothing_is_refused() {
    let read = std::cell::Cell::new(false);
    RefusedWindowOwner::Nobody
        .check("test", || {
            read.set(true);
            Vec::new()
        })
        .expect("nothing refused");
    assert!(!read.get());
}

#[test]
fn a_refusal_says_nothing_was_sent_and_offers_no_retry() {
    assert!(refusal("click", Verdict::Allowed, None).is_none());
    for (verdict, kind) in [
        (Verdict::Own, "own_window_refused"),
        (Verdict::Unconfirmed, "own_window_unconfirmed"),
        (Verdict::Unreadable, "own_window_variable_unreadable"),
    ] {
        let error = refusal("click", verdict, None).expect("refused");
        assert_eq!(error.code, ErrorCode::PolicyDenied);
        assert_eq!(
            error.disposition.delivery(),
            DeliveryDisposition::NotDelivered
        );
        assert!(!error.permits_retry_by_default(), "{kind}");
        let details = error.details.as_ref().expect("details");
        assert_eq!(details["kind"], kind);
        assert_eq!(details["operation"], "click");
        assert_eq!(details["physical_delivery_started"], false);
        assert!(
            error.message.contains("Sprint Coder")
                || error.message.contains(REFUSED_WINDOW_OWNER_VARIABLE),
            "{}",
            error.message
        );
    }
    let own = refusal("click", Verdict::Own, None).expect("refused");
    assert!(own.message.contains("only by the user"), "{}", own.message);
}

#[test]
fn invalid_utf8_and_oversized_instance_fail_closed() {
    use std::os::unix::ffi::OsStrExt;
    assert_eq!(
        RefusedWindowOwner::from_variable(Some(OsStr::from_bytes(b"12:\xff"))),
        RefusedWindowOwner::Unreadable
    );
    assert_eq!(
        RefusedWindowOwner::from_variable(Some(OsStr::new(&format!("12:{}", "x".repeat(129))))),
        RefusedWindowOwner::Unreadable
    );
}

#[test]
fn nested_scopes_restore_the_previous_policy_even_on_unwind() {
    let _outer = enter(&process(42, None), "outer");
    assert!(check_pid(Some(42)).is_err());
    let _ = std::panic::catch_unwind(|| {
        let _inner = enter(&RefusedWindowOwner::Nobody, "inner");
        assert!(check_pid(Some(42)).is_ok());
        panic!("unwind");
    });
    let error = check_pid(Some(42)).unwrap_err();
    assert_eq!(error.details.unwrap()["operation"], "outer");
}

#[test]
fn point_containment_uses_half_open_screen_bounds() {
    use agent_desktop_core::{Point, Rect};
    let rect = Rect {
        x: -100.0,
        y: 10.0,
        width: 100.0,
        height: 50.0,
    };
    assert!(contains(&rect, &Point { x: -100.0, y: 10.0 }));
    assert!(!contains(&rect, &Point { x: 0.0, y: 10.0 }));
    assert!(!contains(&rect, &Point { x: -1.0, y: 60.0 }));
    assert!(!contains(
        &rect,
        &Point {
            x: f64::NAN,
            y: 10.0
        }
    ));
}

#[test]
fn later_refusal_preserves_earlier_delivery_evidence_and_the_suggestion() {
    let error = refusal("click", Verdict::Own, None).unwrap();
    let error = crate::actions::DeliveryTracker::from_delivered_units(2).annotate(error);
    assert_eq!(error.code, ErrorCode::PolicyDenied);
    assert_eq!(error.suggestion.as_deref(), Some(OWN_WINDOW_SUGGESTION));
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    assert!(error.message.contains("inputs before this one"));
    assert_eq!(
        error.details.as_ref().unwrap()["physical_delivery_started"],
        true
    );
    assert_eq!(error.details.unwrap()["delivered_events"], 2);
}

#[test]
fn unreadable_variable_refuses_adapter_entrypoints_without_native_access() {
    use agent_desktop_core::{
        Action, ActionOps, ActionRequest, AppInfo, Deadline, DismissAllNotificationsRequest,
        DismissNotificationRequest, DragParams, InputOps, InteractionLease, InteractionPolicy,
        KeyCombo, MouseButton, MouseEvent, MouseEventKind, NativeHandle, NotificationActionRequest,
        NotificationIdentity, Point, ProcessId, ProcessIdentity, SystemOps, WindowInfo, WindowOp,
    };
    let adapter = crate::MacOSAdapter::new().refusing_windows_of(RefusedWindowOwner::Unreadable);
    let lease = InteractionLease::guarded(Deadline::standard().unwrap(), ()).unwrap();
    let handle = NativeHandle::new(crate::tree::AXElement(std::ptr::null_mut()));
    let app = AppInfo {
        name: "fixture".into(),
        pid: ProcessId::new(42),
        bundle_id: None,
        process_instance: None,
        presentation: None,
    };
    let window = WindowInfo::for_process(&app);
    let combo = KeyCombo {
        key: "enter".into(),
        modifiers: Vec::new(),
    };
    let process = ProcessIdentity::new(app.pid, "macos-proc-v1:1:2");
    let policy = InteractionPolicy::headed();
    let identity = NotificationIdentity::default();
    let errors = vec![
        adapter
            .execute_action(&handle, ActionRequest::headless(Action::Click), &lease)
            .unwrap_err(),
        adapter
            .execute_action(
                &NativeHandle::null(),
                ActionRequest::headed(Action::PressKey(combo.clone())),
                &lease,
            )
            .unwrap_err(),
        adapter.scroll_into_view(&handle, &lease).unwrap_err(),
        adapter
            .mouse_event(
                MouseEvent {
                    kind: MouseEventKind::Move,
                    point: Point { x: 1.0, y: 2.0 },
                    button: MouseButton::Left,
                    modifiers: Vec::new(),
                },
                &lease,
            )
            .unwrap_err(),
        adapter.key_event(&combo, true, &lease).unwrap_err(),
        adapter
            .drag(
                DragParams {
                    from: Point { x: 1.0, y: 2.0 },
                    to: Point { x: 3.0, y: 4.0 },
                    duration_ms: None,
                    drop_delay_ms: None,
                },
                &lease,
            )
            .unwrap_err(),
        adapter.focus_window(&window, &lease).unwrap_err(),
        adapter
            .launch_app("fixture", &Default::default(), &lease)
            .unwrap_err(),
        adapter.close_app(&app, true, &lease).unwrap_err(),
        adapter
            .activate_renderer_accessibility(process.clone(), &lease)
            .unwrap_err(),
        adapter
            .press_key_for_app(process, &combo, policy, &lease)
            .unwrap_err(),
        adapter
            .dismiss_notification(
                DismissNotificationRequest {
                    index: 0,
                    app_filter: None,
                    identity: &identity,
                    policy,
                },
                &lease,
            )
            .unwrap_err(),
        adapter
            .dismiss_all_notifications(
                DismissAllNotificationsRequest {
                    app_filter: None,
                    policy,
                },
                &lease,
            )
            .unwrap_err(),
        adapter
            .notification_action(
                NotificationActionRequest {
                    index: 0,
                    identity: &identity,
                    action_name: "Open",
                    policy,
                },
                &lease,
            )
            .unwrap_err(),
    ];
    for error in errors {
        assert_eq!(error.code, ErrorCode::PolicyDenied);
        assert_eq!(
            error.details.unwrap()["kind"],
            "own_window_variable_unreadable"
        );
    }
    for op in [
        WindowOp::Move { x: 1.0, y: 2.0 },
        WindowOp::Resize {
            width: 100.0,
            height: 100.0,
        },
        WindowOp::Minimize,
        WindowOp::Maximize,
        WindowOp::Restore,
    ] {
        let error = adapter.window_op(&window, op, &lease).unwrap_err();
        assert_eq!(error.code, ErrorCode::PolicyDenied);
        assert_eq!(
            error.details.unwrap()["kind"],
            "own_window_variable_unreadable"
        );
    }
}

fn screen_window(owner: Option<u32>, layer: f64, alpha: f64) -> ScreenWindow {
    ScreenWindow {
        owner,
        bounds: Some(agent_desktop_core::Rect {
            x: 0.0,
            y: 0.0,
            width: 500.0,
            height: 500.0,
        }),
        layer: Some(layer),
        alpha: Some(alpha),
    }
}

fn judge_at(windows: Option<&[ScreenWindow]>, hit_owner: Option<u32>) -> Verdict {
    let point = agent_desktop_core::Point { x: 100.0, y: 100.0 };
    process(500, None).judge_point(&point, windows, hit_owner, |_| None)
}

#[test]
fn a_click_through_overlay_does_not_hide_the_refused_window_below_it() {
    // This executable's cursor overlay (popup menu level, alpha 1, ignores mouse events).
    let overlay = screen_window(Some(7), 103.0, 1.0);
    let transparent = screen_window(Some(8), 0.0, 0.0);
    let own = screen_window(Some(500), 0.0, 1.0);
    let other = screen_window(Some(9), 0.0, 1.0);
    assert_eq!(
        judge_at(Some(&[overlay.clone(), own.clone()]), None),
        Verdict::Own
    );
    assert_eq!(
        judge_at(Some(&[transparent, own.clone()]), None),
        Verdict::Own
    );
    // An ordinary window of another app above the refused one takes the click.
    assert_eq!(
        judge_at(Some(&[other.clone(), own.clone()]), None),
        Verdict::Allowed
    );
    assert_eq!(
        judge_at(Some(&[overlay.clone(), other.clone(), own.clone()]), None),
        Verdict::Allowed
    );
    // The refused process's own menu or panel above another app's window.
    let own_menu = screen_window(Some(500), 101.0, 1.0);
    assert_eq!(
        judge_at(Some(&[own_menu, other.clone()]), None),
        Verdict::Own
    );
    assert_eq!(
        judge_at(Some(&[own.clone(), other.clone()]), None),
        Verdict::Own
    );
    // Only another app's windows at the point.
    assert_eq!(judge_at(Some(&[overlay.clone()]), None), Verdict::Allowed);
    assert_eq!(judge_at(Some(&[other.clone()]), None), Verdict::Allowed);
}

#[test]
fn windows_away_from_the_point_or_unreadable_fail_closed_where_they_matter() {
    let other = screen_window(Some(9), 0.0, 1.0);
    let own = screen_window(Some(500), 0.0, 1.0);
    let far = ScreenWindow {
        bounds: Some(agent_desktop_core::Rect {
            x: 1000.0,
            y: 1000.0,
            width: 10.0,
            height: 10.0,
        }),
        ..own.clone()
    };
    assert_eq!(
        judge_at(Some(&[far.clone(), other.clone()]), None),
        Verdict::Allowed
    );
    // Nothing at the point, or no list at all.
    assert_eq!(judge_at(Some(&[]), None), Verdict::Unconfirmed);
    assert_eq!(judge_at(Some(&[far]), None), Verdict::Unconfirmed);
    assert_eq!(judge_at(None, None), Verdict::Unconfirmed);
    // A window whose owner cannot be read above the one that takes the click.
    let unread = ScreenWindow::default();
    assert_eq!(
        judge_at(Some(&[unread.clone(), other.clone()]), None),
        Verdict::Unconfirmed
    );
    assert_eq!(
        judge_at(
            Some(&[ScreenWindow {
                owner: None,
                ..other.clone()
            }]),
            None
        ),
        Verdict::Unconfirmed
    );
    // Unreadable bounds: the refused process's window may be at the point; another app's
    // window is not taken as the receiver.
    let own_unbounded = ScreenWindow {
        bounds: None,
        ..own.clone()
    };
    let other_unbounded = ScreenWindow {
        bounds: None,
        ..other.clone()
    };
    assert_eq!(
        judge_at(Some(&[own_unbounded, other.clone()]), None),
        Verdict::Own
    );
    assert_eq!(
        judge_at(Some(&[other_unbounded, own.clone()]), None),
        Verdict::Own
    );
    // Unreadable layer or alpha is not taken as an ordinary window.
    let unknown_layer = ScreenWindow {
        layer: None,
        ..other.clone()
    };
    assert_eq!(
        judge_at(Some(&[unknown_layer, own.clone()]), None),
        Verdict::Own
    );
}

#[test]
fn the_accessibility_hit_test_only_adds_refusals() {
    let other = screen_window(Some(9), 0.0, 1.0);
    let own = screen_window(Some(500), 0.0, 1.0);
    assert_eq!(
        judge_at(Some(&[other.clone(), own.clone()]), Some(500)),
        Verdict::Own
    );
    assert_eq!(judge_at(None, Some(500)), Verdict::Own);
    assert_eq!(judge_at(Some(&[other.clone()]), Some(9)), Verdict::Allowed);
    // A readable hit test of another app does not rescue an unreadable window list.
    assert_eq!(judge_at(None, Some(9)), Verdict::Unconfirmed);
    // The pid was reused by another process: the instance decides as for every target.
    let point = agent_desktop_core::Point { x: 100.0, y: 100.0 };
    assert_eq!(
        process(500, Some(INSTANCE)).judge_point(&point, Some(&[own]), Some(500), |_| {
            Some("macos-proc-v1:1:1".to_string())
        }),
        Verdict::Allowed
    );
    assert_eq!(
        RefusedWindowOwner::Nobody.judge_point(&point, None, None, |_| None),
        Verdict::Allowed
    );
    assert_eq!(
        RefusedWindowOwner::Unreadable.judge_point(&point, Some(&[other]), None, |_| None),
        Verdict::Unreadable
    );
}

#[test]
fn either_front_application_source_naming_the_refused_process_refuses_a_key() {
    let owner = process(500, None);
    let unread = |_: u32| None;
    assert_eq!(owner.judge(&[Some(9), Some(500)], unread), Verdict::Own);
    assert_eq!(owner.judge(&[Some(500), Some(9)], unread), Verdict::Own);
    assert_eq!(owner.judge(&[None, Some(9)], unread), Verdict::Allowed);
    assert_eq!(owner.judge(&[Some(9), None], unread), Verdict::Allowed);
    assert_eq!(owner.judge(&[None, None], unread), Verdict::Unconfirmed);
}
