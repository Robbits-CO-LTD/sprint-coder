# 0.7.0-beta.14 公開候補

beta.13 の公開（2026-09-29）のあとに、6件の変更が main に入った。どれも Issue は OPEN のままで、配布物での実機受入を待っている。これらを公開物で確かめられるように、今の main を評価用のベータ候補に固定する。`0.7.0` の base は維持し、まだ使っていない番号 beta.14 を一度だけ使う。

## beta.13 以降に含む変更

- Team・Managed Local: #639（Managed Local の Worker が確定した書き込みを変更として記録する。#575）
- 削除の安全性:
  - #640（AI の一時フォルダを消すときにジャンクションの先をたどらない。#582）
  - #642（Worker の worktree を消すときに、Volume GUID 形式のジャンクションの先をたどらない。#641）
- 許可: #643（Project メモリの記憶と Skill 下書きの作成を専用の許可にし、毎回確認する。#546）
- Windows のファイル操作: #644（NativeSafeFs で既存ファイルの編集・削除・rename とフォルダの所有権を扱う。能力の申告を full にした。#559）
- Grok の診断:
  - #645（失敗原因の固定コードと `grokProtocol` 診断。#506 Slice A）
  - #646（実際の Grok CLI が送る update の種類を診断で見分ける。#506 Slice C）

変更の基点は、公開 `v0.7.0-beta.13` のソース commit `1f3b7e8c`。この PR で変えるのは version だけで、`apps/desktop/package.json` と `package-lock.json` の desktop workspace の値を揃える。

## 配布と検証

beta.13 の手順を引き継ぐ。

1. 最新 head の必須 CI とレビューを確認してから、この PR をマージする。
2. マージした commit に tag を付ける。
3. release workflow が作る Draft で、次を照合する。
   - 全 asset
   - version・tag・commit
   - 更新 manifest
   - macOS の署名・notarization・cleanup
4. 照合できたら、pre-release（`--latest=false`）として公開する。

正式版の Latest は更新しない。Windows 版は beta.13 と同じく未署名。

version の更新や release workflow の成功を、各 Issue の実機受入の PASS とはみなさない。公開物で確かめる予定のものは次のとおり。

- #575: 「単一作成 → 変更 activity → 報告」「作成成功後に条件未達 → 隔離／報告」「read-only → 変更なし」
- #582: Turn の終了・開始失敗・Stop のあとに一時フォルダが残らないこと、リンク先が消えないこと
- #641: Worker の worktree 内の Volume GUID 形式のジャンクションの先が残ること
- #546: Ask／Auto／Full で、Project メモリと Skill 下書きが承認カード → 効果の順に進むこと
- #559: 既存ファイルの編集・削除・rename、フォルダの作成、Stop と再起動のあとの整合性
- #578: 残った worktree の一覧で、Git にロックされたものは破棄できないと表示されること（#634 は beta.13 から入っている）

#506 は受入用の Issue なので、この release では close しない。#549 は上流の Node を待っている。#500 と Computer Use の実機 gate も、この release では close しない。
