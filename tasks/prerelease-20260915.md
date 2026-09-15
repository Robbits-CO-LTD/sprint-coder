# 2026-09-15 pre-release修正・検証

ユーザー依頼: この会話の残件をすべて修正した後、新しいpre-releaseを公開する。merge・tag・公開まで許可済み。

## 対象

- Windowsのlibuv終了クラッシュ: Electron 43.2.0から既知修正を含む43.5.0へ。実機では旧新版ともGraph Mission 45件×10回、最小終了シナリオ100回が通ったため、CIクラッシュと上流修正の同一原因は断定しない。CIで再検証。
- Electron 43.5.0用に旧better-sqlite3 12.11.1を再buildすると、StatementのGCで`RemoveEnvironmentCleanupHook: env != nullptr`がローカル・macOS/Linux CIで再現。N-API化とworker終了修正を含む13.0.3を採用し、同じDB試験・package起動で解消を検証する。出典: WiseLibs/better-sqlite3 v13.0.0、v13.0.2、v13.0.3 release。
- mainのmacOS Archify packaged CI: ノード選択後のclear操作が詳細表示を閉じない失敗を再現・修正。
- Windowsのgraph-propose後の失敗: pinned CLIのprocess.exitがpipeを切り詰める経路と、親が出力受信前にexitだけで結果を返す経路を回帰試験で再現。実Electron UtilityProcessではpipe EOFが通知されないことを実測したため、workerの出力drain後に上限付きIPC resultを送り、MainのACK後にexitする方式へ変更。Mainはschema・byte上限と一致する正常終了を検証し、非zero・signal exit・cancel・timeoutを拒否する。
- PR #471の保留Warning: Turn跨ぎ/同Workspaceのbackground command、Saga commit順の検証、Windowsのnative post-image観測。

関係のない新機能や既存Issue全件の再実装は対象外。未到達の署名済みComputer Use等の別gateは成功扱いしない。

## リリース

既存の公開0.7.0 beta系列を継続し、次の未使用beta番号を公開直前にも再確認する（開始時最大beta.2、予定0.7.0-beta.3）。新機能は追加せず、baseを新たに上げない。最新stable v0.5.0以降の最大変更はMINORだが、既に公開された0.7系列を後退させない。macOS正式署名・notarization、Windows現行unsigned方針、Linux配布を維持する。

## 検証と完了条件

1. 原因に対応した回帰testと対象typecheck/lint。
2. macOS packaged ArchifyおよびWindows native/実AI操作。
3. 最新PR headの全必須CIとReviewBOT。指摘対応後に再確認。
4. merge commitとversion/tag一致、release workflowで署名・notarization・asset/checksum/更新feed検証。
5. GitHubで新pre-releaseの公開状態を再取得する。

基準source: 5a0be9be7b9957e0515bcdb0fb72f6822458bf14。
前回Windows証拠: /Users/yusei/sc-windows-validation-20260914.3lWrc6/report.md。
今回のローカル証拠: /Users/yusei/sc-prerelease-20260915.TCAXtH/。
