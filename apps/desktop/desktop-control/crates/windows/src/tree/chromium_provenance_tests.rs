// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! Chromium content held in a child window (WebView2 in a Tauri, WinForms or
//! WPF window) is found by the child window's class, at any nesting depth.
//!
//! The windows are message-only children of a message-only parent: never
//! shown, no message pump, and `GetClassNameW` answers for them exactly as it
//! does for a real window.

use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, HWND_MESSAGE, WS_CHILD, WS_OVERLAPPED,
};

use super::has_child_window_of_class;
use crate::tree::fixture::fixture_window::{
    register_class, unique_class_name, unregister_class, wide,
};

const CONTENT_CLASS: &str = "Chrome_RenderWidgetHostHWND";

/// Destroys the windows (children first) and unregisters the classes when a
/// test ends, whether its assertions held or not.
struct Windows {
    handles: Vec<HWND>,
    classes: Vec<String>,
}

impl Windows {
    fn new() -> Self {
        Self {
            handles: Vec::new(),
            classes: Vec::new(),
        }
    }

    fn create(&mut self, class: &str, parent: Option<HWND>) -> HWND {
        if !self.classes.iter().any(|known| known == class) {
            register_class(class).expect("the test host must be able to register a class");
            self.classes.push(class.to_owned());
        }
        let name = wide(class);
        let (style, parent) = match parent {
            Some(parent) => (WS_CHILD, parent),
            None => (WS_OVERLAPPED, HWND_MESSAGE),
        };
        let handle = unsafe {
            CreateWindowExW(
                0,
                name.as_ptr(),
                name.as_ptr(),
                style,
                0,
                0,
                0,
                0,
                parent,
                std::ptr::null_mut(),
                GetModuleHandleW(std::ptr::null()),
                std::ptr::null(),
            )
        };
        assert!(!handle.is_null(), "CreateWindowExW produced no window");
        self.handles.push(handle);
        handle
    }
}

impl Drop for Windows {
    fn drop(&mut self) {
        for handle in self.handles.iter().rev() {
            unsafe { DestroyWindow(*handle) };
        }
        for class in &self.classes {
            unregister_class(class);
        }
    }
}

/// The WebView2 shape measured on a Tauri window: the content window sits
/// three windows below the top level (host child, then two Chromium frames).
#[test]
fn content_nested_below_the_host_window_is_found() {
    let mut windows = Windows::new();
    let host_class = unique_class_name();
    let root = windows.create(&host_class, None);
    let host = windows.create(&host_class, Some(root));
    let frame = windows.create(&host_class, Some(host));
    windows.create(CONTENT_CLASS, Some(frame));

    assert!(has_child_window_of_class(root.cast(), CONTENT_CLASS));
}

#[test]
fn a_window_without_chromium_content_is_not_matched() {
    let mut windows = Windows::new();
    let host_class = unique_class_name();
    let root = windows.create(&host_class, None);
    let child = windows.create(&host_class, Some(root));
    windows.create(&host_class, Some(child));

    assert!(!has_child_window_of_class(root.cast(), CONTENT_CLASS));
}

/// The class must match whole: a class that only starts with the content
/// class's name is another class.
#[test]
fn a_class_sharing_only_a_prefix_is_not_matched() {
    let mut windows = Windows::new();
    let host_class = unique_class_name();
    let root = windows.create(&host_class, None);
    let lookalike = format!("{CONTENT_CLASS}X{}", std::process::id());
    windows.create(&lookalike, Some(root));

    assert!(!has_child_window_of_class(root.cast(), CONTENT_CLASS));
}

/// By its handle alone, a top-level window of another toolkit with no Chromium
/// content below it is not of Chromium provenance, and no window at all is
/// not either, so the menu detector's Chromium arm searches neither. (The
/// class and content verdicts are driven by `chromium_provenance_of` and
/// `has_child_window_of_class`; this test registers neither Chromium class,
/// which other tests register at the same time.)
#[test]
fn a_plain_window_or_none_is_not_taken_for_chromium_by_its_handle() {
    let mut windows = Windows::new();
    let host_class = unique_class_name();
    let plain = windows.create(&host_class, None);
    windows.create(&host_class, Some(plain));

    assert!(!super::window_has_chromium_provenance(plain as isize));
    assert!(!super::window_has_chromium_provenance(0));
}
