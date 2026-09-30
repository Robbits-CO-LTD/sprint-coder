# Issue653 POSIX stop receipt budget

Issue649 concerns waiter settlement after forced stop; Issue678 is specifically Windows Grok's stop/receipt budget mismatch. Issue653 already tracks the POSIX helper's possible eight-second bounded path. This is a separate limited slice within Issue653, not a new or reopened Issue and not a full descendant ownership guarantee.

The existing helper can spend two seconds in each of two ps snapshots and two seconds in each of two grace windows. Main previously allowed five seconds for these CLI receipts. A controlled actual Main → transport fixture → actual Codex/Claude adapter.cancel route reproduced premature waiter rejection and host kill in all four six/eight-second stop-confirmation cases. The fixture ran on Windows Node22.23.2 and only injected Linux/macOS budget policy and a deferred OS-stop boundary; process.platform and real OS signals were never changed. This is product cancellation flow evidence, not real POSIX stop timing acceptance.

The ps snapshot timeout is now a shared constant consumed by the helper. Main derives eight seconds plus a one-second receipt delivery margin from those same two snapshot/two grace constants only for Codex/Claude/Grok on Linux/macOS. Windows Codex/Claude remains five seconds and Windows Grok remains fifteen seconds. RuntimeHost supports only those three CLI kinds; Gemini/local execution uses other paths. Other platforms remain at the existing five seconds. Stop targets, actual grace periods, quarantine and forced-uncertainty semantics are unchanged.

Windows Node22 controlled product regression: four failures before, four successes after. Focused budget/stop regressions total41 PASS, including nine-second nonresponse expiry, joined cancels, old-host receipts and existing Windows budgets. Two independent review seats distinguish readonly review from execution. Exact remote SHA/draft CI remain required validation evidence.

Synthetic review base413f7743 consists exclusively of already-reviewed Issue653 PR697 and Issue678 PR683 changes so this PR presents only the new budget delta. Native build/download and paid API holds remain respected.

Full POSIX ownership, PID reuse, reparented new-group capture and malformed/cyclic ps output remain outside this slice. The nominal derived bound is not a hard scheduler or OS execution deadline; delayed receipt beyond the bounded margin remains unconfirmed. Issue653 must stay open until remaining acceptance is independently met.

## Existing start-ack regression follow-up

Initial CI1fa33874 failed the existing Main start acknowledgement test on Linux/macOS because its post-start-timeout cancellation assertion still required host kill at five seconds. The product correctly waited the new nine-second budget. This test now checks supported POSIX9s/other5s literal expectations at deadline-1 (no kill) and deadline (one kill, no duplicate failure). Main/budget35 PASS on Windows Node22;26 Main tests add to41 budget/stop tests for67 distinct PASS. Two independent readonly reviews passed, separately from execution. Production/native source is unchanged in this follow-up; initial failure logs are retained under task/ci700-linux-shard1.log and ci700-macos-shard1.log.
