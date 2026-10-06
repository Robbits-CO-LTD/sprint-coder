# CI runtime reduction

## Confirmed cause and scope

Latest baseline: main `94663c6b`, CI [37307810511](https://github.com/Robbits-CO-LTD/sprint-coder/actions/runs/37307810511).
Elapsed time: 12m53s; accumulated job time: 87.4 minutes (not billing-weighted).
Windows test steps take 326 / 426 / 561 seconds. The default Vitest 3.2.7
sequencer partitions by a filename hash, placing the 209-second Graph bridge
and 93-second persistence bridge in the same shard. Other shards carry less
work. Runner queue time is not the main cause: the test steps themselves are
uneven. Rust compilation is also repeated in seven job definitions, and Archify bypasses
the SQLite/NativeSafeFs caches used by the other packaged jobs.

RCA: A/B/C/D YES. Evidence is the completed run's job steps and file timing
lines, the installed Vitest BaseSequencer source, and ci.yml. No product
timeout or assertion change is needed.

## Change and correctness boundary

- Balance Windows CI files across the existing three shards with deterministic
  longest-first allocation and measured hints for slow files. Unknown/new files
  always join the partition. Preserve every specification exactly once; keep
  maxWorkers=1, child bridge coverage checks, deadlines and inherited sorting.
- Cache Rust build intermediates by OS, architecture and crate/build inputs.
  Always run the locked Cargo build and regenerate the helper digest.
- Give Archify the same Electron ABI cache preparation as other packaged jobs.
  Forge still rebuilds Computer Use provenance and Managed Local resources.
- Keep every existing test, OS, required check, permission and release policy.
  No production behavior, dependency update, merge or release is in scope.

Validation: partition coverage/determinism/unknown-file/load tests, existing
workflow boundary tests, desktop typecheck, changed-file lint/format, actionlint,
then the actual PR's full three-OS CI and ReviewBOT. Compare Windows test step
times and total elapsed/job time at the same GitHub observation points.

## Local verification

- Partition and existing workflow/Forge boundary tests: 47 PASS, 2 existing
  Windows-only SKIP on macOS.
- Actual Vitest API collected 389 specifications; the configured sequencer
  selected 127 / 130 / 132 files, with the exact union and no duplicate object,
  missing file, or extra file. `vitest list --filesOnly` itself reports the
  pre-shard collection, so the sequencer was verified through its real API.
- Desktop typecheck, changed-file ESLint/Prettier, full lint/format and
  actionlint 1.7.12: PASS. Full lint has two unchanged source warnings.
- Same-baseline timing simulation (371 files with timing lines) predicts
  test-only load of 372 / 356 / 373 seconds instead of the former uneven
  allocation. This is an estimate; actual PR CI measures the result.

## Direct Electron config import

The first PR CI caught a real configuration regression: the Coordinator bridge
imports vitest.config.ts directly from a temporary .mjs, so native ESM cannot
resolve an extensionless relative sequencer import. Reproduced with the bundled
Electron before repair (ERR_MODULE_NOT_FOUND). Keep the partition/sequencer in
vitest.config.ts so its runtime imports remain Node-resolvable, and exercise the
raw import with real Electron in a focused regression test. No bridge assertion
or timeout is changed.
