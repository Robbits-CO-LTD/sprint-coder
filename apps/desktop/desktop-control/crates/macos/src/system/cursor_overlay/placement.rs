// Changed by Sprint Coder (new file); see VENDORED.md in apps/desktop/desktop-control.
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

// The Objective-C side declares the same records; it asserts the same sizes.
const _: () = assert!(core::mem::size_of::<ListedWindow>() == 64);
const _: () = assert!(core::mem::size_of::<Placement>() == 16);

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

/// Where the overlay goes for the window an instruction names.
///
/// With none named (`named` false) it goes above every window. With one named,
/// it is hidden unless that window is in the list now with its owner, level
/// and frame read (number 0, which no window has, is one that could not be
/// read). Otherwise it goes directly above the named window, at the named
/// window's level, and no window in front of it is looked at: whatever is in
/// front stays in front, so the overlay is never above a window the user is
/// using, another window of the same app included, and is never left above
/// one once the user brings it to the front.
///
/// The named window's attached sheets and popovers are separate windows, but
/// the window server keeps a window and its attached windows together, so
/// the overlay ordered directly above the named window is above them too
/// (measured on macOS 27, 2026-11-17), and nothing more is needed for them.
pub(super) fn resolve(windows: &[ListedWindow], named: bool, number: u32) -> Placement {
    if !named {
        return Placement::FREE;
    }
    if number == 0 {
        return Placement::GONE;
    }
    let Some(anchor) = windows.iter().find(|window| window.number == number) else {
        return Placement::GONE;
    };
    if !anchor.has(HAS_PID) || !anchor.has(HAS_LAYER) || !anchor.has(HAS_BOUNDS) {
        return Placement::GONE;
    }
    Placement {
        kind: ABOVE,
        target: number,
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
pub(super) unsafe extern "C" fn sc_cursor_overlay_resolve(
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
pub(super) unsafe extern "C" fn sc_cursor_overlay_settled(
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
