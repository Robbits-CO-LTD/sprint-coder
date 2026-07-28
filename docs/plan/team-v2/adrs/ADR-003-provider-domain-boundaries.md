# ADR-003: Provider domainと依存境界

- Status: Accepted
- Date: 2026-07-28
- Supersedes: `instructions/02-final-revision-v2.md` §2 P0の未決部分

## Decision

`Provider`、`ProviderConnection`、`Runtime`、`Model`を別identityとして扱う。

- Providerはprotocol／catalogの発行主体。
- Connectionは認証、base URL、account scope、verification、rate-limitを持つ実行設定。
- Runtimeは`builtin_cli | official_api | openai_compatible | mock`の実行方式。
- ModelはConnection配下のcatalog identity。requestedとresolvedを分離する。

Team Coreが参照できるProvider境界は`ProviderRuntime`と`ProviderRegistry` interfaceだけとする。
TeamCoordinatorからAdapter class、Provider SDK、Provider名分岐へのimportをAST/import graphで拒否する。
official APIとCLIは同じProvider名でも別Connection／Runtimeとし、Claude CLIをAnthropic API、
Codex CLIをOpenAI APIとして扱わない。

## Placement

- domain schema／canonical event: `packages/contracts`またはProvider-neutral package
- Registry、Connection repository、Secret Storage、network policy: Main
- wire Adapter／stream parser: Runtime Host配下
- TeamCoordinator: connection/model identityを渡すだけ
- Renderer: typed IPCのview modelだけ

## Evidence

- 現Runtime protocolはCLI固有helloを持つ: `runtime-host/protocol.ts:108-125`
- MainがClaude／Codexを直接分岐する: `main/ipc.ts:1490-1525`
- Runtime Hostは1 process 1 Adapter: `runtime-host/index.ts:13-37`
- Core identityのstable ID: `main/connection-identity.ts:7-45`

## Consequences

P1Bで既存CLIをProviderRuntime wrapperとしてRegistryへ登録する。Adapter追加のために
TeamCoordinatorを変更してはならない。`mock`はconformance test用で、GA Provider数に数えない。
