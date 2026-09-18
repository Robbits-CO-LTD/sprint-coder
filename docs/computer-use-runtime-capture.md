# Computer Use runtime capture boundary (#388)

This is an implementation checkpoint, not completed real-Provider acceptance. The canonical
parent requirements remain in `tasks/issue-333-computer-use-final-gate.md`. The generator still
refuses **every Core/Safety PASS**, including an in-process observation snapshot presented as a
machine transcript. No feature flag, package identity, version, or release is changed.

## Implemented observation path

Main owns one `ComputerUseRuntimeCapture` shared by the actual preflight/planner and Controller.
The Controller records the selected native session and manifest digest before the planner factory
runs. The planner emits attempts immediately before consuming the Provider runtime stream, and
emits successful parsing only after completion, resolution, canonical parsing, and compatibility
permit revalidation. The Controller records accepted observations, Broker action results, paired
native calls and native cancel/close acknowledgement. Recording adds no plan, retry, input,
observation, permission, or persistence operation.

Events contain strict enum values, numbers, and SHA-256 digests. No screen, accessibility text,
prompt, action body, response/reasoning, endpoint, connection/model name, or secret is retained.
The latest session replaces the previous capture; the events kept in Main memory are bounded by the
product's own round and text-action limits rather than by a fixed count, because a `type` action
records a native receipt pair per Unicode scalar. The metadata stream is budgeted the same way and
resets that budget on each session, so neither bound depends on process uptime. There is no file
writer, replay/import interface, Renderer IPC endpoint, or automatic upload. Observer
failure or overflow invalidates that session: it stops contributing events, so the session reads
as truncated rather than complete, while the next user-initiated session still starts clean. None
of that interrupts product operations or Stop.
The local snapshot is detached from the recorder. Digests provide integrity/correlation, not
authentication of their source; unit fixtures can produce them and are never runtime acceptance.

Normal startup can opt into a one-way inherited output pipe (`SPRINT_CODER_COMPUTER_USE_CAPTURE_PIPE=1`
and a per-run nonce). This uses the same bootstrap for startup transport and later recorder
events, with no probe-only CLI, Renderer command, arbitrary fd/path selector, or input authority.
Main uses bounded asynchronous writes, never waits for drain, and unrefs the pipe. Missing,
closed, overflowing or broken pipes invalidate capture only. Recorder overflow also invalidates
the stream, so a truncated recorder cannot acquire a valid terminal frame.
The fixed fd3 is validated by Node's Socket PIPE/TCP descriptor check. Windows inherited pipes
can have no `fstat` mode type, so POSIX FIFO/socket mode bits are not used as a cross-platform gate.
For packaged startup with CU OFF, the native loader intentionally returns a disabled binding.
The hello source comes from the existing Main-embedded build pin, not that binding's zero source;
native manifest availability/readiness remain unchanged. Missing or mismatched pins invalidate
capture only. This metadata does not enable native loading or establish signer authenticity.

`collect-computer-use-runtime.mjs` owns the spawned child and receives only that pipe, checking
pid/ppid/platform and executable bytes. stdout/stderr are ignored rather than persisted. Nonce,
canonical framing and hash chains detect mixing/tampering but do not authenticate the package:
the protected runner's independently verified source/package/signer/process facts are still
required by the parent schema. Collector completion requires the normal shutdown end frame;
hello followed by owned-child termination is startup transport only, not a completed capture.
Its consumer aggregates ordered native request/receipt sequences into one canonical round,
including multiple Unicode-scalar dispatches. Missing TTL/epoch/receipt facts stay incomplete.
The aggregator requires exactly one preflight attempt and a Stop request before acknowledgement;
new work after Stop cannot complete a journey (in-flight drain receipts remain observable).
Each session's platform and native manifest digest must match the owned child's hello. Completion
and canonical summaries are detached and deeply frozen, including frame payloads and nested rounds.
These checks prevent mixed/mutable diagnostic facts; they do not verify signer or running-image
identity and do not make synthetic events into live-Provider evidence.

`exactThreeRoundJourneyObserved` requires one preflight, matching session/provider binding,
three ordered parse/action rounds, per-action matched native call pairs bound to action digest
and observation revision, a later same-window observation after each action, and acknowledged
Stop without later native calls. Missing/extra rounds, replayed native request IDs, drift, an
unparsed action, non-native wait/finish, rejected/uncertain results, and missing final observation
cannot satisfy it. This diagnostic boolean never makes `finalGateEligible` true.

Normal session settings now accept an integer limit of 1–25 (default 25), bound to the trusted
start/quick-start/resume intent and in-memory session/plan grant. This value is not persisted in
the app profile. After the last completed action, the normal runtime obtains one final fresh
observation through the Broker and stops without another Provider plan. Direct tests establish
three plans / three native calls / four observations for limit 3, and no extra observation when
Stop or policy revocation wins. This is the same execution path with or without a recorder.

## Normal packaged transport checkpoints (2026-09-15)

These are metadata-only observations from owned children, not canonical Provider evidence or
generator inputs. All launches used isolated profiles, hidden presentation and CU OFF, with
allowlisted parent/child environments and ignored raw stdout/stderr. No Provider or native input
was requested. Existing signed packages, fuses, other applications and user profiles were not changed.

| Host / package source | Startup hello | Source binding | Terminal frame | Acceptance scope |
| --- | --- | --- | --- | --- |
| macOS arm64 / `931be52fab93c52b10dca922b5d52e15c002cad4` | Received | **Not established**: CU-OFF disabled binding emitted a zero source | Received | Startup transport only; not source-bound |
| macOS arm64 / `0e97b72b5fabe57e9c72e31d538bbb3ad6c2ebd9` | Received | Hello and packaged native manifest matched this source | Received; 2 frames, 0 events, 0 sessions | Source-bound startup and empty-stream shutdown transport only |
| Windows x64, `ssh mainpc` / `0e97b72b5fabe57e9c72e31d538bbb3ad6c2ebd9` | Not received within 30 seconds | Package manifest matched; no hello binding established | Missing | Build/provenance checkpoint; startup transport **FAIL** |
| Windows x64, `ssh mainpc` / `1349068cab54941564403c86c6125077507719f1` | Received | Hello and packaged native manifest matched this source | Missing after owned-child termination | Source-bound startup only; `transportCompleted=false` |
| Windows x64, `ssh mainpc` / same `1349068cab54941564403c86c6125077507719f1`, normal-close follow-up | Received | Same original package; hello source matched | Received after normal Renderer `window.close()`; 2 frames, 0 events, 0 sessions | Empty-stream startup/shutdown transport only; `coreEvidenceComplete=false` |

In both successful source-bound startups, `packaged=true`, `packageReady=false`, and
`coreEvidenceComplete=false`. Native API was 2 and its packaged artifact hash matched the manifest.
macOS used ad-hoc signing with deep/strict verification; Windows app/helper were both `NotSigned`.
Neither proves the required production signer or real-Provider journey. macOS source `1349068`
was not repackaged/retested by this lane; these two OS checkpoints are not a same-SHA final gate.

| Artifact SHA-256 | macOS `0e97b72` | Windows `1349068` |
| --- | --- | --- |
| Executable | `8b1825fbd4530c2c4e5ac48e2b9c423fc1beeb32e1e09f37c92e76dc2cc8718c` | `0fac48c5147268452f65fb2fb83a7d0848b0829609d57f9aa35de8d203df7e3b` |
| app.asar | `43183e7f2c0a65fbeedeafd326ba146afb0c52d68cde84fb612950f8ec7a1c6b` | `eaccef15b93c1c9d20e4c39b736d3fd1b9704ac987e1c847c897ed009c6ffdb2` |
| Native artifact | `4d3d35e9d527b1f8a754229f105d6627f8230fd4bab7c2380b3be89fa9abe226` | `5f62db6415d726002e07a0c1f67feca5e921f2192ad62a28857a08d55f1a03d0` |

The Mac child PID/PPID were 27601/27591; the Windows child PID/PPID were 44124/50964.
Each PPID matched its collector, and an OS process-path read matched the owned executable.
These are historical process/path observations, not independent loaded-image attestation.
Only the owned child handles were terminated. The final Windows GUI handoff check found zero
processes under the #388 lane, PID 44124 absent, and clean source at `1349068`. Generated compiler
objects were retained in lane-local checkpoints; isolated startup profiles were retained without
reading their DB/log bodies. No other lane was stopped or modified.

The Windows fault was reproduced separately in a Node 22.23.2 production-adapter seam on mainpc:
an inherited pipe had no `fstat` FIFO/socket mode bits, while Socket could open it. After `1349068`,
the same adapter emitted 824 synthetic metadata bytes; a regular-file descriptor was refused with
zero file bytes. This is supplemental boundary evidence, not packaged or Provider acceptance.
Focused regression RED became GREEN; related Mac common tests were 53/53, with typecheck/lint PASS.

### Windows normal-close follow-up (same original package)

One subsequent run on mainpc used the unchanged Windows `1349068` package, a new isolated profile,
hidden presentation and CU OFF. The original executable/ASAR hashes above were checked before
launch. The existing Renderer CDP listener was verified as loopback-only and owned by the spawned
app PID; its OS process path matched the owned executable. No Node Inspector, fuse change, Main RPC,
new capture channel, Provider call or native input was used. Renderer `window.close()` was requested
once, taking the normal Windows close/disposal path; there was no forced cleanup.

The child PID/PPID were 75436/46448, with PPID matching the collector. The same normal collector
received the terminal frame and confirmed child exit 0: `transportCompleted=true`, `endFrame=true`,
2 frames, 0 events and 0 sessions. The diagnostic event-chain SHA-256 was
`96f15f74d518ee2148de4ccdc6367067a73849e52bd7698cfdcea78345eb9dd9`.
The wrapper also exited 0. Package contents and fuse state were unchanged before/after:

- Package file count: 113; tree SHA-256:
  `29cfe671fecf6c5ca0e4192ad0811c6031f00a487820d4df3b55025c86677b98`.
- Fuse-state SHA-256:
  `f1660f67c087e200cbbc4f2386221a1d3034ff32d4f802b524e763e4b10b585c`.
- Post-run/reconnection check: #388 lane process count 0; PID 75436 and collector PID 46448 absent;
  Windows source clean at `1349068`. No new app launch was needed for that check.

The earlier force-kill checkpoint and its missing end frame remain valid separate observations;
they are not overwritten or relabeled. This follow-up establishes normal **empty-stream** shutdown
transport, not a Provider journey, signed-package acceptance, full privacy or verified v4 closure.
`packageReady=false` and `coreEvidenceComplete=false` remain in force. Provider/signing user choices
and the remaining qualification/privacy code described below are still required.

### Why the opt-in pipe fix does not change the normal Graph path

`1349068` changes the capture-output descriptor check, its focused test and this document; it does
not change Graph rendering, IPC, Controller, planner or the native loader. With capture unspecified,
`createComputerUseCaptureOutput` returns `undefined` before source-pin evaluation, encoder creation
or Socket construction. The helper is not evaluated as an argument at the Main call site. Therefore
the removed `fstat` check is unreachable in the ordinary capture-disabled Graph path. This is a
source/control-flow and focused-test assessment, not a new Graph E2E run. Main's separately reported
11/11 Graph E2E belongs to its own source/package checkpoint and is not relabeled as this run.

User Provider/signing selections remain pending, and code work also remains: independently verified
package/signer/running-image facts, collector-to-v4 assertion/closure qualification, full privacy
sink inventory and logical coverage, and actual-stream proof for non-generated payload categories.
The generator's blanket Core/Safety PASS refusal is still a code connection to complete; this is
not an external-gates-only hold. No hand-authored or synthetic PASS sealing is enabled here.

## Privacy inspection prerequisite

`inspectComputerUsePrivacySurfaces` is a local, read-only helper for a protected acceptance runner.
It requires explicit regular files below one root, and transient payload samples from the tested
session. It reads one bounded 16MiB file at a time (64MiB total corpus), across DB, log, telemetry,
Provider trace, crash, stdout, and stderr files; detects
raw, base64 image, UTF-16LE, and JSON string representations, including chunk boundaries; and
returns only surface enums, bounded counts, file digests, and detected payload categories.
Missing payload categories, missing/unreadable/changed files, symlinks, duplicate paths, and size
limits remain uninspected. Owned byte buffers are explicitly cleared; temporary JavaScript strings
are released for garbage collection. Complete memory erasure is not guaranteed, and caller-owned
inputs are not modified. An 8MiB image / 64MiB file-corpus regression bounds copying: the previous
overlap implementation copied 8.6GB and took 15.1s locally; file-bounded scanning copied no overlap
and took 276ms in the same fixture. These timings are local diagnostics, not cross-machine limits.

Physical scans remain `raw_bytes_scanned`. SQLite is additionally opened read-only, with
`query_only` and `trusted_schema=OFF`, to inspect bounded stored BLOB/TEXT values in real tables.
The existing 32KiB BLOB / 512-byte-page regression now detects the leak; committed WAL values
are read through SQLite, not by a custom WAL parser. Views are not executed, virtual/generated
tables, missing WAL index, recovery journals, locks and unsupported layouts remain uninspected.
Reader handles are always closed. `logical_values_scanned` reports completed logical inspection;
`contaminated` takes priority whenever a known payload was found.

Gzip uses bounded Node zlib output; ZIP uses the existing yauzl dependency with entry/size/total
bounds, encryption/type refusal and CRC verification. Nothing is extracted to disk. These return
`decoded_bytes_scanned`, which does not claim to interpret arbitrary inner minidump structures.

A zlib stream has no magic number, so a value whose two header bytes satisfy the CM/CINFO/FCHECK
rules is inflated under the same bounds, and one that cannot be inflated is left as the raw bytes
that were already scanned. FDICT is the exception: a body compressed against a preset dictionary
cannot be read here at all, and ordinary text sets that bit as readily as the other header bits
(`"(rest of an ordinary line"` does). The body behind the 4-byte DICTID therefore decides. It is
parsed structurally against RFC 1951 — block headers, code-length and literal/distance code tables,
symbol walk, references bounded by the window CINFO declares — without decompressing anything, and
is accepted only when it ends as a written body ends: on a final block, zero-padded to its last
byte, followed by the 4-byte Adler-32, or by further stored bytes if the body itself ran at least
1KiB first. Only an accepted body leaves the surface `unavailable`; every other outcome, including
running past the 64KiB parse budget, stays a scanned look-alike. Reaching the budget is not
evidence of anything — 63 of the 256 constant byte fills decode into valid symbols for as long as
they repeat — so it is refused rather than trusted.

The regression asserts no misclassification over 29,640 constructed look-alikes (every printable
header prefix with FDICT set, every first body byte, ordinary log, JSON and Japanese continuations),
100,000 random printable-ASCII values, and all 256 constant fills past the budget, with the FDICT
header forced throughout. One-time local sweeps, not checked in and not rerun by CI, covered
2,000,000 random printable-ASCII and 2,000,000 random Japanese/ASCII values and misread none either.
Uniform random **binary** values are the residual: 14 of 2,000,000 parse as written streams and are
refused as `unavailable`, before the header rules themselves cut that by a further factor of about
2,000. The 1KiB floor for trailing bytes comes from the same sweep: without it, 7,962 of those
2,000,000 are misread, while with it the count is the same 14 as demanding that nothing follow the
stream at all.

The costs fall the other way. A real preset-dictionary stream that was cut short, damaged, padded
with something other than zeros, shorter than 1KiB with bytes stored after it, or still running
when the walk spends its 64KiB budget is not recognised and falls back to a raw scan — the same
trade already made for any stream that fails to inflate. Note also that `unavailable` is forgeable by
anyone who can write to an inspected surface, here as elsewhere in this helper (an unopenable
container magic does it in three bytes). It always means "could not be certified clean", never
"a payload was found"; only `contaminated` says that.

No persistence path in this app writes a preset-dictionary stream, or any compressed stream. The
only production source under `apps/*/src` or `packages/*/src` that imports `node:zlib` is this
read-only inspection decoder, which never compresses; there is no compression dependency, SQLite
stores values uncompressed, and no crash reporter is configured. Such a stream on an inspected
surface would have come from outside the app.
A physical or decoded-byte scan is not proof of logical absence or of a complete sink inventory.
The protected runner must enumerate
all relevant files (including SQLite WAL/SHM and rotated files), flush/close the tested processes,
account for disabled/no-file sinks from independent runtime facts, and exclude later writes.
Encrypted databases, unsupported nested formats, escaped Unicode variants beyond JSON.stringify,
and remote Provider storage are not decoded/scanned by this helper. Their absence cannot be inferred.
The helper neither scans live user data automatically nor claims final privacy acceptance.
The present payload-based inspector also requires a nonempty sample for each of six payload
classes. A Provider that emits no reasoning cannot be marked complete by supplying a dummy
sample: independent live stream/egress evidence of non-generation must be added by the collector.
Deleted SQLite values, old WAL frames, full sink inventory, and actual authentication-secret
nonpersistence are not established by these tests. Actual secrets, screens and prompts must
never be sent over the metadata pipe to supply scanner samples.

## Remaining required connections

| Requirement                                    | Current evidence                                                          | Required next boundary                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Actual Provider and canonical action           | Production emit sites; direct tests                                       | Selected non-OpenRouter, fixed-image preflight and exact 3 live rounds separately on each OS                                                 |
| Bounded runtime / final state                  | Normal 1–25 round limit and final observation; direct race tests          | Both OS signed-package final state with real Provider                                                                                        |
| Semantic plus typing/scroll, TTL, egress, cost | Partial runtime metadata only                                             | Correlated action-class/TTL/consent/budget assertions, final app state, both OS sessions                                                     |
| Source/package/signer                          | Native manifest digest observed                                           | Independent exact-source portable/installer/DMG and signer verification from #387                                                            |
| Native zero-after-Stop                         | Native API 2 attempt counter, async drain, direct C++/ASan and host tests | Windows build and both OS representative signed-package input/Stop journeys                                                                  |
| Privacy                                        | Direct tests of explicit-file scanner                                     | Full sink inventory and transient payload samples from each real package run; independently inspect unsupported formats                      |
| Safety                                         | Direct Controller/planner regressions                                     | Original AC/INV proportional direct tests and representative per-OS Core hard-boundary/Stop scenarios in parent map                          |
| Canonical transcript and protected sealing     | All PASS imports rejected                                                 | Reviewed assertions consuming source-bound runtime/native/privacy facts, complete original AC coverage, protected collection and attestation |

Native API **2** counts attempts reaching input/focus APIs, not successful effects. An atomic
counter increments immediately before CGEventPost/AX activation/input calls on macOS and
SendInput/UIA/cursor/focus calls on Windows. One SendInput call may contain multiple events;
counts are API attempts, not characters or cross-platform comparable effect counts.
Receipts bind the count to the same session and cancel epoch. Missing or decreasing counts,
wrong binding, and an API 1 helper/manifest are refused; unknown count remains `null`.

On macOS, Cancel invalidates the epoch immediately and queues an asynchronous drain behind the
existing native serial worker. Its acknowledgement occurs after the accepted down/up pair ends.
Close also queues cleanup, preserving session shared_ptr lifetime without blocking Main on the
state mutex. Worker failure and the host's bounded stop timeout remain unconfirmed; late completion
cannot turn that timeout into an accepted receipt. The Controller publishes `native_unavailable`
instead of a successful user-stop reason when native acknowledgement fails.

The binary frame protocol stays **1** because its header layout is unchanged. Loader, handshake,
build manifest, Forge package checks and final-gate workflow now require native API **2**.
Production-function C++ seams reproduce the pre-fix macOS post-ack calls and establish zero after
the fix, also under ASan/UBSan; Windows SendInput's portable seam distinguishes attempted calls
from successful effects. These tests execute inert OS seams, not signed-device acceptance.

Close requires a strictly bound `closed` / `drained: true` receipt with the requested next cancel
epoch and monotonic attempt count. Cancel or Close puts the host into an input quarantine;
malformed results, errors, and timeouts retain it and the old session. Both availability and the
actual start/observe/dispatch entry points refuse further input. Only a validated Close releases
it. Late fulfillment cannot release a timed-out operation. A repeated already-confirmed Close
does not call native again. Cancel and Close use different bounded deadlines: Cancel only needs the
native input epoch invalidated, while Close also waits for the native stop lane to drain, so its
default deadline follows the native close budget (the macOS stop work shares the serial dispatch
lock and has no internal timeout; the Windows helper transport budgets 10s for a close round trip)
instead of the shorter Cancel acknowledgement deadline. Only a Close that exceeds that budget is
unconfirmed, and the quarantine it leaves is intentional.

For a clean committed checkout after `node build-computer-use-native.mjs`, run
`node verify-computer-use-native-offline.mjs` with Node 22 (and an x64 VS developer environment
on Windows). It verifies the manifest/source/artifact binding and compiles/runs the protocol and
inert SendInput seam without npm dependencies, GUI, signatures, or real input. Its bounded JSON
is compile/contract evidence only; it is not accepted by the final-gate generator.

Schema v3's single Provider binding cannot establish two OS runs, five-action full-access runs
with zero Approval Cards, remembered one-click start, file-picker resume, third-party state change,
or a supervised bounded-grant journey. These original parent requirements remain mandatory.
Adding synthetic canonical event names or hashing manually entered PASS rows is not a solution.
New observer code also requires new signed packages from its exact integrated source revision;
the published beta.3 package is a notarized baseline only.
