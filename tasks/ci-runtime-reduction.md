# CI runtime reduction

## Goal and confirmed cause

Keep all existing validation on every PR, aiming for approximately five minutes.
The user explicitly selected full coverage with sharding and caches.
Baseline [37307810511](https://github.com/Robbits-CO-LTD/sprint-coder/actions/runs/37307810511)
(main94663c6b) took12m53s. Windows test steps, serial Electron integration groups,
70–90-second npm installation, repeated Rust compilation and packaged E2E are
confirmed bottlenecks in the Actions step/test timing logs; queue time alone
does not explain the duration. RCA A/B/C/D: YES.

Head79761a8 passed all required gates in6m42 (cold) and6m40 (warm) in
[37470380316](https://github.com/Robbits-CO-LTD/sprint-coder/actions/runs/37470380316).
Its Mac package job had104s packaging,182s Archify and44s Managed Local smoke.
Moving smoke plus a second bundle build to the native gate still took6m44: the
last Mac Coordinator group waited263s for a runner. Avoid that extra slot/bundle
work by running the headless smoke alongside Archify after fresh packaging.
Two simultaneous GUI workers would compete for native foreground focus, so
packaged Mac Archify retains one worker and all8 cases.

## Final design

- Full matrix is unconditional. Mac/Linux ordinary tests use3 shards; Windows
  uses4 one-worker weighted shards. Only Coordinator/Graph move from ordinary
  Mac/Windows CLI invocations to required Electron case groups. Linux and local
  unconfigured execution retain all groups. Mac ordinary shards also run the
  eight Electron groups (3/3/2 groups across3 jobs), reusing their existing
  setup; Windows retains8 separate one-worker group jobs. All16 logical
  tuples run exactly once. Mac uses5 physical jobs to reduce runner queueing.
- Each integration group uses the actual collected case list, isolated
  report/marker/progress paths and anchored selection. Exact JSON PASS-set
  verification rejects missing, extra, duplicate or skipped planned cases.
  Existing child deadlines and diagnostic redaction remain intact.
- Windows major E2E splits the existing9 specs into core/Archify groups.
  Packaged Windows Archify has2 one-worker case shards; Mac uses the fresh
  production package from its own job for all8 cases. Existing prebuilt-package
  handling copies it, changes the inspector fuse only in that test copy and
  verifies the production source fuse remains intact.
- Windows Cargo boundary tests run once in the required Windows native gate.
  Mac Managed Local LIVE smoke reads the same freshly pinned bundle alongside
  Archify in the required package job. It has no GUI or loaded model; scratch
  roots and OS-assigned ports are isolated. Both exit codes are required, logs
  are retained, and cancellation kills the smoke process group including its
  restricted-environment sidecar. Existing signatures/digests/probes/deadlines
  remain required. Mac/final aggregates also require native gate success.
- Installed dependency cache requires exact OS/architecture/Node/lock/all
  workspace manifests/action/validator inputs and current workspace links.
  Missing/invalid hits fall back to npm ci; source-transform caches are cleared.
  SQLite/NativeSafeFs ABI restoration follows, with actual runtime tests required.
- Completed Rust helper cache includes compiler identity and all build inputs.
  Compiler/target/profile overrides disable reuse. Digest, permissions, Windows
  guard and bounded executable protocol checks precede reuse; invalid output
  falls back to the original locked build, then mandatory final validation.
  Optional compiler identity probe failure only disables reuse. Rust config
  input globs are limited to repository/crate paths, avoiding node_modules walks.
- Release builds remain fresh. No merge, release, assertions or timeouts changed.

## Compatibility and verification

Windows Git2.56 rejected NUL as the system/global configuration replacement;
failed2.56 logs and isolated same-head passing2.55 retries confirm this boundary.
Use Git's documented /dev/null path on both OSes, preserving hook/filter/include
and environment isolation. Existing real-Git execution canaries remain required.
Source: https://git-scm.com/docs/git#Documentation/git.txt-GIT_CONFIG_GLOBAL

Independent design and focused implementation reviews checked cache boundaries,
ABI, complete partitions, aggregate failure handling and GUI isolation. Actual
local Electron Graph acceptance passed all127 planned cases in4 groups, plus
explicit CI-selected Graph/Coordinator groups. Workspace typechecks, JS checkJs,
lint, format, actionlint and related contract tests passed; two existing lint
warnings and Windows-only local skips remain. Latest full-OS Actions and latest
head ReviewBOT are required before completion. Cache misses and runner queues
can exceed the target; measured run timings belong in PR743's final validation.
