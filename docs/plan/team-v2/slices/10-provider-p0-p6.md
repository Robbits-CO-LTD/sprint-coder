# Provider Slices P0–P6

| Slice | Outcome | Must not include | Exit proof |
|---|---|---|---|
| P0 | current-stateとADR | code change | source-linked調査、Accepted ADR |
| P1A | Connection domainとlegacy migration | real Provider API | 全DB fixture、dual-read、CLI 8並列 |
| P1B | registry、mock、secrets、Scheduler | 大量Adapter | mock conformance、secret canary、fairness |
| P2 | OpenAI reference Adapter | 他Provider | Chat／Team contract、real smoke |
| P3 | OpenRouter Gateway | official routeとの混同 | 1000+ catalog、routing履歴 |
| P4 | Anthropic official API | Claude CLIとの混同 | Provider固有fixture、Team smoke |
| P5 | Gemini | OpenAI wire formatの強制 | multimodal／structured contract |
| P6 | xAI | generic RuntimeのxAI分岐 | Grok catalog／error／usage contract |

## P0 completion

P0は2026-07-28にdocs-onlyで完了した。

- [current state](../01-current-state.md)をCore後の実装へ更新
- [ADR-003〜007](../adrs/README.md)をAccepted
- v35 identity先行導入の成功とpre-v35 backfill残件を分離
- global 8枠を保持する二段階admission、CLI除外、FIFO／round-robin／agingを確定
- Main catalog query、1000+ fixture、feature flag並走を確定
- Profile、24時間TTL、3秒preflight、Main-only Secret Storageを確定
- 実API通信、有料probe、製品コード変更は実施していない

## P1A progress

- P1A-a: 共通`ProviderConnection`契約、DB v41、built-in CLI 2件の安定ID seed、
  persistence list/getを完了
- P1A-b: DB v42によるpre-v35 legacy rowのbackfillとTurn／Agent dual-readを完了
- P1A-c: 指定DB fixture、再起動復元、旧／新Picker互換、CLI並列維持の証拠

P1A-aでは実Provider API、Secret Storage、Scheduler変更を行わない。

## P1B progress

- P1B-a: Provider Runtime／Registry interface、canonical event、error／usage normalization、
  capability schema、Mock Runtimeを完了
- P1B-b1: secure logger、sink側強制redaction、production `no-console`を完了
- P1B-b2: safeStorage adapter、Main-only encrypted blob、DB secret referenceを完了
- P1B-b3: 24時間TTL、3秒preflight、built-in除外を含むconnection verificationを完了
- P1B-c1: Connection token bucket、concurrency、round-robin、aging domainを完了
- P1B-c2a: global 8枠への統合と永続`waiting_rate_limit`を完了
- P1B-c2b: 429 same-attempt retry、非active backoff、既定3回上限を完了

P1B-aは外部network、実Provider SDK、認証情報を扱わない。

## P2 progress

- P2a: Main-only credential resolver、OpenAI auth header、`GET /v1/models`による無料verification、
  model discovery、credentials／temporary／network分類を完了
- P2b: Responses API、SSE stream、Tool Calling、Structured Output、usage normalization、
  resolved model、429 event、cancellationを完了
- P2c: Registry、Chat／Team execution、cancel、resolved model、release smoke

P2aでは生成API、Chat／Team配線、実API probeを行わない。実API smokeは全実装後のfinal gateへ
留保する。

## Shared stop rule

Sliceの受入条件がgreenになったら停止して証拠を報告する。隣接Provider、cleanup、将来の
hardeningを同じPRへ取り込まない。
