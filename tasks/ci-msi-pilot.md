# MSI runner pilot

## Scope

Use the existing non-administrator Organization runner `MSI-ci` (ID3741) for the
three quality jobs (typecheck, lint, format), contracts/domain tests, and the existing
Windows Rust `windows_command` integration suite. Extract that suite from native Gate 0
without changing its command or dropping it from the required full CI gate.

Keep macOS/Linux platform coverage, Windows desktop shards/bridges, packaging,
release/signing/attestation and Computer Use acceptance on GitHub-hosted runners.
The CI contract tests retain their Linux runner, including their POSIX-only cases.

The pilot targets runner availability and reusable local tool/dependency caches;
it does not promise lower wall time before measurement. Reference run41548546148
finished in about11 minutes with18 parallel Windows jobs totaling about70 job-minutes.
MSI has one execution slot; moving every shard to it would serialize that work.

## Routing and access

`SPRINT_CODER_MSI_CI_ENABLED=true` opts in. With the variable absent/false, existing
GitHub-hosted runners remain the default. Fork PRs and Dependabot always retain
GitHub-hosted runners in this workflow; internal PRs, main pushes and manual runs
can use the pilot. No `pull_request_target` execution is introduced.

Runner group `windows-ci-msi` must allow the current private repository IDs plus
only `Robbits-CO-LTD/sprint-coder` as a public repository. Use selected repository
access, not all-public access. New private repositories then need explicit addition.
Require workflow approval for all external fork contributors in this public repo;
workflow conditions alone do not prevent a fork from changing workflow YAML.

## Acceptance and rollout

1. Check routing contracts for disabled, internal PR, fork PR, bot, push and dispatch.
2. Run affected typecheck/lint/format and workflow/scope contracts.
3. Verify actual pilot jobs on runner ID3741, Session0/non-administrator environment,
   exact workflow/head/attempt, results and durations. Record queue time separately.
4. Compare complete CI wall time to the reference and retained hosted jobs before
   expanding. One cold run does not establish a speedup; inspect a warm run too.

Disable the repository variable to route future jobs back to GitHub-hosted runners.
Do not stop busy jobs or alter another PC's labels/services. An offline MSI with
the variable enabled queues its jobs; fallback requires disabling the variable
and starting a new run. Merge/release and policy changes must be reported separately
from a successful PR check.
