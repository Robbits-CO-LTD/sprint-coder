# Current State

調査日: 2026-07-28

対象commit: `2c645b6`

## 結論

Team v2 Coreのdomain、永続execution／attempt、global最大8並列、階層UI、Team Policyは実装済みで
ある。Multi-Providerのためのconnection identity列は先行導入済みだが、Connection正本、
Provider Registry／Runtime、API rate admission、Secret Storage、共通Model Pickerは未実装である。

## データ経路マトリクス

| 経路 | 現在の正本／境界 | 現状 | P1以降の扱い |
|---|---|---|---|
| Chat送信 | `persistence.ts:8294-8355` | Task selectionをTurnへsnapshot | Connection解決をRegistryへ委譲 |
| Team雇用 | `persistence.ts:3485-3515` | built-in identityをAgent／threadへ保存 | Agent selectionを実行時にも使用 |
| Team実行 | `team-coordinator.ts:410-454` | durable execution作成後に即ID返却 | Connection admissionを追加 |
| runtime dispatch | `ipc.ts:1490-1525` | Claude／CodexをMainで分岐 | ProviderRuntime interfaceへ置換 |
| Main→Runtime Host | `runtime-host.ts:58-105` | process-local protocol | canonical Provider eventを追加 |
| Runtime Host→CLI | `claude-adapter.ts:128-198`、`codex-adapter.ts:70-123` | CLI process／MCP | built-in Runtimeとして保持 |
| model選択UI | `Composer.tsx:438-515` | global配列を同期render | Main catalog queryへ置換 |
| 設定保存 | `appStore.ts:784-822`、`ipc.ts:430-477` | global runtime/model | canonical Task selection repository |
| queue復元 | `team-coordinator.ts:987-1017` | durable ordinal順に再投入 | Connection queueも同じ正本を使用 |
| resolved model | `protocol.ts:43-51`、`persistence.ts:7769-7772` | Claudeのみ任意 | 全Providerでattemptへ正規化 |

## Runtime

- Runtime Hostは1 UtilityProcessにつきClaudeまたはCodexのCLI Adapterを1つ持つ
  (`runtime-host/index.ts:13-37`)。
- Mainの`RuntimeHostClient`は`start`と`cancel`を持つ。Teamのrunning steerは現在のprocessを
  cancelし、同じexecutionの新attemptとして再投入する。
- Claude／Codex AdapterはCLI processを直接起動する。公式API Adapter、Provider Registry、
  usage normalization、Connection verificationは存在しない。
- protocol v5のcanonical eventはstage、delta、reasoning、thread、file change／edit、completed。
  usage、rate-limit、routing、resolved providerの共通eventはない
  (`runtime-host/protocol.ts:14-125`)。
- packaged runtime-hostはForgeの独立entryで、Mainが`utilityProcess.fork`する
  (`forge.config.ts:75-82`、`main/runtime-host.ts:125-165`)。production fuseはRunAsNode、
  Node options、inspectorを無効化している。

## Connection identityとmodel selection

- stable built-in IDは`builtin:claude-cli`と`builtin:codex-cli`
  (`connection-identity.ts:7-28`)。
- DB v35はTurn、thread、Agentへidentity列、v36はTaskへselection列を追加した。
  v38のexecution／attemptもidentity列を持つ (`persistence.ts:1810-1935`)。
- 新規Task、Turn、Agentはidentityを保存する (`persistence.ts:3182-3254`、
  `3485-3515`、`8294-8355`)。
- v35 migrationは列追加だけで、既存rowをbackfillしない。pre-v35履歴はlegacy
  `runtime_kind`／`model`だけを持つため、P1Aの必須対象である。
- Task selectionはcanonical repositoryを持つが、RendererのPickerはglobal
  `settings.setRuntime/setModel`を操作する。会話単位UIとの接続は未完了。
- Worker identityは保存される一方、`RuntimeHostTeamWorkerRuntime`は実行時にglobal
  runtime/modelを再選択する (`ipc.ts:216-225`、`team-worker-runtime.ts:103-171`)。
  Worker別モデル割当は保存と実行がまだ一貫していない。
- model contractは最大32件 (`contracts/index.ts:1257`)。ComposerとSettingsは
  `runtime.models.map()`で同期renderするため、大量catalogへ対応していない。

## Team executionとScheduler

- `TeamExecutionScheduler`はglobal 8枠とTeam別上限を同時に守り、queued jobはactive countへ
  含めない (`team-execution-scheduler.ts:1-123`)。
- queue、attempt、instruction revision、queue reasonはDB v38から永続化される。
- queue復元、queued steer/cancel、running interrupt-and-resumeはCoreで実装済み。
- 現SchedulerはConnection IDを入力に持たず、token bucket、RPM／TPM、429 retry、
  Connection間round-robin／agingを実装していない。P1Bは既存8枠を置換せず第二admissionを統合する。
- built-in CLIには外部API rate limitを適用しない。現在の8並列を維持することが回帰条件である。

## Persistence

- 最新schemaはv40。migrationはchecksum検査、migrationごとのtransaction、適用前backup、
  `foreign_key_check`を持つ (`persistence.ts:2872-3003`)。
- 既存migration testはv1→v40をコード内生成DBで検査するが、計画指定の独立DB fixture群は
  まだ存在しない。P1Aでfixtureを追加する。
- legacy列は削除しない。P1Aはdual-readとunknown legacy runtime表示を追加し、cleanupは別Sliceにする。

## Renderer／Preload／Main

- RendererはZustand、Preloadはtyped IPC、MainはDB、秘密、runtime、networkの所有者である。
- API keyをRenderer stateへ置かない。Rendererが扱うのはmasked metadataとsecret referenceだけにする。
- U1のPickerはRuntime固有stateを読まず、Mainのcatalog query interfaceだけへ依存する。

## Secrets、logging、rate limit

- `safeStorage`を使うSecret Storageは未実装。
- `secret-redactor.ts:66-97`は文字列／stream redactionを持つが、全production logを強制する
  secure loggerではない。
- production Mainに`console.*`が残る (`main/index.ts:101,197,204`、
  `team-mcp-bridge.ts:135`)。P1BでCI禁止とsecure loggerへ移行する。
- Connection設定、verification TTL、observed rate-limit headers、429 normalizationは未実装。

## 既存test資産

- Runtime JSONL fixture: `runtime-host/fixtures/`。
- Scheduler、execution persistence、Coordinatorのunit／Electron ABI testがある。
- packaged Team、activity restart、Canvas／List、Policy、model/access E2Eがある。
- v1 migrationはコード内fixtureだけであり、P1A指定の初期版、Team導入前、production、
  Claude/Codex混在、running/interrupted、不明modelのDB fixtureは不足している。
- 実AI、全E2E、packaged、Computer Useはユーザー指示により全実装後の最終gateへ集約する。

## 公式仕様の確認

P0は有料probeを行わず、2026-07-28時点の公式資料だけを確認した。

- [OpenAI Models API](https://platform.openai.com/docs/api-reference/models/object)
- [OpenAI rate limits](https://platform.openai.com/docs/guides/rate-limits)
- [OpenRouter Models API](https://openrouter.ai/docs/api/api-reference/models/get-models)
- [OpenRouter errors and Retry-After](https://openrouter.ai/docs/api/reference/errors-and-debugging)
- [Anthropic Models API](https://platform.claude.com/docs/en/api/models/list)
- [Anthropic rate limits](https://platform.claude.com/docs/en/api/rate-limits)
- [Gemini Models API](https://ai.google.dev/api/models)
- [Gemini rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
- [xAI Models API](https://docs.x.ai/developers/rest-api-reference/inference/models)
- [xAI rate limits](https://docs.x.ai/developers/rate-limits)
