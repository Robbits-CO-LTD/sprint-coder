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

The existing normal runtime's limit is 25 and its final action has no subsequent observation.
A focused Controller regression documents 25 Provider plans / 25 native actions / 25 observations
followed by `limit_reached`. The capture does not add an observation to conceal that gap.

## Privacy inspection prerequisite

`inspectComputerUsePrivacySurfaces` is a local, read-only helper for a protected acceptance runner.
It requires explicit regular files below one root, and transient payload samples from the tested
session. It streams DB, log, telemetry, Provider trace, crash, stdout, and stderr files; detects
raw, base64 image, UTF-16LE, and JSON string representations, including chunk boundaries; and
returns only surface enums, bounded counts, file digests, and detected payload categories.
Missing payload categories, missing/unreadable/changed files, symlinks, duplicate paths, and size
limits remain uninspected. Owned byte buffers are cleared; caller-owned inputs are not modified.

An inspected file is not proof of a complete sink inventory. The protected runner must enumerate
all relevant files (including SQLite WAL/SHM and rotated files), flush/close the tested processes,
account for disabled/no-file sinks from independent runtime facts, and exclude later writes.
Compressed archives, encrypted databases, escaped Unicode variants beyond JSON.stringify, and
remote Provider storage are not decoded/scanned by this helper. Their absence cannot be inferred.
The helper neither scans live user data automatically nor claims final privacy acceptance.

## Remaining required connections

| Requirement                                    | Current evidence                           | Required next boundary                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Actual Provider and canonical action           | Production emit sites; direct tests        | Selected non-OpenRouter, fixed-image preflight and exact 3 live rounds separately on each OS                                                 |
| Bounded runtime / final state                  | Final-update gap reproduced                | User-selected normal session limit, final fresh observation without a fourth Provider request; Stop/policy race tests                        |
| Semantic plus typing/scroll, TTL, egress, cost | Partial runtime metadata only              | Correlated action-class/TTL/consent/budget assertions, final app state, both OS sessions                                                     |
| Source/package/signer                          | Native manifest digest observed            | Independent exact-source portable/installer/DMG and signer verification from #387                                                            |
| Native zero-after-Stop                         | Logical call pairs and cancel/close result | Native OS-input-API attempt counter bound to session/cancel epoch; never infer physical calls from logical dispatch                          |
| Privacy                                        | Direct tests of explicit-file scanner      | Full sink inventory and transient payload samples from each real package run; independently inspect unsupported formats                      |
| Safety                                         | Direct Controller/planner regressions      | Original AC/INV proportional direct tests and representative per-OS Core hard-boundary/Stop scenarios in parent map                          |
| Canonical transcript and protected sealing     | All PASS imports rejected                  | Reviewed assertions consuming source-bound runtime/native/privacy facts, complete original AC coverage, protected collection and attestation |

The native probe must count **attempts reaching an OS input API**, not successful effects. A
SendInput/AX result is a separate outcome. Proposed counters require atomic increments directly
before the OS call and a Stop barrier binding acknowledgement to the same session/cancel epoch.
Their absence stays `null`; an unavailable probe is never zero. Native ABI/protocol changes and
both OS verification require a separate coordinated implementation checkpoint.

Schema v3's single Provider binding cannot establish two OS runs, five-action full-access runs
with zero Approval Cards, remembered one-click start, file-picker resume, third-party state change,
or a supervised bounded-grant journey. These original parent requirements remain mandatory.
Adding synthetic canonical event names or hashing manually entered PASS rows is not a solution.
New observer code also requires new signed packages from its exact integrated source revision;
the published beta.3 package is a notarized baseline only.
