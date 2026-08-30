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

Keep package identity, fixture SHA-256, signer binding, window title, action trace, and visible
control values in the local operator work log only. The uploaded artifact contains just the canonical schema-v3 code
and package/provider digests. Never upload the fixture executable, screenshots, title, typed value,
or raw trace.

The source/build output is non-production and unsigned by default. Its payment button is inert, its
password is dummy text, and its file picker does not retain the selected path. A successful compile
or `--contract-check` without the same-release Authenticode binding is Gate 0 evidence only, not
signed-package acceptance evidence. Core/Safety rows never accept `SKIP`, `HARNESS_PASS`, or
another arbitrary self-attested evidence code.
