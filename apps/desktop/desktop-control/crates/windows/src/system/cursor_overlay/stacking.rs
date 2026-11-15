// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! Where in the stacking order the overlay goes: at the height of the window
//! the agent is working in, not above every window.
//!
//! The overlay used to be raised to the top of the topmost band on every
//! frame, so a cursor working in a window behind the operator's was drawn
//! over the operator's window. It now sits directly above the working
//! window's *family* - the window and the popups and menus it owns, which
//! the system keeps above it - and below whatever other window covers that
//! family. A covered window hides its cursor with it; where the window shows,
//! the cursor shows.
//!
//! Owning the overlay by the working window would follow the window for
//! free, and is not done: an owned window is minimised with its owner and
//! changes how the owner is activated, and the owner belongs to another
//! process. Repositioning a window of our own changes nothing of anyone
//! else's.
//!
//! The decision is pure, made over the windows above the family as the walk
//! reports them, so it is tested without a desktop.

#![cfg_attr(not(target_os = "windows"), allow(dead_code))]

/// The window the agent works in, as the renderer finds it on screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Anchor {
    /// No window was named (a bare coordinate, the greeting): the cursor
    /// stays above everything, as it always was. A bare coordinate is where
    /// the input lands whatever covers it, so above everything is where it
    /// is seen landing.
    Unnamed,
    /// The named window is closed, minimised or hidden, and so is every
    /// window it belonged with. The cursor goes under everything: nothing of
    /// the window is on screen, so nothing of its cursor is either.
    Gone,
    /// The window is on screen. `topmost` is whether it lives in the topmost
    /// band (the taskbar, an always-on-top window).
    Live { topmost: bool },
}

/// One window above the working window, walking upward.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Neighbour {
    pub(crate) handle: isize,
    pub(crate) kind: Kind,
    pub(crate) topmost: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    /// Visible and owned by the working window's root owner: part of it.
    Family,
    /// Draws nothing here: invisible, or another agent cursor overlay. The
    /// walk passes over it.
    Passable,
    /// This overlay itself.
    Own,
    /// A visible window of something else. The family ends below it.
    Other,
}

/// What to do with the overlay's place in the stacking order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Placement {
    /// Top of the topmost band: the behaviour before windows were named.
    TopOfTopmost,
    /// Directly below this window, which is directly above the family.
    Below(isize),
    /// Top of the ordinary band, out of the topmost band.
    TopOfOrdinary,
    /// Under every window.
    Bottom,
    /// Already directly above the family; moving it would only repaint.
    Stay,
}

/// Decides the overlay's place from the anchor and the windows above the
/// working window, nearest first. `own_topmost` is whether the overlay is in
/// the topmost band now.
pub(crate) fn placement(
    anchor: Anchor,
    above: impl IntoIterator<Item = Neighbour>,
    own_topmost: bool,
) -> Placement {
    match anchor {
        Anchor::Unnamed => return Placement::TopOfTopmost,
        Anchor::Gone => return Placement::Bottom,
        Anchor::Live { topmost: true } => return Placement::TopOfTopmost,
        Anchor::Live { topmost: false } => {}
    }
    let mut just_above_top: Option<Neighbour> = None;
    let mut own_above_top = false;
    for neighbour in above {
        if just_above_top.is_none() {
            just_above_top = Some(neighbour);
        }
        match neighbour.kind {
            Kind::Family if neighbour.topmost => return Placement::TopOfTopmost,
            Kind::Family => {
                just_above_top = None;
                own_above_top = false;
            }
            Kind::Own => own_above_top = true,
            Kind::Passable => {}
            Kind::Other => break,
        }
    }
    if own_above_top {
        // Only passable windows lie between the family and the overlay. In
        // the topmost band it is still above the family, but it is above
        // everything else as well, so it comes down to the ordinary band.
        return if own_topmost {
            Placement::TopOfOrdinary
        } else {
            Placement::Stay
        };
    }
    match just_above_top {
        // The family is the highest ordinary window: the top of the
        // ordinary band is directly above it.
        None => Placement::TopOfOrdinary,
        Some(neighbour) if neighbour.topmost => Placement::TopOfOrdinary,
        Some(neighbour) => Placement::Below(neighbour.handle),
    }
}

/// How far the walk goes before it gives up and leaves the overlay where it
/// is. A desktop has a few hundred top-level windows; the walk normally ends
/// at the first visible window of something else.
pub(crate) const WALK_LIMIT: usize = 4096;

#[cfg(target_os = "windows")]
pub(crate) use imp::Stacker;

#[cfg(target_os = "windows")]
mod imp {
    use super::{Anchor, Kind, Neighbour, Placement, WALK_LIMIT, placement};
    use std::cell::Cell;
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GA_ROOT, GA_ROOTOWNER, GW_HWNDPREV, GWL_EXSTYLE, GetAncestor, GetClassNameW, GetWindow,
        GetWindowLongPtrW, HWND_BOTTOM, HWND_NOTOPMOST, HWND_TOPMOST, IsIconic, IsWindow,
        IsWindowVisible, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SetWindowPos, WS_EX_TOPMOST,
    };

    /// Places one overlay window, remembering the family of the last window
    /// it was placed with so a dialog that closes under the cursor hands it
    /// to the window that owned the dialog.
    pub(crate) struct Stacker {
        remembered: Cell<Option<(isize, isize)>>,
    }

    impl Stacker {
        pub(crate) const fn new() -> Self {
            Self {
                remembered: Cell::new(None),
            }
        }

        /// Puts `own` at the height `anchor` names. Activation, focus and
        /// the order of every other window are left as they are.
        pub(crate) fn place(&self, own: HWND, anchor: Option<isize>, overlay_class: &[u16]) {
            let (view, root, family) = self.resolve(anchor);
            let decided = match view {
                Anchor::Live { topmost: false } => placement(
                    view,
                    Walk::from(root, |window| classify(window, own, family, overlay_class)),
                    is_topmost(own),
                ),
                other => placement(other, std::iter::empty(), is_topmost(own)),
            };
            apply(own, decided);
        }

        /// The anchor as it stands now, its root window and its family's
        /// root owner.
        fn resolve(&self, anchor: Option<isize>) -> (Anchor, HWND, HWND) {
            let Some(id) = anchor else {
                self.remembered.set(None);
                return (Anchor::Unnamed, std::ptr::null_mut(), std::ptr::null_mut());
            };
            let named = id as HWND;
            if on_screen(named) {
                let root = unsafe { GetAncestor(named, GA_ROOT) };
                let root = if root.is_null() { named } else { root };
                let family = unsafe { GetAncestor(root, GA_ROOTOWNER) };
                let family = if family.is_null() { root } else { family };
                self.remembered.set(Some((id, family as isize)));
                return (
                    Anchor::Live {
                        topmost: is_topmost(root),
                    },
                    root,
                    family,
                );
            }
            match self.remembered.get() {
                Some((remembered_id, family))
                    if remembered_id == id && family != id && on_screen(family as HWND) =>
                {
                    let family = family as HWND;
                    (
                        Anchor::Live {
                            topmost: is_topmost(family),
                        },
                        family,
                        family,
                    )
                }
                _ => (Anchor::Gone, std::ptr::null_mut(), std::ptr::null_mut()),
            }
        }
    }

    fn on_screen(window: HWND) -> bool {
        unsafe { IsWindow(window) != 0 && IsWindowVisible(window) != 0 && IsIconic(window) == 0 }
    }

    fn is_topmost(window: HWND) -> bool {
        (unsafe { GetWindowLongPtrW(window, GWL_EXSTYLE) } as u32) & WS_EX_TOPMOST != 0
    }

    fn classify(window: HWND, own: HWND, family: HWND, overlay_class: &[u16]) -> Neighbour {
        let topmost = is_topmost(window);
        let kind = if window == own {
            Kind::Own
        } else if unsafe { IsWindowVisible(window) } == 0 || has_class(window, overlay_class) {
            Kind::Passable
        } else if unsafe { GetAncestor(window, GA_ROOTOWNER) } == family {
            Kind::Family
        } else {
            Kind::Other
        };
        Neighbour {
            handle: window as isize,
            kind,
            topmost,
        }
    }

    /// `overlay_class` is the class name without its terminator.
    fn has_class(window: HWND, overlay_class: &[u16]) -> bool {
        let mut buffer = [0u16; 64];
        let length =
            unsafe { GetClassNameW(window, buffer.as_mut_ptr(), buffer.len() as i32) } as usize;
        length == overlay_class.len() && buffer[..length] == *overlay_class
    }

    /// The windows above `from`, nearest first, classified as they are met.
    struct Walk<F> {
        at: HWND,
        steps: usize,
        classify: F,
    }

    impl<F: FnMut(HWND) -> Neighbour> Walk<F> {
        fn from(start: HWND, classify: F) -> Self {
            Self {
                at: start,
                steps: 0,
                classify,
            }
        }
    }

    impl<F: FnMut(HWND) -> Neighbour> Iterator for Walk<F> {
        type Item = Neighbour;

        fn next(&mut self) -> Option<Neighbour> {
            if self.steps >= WALK_LIMIT {
                return None;
            }
            self.steps += 1;
            let next = unsafe { GetWindow(self.at, GW_HWNDPREV) };
            if next.is_null() {
                return None;
            }
            self.at = next;
            Some((self.classify)(next))
        }
    }

    fn apply(own: HWND, decided: Placement) {
        let after = match decided {
            Placement::Stay => return,
            Placement::TopOfTopmost => HWND_TOPMOST,
            Placement::TopOfOrdinary => HWND_NOTOPMOST,
            Placement::Bottom => HWND_BOTTOM,
            Placement::Below(window) => window as HWND,
        };
        unsafe {
            SetWindowPos(
                own,
                after,
                0,
                0,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
            );
        }
    }
}

#[cfg(test)]
#[path = "stacking_tests.rs"]
mod tests;
