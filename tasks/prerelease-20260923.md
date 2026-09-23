# 0.7.0-beta.7

2026-09-23ユーザー依頼「インストーラー公開版して。次のbeta版」に基づき、beta.6公開後にmainへ入った
Grok修正を評価用ベータとして公開する。base 0.7.0は維持し、未使用番号beta.7を一度だけ採用する。

v0.7.0-beta.6以降の配布変更:

- #510: Grok Buildの応答中断とWorkspaceツール拒否を修正。(1) MCP利用中に混在する文字列JSON-RPC
  応答IDでACPストリームを中断していた不具合、(2) 裸の`Read` denyがpathlessの`search_tool`まで
  拒否していた隔離設定、(3) 並行ツールの先行承認で`waiting_approval`になると後続の承認要求を
  拒否していた永続層、の3点。

version更新はこのPRのみ（`apps/desktop/package.json`とlockfile）。配布・検証の方針は
`tasks/prerelease-20260922.md` のbeta.5の記載を引き継ぐ。

## 既知の未確認事項

#506の実機受入は継続中。実アプリでのテスト実行command承認の再試験と、G01〜G17受入表全体の
再実施は未完了。Grokの画像添付・固有Effort選択は未対応。#506とComputer Useの実機gateはcloseしない。

# 0.7.0-beta.8

2026-09-23ユーザー依頼「Grok関連issueをすべて消化してマージして次のバージョンのプレリリースして」に基づき、
beta.7公開後にmainへ入ったGrok関連の修正を評価用ベータとして公開する。base 0.7.0は維持し、未使用番号beta.8を一度だけ採用する。

v0.7.0-beta.7以降の配布変更:

- #518 (#515): Grokで選んだモデルが実行に反映されず常に既定のgrok-4.7で推論されていた。session/new後に
  ACPのsession/set_modelで束縛し、要求と実行モデルの不一致を成功扱いしない。
- #519 (#517): 見つかっているCLIの状態を確認できないとき、設定とComposerが「CLIが見つかりません」と誤案内していた。
- #520 (#512 / #513): Grok Buildの残高切れ(HTTP 402)を「接続を確認できませんでした」と誤表示していた。
  公開エラーRUNTIME_BILLING_REQUIRED、Grok専用の診断段階billing_error / rate_limitとhttpStatusを追加し、
  DB migration v95で保存できるようにした。
- #521 (#516): Grok Workerの成果が統合済みでもLeaderのTurnが「変更後のファイルを検証できなかった」で失敗していた。
- #523 (#514): Windowsサンドボックス内でWorkspace内のrequire/importがEPERMで失敗していた。
  サンドボックス経由の起動だけNodeへ`--preserve-symlinks`を与え、サンドボックス外のモジュール解決は変えない。

version更新はこのPRのみ（`apps/desktop/package.json`とlockfile）。配布・検証の方針は
`tasks/prerelease-20260922.md` のbeta.5の記載を引き継ぐ。

## 既知の未確認事項

- 各修正のpackaged実機確認はこのプレリリースの公開物で行う（#506の受入継続）。
- #512 / #513 の残高切れ402は、残高を故意に消費しないと実機で再現できないため、実機では未確認。
- 既定の`node --test`がWindowsサンドボックス内で終わらない件は別原因で#522（未修正）。
- #506とComputer Useの実機gateはcloseしない。
