// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::*;

/// The virtual key a name resolves to, dropping the layout modifiers the
/// scan-decoding tests below assert separately.
fn key_name_to_vk(key: &str) -> Result<u16, AdapterError> {
    resolve_key(key).map(|resolved| resolved.vk)
}

/// Every key name `crates/macos/src/input/keyboard/keyboard_map.rs::key_name_to_code`
/// accepts, transcribed as data. A silently-narrower Windows vocabulary must
/// fail this test rather than ship: the name *resolves* on both
/// platforms even though the combo it forms does not mean the same thing.
const MACOS_KEY_VOCABULARY: &[&str] = &[
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
    "g",
    "h",
    "i",
    "j",
    "k",
    "l",
    "m",
    "n",
    "o",
    "p",
    "q",
    "r",
    "s",
    "t",
    "u",
    "v",
    "w",
    "x",
    "y",
    "z",
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "return",
    "enter",
    "escape",
    "esc",
    "tab",
    "space",
    "delete",
    "backspace",
    "forwarddelete",
    "home",
    "end",
    "pageup",
    "pagedown",
    "left",
    "right",
    "down",
    "up",
    "cmd",
    "command",
    "shift",
    "alt",
    "option",
    "ctrl",
    "control",
    "f1",
    "f2",
    "f3",
    "f4",
    "f5",
    "f6",
    "f7",
    "f8",
    "f9",
    "f10",
    "f11",
    "f12",
];

#[test]
fn every_macos_key_name_resolves_on_windows() {
    let unmapped: Vec<&str> = MACOS_KEY_VOCABULARY
        .iter()
        .copied()
        .filter(|name| key_name_to_vk(name).is_err())
        .collect();

    assert!(
        unmapped.is_empty(),
        "Windows must resolve every macOS key name; unmapped: {unmapped:?}"
    );
}

#[test]
fn named_key_aliases_resolve_to_same_code() {
    assert_eq!(key_name_to_vk("return").unwrap(), VK_RETURN);
    assert_eq!(key_name_to_vk("enter").unwrap(), VK_RETURN);
    assert_eq!(key_name_to_vk("escape").unwrap(), VK_ESCAPE);
    assert_eq!(key_name_to_vk("esc").unwrap(), VK_ESCAPE);
    assert_eq!(key_name_to_vk("alt").unwrap(), VK_MENU);
    assert_eq!(key_name_to_vk("option").unwrap(), VK_MENU);
    assert_eq!(key_name_to_vk("cmd").unwrap(), VK_LWIN);
    assert_eq!(key_name_to_vk("command").unwrap(), VK_LWIN);
    assert_eq!(key_name_to_vk("ctrl").unwrap(), VK_CONTROL);
    assert_eq!(key_name_to_vk("control").unwrap(), VK_CONTROL);
}

#[test]
fn delete_and_backspace_map_to_the_backspace_key_not_forward_delete() {
    assert_eq!(key_name_to_vk("delete").unwrap(), VK_BACK);
    assert_eq!(key_name_to_vk("backspace").unwrap(), VK_BACK);
    assert_eq!(key_name_to_vk("forwarddelete").unwrap(), VK_DELETE);
    assert_ne!(VK_BACK, VK_DELETE);
}

#[test]
fn navigation_and_function_keys_map_to_expected_codes() {
    assert_eq!(key_name_to_vk("f1").unwrap(), 0x70);
    assert_eq!(key_name_to_vk("f12").unwrap(), 0x7B);
    assert_eq!(key_name_to_vk("tab").unwrap(), VK_TAB);
    assert_eq!(key_name_to_vk("left").unwrap(), VK_LEFT);
    assert_eq!(key_name_to_vk("up").unwrap(), VK_UP);
}

/// The scan's low byte equals the ASCII value on this layout, so this case
/// passes whether or not the shift state was read at all. It pins the
/// coincidence rather than the behaviour; the scan-decoding tests below are
/// the ones that can see the difference.
#[test]
fn digits_resolve_to_their_ascii_derived_virtual_key_on_a_us_layout() {
    for digit in '0'..='9' {
        let name = digit.to_string();
        assert_eq!(
            key_name_to_vk(&name).unwrap(),
            digit as u16,
            "digit VK codes are numerically identical to their ASCII value"
        );
    }
}

#[test]
fn unknown_key_name_returns_invalid_args_error_with_suggestion() {
    let error = key_name_to_vk("hyperkey").unwrap_err();

    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert!(error.message.contains("hyperkey"));
    assert!(error.suggestion.is_some());
}

#[test]
fn multi_character_unnamed_strings_are_rejected_not_silently_truncated() {
    let error = key_name_to_vk("ab").unwrap_err();

    assert_eq!(error.code, ErrorCode::InvalidArgs);
}

#[test]
fn uppercase_letter_names_are_not_accepted_the_vocabulary_is_lowercase() {
    assert!(key_name_to_vk("A").is_err());
}

/// `VkKeyScanW` packs the virtual key in the low byte and the modifiers the
/// layout needs in the high byte. These drive the decoder with synthetic scan
/// results because the mapping is pure and this rig has a US layout, where the
/// shift-requiring cases do not arise - the honest way to cover a case the
/// hardware cannot present.
#[test]
fn a_scan_requiring_shift_carries_shift_as_a_layout_modifier() {
    let resolved = resolved_from_scan(0x0135);

    assert_eq!(resolved.vk, 0x35, "the virtual key is still the low byte");
    assert!(resolved.layout_shift);
    assert!(!resolved.layout_control);
    assert!(!resolved.layout_alt);
    assert_eq!(resolved.layout_modifier_vks(), vec![VK_SHIFT]);
}

#[test]
fn a_scan_requiring_nothing_carries_no_layout_modifier() {
    let resolved = resolved_from_scan(0x0041);

    assert_eq!(resolved.vk, 0x41);
    assert!(!resolved.layout_shift);
    assert!(resolved.layout_modifier_vks().is_empty());
}

#[test]
fn a_scan_requiring_control_and_alt_carries_both() {
    let resolved = resolved_from_scan(0x0651);

    assert!(!resolved.layout_shift);
    assert!(resolved.layout_control);
    assert!(resolved.layout_alt);
    assert_eq!(resolved.layout_modifier_vks(), vec![VK_CONTROL, VK_MENU]);
}

/// A named key is produced by its virtual key alone, so it carries no layout
/// requirement - the case that keeps `layout_modifier_vks` from being read as
/// "always empty" by a reader who has only seen the scan tests above.
#[test]
fn a_named_key_carries_no_layout_modifier() {
    let resolved = resolve_key("return").expect("'return' resolves");

    assert_eq!(resolved.vk, VK_RETURN);
    assert!(resolved.layout_modifier_vks().is_empty());
}

/// Each symbol name resolves to the key the active layout produces the
/// symbol with - the same answer `VkKeyScanW` gives for the character - and
/// the character itself (every symbol but `+`, which joins a combo) resolves
/// to the same key with the same layout modifiers.
#[cfg(target_os = "windows")]
#[test]
fn symbol_names_and_characters_resolve_through_the_active_layout() {
    for (name, symbol) in [
        ("plus", '+'),
        ("minus", '-'),
        ("asterisk", '*'),
        ("slash", '/'),
        ("equal", '='),
        ("period", '.'),
        ("comma", ','),
    ] {
        let Some(scan) = imp::vk_key_scan(symbol, KeyboardLayout::Caller) else {
            assert!(
                resolve_key(name).is_err(),
                "{name}: a symbol the layout cannot produce is refused, not guessed"
            );
            continue;
        };
        let by_name = resolve_key(name).unwrap_or_else(|_| panic!("{name} resolves"));
        assert_eq!(by_name, resolved_from_scan(scan), "{name}");
        if symbol != '+' {
            let by_character =
                resolve_key(&symbol.to_string()).unwrap_or_else(|_| panic!("{symbol} resolves"));
            assert_eq!(
                by_character, by_name,
                "{symbol} and {name} are the same key"
            );
        }
    }
}

/// The ASCII value of a symbol is an unrelated virtual key (`+` is
/// `VK_EXECUTE`), so a symbol never resolves to it.
#[cfg(target_os = "windows")]
#[test]
fn a_symbol_never_resolves_to_its_ascii_value_as_a_virtual_key() {
    for name in ["plus", "asterisk", "slash", "equal", "period", "comma"] {
        if let Ok(resolved) = resolve_key(name) {
            let symbol = symbol_character(name).expect("a symbol name");
            assert_ne!(resolved.vk, symbol as u16, "{name}");
        }
    }
}

/// A layout this session already has loaded, found by its full handle
/// (`0x04110411` is the Japanese keyboard, `0x04090409` the US one). Only the
/// loaded list is read: loading a layout to test against it would add it to
/// the user's input-language switcher, which a test must not do.
#[cfg(target_os = "windows")]
fn loaded_layout(handle: isize) -> Option<KeyboardLayout> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetKeyboardLayoutList;
    let mut layouts = [std::ptr::null_mut(); 64];
    let count = unsafe { GetKeyboardLayoutList(layouts.len() as i32, layouts.as_mut_ptr()) };
    let count = usize::try_from(count).unwrap_or(0).min(layouts.len());
    layouts[..count]
        .iter()
        .any(|layout| *layout as isize == handle)
        .then_some(KeyboardLayout::Handle(handle))
}

#[cfg(target_os = "windows")]
fn layout_scan(character: char, layout: KeyboardLayout) -> ResolvedKey {
    resolved_from_scan(imp::vk_key_scan(character, layout).expect("the layout has the key"))
}

#[cfg(target_os = "windows")]
const VK_OEM_1: u16 = 0xBA;
#[cfg(target_os = "windows")]
const VK_OEM_PLUS: u16 = 0xBB;
#[cfg(target_os = "windows")]
const VK_OEM_MINUS: u16 = 0xBD;

/// On the Japanese keyboard `=` is Shift+`-`, `+` is Shift+`;` and `;` is the
/// key US calls `=` (`VK_OEM_PLUS`). Looked up in the Japanese layout handle,
/// the symbol names press those keys.
#[cfg(target_os = "windows")]
#[test]
fn symbols_resolve_to_the_japanese_layouts_own_keys() {
    let Some(japanese) = loaded_layout(0x0411_0411) else {
        eprintln!("skipped: the Japanese keyboard layout is not loaded in this session");
        return;
    };
    let equal = resolve_key_in("equal", japanese).expect("equal resolves");
    assert_eq!((equal.vk, equal.layout_shift), (VK_OEM_MINUS, true));
    let plus = resolve_key_in("plus", japanese).expect("plus resolves");
    assert_eq!((plus.vk, plus.layout_shift), (VK_OEM_PLUS, true));
    let semicolon = layout_scan(';', japanese);
    assert_eq!((semicolon.vk, semicolon.layout_shift), (VK_OEM_PLUS, false));
    let minus = resolve_key_in("-", japanese).expect("- resolves");
    assert_eq!((minus.vk, minus.layout_shift), (VK_OEM_MINUS, false));
}

/// On the US keyboard `=` is `VK_OEM_PLUS` without Shift, `+` is the same key
/// with Shift, and `;` is `VK_OEM_1`.
#[cfg(target_os = "windows")]
#[test]
fn symbols_resolve_to_the_us_layouts_own_keys() {
    let Some(us) = loaded_layout(0x0409_0409) else {
        eprintln!("skipped: the US keyboard layout is not loaded in this session");
        return;
    };
    let equal = resolve_key_in("equal", us).expect("equal resolves");
    assert_eq!((equal.vk, equal.layout_shift), (VK_OEM_PLUS, false));
    let plus = resolve_key_in("plus", us).expect("plus resolves");
    assert_eq!((plus.vk, plus.layout_shift), (VK_OEM_PLUS, true));
    let semicolon = layout_scan(';', us);
    assert_eq!((semicolon.vk, semicolon.layout_shift), (VK_OEM_1, false));
}

/// The defect itself: the same name is a different key in the two layouts,
/// so a key looked up in the sender's layout types another character in a
/// receiver using the other one.
#[cfg(target_os = "windows")]
#[test]
fn the_same_symbol_is_a_different_key_in_the_us_and_japanese_layouts() {
    let (Some(us), Some(japanese)) = (loaded_layout(0x0409_0409), loaded_layout(0x0411_0411))
    else {
        eprintln!("skipped: the US and Japanese keyboard layouts are not both loaded");
        return;
    };
    for name in ["equal", "plus"] {
        assert_ne!(
            resolve_key_in(name, us).expect("resolves"),
            resolve_key_in(name, japanese).expect("resolves"),
            "{name}"
        );
    }
}

/// A named key does not depend on any layout.
#[cfg(target_os = "windows")]
#[test]
fn a_named_key_is_the_same_in_every_layout() {
    let layout = KeyboardLayout::from_handle(unsafe {
        windows_sys::Win32::UI::Input::KeyboardAndMouse::GetKeyboardLayout(0)
    } as isize);
    for name in ["return", "tab", "f5", "left"] {
        assert_eq!(
            resolve_key_in(name, layout).expect("resolves"),
            resolve_key_in(name, KeyboardLayout::Caller).expect("resolves"),
            "{name}"
        );
    }
}

/// A layout handle of zero, what an unreadable thread answers, falls back to
/// the caller's layout: the behaviour before the receiver's layout was read.
#[test]
fn an_unreadable_layout_falls_back_to_the_callers() {
    assert_eq!(KeyboardLayout::from_handle(0), KeyboardLayout::Caller);
    assert_eq!(
        KeyboardLayout::from_handle(0x0411_0411),
        KeyboardLayout::Handle(0x0411_0411)
    );
}

/// Looking up the caller's layout by its handle gives the same key as the
/// caller-layout lookup, so the handle path changes nothing for an
/// application that uses the same input language as this process.
#[cfg(target_os = "windows")]
#[test]
fn the_callers_own_handle_resolves_like_the_caller_lookup() {
    let own = KeyboardLayout::from_handle(unsafe {
        windows_sys::Win32::UI::Input::KeyboardAndMouse::GetKeyboardLayout(0)
    } as isize);
    for name in ["a", "z", "5", "plus", "minus", "equal", "comma", "period", "slash"] {
        assert_eq!(
            resolve_key_in(name, own).ok(),
            resolve_key_in(name, KeyboardLayout::Caller).ok(),
            "{name}"
        );
    }
}

/// Reading the focused thread's layout only reads: this thread's own layout
/// is the same before and after.
#[cfg(target_os = "windows")]
#[test]
fn reading_the_focused_layout_leaves_this_threads_layout_unchanged() {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetKeyboardLayout;
    let before = unsafe { GetKeyboardLayout(0) } as isize;
    let _ = focused_layout();
    assert_eq!(unsafe { GetKeyboardLayout(0) } as isize, before);
}

#[test]
fn unlisted_punctuation_and_misspelled_symbol_names_stay_unknown() {
    for key in ["!", "#", "equals", "pluss", "+"] {
        let error = resolve_key(key).expect_err("not in the vocabulary");
        assert_eq!(error.code, ErrorCode::InvalidArgs, "{key}");
    }
}

#[test]
fn the_unknown_key_suggestion_lists_the_symbol_names() {
    let suggestion = unknown_key_error("hyperkey")
        .suggestion
        .expect("a suggestion");
    for name in [
        "plus", "minus", "asterisk", "slash", "equal", "period", "comma",
    ] {
        assert!(suggestion.contains(name), "{name}");
    }
}
