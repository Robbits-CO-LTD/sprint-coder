// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! Where the overlay's windows go in the stacking order, decided from the
//! window list the renderer reads (CoreGraphics' on-screen list, front to
//! back). The Objective-C side reads the list into `ListedWindow` records,
//! asks here, and applies the answer; nothing here touches a window.

/// The window was read with its owner's pid.
pub(super) const HAS_PID: u8 = 1 << 0;
/// The window was read with its layer (window level).
pub(super) const HAS_LAYER: u8 = 1 << 1;
/// The window was read with its frame.
pub(super) const HAS_BOUNDS: u8 = 1 << 2;
/// A renderer's window: this one's or another agent's (the same executable in
/// another process).
pub(super) const OVERLAY: u8 = 1 << 3;
/// This renderer's own window.
pub(super) const OWN: u8 = 1 << 4;

/// One entry of the window list. `number` is 0 when it could not be read.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct ListedWindow {
    pub(super) number: u32,
    pub(super) pid: i32,
    pub(super) layer: i64,
    /// x, y, width, height, in CoreGraphics' global coordinates.
    pub(super) bounds: [f64; 4],
    pub(super) alpha: f64,
    pub(super) flags: u8,
}

impl ListedWindow {
    fn has(&self, flag: u8) -> bool {
        self.flags & flag != 0
    }
}

pub(super) const FREE: u8 = 0;
pub(super) const ABOVE: u8 = 1;
pub(super) const GONE: u8 = 2;

/// Where the overlay goes: `FREE` above every window (none is named), `ABOVE`
/// directly above window `target` at level `level`, or `GONE` off the screen.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Placement {
    pub(super) kind: u8,
    pub(super) target: u32,
    pub(super) level: i64,
}

impl Placement {
    const FREE: Self = Self {
        kind: FREE,
        target: 0,
        level: 0,
    };
    const GONE: Self = Self {
        kind: GONE,
        target: 0,
        level: 0,
    };
}

fn max_x(rect: &[f64; 4]) -> f64 {
    rect[0] + rect[2]
}

fn max_y(rect: &[f64; 4]) -> f64 {
    rect[1] + rect[3]
}

/// Whether `inner` lies inside `outer` grown by a point on every side.
fn inside(outer: &[f64; 4], inner: &[f64; 4]) -> bool {
    inner[0] >= outer[0] - 1.0
        && inner[1] >= outer[1] - 1.0
        && max_x(inner) <= max_x(outer) + 1.0
        && max_y(inner) <= max_y(outer) + 1.0
}

/// Whether the two frames share some area (touching edges do not).
fn overlaps(a: &[f64; 4], b: &[f64; 4]) -> bool {
    a[0] < max_x(b) && b[0] < max_x(a) && a[1] < max_y(b) && b[1] < max_y(a)
}

fn union(a: &[f64; 4], b: &[f64; 4]) -> [f64; 4] {
    let x = a[0].min(b[0]);
    let y = a[1].min(b[1]);
    [x, y, max_x(a).max(max_x(b)) - x, max_y(a).max(max_y(b)) - y]
}

/// Where the overlay goes for the window an instruction names.
///
/// With none named (`named` false) it goes above every window. With one named,
/// it is hidden unless that window is in the list now (number 0, which no
/// window has, is one that could not be read). Otherwise it goes directly above
/// the named window and the windows of the same process at the same level that
/// lie inside its frame (its sheets and popovers - or another document window
/// of the same app that happens to fit inside it), at the named window's level,
/// and never higher: windows of the same process at a higher level (its menus
/// and panels) are passed like any other window, so the overlay may be hidden
/// under them, but it is never left above the user's window once that is
/// brought to the front. The walk toward the front skips the renderers' own
/// windows and transparent ones, and stops at the first other window that
/// covers what it has passed.
pub(super) fn resolve(windows: &[ListedWindow], named: bool, number: u32) -> Placement {
    if !named {
        return Placement::FREE;
    }
    if number == 0 {
        return Placement::GONE;
    }
    let Some(anchor_index) = windows.iter().position(|window| window.number == number) else {
        return Placement::GONE;
    };
    let anchor = &windows[anchor_index];
    if !anchor.has(HAS_PID) || !anchor.has(HAS_LAYER) || !anchor.has(HAS_BOUNDS) {
        return Placement::GONE;
    }
    let mut top = anchor_index;
    let mut covered = anchor.bounds;
    for index in (0..anchor_index).rev() {
        let entry = &windows[index];
        if !entry.has(HAS_PID) || !entry.has(HAS_BOUNDS) {
            continue;
        }
        if entry.has(OVERLAY) || entry.alpha <= 0.0 {
            continue;
        }
        if entry.pid == anchor.pid
            && entry.has(HAS_LAYER)
            && entry.layer == anchor.layer
            && inside(&anchor.bounds, &entry.bounds)
        {
            top = index;
            covered = union(&covered, &entry.bounds);
            continue;
        }
        if overlaps(&entry.bounds, &covered) {
            break;
        }
    }
    let target = windows[top].number;
    if target == 0 {
        return Placement::GONE;
    }
    Placement {
        kind: ABOVE,
        target,
        level: anchor.layer,
    }
}

/// Whether this renderer's windows already sit where `target` wants them:
/// every one of `mine` (its shown windows, from the lowest to the highest as
/// they are meant to be stacked) is in the run of renderer windows directly in
/// front of `target`, in that order, and none of its windows is anywhere else.
/// Another agent's renderer windows in the run are passed over, in any
/// interleaving, so two renderers that name the same window both find
/// themselves in place and neither moves.
pub(super) fn settled(windows: &[ListedWindow], target: u32, mine: &[u32]) -> bool {
    if target == 0 || mine.is_empty() {
        return false;
    }
    let Some(target_index) = windows.iter().position(|window| window.number == target) else {
        return false;
    };
    let mut found = Vec::with_capacity(mine.len());
    for index in (0..target_index).rev() {
        let entry = &windows[index];
        if !entry.has(OVERLAY) {
            break;
        }
        if entry.has(OWN) {
            found.push(entry.number);
        }
    }
    found == mine
}

/// # Safety
///
/// `windows` points to `count` records (or is null with `count` 0), and
/// `output` to a writable `Placement`.
#[unsafe(no_mangle)]
pub(super) unsafe extern "C" fn agent_desktop_cursor_overlay_resolve(
    windows: *const ListedWindow,
    count: usize,
    named: bool,
    number: u32,
    output: *mut Placement,
) {
    if output.is_null() {
        return;
    }
    let listed = if windows.is_null() || count == 0 {
        &[][..]
    } else {
        // SAFETY: the caller passes `count` readable records.
        unsafe { std::slice::from_raw_parts(windows, count) }
    };
    // SAFETY: the caller passes a writable placement.
    unsafe { output.write(resolve(listed, named, number)) };
}

/// # Safety
///
/// `windows` points to `count` records and `mine` to `mine_count` numbers
/// (either may be null with its count 0).
#[unsafe(no_mangle)]
pub(super) unsafe extern "C" fn agent_desktop_cursor_overlay_settled(
    windows: *const ListedWindow,
    count: usize,
    target: u32,
    mine: *const u32,
    mine_count: usize,
) -> bool {
    let listed = if windows.is_null() || count == 0 {
        &[][..]
    } else {
        // SAFETY: the caller passes `count` readable records.
        unsafe { std::slice::from_raw_parts(windows, count) }
    };
    let mine = if mine.is_null() || mine_count == 0 {
        &[][..]
    } else {
        // SAFETY: the caller passes `mine_count` readable numbers.
        unsafe { std::slice::from_raw_parts(mine, mine_count) }
    };
    settled(listed, target, mine)
}

#[cfg(test)]
#[path = "placement_tests.rs"]
mod tests;
