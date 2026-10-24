# WindowsのComputer Use検証

WindowsのUI・E2Eは、開発エージェントがComputer Useで実アプリを操作して確認します。[検証チェックリスト](testing/computer-use/README.md)がケースの正本です。Sprint Coder自身のComputer Use機能とは区別します。

## 対象と準備

セットアップ、Composer / IME / keyboard、設定、Project / file、承認、Team / Graph、window focusと再起動復元から変更に関係するケースを選びます。macOS専用ケースはWindowsの対象外です。実Provider、実CLIへの課金を伴う送信は現在の依頼で明示された場合だけ実施します。

Node.js 22、Python 3、Visual Studio Build Toolsを用意し、PowerShellで `npm ci` と `npm run prepare:desktop --workspace @sprint-coder/desktop` を実行してから `npm start` で開発buildを起動します。installerを検証する場合はInno Setupも用意し、対象buildのinstallerを使います。既存の開発者のprocessやprofileは保持し、run所有のprofileとworkspaceを使います。

## 実施と証拠

- source SHA / 差分、build、OS、process、所有profileを記録し、対象windowがそのbuildであることを照合します。
- Computer Useでチェックリストの操作を行い、実画面と期待結果を確認します。shellは起動、fixture準備、ログ・ファイル照合に使えます。
- 各ケースの `PASS` / `FAIL` / `SKIP` / `BLOCKED` と証拠を記録します。Computer Useを利用できない場合は `BLOCKED` です。失敗を環境、成果物、操作ツール、製品のどこで起きたか切り分けます。
- 起動しない場合は起動ログ、Main / Preloadのbuild、renderer配信、native ABIを確認します。停止処理は自分のrunが起動したprocessだけに限定します。
- Windows CIの型・単体・native・package / installer検証と、Computer Useの画面検証は別の証拠です。CI成功をUIのPASSに読み替えません。性能の数値基準やaxe監査にも別途計測・監査結果が必要です。

詳細な操作規約は [Windows用Skill](../.claude/skills/sprint-coder-e2e-windows/SKILL.md)を参照してください。
