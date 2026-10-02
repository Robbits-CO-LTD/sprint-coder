# Issue 648: independent save facts and durable retry aliases

Current integration base: main 7e5e19a3. Original implementation base: main 28a3b729. Scope: persistence journal and regression witnesses; no public IPC or UI change.

Root cause confirmed: prepareUserFileSaveIntent reused completed facts across new operation IDs, while executeUserFileSave returned the old completed result before observing the disk. An external revert therefore left the file unchanged despite saved. Joining an unfinished save also did not reserve the joined operation ID, so a later payload hash could reuse it.

Correction: migration 98 rebuilds the historical v70 table with identical columns, PK, CHECKs, task FK, timestamps and recovery index, replacing the all-state facts UNIQUE with an unfinished-state partial UNIQUE. Canonical completion and file.saved remain transactional. New operation IDs never join completed facts. Durable aliases reserve joined IDs, reference the canonical composite identity with cascade deletion, and validate alias, intent and operation request hashes. Existing operation IDs preserve immutable results across restart and disk changes. Direct operations collisions and changed intent facts are rejected.

Design reviews: root and shutdown_fixes independently reviewed the concrete plan before production edits. Both approved with checks for full intent/hash equality, both operation-ID directions, completed refusal/conflict, migration rollback and FK integrity. Independent implementation review shutdown_fixes found no blocker; its alias-row hash hardening suggestion was applied and fault-tested.

Historical evidence before the current main synchronization (yuseipc Windows / Electron 43.5.0 / real Electron-ABI SQLite):

- Before: 2 new regressions FAIL (external revert returned saved while disk stayed before; joined ID accepted changed hash).
- After: 9 dedicated tests PASS: external revert/new ID, immutable old joined ID after restart/revert, hash reuse, refused/conflict then new save, parallel saves exactly one publication/audit, SQLite outage recovery, restart reconcile, historical v70 table in v97 DB to v98 copy/constraints/FK cascade, transactional DDL rollback when schema_migrations insertion fails.
- Subsystem: persistence plus the 2 save files 242 PASS / 25 platform SKIP, 3 files, 64.65 seconds. This runs real SQLite under Electron, not Node ABI mocks.
- Desktop typecheck PASS; changed ESLint and Prettier PASS. Independent implementation hash suggestion added after subsystem check; dedicated tests rerun on final source.

Remaining: exact remote-head full OS CI and installed Windows editor filesSave IPC acceptance. No provider/API/credential activity. Old-binary downgrade compatibility is unverified; preserve the automatically-created pre-migration DB backup and do not recommend downgrade. No merge, release or issue closure.

Current synchronization retains the existing isolated worktree and five untracked local logs. Native build/download remains on hold: the integration check reuses the existing offline C6 artifact, not a newly compiled head-specific binary. Previously confirmed local 275 PASS / 33 SKIP at 094ee857 and that head's independent source review are historical only; the latest head requires fresh tests, review and CI. The #712 recovery retention and #714 initialization synchronization changes are inherited from healthy main, not duplicated in this PR.

Latest-main integration execution before final commit: real Electron SQLite/migration/Saga/workspace four suites **276 PASS / 33 platform SKIP** (55.01s); native-file-publication separately **3 PASS** using the existing C6 artifact. TypeScript, changed-file ESLint and Prettier passed. This is 279 passing cases across five files in two commands, not a same-head native rebuild or installed UI acceptance. The final commit's independent review and full hosted CI remain gates.
