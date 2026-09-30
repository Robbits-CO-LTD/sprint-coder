# #333 Controller / planner / capture checkpoint

Source baseline: `28a3b7291f7bc7ec5a482a3952f449ecf3f10261`.
Current #333/#500 bodies and comments were retrieved again before this work. This checkpoint
does not close either parent issue or replace the protected final acceptance gate.

## Existing implementation and missing boundary

The planner test previously fed one real parser/preflight round into the capture aggregator.
The Controller's three-round test used a handwritten planner, while the collector's three-round
fixtures supplied synthetic events directly. Those tests did not exercise the actual emitter
sequence from the real planner through the Controller's run loop and final Stop.

This test-only slice connects the real `preflightComputerUseProvider`,
`ProviderComputerUsePlanner`, `ComputerUseController`, `ComputerUseRuntimeCapture`, and
`summarizeComputerUseCaptureRounds`. Provider responses and native receipts are explicitly
offline fixtures; no API, credentials, actual OS input, signing identity, or protected-runner
authenticity is claimed. It leaves production behavior, feature gates and the generator's
Core/Safety PASS refusal unchanged.

## Verification

Windows yuseipc, Node 22.23.2, Vitest 3.2.7:

- One fixed-marker preflight followed by exactly three type/scroll/click planner rounds, four
  observations, and confirmed Stop produces a three-round metadata binding.
- Two rounds, a response-side model fallback, or Stop during an in-flight second response leaves
  `roundsComplete` false and `binding` null; fallback/Stop sends no second native action.
- Raw fixture task text does not enter capture metadata. Every scenario retains
  `snapshot.finalGateEligible === false`; disposal and late response do not append capture events.
- Controller, planner, and runtime-capture suites: **131 PASS**. Desktop TypeScript,
  changed-file ESLint (zero warnings), and Prettier passed.

The initial failures were incomplete new fixtures (missing current window executable digest,
Provider verification/task title, receipt session IDs, and scroll coordinates), corrected in
test data; they were not product defects. The known coverage gap is recorded in the existing
#333 final-gate plan, so no duplicate bug issue was created.

Design review: root accepted this test-only scope, requiring an explicit false final-gate
assertion. Independent code review is recorded in the draft PR.

## Remaining parent scope

| Issue | Existing scope                                                                                                      | Remaining dependency / acceptance                                                                                                                                                                                                                                                                                              |
| ----- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #333  | V1 native/Main/Controller/Broker/IPC and schema-v4 evidence gates; this PR tests their metadata join                | Protected runner must independently verify owned-run facts and closure digest; signer/process/privacy digest producers and 27 coverage producers must connect to sealing. Current generator refuses Core/Safety PASS. #387 signed Windows/notarized macOS and #388 real non-OpenRouter Provider acceptance are still required. |
| #500  | S1 permissions (#501), S2 target tools/ADR (#503), S3a grants/settings (#504), S3b chat/start (#505) already merged | S4 macOS deny/surface/execution interlock is an inseparable reviewed checkpoint before S5 Windows, then UWP/browser and S8 V1 retirement. Windows-only execution cannot establish macOS real-app/process-signature acceptance; do not enable the feature or remove V1 prematurely.                                             |

Current user authorization is implementation, overriding older planning-only task scope, but
Windows-only work cannot supply macOS acceptance or credential-bearing Provider acceptance.
Those require a separate concrete execution environment / paid Provider authorization. This
checkpoint requests neither setting changes nor those external actions.
