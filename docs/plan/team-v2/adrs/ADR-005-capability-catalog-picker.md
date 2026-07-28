# ADR-005: Capability CatalogとModel Picker境界

- Status: Accepted
- Date: 2026-07-28
- Supersedes: `instructions/02-final-revision-v2.md` §3、§5の未決設計

## Decision

catalog identityの必須値はConnection ID、Provider ID、Model ID、display name、availability、
availability observedAtとする。任意値は次のsourceを必ず持つ。

```ts
type CapabilitySource = "provider_api" | "official_curated" | "unknown";
type CatalogValue<T> = {
  value: T | null;
  source: CapabilitySource;
  sourceReference?: string;
  observedAt?: string;
};
```

速度、品質、コーディング／推論適性、コスト傾向は推測せず既定`unknown`とする。unknownはvalidで、
UIは0／false／空欄へ変換せず「不明」と表示する。official curated値はsource reference、
version、reviewedAt、reviewedBy、価格effective dateを持つ。

PickerはMainのcatalog query interfaceだけへ依存する。Rendererへ全catalogを渡さず、検索、
filter、group、pagination済みview modelを返す。検索indexはcatalog revision更新時に一度だけ構築する。
U1から仮想化を有効にし、1000件以上の合成fixtureを使う。

## Migration

`multiProviderModelPickerV2=OFF`は既存Picker、ONは新Picker。同じcanonical Task selection repositoryを
読む。U2まで並走、U3で既定ON、U4は独立cleanup PRとする。

## Evidence

- 現contractはmodel最大32件: `packages/contracts/src/index.ts:1257`
- 現Pickerは同期`runtime.models.map`: `Composer.tsx:438-515`
- OpenRouter Models APIは400+ modelとserver-side search／filter／sortを公開している。
- OpenAIのModels APIはidentity／availability中心で、能力の完全なcatalogではない。
- GeminiとxAIは認証済みmodel discovery APIを持つ。

## Rejected

- model名やProvider名から能力を推測する
- Rendererで1000件をfilter／sortする
- CLI固有stateを新Pickerから直接読む
