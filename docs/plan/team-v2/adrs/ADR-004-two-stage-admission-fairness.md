# ADR-004: 二段階admissionとConnection fairness

- Status: Accepted
- Date: 2026-07-28
- Supersedes: `instructions/02-final-revision-v2.md` §6の未決実装位置

## Decision

既存`TeamExecutionScheduler`を捨てず、1つのdurable queueから次の条件を同時に満たすjobだけを
admitする。

1. global active数が8未満
2. Team active数がTeam Policy未満
3. 外部API Connectionのconcurrency／token bucketが許可

built-in CLI Connectionは3を通らず、1と2だけを消費する。外部APIの情報がないConnectionは
`maxConcurrentRequests=2`、`rateLimitMode=auto`で開始する。

Connection内は永続`queue_ordinal`のFIFO、Connection間はround-robinとする。同じConnection内では
Team別subqueueをround-robinし、待機時間bucketによるagingを加える。agingはFIFOを逆転させる
任意priorityではなく、長時間待機Teamを次roundの先頭候補へ昇格する。

429は同じattempt IDとexecution IDを維持し、provider call ordinalだけを増やす。
`Retry-After`、observed headers、exponential backoff＋jitterの順で再投入し、既定3回またはdeadline
到達時だけ`rate_limited`でfailedにする。

## Queue durability

queue順、waiting reason、queuedAt、Connection IDはDBを正本とする。再起動時はDB順にSchedulerへ
再投入し、memory queueを復元元にしない。queue待ち時間はwall-clock budgetへ含めるが、
model execution timeへ含めない。

## Evidence

- global 8枠とTeam別上限: `team-execution-scheduler.ts:1-123`
- durable queue state／reason: `persistence.ts:1866-1935`
- restart再投入: `team-coordinator.ts:987-1017`
- OpenAIはrate-limit response headersを公開する。
- Anthropicはtoken bucket、RPM／ITPM／OTPM、429 `retry-after`を公式に明記する。
- Geminiはlimitがproject／model／tier依存、xAIはteam／model依存である。固定Provider値ではなく
  Connection観測値が必要である。

## Rejected

- built-in CLIへ外部APIの同時2件既定値を適用する案
- Connection別memory queueを別正本にする案
- 全Connection共通FIFOだけでfairnessを表現する案
