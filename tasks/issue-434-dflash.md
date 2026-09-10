# Issue #434: DFlash2 speculative decoding

Source: https://github.com/Robbits-CO-LTD/sprint-coder/issues/434 (current plan revision 5, read 2026-09-11).
Base: main 51f5705. Existing user changes remain in the original main checkout; this feature uses its own worktree.

## Required outcome

UI model download → target/draft selection → persisted settings → verified private paths → fixed DFlash argv → real pair self-test → actual generation and owned cleanup. This file tracks implementation checkpoints; none replaces the original AC-1 through AC-7 or INV-1 through INV-7.

## Checkpoints

1. Source identity and storage: bounded actual GGUF architecture/context metadata, immutable HF base-model declaration, purpose migration, strict separate settings map, transactionally checked references and deletion.
2. Runtime integration: double integrity/context validation, combined fit, pair-bound verification and runtime reuse, leased/idle protection for both models, capability-bound argv and path redaction.
3. Product integration: typed view/get/set via Main/IPC/preload, legacy target backfill for only the selected immutable row, draft-only download/display, eligible selector and recovery/error/disabled states.
4. Release and acceptance: validate candidate sidecar for all six targets, preserve packaging/signature checks, Windows x64 CPU Qwen3.8-27B/DFlash2 off/on response and structured timings acceptance.

## Current evidence and remaining requirements

| Requirement | State |
| --- | --- |
| AC-1 persistence and restart | Repository storage/reopen and legacy migration covered. UI and selected-target backfill wiring remain. |
| AC-2 draft-only model | Actual GGUF validation precedes publish; purpose stored and normal provider/start/settings routes reject drafts. Draft badge and download UX remain. |
| AC-3 fixed argv | Not implemented. |
| AC-4 invalid pair rejection | Strict values, metadata mismatch, base identity and deletion state handled in data layer. Context, mmproj, private paths and sidecar capability must also be checked at runtime. |
| AC-5 binding and reuse | Setting change invalidates old verification. Combined fit, pair binding/self-test and exact runtime reuse remain. |
| AC-6 ownership and recovery | DB reference/deletion ordering, shared drafts and malformed-map recovery covered. Active runtime ownership and concurrent async operations remain. |
| AC-7 release and real E2E | Not implemented or verified. b10809 is only an upstream candidate; no production pin changed. |

The plan's v78 migration number was stale: main already has migrations through v82. This branch uses additive v83 and retains model identities, existing artifact roles and separate legacy launch settings. HF declarations are only compatibility candidates; they do not constitute pair verification.

## Validation boundary

Current tests use temporary GGUF metadata fixtures and real SQLite via Electron ABI. They do not prove real DFlash inference, the user interface, multi-OS native launch, signed packaging, or all acceptance criteria. Do not merge or close the Issue at this checkpoint. Required independent reviews and final check remain unfulfilled.

## Next action

Connect repository settings/backfill through the controller, then extend fit/verification/lifecycle/supervisor with the same target/draft identity. Keep off behavior compatible and reject on until the sidecar, context and pair self-test evidence are valid.
