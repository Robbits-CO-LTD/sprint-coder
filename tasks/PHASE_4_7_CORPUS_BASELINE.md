# Phase 4.7 Standard Assurance corpus baseline

- Seed: `standard-assurance-baseline-v1`
- Configuration digest: `ff20a0c26012967120d007942dfa61f87269cc924f4c7ccf3a3a9ceca57abb0f`
- Fixed cases: 30
- Categories: locate, edit, debug, multi-file, safety, recovery, context, review
- Successful expected outcomes: 30/30
- False completions: 0
- Gating criteria passed: 25/30 (the remaining 5 are expected blocked outcomes)
- Unnecessary diff lines: 0
- Tool calls: 22
- Input/output token estimates: 244/275
- Estimated cost units: 739
- Approval count: 0
- Repair rounds: 11
- User interventions: 5 expected blocked outcomes

`wallTimeMs` is captured for every run but is not fixed because it depends on the host. Reproduce with:

```sh
cd apps/desktop
npm test -- --run src/main/agent-corpus.test.ts
```
