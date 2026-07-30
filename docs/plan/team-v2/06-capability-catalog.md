# Capability Catalog

## Source model

```ts
type CapabilitySource = "provider_api" | "official_curated" | "unknown";

type CatalogValue<T> = {
  value: T | null;
  source: CapabilitySource;
  sourceReference?: string;
  observedAt?: string;
};
```

## Required identity

model entryをvalidとする最低条件は次である。

- connection ID
- provider ID
- model ID
- display name
- availability
- availability確認日時

速度、価格、品質、コーディング適性がunknownでもmodelを除外しない。

## Sources

### provider_api

Provider APIまたは実Runtimeが返したmodel ID、availability、resolved model、利用権限、usage、
context情報。

### official_curated

公式文書を人手で管理したcontext window、output token、公式価格、input type、Tool Calling、
Structured Output、reasoning。可能な範囲でsource URL／document ID、version、reviewedAt、
reviewedBy、pricing effective dateを持つ。

### unknown

信頼できる情報がない状態。coding、reasoning、speed、cost tendency、quality ranking、latencyは
model名、価格、Provider名から推測しない。

## UI

null、0、falseを混同しない。`unknown`は「不明」と表示する。

```text
コーディング適性：不明
速度傾向：不明
価格：不明
```

## Refresh and stale data

- catalogはConnection、source、revision、observedAtを持つ。
- refresh失敗時は最後のcatalogをstale表示で残す。
- staleをunavailableへ自動変換しない。
- duplicate model IDはConnection IDを含むcompound identityで区別する。
- resolved modelはProvider応答だけで更新する。

## CI invariants

- optional curationがunknownでもvalid
- unknownを0／falseへ変換しない
- sourceのないcurated valueを拒否
- model名から傾向を自動生成しない
- Provider Profile schema validation
- duplicate identity、stale catalog、partial refresh
