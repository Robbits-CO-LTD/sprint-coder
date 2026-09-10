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
| AC-1 persistence and restart | Controller/IPC/preload/UI connected; collapsed cards do not backfill other models. Repository reopen/migration and UI save/off/recovery tests pass. Real-model restart acceptance remains. |
| AC-2 draft-only model | Actual metadata-before-publish, draft badge/search entry, provider/start/settings exclusion connected. Synthetic model tests and hidden Electron UI pass. |
| AC-3 fixed argv | Supervisor validates both ID-owned roots, private GGUF paths and context; literal DFlash argv tested. Manifest/pin capability agreement enforced. Actual DFlash generation remains. |
| AC-4 invalid pair rejection | Store/controller/supervisor checks connected, including mmproj/context/integrity/capability. Rejection tests pass; real-model negative journeys remain. |
| AC-5 binding and reuse | Combined fit includes draft KV/hidden-state scratch; unknown metadata stays unknown. Pair hash/token binding, exact descriptor reuse, deterministic response and structured draft counts are required for verification. Integrated fake-runtime/real-SQLite test passes; real inference remains. |
| AC-6 ownership and recovery | Shared references/deletion ordering, target operation queue, both-model runtime ownership, off/edit idle-stop, recovery and no stale verification connected. Integration tests pass. |
| AC-7 release and real E2E | Candidate b10809 has six pinned assets and is 151 commits ahead of DFlash2 merge b10f9ca. All six native candidate jobs passed in run 34502685442 at 6deb182, including hash/version/help/loopback/auth/stop. The default release config is promoted to that exact b10809 candidate. Windows Qwen/DFlash inference and signed packaging remain. |

The plan's v78 migration number was stale: main already has migrations through v82. This branch uses additive v83 and retains model identities, existing artifact roles and separate legacy launch settings. HF declarations are only compatibility candidates; they do not constitute pair verification.

## Validation boundary

Tests use temporary GGUF fixtures, real SQLite, fake inference responses, and hidden Electron UI. A separate six-target CI run proves native router startup/authentication/stop without loading model weights. These do not prove real DFlash inference, signed packaging, or all acceptance criteria. Do not merge or close the Issue at this checkpoint. Required independent reviews and final check remain unfulfilled.

## Next action

Verify the promoted-head CI, then run actual target/draft inference and Windows product E2E with structured timings. The UI smoke uses synthetic installed rows and verifies support/selection plus rejection of missing model files, not real generation. Obtain independent reviews/final check before ready/merge/close.

## Actual artifact metadata preflight

Read bounded prefixes (not complete models, not full-file hash verification) from immutable HF revisions: target unsloth/Qwen3.8-27B-GGUF@4ca720788d1e01f1bff70c033e0d0028fd02e502 has architecture qwen35, 65 blocks, context 262144, conservative f16 KV 266240 bytes/token. Draft incoai/Qwen3.8-27B-DFlash2-GGUF@51962825493a48b846b40126d35c799ac4093ad0 has architecture dflash, 5 blocks, context 262144, KV 20480 and extracted-hidden scratch 51200 bytes/token. Both declared base Qwen/Qwen3.8-27B. The pair estimator now uses actual target KV metadata when speculative decoding is enabled. This Mac has 24 GiB RAM and about 23 GiB free disk; no full models were downloaded or run.
