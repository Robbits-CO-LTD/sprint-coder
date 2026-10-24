# #909 権限確認中の表示と送信

- 目的: native確認前は確定済みの権限を維持して確認待ちを表示し、送信を理由付きで拒否して下書きを保つ。取消・閉じる・120秒の期限で確認待ちを解除する。
- 根拠: [Issue追加情報](https://github.com/Robbits-CO-LTD/sprint-coder/issues/909#issuecomment-6363561031)。正常DBはack/full保存済み、失敗DBは未保存なのにUI full。実handler/TaskMailbox/storeのdeferred再現でも未回答時は同じ状態、native回答だけを変えると送信が進む。RCA: Root Cause Confirmed。
- 変更範囲: Mainのpermission admissionと期限付きnative確認、RendererのTask別pending/送信ガード/確認待ち表示、直接関連する回帰テスト。
- 非対象: native承認の省略・自動承認、権限規則/secret/egress、DB/schema、Provider、Computer Use機能の変更。
- 前提: base `829155af`。#890の操作cache/hash、policy epoch、cleanup結果とupdate-install gateを保持。受付済み処理のmailbox順序を変えず、Stopボタンを新たに無効化しない。
- リスクと復旧: 権限変更と送信の競合、期限後の承認、取消時のUI復元。変更をrevert可能、永続化形式の変更なし。
- 検証: 実IPC登録handler/TaskMailbox/Native callback deferred、全new-work拒否、approve/cancel/timeout/後着結果/dispose、既存ack/cache/hash/cleanup、storeの下書き等の保持、React DOMの確認待ち/Enter/IME/Shift+Enter/Stop、desktop typecheck・対象test・lint・format。
- 独立レビュー: `claude -p --model claude-opus-5-5 --effort high`、tools無効で差分をレビュー済み。ブロッカーなし。native本人承認、cache/hash/cleanup/gate、期限後の承認無効、Task別pendingの後片付けを確認。
- 残件: Windows実native画面での取消と本人承認後の送信は未確認。Macのnative AbortSignal取消は隔離fixtureで確認済み。実AI smoke・承認ボタンの自動操作は行わない。push/PR/merge/Issue操作は親が管理する。
- 添付: 0/0（本文・最新コメントに添付なし）。

## 検証結果

- PASS: Node 22、desktop typecheck、変更したTS/TSXのESLint、変更ファイルのPrettier、diff whitespace。
- PASS: 関連13 test file・1,538件（既存IPC、permission broker、update-install gate、cleanup、store、React DOM）。最後の表示文言と古いepoch応答の既定値記憶抑制は、直接関係する3 file・17件を再確認。
- PASS: 未回答の実permissionsSet handler直後に6種類のnew-work送信を実TaskMailbox経由で試し、Turn生成前に理由付きで拒否。承認後の送信、取消後の旧権限、期限直前の未決着、期限到達でのabort、遅延した肯定応答の無効を確認。
- PASS: native未回答でも下書き・Skill・添付を保持。React DOMで確定権限の表示、確認待ち理由、Enter拒否、IME/Shift+Enter、Stopボタン維持を確認。
- PASS: macOSの実Electron 43.5.0で、親付きnative `showMessageBox` が未回答のまま250ms待ち、AbortSignal後にcancelId=0を返すことを確認。親は応答まで生存し、その後destroyしてプロセス正常終了。親のfocusイベントは0件。fixtureは専用userDataを使い、AI/DB/承認操作は持たない。
- native fixtureはWindows/macOSの通常testから実行する。Linux unit jobはGUI契約がないため明示SKIP。120秒の製品期限は既存のfake timer回帰を維持し、実fixtureはOSの取消境界だけを短時間で検証する。
- SKIP: 実Windowsのnative取消、本人承認後の実Provider応答、OSごとの目視。schema/DB migrationなし、Provider smoke/フルE2Eは実施しない。
