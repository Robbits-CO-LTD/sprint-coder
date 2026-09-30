# Issue #653: Windows CLI descendant ownership

Root Cause Confirmed: when the CLI root closed before the first tree stop, the old Windows helper returned success from root exit facts alone. A real synthetic Codex app-server spawned a detached child, completed, then exited normally; the adapter emitted exited(0,false) while that owned child survived. This was reproduced twice on main plus PR671.

## Scope and design

Windows Codex/Claude turns now spawn the existing Node Job wrapper with an unopened fd3 gate. Job assignment and the additive membership-query API must succeed before runtime process identity is published and the CLI executable/argv is released. The wrapper PID remains live for the CLI lifetime, so the existing native descendant identity predicate recognizes the CLI beneath it. Windows npm shims continue to resolve to their native executable through the existing resolution code; argv prefixes and the immutable CLI environment are preserved.

The new retained-Job termination API leaves the handle owned. JavaScript polls ActiveProcesses asynchronously for at most 2000ms, then closes only after zero members. This is within Main's existing 5000ms cancellation watchdog and leaves 3000ms for scheduling and receipt delivery. Missing Job, query error, timeout, failed termination/close all stay unconfirmed and use PR671's quarantine behavior. Concurrent turns use unique Job IDs; repeated cancel/dispose/close join the same stop promise.

The existing CommandRunner terminateOwnedJob/closeOwnedJob APIs retain their behavior. Startup failures never open the gate; the blocked wrapper is killed and its owned handle closed when possible. Reentrant cancellation during identity binding also keeps the gate closed.

## Evidence

- Windows yuseipc, existing Node22.23.2 and Electron43.5.0, existing VS Build Tools and cached headers only. No paid APIs, downloads, CLI credentials or external application messages.
- Standard `node build-native-safe-fs.mjs --test`: 0 compiler warnings/errors. Initial direct Node-header build linked against an absent Release/node.lib path; standard Electron-header build succeeded, and its N-API artifact loaded in Node22 and Electron UtilityProcess.
- Actual Codex adapter + synthetic app-server + actual Job API: natural root close with a detached child now notifies exited(0,false) only after the child PID is gone (RED before / GREEN after).
- Actual gated wrapper/native boundary: Unicode and space-containing script paths/argv, HOME/CODEX_HOME/cwd preserved; native identity/ancestry predicate accepts CLI under live wrapper; the detached child survives root close before stop and disappears after confirmed Job stop.
- Actual Electron43.5.0 UtilityProcess, CJS bundle made with the repository Forge Vite config generator: native addon resolution and new helper Job termination returned `{utilityJobConfirmed:true,exitCode:0}`. This is a development UtilityProcess boundary check, not packaged-app acceptance.
- Windows Node22 subsystem checkpoint: 142 PASS / 31 intentional SKIP; one additional FAIL is the already reproduced ambient Claude fixture issue #673, independently corrected by PR675. Existing CommandRunner tests: 44 PASS / 25 intentional SKIP. Legacy fake-child cleanup tests were explicitly isolated from the real Windows Job boundary; new real/native tests cover ownership instead.
- Full workspace typecheck PASS. Changed-file ESLint 0 errors/0 warnings, Prettier and diff checks PASS before final review.

## Limits and remaining gates

POSIX natural-root-exit descendant ownership remains unproven and is not fixed by this Windows slice; issue #653 must remain open. A development UtilityProcess check is not a same-artifact packaged Windows acceptance. Real authenticated Claude/Codex/TeamMCP acceptance was not performed. The ordinary owned descendants guarantee does not encompass processes created by external services outside the CLI Job. Existing nodeJob support remains required; missing native exports fail closed before the CLI starts.

Implementation review, integration with PR686's shared wrapper environment change and PR675's fixture isolation, exact remote head CI, and packaged acceptance are tracked separately.

## Follow-up: inherited output pipes and CI console policy

The first implementation review passed but identified an additional liveness case: a detached child inheriting stdout/stderr prevents Node ChildProcess close after root exit. The same actual Codex fixture, changed only from ignored to inherited stdout/stderr, failed on 4dee0fae after a 10-second wait with no exited callback. Windows adapters now start the same single-flight owned stop at exit. Cleanup and exited still require close and confirmed zero membership. Stop failure is reported even when close is delayed, and exit/close failures produce one unconfirmed notification. POSIX behavior remains unchanged.

The exact 4dee0fae CI failed on Linux/macOS windows-hide.test.ts because its static policy scanner counted only spawn() and did not recognize the extracted owned CLI factory (2727 tests passed / 42 skipped / 2 policy assertions failed on each shard). The scanner now covers owned factory calls and the helper itself, which explicitly forces windowsHide on its real spawn boundaries.

Post-review native hold is respected: these follow-up edits are TypeScript/tests only; native C++ equals 4dee0fae. Reused native artifact SHA256: C6F97BC42539E334D0CDD9CC3B2904F082C76BD04E3CE69C38400D14F1F34040. No additional build/download was performed. The existing standard-build log confirms cached Electron43.5.0 headers were already installed and installVersion was valid.

The previous full integration checkpoint is specifically head35e68b77 (4dee0fae + PR6759a7663fa + PR6867bc41f0f): 10 suites171 PASS /31 intentional SKIP, desktop typecheck PASS, matching PR686 runner plus preload required. It is evidence for that exact combined source, not automatically evidence for later heads.

Independent implementation review and the Windows exit follow-up review both passed with no blocker/P1. Real packaged authenticated CLI/TeamMCP and POSIX ownership guarantees remain pending.

Final TS-only focused checkpoint on Windows Node22.23.2: 5 suites26 PASS, including both inherited/ignored stdio natural-close cases, both adapters' exit-before-close unconfirmed dedup, and console policy. Full workspace typecheck PASS; changed ESLint has zero errors/warnings, Prettier/diff PASS. Native artifact above reused without rebuild.
