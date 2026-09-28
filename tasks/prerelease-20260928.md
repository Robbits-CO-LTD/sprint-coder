# 0.7.0-beta.12 公開候補

公開 beta.11 で #556 のGraph資源予約を実機確認した際、Workerの承認要求が拒否され、長い停止理由によってMainも異常終了したため、元の停止未確認条件に到達できなかった。両方の修正（#620・#618）は公開beta.11後にmainへ入り、現mainのローカルpackageでは#556の資源隔離を直接確認した。公開物での受入をやり直すため、beta.11後のmainを評価用ベータ候補に固定する。`0.7.0`のbaseは維持し、未使用番号beta.12を一度だけ使う。

## beta.11以降に含む変更

- Graph・Teamの安全境界: #616（Graph工程外の書込みWorkerのsteer／再開を拒否）、#618（長い停止理由をTeam表示へ収める）、#619（Worker内のツール結果の順序を保つ）、#620（実行中Graph MissionのWorkerが承認カードを使える）。
- Managed Local MissionのWorkspace: #621（書込みを永続隔離へ結びつける）、#622（通常MissionのWorkerツールsessionを維持）、#623（Mission sessionへAcceptance Contractを保存）、#624（Graph Mission sessionのWorkspace snapshotを封印）。これらは#570のコード修正であり、後続の実機受入は別に判定する。
- 文書識別子とURLパス: #617（通常文書の識別子とURLパスを保持）。
- テスト: #611（Windows E2Eの起動待ち診断と上限。配布物の動作変更ではない）。

変更の基点は公開 `v0.7.0-beta.11` のソースcommit `a7ab4a7e843cbbde9b384019cecd1e263fe58c53`、候補の製品コード基点は `main@0478b5477f540792be4c1cbed32aa6bffe247819`。本PRの製品コード変更はversionのみで、`apps/desktop/package.json`と`package-lock.json`のdesktop workspaceの値を揃える。

## 配布と検証

beta.11の手順を引き継ぐ。最新headの必須CIと独立レビューを確認してmergeし、そのmerge済みcommitへtagを付ける。release workflowのDraftで全asset、version・tag・commit、更新manifest、macOS署名・notarization・cleanupを照合した後、pre-release（`--latest=false`）として公開する。正式版のLatestは更新しない。

今回のversion更新やrelease workflowの成功を、各Issueの実機受入PASSとして扱わない。公開物のWindows Graph試験では#556の実際の停止未確認・予約quarantined・後続Worker未入場を直接確認する。#570の書込み後の従属読取り／通常Mission読取り、#571の統合順番待ち、#585のClaude経路、#572の必須独立レビュー証跡は未完了としてOPENを維持する。#533は実装前レビュー待ち、#549は上流待ち。#506とComputer Useの実機gateもこのreleaseでcloseしない。
