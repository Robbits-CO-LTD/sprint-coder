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
The latest session replaces the previous capture; at most 128 events stay in Main memory. There
is no file writer, replay/import interface, Renderer IPC endpoint, or automatic upload. Observer
failure or overflow invalidates the evidence without interrupting product operations or Stop.
The local snapshot is detached from the recorder. Digests provide integrity/correlation, not
authentication of their source; unit fixtures can produce them and are never runtime acceptance.

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

Each successful physical scan is labelled `raw_bytes_scanned`, with `logicalValuesInspected: false`.
In particular, SQLite splits BLOB/TEXT across pages: a direct test stores and reads back a 32KiB
BLOB on 512-byte pages, while whole-payload raw search misses it. The database is therefore never
labelled logically inspected by this helper. Compressed crash archives have the same limitation.
A physical scan is not proof that the logical value is absent, nor of a complete sink inventory.
The protected runner must enumerate
all relevant files (including SQLite WAL/SHM and rotated files), flush/close the tested processes,
account for disabled/no-file sinks from independent runtime facts, and exclude later writes.
Compressed archives, encrypted databases, escaped Unicode variants beyond JSON.stringify, and
remote Provider storage are not decoded/scanned by this helper. Their absence cannot be inferred.
The helper neither scans live user data automatically nor claims final privacy acceptance.

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
does not call native again.

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
