---
name: sprint-coder-e2e
description: macOS / LinuxでSprint CoderのUI・E2EをComputer Useで実操作し、証拠とPASS / FAIL / SKIP / BLOCKEDを記録する。動作確認・回帰確認・golden path確認に使う。
---

# Sprint CoderのComputer Use検証

UI・E2E・ユーザー操作は開発エージェントのComputer Useで実アプリを操作する。製品自身のComputer Use機能とは別であり、Playwrightのテストコードや実行手順を追加しない。単体・結合テストはVitestを使う。

正本は [Computer Use検証チェックリスト](../../../docs/testing/computer-use/README.md)。対象ケースの前提、操作、期待結果、対象OS、必要な証拠を読み、変更範囲に応じて選ぶ。全件が必要な場合は全ケースを列挙し、未実行分も記録する。

## 実行と判定

1. 対象checkoutのSHAと差分、build、起動process、所有するprofile・workspaceを記録する。開発者の既存アプリやdev serverは停止しない。
2. Node.js 22と依存関係を用意する。必要なら `npm run prepare:desktop --workspace @sprint-coder/desktop` でnative依存を準備し、`npm start` または対象OSのpackageを起動する。Node ABIとElectron ABIの不一致は環境障害として切り分ける。
3. 現在利用可能なComputer Useツールのドキュメントを読み、アプリ・windowとsource/buildの対応を確認する。ツールが使えない、対象windowを識別できない場合は `BLOCKED` にする。
4. Computer Useで実画面を操作する。shellは起動、fixture準備、ログ・ファイル照合に使用できる。DOM自動操作や内部IPCでUI操作を迂回しない。
5. 期待結果を画面と必要な実測証拠で照合する。性能の数値基準とaxe監査は専用計測・監査結果が必要であり、目視で代用しない。
6. 同じ所有profileで再起動するケースではprofileを作り直さない。異常を発見した場合は環境・成果物・操作ツールの障害と製品不具合を切り分け、必要なら初期状態を戻した別sessionで再現する。
7. 各ケースの `PASS` / `FAIL` / `SKIP` / `BLOCKED`、build、OS、前提、操作、期待値・実測、証拠の所在を記録する。CIやbuildの成功だけで画面検証をPASSにしない。
8. 自分のrunが所有するwindow・processだけを通常終了し、証拠を保持する。秘密やprompt・response全文を公開しない。

実Providerへの送信、実CLIの課金、Teamの実Worker検証は現在の依頼で明示されたときだけ行う。認証がない場合に勝手なログインやモデルdownloadを行わない。実Providerを使わないケースと混ぜて報告しない。
