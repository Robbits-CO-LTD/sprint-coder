# Issue500 native classifier core C0

Stacked on draft704 d11e785ff325d8bbff26df0efdde765ff8ec9bac. This native-only core is connected to real Mac RiskOutcome and Windows RejectWindowsRisk immediately before existing input paths. Fresh measured AX/UIA facts are translated to versioned fixed ordinary/single_use_approval/blocked/takeover decisions. It does not widen eligibility or change existing V1 result/reason precedence.

Unknown/incomplete facts remain denied. Secure fields remain blocked. Coarse highimpact remains takeover (Mac paused / Windows high_impact_blocked), because existing facts cannot safely distinguish E1/E4/E5 hard blocks from E2/E3 approval-eligible effects. Only complete classified nonsecure nonhighimpact facts yield ordinary. Dispatch requires the exact supported version1+ordinary+none tuple; reserved single_use_approval, unknown versions/enums/reasons and inconsistent tuples never authorize input.

The existing C++ sanitizer harness now checks all16 native fact combinations against a fixed independent truth table and100 version/kind/reason tuples. Both native hosts include and call this core. Local native compile/build/download/dispatch remained held; native compilation and harness execution must be supplied by ordinary same-head CI. Locally Windows Node22.23.2 existing Main/native/transport/controller four suites206PASS; desktop typecheck and diff checks verified separately.

Root/runtime design reviews PASS; final code reviews tracked separately from test execution. V1 default and V2 OFF/unsupported future-authority handshake remain unchanged. No JS-owned ticket store, security-setting change, signing, paid API, credentials, OS input execution or dependency acquisition.

Next required native slice: separate read-only preflight validation from Mac ParseNativeDispatchRequest's inflight reservation, then implement native-owned bounded one-shot tickets and fresh effect classification with session/action/target/observation/cancel/process/window/ruleset bindings. Cancel/close/changed state invalidates tickets; serial dispatch consumes exactly once after fresh reclassification. UI trusted activation, manifest/ruleset/mode interlocks, precise E1-E5 classification and actual signed same-artifact acceptance remain incomplete. This core does not claim S4 or issue500 complete; input to new V2 candidates stays unpublished.
Final root/runtime independent read-only code reviews PASS, no blocker. Native execution is CI-pending; local206PASS refers solely to existing TypeScript suites.

Full existing workspace lint completed with zero errors and two existing warnings in untouched prepared-execution-image.ts/team-coordinator.ts. Existing workspace Prettier and desktop typecheck PASS. C++ actual execution remains CI-pending.
