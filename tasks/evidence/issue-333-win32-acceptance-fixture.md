# Issue #333 — deterministic Win32 acceptance fixture

Use the fixture documented in
`apps/desktop/computer-use-native/fixtures/win32-acceptance/README.md` for the Windows Core and
Safety rows of the external final gate. Build it on the signed-package x64 Windows machine into a
temporary directory; it is intentionally absent from Sprint Coder packages and release assets.
Before an interactive Computer Use session, Authenticode-sign that exact fixture with the same
release certificate as the packaged Sprint Coder app/helper and verify the signer match. The
unsigned compiler output is Gate 0 evidence only and is rejected by the positive V1 attach policy.

The fixture contributes only the following canonical Core PASS codes:

- `WIN_FIXTURE_IDENTITY_OBSERVE_V1` — exact native identity/window binding plus bounded
  window-only screenshot/tree observation;
- `WIN_FIXTURE_SEMANTIC_ACTIONS_V1` — ordinary Edit, Combo, Checkbox, and Button state changes
  through semantic operations;
- `WIN_FIXTURE_VISUAL_ACTIONS_V1` — normalized-coordinate left click changes only the intended
  ordinary control;
- `WIN_FIXTURE_MIXED_ACTIONS_V1` — semantic and visual operations interleave in one bound session;
- `WIN_FIXTURE_JAPANESE_TEXT_V1` — the fixed Japanese fixture value is visible after
  Unicode-scalar typing.

Use the same fixture for the secure-field, payment, file-picker, focus/geometry/stale,
same-owner-dialog, visual-patch-drift, duplicate, Stop, and type-mid-Stop Safety arrangements where
the fixture README exposes the required control. Installer/admin/OS-prompt, task/turn/policy,
native crash/parent death, prompt-injection, unsigned-package, and privacy journeys must still be
run in their documented environment; a fixture Core PASS does not imply any Safety PASS.

Keep only source/package identity, fixture SHA-256, public signer binding, OS, and bounded results
in the operator record. Inspect window/control state transiently without retaining window titles,
action traces, or visible/typed values in logs. The uploaded artifact contains just the canonical
schema-v3 code and package/provider digests. Never upload the fixture executable, screenshots,
title, typed value, or raw trace.

Before reserving an interactive session, run the read-only `verify-signatures.ps1` procedure in
the fixture README. It checks the app, installer, helper, fixture, and packaged DLL/native modules
for the approved signer, timestamps, and digest stability. Its result is explicitly preparation
only (`interactiveAcceptance: NOT_RUN`), not a schema-v3 Core/Safety PASS. See
[the #387 preparation handoff](issue-387-signed-device-preflight.md) for the current external gates.

The source/build output is non-production and unsigned by default. Its payment button is inert, its
password is dummy text, and its file picker does not retain the selected path. A successful compile
or `--contract-check` without the same-release Authenticode binding is Gate 0 evidence only, not
signed-package acceptance evidence. Core/Safety rows never accept `SKIP`, `HARNESS_PASS`, or
another arbitrary self-attested evidence code.
