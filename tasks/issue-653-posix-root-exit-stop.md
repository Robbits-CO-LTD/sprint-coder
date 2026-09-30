# Issue 653: start owned POSIX cleanup on root exit

Stacked on PR700 (50f95d8b); this slice changes only Codex/Claude root-exit cleanup policy and regressions.

Root cause: Linux/Darwin CLI roots are detached owners of their original process group, but cleanup previously began only on child `close`. A same-group descendant inheriting stdout/stderr can keep that event pending after root `exit`. The existing singleflight stop path now starts on `exit` on Windows/Linux/Darwin; `close` and confirmed stop remain required for cleanup/exited notification. Unknown/permission/visible-zombie groups remain unconfirmed and quarantined.

Evidence: four modeled Linux/Darwin actual-adapter tests failed before the policy change (stop never called), then passed. Eight modeled cases cover true/false and close before/after stop settlement without process.platform mutation or real POSIX signals on Windows. Pure policy coverage retains FreeBSD exclusion. Windows Node22.23.2 focused six suites: 37 PASS, one actual POSIX-only SKIP. Existing Windows actual owned Job ignore/inherit stdio tests passed. Desktop TypeScript, scoped ESLint, formatting and diff checks passed.

An actual Linux/macOS Codex synthetic CLI fixture forks a same-original-group child inheriting output pipes, completes a turn and naturally exits. It requires child disappearance or zombie state within 10 seconds, before the 30-second idle deadline; clean exit is allowed only after confirmation, otherwise RUNTIME_STOP_UNCONFIRMED. Owned marker group/PID cleanup uses only this fixture's positive validated group/PID. Actual POSIX result remains CI pending.

Native source/build untouched. Existing pre-hold artifact reused: SHA256 C6F97BC42539E334D0CDD9CC3B2904F082C76BD04E3CE69C38400D14F1F34040. Initial unprivileged broad run had three environment/resource failures; existing artifact plus authorized ordinary process test run gave the 37 PASS result.

Limits: this does not detect reparented/new-group escaped descendants, solve PID reuse/malformed process snapshots, prove every POSIX CLI descendant, or provide same-package authenticated TeamMCP/real paid CLI acceptance. Those outstanding conditions remain tracked under issue653/506. No native build/download, paid APIs, settings/probe changes, merge, or issue closure.
Root independent final read-only review PASS. Test-only fixed status prints confirmation and zombie/absent class without PID/path. A zombie/unconfirmed PASS proves timely stop attempt and fail-closed notification, not successful termination confirmation. Runtime second-seat review tracked separately.
