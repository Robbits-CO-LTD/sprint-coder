# CI runtime reduction

## Goal and confirmed cause

Keep all existing CI coverage on every PR, aiming for approximately five minutes.
The user explicitly selected full coverage rather than moving validation to main.
Baseline [37307810511](https://github.com/Robbits-CO-LTD/sprint-coder/actions/runs/37307810511)
(main94663c6b) took12m53s /87.4 summed job minutes. The first weighted3-shard
change passed all gates in10m28s /84.1 minutes ([37449015881](https://github.com/Robbits-CO-LTD/sprint-coder/actions/runs/37449015881)).
Windows test steps were409 /440 /395 seconds; Coordinator alone270 seconds,
Graph207 seconds. npm ci adds70–90 seconds; restoring Rust intermediates still
recompiles the crate for about30 seconds because checkout timestamps changed.
The Windows major E2E step alone took320 seconds (Archify136s, other specs140s,
plus startup/teardown). Test and setup timing lines establish these paths; runner
queue time alone does not explain the duration. RCA A/B/C/D: YES.

## Final design

- Full matrix is unconditional. Keep macOS3 and Linux3 shards; use Windows8
  one-worker shards, leaving Coordinator and Graph alone. Move the existing
  Windows Cargo boundary test to8/8, away from the longest file.
- Split Windows major E2E into core and Archify with one worker in each. The
  exact union of all9 existing specs is required; artifacts include group names.
  Local ungrouped execution still selects all9. Invalid groups fail closed.
- Cache installed dependencies by OS, architecture, exact Node, lock, every
  workspace manifest and action/validator source. Only exact hits with current
  workspace links skip npm ci. Discard source-transform caches. SQLite and
  NativeSafeFs restoration still happens afterward; restoration alone is not
  ABI proof. Required native/runtime tests exercise the actual dependencies.
- Cache completed sandbox helpers by OS/architecture, rustc-vV identity and
  all build inputs (including root package script, Cargo/config/toolchain,
  workflow/action/validator and Windows guard source). Compiler/target/profile
  overrides disable reuse. Validate digest, permission, Windows guard and real
  executable protocol before reuse. Missing/invalid output falls back to the
  original locked build; final validation/probe is mandatory on both paths.
- Keep all assertions/deadlines, required aggregate gates, package verification,
  Forge Computer Use provenance, and fresh release builds. No release or merge.

## Reviews and verification

Six independent design reviews checked dependencies, sharding, artifact inputs,
ABI, timing and cache contracts. They required E2E splitting, exact-hit checks,
workspace fallback, compiler/root-script identity, helper recovery and immutable
pins inside the composite actions. Stage2 review found a probe-before-reuse gap;
that was repaired and independently rechecked.

Local focused tests55 PASS /2 existing Windows-only SKIP on macOS. All workspace
typechecks, JS checkJs, lint, format and actionlint passed; full lint retains two
unchanged warnings. The actual Vitest sequencer selected390 files in8 groups
[1,1,58,64,66,67,66,67], with no omission/duplication. The bundled native helper
passed digest and executable protocol checks. Raw Electron config import remains
covered so the Coordinator bridge can import it without Vite bundling.

Cold and warm full-OS Actions are the final measurement gate. Cold compilation,
new lockfiles and hosted-runner queues can take longer than five minutes; no
unverified performance guarantee is made. Runtime/packaging/E2E successes are
required before reporting completion. Source/dependency/native inputs changing
must rebuild rather than reuse a previous binary.
