# Team v2 Core

## Team formation

- Chat本文とユーザー指定人数・役割をLeaderへ渡す。
- 明示的な「Teamで」「3人で」等は必ずTeamを形成する。
- 明示指定がなくても、独立可能な作業が複数あり並列化の便益がある場合はTeamを提案または形成する。
- 総Agent数は固定しない。既定の予算と最大8実行枠で制御し、Team Policyでunlimited budgetを
  明示選択できる。
- 雇用はexecution slot不足を理由に拒否しない。

## Hierarchy and delegation

- Agentは`parentAgentId`、`depth`、`canDelegate`、`managerPolicy`を持つ。
- Leader depthは0、最大Agent depthは4。
- `canDelegate=true`のAgentだけが子を雇用できる。一般Workerは委譲不可。
- Managerは子Workerの報告を検証・集約して直属親へ報告する。
- 親子関係、雇用理由、割当、報告、stopをaudit eventへ保存する。

## Model assignment

- LeaderはTeam Policy、required capabilities、利用可能性、ユーザーのConnection優先、予算、
  concurrencyを使って候補を絞る。
- source付きの能力値だけを順位付けに使い、model名やProvider名から速度・品質を推測しない。
- unknownは0点やfalseへ変換しない。同率時はTeam Policyの既定selection、その後stable ID順にする。
- Agentごとにconnection IDとrequested modelを保存し、選択理由をauditへ残す。
- Coreでは候補は既存Claude CLI／Codex CLIだけだが、後続Providerも同じinterfaceへ追加する。

## Execution and attempt

- task割当は永続executionを作成し、完了を待たずexecution IDを返す。
- Team全体の実行上限は8。queued executionはAI実行枠を消費しない。
- executionは1人のWorkerへの論理的な仕事、attemptは具体的なRuntime呼び出しとする。
- Runtime crash、steer、明示retryは同じexecutionへ新attemptを作る。
- queued中のsteerはinstruction revisionを更新する。
- running中のsteerは現在attemptを`interrupted_by_steer`でcancelし、同じWorker・同じexecutionへ
  新attemptを作る。明示的なmodel再指定がない限りselectionを維持する。

## Communication

- Leader、Manager、Worker間のdirect messageを許可する。
- messageは送信前に永続化し、source、target、seq、execution、attempt、delivery stateを監査する。
- Worker間messageもTeam Policy、rate limit、capability ceilingを越えない。
- stop workerは実行中attemptをcancelし、queued executionも取消す。

## Recovery

- app再起動時、running attemptは`interrupted`へ確定し、executionはPolicyに従いqueuedまたは
  needs-reviewへ戻す。
- queued順、instruction revision、親子関係、selection、audit順序を復元する。
- Worker reportが永続済みなら重複実行せず、未確定dispatchだけを再評価する。

## User interface

- Chat timelineへ`worker_hired`、`task_assigned`、`execution_queued`、`execution_started`、
  `steered`、`worker_reported`、`worker_stopped`を永続Cardとして表示する。
- Cardのsummaryは「調査担当を雇いました」のように短くし、detailsでAgent、model、Connection、
  execution、attempt、時刻、理由を開示する。
- Agent Card、Activity Card、Canvas、List Viewは同じprojectionを使う。
- Canvasは親子treeを表示し、List Viewは同等情報とkeyboard操作を提供する。

## Core acceptance

- 8件が実際に同時runningになり、9件目がqueue表示される。
- depth 4まで委譲でき、depth 5と非Manager委譲は拒否される。
- Worker間通信とrunning steerが監査履歴から再現できる。
- Claude-only、Codex-only、混在Teamが再起動後も復元する。
- 外部Provider未設定でも既存ChatとTeamが動く。
