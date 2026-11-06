# 非Computer Use修正の統合

元の全変更は `codex/non-cu-complete-snapshot-20261106` (`f6a8b1a1`) に保持する。
追加レビューのファイル数上限を超えたため、確認条件を変えず3本を順次mergeする。

1. PR #1158: 画像添付の状態競合（#1157）、取消試験のwatchdog競合（#1137）、mergeを止めたWindows native試験の参照競合。
2. ProjectのAPFS永続識別・再リンク・既存参照保持。元snapshotの13ファイルをそのまま移植し、既存native/SQLite/UI試験を照合する。
3. Graph診断のworker/IPC/API Provider経路。元snapshotの10ファイルを移植し、元のUI・応答順制御記録を含む全体記録を統合する。

## PR #1158の原因と検証

- 添付: accepted eventと、未購読時のstart応答、snapshot後の再読込みを使って古い一覧を再照合。実Zustandの遅延PromiseでRED→GREEN。隔離Electronでもcapabilityを4500ms遅延し、その途中の画像送信と、後着後draft0件・次の送信成功を確認済み。
- 取消試験: UI threadを8100ms停止すると、8秒watchdogのapp.exitが親を破棄し、後のsheet完了が失敗報告を成功で上書きする。fixture内watchdogだけを除去すると同一入力で親が生存。外部execFile15秒期限と親生存assertは保持。通常3条件＋停止条件が成功。過去CIへの同一原因の帰属は推論。
- Windows CI: [失敗job](https://github.com/Robbits-CO-LTD/sprint-coder/actions/runs/42214428291/job/127881434246)はdeadline query終了後のStop receiptで参照数を検査して失敗した。query workerは返答前に終了するためSlotのglobal flag更新順は原因ではない。Stop要求自身のadministrative leaseが、返答公開後まで残ることを独立したコードレビューで確認（RCA: A/B/D=YES）。
- 修正: fresh Stopとcached応答のadministrative leaseを公開前に解放する。測定のlease、他ownerの処理、停止期限、drained/残処理の判定は緩めない。
- Windows回帰試験: 成功したWriteFrameの直後でserverを止め、clientがserverのreturn前に参照数を検査する。新規とreplayの両応答を確認。生成fixtureだけで解放を省いた旧順序の負例はrefs=1/running=0、exit7となる必要がある。実Windowsの結果は最新CIで確認する。

実AIによるComputer Use受入は実施しない。これはnative seamであり、製品実AI受入の成功へ置き換えない。OS/lock/service/CI設定は変更しない。
