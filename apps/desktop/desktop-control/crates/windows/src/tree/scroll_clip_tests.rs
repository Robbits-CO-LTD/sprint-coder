// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! The scroll-clipping climb (`clipped_by_scroll_viewports`), driven over
//! recorded ancestries instead of a live provider.
use super::{ViewportClimb, clipped_by_scroll_viewports};
use agent_desktop_core::{AdapterError, Deadline, ErrorCode, Rect};

fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
    Rect {
        x,
        y,
        width,
        height,
    }
}

/// One ancestor: whether it advertises scrolling, the window it owns
/// (`0` for none) and its rectangle.
#[derive(Clone, Copy)]
struct Node {
    scrollable: bool,
    hwnd: isize,
    bounds: Rect,
}

const CONTENT_HWND: isize = 0x34E_5040;
const TOP_LEVEL: isize = 0x14_17A4;

/// The ancestry of the guest button in a Chrome profile picker covered by
/// other windows, read on 2026-11-15 (#1294), from the button's parent up:
/// two groups, the page's document (scrollable, owns no window), the content
/// pane that owns `Chrome_RenderWidgetHostHWND` (scrollable; while the page
/// is hidden that window is parked under Chromium's hidden top-level window
/// at the screen's origin, so its rectangle there is `0,0` with the page's
/// size), and the top-level window.
fn picker_ancestry(content_at: Rect) -> Vec<Node> {
    let page = rect(512.0, 167.0, 1539.0, 1140.0);
    vec![
        Node {
            scrollable: false,
            hwnd: 0,
            bounds: rect(512.0, 1133.0, 1539.0, 174.0),
        },
        Node {
            scrollable: false,
            hwnd: 0,
            bounds: page,
        },
        Node {
            scrollable: true,
            hwnd: 0,
            bounds: page,
        },
        Node {
            scrollable: true,
            hwnd: CONTENT_HWND,
            bounds: content_at,
        },
        Node {
            scrollable: false,
            hwnd: TOP_LEVEL,
            bounds: rect(500.0, 122.0, 1560.0, 1196.0),
        },
    ]
}

const GUEST_BUTTON: Rect = Rect {
    x: 572.0,
    y: 1193.0,
    width: 228.0,
    height: 54.0,
};
const PROFILE_CARD: Rect = Rect {
    x: 893.0,
    y: 709.0,
    width: 243.0,
    height: 268.0,
};
const PARKED_AT_ORIGIN: Rect = Rect {
    x: 0.0,
    y: 0.0,
    width: 1539.0,
    height: 1140.0,
};

/// Climbs `ancestry` (index 0 is the target's parent); `shown` says which
/// windows are shown.
fn clipped(ancestry: &[Node], target: Rect, shown: &dyn Fn(isize) -> bool) -> bool {
    clipped_by_scroll_viewports(
        None::<usize>,
        target,
        &ViewportClimb {
            parent_of: &|node: &Option<usize>| {
                let next = node.map_or(0, |index| index + 1);
                Ok((next < ancestry.len()).then_some(Some(next)))
            },
            scrollable: &|node: &Option<usize>| ancestry[node.unwrap()].scrollable,
            native_hwnd: &|node: &Option<usize>| Ok(ancestry[node.unwrap()].hwnd),
            window_shown: shown,
            viewport: &|node: &Option<usize>| Ok(Some(ancestry[node.unwrap()].bounds)),
            deadline: Deadline::standard().expect("a standard deadline"),
        },
    )
    .expect("the climb answers")
}

fn parked(hwnd: isize) -> bool {
    hwnd != CONTENT_HWND
}

#[test]
fn a_parked_content_window_does_not_clip_the_page_it_draws() {
    let ancestry = picker_ancestry(PARKED_AT_ORIGIN);
    assert!(
        !clipped(&ancestry, GUEST_BUTTON, &parked),
        "the guest button lies inside the page; the parked window's rectangle at the origin is not a clip"
    );
    assert!(!clipped(&ancestry, PROFILE_CARD, &parked));
}

#[test]
fn a_shown_content_window_still_clips() {
    let ancestry = picker_ancestry(rect(512.0, 167.0, 1539.0, 1140.0));
    assert!(!clipped(&ancestry, GUEST_BUTTON, &|_| true));
    let below_the_page = rect(572.0, 1400.0, 228.0, 54.0);
    assert!(clipped(&ancestry, below_the_page, &|_| true));
}

#[test]
fn the_document_viewport_still_clips_while_the_content_window_is_parked() {
    let ancestry = picker_ancestry(PARKED_AT_ORIGIN);
    let scrolled_out = rect(572.0, 1400.0, 228.0, 54.0);
    assert!(
        clipped(&ancestry, scrolled_out, &parked),
        "a part scrolled out of the page stays clipped by the document's own viewport"
    );
}

#[test]
fn a_shown_native_scroll_panel_clips_its_children() {
    // A WinForms panel owns a shown window: its client rectangle clips.
    let panel = Node {
        scrollable: true,
        hwnd: 0x2_0010,
        bounds: rect(100.0, 100.0, 200.0, 150.0),
    };
    let top = Node {
        scrollable: false,
        hwnd: TOP_LEVEL,
        bounds: rect(0.0, 0.0, 800.0, 600.0),
    };
    let ancestry = [panel, top];
    assert!(clipped(&ancestry, rect(120.0, 400.0, 50.0, 20.0), &|_| {
        true
    }));
    assert!(!clipped(&ancestry, rect(120.0, 120.0, 50.0, 20.0), &|_| {
        true
    }));
}

#[test]
fn an_unreadable_window_handle_leaves_the_viewport_read_to_answer() {
    let answer = clipped_by_scroll_viewports(
        0usize,
        GUEST_BUTTON,
        &ViewportClimb {
            parent_of: &|_: &usize| Ok(Some(1)),
            scrollable: &|_: &usize| true,
            native_hwnd: &|_: &usize| Err(()),
            window_shown: &|_| panic!("no handle was read"),
            viewport: &|_: &usize| {
                Err(AdapterError::new(
                    ErrorCode::ActionFailed,
                    "Could not read the native scroll viewport",
                ))
            },
            deadline: Deadline::standard().expect("a standard deadline"),
        },
    );
    let error = answer.expect_err("the viewport read's failure is reported");
    assert_eq!(error.code, ErrorCode::ActionFailed);
}
