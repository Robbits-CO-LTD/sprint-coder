# Issue 652: bounded CLI discovery

Base: main `28a3b7291f7bc7ec5a482a3952f449ecf3f10261`.

User-visible result: valid slow version/help/auth probes remain available on initial detection and refresh. An arbitrarily long Desktop candidate list cannot extend detection indefinitely.

The selection budget allows two complete version/help candidate probes (20 seconds), followed by the existing authentication budget (3 seconds), with Main allowing 2 seconds for IPC/scheduling. Each version/help subprocess keeps its existing 5-second maximum and is additionally capped by the remaining shared selection deadline. Candidate enumeration/ranking and fallback policy remain unchanged; candidates beyond the deadline do not spawn. Authentication timeout retains the existing unknown-to-ready behavior. Runtime Host generations prevent an older concurrent probe from replacing the selected CLI or publishing stale hello.

Non-goals: Grok probe/stop budgets, CLI authentication changes, installed-provider or paid API acceptance. Filesystem discovery remains synchronous; blocked filesystem calls are covered by Main's bounded hello timeout rather than claimed interruptible.

RCA confirmed: Main's former 10-second wait covered one version probe and auth, while actual CLI discovery executes both version and help. Regression with a 10.7-second hello failed for both Codex and Claude under the old budget; restoring the new budget passes initial and refresh cases. Real probe functions are exercised with slow synthetic subprocess events, and a 20-entry Desktop list plus fallback is bounded with only three children started for a 12-second test deadline. Expired Main hello remains rejected. Overlapping Host probes publish only the newer generation.

Validation on yuseipc Windows / Node 24: seven focused suites, 63 tests pass; desktop typecheck and changed-file lint/format pass. Elevated Codex adapter suite: 52 pass, 4 platform skips. Restricted child-tree tests fail because taskkill cannot stop the synthetic children; elevated execution passes. Elevated Claude adapter suite has 30 pass, 2 platform skips and one ambient-skill fixture failure caused by real user-home skills, unrelated to changed probe paths. Node 22 cross-platform CI and installed packaged CLI startup remain separate evidence gates.
