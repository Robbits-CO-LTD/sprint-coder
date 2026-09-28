# Issue #500 実装ミッション（2026-09-29）

## 目的と受入条件

AI が実行中の一般アプリとウィンドウを native/Main の検証済み identity から一覧し、初回のアプリ許可後に対象へ操作できるようにする。macOS と Windows で、禁止クラスの除外、identity 変更時の再確認、既存の Stop・フォーカス・secure input・OS dialog・観測鮮度の拒否境界を保つ。旧 picker の終了は ADR v2 §10 の V1 終了条件がそろってから判断する。

## 現在地と依存

- S1〜S3b は merge 済み。S4 macOS、S5 Windows、S6 UWP、S7 ブラウザ、S8 旧 picker 撤去、S9 実機受入が残る。
- S4 の設計は ADR v2 に記録し、Grok Build（Grok 4.7）との相談と独立した設計レビューを反映した。
- PR #631 は S4 前の承認 UI 安全修正と ADR 決定だけ。V2 適格性は広げず、flag 既定 OFF を維持する。実機受入は未実施。
- #387 と親 #333 の受入条件、署名済み成果物、macOS/Windows 実機を最終照合する。

## 許可範囲と非対象

許可範囲は `apps/desktop/computer-use-native/**`、`apps/desktop/src/main/computer-use-*.ts`、`apps/desktop/src/main/ipc.ts`、`packages/contracts/src/index.ts`、Computer Use UI/フック、build/manifest/handshake、直接関連テスト・文書・CI。V2 新経路を開く PR には native/Main の deny と実行トリガ interlock を同時に含める。セッション内の画面内容を外側の会話へ返す T13 の新設計、S1〜S3b の再実装、未検証 UWP の許可は非対象。

## 原因・リスク・復旧

V1 は native allow-list と人が選ぶ picker を前提にしているため、AI が一般アプリを列挙して開始できない。V2 は任意のアプリと危険操作を対象へ広げるため、表示名・モデル出力・Renderer を権限根拠にせず、実行中プロセスの identity、面、操作を入力直前まで再検証する。分類不能・handshake 不一致・grant 不一致では拒否する。S4/S5 では V2 flag 既定 OFF、V1 経路を残す。失敗時は V2 を有効にせず、旧経路を使用する。

## 検証と終了地点

各スライスで関連する型・契約・native deny の正負・Main の grant/token/epoch・UI の拒否テストを実施し、独立レビューと最新 head CI を通す。高コスト E2E の前に同一ソース・成果物・実行プロセスを結ぶ preflight を確認する。macOS/Windows の実機で受入 journey を直接操作し、PASS/FAIL/SKIP を記録する。未実施は PASS とせず、#500 を OPEN に保つ。

添付: 0 件中 0 件を確認。Issue 本文・コメントと公開計画を live で確認した。
