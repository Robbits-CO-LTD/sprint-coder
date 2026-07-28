# ADR-002: Core-first connection identity

- Status: Accepted
- Date: 2026-07-28
- Reviewed again in: Provider P0

## Context

現行DBはTurnへ`runtime_kind`と`model`、AgentThreadへ`runtime_kind`を保存する。Provider P1Aまで
identity追加を遅らせると、Core期間に作られるTeam v2 execution／attempt／Agentをすべて
backfillする必要がある。一方、Coreへ外部API基盤を持ち込むとMilestone Aが膨張する。

## Decision

Coreで次のidentityをadditiveかつnullableに先行導入する。

- connection ID
- requested provider／model
- resolved provider／model

既存CLIには`builtin:claude-cli`と`builtin:codex-cli`を割り当てる。Coreで作る新規CLIデータは
connection ID付きで保存する。

CoreではProvider Adapter、Registry実装、Secret Storage、外部API通信、API rate-limit
Schedulerを実装しない。旧`runtime_kind`と`model`は保持し、dual-readの削除は後続cleanupとする。

## Evidence

現行migration runnerはchecksum、transaction、backup、idempotentなversion管理を持つ。
P1Aでproduction v34を含むfixtureによりbackfill量と互換性を再検証し、問題があればこのADRを
明示的にsupersedeする。
