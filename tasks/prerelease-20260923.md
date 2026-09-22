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
