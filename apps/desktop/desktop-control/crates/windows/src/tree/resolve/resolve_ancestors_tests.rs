// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! The ancestor read on a live fixture: it stops below the window root, reads
//! no more levels than asked, and gives up at the deadline instead of reading
//! past it.

use std::ops::ControlFlow;

use super::read_ancestor_evidence;
use crate::tree::fixture::{HostedFixture, ensure_test_apartment};
use crate::tree::walk::walker_fake::{deadline, ref_entry, scan_subtree};
use agent_desktop_core::{Deadline, ErrorCode, ProcessId, RefEntry};

/// An entry for the first fixture element at least two levels below the
/// window root, and that element's path.
fn nested_entry(fixture: &HostedFixture) -> (RefEntry, Vec<usize>) {
    let root = crate::tree::automation::root_from_hwnd(fixture.handle(), deadline())
        .expect("a fixture root");
    let source =
        crate::tree::walk::walker_source::UiaTreeSource::for_root(&root).expect("a source");
    let prepared = source.prepare_root(&root).expect("a prepared root");
    let budget = crate::tree::walk::walker::WalkBudget::new(10, deadline());
    let (path, role) = scan_subtree(
        &source,
        &prepared,
        &budget,
        10,
        &mut |prefix, _, evidence, _| {
            if prefix.len() >= 2 {
                ControlFlow::Break((
                    prefix.to_vec(),
                    evidence.role.known().cloned().unwrap_or_default(),
                ))
            } else {
                ControlFlow::Continue(())
            }
        },
    )
    .expect("the fixture walk succeeds")
    .expect("the fixture nests an element two levels deep");
    let token =
        crate::system::process_identity::token_for_pid(ProcessId::new(fixture.process_id()))
            .unwrap()
            .expect("a live fixture token");
    let mut entry = ref_entry(&role);
    entry.process = agent_desktop_core::RefProcess {
        pid: ProcessId::new(fixture.process_id()),
        process_instance: Some(token),
    };
    entry.source.source_app = Some("fixture.exe".into());
    entry.source.source_window_id = Some(format!("w-{}", fixture.handle()));
    entry.scope.path_is_absolute = true;
    entry.scope.path = path.clone().into();
    (entry, path)
}

#[test]
fn the_read_stops_below_the_root_and_at_the_asked_count() {
    ensure_test_apartment();
    let fixture = HostedFixture::spawn().expect("the fixture host starts");
    let (entry, path) = nested_entry(&fixture);
    let handle = crate::tree::resolve::resolve_anchor::resolve_locator_anchor(&entry, deadline())
        .expect("the nested element lands");

    let all = read_ancestor_evidence(&entry, &handle, 64, deadline()).expect("the chain reads");
    assert_eq!(
        all.len(),
        path.len() - 1,
        "every ancestor below the root, and no more"
    );
    assert!(all.iter().all(|ancestor| ancestor.role.known().is_some()));

    let one = read_ancestor_evidence(&entry, &handle, 1, deadline()).expect("one level reads");
    assert_eq!(one.len(), 1);
    assert_eq!(one[0].role, all[0].role);
}

#[test]
fn the_read_gives_up_at_the_deadline() {
    ensure_test_apartment();
    let fixture = HostedFixture::spawn().expect("the fixture host starts");
    let (entry, _) = nested_entry(&fixture);
    let handle = crate::tree::resolve::resolve_anchor::resolve_locator_anchor(&entry, deadline())
        .expect("the nested element lands");
    let expired = Deadline::after(1).expect("a deadline");
    std::thread::sleep(std::time::Duration::from_millis(5));

    let Err(error) = read_ancestor_evidence(&entry, &handle, 3, expired) else {
        panic!("no level is read once the deadline has passed");
    };
    assert_eq!(error.code, ErrorCode::Timeout);
}

#[test]
fn a_view_proof_reads_its_ancestors_in_the_view_of_visible_elements() {
    ensure_test_apartment();
    let fixture = HostedFixture::spawn().expect("the fixture host starts");
    let (entry, path) = nested_entry(&fixture);
    let handle = crate::tree::resolve::resolve_anchor::resolve_locator_anchor(&entry, deadline())
        .expect("the nested element lands");
    let raw = read_ancestor_evidence(&entry, &handle, 64, deadline()).expect("the raw chain");
    let mut in_view = entry.clone();
    in_view.identity.in_view = Some(agent_desktop_core::RefViewProof {
        path: path.clone().into(),
        bounds: agent_desktop_core::Rect {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        },
        runtime_id: Vec::new(),
        ancestors: Vec::new(),
    });
    let visible =
        read_ancestor_evidence(&in_view, &handle, 64, deadline()).expect("the visible chain");
    // The fixture shows every element, so both views hold the same levels, and
    // the visible view's climb stops below the root as the raw one does.
    assert_eq!(visible.len(), path.len() - 1);
    assert_eq!(
        visible
            .iter()
            .map(|ancestor| &ancestor.role)
            .collect::<Vec<_>>(),
        raw.iter()
            .map(|ancestor| &ancestor.role)
            .collect::<Vec<_>>()
    );
}
