# Coordinator Electron bridge bounded shards (#689)

## Problem and scope

The previous Windows Electron/SQLite bridge runs all Coordinator cases in one child
with a 420-second process deadline. On yuseipc, 133 cases passed with a cumulative
413.059 seconds of test time before the deadline killed the process; the remaining
27 cases passed separately (38.33 seconds of test time). That original aggregate
run remains FAIL. The cumulative budget, rather than an individual assertion
failure, prevents completing the growing serial Git/worktree suite.

This change only alters the test bridge and adds tests for its coverage checks.
Production code and existing integration expectations are unchanged.

## Design and review

Collect the real Electron suite using `vitest list --json`, validate the source file,
reject empty/duplicate/ambiguous names, and partition all names into four nonempty
round-robin groups. Each bridge case runs one child with the existing 420-second
process and 430-second test deadlines. The collection has its own 60-second deadline.
Keep the workspace test/hook timeouts and worker configuration by importing its
existing config. Store the escaped, anchored selection pattern in a temporary config
file to avoid growing Windows command-line arguments. Temporary files are removed
after the bridge finishes or fails.

Require successful child exit and a successful JSON report. The report's passing
assertion-name set must exactly equal that group's planned names: missing, extra,
duplicate, failed, or unexpectedly skipped planned cases cannot pass. The four
groups form the complete collected set exactly once.

Independent runtime_fixes design/current-code review: PASS, no blocker. Review
explicitly checked collection/report schemas, recursive-bridge avoidance, config
preservation, deadlines, argv length, and fail-closed coverage. Implementation began
while the requested review was pending; it is not claimed that the response arrived
before implementation. Root second-seat current-code review also PASS; no blocker.

## Verification

Environment: yuseipc Windows, Node 22.23.2, Electron 43.5.0, real SQLite with the
matching Electron native dependency. No paid APIs or collaborator files used.

- Original single-child aggregate: FAIL at 420 seconds (kept as the RCA evidence).
- Pure regression checks: partition union/exactly once, regex escaping and anchoring,
  empty/foreign/duplicate/ambiguous collection, missing/duplicate/skipped/failed/extra
  report assertions, and nested suite names.
- Full corrected bridge PASS: 156 collected real Electron/SQLite cases, four groups of 39. Each successful bridge case checked its JSON passing-name set against exactly its planned group. No missing, extra, duplicate, failed, or skipped planned assertions. Group durations: 140.369 / 74.124 / 93.580 / 115.476 seconds, all below the unchanged 420-second bound. Total final command: 2 files / 38 outer tests PASS, 440.13 seconds; child durations total 423.549 seconds. The whole serial suite exceeds one original child budget while each shard completes. Final verbose log saved outside the checkout as issue-689-full-final.log. The original 160-case diagnostic was on PR #677; this independent main-based branch contains 156 baseline cases and discovers future added cases dynamically.
- Desktop typecheck and changed-file ESLint: PASS.
- Windows/macOS/Linux CI remains the final aggregate gate; no Issue close, merge,
  release, or deployment is authorized by this verification.
