# 0.7.0-beta.5

2026-09-22ユーザー依頼「これでpre-releaseして」に基づき、Grok CLI対応を含むベータ版を公開する。

## バージョンと範囲

最新stableはv0.5.0。そこからの全commitを確認し、Local AI・Graph・Computer Use・Grokなど
新機能を含む最大変更はMINOR。既に公開されている0.7.0ベータ系列のbaseは維持し、
最大のbeta.4に続く未使用番号beta.5を一度だけ採用する。以前の判断は
`tasks/prerelease-20260915.md` にも記録されており、0.6系列へ後退させない。

v0.7.0-beta.4以降の配布変更:

- #501: 不足しているOSの許可と設定導線の案内。
- #502: Windows Computer Use helperの同期pipeデッドロック修正。
- #503〜#505: 操作対象ツール、アプリごとの許可、会話内の承認カード（新flag配下）。
- #507: 公式Grok CLIの設定・モデル・Task/Team・管理ツール・停止制御、およびWindowsの
  `[stable]`付きversion表示の検出修正。

PR #507にversion更新も含める。埋め込みCLI client versionはdesktop package参照のため、
package.jsonとlockfileを揃える。リリースはmerge済みcommitへtagを付け、そのcommitから作る。

## 配布と検証

現行workflowのmacOS arm64正式署名・notarization、Windows x64 unsigned、Linux x64を維持する。
最新headのCIとReviewBOTを確認してmergeし、release workflowのDraft生成後に全asset、
version/tag/commit、更新manifest、macOS署名・notarization・cleanupを検証してpre-release公開する。
今回、正式版のLatestは更新しない。

## 既知の未確認事項

Windows実Grok受入は#506で継続。旧commitではG01のみPASS、G02検出不具合は修正済みだが
実機再試験とG03〜G17は未完了。今回の公開は評価用ベータであり、全実機受入完了とは扱わない。
Grokの画像添付・固有Effort選択は未対応。#506と既存Computer Useの実機gateはcloseしない。
