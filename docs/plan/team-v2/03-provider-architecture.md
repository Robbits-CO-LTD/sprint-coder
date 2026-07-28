# Provider Architecture

## Responsibility

```text
TeamCoordinator
  → ProviderRuntime interface
  → ProviderRegistry interface
      → built-in CLI runtime
      → official API adapter
      → OpenAI-compatible profile runtime
```

Team CoreはAdapter class、Provider SDK、Provider名による分岐へ依存しない。

## Domain

### Provider

API protocolとcatalogの発行主体を表す。表示名と実行Connectionを混同しない。

### ProviderConnection

ユーザーが実行に使う設定単位。最低限、connection ID、provider ID、runtime kind、表示名、
verification state、rate limit、secret referenceを持つ。

### Runtime

- `builtin_cli`: 既存Claude／Codex CLI。外部API rate admission対象外。
- `official_api`: Provider固有の公式API Adapter。
- `openai_compatible`: Provider Profileで駆動する共通Runtime。
- `mock`: test専用。GA Provider数へ含めない。

### Model

catalog identityとexecution resolutionを分離する。requested provider/modelはユーザーまたはLeaderの
選択、resolved provider/modelは実Runtimeの応答である。Runtimeが返さないresolved値はunknownの
まま保存し、推測しない。

## Interfaces

- `ProviderRegistry`: Connection登録、Runtime解決、Catalog統合、verification routing。
- `ProviderRuntime`: verify、listModels、start、cancel。raw Provider eventを外へ返さない。
- `CanonicalProviderEvent`: output、tool call、usage、resolution、rate limit、completed、error。
- `NormalizedUsage`: input/output/cache/reasoning token、provider cost情報、source。
- `NormalizedProviderError`: credentials、not_found、rate_limited、timeout、network、canceled、
  invalid_request、provider_unavailable。
- `ProviderProfile`: base URL、auth header、catalog strategy、capability/error override、
  curated rate-limit default。

## OpenAI-compatible profiles

generic RuntimeへProvider名の条件分岐を追加しない。差分はschema検証されたProfileで表す。
conformance失敗時は次の順で処理し、ADRへ記録する。

1. Profile設定で解決
2. 複数Providerに有効な小さなprotocol extensionを共通基盤へ追加
3. 専用Adapter候補として将来Sliceへ分離
4. 対応を保留して理由を記録

## P0 ADR topics

- Provider／Connection／Runtime／Model責務
- official APIとbuilt-in CLIの区別
- built-in CLIのrate admission除外
- Profile Engine
- Capability Catalogの情報源
- Team 8並列とConnection limitsの統合
- fairness
- Picker移行
- legacy migration
- Core connection ID先行導入の実績
- Provider固有コードの依存方向

詳細な調査項目と判断証拠は[ADR backlog](adrs/ADR-P0-BACKLOG.md)を正本とする。
