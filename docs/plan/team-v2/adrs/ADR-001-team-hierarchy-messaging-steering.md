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
- 永続化する`ManagerPolicy.maxDelegationDepth`はLeader=0とする絶対深度のまま維持する。
  一方、モデル向け`team_hire_worker`は`managerPolicy.maxDelegationLevels`を新Managerの下へ
  許可する相対段数として受け取り、Coordinatorが一度だけ絶対深度へ変換する。親Managerの
  絶対上限を超える変換はAgent作成前に拒否する
- Worker同士のdirect messageを許可し、全messageをpersist-before-dispatchで監査
- steerはProvider-native in-turn mutationへ依存しない
- queued steerはinstruction revision更新
- running steerはattemptを中断し、同じexecution・同じWorkerへ新attemptを作る
- Team全体のAI execution上限は8、総Agent数は固定しない

## Consequences

execution／attempt、parent relationship、message audit、restart recoveryがCore必須になる。
外部Provider固有機能へ依存せず既存CLIで成立させる。
