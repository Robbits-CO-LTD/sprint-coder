# macOS のデスクトップ操作: 配布物と同じ署名を付けた実行ファイルの確認（2026-11-16）

配布物の中の実行ファイルは、hardened runtime を付け、entitlements を空にして署名する。実 AI の試験（`macos-desktop-control-real-ai-20261116.md`）で使った実行ファイルには、この署名が付いていなかった。同じ署名を付けた実行ファイルで、実際の操作が動くかを確かめた記録。

これは、開発エージェントが実行ファイルを直接動かした確認で、Sprint Coder の中の実 AI の試験ではない。製品の経路（承認カード、起動の規則）は通っていない。

## 環境

| 項目 | 値 |
| --- | --- |
| OS | macOS 27.0.1、Apple シリコン |
| 実行ファイル | main（`ad026212`）から build した `sprint-coder-desktop-control` を複製し、`codesign --force -s - --options runtime` で署名し直したもの。`flags=0x10002(adhoc,runtime)`、entitlements なし（配布の時の `postPackage` と同じ） |
| 起動 | 開発版の Electron（`open` で起動。アクセシビリティと画面収録の許可を持つ）の子プロセスとして、1 コマンドずつ起動 |
| 対象 | テキストエディット（試験用の書類）、計算機 |

## 結果

| 操作 | コマンド | 結果 |
| --- | --- | --- |
| 版と権限の状態 | `version`、`permissions` | PASS（アクセシビリティと画面収録は granted。automation は unknown で、署名の無い build と同じ） |
| 窓の一覧 | `list-windows --app TextEdit` | PASS |
| 読み取り | `snapshot --window-id …`、`snapshot --app Calculator` | PASS |
| 撮影 | `screenshot --window-id …` | PASS（画像が返る） |
| 起動 | `launch Calculator` | PASS（裏で起動。前面のアプリは変わらない） |
| 入力 | `set-value @ref "…日本語…"`、`get @ref --property value` | PASS（書類に入り、読み直した値と一致） |
| クリック | `click @ref` を 5 回（消去・7・×・8・=） | PASS（計算機の表示は「7 × 8」「56」） |
| 終了 | `close-app Calculator` | PASS（プロセスが残らない） |

hardened runtime と空の entitlements で、止まる操作は無かった。

確かめていないもの: 通知の command（`osascript` を使う）、物理の入力（`--headed`）、drag、公証を通した配布物、Sprint Coder の製品の経路からの起動。

## この確認で見つけた不具合

`screenshot` を流した後、macOS が画面収録の確認のダイアログを出した。

> “Electron”から、システムプライベートウインドウピッカーをバイパスして画面とオーディオに直接アクセスすることが要求されています。

ボタンは「許可」と「システム設定を開く」。macOS が定期的に出すもので、配布版では「Sprint Coder」の名前で出る。権限のダイアログなので、開発エージェントは押していない。

このダイアログが最前面にある間、アプリを指定しない `list-windows` と、`--window-id` を使うコマンドが、全部 TIMEOUT になった（`global_window_inventory_unstable`、`frontmost_window_join`）。署名とは関係が無く、署名の無い build でも同じ。`--app` を付けた一覧と、ref を使う操作は通った。

原因: 最前面のアプリ（`com.apple.UserNotificationCenter`）のフォーカスのある窓（ダイアログ。CoreGraphics の layer は 8）を、layer 0 の窓の記録と突き合わせ、合わない時にやり直す作りだった。取り込んだ agent-desktop 1.2.0 の作りで、upstream の最新も同じ。

修正: PR #1322。ダイアログが出たままの状態で、直す前と後の実行ファイルを比べた。

| コマンド | 直す前 | 直した後 |
| --- | --- | --- |
| `list-windows` | TIMEOUT（5.0 秒） | 成功（0.8 秒）。フォーカスありの窓は 0、ダイアログは一覧に出ない |
| `snapshot --window-id <テキストエディットの窓>` | TIMEOUT（3.0 秒） | 成功（0.4 秒） |
| `list-windows --app TextEdit` | 成功 | 成功 |
