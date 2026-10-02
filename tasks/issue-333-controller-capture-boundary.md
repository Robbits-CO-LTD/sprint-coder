# #333 Controller / planner / capture checkpoint

Original source baseline: `28a3b7291f7bc7ec5a482a3952f449ecf3f10261`.
The #333/#500 bodies and comments were retrieved before the original Windows work. This checkpoint
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

### Original Windows verification

Windows yuseipc, Node 22.23.2, Vitest 3.2.7 (historical evidence):

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
assertion. The draft PR body describes independent review of original commit
`93a5cc94dd3ed5466aef1bb759408d1315cf50dd`; that review is historical and does not establish fresh
independent review of a later head.

### macOS revalidation on 2026-10-02

Current #333 acceptance and latest CLOSE_HOLD comments, the PR diff, Controller/planner emitters,
runtime capture, and the collector's round aggregator were read again. The isolated worktree
contains current `origin/main` `501810587105f820e554277e2f0de12d876bee02`, merged into PR preparation
head `3026d4f26fa59fc20941afbfc8b178333f07689e` before this documentation update.

macOS, Node 22.23.1, Vitest 3.2.7:

- `npm ci --ignore-scripts --offline --no-audit --no-fund`: exit 0. No native artifact was built,
  downloaded, or copied.
- Controller (82), planner (22), and runtime capture (27): **131 PASS**, exit 0.
- Existing capture transport suite, including synthetic owned Node-child pipes: **39 PASS**, exit 0.
- Desktop TypeScript, changed-test ESLint (zero warnings), Prettier, and diff checks: exit 0.

No defect was reproduced and the test implementation required no changes. This is local execution
evidence and self-review. The new tests still use a Windows identity fixture on the Mac; they
prove the offline metadata join, not Windows execution or macOS native acceptance. They call the
collector's round aggregator directly and do not exercise a packaged Main process or authenticate
the capture stream. Every scenario asserts `finalGateEligible === false`. They provide no real
producer, canonical 27 parent assertions, real journey, runtime attestation, signer, or physical
input acceptance. A fresh independent review and required CI for the published final head remain
PR gates; signed-package and real-Provider gates remain parent requirements.

## Remaining parent scope

| Issue | Existing scope                                                                                                      | Remaining dependency / acceptance                                                                                                                                                                                                                                                                                              |
| ----- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #333  | V1 native/Main/Controller/Broker/IPC and schema-v4 evidence gates; this PR tests their metadata join                | Protected runner must independently verify owned-run facts and closure digest; signer/process/privacy digest producers and 27 coverage producers must connect to sealing. Current generator refuses Core/Safety PASS. #387 signed Windows/notarized macOS and #388 real non-OpenRouter Provider acceptance are still required. |
| #500  | S1 permissions (#501), S2 target tools/ADR (#503), S3a grants/settings (#504), S3b chat/start (#505) already merged | S4 macOS deny/surface/execution interlock is an inseparable reviewed checkpoint before S5 Windows, then UWP/browser and S8 V1 retirement. Windows-only execution cannot establish macOS real-app/process-signature acceptance; do not enable the feature or remove V1 prematurely.                                             |

Current user authorization covers preparing the existing PR in an isolated worktree. Offline
fixtures on either OS cannot supply signed-package real-app or credential-bearing Provider
acceptance. Those require a separate concrete execution environment / paid Provider authorization.
This checkpoint requests neither setting changes nor those external actions.
