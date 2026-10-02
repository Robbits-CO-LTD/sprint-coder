# #692 bounded SQLite bridge reporting checkpoint

#681 head 0f5da597 failed Windows shard 3/3 twice at the child Vitest
`onTaskUpdate` RPC acknowledgment boundary (100.24s / 108.33s), with no reported SQLite
assertion failure. The 180s bridge process deadline was not reached. Build/required failures
were aggregation consequences. Historical closed #578 describes the same earlier-main RPC
failure and remains closed; #689 is a different Coordinator 420s cumulative process budget.

Existing-artifact yuseipc Node22 -> Electron bridge passed at unchanged source (40.85s).
That does not override required CI, or prove the missing acknowledgment's underlying cause.

This test-only checkpoint keeps default reporting, async execFile, 180s process deadline,
185s outer test deadline, maxBuffer, full SQLite coverage and failure propagation unchanged.
An additional JSON reporter writes to a uniquely created test-owned temporary directory.
Only on failure, the bridge appends a bounded summary: non-negative safe integer counts and
at most five failed assertion titles of 120 characters with control/format characters removed.
Raw stdout, report error bodies, full names, paths, prompts, responses and failureMessages
are not copied into the new summary. Missing/unreadable/oversized (>2MiB) reports have distinct
markers. Failure still throws, retaining only whitelisted exit code, signal, killed state and
a fixed RPC-boundary boolean. The raw execFile error is never attached as cause because Vitest
prints cause messages and those contain child stderr/paths. Finally removes the owned directory.

The diagnostic fixture verifies excluded private data, counts, five-title and 120-character
bounds, control removal, missing/malformed/oversized reports, and privacy of all serialized
wrapper Error properties with a raw child-error fixture. Real Windows Node22 / existing
Electron43.5.0 ABI bridge plus diagnostic fixture: **2 PASS**, 56.68s; the child SQLite suite
completed successfully. Desktop TypeScript, changed-file ESLint zero warnings, Prettier and
diff checks passed. No download, native rebuild, API, credential, or security-setting change.

Root accepted the observation-only design. First review found that preserving the raw child
error as cause violated the privacy requirement; root's initial summary review missed the
formatter's cause display. The implementation now removes raw cause, tests serialized wrapper
properties, and root's second review passed. Independent final review is recorded in PR #681.
This is diagnostic instrumentation, not a claimed #692 fix. The exact new-head CI must still
establish whether the reporting failure persists and supplies enough metadata for further RCA.
