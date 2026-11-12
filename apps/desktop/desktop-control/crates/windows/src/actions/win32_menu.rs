// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! Runs an item of a window's standard menu bar without opening the menu:
//! the item's command is posted to the window as `WM_COMMAND`, as the menu
//! itself does when a person chooses the item. The window stays where it is
//! and takes neither the foreground nor the focus.
//!
//! Nothing that runs the item is sent unless, at that moment, the window is
//! the one the ref was read from (handle, owning process and its instance),
//! is not minimized, still has a menu bar, and its menu - updated the way an
//! opening menu is, by `WM_INITMENU` and `WM_INITMENUPOPUP` for each level on
//! the way down - shows at every level exactly one item with the recorded
//! name, each but the last opening a submenu and none disabled, the last
//! sending the recorded command (`ref_menu`). The levels are matched by name,
//! not by position: some applications rebuild a menu when it opens, which
//! moves its items (7-Zip File Manager does), and the uniqueness of each name
//! in its level is what keeps a moved item from being taken for another.
//! Each popup told it opens is then told it closes (`WM_UNINITMENUPOPUP`, in
//! reverse order), as a closing menu does before the chosen command arrives.
//!
//! The command is posted, not sent: a command that opens a modal dialog
//! (an About box, a file dialog) does not return until the dialog closes, so
//! a send would time out while the command runs. A posted command is queued
//! but cannot be observed, so the result is `delivered_unverified`, except
//! for an item that shows a check mark or a radio mark: its state is read
//! again, the same way, for a short while, and only a change to the expected
//! state reports `delivered_verified`.

use agent_desktop_core::{
    ActionResult, ActionStep, AdapterError, Deadline, DeliverySemantics, ErrorCode,
    InteractionLease, RefEntry, StepMechanism, WindowInfo,
};

const STEP_LABEL: &str = "Win32Menu.PostCommand";

/// The refusal for a window that is gone or now belongs to another process.
fn window_changed() -> AdapterError {
    AdapterError::new(
        ErrorCode::StaleRef,
        "The window the menu item ref was read from is gone or belongs to another process now",
    )
    .with_suggestion("Run 'list-windows' and snapshot --surface menubar again.")
    .with_details(serde_json::json!({ "kind": "menu_window_changed", "retryable": false }))
    .with_disposition(DeliverySemantics::not_delivered())
}

/// What the check mark of the item is expected to read after the command:
/// a check item flips, a radio item becomes the checked one.
pub(crate) fn expected_check(checked: bool, radio: bool) -> Option<bool> {
    if radio {
        (!checked).then_some(true)
    } else if checked {
        Some(false)
    } else {
        None
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use super::*;
    use agent_desktop_core::{
        MenuMismatch, NativeMenuItem, confirm_menu_leaf, match_menu_step, menu_mismatch_error,
    };
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        HMENU, IsIconic, PostMessageW, SMTO_ABORTIFHUNG, SendMessageTimeoutW, WM_COMMAND,
        WM_INITMENU, WM_INITMENUPOPUP, WM_UNINITMENUPOPUP,
    };

    use crate::system::menu::menu_bar::{bar_of, read_level};
    use crate::system::window::window_ops::parse_window_id;

    /// One message never waits longer than this, whatever the action budget.
    const MESSAGE_CAP_MS: u64 = 2_000;
    /// How long a check or radio item's state is watched after the command.
    const VERIFY_MS: u64 = 1_000;
    const VERIFY_STEP_MS: u64 = 100;

    fn unresponsive(message: u32) -> AdapterError {
        AdapterError::new(
            ErrorCode::AppUnresponsive,
            "The application did not answer the menu's opening messages in time, so the menu \
             item was not run",
        )
        .with_platform_detail(format!("SendMessageTimeoutW(0x{message:04X}) failed"))
        .with_details(serde_json::json!({
            "kind": "menu_not_answered",
            "command_sent": false,
            "retryable": true,
        }))
        .with_disposition(DeliverySemantics::not_delivered())
    }

    /// The popups told they open, to be told they close in reverse order.
    struct Opened {
        hwnd: isize,
        popups: Vec<HMENU>,
        deadline: Deadline,
    }

    impl Opened {
        fn send(&self, message: u32, wparam: usize, lparam: isize) -> Result<(), AdapterError> {
            self.deadline.ensure_remaining()?;
            let timeout = self.deadline.remaining_ms().clamp(1, MESSAGE_CAP_MS);
            let mut answer: usize = 0;
            // SAFETY: a message to a window of another process, bounded by the
            // timeout; `SMTO_ABORTIFHUNG` returns at once for a hung window.
            let sent = unsafe {
                SendMessageTimeoutW(
                    self.hwnd as *mut std::ffi::c_void,
                    message,
                    wparam,
                    lparam,
                    SMTO_ABORTIFHUNG,
                    u32::try_from(timeout).unwrap_or(u32::MAX),
                    &mut answer,
                )
            };
            if sent == 0 {
                Err(unresponsive(message))
            } else {
                Ok(())
            }
        }

        fn close(mut self) {
            while let Some(popup) = self.popups.pop() {
                // A failure here changes nothing about what was run.
                let _ = self.send(WM_UNINITMENUPOPUP, popup as usize, 0);
            }
        }
    }

    /// Tells the window its menu opens, down the recorded names, and returns
    /// the item the last name matches, or why the live menu does not show it.
    fn locate(
        hwnd: isize,
        bar: HMENU,
        entry: &RefEntry,
        deadline: Deadline,
    ) -> Result<(Result<NativeMenuItem, MenuMismatch>, Opened), AdapterError> {
        let Some(proof) = entry.identity.in_menu.as_ref() else {
            return Err(agent_desktop_core::menu_ref_refused(entry));
        };
        let mut opened = Opened {
            hwnd,
            popups: Vec::new(),
            deadline,
        };
        opened.send(WM_INITMENU, bar as usize, 0)?;
        let mut menu = bar;
        let last = proof.steps.len().saturating_sub(1);
        for (level, step) in proof.steps.iter().enumerate() {
            let Some(items) = read_level(menu) else {
                return Ok((Err(MenuMismatch::Missing), opened));
            };
            let plain: Vec<NativeMenuItem> = items.iter().map(|(item, _)| item.clone()).collect();
            let index = match match_menu_step(&plain, step) {
                Ok(index) => index,
                Err(mismatch) => return Ok((Err(mismatch), opened)),
            };
            let (item, submenu) = &items[index];
            if level == last {
                return Ok((confirm_menu_leaf(item, proof).map(|_| item.clone()), opened));
            }
            if submenu.is_null() {
                return Ok((Err(MenuMismatch::KindChanged), opened));
            }
            let position = u16::try_from(index).unwrap_or(u16::MAX) as isize;
            // `lParam`: the item's position in its menu, and FALSE for a
            // menu that is not the window menu.
            if let Err(error) = opened.send(WM_INITMENUPOPUP, *submenu as usize, position) {
                opened.close();
                return Err(error);
            }
            opened.popups.push(*submenu);
            menu = *submenu;
        }
        Ok((Err(MenuMismatch::Missing), opened))
    }

    /// Reads the item again the way `locate` does, for its check mark.
    fn read_check(hwnd: isize, entry: &RefEntry, deadline: Deadline) -> Option<bool> {
        let window_id = entry.source.source_window_id.as_deref()?;
        let bar = bar_of(window_id, entry.process.pid.get()).ok()??;
        let (found, opened) = locate(hwnd, bar, entry, deadline).ok()?;
        opened.close();
        found.ok().map(|item| item.checked)
    }

    pub(crate) fn run_menu_command(
        entry: &RefEntry,
        window: &WindowInfo,
        deadline: Deadline,
        _lease: &InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        let proof = entry
            .identity
            .in_menu
            .as_ref()
            .ok_or_else(|| agent_desktop_core::menu_ref_refused(entry))?;
        // `WM_COMMAND` carries a 16-bit identifier; a larger one is not a command
        // this message can send (a capture gives such an item no ref).
        if proof.command_id == 0 || proof.command_id > 0xFFFF {
            return Err(menu_mismatch_error(entry, MenuMismatch::CommandChanged));
        }
        if entry.source.source_window_id.as_deref() != Some(window.id.as_str())
            || window.pid != entry.process.pid
        {
            return Err(window_changed());
        }
        let hwnd = parse_window_id(&window.id)?;
        let instance = entry
            .process
            .process_instance
            .as_deref()
            .ok_or_else(window_changed)?;
        let owner = crate::system::window::window_identity::live_window_owner(
            hwnd as crate::system::window::window_enum::WindowHandle,
        );
        if owner != Some(entry.process.pid)
            || !crate::system::process_identity::matches_instance(entry.process.pid, instance)?
        {
            return Err(window_changed());
        }
        // SAFETY: a plain read of a window handle.
        if unsafe { IsIconic(hwnd as *mut std::ffi::c_void) } != 0 {
            return Err(crate::tree::minimized::minimized_window_error(hwnd));
        }
        let Some(bar) = bar_of(&window.id, entry.process.pid.get())? else {
            return Err(menu_mismatch_error(entry, MenuMismatch::NoMenuBar));
        };
        let (found, opened) = locate(hwnd, bar, entry, deadline)?;
        opened.close();
        let item = found.map_err(|mismatch| menu_mismatch_error(entry, mismatch))?;
        let expected = super::expected_check(item.checked, item.radio);
        let wparam = proof.command_id as usize;
        // SAFETY: posting a message to a window handle; no pointer is passed.
        let posted = unsafe { PostMessageW(hwnd as *mut std::ffi::c_void, WM_COMMAND, wparam, 0) };
        if posted == 0 {
            // SAFETY: reads this thread's last error.
            let code = unsafe { GetLastError() };
            return Err(AdapterError::new(
                ErrorCode::ActionFailed,
                "The menu item's command could not be posted to the window",
            )
            .with_platform_detail(format!("PostMessageW(WM_COMMAND) failed: {code}"))
            .with_details(serde_json::json!({ "kind": "menu_command_not_posted" }))
            .with_disposition(DeliverySemantics::not_delivered()));
        }
        let verified = expected.is_some_and(|expected| {
            let until = std::time::Instant::now() + std::time::Duration::from_millis(VERIFY_MS);
            while std::time::Instant::now() < until && !deadline.is_expired() {
                std::thread::sleep(std::time::Duration::from_millis(VERIFY_STEP_MS));
                match read_check(hwnd, entry, deadline) {
                    Some(checked) if checked == expected => return true,
                    Some(_) => {}
                    None => return false,
                }
            }
            false
        });
        let step = ActionStep::succeeded(STEP_LABEL)
            .with_mechanism(StepMechanism::SemanticApi)
            .with_verified(verified);
        let mut result = ActionResult::delivered_unverified("click")
            .with_steps(vec![step])
            .with_details(serde_json::json!({
                "menu_command": proof.command_id,
                "verification_scope": if verified { "menu_check_state" } else { "unavailable" },
            }));
        if verified {
            result = result.with_verified_delivery();
        }
        Ok(result)
    }
}

#[cfg(target_os = "windows")]
pub(crate) use imp::run_menu_command;

#[cfg(not(target_os = "windows"))]
pub(crate) fn run_menu_command(
    _entry: &RefEntry,
    _window: &WindowInfo,
    _deadline: Deadline,
    _lease: &InteractionLease,
) -> Result<ActionResult, AdapterError> {
    Err(AdapterError::not_supported("run_menu_command"))
}

#[cfg(test)]
#[path = "win32_menu_tests.rs"]
mod tests;
