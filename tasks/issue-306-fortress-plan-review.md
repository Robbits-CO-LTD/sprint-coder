# Fortress Review — Issue #306 pre-implementation plan

## Revision binding

- review_target_kind: `plan`
- base_sha: `d2d64762d373f0e0cf91ed3de27a50393f574501`
- issue_plan_version: `d01444a6e661e370c6d0794b65b1fa6f4104233c1157593f437df6f6a665d4c6`
- revision_class: `RVC3_CONTRACT_OR_BOUNDARY`
- affected_lenses: impact, tests, requirements, failure_operations, data_security
- current-head amendments reviewed: PR #311 clipboard draft/preview flow and PR #313 Ollama preload/lease flow

## Reviewer availability

The pinned Terra/PowerShell runner is unavailable on this macOS host. No generic subagent was
substituted. The five bounded lenses below use the repository's documented Sol fallback shape and
are explicitly `not_independent`.

| Lens               | Reviewer       | Independence      | Status |
| ------------------ | -------------- | ----------------- | ------ |
| impact             | `sol_fallback` | `not_independent` | PASS   |
| tests              | `sol_fallback` | `not_independent` | PASS   |
| requirements       | `sol_fallback` | `not_independent` | PASS   |
| failure_operations | `sol_fallback` | `not_independent` | PASS   |
| data_security      | `sol_fallback` | `not_independent` | PASS   |

## Lens findings

### Impact

PASS with bounded amendments. The existing Codex custody path remains unchanged. Provider inline
images reuse the accepted `image_attachments` rows and existing `ProviderInlineImage` contract;
no DB migration or Renderer byte surface is needed. PR #311 already supplies picker/paste,
thumbnail, removal, and trusted paste gating, so those paths must not be rebuilt.

### Tests

PASS. Required axes are vision/non-vision/unknown Ollama capability, stale task/connection/model/
capability identity, acceptance-time and pre-egress revalidation, exact DB order/MIME/hash/bytes,
single attachment set per current user message across tool rounds, cancel/timeout/error cleanup,
and the unchanged Codex CLI custody path. The final gate is focused contracts/Main/Renderer tests,
provider E2E with mocked `/api/show`, packaged Composer E2E, and full cross-OS CI.

### Requirements

PASS. AC-1 through AC-4 map to the selected-model capability snapshot, transactional acceptance,
Provider message assembly, and the existing Codex branch. Arbitrary files, PDF/OCR, remote image
URLs, and forcing a non-vision model remain explicit non-goals.

### Failure and operations

PASS with a send-order constraint. Provider payload authorization must happen before lifecycle or
capability network calls for that round; after authorization, the selected capability is recaptured
before `runtime.execute`. Capability timeout, malformed `/api/show`, selection drift, and unknown
catalog data fail closed without consuming the accepted images or leaving an in-memory binding.

### Data and security

PASS with a dual-payload constraint. The real payload digest covers messages including base64, but
the policy prompt/secret scan receives an isomorphic redacted message structure without base64.
Egress also receives the attachment manifest digest and raw byte count. Logs, errors, diagnostics,
Renderer IPC, and policy prompt never receive bytes, data URLs, raw `/api/show`, credentials, or
absolute paths.

## Frozen execution amendments

1. Use a discriminated internal capability binding for `codex_cli` and `provider_inline`; keep the
   public capability response unchanged.
2. Ollama capability comes only from a bounded loopback native `/api/show` response whose
   `capabilities` contains `vision`. Model-name heuristics and coarse generic `multimodalInput`
   flags are forbidden; a Runtime without an image-specific snapshot stays unknown.
3. Bind Provider acceptance to task, connection, provider, model, endpoint/connection revision,
   capability digest, and capture age. Revalidate in the acceptance transaction and before every
   Provider round.
4. Attach accepted DB bytes only to the context fragment whose `messageId` equals the current
   Turn's user message ID. Preserve ordinal order and do not reread or duplicate them per round.
5. Authorize a redacted policy projection first; then recheck capability and model selection; then
   prepare the model and send the actual payload. The actual payload digest and attachment manifest
   remain bound to the authorization decision.
6. Use existing `finishAndAdvance`/cancel cleanup to remove Provider bindings on every terminal path;
   do not create Provider temp files or alter Codex custody release.

## Verdict

- Findings: no unresolved CRITICAL/HIGH findings after the amendments above.
- Human Gate: no destructive action, credential change, migration, or residual-risk acceptance.
- Verdict: **Go** for the bounded Issue #306 implementation on the bound revision.

## Final diff checkpoint

- Impact: PASS — eight implementation/test files plus this review artifact; no schema, preload,
  renderer byte API, or Codex custody redesign.
- Tests: PASS — 981 focused desktop tests with 3 opt-in skips, 45 contracts tests, real Ollama
  vision/non-vision probes, real cold-load lifecycle, and 7 packaged Composer E2E tests.
- Requirements: PASS — vision allows Provider inline send; non-vision/unknown/stale fail closed;
  Provider bytes remain Main-owned; Codex select/send/restart/paste behavior is green.
- Failure/operations: PASS — 5-second capability deadline, acceptance and per-round validation,
  all-terminal binding cleanup, no Provider temp files.
- Data/security: PASS — real payload digest includes base64; policy projection contains only MIME
  plus `redacted-image-bytes`; manifest digest/raw count are audited; real paths and raw `/api/show`
  are absent from IPC/log/error output.
- Final fallback verdict: **PASS**, pending independent ReviewBOT and full CI on the PR head.
