// Added by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! A view of visible elements whose root is not itself in that view is empty:
//! nothing is read below such a root, so no step can leave it.

use super::*;
use crate::tree::automation::root_from_hwnd;
use crate::tree::fixture::{LocalFixture, bootstrap};
use crate::tree::walk::walker::{TreeSource, WalkBudget};
use agent_desktop_core::{Deadline, ObservationRoot};

fn deadline() -> Deadline {
    Deadline::standard().expect("a standard deadline")
}

/// A minimized Win32 window reports its root offscreen (its children do not:
/// that is the shape that let the view step past the root). Its view of
/// visible elements is empty, in a walk and in a descent alike, and the walk
/// still answers whole, as for a covered window.
#[test]
fn the_view_below_a_root_reported_offscreen_is_empty() {
    bootstrap();
    let fixture = LocalFixture::create().expect("the fixture window is created");
    fixture.minimize();
    std::thread::sleep(std::time::Duration::from_millis(250));
    let root = root_from_hwnd(fixture.handle(), deadline()).expect("the fixture root resolves");
    assert_eq!(
        root_in_view(&root),
        Some(false),
        "a minimized root is reported offscreen"
    );

    let walk = UiaTreeSource::for_visible_root(&root, deadline()).expect("a visible source");
    assert!(
        walk.first_child(&root)
            .is_err_and(|failure| failure.is_exhaustion())
    );
    let descent = UiaTreeSource::for_visible_descent(&root, deadline()).expect("a descent source");
    assert!(
        descent
            .first_child(&root)
            .is_err_and(|failure| failure.is_exhaustion())
    );

    let window = crate::tree::walk::walker_fake::window();
    let outcome = walk_uia_visible_subtree(
        &root,
        &ObservationRoot::Window(&window),
        WalkBudget::new(50, deadline()),
    )
    .expect("the view is walked");
    assert_eq!(outcome.stats.traversal.nodes_visited, 1, "the root alone");
    assert!(outcome.tree.is_complete());
}

/// The same window restored is in the view, and its children are read.
#[test]
fn the_view_below_a_root_reported_onscreen_is_read() {
    bootstrap();
    let fixture = LocalFixture::create().expect("the fixture window is created");
    let root = root_from_hwnd(fixture.handle(), deadline()).expect("the fixture root resolves");
    if root_in_view(&root) != Some(true) {
        // The fixture is placed where this desktop reports it offscreen; the
        // case above is the one this guard is for.
        return;
    }
    let walk = UiaTreeSource::for_visible_root(&root, deadline()).expect("a visible source");
    assert!(walk.first_child(&root).is_ok());
}

/// A root whose place in the view could not be read is not walked, but the
/// step answers a failed read (which a caller may retry), never the end of an
/// empty view: the elements below it are unread, not absent.
#[test]
fn the_view_below_a_root_that_could_not_be_read_is_a_failed_read_not_an_empty_view() {
    bootstrap();
    let fixture = LocalFixture::create().expect("the fixture window is created");
    let root = root_from_hwnd(fixture.handle(), deadline()).expect("the fixture root resolves");

    let unread = UiaTreeSource::for_visible_root(&root, deadline())
        .expect("a visible source")
        .with_root_view(None);
    assert!(
        unread
            .first_child(&root)
            .is_err_and(|failure| !failure.is_exhaustion() && !failure.is_absence())
    );

    let offscreen = UiaTreeSource::for_visible_root(&root, deadline())
        .expect("a visible source")
        .with_root_view(Some(false));
    assert!(
        offscreen
            .first_child(&root)
            .is_err_and(|failure| failure.is_exhaustion())
    );
}

/// The shown view (WPF windows) holds to the same rule: below a root reported
/// offscreen (a minimized window) nothing is read, in a walk or a descent; a
/// root not read is a failed read there too.
#[test]
fn the_shown_view_below_a_root_reported_offscreen_is_empty() {
    bootstrap();
    let fixture = LocalFixture::create().expect("the fixture window is created");
    fixture.minimize();
    std::thread::sleep(std::time::Duration::from_millis(250));
    let root = root_from_hwnd(fixture.handle(), deadline()).expect("the fixture root resolves");
    assert_eq!(root_in_view(&root), Some(false));

    let source = UiaTreeSource::for_shown_root(&root, deadline()).expect("a shown source");
    assert!(
        source
            .first_child(&root)
            .is_err_and(|failure| failure.is_exhaustion())
    );
    let unread = UiaTreeSource::for_shown_root(&root, deadline())
        .expect("a shown source")
        .with_root_view(None);
    assert!(
        unread
            .first_child(&root)
            .is_err_and(|failure| !failure.is_exhaustion() && !failure.is_absence())
    );
    let window = crate::tree::walk::walker_fake::window();
    let outcome = walk_uia_shown_subtree(
        &root,
        &ObservationRoot::Window(&window),
        WalkBudget::new(50, deadline()),
    )
    .expect("the view is walked");
    assert_eq!(outcome.stats.traversal.nodes_visited, 1, "the root alone");
    assert!(outcome.tree.is_complete());
}

/// Only the onscreen view checks each sibling's parent: its steps can leave
/// the element listed. The shown view walks the raw view, where a sibling
/// always shares its parent, so it pays no call for it. A root is not its own
/// parent's child, so the onscreen view refuses that pair and the shown view,
/// which does not ask, lets it be.
#[test]
fn only_the_onscreen_view_checks_the_parent_of_each_sibling() {
    bootstrap();
    let fixture = LocalFixture::create().expect("the fixture window is created");
    let root = root_from_hwnd(fixture.handle(), deadline()).expect("the fixture root resolves");

    let onscreen = UiaTreeSource::for_visible_root(&root, deadline()).expect("a visible source");
    assert_eq!(onscreen.sibling_in_view(&root, &root), Ok(false));
    let shown = UiaTreeSource::for_shown_root(&root, deadline()).expect("a shown source");
    assert_eq!(shown.sibling_in_view(&root, &root), Ok(true));
}

/// A check of the view that has no time left answers that it could not tell,
/// and the question a capture asks then answers "not read that way" (`None`),
/// which keeps the capture's split as it was.
#[test]
fn a_view_check_without_time_could_not_tell() {
    bootstrap();
    let fixture = LocalFixture::create().expect("the fixture window is created");
    let root = root_from_hwnd(fixture.handle(), deadline()).expect("the fixture root resolves");
    let spent = Deadline::after(1).expect("a deadline");
    std::thread::sleep(std::time::Duration::from_millis(5));

    assert_eq!(
        crate::tree::walk::shown_view::checked_view_of(&root, spent),
        crate::tree::walk::shown_view::ViewCheck::Unread
    );
    let window = agent_desktop_core::WindowInfo {
        id: format!("w-{}", fixture.handle()),
        title: String::new(),
        app: String::new(),
        pid: agent_desktop_core::ProcessId::new(std::process::id()),
        process_instance: None,
        bounds: None,
        state: Default::default(),
    };
    assert_eq!(
        crate::tree::observe::reads_visible_elements(
            &window,
            agent_desktop_core::SnapshotSurface::Window,
            spent
        ),
        None
    );
}
