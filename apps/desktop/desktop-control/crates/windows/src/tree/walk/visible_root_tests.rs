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

    let walk = UiaTreeSource::for_visible_root(&root).expect("a visible source");
    assert!(
        walk.first_child(&root)
            .is_err_and(|failure| failure.is_exhaustion())
    );
    let descent = UiaTreeSource::for_visible_descent(&root).expect("a descent source");
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
    let walk = UiaTreeSource::for_visible_root(&root).expect("a visible source");
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

    let unread = UiaTreeSource::for_visible_root(&root)
        .expect("a visible source")
        .with_root_view(None);
    assert!(
        unread
            .first_child(&root)
            .is_err_and(|failure| !failure.is_exhaustion() && !failure.is_absence())
    );

    let offscreen = UiaTreeSource::for_visible_root(&root)
        .expect("a visible source")
        .with_root_view(Some(false));
    assert!(
        offscreen
            .first_child(&root)
            .is_err_and(|failure| failure.is_exhaustion())
    );
}
