# Issue 648: independent save facts and durable retry aliases

Base: main 28a3b729. Scope: persistence journal and regression witnesses; no public IPC or UI change.

Root cause confirmed: prepareUserFileSaveIntent reused completed facts across new operation IDs, while executeUserFileSave returned the old completed result before observing the disk. An external revert therefore left the file unchanged despite saved. Joining an unfinished save also did not reserve the joined operation ID, so a later payload hash could reuse it.

Correction: migration 98 rebuilds the historical v70 table with identical columns, PK, CHECKs, task FK, timestamps and recovery index, replacing the all-state facts UNIQUE with an unfinished-state partial UNIQUE. Canonical completion and file.saved remain transactional. New operation IDs never join completed facts. Durable aliases reserve joined IDs, reference the canonical composite identity with cascade deletion, and validate alias, intent and operation request hashes. Existing operation IDs preserve immutable results across restart and disk changes. Direct operations collisions and changed intent facts are rejected.

Design reviews: root and shutdown_fixes independently reviewed the concrete plan before production edits. Both approved with checks for full intent/hash equality, both operation-ID directions, completed refusal/conflict, migration rollback and FK integrity. Independent implementation review shutdown_fixes found no blocker; its alias-row hash hardening suggestion was applied and fault-tested.

Evidence on yuseipc Windows / Electron 43.5.0 / real Electron-ABI SQLite and source-matching native-safe-fs:
- Before: 2 new regressions FAIL (external revert returned saved while disk stayed before; joined ID accepted changed hash).
- After: 9 dedicated tests PASS: external revert/new ID, immutable old joined ID after restart/revert, hash reuse, refused/conflict then new save, parallel saves exactly one publication/audit, SQLite outage recovery, restart reconcile, historical v70 table in v97 DB to v98 copy/constraints/FK cascade, transactional DDL rollback when schema_migrations insertion fails.
- Subsystem: persistence plus the 2 save files 242 PASS / 25 platform SKIP, 3 files, 64.65 seconds. This runs real SQLite under Electron, not Node ABI mocks.
- Desktop typecheck PASS; changed ESLint and Prettier PASS. Independent implementation hash suggestion added after subsystem check; dedicated tests rerun on final source.

Remaining: exact remote-head full OS CI and installed Windows editor filesSave IPC acceptance. No provider/API/credential activity. Old-binary downgrade compatibility is unverified; preserve the automatically-created pre-migration DB backup and do not recommend downgrade. No merge, release or issue closure.
