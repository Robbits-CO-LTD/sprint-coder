# Issue 692: worker reporting starvation checkpoint

The Windows Electron ABI bridge has failed with Vitest 3.2.7's 60-second
`onTaskUpdate` acknowledgement timeout on multiple heads, including PR681 and
PR697. SQLite assertion failures are not inferred from that reporting error.

## Measured boundary

Windows yuseipc, existing Electron43.5.0/SQLite artifacts, source baseline
8d37122a708959b5cabe7fe7fe291cc7219d389b. The local opt-in observer wraps the worker
RPC call and runner `updated` method without recording arguments, task names,
IDs, paths, or error contents. It records only counts, elapsed time, and event
loop lag; it is not included in the production or ordinary CI configuration.

| Measurement                    |             Before | After test-case yield |
| ------------------------------ | -----------------: | --------------------: |
| Actual SQLite cases            | 233 PASS / 25 SKIP |    233 PASS / 25 SKIP |
| Worker acknowledgement maximum |          34,030 ms |                767 ms |
| Worker maximum pending calls   |                159 |                     3 |
| Worker event loop maximum lag  |          27,347 ms |                591 ms |
| Runner update maximum          |               1 ms |                  1 ms |
| Runner event loop maximum lag  |             123 ms |                129 ms |

Both runs completed all 231 observed reporting calls with zero rejections and
zero pending calls. Source content of the candidate was subsequently committed
as 4d3f0d0a58bc320a387746f9ad508692c7da41eb on the baseline; no assertion or
timeout changed. The normal uninstrumented Node22.23.3-to-Electron bridge also
passed its two wrapper cases in 58.94 seconds on that candidate. These are local
measurements, not evidence that the original hosted 60-second failure was
reproduced or fully explained. Original CI failures remain authoritative.

## Change and limits

The existing synchronous cleanup remains before a native event-loop yield in
`afterEach`. The two fake-clock tests restore real timers in their `finally`
blocks before that hook. Synchronous SQLite cases previously accumulated worker
responses despite fast runner processing; yielding between cases reduces that
measured starvation without extending deadlines, removing cases, suppressing
unhandled errors, or changing product code.

The final branch is based on main28a3b729 so this reporting fix does not depend
on the separate migration in PR681. Its normal bridge passed one wrapper case
in 57.71 seconds; all workspace typechecks, full-repository lint (two existing
warnings), changed-file format, and two independent reviews passed. Exact-head
Windows CI is still required. A green
run alone does not prove all causes of Issue692 are resolved. If the timeout
recurs, collect bounded worker/runner timing at the failing boundary rather than
loosening the RPC deadline or treating missing report data as PASS.

Native artifact reuse: SHA256
D8C62B72396A1BDD5B718122706B9D6B805E0CE5545B029D1563EFA752518FD4. No additional
headers, software, native rebuild, provider call, or security-setting change
was performed. Installed/package/provider acceptance remains separate.
