# Codebase Patrol Report

- Repository: `Robbits-CO-LTD/sprint-coder`
- Source: `4684eb356d8308995c5eb10a518b11f6df2bca83`
- Mode: `full`
- Publication: candidate discovery was `report-only`; confirmed findings are filed by `bug-investigation-to-issue`
- Profile: Node.js 22 / TypeScript / Electron / React / SQLite / HTTP Provider runtimes
- Tracked files: 752
- Existing user changes preserved: `AGENTS.md`, `.agents/skills/bug-investigation-to-issue/`, `.agents/skills/sprint-coder-real-ai-smoke/`

## Rule results

| Rule | Result | Note |
|---|---|---|
| SEC-01 | PASS | Candidate key material was limited to explicit test fixtures and workflow secret references; no live value was recorded. |
| SEC-02 | PASS | Dynamic SQL and command candidates were bound to validated identifiers or parameterized execution in inspected paths. |
| SEC-03 | SKIP | No public HTTP/RPC authentication profile was established for this desktop-only scan. |
| SEC-04 | SKIP | No multi-tenant ownership contract applies to the local desktop persistence model. |
| SEC-05 | SKIP | No inbound webhook endpoint was detected. |
| ERR-01 | PASS | Inspected explicit result/status paths did not produce an additional confirmed finding. |
| ERR-02 | FAIL | Chat Completions EOF/error frames are converted to a successful completion. |
| ERR-03 | FAIL | Already-aborted signals are not propagated by Provider execution and verification adapters. |
| ERR-04 | FAIL | Bounded catalog and model-download readers do not cancel response bodies on validation failure. |
| DEP-01 | SKIP | The skill's isolated dependency-audit runner requirements were not available; no package-manager audit was run in the working tree. |
| ENC-01 | PASS | Tracked text inspected against `.gitattributes` is UTF-8/ASCII with the declared LF policy. |
| DB-01 | PASS | No new timestamp storage/serialization mismatch was confirmed. |
| DUP-01 | PASS | Repeated Provider code was assessed causally; only the abort propagation defect was retained. |
| DEAD-01 | SKIP | No project-native dead-code analyzer evidence was available. |
| ARCH-01 | PASS | No duplicate endpoint or responsibility defect was confirmed. |
| PERF-01 | PASS | No separate loop-I/O/N+1 finding was confirmed. |
| TYPE-01 | PASS | Inspected casts were paired with validation or constrained internal contracts. |
| MAINT-01 | PASS | No tracked stale/backup artifact with runtime impact was confirmed. |

## Confirmed findings

Five independent root causes passed the runtime/code/history/deduplication gates. Reproduction used Node `v22.23.1` and synthetic local streams/fetches only; no Provider request or production mutation occurred.

1. `961429ff...`: Chat Completions normalizer synthesizes `completed` for empty, truncated, and error-only streams.
2. `19c16e85...`: six Provider execute adapters miss an already-aborted caller signal.
3. `c63efc50...`: Provider verification misses an already-aborted caller signal and persists a verification answer.
4. `df65a82f...`: public catalog oversized responses are rejected without canceling the body.
5. `1f728545...`: local model artifact validation failures leave the response body uncanceled.

No matching open Issue or open PR was found. Closed Issue #135 covers a different cause (missing stream deadlines); its PR did not modify the Chat Completions normalizer.

## Filed issues

- #374: https://github.com/Robbits-CO-LTD/sprint-coder/issues/374
- #375: https://github.com/Robbits-CO-LTD/sprint-coder/issues/375
- #376: https://github.com/Robbits-CO-LTD/sprint-coder/issues/376
- #377: https://github.com/Robbits-CO-LTD/sprint-coder/issues/377
- #378: https://github.com/Robbits-CO-LTD/sprint-coder/issues/378

All five were read back as `OPEN` with one exact fingerprint marker and the existing `bug` label.
