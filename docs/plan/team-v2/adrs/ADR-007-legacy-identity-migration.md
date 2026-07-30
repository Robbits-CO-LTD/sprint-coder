# ADR-007: legacy identity migration

- Status: Accepted
- Date: 2026-07-28
- Confirms: [ADR-002](ADR-002-core-connection-identity.md)
- Supersedes: `instructions/02-final-revision-v2.md` §8の未決移行方式

## Decision

Coreでconnection identity列を先行導入した判断を維持する。P1Aは新しい列追加ではなく、pre-v35
rowのbackfill、Connection正本への参照、dual-read、migration fixtureへ集中する。

- Claude legacy runtime → `builtin:claude-cli`
- Codex legacy runtime → `builtin:codex-cli`
- unknown文字列 → raw legacy値を保持したunknown legacy runtime
- `runtime_kind`／`model`はP1Aで削除しない
- 新identityを解決できなくても履歴表示、pagination、restartを壊さない

migrationは既存frameworkのchecksum、transaction、pre-migration backup、foreign-key checkを
利用し、外部API／API keyを必要としない。二重実行はschema migration記録とbackfill predicateの
両方でidempotentにする。

## Required fixtures

初期version、Team導入前、現production、Claudeのみ、Codexのみ、混在、running attempt、
interrupted attempt、不明legacy modelを独立DB fixtureとして追加する。v1コード内fixtureだけを
全要件の代用にしない。

## Evidence

- v35／v36はidentity列を追加するが既存rowを更新しない: `persistence.ts:1810-1836`
- 新規Task／Turnはidentityを保存する: `persistence.ts:3182-3254,8294-8355`
- stable built-in mapping: `connection-identity.ts:7-45`
- migration safety: `persistence.ts:2872-3003`
