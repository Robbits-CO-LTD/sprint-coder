# Issue #654: Windows helper transport reconnection

## Root Cause Confirmed

On the inherited checkout `8a4404336eb8ad741e185d47a52856c2fe55a5b0`, all four response-cut regressions (1, 64, 68, 70 bytes) failed: the disconnected call rejected, but a correct fresh handshake never restored the same addon. The client-owned `readBuffer` retained old frame bytes and prepended them to each new pipe's handshake. Trust and fresh-addon responses were identical, excluding signer, response corruption and session quarantine as causes. The test clock now bounds all 50 handshake attempts, including attempts that wait for a full handshake timeout; this replaces test timeouts with explicit product rejection.

The decoder buffer now belongs to each socket closure, including handshake retries on the same helper. Existing socket and child identity guards remain. Write callbacks additionally require both their original socket and exact pending-request object, preventing a delayed old write error from deleting or aborting a newer request with a reused id. Removing this guard reproduces a request timeout in the new regression.

Frame layout, header/length/binary/session binding, attestation, retry counts and production deadlines remain unchanged. Existing Stop lane, close retry and input quarantine contracts are preserved.

## Evidence

Windows, Node 22.23.2: four suites, 197 tests passed:

- `computer-use-windows-transport.test.ts`: 19 tests, including all four cut positions, delayed old data/error/close/child exit against a new partial frame, old write callback with reused request id, invalid header/length/JSON body/session binding followed by reconnection, handshake retry, split/coalesced parallel frames, and all eight existing Stop/idle/quarantine tests.
- `computer-use-native.test.ts`: 83 tests.
- `computer-use-native-host.test.ts`: 17 tests.
- `computer-use-controller.test.ts`: 78 tests.

Desktop typecheck and changed-file ESLint/Prettier passed. The tests run real TypeScript transport framing, binding, retries and Main host logic; only child spawn, helper attestation and named pipes are fixtures. No API use, download, credential editing, native-input dispatch or actual signer was involved. Real native mid-frame pipe interruption and packaged UI acceptance are untested; the approved plan marks them additional acceptance rather than this limited TypeScript fix's mandatory gate.

| Acceptance                                                         | Evidence                                                                                                                                 |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1: same addon reconnects after partial header/body              | Four cut-position regressions fail before fix and pass after fix; same-helper handshake retry also passes.                               |
| AC-2: old connection callbacks cannot change current state         | Delayed old data/error/close/exit during current partial response and old write error with reused id pass; no pending timers remain.     |
| AC-3: invalid frames rejected while stop and binding stay enforced | Four invalid-frame controls reject before reconnecting; native, host and controller suites all pass, including existing Stop quarantine. |

Commit, remote and CI status are reported in the draft PR; an outstanding CI result is not a successful check. Do not close the issue without review.

## Latest-main serial checkpoint

Integrated healthy main 02594d0a after PR681 main CI36857679683 completed with 26 successful checks and one intentional platform/scope skip. Windows yuseipc / Node22.23.3 reran the same four suites: **197 PASS**, 4.64s. Desktop typecheck, changed-file ESLint and Prettier passed. No new helper binary, native build, download, signing/credential settings, real input or process enumeration was involved. The branch contains only the three transport/regression/evidence files relative to main. Latest-head independent review and CI, then merge/main CI, remain gates. Native mid-frame interruption and installed UI acceptance remain unverified.

## Mac continuation checkpoint

On 2026-10-01, integrated main `7dbefa83` after PR717 and exact main CI36872485765 completed successfully (26 success / one intentional skip). The Graph test's prior Worker-order assertion is fixed upstream; the initial180s timeout remains separately tracked in OPEN #716. The latest transport diff still contains only these three transport/regression/evidence files, and production transport bytes are unchanged from e169fb27.

Mac arm64 / Node22.23.1: reran all four focused suites, **197 PASS** (transport19 / native83 / host17 / controller78), 1.47s overall. Desktop typecheck and changed-file ESLint/Prettier/diff check pass. This is actual TypeScript transport with fake Windows spawn/pipe/attestation, not Windows native or installed UI acceptance. Dependency installation used npm ci --ignore-scripts --offline; only existing same-OS runtime artifacts were copied, with no native build/download, real input, signing, paid API, credential or security-setting changes.

Main self-review checked per-socket decoder lifetime, exact pending-object ownership, old child/socket guards, coalesced-frame synchronous consumption, timeout settlement and existing Stop/close/quarantine contracts. This is not independent review. Prior e169 review is historical evidence; latest-head ReviewBOT and exact required CI, merge/main CI remain gates. The accepted Issue plan requires the fixture boundary for this limited TS fix; real native mid-frame interruption and installed UI remain additional product acceptance.
