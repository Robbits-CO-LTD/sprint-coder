# Provider Rollout

## P0 — Current-state and ADR

コードを変更しない。Claude／Codex Runtime、model保存、Picker、Team selection、Secret Storage、
usage、rate limit、TeamCoordinator、実並列、migration、process境界、packaged解決、test fixtureを
調査する。成果はcurrent-state更新、ADR、P1A/P1B contractである。

## P1A — Connection domain and legacy migration

- ProviderConnection、Runtime Kind、Connection ID
- requested／resolved provider/model
- built-in IDへのbackfill
- dual-read／compatibility facade
- migration fixtureと再起動復元

実Provider API、Secret Storage、外部通信、API Schedulerは追加しない。Coreの8並列をschema変更で
低下させない。

## P1B — Common Provider foundation

- Registry、Runtime interface、Mock Provider
- canonical event、error／usage normalization
- capability schema、verification
- Secret Storage、secure logger
- Provider Profile schema
- Team 8枠とConnection limitを統合する二段階Scheduler

real ProviderはMockとbuilt-in CLIによるcontract証明に必要な範囲へ限定する。

## P2 — OpenAI API

共通基盤のreference implementation。auth、model discovery、Chat、Streaming、Tool Calling、
Structured Output、cancel、usage、resolved model、error normalization、Chat／Teamを実装する。

## P3 — OpenRouter API

OpenAI直後に実装する。Gatewayとupstream provider、requested／resolved model、routing、pricing、
Tool Calling、Streaming、大量catalog検索、公式APIとの履歴区別を扱う。返却されないupstream情報は
unknownとする。

## P4 — Anthropic API

Anthropic専用AdapterとClaude CLIを別Connectionとして扱う。Streaming、Tool Calling、usage、
cancel、discoveryまたはcurated catalog、Team executionを実装する。

## P5 — Google Gemini API

固有auth／request、Streaming、Tool Calling、Structured Output、multimodal capability、usage、
cancel、model discoveryを実装する。

## P6 — xAI API

OpenAI互換部分は共通部品を使うが、Grok catalog、capability、error、usage差分を独立Sliceで
検証する。

## Provider Slice exit report

各Sliceは次を報告する。

- 完了／部分完了／未着手
- 変更した境界とschema
- 満たした／未達の受入条件
- 実行したtestと結果
- fixture／conformance／実API smokeの区別
- resolved model、usage、error、secret leak検査
- blockerとrollback方法
