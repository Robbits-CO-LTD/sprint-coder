# Windows Grok stop receipt budget (#678)

Base main: 28a3b729 (PR #666 merged). Dedicated branch: codex/grok-stop-budget.

Root Cause Confirmed: Main's cancellation watchdog was fixed at 5 seconds, while the Grok Windows Turn helper can spend 2 seconds in soft grace, 10 seconds awaiting forced taskkill and 2 seconds in final grace. A real RuntimeHostClient→fixture transport→real GrokRuntimeAdapter.cancel→stopped receipt fixture confirmed Main rejects/restarts at 5 seconds even when the adapter confirms at 6 seconds. The same expected-success regressions at 6 and 14 seconds both failed before production changes.

Change: stop-budget.ts owns the helper's grace/taskkill constants and derives the Windows Grok maximum. Main waits for that 14-second finite budget plus 1-second receipt delivery margin. Other runtime kinds and Grok on other platforms retain the existing 5-second watchdog. The adapter's stop confirmation policy and process ownership strategy do not change.

Validation: new integration tests cover 6/14-second real-adapter receipts, 15-second absent receipts, ordinary Windows Codex and POSIX Grok 5-second controls, joined cancels, mismatched operation IDs, old host receipts, parallel cancellations, disposal timer cleanup and immediate unconfirmed-stop quarantine. The host transport fixture follows runtime-host/index.ts's cancel→adapter.cancel→stopped mapping; Electron child processes and OS stopping are substituted in that fixture.

Windows Node22.23.2: first six integration cases + existing Main/Grok stop suites + process-tree suite 37 PASS. The process-tree suite includes actual self-created Windows root/descendant termination with delayed taskkill. Extended eight integration cases PASS. Node24.13.0 focused suites also PASS. Node22.23.3 aggregate CI remains distinct. No real Grok binary, paid/authenticated API, TeamMCP external tool, installed package, or release was used.

Independent design review: runtime_fixes found no blocker for the bounded budget derivation and requested 14-second boundary, 15-second timeout, platform controls, old-instance and joined-call checks, now included. Independent code review also found no new blocker. Exact-head CI remains pending until the dedicated draft PR is created.

Known independent work: #649 forced/disposal waiter behavior is handled by draft #671; its rejection semantics are not duplicated here. The disposal test checks watchdog cleanup and finite settlement, not an unconfirmed success receipt. #653 natural-close owned-descendant confirmation remains incomplete in #671. #665/#506 still require same-artifact Windows real Grok/TeamMCP acceptance; this fixture is not that acceptance.
