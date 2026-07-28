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
- P2c1: Registry、Connection作成／列挙／検証IPC、safeStorage、catalog／selection統合を完了
- P2c2: Chat execution、provider-egress、context、stream、usage永続化、cancel、
  resolved provider／modelを完了
- P2c3: Worker別model selection／親継承、Team Provider Worker、429 retry連携、
  attempt resolution／usage永続化を完了。release smokeはfinal gateへ留保

P2aでは生成API、Chat／Team配線、実API probeを行わない。実API smokeは全実装後のfinal gateへ
留保する。

## P3 completion

- OpenRouter ConnectionのMain／Preload契約、Main-only secret、作成直後verificationを追加
- `/models`の1000件超catalogを共通catalogへ変換し、価格とcapabilityの情報源を保持
- Responses APIのstream、Tool Calling、Structured Output、usage／cost、取消、429を正規化
- `X-OpenRouter-Metadata`を有効化し、requested model、Gateway、upstream、routingを分離
- DB v48でChat TurnとTeam attemptの完全なexecution resolutionを永続化
- catalog時刻更新だけでは検索indexを再構築しない
- Chat／Team実行はP2で追加したProvider-neutral経路を再利用し、OpenRouter固有分岐を
  TeamCoordinatorへ追加しない

実API smoke、packaged E2E、再起動後のrouting履歴確認は全実装後のfinal gateへ留保する。

## P4 completion

- Anthropic公式APIを`official_api` Connectionとして追加し、built-in Claude CLIと識別
- `x-api-key`とversion headerをMain-only Adapterで付与し、Secretはreferenceだけを永続化
- Models APIのpagination、availability、context／output上限、公開capabilityをcatalogへ反映
- Messages SSEのtext、thinking、Tool Calling、Structured Output、usage、resolved model、
  cancellation、429／529をcanonical eventへ正規化
- Chat／Teamは共通ProviderRuntime経路を再利用し、Team CoreへAnthropic固有importを追加しない

実API smokeとpackaged E2Eは全実装後のfinal gateへ留保する。

## P5 progress

- P5a: Google Gemini API Connection、Main-only secret、Models API pagination、
  `streamGenerateContent` SSE、function call、structured output、thinking、usage、
  cancellation、429 normalizationを完了
- P5b: 共通message contractのmultimodal inputとGemini `inlineData`変換

P5aではModels APIが公開しないtool／structured／multimodal能力をモデル名から推測せず
`unknown`にする。P5bは既存text-only Chat／Team経路を壊さない独立変更として実装する。
実API smokeとpackaged E2Eはfinal gateへ留保する。

## Shared stop rule

Sliceの受入条件がgreenになったら停止して証拠を報告する。隣接Provider、cleanup、将来の
hardeningを同じPRへ取り込まない。
