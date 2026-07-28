# Current State

調査日: 2026-07-28

## Runtime

- `apps/desktop/src/runtime-host/index.ts`は1 UtilityProcessにつきClaudeまたはCodexのCLI Adapterを
  1つ起動する。
- Mainの`RuntimeHostClient`は`start`と`cancel`を持つが、production steer protocolはない。
- Claude catalogはcurated 4件、Codex catalogは`~/.codex/models_cache.json`由来である。
- WorkerはChatで選択中の1つのruntime/modelを全員で共有する。Agent別modelは保存されない。
- Runtime canonical eventにはstream、stage、file change、completedがあるが、共通Provider usage契約は
  ない。

## Model selection

- 選択はglobal settingsの`runtime.kind`とRuntime別model keyへ保存される。
- 各Turnは`turns.runtime_kind`と`turns.model`へ送信時snapshotを保存する。
- Claudeのresolved modelはlive eventだけで、Turnの永続列には保存されない。
- `agent_threads`は`runtime_kind`だけを持ち、Agentはmodelを持たない。
- RendererのPickerは`runtime.models.map()`で全件同期renderし、contractは最大32件に制限される。
- feature flag基盤とProvider横断catalog interfaceはない。

## Team

- `TeamCoordinator`の`MAX_WORKERS`は3。
- `assignTask`はtask ID単位のPromise queue内でRuntime完了までawaitするため、Worker実行は直列。
- `DEFAULT_TEAM_BUDGET_LIMITS.team.spawnSlots`は8だが、Worker startup後にreleaseされる予算leaseで
  あり、execution concurrencyではない。
- Worker capabilityは`maxWorkerDepth: 0`、`maxConcurrentWorkers: 0`で固定される。
- domainとpersistenceがLeader↔Worker以外のmessageを拒否する。
- delivery attemptはあるが、execution／attempt／queueは独立した正本になっていない。
- `team_tasks`に`waiting`はあるが、queue reason、Connection、queued timestampはない。
- stopは実行中CLIのcancelに対応するが、queued cancellationやinterrupt-and-resume steerはない。

## Team UI

- CanvasとList ViewはWorker上限3を直接表示する。
- Worker Cardはruntime種別を表示するがmodel、Connection、queue reasonを表示しない。
- transientな雇用通知はあるが、Chat timelineへ永続Team Activity Cardを追加していない。
- TeamはLeader中心のstar layoutで、親子階層を表現しない。

## Persistence and process boundaries

- SQLite migrationはv34。migration checksum、transaction、`.pre-migration.bak`、foreign-key checkを
  既に持つ。
- RendererはZustand、PreloadはZod検証付きtyped IPC、MainがDBとRuntimeを所有する。
- packaged runtime-hostはForge Vite entryとして`runtime-host.js`へbuildされ、Mainが
  `utilityProcess.fork(join(__dirname, "runtime-host.js"))`で起動する。
- Provider egress policyはあるが、Provider Connection／Adapter Registryではない。

## Secrets, logging, limits

- safeStorageは旧設計文書の要件だけで、Secret Storage実装はない。
- `secret-redactor.ts`は既存するが、全経路を強制する共通secure loggerはない。
- production Main／Team bridgeに生の`console.*`が残る。
- API Connection別rate limit、429 normalization、token bucket、fairness queueはない。

## Existing verification evidence

- 対象Team unit: 55 pass、1 skip、2 fail。2件はElectron ABI用wrapperがVitest pathを誤解決する
  テスト起動問題であり、製品仕様の合格証拠には使えない。
- `tests/e2e/team-flow.spec.ts`: 3件すべて90秒timeout。原因未確定。
- packagedアプリは生成可能だが、Computer Useでは同名Electron processの識別とAX取得が安定せず、
  最終証拠として未成立。

Slice 0はこれらを既知blockerとして扱い、原因未確定のままテストを弱めない。
