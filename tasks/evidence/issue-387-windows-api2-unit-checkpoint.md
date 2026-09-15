# Issue #387: Windows Node units for API 2 at 708f846

Verified on 2026-09-15 through **`ssh mainpc`**. Source:
`708f846472cc7ebdda6bcf5d072dea0f55906445`. Result: **139 passed / 0 failed / 0 skipped**,
Vitest exit 0 on Windows Node `22.23.2`.

This fills the previously unrun Windows-hosted Node unit checkpoint. The suites use synthetic
native bindings, receipts, profiles, and provider behavior, including platform-spanning fixtures.
It is not Windows signed-package, GUI, actual native-input, or attested Core/Safety acceptance.
The native compile, offline protocol, and inert SendInput seam already run by #388 at the same SHA
were deliberately not repeated. The #444 GUI interval was not used.

## Scope and results

| Unmodified suite at the tested source                    | Passed | Failed | Skipped |
| -------------------------------------------------------- | -----: | -----: | ------: |
| `apps/desktop/src/main/computer-use-native.test.ts`      |     55 |      0 |       0 |
| `apps/desktop/src/main/computer-use-native-host.test.ts` |     11 |      0 |       0 |
| `apps/desktop/src/main/computer-use-controller.test.ts`  |     73 |      0 |       0 |
| Total                                                    |    139 |      0 |       0 |

The native/host tests cover unsigned/ad-hoc manifest rejection, API 1/API 2 incompatibility,
identity/provenance and envelope checks, and strict native receipt validation. In particular,
`keeps OS handles inside Main while adapting a complete native controller seam` exercises absent,
malformed, decreasing-count, wrong-session/epoch, extra-field, and late cancel/close receipts.
It verifies that an unconfirmed Stop quarantines availability and subsequent start/observe/dispatch,
and that a late acknowledgement cannot silently restore input. Controller cases cover Stop races,
approval/observation invalidation, hard-boundary denial, and unknown effects without retry.
These assertions were executed as written, without modifying the source or shrinking the AC/INV.

## Isolation and provenance

- Dedicated remote lane:
  `C:\Users\yusei\sc-issue-387-20260915\units-708f846`.
- Full source snapshot: `git archive 708f846472cc7ebdda6bcf5d072dea0f55906445`, 988 tracked
  files. Archive SHA-256:
  `104d7fd604ecfd53413ad0ce64eae58a45e907eba1b9c561009c7fd91d23bd84`, verified before extraction.
  This is an exact snapshot, not a claim that 708f846 was merged into the #387 branch or Main.
- Dependencies were independently copied from the existing Windows validation repository using
  `robocopy /E /XJ`, excluding its `.vite`, `.vite-temp`, and `.cache` directories. No install,
  dependency upgrade, npm command, ABI rebuild, native compile, or shared dependency write ran.
- The only two resulting dependency junctions are `@sprint-coder/contracts` and
  `@sprint-coder/domain`, both targeting this lane's own `packages` directory. No junction points
  back to the old checkout. Actual resolution of Vitest, zod, contracts, and domain was checked
  before executing tests and stayed within the lane.
- `TEMP` and `TMP` pointed to the lane's `tmp` directory; Vitest used one worker. Test artifacts
  and any default cache were confined to the independent lane. No GUI application was launched.
- SHA-256 values for the three suites, their three implementations, runtime capture, and contracts
  were checked against `git show 708f846:<path>` before execution and checked unchanged afterwards.
- Shared `vitest/vitest.mjs`, `electron/dist/electron.exe`, and
  `better-sqlite3/build/Release/better_sqlite3.node` hashes were identical before/after. Their exact
  digests and resolved paths are retained in the summary below. Final own-lane Node process count: 0.

The metadata-only summary is preserved unchanged in
[issue-387-windows-api2-unit-result.json](issue-387-windows-api2-unit-result.json), copied from
`units-708f846\evidence\api2-unit-summary.json`. Local and remote SHA-256 both equal
`f5d79d27f97ded8576eef21cb033069f533c7ca2d4ce8db2f8dfedec54e5d740`.
The full Vitest JSON remains local to the Windows lane at `evidence\vitest-api2.json`, digest
`9a1c4395e3d5ac2407b6ef759c3e191dfe3b876705531689994c8025dc39a39e`.
No screen, input, prompt, credential, or raw native trace was captured.

## Main: exact focused replay

Run through `ssh mainpc` in Windows PowerShell, with the existing source snapshot and independent
dependencies. This example uses a fresh report filename and refuses to replace earlier evidence:

```powershell
$ErrorActionPreference = 'Stop'
$lane = 'C:\Users\yusei\sc-issue-387-20260915\units-708f846'
$node = 'C:\Users\yusei\sc-windows-validation-20260914\node-v22.23.2-win-x64\node.exe'
$report = Join-Path $lane 'evidence\vitest-api2-replay.json'
if (Test-Path -LiteralPath $report) { throw 'EVIDENCE_ALREADY_EXISTS' }
$env:TEMP = Join-Path $lane 'tmp'
$env:TMP = $env:TEMP
Push-Location (Join-Path $lane 'apps\desktop')
try {
  & $node "$lane\node_modules\vitest\vitest.mjs" run `
    src/main/computer-use-native.test.ts `
    src/main/computer-use-native-host.test.ts `
    src/main/computer-use-controller.test.ts `
    --maxWorkers=1 --reporter=json "--outputFile=$report"
  if ($LASTEXITCODE -ne 0) { throw 'FOCUSED_UNITS_FAILED' }
} finally { Pop-Location }
```

## Integration overlap and remaining gates

This checkpoint adds only this document and its new metadata JSON. It changes no #333/#388
runtime, contracts, canonical final-gate document, workflow, fixture, or previous evidence.

The earlier #387 commits remain distinct for Main's integration:

- `97df75b`: signature preflight/units and initial fixture handoff; Main reported it integrated.
- `2ae7f94`: edits `tasks/evidence/issue-387-signed-device-preflight.md` and adds
  `issue-387-unsigned-fixture-build.md`.
- `9f789b3`: edits that same preflight document and adds the unsigned availability `.md`, `.mjs`,
  and `-result.json`. Apply after `2ae7f94`; the shared preflight document is the overlapping path.
  Neither latter commit edits product/native/contract code or the parent/API 2 fixtures.

The existing beta.3 unsigned availability measurement remains valid for its own baseline bytes:
113/113 ZIP files equal, no fuse changes, explicit feature opt-in yet observe/control unavailable,
normal owned-process shutdown. It is not evidence for a new API 2 signed positive run.

Remaining external gates: approved existing Windows release signing identity/operator, an exact
integrated-source signed Windows app/helper/installer/fixture and notarized macOS package,
coordinated GUI/native-input intervals and all original interactive AC/INV journeys, plus protected
runner/configuration and trusted runtime-capture/attestation evidence. The signing question remains
with Main/user; no new signing, permission configuration, or GUI action was authorized or taken here.
