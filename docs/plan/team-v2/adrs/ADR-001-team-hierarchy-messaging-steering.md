# ADR-001: Team hierarchy, messaging and steering

- Status: Accepted
- Date: 2026-07-28
- Supersedes: `docs/PRODUCT_AND_TECHNICAL_DESIGN.md` ADR-005のWorker間直接通信禁止、
  旧max depth 1、旧3 Worker上限

## Context

現行TeamはLeader↔Workerだけを許可し、全Workerをleafとして固定する。ユーザー要件は会社型の
Leader→Manager→Worker委譲、Worker間連携、実行中の指示修正である。

## Decision

- hierarchyはLeader depth 0、最大Agent depth 4
- Team Policyで`canDelegate`を与えられたManagerだけが子を雇用
- Worker同士のdirect messageを許可し、全messageをpersist-before-dispatchで監査
- steerはProvider-native in-turn mutationへ依存しない
- queued steerはinstruction revision更新
- running steerはattemptを中断し、同じexecution・同じWorkerへ新attemptを作る
- Team全体のAI execution上限は8、総Agent数は固定しない

## Consequences

execution／attempt、parent relationship、message audit、restart recoveryがCore必須になる。
外部Provider固有機能へ依存せず既存CLIで成立させる。
