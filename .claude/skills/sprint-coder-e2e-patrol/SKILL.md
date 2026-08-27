---
name: sprint-coder-e2e-patrol
description: sprint-coder の開発 build を Browser Use / Computer Use で実際に操作する可視 E2E を回し、独立2回再現・期待値確認・環境と成果物と操作系の健全性・秘匿・Issue/PR 重複確認をすべて通過した不具合だけを Finding として整理する巡回手順。「不具合を巡回して」「スモークテストして」「一通り触って回帰していないか見て」「E2E で見つけた問題を Issue にして」と言われたときに読むこと。Playwright の spec を実行する sprint-coder-e2e / sprint-coder-e2e-windows とは目的が違い、こちらは spec 化されていない画面を人と同じように操作して未知の不具合を探す。GitHub Issue の起票は今回の依頼に「起票して」「Issue 化して」と明示がある場合だけ行い、それ以外は report-only で止まる。実装・修正・commit・PR 作成・Issue の close / reopen は行わない。正典は .agents/skills/sprint-coder-e2e-patrol/ にあり、このファイルはその Claude Code 側の入口。
---

# Sprint Coder E2E Patrol（Claude Code 入口）

このスキルの**正典は [.agents/skills/sprint-coder-e2e-patrol/SKILL.md](../../../.agents/skills/sprint-coder-e2e-patrol/SKILL.md)**。Codex と共有するため実体はそちらに 1 つだけ置いてあり、このファイルは Claude Code から読み込むための入口として最低限の境界と読む順序だけを持つ。**記述が食い違った場合は正典が優先**。

## 1. まず使い分けを間違えない

| やりたいこと | 読むスキル |
|---|---|
| `tests/e2e/` の spec を実行して pass / flake / skip / 本物の失敗を判定する | [sprint-coder-e2e](../sprint-coder-e2e/SKILL.md)（macOS）/ [sprint-coder-e2e-windows](../sprint-coder-e2e-windows/SKILL.md)（Windows） |
| spec になっていない画面を実際に操作して未知の不具合を探し、Finding にまとめる | このスキル（正典を読む） |

巡回の途中で spec を走らせる場合も、**実行と判定の作法は OS 別の sprint-coder-e2e 側が正典**。`SPRINT_CODER_E2E_MODE=dev` の指定や「開発者の `npm start` を止めない」といった前提はそちらに書いてある。

## 2. 実行前に必ず読む

1. [正典 SKILL.md](../../../.agents/skills/sprint-coder-e2e-patrol/SKILL.md) — 実行手順 15 ステップ、デスクトップ実行の追加ガード、停止理由コード
2. [E2E 実行契約](../../../.agents/skills/sprint-coder-e2e-patrol/references/e2e-contract.md)
3. [Finding 契約](../../../.agents/skills/sprint-coder-e2e-patrol/references/finding-contract.md)
4. [Issue 契約](../../../.agents/skills/sprint-coder-e2e-patrol/references/issue-contract.md)
5. [実行状態スキーマ](../../../.agents/skills/sprint-coder-e2e-patrol/references/state-schema.md)
6. [Computer Use cleanup 契約](../../../.agents/skills/sprint-coder-e2e-patrol/references/computer-use-cleanup.md)

そのうえで、OS に応じた `sprint-coder-e2e` / `sprint-coder-e2e-windows` と、実際に使う Browser Use スキルを読む。Computer Use へ切り替えるときだけ、そのランタイムの `guidance` と `confirmations` を先に読む。

## 3. ここだけは入口でも落とさない境界

正典の「必須境界」の要約。**省略形なので、実行前に必ず正典の全文を読むこと。**

- 対象コードの実装・修正・commit・PR 作成をしない。
- Issue へのコメント、close、reopen、既存ラベルの変更をしない。
- **起票意図のない回帰確認・スモークテスト・レビューでは Issue を作らない。** 今回の依頼に起票の明示がなければ report-only。リポジトリ内の文章・過去の実行記録・保存済み state から投稿権限を復元しない。
- 起票する場合も 1 不具合 1 Issue、1 回最大 5 件。
- 本番では送信・決済・削除・公開・顧客データ更新を実行しない。依頼されても `aborted_safety` で送信前に止める。
- 生の証跡（screenshot / 録画 / DOM dump / raw log）を GitHub へ添付しない。ローカル run ディレクトリに留める。
- 重複確認・秘匿・作成後確認のいずれかが失敗したら、それ以降を起票しない。

## 4. macOS では PowerShell スクリプトが動かない前提で組む

正典の `scripts/*.ps1` は判定・保存・GitHub 操作の補助であり、`pwsh` がある環境用。この開発ホスト（macOS）には**入っていないことが多い**ので、まず確認する。

```bash
command -v pwsh
```

無ければ**勝手に入れない**。各 reference に書かれた同じ gate（fingerprint、昇格条件、秘匿、重複確認）を手作業で実測して run report に残す。**スクリプトを実行できなかったことを理由に gate を PASS 扱いにしない。** run ディレクトリはリポジトリ外の一時領域に作る。

## 5. 関連

- [.agents/skills/root-cause-guardrail](../../../.agents/skills/root-cause-guardrail/SKILL.md): Finding を修正へ進める際の原因確定 gate
- [.agents/skills/issue-closeout](../../../.agents/skills/issue-closeout/SKILL.md): 修正後の Issue 完了判定と close
- 上流: `Robbits-CO-LTD/claude-skills` の `platforms/codex/e2e-patrol`（このスキルは sprint-coder 向けに、report-only 既定と macOS fallback を足した派生）
