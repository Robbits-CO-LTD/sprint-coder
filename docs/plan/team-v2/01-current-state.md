# Current State

調査日: 2026-07-28

基準: working tree上のTeam v2／Multi-Provider実装。macOS local final gate実行済み。

## 結論

Team v2 Core、公式API 5 Provider、OpenAI-compatible Pack A/B、共通Model Picker、
Connection設定、Secret Storage、二段階Schedulerまで製品コードへ接続済みである。

今回追加した最終統合では、実CLI／公式API LeaderとManagerがcatalogからWorker別modelを選び、
Manager／Workerがprovider-neutralなtool loopでTeam toolを実行できるようにした。Worker間通信、
実行中監視とsteer、階層Canvas、model／Connection／選定理由の監査表示も接続済みである。

実装は完了し、変更中の反復ではなく最後にまとめたlocal final gateでunit、lint、typecheck、
packaged E2E、実CLI、利用可能な実API、Computer Useを検証した。ただし3OS CIと、資格情報が
存在しないProviderの実API smokeは未実行なので、全GA条件の完成は宣言しない。

## 実装済みの主要経路

| 経路                  | 現在の正本／境界                      | 状態                                                  |
| --------------------- | ------------------------------------- | ----------------------------------------------------- |
| Chat model selection  | Task canonical selection repository   | 旧／新Pickerが同じselectionを読む                     |
| Team model selection  | `team_list_models` + hire audit       | 実Leader／Managerはselectionと理由が必須              |
| CLI Team              | Team MCP bridge                       | Claude／Codex Leader、Manager、Worker通信を接続       |
| API Team              | canonical Provider tool loop          | Leader／Manager／Workerが複数roundのtool callを実行   |
| Team hierarchy        | persisted parent/depth/Manager Policy | 深度4、Managerによる直下Agent再委譲                   |
| execution             | durable execution／attempt            | assign即ID、queue、running steer、cancel、restart     |
| Scheduler             | global 8 + Connection admission       | built-in bypass、token bucket、round-robin、aging     |
| 429                   | same attempt retry                    | Retry-After、jitter、最大3回、terminal `rate_limited` |
| Provider verification | Main verification service             | 24時間TTL、3秒preflight、期限切れfail-closed          |
| Provider secrets      | safeStorage wrapper                   | DBはopaque referenceだけを保存                        |
| Provider settings     | typed Main／Preload IPC               | 作成、再確認、外部Connection上限のlower-only変更      |
| Team UI               | Canvas／List／Activity Card           | 階層、model、Connection、queue理由、選定理由を表示    |

## RuntimeとProvider

- built-in Connectionは`builtin:claude-cli`、`builtin:codex-cli`で安定している。
- 外部APIはOpenAI、OpenRouter、Anthropic、Gemini、xAIを独立Runtimeとして登録済み。
- Pack A/Bは専用Adapterを複製せず、宣言的`ProviderProfile`と共通OpenAI-compatible Runtimeを使う。
- ChatとTeam attemptはrequested／resolved provider/model、routing、normalized usageを分離して保存する。
- Provider message contractはassistant tool callとtool result履歴を保持し、OpenAI Responses、
  Chat Completions、Anthropic Messages、Gemini形式へAdapter内で変換する。
- Team CoreはProvider固有client／SDKへ依存しない。ESLint import制限とTypeScript AST検査は
  local final gateでgreen。

## Team executionと監督

- Team全体の同時AI実行上限は8。queued／waiting中はactive枠を消費しない。
- built-in CLIはConnection rate admissionをbypassし、Team全体の8枠だけを消費する。
- Connection内FIFO、Connection間round-robin、同一Connection内Team round-robin、
  30秒agingでstarvationを防ぐ。
- Leaderは実行中に`team_get_status`で`currentActivity`と`liveOutput`を読み、
  scope逸脱や誤実装を見つけた時点で`team_steer_execution`できる。
- ManagerのauthorityはMCP tokenまたはprovider runtime contextへ固定し、直下Agentの
  hire／assignと自分が作成したexecutionのsteer／cancelだけを許可する。
- Worker間messageはTeam Policyを確認し、送信元identityをmodel引数から受け取らず監査保存する。
- Worker停止はqueued job、rate-limit後のpending resume、running attemptも取消し、
  停止後にexecutionが再開しない。

## Renderer／Preload／Main

- RendererはProvider Runtime、Secret、DBへ直接触れない。
- 共通PickerはMain catalog queryだけを読み、revision単位index、paging、常時virtualizationを使う。
- 1000件超の合成catalog fixtureとviewport外非描画testを実装済み。
- `multiProviderModelPickerV2=0`では旧Pickerへ戻せる。U4削除はfinal gate後の独立cleanupである。
- Provider設定UIはClaude CLI非対話実行へ小Slice単位で委託した。今回の変更では、
  Team階層表示、Worker model／Connection／理由、外部API表示、Connection同時実行上限を追加した。

## Persistenceとmigration

- 現在のschemaはv48。
- connection identity、Team execution／attempt／activity、Provider connection、
  secret reference、verification、rate limit、routing metadataを永続化する。
- pre-v35 built-in identityはv42でbackfillし、legacy列は削除せずdual-readを維持する。
- migrationはtransaction、checksum、適用前backup、`foreign_key_check`を持つ。
- v1から最新、built-in identity backfill、Claudeのみ、Codexのみ、Claude／Codex混在、
  不明legacy model、二重migrationのfixtureを実装済み。
- running／interrupted attemptの再起動復元はCoordinator／execution persistenceのfixtureで
  分離して検証する。これらを含むmigration matrixはdesktop unit suiteでgreen。

## SecurityとCI

- Main／Preload／Runtime productionの`console.*`はESLint error。
- secure loggerはheader、body、URL query、Errorをsink前にredactする。
- safeStorage、SQLite／Renderer非露出、canary secret testを実装済み。
- Team CoreのProvider固有importとProvider名によるcontrol-flow分岐をASTで検査するtestを追加した。
- 実secret、Authorization Header、ユーザー会話をUI委託prompt／fixtureへ渡していない。

## Local final gate evidence

- full typecheck、lint、format check: green
- desktop unit: 106 files passed、3 skipped、1444 passed、23 skipped
- contracts: 30 passed、domain: 284 passed
- packaged E2E: 初回で検出した16件を修正し、対象再検証green
- 実Claude packaged Team: 2 Worker reportとLeader統合green
- 実Codex packaged Team: 数学担当／実装担当、2 Worker reportとLeader統合green
- OpenRouter実API: verified、368-model catalog、stream／resolution／usage／completed green
- Computer Use: production packageの共通Picker、unknown表示、Team Canvas、AX treeを確認

## External release gateまで保留する証拠

- 3OS CI
- OpenAI、Anthropic、Gemini、xAI、Pack A/Bの実API smoke（資格情報なし）
- Windows／Linux packaged E2E
- UI U4 cleanup（rollback用旧Pickerを意図的に維持）

## Blocker

- `instructions/01-multi-provider-addendum.md`の原文はローカルに存在しない。提供されるまで
  placeholderを維持し、内容を創作しない。
- macOS local gateはgreenだが、上記external release gate未実行のためInitial GA／Pack GAを
  completeとは扱わない。
