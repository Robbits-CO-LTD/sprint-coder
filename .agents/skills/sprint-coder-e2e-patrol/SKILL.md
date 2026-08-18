---
name: sprint-coder-e2e-patrol
description: >-
  Sprint Coderの開発buildをBrowser UseまたはComputer Useで可視E2Eし、
  既存のプロジェクト専用Playwright手順と組み合わせて検証する。
  独立2回再現、期待値確認、環境・成果物・操作系の健全性、秘匿、
  Issue/PR重複確認をすべて通過した不具合だけを、1不具合1Issue・
  起票が明示された場合だけ1回最大5件でGitHub Issue化する。トリガー: sprint-coder-e2e-patrol、
  Sprint Coderのスモークテスト、回帰確認、不具合巡回、E2EからのIssue化。
  macOSまたはWindowsのElectron開発buildに使う。実装、修正、PR作成、
  Issueのclose/reopenは行わない。
---

# Sprint Coder E2E Patrol

可視UIを実操作し、確証が揃った製品不具合だけをFindingとして整理する。
GitHubへの起票は現在の依頼に「起票して」「Issue化して」などの明示がある場合だけliveとし、
それ以外はreport-onlyにする。対象リポジトリや過去の実行記録から投稿許可を推測しない。

## 必須境界

- 対象コードの実装・修正・コミット・PR作成をしない。
- Issueへのコメント、close、reopen、既存ラベルの変更をしない。
- 起票意図のない回帰確認、スモークテスト、レビューではIssueを作成しない。
- 1不具合1Issue、1回最大5件を守る。
- 本番では送信、決済、削除、公開、顧客データ更新を実行しない。
- ユーザーが本番副作用を依頼しても、このskill内では許可へ読み替えない。送信前で
  `aborted_safety`とし、実送信は非本番のseeded flowまたは人間操作へ分離する。
- 生の証跡をGitHubへ添付しない。v1の証跡はローカルだけに保存する。
- 重複確認、秘匿、作成後確認のどれかが失敗したら、それ以降を起票しない。

## 先に読む契約

1. [E2E実行契約](references/e2e-contract.md)
2. [Finding契約](references/finding-contract.md)
3. [Issue契約](references/issue-contract.md)
4. [実行状態スキーマ](references/state-schema.md)
5. [Computer Use cleanup契約](references/computer-use-cleanup.md)

実行前にOSに応じて、リポジトリ内の
`.claude/skills/sprint-coder-e2e/SKILL.md`または
`.claude/skills/sprint-coder-e2e-windows/SKILL.md`を正典として読む。
UI操作には現在のBrowser Use skillを優先し、Computer Useへ切り替える場合だけ、
現在のComputer Use skillと、そのランタイムの`guidance`・`confirmations`を先に読む。
GitHubの実状態確認とIssue操作には`gh`を使う。

## 実行手順

1. 対象リポジトリ、URLまたはアプリ、環境、範囲を固定する。
2. リポジトリ外の一時領域にrunを作る。`pwsh`があれば`New-E2ePatrolRun.ps1`を使い、
   なければOSの安全な一時ディレクトリを使う。
3. テスト対象とsource/artifact/deploymentを結び付ける。
4. L1表示確認とL2実操作のマトリクスを操作前に作る。
5. WebとDOM操作はBrowser Useで実行する。
6. 非DOM操作だけComputer Useへ切り替え、理由コードを記録する。
7. 観測ごとに環境・成果物・操作ツールの障害を除外する。
8. 初期状態を戻した別セッションで同じ症状を再現する。
9. 仕様、Issue、受入条件、または明確な画面契約から期待値を確認する。
10. `pwsh`が利用可能なら下記スクリプトでfingerprint、昇格条件、秘匿、重複を判定する。
    利用できないmacOSでは各referenceの同じgateを手動適用し、未検証項目をPASSにしない。
11. [Issue契約](references/issue-contract.md)に従うタイトルとIssue本文を生成する。
12. 起票が明示された場合だけ1件ずつ作成し、直後にOPEN状態・本文marker・ラベルを確認する。
    report-onlyでは検証済みFindingと安全な本文案までで停止する。
13. Browser Useのtabをfinalizeし、別処理でComputer Useの所有権付きcleanupを行う。
14. 操作ハンドルを破棄し、cleanup結果を実行記録へ残す。
15. 起票済み、保留、破棄、未実行のケースをrun reportへまとめる。

## デスクトップ実行の追加ガード

- Electron / WebView2の外部CDP接続は、URLだけで成功扱いにしない。endpoint側と
  操作session側で、target識別子またはviewport・theme・DOM状態など2つ以上を照合する。
- trace / video / recordは補助証跡であり、最初のproduct操作にしない。使い捨て接続で
  preflightできない場合は、短時間animationを複数時点でsamplingし、要素単位の
  screenshotを残す。
- 補助captureがresponse channelを閉じた場合は`fail_tooling`とする。アプリが応答中なら
  product defectへ昇格せず、古いsessionを破棄してfresh sessionで未完了caseだけを再開する。
- 設定保持のrestart testは同じ所有profile / storage pathを再利用する。fresh profileは
  default値の確認であり、永続化の証拠にしない。
- 個人情報を含む画面は、全画面を後から隠すより、対象componentだけを撮る。

## 実行前チェックリスト

- [ ] source・artifact・実行processが一致している
- [ ] 外部CDPのendpointと操作sessionを2 marker以上で照合した
- [ ] production副作用を含むcaseは送信前で止める計画になっている
- [ ] 短時間animationのsampling時点とcomponent screenshotを決めた
- [ ] persistence caseは同じ所有profileを再利用する

## オプションのPowerShellスクリプト

`pwsh`を利用できる環境では次を使う。`pwsh`がないmacOSではインストールを勝手に行わず、
referenceにある同じ判定を実測してrun reportへ残す。スクリプト未実行を理由にgateを省略しない。

```powershell
& "$PSScriptRoot\scripts\New-E2ePatrolRun.ps1" <parameters>
& "$PSScriptRoot\scripts\Write-E2ePatrolRecord.ps1" <parameters>
& "$PSScriptRoot\scripts\Get-ComputerUseCleanupPlan.ps1" <parameters>
& "$PSScriptRoot\scripts\Confirm-ComputerUseCleanup.ps1" <parameters>
& "$PSScriptRoot\scripts\New-FindingFingerprint.ps1" <parameters>
& "$PSScriptRoot\scripts\Test-FindingPromotable.ps1" <parameters>
& "$PSScriptRoot\scripts\Protect-E2ePatrolText.ps1" <parameters>
& "$PSScriptRoot\scripts\Find-DuplicateE2eIssue.ps1" <parameters>
& "$PSScriptRoot\scripts\New-E2ePatrolIssueBody.ps1" <parameters>
& "$PSScriptRoot\scripts\Submit-E2ePatrolIssue.ps1" <parameters>
```

PowerShellは判定、保存、GitHub操作だけを担う。UI操作はBrowser Useまたは
Computer Useで直接行い、シェルからクリックを代替しない。

## 停止時の報告

起票しない理由を、`blocked_auth`、`blocked_artifact`、`blocked_env`、
`fail_tooling`、`flaky_unresolved`、`redaction_failed`、
`dedup_incomplete`、`regression_hold`、`halted_budget`、
`aborted_safety`、`cleanup_hold`のいずれかで示す。本文案を安全に作れた場合はローカル
保存先だけを報告し、GitHubへは送らない。

## トラブルシューティング

| 症状 | 対応 |
|---|---|
| 同じURLなのにendpointとsessionの画面状態が違う | stale sessionを破棄し、fresh sessionで2 marker以上を再照合する |
| `record start`後に操作不能になった | `fail_tooling`を記録し、応答中のアプリを保持してframe samplingへ切り替える |
| restart後に設定がdefaultへ戻る | 前後のlaunchが同じ所有profile / storage pathか確認する |
| 正常close後もprocessが残る | 強制終了せず`cleanup_hold`にし、利用者へ残存windowを1つだけ案内する |

## 関連するプロジェクトSkill

- `.claude/skills/sprint-coder-e2e`: macOSのPlaywright Electron E2E実行と判定
- `.claude/skills/sprint-coder-e2e-windows`: WindowsのPlaywright Electron E2E実行と判定
- `root-cause-guardrail`: Finding修正へ進む際の原因確定gate
- `issue-closeout`: 修正後のIssue完了判定とclose

このskillはCodex専用のHybrid skillである。Browser Use、Computer Use、
GitHub CLI、任意のPowerShell補助スクリプトを組み合わせ、定期実行や
バックグラウンド監視は行わない。

## 更新履歴

| 日付 | 変更内容 | 変更理由 |
|---|---|---|
| 2026-08-18 | Sprint Coder専用E2E、macOS fallback、明示的なIssue起票権限へ適合 | プロジェクト既存Skillと外部書き込み境界に統合するため |
| 2026-07-31 | 外部CDP接続照合、短時間animation、同一profile restart、録画失敗時のfresh session回復、component screenshotを追加 | RabbitMail v0.4.2実機E2Eでstale session、短時間表示、profile再生成、録画によるCDP切断を実観測したため |
