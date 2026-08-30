# ADR: Computer Use Desktop v1 native boundary

- Status: Accepted; capability remains gated by signed/notarized package acceptance
- Date: 2026-08-29
- Scope: Issue #333 native protocol, macOS module, Windows helper, loading, and packaging

## Context and threats

Computer Use observes and controls one explicitly registered application window. This authority is
materially different from a workspace tool: a reused PID, replaced executable, changed dialog,
lost foreground focus, stale observation, renderer compromise, or substituted native binary could
send input to the wrong target. Screen content and model output are untrusted and cannot expand the
selected app, window, mode, task, provider-egress decision, or policy epoch.

The boundary addresses these concrete threats:

- Renderer/model supplied paths, PIDs, HWNDs, CGWindowIDs, or native actions bypassing Main.
- Source/PATH fallback, unsigned Windows packages, ad-hoc macOS packages, or modified Resources.
- PID/handle reuse, signer or executable replacement, proxy/elevated targets, and geometry drift.
- New dialogs, file choosers, OS/security prompts, secure fields, payment/contract flows,
  installers, administrator/security surfaces, remote desktops, and shell/terminal surfaces.
- Cancellation racing a multi-unit input, duplicate request replay with changed bytes, helper
  orphaning, and malformed/oversized/truncated frames.
- Raw screenshots, accessibility text, typed text, or provider responses crossing persistence or
  ordinary Chat/tool bridges.

## Decision

### Authority and data flow

The trusted flow is:

1. Main consumes a recent, one-shot user activation and asks native code to show the platform app
   picker. Renderer never supplies a path, PID, or window handle.
2. Native returns verified identity facts. Main persists only the profile preference and later asks
   native code to resolve or launch/attach that identity and enumerate windows.
3. Renderer receives opaque Main tokens and display-safe candidates in Electron screen DIP. Native
   process IDs and window handles remain inside Main/native.
4. Main starts a task/policy-bound ephemeral session. Native binds the verified app, exact window,
   process-start identity, cancel epoch, client geometry, and native observation revision.
5. Native captures only that window, returns a bounded screenshot and accessibility projection to
   Main, and revalidates identity/focus/geometry/cancel/risk before and after every atomic input.

Main remains the policy owner. Native code is a second, restrictive enforcement layer and has no
provider, persistence, mode, grant, or policy authority.

Desktop v1 also carries a native-attested `maximumMode` through app identity, stored profile,
window-candidate permit, relist, native session, every observation, and public session status.
Main binds those facts monotonically to the least-privileged value; a missing, malformed, or mixed
attestation becomes `observe_only` and can never be upgraded by Renderer, model output, remembered
preferences, or a later observation. Authoritative target-client `screenBounds` remain ephemeral
inside Main/native (and the bounded internal observation) and reposition the Stop overlay after
start/resume and every observation. They are not a Renderer-supplied start field or durable profile.

The positive v1 mode classes are deliberately narrow. Exact protected system TextEdit and Notepad,
plus the deterministic acceptance fixture only after it is Authenticode-signed by the same release
certificate as Sprint Coder/helper, may attest `full_access_app` with a supported English/Japanese
policy-language result. Officially signed macOS Visual Studio Code may attest at most `supervised`.
Applications without one of those positive v1 classes have no control authority; the current native
attach surface marks them ineligible rather than inferring support. Remote-control, installer,
shell, OS, security, proxy, or otherwise prohibited targets are likewise rejected. Product or
window display-name denylists are defense-in-depth signals only—they never grant a higher mode.
Positive authority comes from the versioned native classifier and verified stable app identity.

### Versioned bounded protocol

Protocol version 1 and API version 1 use a packed 68-byte little-endian header: magic (`SCU1`),
message type, flags, non-zero 128-bit request/session IDs, a cancel ID only on cancel frames, and
separate metadata/binary lengths. UTF-8 JSON metadata is limited to 64 KiB. Binary payload is
limited to 16 MiB so one response can carry an at-most-8-MiB screenshot plus an at-most-512-KiB
tree without base64 inflation. Provider-response limits remain separate.

Bad magic/version/type/IDs, embedded NUL or malformed UTF-8, truncation, trailing bytes, oversized
lengths, and binary request bodies are rejected before a platform call. Exact duplicate requests
replay a bounded cached response. Reusing a request ID with different metadata/binary digest is an
explicit conflict and never executes the second payload.

### macOS implementation

The Objective-C++ N-API module uses AXUIElement, ScreenCaptureKit, CGEvent, NSWorkspace, and a
serial native session map. It is built for Electron 43.2.0/N-API 10 with only this module's
deployment target set to macOS 12.3. ScreenCaptureKit captures a desktop-independent single window;
there is no CG/full-screen fallback. Frames are aspect-preserving, at most 2560x1600 and 8 MiB.

The native picker is an NSOpenPanel restricted to `.app`. Stable signed identity facts are used
only after strict/all-architectures code-sign validity succeeds; invalid signatures fall back to
exact executable-digest identity. Trusted Start may activate the registered app and raise the exact
selected AX window, then boundedly waits and revalidates PID, identity, shareability, window ID, and
geometry. Observe and dispatch bind the last native revision and captured geometry. Focused window,
focused control, coordinate/semantic target, and a bounded AX parent chain are reclassified before
input. Dialog/file/OS prompts and protected/high-impact/shell surfaces fail closed.

### Windows implementation

The x64 C++20/MSVC helper requires Windows build 18362 or later and Windows Graphics Capture
headers. Main launches it at a random named-pipe name. The helper validates its actual parent and
pipe client PID, applies a current-user/SYSTEM pipe ACL and remote-client rejection, restricts DLL
search, keeps COM/UIA/file-picker work on an STA worker, and uses a reader thread so cancel epochs
advance while work is in flight. Parent death cancels pipe I/O and terminates the helper.

IFileOpenDialog selects an explicit `.exe`; Authenticode signer or exact SHA-256 identity is
verified in native code. Persisted identities are re-resolved, optionally launched with a clean
user environment, and matched to top-level client windows. Elevated, proxy, dialog/tool, system
settings, installer, remote desktop, and shell targets are ineligible. HWND/PID values stay on the
Main/helper pipe.

Desktop v1 does not unwrap Windows UWP/package-proxy windows. In particular,
`ApplicationFrameHost.exe`, package activation identity, and title-matched proxy children are not
translated into an underlying app identity or accepted as a registered target. They remain an
explicit AC-30 Compatibility `SKIP` with reason `UNSUPPORTED_WINDOW_PROXY_DOCUMENTED`; adding
support requires a new versioned identity/binding design and native acceptance evidence.

The versioned hard-boundary text classifier recognizes English and Japanese UI text only. Other
UI languages are an explicit AC-30 Compatibility `SKIP` with reason
`UNSUPPORTED_POLICY_LANGUAGE_DOCUMENTED`; those applications must use `supervised` or
`observe_only`, not `full_access_app`, until a new classifier version and acceptance evidence add
that language.

Observation uses UI Automation plus WGC `CreateForWindow`, crops to the client area, and
aspect-preservingly downsizes before PNG encoding. Main converts physical client bounds with
Electron `screenToDipPoint`; normalized native input continues to use physical client pixels.
Dispatch supports UIA semantic actions and foreground-gated click/scroll/key/Unicode-scalar input.
It binds the last observation revision/geometry and focused-control signature, classifies a bounded
UIA parent chain, rechecks process start/elevation/focus/cancel around each atomic SendInput, and
marks only acknowledged/partial effects as unknown.

The process probe establishes OS/UIA/WGC/SendInput API readiness only. It does not fabricate a
target capture; real target capture failure is reported by Observe.

### Manifest, signature, and packaging

`computer-use-native.manifest.json` is the canonical contracts shape and binds the exact lowercase
source commit, platform, architecture, protocol/API/native versions, artifact SHA-256, signer
digest, and capabilities.
Build output always has `signerDigest: null`. Forge derives signer evidence only from the already
signed artifact: Developer ID identity on macOS and valid Authenticode on Windows. Main recomputes
the artifact digest, verifies the helper/module and outer package identity, and requires a packaged
`app.asar` runtime. No arbitrary module, PATH, source-build, or browser fallback exists.

Forge copies exactly one artifact and manifest into Resources and excludes the native build tree
from app.asar. macOS includes `NSScreenCaptureUsageDescription`; only the native module uses the
12.3 deployment target. Unsigned/ad-hoc artifacts can compile and be packaged for tests but cannot
make the capability available.

On Windows the same source commit is compiled into the Authenticode-signed helper probe; the final
gate requires the helper, manifest, package run, artifact name, portable ZIP filename/hash, and
installer filename/hash to agree. The two Windows payload digests are independent, so another
installer from the same signer cannot replace the tested installer. On macOS the manifest is
covered when Forge reseals the signed app, and the final gate compares that signed value with the
package run before accepting evidence.

## No-Go conditions

The capability remains unavailable when any gate is false:

- `SPRINT_CODER_COMPUTER_USE_DESKTOP_V1` is not exactly `1`.
- Runtime is source/dev, Linux, unsigned Windows, ad-hoc macOS, or has a missing/duplicate artifact.
- Manifest target/protocol/API/ABI/digest/signer differs from the packaged bytes and outer identity.
- The complete picker/session/observe/dispatch/cancel/close surface did not handshake.
- Required OS/API/TCC capability is unavailable, the emergency accelerator is not registered, or a
  real session cannot bind its app/window/focus/geometry.
- A frame/request is malformed, stale, canceled, conflicted, oversized, or has an unknown effect.
- A Windows candidate is a UWP, `ApplicationFrameHost.exe`, or another package/proxy window that
  would require identity unwrapping.

These checks do not turn Core or Safety `SKIP` results into success. The feature flag remains closed
until signed Windows x64 and notarized macOS acceptance, real supported-app scenarios, privacy
inspection, and the selected real Provider three-round gate pass.

## Consequences and verification boundary

The native trusted computing base is intentionally small but platform-specific. macOS compilation,
actual addon load/handshake, source contracts, framing, loader gates, package layout, and unsigned/
ad-hoc fail-closed behavior are locally testable. CI compiles the Windows helper with MSVC and the
WGC headers, compiles the macOS module against Electron, and runs loader/protocol/package tests.

This ADR does not claim Windows runtime success from macOS source tests, nor signed/notarized or
real-provider acceptance from CI. The external schema-v3 gate requires exact ordered Core/Safety
journeys for each OS, identity/observation, semantic/visual/mixed and Japanese-text actions,
dialog/focus/geometry/staleness, every hard boundary/takeover, drift/replay/unknown-effect/crash
races, emergency and mid-type Stop, Task/Turn/policy invalidation, prompt injection, privacy, and
unsigned/ad-hoc fail-closed behavior. Each journey also carries a canonical event sequence and
per-event digests. A dedicated GitHub-hosted sealing job derives the final JSON from the bounded
machine transcript and issues GitHub build provenance; the final workflow requires that exact
workflow identity, source digest, run/attempt, and artifact attestation. Missing attestation fails
closed, and hand-edited PASS JSON is not an input. This revision has no trustworthy full-GUI capture
adapter, so its generator refuses every Core/Safety PASS and can attest only incomplete CLOSE_HOLD
evidence. Its Provider binding requires one fixed-image preflight and exactly three
attempted/completed non-OpenRouter rounds without fallback. Those remain external final gates;
merge, tag, and release also remain separately approval-gated.
