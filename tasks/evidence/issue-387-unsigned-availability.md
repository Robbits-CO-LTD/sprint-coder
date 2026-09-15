# Issue #387: real unsigned-package availability check

Verified 2026-09-15 on `mainpc`, Windows `10.0.26200.0`, Node `22.23.2`.
Result: **PASS for the bounded unsigned availability negative case**. The actual packaged
application, with explicit Computer Use opt-in, returned neither observe nor control capability.
Signed positive journeys, native input, API-v2/cancel acceptance, and the canonical attested final
gate remain incomplete. This report does not enable Computer Use or authorize a release.

## Artifact and source binding

The source is the published [v0.7.0-beta.3 release](https://github.com/Robbits-CO-LTD/sprint-coder/releases/tag/v0.7.0-beta.3):
`Sprint-Coder-win32-x64-0.7.0-beta.3.zip`, 218649557 bytes. Its GitHub asset digest, the supplied
Windows ZIP digest, and the ZIP digest after the run all match:
`663a29379f9908f1f9d0beea1e7d4eb89df526748d8326e198f19fe97cf3daeb`.

- Original ZIP: `C:\Users\yusei\sc-issue-434-20260915\beta3.zip` (read only).
- Dedicated extraction: `C:\Users\yusei\sc-issue-387-20260915\negative-beta3-app`.
- Dedicated fresh profile: `C:\Users\yusei\sc-issue-387-20260915\negative-beta3-profile-a`.
- Native manifest source: `5b20208eb7b4f7697105dca2bf9436da3aeec910`, Windows x64,
  protocol/API 1, `signerDigest: null` (the genuine unsigned release manifest).
- App EXE SHA-256: `3474789e77d36afd93df6226d2095733e3e504877d5815c39caa32ca6f229cdd`.
- Full `resources/app.asar` SHA-256:
  `24a1211a83a8f082880b490a4c87de7d4b8d0ff81d7ac3fa85eddcface813d1b`.
- Computer Use helper SHA-256:
  `e375657973ac8a5b2f4fd4b12ec10af09dadf80f8f4d2c11d5cfc0c7262a83e5`.
- `Get-AuthenticodeSignature`: both app and helper `NotSigned`.

Every one of the 113 ZIP file entries was independently streamed, SHA-256 hashed, and compared
with its extracted file after the run. All 113 matched, with no extra package files. The harness
also compared its entire package tree before/after execution:
`5a5bc57681adadd2d7e6ac783620842071f5f161a9df774d2f27bb3f3290a3de` in both cases.
Therefore all packaged application code and native binaries match the original ZIP, not a
modified inspector copy. No fuse was changed; `EnableNodeCliInspectArguments` stayed disabled
(wire value 48). Only the loopback Chromium remote-debugging connection was used.

## Real application call and result

The replay harness starts `Sprint Coder.exe` itself using the new profile and process-local
`SPRINT_CODER_COMPUTER_USE_DESKTOP_V1=1`. `SPRINT_CODER_E2E_BACKGROUND=1` selects the existing
inactive-window presentation; it does not replace the native loader or availability controller.
`SPRINT_CODER_RUNTIME_ADOPT=0` avoids adopting installed coding CLIs. No Provider turn, synthetic
Computer Use binding, fixture payload, task/session creation, OS prompt, or native input was used.

After the real renderer/preload became ready, the only application queries were:

```javascript
await window.sprintCoder.app.getInfo();
await window.sprintCoder.computerUse.availability();
```

The public preload creates the normal validated IPC envelope and empty payload, checks the reply
schema, and routes to Main's actual controller. No raw IPC handler or schema was substituted.
The observed app version was `0.7.0-beta.3`; the complete bounded availability reply was:

```json
{
  "platform": "win32",
  "state": "unsigned_package",
  "featureEnabled": true,
  "packageReady": false,
  "handshakeReady": false,
  "observe": false,
  "control": false,
  "available": false,
  "reasonCode": "windows_signature_required",
  "manifestDigest": null
}
```

The source path is `preload/index.ts` availability -> `main/ipc.ts` registered availability
handler -> `ComputerUseController.availability()` -> the real native host. In
`main/computer-use-native.ts`, a valid Windows manifest with `signerDigest === null` returns
`WINDOWS_SIGNATURE_REQUIRED` before `loadRawBinding`. Thus this result is the intended unsigned
gate, not `FEATURE_FLAG_DISABLED`, malformed payload/manifest, an absent fixture, or a missing
native controller implementation. No dispatch was attempted; this check does not claim to measure
the future #388 native input-attempt counter.

## Cleanup and retained evidence

The owned main PID was 55112. Closing its page took the normal BrowserWindow/window-all-closed/
app.quit shutdown path and exited with code 0. Afterwards, that PID and all app/helper processes
whose executable path belonged to this dedicated extraction were absent. No process was killed.
The original ZIP, #434's profile/models/app copy, and OS permissions/settings were unchanged.

The metadata-only machine output is preserved unchanged in
[issue-387-unsigned-availability-result.json](issue-387-unsigned-availability-result.json), copied
from `C:\Users\yusei\sc-issue-387-20260915\negative-beta3-result-a.json`. It contains capability
results, package/fuse digests, and the owned PID/exit result, not screenshots, accessibility trees,
window text, input/prompt bodies, credentials, or raw app stdout/stderr.

Both remote and checked-in evidence bytes have SHA-256
`a78f55d5c0345b566173b4a1b18b9051e3bc4acd51c55d5ae5ba37a4445726c6`; the executed/checked-in harness
hash is `a2fe7571dad331d00d06c4bd53670001a8132db9f6628526bbb89fcf9ea8a0a4`. A final process query
also found zero executable paths under the entire dedicated #387 directory.

This directly observes the behavior described by `AC-29-UNSIGNED-WINDOWS-FAIL-CLOSED` at the
`availability()` boundary, for the published beta.3 (`5b20208`) unsigned bytes only. It does not
satisfy that row: the canonical evidence code `UNSIGNED_WINDOWS_FAIL_CLOSED_V1` requires the frozen
integrated SHA and a schema-v3 attested transcript. The JSON is a local diagnostic result, **not**
the schema-v3 attested canonical transcript; it must not be submitted or relabelled as the complete
final-gate artifact.

## Main: exact replay

The checked-in [harness](issue-387-unsigned-availability.mjs) was copied to
`C:\Users\yusei\sc-issue-387-20260915\unsigned-availability.mjs`. On Windows, this command uses
the unchanged extraction and existing read-only Playwright dependencies. It uses fresh `-b`
profile/evidence paths and refuses to overwrite them:

```powershell
& 'C:\Users\yusei\sc-windows-validation-20260914\node-v22.23.2-win-x64\node.exe' `
  'C:\Users\yusei\sc-issue-387-20260915\unsigned-availability.mjs' `
  'C:\Users\yusei\sc-issue-387-20260915\negative-beta3-app' `
  'C:\Users\yusei\sc-issue-387-20260915\negative-beta3-profile-b' `
  'C:\Users\yusei\sc-windows-validation-20260914\repo' `
  'C:\Users\yusei\sc-issue-387-20260915\negative-beta3-result-b.json'
```

Expected exit: 0, bounded report `status: PASS`, `normalExit.code: 0`, package/fuses unchanged,
and exactly the availability reply above. Replay requires Main's allocated app interval, not a
new signing certificate. Signed positive/API-v2/cancel runs require new exact-source packages,
approved signing identity, and separately coordinated GUI/input authorization.
