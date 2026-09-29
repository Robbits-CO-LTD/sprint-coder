# 0.7.0-beta.13 公開候補

公開 beta.12 の実機受入（2026-09-29）で、Team 画面が isolation の状態変化を開き直すまで反映しない不具合（#635）が見つかった。修正（#637）は beta.12 公開後に main へ入った。公開物で確かめるため、beta.12 後の main を評価用ベータ候補に固定する。`0.7.0` の base は維持し、未使用の番号 beta.13 を一度だけ使う。

## beta.12 以降に含む変更

- Team の表示: #637（isolation の状態が変わったら Team 画面へ通知する。#635 の修正）、#634（残った worktree の一覧で Git のロックを示す）。
- Graph・Mission: #626（Worker の工程をまたいでも Mission のツール監査番号を保つ）、#629（Team を安全に停止したあと Mission を確定する）、#627（Managed Local の再開が隔離 root を再利用することのテスト）。
- Provider: #630（Codex の補助 MCP を管理された認可経由にする）。
- Computer Use: `491c8c8c`（#500。承認カードがキーボードフォーカスを奪わないようにする安全修正）。#632 はこのコードを戻そうとする PR だが、レビューの Critical 2件のとおり安全修正が消えるため、ユーザー判断（2026-09-29）でマージせず、この修正を含めて出す。#500 の S4〜S9 の実装は引き続き未承認。
- ビルド: #636（同梱と CI の Node を 22.23.3 へ。libuv は 1.51.0 のままで、#549 の修正は含まない）。
- 文書: #633（権限判定の上限の説明）。

変更の基点は公開 `v0.7.0-beta.12` のソース commit `8fe59c74e4d3369ee2394c9ed15891f44136ac7a`、候補の製品コードの基点は `main@44b38312d3b18bd41ff7343e1dbc1508175087e7`。この PR の変更は version のみで、`apps/desktop/package.json` と `package-lock.json` の desktop workspace の値を揃える。

## 配布と検証

beta.12 の手順を引き継ぐ。最新 head の必須 CI と独立レビューを確認してマージし、マージした commit に tag を付ける。release workflow の Draft で全 asset、version・tag・commit、更新 manifest、macOS の署名・notarization・cleanup を照合してから、pre-release（`--latest=false`）として公開する。正式版の Latest は更新しない。Windows 版は beta.12 と同じく未署名。

今回の version 更新や release workflow の成功を、各 Issue の実機受入 PASS とはみなさない。#635 は公開物の Team 画面を開いたまま、統合の順番待ちが自動で表示されることを確認してから close する。#549 は上流の Node 待ち。#500 と Computer Use の実機 gate も、この release では close しない。
