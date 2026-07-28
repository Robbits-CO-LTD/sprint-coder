# Team v2 Core Slices

## Slice 0 — Baseline and decisions

### Outcome

実装前baseline、Root Cause Confirmed Gate、Core schema、execution model、connection identityを
確定する。

### Required

- Team unit 2失敗とE2E 3 timeoutの原因箇所・経路・独立証拠
- current Team data flowとstate transition matrix
- connection ID先行導入ADR
- Coreのfeature boundariesとrollback
- 既存CLI packaged resolution確認

### Non-goals

製品機能追加、外部API、Secret Storage。

### Proof

再現command、原因証拠、修正後に使う同一acceptance command、Accepted ADR。

## Core A — Domain and persistence

- parent/depth/canDelegate、Team Policy
- ModelSelection、connection identity
- execution、attempt、instruction revision、queue
- direct message audit
- Team activity event
- restart projectionとmigration fixture

Proof: pure domain state-machine testとpersistence integration。

## Core B — Coordinator and Runtime

- dynamic hire、Manager delegation
- global execution Scheduler 8
- async assign returning execution ID
- queued steer、interrupt-and-resume running steer
- Worker message routing
- stop queued/running、budget、recovery

Proof: deterministic Runtimeで8 parallel、depth、steer、crash／restart。

進捗:

- B1a完了: 旧3 Worker hard cap撤廃、5 Worker雇用回帰、明示的かつcaller-boundな
  `requesterAgentId`を受けるCoordinator境界、Manager Policyに基づく子Agent登録。
- B1b完了: 可変人数Canvas／List表示、先頭3配置互換、4人目以降の決定的配置、
  10 Worker pure geometry test、5 Worker packaged E2E。UI実装は規定どおり
  `UI_DELEGATION_MODEL`を使うClaude CLIへ委託し、メインAgentが差分とtestを再検証した。
- B2a完了: global最大8、Team Policy別上限、FIFO、失敗時枠解放を担うCore admission
  schedulerとdeferred job unit test。
- B2b完了: 永続execution/message/task/deliveryをSchedulerへ接続し、formal
  `team_assign_task`が完了を待たずexecution IDを返す。global 8 running／2 queued、
  attempt、message link、失敗時枠解放をElectron ABIで検証。旧IPC `sendToWorker`は
  後方互換の同期経路として維持する。
- B3a完了: queued instruction revision、queued cancel、Schedulerからの取消、task/delivery終端化、
  Claude/Codex MCP tool公開。revised instructionがruntime開始時に解決されることをElectron ABIで検証。
- B3b次着手: running executionのinterrupt-and-resume steerとcancel。
- B3c後続: 再起動queue rehydrate。
  Manager MCP caller bindingはRuntime接続Sliceで行い、model-controlled引数からAgent
  identityを受け取らない。

## Core C — User experience and GA

- Agent／Activity Card
- persistent Chat Team event
- hierarchical CanvasとList View
- Team Policy settings
- queue stateとelapsed
- Claude CLI／Codex CLI packaged execution

Proof: component、keyboard、accessibility、Playwright、packaged Computer Use evidence。
