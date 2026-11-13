// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! Key-name to Windows virtual-key resolution.
//!
//! Key *names* are a shared contract with macOS: every name
//! `crates/macos/src/input/keyboard/keyboard_map.rs` accepts must resolve here too,
//! even though what a combo built from those names *does* is not
//! portable. `delete`/`backspace` and `forwarddelete` keep the same split
//! macOS draws between its single Backspace-shaped key and the separate
//! forward-delete key, mapped onto Windows' own two distinct keys
//! (`VK_BACK`/`VK_DELETE`) rather than collapsing them.
//!
//! Single-character names (`a`-`z`, `0`-`9`) and the symbol names resolve
//! through the keyboard layout of the thread that will receive the key, so the
//! physical key pressed matches *that* layout, falling back to the fixed
//! ASCII-derived virtual-key code (numerically identical to the answer on a
//! US layout) when the layout has no key that produces the requested
//! character at all.
//!
//! The receiving layout matters because Windows can keep a separate input
//! language per application: a key looked up in this process's own layout
//! (`VkKeyScanW`) and then delivered to an application using another one
//! types a different character without any error (`=` on a US layout is the
//! key that types `^` on a Japanese one). [`focused_layout`] reads the layout
//! of the thread holding the keyboard focus, which is where `SendInput` puts
//! the key, and [`resolve_key_in`] looks the key up in it (`VkKeyScanExW`).
//! When that layout cannot be read the lookup uses this thread's own layout,
//! the behaviour before. Nothing here loads, activates or changes a layout.

use agent_desktop_core::{AdapterError, ErrorCode};

pub(crate) const VK_BACK: u16 = 0x08;
pub(crate) const VK_TAB: u16 = 0x09;
pub(crate) const VK_RETURN: u16 = 0x0D;
pub(crate) const VK_SHIFT: u16 = 0x10;
pub(crate) const VK_CONTROL: u16 = 0x11;
pub(crate) const VK_MENU: u16 = 0x12;
pub(crate) const VK_ESCAPE: u16 = 0x1B;
pub(crate) const VK_SPACE: u16 = 0x20;
pub(crate) const VK_PRIOR: u16 = 0x21;
pub(crate) const VK_NEXT: u16 = 0x22;
pub(crate) const VK_END: u16 = 0x23;
pub(crate) const VK_HOME: u16 = 0x24;
pub(crate) const VK_LEFT: u16 = 0x25;
pub(crate) const VK_UP: u16 = 0x26;
pub(crate) const VK_RIGHT: u16 = 0x27;
pub(crate) const VK_DOWN: u16 = 0x28;
pub(crate) const VK_DELETE: u16 = 0x2E;
pub(crate) const VK_LWIN: u16 = 0x5B;
const VK_F1: u16 = 0x70;
const VK_F2: u16 = 0x71;
const VK_F3: u16 = 0x72;
const VK_F4: u16 = 0x73;
const VK_F5: u16 = 0x74;
const VK_F6: u16 = 0x75;
const VK_F7: u16 = 0x76;
const VK_F8: u16 = 0x77;
const VK_F9: u16 = 0x78;
const VK_F10: u16 = 0x79;
const VK_F11: u16 = 0x7A;
const VK_F12: u16 = 0x7B;

#[cfg(target_os = "windows")]
const _: () = {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse as win32;
    assert!(VK_BACK == win32::VK_BACK);
    assert!(VK_TAB == win32::VK_TAB);
    assert!(VK_RETURN == win32::VK_RETURN);
    assert!(VK_SHIFT == win32::VK_SHIFT);
    assert!(VK_CONTROL == win32::VK_CONTROL);
    assert!(VK_MENU == win32::VK_MENU);
    assert!(VK_ESCAPE == win32::VK_ESCAPE);
    assert!(VK_SPACE == win32::VK_SPACE);
    assert!(VK_PRIOR == win32::VK_PRIOR);
    assert!(VK_NEXT == win32::VK_NEXT);
    assert!(VK_END == win32::VK_END);
    assert!(VK_HOME == win32::VK_HOME);
    assert!(VK_LEFT == win32::VK_LEFT);
    assert!(VK_UP == win32::VK_UP);
    assert!(VK_RIGHT == win32::VK_RIGHT);
    assert!(VK_DOWN == win32::VK_DOWN);
    assert!(VK_DELETE == win32::VK_DELETE);
    assert!(VK_LWIN == win32::VK_LWIN);
    assert!(VK_F1 == win32::VK_F1);
    assert!(VK_F12 == win32::VK_F12);
};

/// A key name resolved to the virtual key that produces it, together with
/// the modifiers the layout it was looked up in requires to produce it.
///
/// The layout half is what `VkKeyScanExW` reports in its high byte and what
/// a caller cannot know: on AZERTY the digit row needs Shift, so pressing
/// the bare virtual key for `5` yields the unshifted glyph instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ResolvedKey {
    pub(crate) vk: u16,
    pub(crate) layout_shift: bool,
    pub(crate) layout_control: bool,
    pub(crate) layout_alt: bool,
}

impl ResolvedKey {
    fn bare(vk: u16) -> Self {
        Self {
            vk,
            layout_shift: false,
            layout_control: false,
            layout_alt: false,
        }
    }

    pub(crate) fn layout_modifier_vks(self) -> Vec<u16> {
        let mut vks = Vec::new();
        if self.layout_shift {
            vks.push(VK_SHIFT);
        }
        if self.layout_control {
            vks.push(VK_CONTROL);
        }
        if self.layout_alt {
            vks.push(VK_MENU);
        }
        vks
    }
}

/// Bit positions `VkKeyScanW` uses in its high byte.
const LAYOUT_SHIFT: u8 = 0x01;
const LAYOUT_CONTROL: u8 = 0x02;
const LAYOUT_ALT: u8 = 0x04;

/// The keyboard layout a key is looked up in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KeyboardLayout {
    /// This thread's own active layout (`VkKeyScanW`): the fallback when the
    /// receiving thread's layout could not be read.
    Caller,
    /// A layout handle (`HKL`) read from the receiving thread
    /// (`VkKeyScanExW`).
    Handle(isize),
}

impl KeyboardLayout {
    /// A layout handle of zero is the answer `GetKeyboardLayout` gives for a
    /// thread it could not read, so it falls back to the caller's layout
    /// rather than asking `VkKeyScanExW` about a layout that does not exist.
    pub(crate) fn from_handle(handle: isize) -> Self {
        if handle == 0 {
            Self::Caller
        } else {
            Self::Handle(handle)
        }
    }
}

/// [`resolve_key_in`] against this thread's own layout.
#[cfg(test)]
pub(crate) fn resolve_key(key: &str) -> Result<ResolvedKey, AdapterError> {
    resolve_key_in(key, KeyboardLayout::Caller)
}

/// Resolves a key name in `layout`. A pure lookup: the same name and layout
/// always give the same key, and nothing about any thread's layout changes.
pub(crate) fn resolve_key_in(
    key: &str,
    layout: KeyboardLayout,
) -> Result<ResolvedKey, AdapterError> {
    if let Some(vk) = named_key_vk(key) {
        return Ok(ResolvedKey::bare(vk));
    }
    if let Some(resolved) = character_key(key, layout) {
        return Ok(resolved);
    }
    if let Some(symbol) = symbol_character(key) {
        return resolve_symbol(key, symbol, layout);
    }
    Err(unknown_key_error(key))
}

/// The layout of the thread that holds the keyboard focus right now, which
/// is the thread `SendInput` delivers a key to. [`KeyboardLayout::Caller`]
/// when there is no focus window or its layout could not be read.
pub(crate) fn focused_layout() -> KeyboardLayout {
    imp::focused_thread_layout().map_or(KeyboardLayout::Caller, KeyboardLayout::from_handle)
}

/// The punctuation a key name or a single-character key produces. `+` joins
/// a combo, so it is only reachable by name (`plus`, `ctrl+plus`); the other
/// symbols are accepted either by name or as the character itself. The
/// names follow the punctuation names the other platforms accept
/// (`comma`, `period`).
fn symbol_character(key: &str) -> Option<char> {
    let symbol = match key {
        "plus" => '+',
        "minus" | "-" => '-',
        "asterisk" | "*" => '*',
        "slash" | "/" => '/',
        "equal" | "=" => '=',
        "period" | "." => '.',
        "comma" | "," => ',',
        _ => return None,
    };
    Some(symbol)
}

/// A symbol is pressed as the key `layout` produces it with, Shift included
/// (on a Japanese layout `+` is Shift+`;`). There is no fixed virtual key to
/// fall back to: the ASCII value of a symbol is an unrelated virtual key (`+`
/// would be `VK_EXECUTE`), so a layout with no key for the symbol refuses the
/// key instead of pressing another one.
fn resolve_symbol(
    key: &str,
    symbol: char,
    layout: KeyboardLayout,
) -> Result<ResolvedKey, AdapterError> {
    imp::vk_key_scan(symbol, layout)
        .map(resolved_from_scan)
        .ok_or_else(|| {
            AdapterError::new(
                ErrorCode::InvalidArgs,
                format!("Key '{key}' has no key on the target's keyboard layout"),
            )
        })
}

fn named_key_vk(key: &str) -> Option<u16> {
    let vk = match key {
        "return" | "enter" => VK_RETURN,
        "escape" | "esc" => VK_ESCAPE,
        "tab" => VK_TAB,
        "space" => VK_SPACE,
        "delete" | "backspace" => VK_BACK,
        "forwarddelete" => VK_DELETE,
        "home" => VK_HOME,
        "end" => VK_END,
        "pageup" => VK_PRIOR,
        "pagedown" => VK_NEXT,
        "left" => VK_LEFT,
        "right" => VK_RIGHT,
        "down" => VK_DOWN,
        "up" => VK_UP,
        "cmd" | "command" => VK_LWIN,
        "shift" => VK_SHIFT,
        "alt" | "option" => VK_MENU,
        "ctrl" | "control" => VK_CONTROL,
        "f1" => VK_F1,
        "f2" => VK_F2,
        "f3" => VK_F3,
        "f4" => VK_F4,
        "f5" => VK_F5,
        "f6" => VK_F6,
        "f7" => VK_F7,
        "f8" => VK_F8,
        "f9" => VK_F9,
        "f10" => VK_F10,
        "f11" => VK_F11,
        "f12" => VK_F12,
        _ => return None,
    };
    Some(vk)
}

fn character_key(key: &str, layout: KeyboardLayout) -> Option<ResolvedKey> {
    let mut chars = key.chars();
    let character = chars.next()?;
    if chars.next().is_some() {
        return None;
    }
    if !(character.is_ascii_lowercase() || character.is_ascii_digit()) {
        return None;
    }
    Some(resolve_character(character, layout))
}

pub(crate) fn resolve_character(character: char, layout: KeyboardLayout) -> ResolvedKey {
    match imp::vk_key_scan(character, layout) {
        Some(scan) => resolved_from_scan(scan),
        None => ResolvedKey::bare(fallback_ascii_vk(character)),
    }
}

/// `VkKeyScanW` packs the virtual key in the low byte and the modifiers
/// the layout needs in the high byte. Keeping only the low byte presses
/// the key without the shift the layout requires, which produces the
/// wrong character rather than a failure.
pub(crate) fn resolved_from_scan(scan: i16) -> ResolvedKey {
    let state = ((scan as u16) >> 8) as u8;
    ResolvedKey {
        vk: (scan as u16) & 0x00FF,
        layout_shift: state & LAYOUT_SHIFT != 0,
        layout_control: state & LAYOUT_CONTROL != 0,
        layout_alt: state & LAYOUT_ALT != 0,
    }
}

fn fallback_ascii_vk(character: char) -> u16 {
    character.to_ascii_uppercase() as u16
}

fn unknown_key_error(key: &str) -> AdapterError {
    AdapterError::new(ErrorCode::InvalidArgs, format!("Unknown key: '{key}'")).with_suggestion(
        "Valid keys: a-z, 0-9, return, escape, tab, space, delete, forwarddelete, home, end, \
         pageup, pagedown, left, right, up, down, cmd, shift, alt, ctrl, f1-f12, \
         plus, minus (-), asterisk (*), slash (/), equal (=), period (.), comma (,)",
    )
}

#[cfg(target_os = "windows")]
mod imp {
    use super::KeyboardLayout;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetKeyboardLayout, VkKeyScanExW, VkKeyScanW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GUITHREADINFO, GetGUIThreadInfo, GetWindowThreadProcessId,
    };

    pub(super) fn vk_key_scan(character: char, layout: KeyboardLayout) -> Option<i16> {
        let code_unit = character as u16;
        let result = match layout {
            KeyboardLayout::Caller => unsafe { VkKeyScanW(code_unit) },
            KeyboardLayout::Handle(handle) => unsafe {
                VkKeyScanExW(code_unit, handle as *mut core::ffi::c_void)
            },
        };
        if result == -1 {
            return None;
        }
        Some(result)
    }

    /// The layout handle of the foreground thread's focus window (its active
    /// window when nothing inside it has focus). Read-only: it asks which
    /// layout that thread uses and changes nothing.
    pub(super) fn focused_thread_layout() -> Option<isize> {
        let mut info = GUITHREADINFO {
            cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        if unsafe { GetGUIThreadInfo(0, &mut info) } == 0 {
            return None;
        }
        let window = if !info.hwndFocus.is_null() {
            info.hwndFocus
        } else if !info.hwndActive.is_null() {
            info.hwndActive
        } else {
            return None;
        };
        let thread = unsafe { GetWindowThreadProcessId(window, std::ptr::null_mut()) };
        if thread == 0 {
            return None;
        }
        Some(unsafe { GetKeyboardLayout(thread) } as isize)
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::KeyboardLayout;

    pub(super) fn vk_key_scan(_character: char, _layout: KeyboardLayout) -> Option<i16> {
        None
    }

    pub(super) fn focused_thread_layout() -> Option<isize> {
        None
    }
}

#[cfg(test)]
#[path = "keyboard_map_tests.rs"]
mod tests;
