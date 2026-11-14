// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! Retiring one agent's cursor: only that agent's renderer is reached, and an
//! agent with no renderer is left as it was.

use super::{ReachOutcome, retire_agent_through, retirement, update};
use crate::system::cursor_overlay::{framing, pipe_name};
use agent_desktop_core::CursorOverlayControl;
use std::path::PathBuf;
use std::time::Duration;

fn session(tag: &str) -> String {
    format!("r{tag}{:07}", std::process::id() % 10_000_000)
}

/// Only for naming: a pipe name hashes the root's text, nothing is read there.
fn root() -> PathBuf {
    PathBuf::from(r"C:\sprint-coder-cursor-retire-test-root")
}

/// A retire aims at the pipe its own agent's renderer answers on, which is
/// neither another agent's nor the session's agent-less one.
#[test]
fn a_retire_aims_at_its_own_agents_pipe_and_no_other() {
    let root = root();
    let session = session("a");
    let control = CursorOverlayControl::retire(session.clone(), "worker-a".into());

    let (name, wire) = retirement(&root, &control).expect("a retire has a target");

    assert_eq!(
        name,
        pipe_name::pipe_name(&root, &session, Some("worker-a"))
    );
    assert_ne!(
        name,
        pipe_name::pipe_name(&root, &session, Some("worker-b"))
    );
    assert_ne!(name, pipe_name::pipe_name(&root, &session, None));
    assert!(
        wire.is_disable() && wire.session_id() == session,
        "what reaches the renderer is the session's disable, which every renderer decodes"
    );
}

#[test]
fn a_control_that_is_not_a_retire_has_no_retire_target() {
    let root = root();
    assert!(retirement(&root, &CursorOverlayControl::disable(session("b"))).is_none());
    assert!(retirement(&root, &CursorOverlayControl::hide(session("b"))).is_none());
}

/// A retire never brings a renderer into existence: one that spawned would
/// start a cursor in order to take it down.
#[test]
fn a_retire_may_not_start_a_renderer_and_is_acknowledged() {
    let control = CursorOverlayControl::retire(session("c"), "worker-c".into());
    assert!(!framing::may_spawn(&control));
    assert!(framing::is_acknowledged(&control));
    assert!(control.expects_acknowledgement());
}

/// An agent nobody is drawing for: nothing to take down, nothing started, and
/// the answer is immediate. A test binary cannot spawn, so a spawn attempt
/// would surface as the error this `expect` rejects.
#[test]
fn retiring_an_agent_with_no_renderer_is_harmless() {
    update(&CursorOverlayControl::retire(
        session("d"),
        "nobody-draws-for-me".into(),
    ))
    .expect("an agent with no cursor has nothing to retire");
}

/// Two agents of one session and its agent-less endpoint: retiring one agent
/// reaches that agent's pipe, once, with the session's disable, and no other
/// pipe at all.
#[test]
fn retiring_one_agent_reaches_that_agents_renderer_and_no_other() {
    let root = root();
    let session = session("e");
    let control = CursorOverlayControl::retire(session.clone(), "worker-e1".into());
    let mut reached = Vec::new();

    retire_agent_through(&root, &control, Duration::from_secs(4), |name, wire, _| {
        reached.push((name.to_owned(), wire.clone()));
        ReachOutcome::Delivered
    })
    .expect("the retire was delivered");

    assert_eq!(reached.len(), 1, "exactly one renderer is reached");
    let (name, wire) = &reached[0];
    assert_eq!(
        name,
        &pipe_name::pipe_name(&root, &session, Some("worker-e1"))
    );
    assert_ne!(
        name,
        &pipe_name::pipe_name(&root, &session, Some("worker-e2"))
    );
    assert_ne!(name, &pipe_name::pipe_name(&root, &session, None));
    assert!(wire.is_disable() && wire.session_id() == session);
}

/// An agent nobody draws for answers `Ok`; a renderer that could not be
/// reached is reported, so the caller knows the cursor may still be drawn.
#[test]
fn a_retire_reports_what_its_one_reach_answered() {
    let root = root();
    let control = CursorOverlayControl::retire(session("f"), "worker-f".into());

    retire_agent_through(&root, &control, Duration::from_secs(1), |_, _, _| {
        ReachOutcome::NoRenderer
    })
    .expect("no renderer means nothing to take down");

    let error = retire_agent_through(&root, &control, Duration::from_secs(1), |_, _, _| {
        ReachOutcome::Unreachable(agent_desktop_core::AdapterError::internal("unreachable"))
    })
    .expect_err("an unreachable renderer is not reported as retired");
    assert_eq!(error.message, "unreachable");
}
