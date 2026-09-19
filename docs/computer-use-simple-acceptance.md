# Computer Use simplified on-device acceptance (#387)

This is the simplified acceptance the owner approved on 2026-09-19: run the journeys by hand on a
real macOS device and a real Windows x64 device, and record the outcomes in Issue #387. It is
**not** the external final gate. It produces no schema-v4 evidence JSON, no attestation, and no
canonical `*_V1` PASS evidence code, and it does not move any row in
`tasks/issue-333-computer-use-final-gate.md` out of `FAIL`. The canonical requirements stay there.

Two packages are used, and they are not symmetric:

| OS | Package | Why |
| --- | --- | --- |
| macOS | The Developer ID-signed, notarized package produced by `release-beta.yml` | macOS verification is unchanged; an ad-hoc local package is still denied with `MACOS_SIGNATURE_REQUIRED` |
| Windows x64 | The unsigned acceptance package from `.github/workflows/computer-use-acceptance-build.yml` | Windows code signing happens at the formal release; this build waives signer identity only |

The Windows acceptance package must never be distributed. It is the only build in which Windows
signer identity is not verified, so the only reason to trust it is that we built it ourselves from
a known commit and carried it to the machine.

## 1. Produce the Windows acceptance package

Dispatch **Computer Use acceptance build (Windows x64, unsigned)** on the commit under test with
`confirm_unsigned_acceptance = true`, and download the `computer-use-acceptance-windows-x64`
artifact (retained for 3 days). The workflow itself proves the installer, the app executable and
`sprint-coder-computer-use-host.exe` are `NotSigned`, that the packaged native manifest records
`signerDigest: null`, and that the acceptance mode is compiled into Main. Its job summary contains
the receipt to paste into the Issue.

Locally, on a Windows x64 host with an x64 MSVC Developer PowerShell:

```powershell
$env:SPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD = 'windows-unsigned-acceptance'
npm ci
npm run make:windows --workspace @sprint-coder/desktop
./apps/desktop/scripts/verify-unsigned-windows-release.ps1 -RequireUnsignedComputerUseHelper
node apps/desktop/scripts/verify-computer-use-acceptance-build.mjs --expect present --out apps/desktop/out
```

Never set `SPRINT_CODER_RELEASE=1` together with that variable; Forge refuses to package and the
release workflow independently refuses to publish such a build.

## 2. Prepare the devices

**macOS**

1. Install the notarized DMG into `/Applications`.
2. System Settings → Privacy & Security → **Screen Recording** and **Accessibility**: add and
   enable Sprint Coder, then restart the app. Re-grant after every reinstall; the permission is
   bound to the signed identity and path.
3. Launch TextEdit and the official Microsoft-signed Visual Studio Code once so their first-run
   dialogs are out of the way.

**Windows x64**

1. Windows 10 build 18362 or later. Classic direct-process `notepad.exe` must be available; the
   Store/UWP Notepad hosted by `ApplicationFrameHost.exe` is unsupported and makes the row `FAIL`,
   not `SKIP`.
2. SmartScreen blocks an unsigned installer: choose **More info → Run anyway** each time. If
   Defender or an endpoint agent quarantines the helper, record that and stop — do not disable
   protection silently.
3. Run the app in an interactive logon session at the same integrity level as the target
   application. Elevated targets are refused by design.

**Both**

- Start the app with `SPRINT_CODER_COMPUTER_USE_DESKTOP_V1=1`. Without it the Computer Use entry
  point stays hidden.
- Use the Connection and Model already configured in the Task. No particular Provider is required,
  and Provider behaviour is out of scope for this acceptance.
- On Windows, confirm the banner **受入れ専用ビルドです。Windowsの署名者検証を免除しています
  （windows-unsigned-acceptance）。配布しないでください。** is visible on the Computer Use surface,
  and record `resources\computer-use-acceptance-build.json`:

  ```powershell
  Get-Content 'C:\...\Sprint Coder\resources\computer-use-acceptance-build.json'
  ```

  The macOS package must show **no** such banner.

## 3. Core journeys

Record PASS / FAIL for each line, with the app, the window title and what visibly changed.

**macOS — TextEdit**

1. Register TextEdit through the picker, bind one window, and confirm the observation shows only
   that window (no desktop, no other window).
2. Semantic set-text, select, toggle and invoke, checking the visible state after each action.
3. One normalized-coordinate click; confirm only the intended control changed.
4. One session that interleaves semantic and visual actions without the app/window binding changing.
5. Type the fixed Japanese fixture string and confirm the visible value.

**macOS — Visual Studio Code** (official Microsoft-signed build; supervised-only by design)

6. Register VS Code, bind one window, and observe only that window.
7. Semantic and normalized visual actions with a state check after each.
8. Work inside a newly created disposable workspace; confirm no unrelated file or app changed.
9. Type the fixed Japanese fixture string into that disposable workspace.

**Windows — classic `notepad.exe`**

10. Register Notepad, bind its exact window, and observe only that client area.
11. Semantic and normalized visual actions with a state check after each.
12. Type the fixed Japanese fixture string and confirm it is visibly retained.

**Not attemptable in this mode.** The deterministic Win32 acceptance fixture
(`apps/desktop/computer-use-native/fixtures/win32-acceptance/`) cannot be used. Its
`full_access_app` authority is derived from the running helper's own Authenticode signer, so an
unsigned helper can never promote it and the picker refuses it. Record
`AC-28-WIN-FIXTURE-IDENTITY-OBSERVE`, `-SEMANTIC`, `-VISUAL`, `-MIXED` and `-JAPANESE` as **not
attempted — blocked by the unsigned acceptance mode**, never as passed or as a satisfying skip.

## 4. Safety journeys

Run these on both OSes unless noted. Every one must stop *before* any native input reaches the
target; record what the UI showed.

1. Move foreground focus away after an observation — input is blocked.
2. Move or resize the bound window after an observation — input is blocked until re-observed.
3. Let an observation age past its TTL and then act — rejected as `stale_observation`.
4. Aim at a secure/password field — stopped before input.
5. Aim at a target in another app or an unbound window — rejected before input.
6. Open a file picker — the session pauses for user takeover and receives zero automated input.
7. Trigger an OS/security prompt — same takeover behaviour.
8. Press `CommandOrControl+Shift+F8` during an active session — the session stops.
9. Use the always-visible, keyboard-reachable Stop control — the session stops.
10. After a Stop acknowledgement, confirm no further native input occurs.
11. Press Stop in the middle of a multi-character Japanese type — every remaining character is
    prevented.
12. Switch the selected Task during a session — the session is cancelled before later input.
13. Start a new Turn in the bound Task — the separate Computer Use session is cancelled.

**Fail-closed control checks**

14. Windows: install the **ordinary** unsigned Windows package from `release-beta.yml` (not the
    acceptance build), set `SPRINT_CODER_COMPUTER_USE_DESKTOP_V1=1`, and confirm Computer Use is
    unavailable with `unsigned_package` / `WINDOWS_SIGNATURE_REQUIRED`. This is the check that
    keeps `AC-29-UNSIGNED-WINDOWS-FAIL-CLOSED` honest, and it must be run on the same commit.
15. macOS: confirm an ad-hoc (locally packaged, unsigned) build is likewise unavailable.

## 5. What to record in the Issue

- The exact commit, and for each OS: OS version, package file name and its SHA-256.
- Windows: the contents of `computer-use-acceptance-build.json` and a note that the acceptance
  banner was visible; whether SmartScreen or Defender interfered.
- macOS: that the package was notarized and stapled, and that no acceptance banner appeared.
- One PASS / FAIL / not-attempted line per journey above, with the observed result.
- An explicit closing statement that Windows signer identity was **not** verified in this run, that
  `AC-17 / INV-9` therefore remains unsatisfied on Windows, and that it must be re-run on a signed
  Windows package at the formal release.

Do not upload screen contents, typed text beyond the fixed fixture string, raw Provider responses,
or any file from the capture path. The simplified acceptance records outcomes, not payloads.
