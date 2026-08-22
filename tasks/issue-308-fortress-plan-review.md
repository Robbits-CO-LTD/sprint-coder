# Fortress Review — Issue #308 pre-implementation plan

## Revision binding

- review_target_kind: `plan`
- base_sha: `d6e19e910dfa1c09fb1324602dd5c4d2ed0a8551`
- issue_plan_version: `010aa882a07bf2fd275da399b245fa4f24fc5f372a2b2dcdf047ea8586f45cb3`
- revision_class: `RVC3_CONTRACT_OR_BOUNDARY`
- affected_lenses: impact, tests, requirements, failure_operations, data_security
- current-head amendments reviewed: PR #313 Ollama preparation failures and PR #314 Provider image failures

## Reviewer availability

The pinned Terra/PowerShell runner is unavailable on this macOS host. No generic subagent was
substituted. These five Sol fallback lenses are explicitly `not_independent`; ReviewBOT and full CI
remain mandatory on the PR head.

| Lens               | Independence      | Status |
| ------------------ | ----------------- | ------ |
| impact             | `not_independent` | PASS   |
| tests              | `not_independent` | PASS   |
| requirements       | `not_independent` | PASS   |
| failure_operations | `not_independent` | PASS   |
| data_security      | `not_independent` | PASS   |

## Lens findings

### Impact

PASS with one revision amendment. Schema version 73 is now occupied by Managed Skill compatibility,
so the diagnostic table rebuild must be migration **v74**. Runtime Host's CLI diagnostic v1 remains
unchanged; the new Provider variant is Main-owned and persisted through a discriminated validator.

### Tests

PASS. Required axes are v69/v73-to-v74 preservation, CLI JSON byte-for-byte compatibility,
Provider timeout/preparation/HTTP/network/malformed stream, cancel exclusion, first-write-wins,
late/next-Turn ownership, 16KiB rejection, persistence failure containment, restart/readback, and
clipboard JSON privacy canaries.

### Requirements

PASS. AC-1 through AC-4 map to a safe Provider cause, a best-effort persistence helper, migration
v74, and the existing Task/latest-or-id IPC. No Provider raw error or conversation data is required.

### Failure and operations

PASS. Only typed Provider-origin failures produce diagnostics. Policy rejection, image-stale local
rejection, user cancellation, replaced Turns, and unowned late errors do not. Diagnostic building,
validation, serialization, and insert cannot block durable Turn termination.

### Data and security

PASS. The Provider variant allowlists runtime/stage/category/retryability/provider/profile/code,
model-preparation state, elapsed time, app version, and timestamp. It excludes model ID, connection
name, endpoint, prompt/output/reasoning/tool data, image data, credentials, paths, and raw errors.

## Frozen execution amendments

1. Add a Main-owned `ProviderFailureDiagnosticV1` and strict persisted union; do not alter
   `RuntimeFailureDiagnostic` or its Runtime Host validator.
2. Use migration v74 to rebuild `runtime_failure_diagnostics`, preserving every existing row and
   enforcing runtime-kind-specific stage checks plus the existing 16KiB bound.
3. Normalize only typed Provider failures. `NormalizedProviderError` is copied without `message` or
   `retryAfterMs`; preparation and deadline errors map from enumerated fields; unknown stream throws
   become a fixed `stream_error/internal` cause.
4. Check Turn ownership before building and immediately before persisting. The existing unique
   `turn_id` constraint remains first-write-wins.
5. Reuse the existing settings clipboard query unchanged; its output is safe only because the
   persistence union validator rejects unknown/oversized rows.

## Verdict

- Findings: no unresolved CRITICAL/HIGH after the v74 and typed-failure amendments.
- Human Gate: migration is high risk but non-destructive within one SQLite transaction; no deploy,
  release, credential, or external communication action is included.
- Verdict: **Go** for the bounded Issue #308 implementation on the bound revision.

## Final diff checkpoint

- Impact: PASS — Main diagnostic union, IPC Provider terminal path, migration v74, tests, and this
  artifact; Runtime Host CLI diagnostic v1 and Renderer bridge remain unchanged.
- Tests: PASS — 978 focused tests with 2 opt-in skips, full SQLite Electron ABI suite, v69/v73-to-v74
  JSON preservation, forced rollback, Provider first-write-wins/restart readback, and 9 packaged
  Settings E2E tests.
- Requirements: PASS — preparation/deadline/normalized/unknown-stream failures are diagnosable;
  cancel/local policy/image stale/late ownership are excluded; copy IPC returns the persisted union.
- Failure/operations: PASS — append, builder, persistence, and logging are best-effort before durable
  terminalization; v74 rebuild is transactional.
- Data/security: PASS — privacy canaries and raw stream throws do not enter diagnostic JSON or logs;
  16KiB and strict-key validation remain fail closed.
- Final fallback verdict: **PASS**, pending independent ReviewBOT and full CI on the PR head.
