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

- Full matrix is unconditional. Keep macOS3 and Linux3 ordinary shards and
  Windows4 one-worker ordinary shards. Move Coordinator/Graph to a required
  Mac/Windows × suite ×4-group matrix (16 jobs); only those two files are excluded
  from ordinary Mac/Windows CLI invocations. Linux retains all default groups.
  The existing Windows Cargo boundary test runs in ordinary4/4.
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

## Bounded bridge follow-up

Full run37454909571 exposed the existing Mac Graph aggregate180-second ceiling:
103 cases passed, the next case remained active, maxCase14.3 seconds and
rpcTimeout=false. Windows Coordinator took322 seconds across four serial groups
(85/83/67/80 seconds). This makes single-file partitioning insufficient for5min.
Move both harnesses into required case-group jobs. Graph dynamically collects
127 active Mac cases, partitions them32/32/32/31, checks each exact JSON result
and retains180s Mac/300s Windows child budgets. Coordinator retains420s.

CI-only group selection is strict0..3; local unconfigured execution runs all4.
Each child has isolated report/marker/progress paths. Fixed marker summaries
now use the validated active-case digest rather than source adjacency, which
round-robin partitioning invalidates. Collection failures also retain redaction.
Three focused independent reviews checked this additional boundary. The matrix
contract checks all16 unique tuples; both OS aggregates reject failed, cancelled,
skipped or missing bridge results. No assertions or deadlines are weakened.

Local real-Electron acceptance: Graph all4 groups PASS (127 planned child cases,
outer12 tests, ~59 seconds; each child11–16 seconds). Explicit CI group2 PASS
(outer9 tests, one selected group). Coordinator explicit CI group0 PASS (outer32
tests, one selected group, ~27 seconds). Selector/coverage/workflow regression
suite53 PASS /2 existing Mac-host Windows-only SKIP. Typecheck/lint/format and
actionlint PASS. Graph collection/report errors and active-case markers retain
the bounded diagnostic redaction contract. Actions remains the timing gate.
