# Computer Use cleanup contract

Browser tab cleanup and Windows app cleanup are separate operations. Calling
`browser.tabs.finalize()` does not release a Windows app, and Computer Use
cleanup does not finalize browser tabs.

## Preflight inventory

Before the first Computer Use launch, activation, or input:

1. Read the current Computer Use `guidance`, `confirmations`, and `api`.
2. Call `sky.list_apps()` and `sky.list_windows()`.
3. Record each returned app id and each window id plus app id.
4. Record the foreground window only when it is known from an immediately
   preceding `activate_window` result or another supported runtime signal.
5. When the runtime cannot identify foreground focus, record
   `focus_capture=unavailable`; never guess it from z-order or list order.
6. Hash or omit window titles before writing the run record.

Keep the preflight inventory in the run record. Treat app and window handles as
opaque. Never reconstruct a handle from a process name, title, or path.

## Ownership decision

Use `scripts/Get-ComputerUseCleanupPlan.ps1` with sanitized before and after
window inventories.

- A window present before the skill began is `reused_existing`. Never close it.
- A window absent before, present after, and created by a recorded
  `sky.launch_app()` is `owned_new` only when the target app has exactly one
  newly returned window.
- A window with no matching launch record, multiple new target-app windows,
  an app mismatch, or incomplete inventories has `unknown` ownership.
- Ownership is attached to the exact returned window id plus app id, not only
  to the process or visible title.

Do not claim ownership of a window merely because the skill activated it.

## Cleanup sequence

1. Stop all input and capture a fresh `sky.list_windows()` inventory.
2. For `owned_new`, rehydrate the exact returned window, verify that it is the
   intended disposable test surface, and send one normal close action
   (`Alt+F4`) through Computer Use.
3. Refresh `sky.list_windows()` and require the owned window to be absent.
4. For `reused_existing`, do not send any close action.
5. If the previously focused window is known, still exists, and is allowed by
   Computer Use safety rules, reactivate it and verify the returned handle.
6. Set the selected window, state, screenshot, coordinate, and element-index
   bindings to `null`. Do not reuse them after cleanup.
7. Append a `cleanup` event describing ownership, close result, focus restore,
   remaining windows, and discarded bindings.

Use `scripts/Confirm-ComputerUseCleanup.ps1` on the post-cleanup inventory.
Do not report completion from the close input alone.

If a close prompt, modal, missing handle, ownership ambiguity, failed close, or
failed focus restore prevents a proven result, do not retry with process
termination. Do not use `Stop-Process`, Task Manager, a terminal, or a forced
close. Record `cleanup_hold`, the remaining window id plus app id, and the
user-visible impact.

## Results

- `cleanup_complete`: every owned window closed, existing windows preserved,
  focus restored when supported, and bindings discarded.
- `cleanup_preserved_existing`: no owned window existed; reused windows were
  preserved and bindings discarded.
- `cleanup_hold`: ownership or cleanup could not be proven. Preserve the
  window and report the residual state.
