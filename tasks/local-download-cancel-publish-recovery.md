# Local download cancel and publish recovery (#656, #659)

Base: `28a3b729` (v0.7.0-beta.14 plus #666). Dedicated branch: `codex/local-recovery-fixes`.

## Scope and checkpoints

User outcome: the same immutable model can be installed after confirmed cancellation; a bundle published before an interrupted database commit can finish installing after restart.

Changes: serialize model identity reuse against cancellation and run startup; replace only a canceled installing job in a SQLite transaction; preserve staging survivors; validate filesystem survivors against the immutable plan and persisted artifact identity before recovery; commit validated final bundles without republishing.

Non-goals: migrations, a journal framework, history retention, installed-model automatic repair, UI redesign, real model downloads, paid providers, release, merge, or issue closure.

Checkpoints: (1) canceled identity and run/cleanup ownership; (2) filesystem publish recovery and SQLite commit; (3) real Controller catalog reconstruction/resume and restart. Independent data integrity/security review remains a separate gate for #659.

## Root cause confirmed

| Issue | Before-fix evidence | Cause | Excluded alternative |
|---|---|---|---|
| #656 | Windows Electron/SQLite fixture: cancel, then enqueue the same plan fails `UNIQUE constraint failed: local_models.id`; other existing tests pass | Deterministic model identity remains in `local_models` after cancellation; create unconditionally inserts it | Network/source validation; a different immutable plan has a separate identity |
| #659 | Windows Electron/SQLite fixture: publish succeeds, injected markInstalled exception, database/store reopen, same job retry returns failed instead of installed | File publication and database commit are separate; retry skips downloaded rows and attempts to publish into the existing final directory | Network, artifact corruption, cancel identity collision; publish-before-final control is distinct |

The implementation directly changes these paths. The same failure fixtures are retained as regression tests. RCA categories A/B/C/D are satisfied by the failure fixture, source/contract trace, independent SQLite/filesystem evidence and the matching post-fix check.

## Acceptance evidence

| Issue / acceptance | Deterministic Windows coverage | Remaining gate |
|---|---|---|
| #656 AC-1 | queued/paused/interrupted/failed cancel, database/store reopen, same model ID/new job UUID, installation and legacy partial cleanup | Draft PR review and exact-head CI |
| #656 AC-2 | active/installed/deleting/delete_failed rejection, atomic transaction rollback on new-job insertion failure | Independent review |
| #656 AC-3 | concurrent same-identity installation, stale cancel, aborted stream completion, cleanup failure, run requested during cleanup | Independent review |
| #659 AC-1 | final rename before DB commit, DB commit exception/failed job, same job and model ID recovered, second restart | Draft PR review and exact-head CI |
| #659 AC-2 | before-publish, one/all staged shards, final, committed cutpoints; missing downloaded partial; publish/rollback rename failure and replay preserve the only staged copy | Independent review |
| #659 AC-3 | size/hash/missing/extra entry/hardlink/junction rejection and preservation; DB identity tampering rejection; duplicate staging/partial conflict; DFlash/baseModelId and mmproj roles retained | Independent security/data integrity review |
| Controller boundary | real create, recoverInterrupted, immutable catalog reconstruction, resume pump, listInstalled and second create; focused Controller suite | Exact-head CI |

## Validation and limits

Windows x64 filesystem and actual SQLite native module through the repository's Electron ABI bridge. Existing Electron 43.5.0 executable selected with `ELECTRON_OVERRIDE_DIST_PATH`; no real model download, credential or paid API is used by fixtures. Desktop typecheck, changed-file ESLint and Prettier checks accompany the focused integration tests. Logs are kept outside Git in the task workspace.

This evidence covers deterministic cutpoints and injected failures, not physical power loss, packaged application UI acceptance, actual GPU/model inference, or macOS/Linux execution. Those must remain distinguished from fixture results. Issues stay open; this branch is for a draft PR, with no merge or release authorized.

Rollback: revert these local changes; no schema migration is introduced. Preserve partial/staging/final bytes during investigation. Recovery never deletes or overwrites an invalid final bundle; staging rollback uses nonrecursive directory removal so a failed reverse rename cannot erase its only copy.
