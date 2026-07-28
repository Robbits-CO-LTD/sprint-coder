# Rate-limit Scheduler

## Admission stages

1. Team global execution limit: 8
2. Connection limit: external APIだけにmax concurrent、RPM、TPMを適用

queued／waiting中はglobal slotとConnection concurrent slotを消費しない。slotを同時に取得できる
executionだけをrunningへ遷移する。

## Built-in CLI

`builtin:claude-cli`と`builtin:codex-cli`はAPI rate-limit admission対象外とする。global 8枠は
消費するが、外部API向けの既定2並列、RPM、TPMを適用しない。CLI固有上限が必要になった場合は
独立設定とADRで扱う。

## Hire and assign

- `team_hire_worker`はslot不足を理由に拒否しない。
- `team_assign_task`はexecutionを永続化し、完了を待たずexecution IDを返す。
- slotがなければattemptをfailedにせずqueueへ置く。
- stop workerはqueued executionをcanceledにし、running attemptをcancelする。

## States and reasons

execution／attemptは必要に応じて次を使う。

- assigned
- queued
- waiting_verification
- waiting_rate_limit
- running
- completed／failed／canceled／interrupted

wait reasonは`team_concurrency`、`connection_concurrency`、`requests_per_minute`、
`tokens_per_minute`、`verification`、`budget`をtyped valueで保存する。

## Connection settings

- `maxConcurrentRequests`
- `requestsPerMinute`
- `tokensPerMinute`
- `rateLimitMode`
- `lastObservedRateLimitHeaders`

初期modeは`auto`。制限を取得できない外部API Connectionは同時2件を既定とする。ユーザーは
下げられる。高度設定で引き上げる場合は429増加警告を表示する。built-in CLIには適用しない。

## Fairness

- Connectionごとにtoken bucket
- Connection内は永続`queueSequence`によるFIFO
- Connection間はround-robin
- agingで長時間待機executionのpriorityを段階的に上げる
- 同一Connection内で新しいTeam taskが古い別Team taskを追い越さない
- queue sequence、round-robin cursor、bucket観測値を復元可能にする

## 429

1. `Retry-After`に従う
2. rate-limit headerをSchedulerへ反映
3. 同じattempt IDを`waiting_rate_limit`へ戻す
4. provider call ordinalとretry countを増やす
5. exponential backoff＋jitter
6. 既定3 retry、task deadlineまたはTeam wall-clock budgetまで

上限到達時だけ`rate_limited`でfailedにする。invalid API key、model not found、permanent outage、
successへ分類しない。

## Time accounting

queue waitとAI executionを別々に記録する。Team wall-clock budgetにはqueueを含めるが、
model実行時間には含めない。

## UI

Agent Card、Activity Card、Canvas、List Viewにstate、理由、待機開始または経過時間、
Connection名を表示する。

```text
待機中：OpenAI APIの同時実行上限（2）に達しています
```

状態なしで進捗が止まって見える表示を禁止する。
