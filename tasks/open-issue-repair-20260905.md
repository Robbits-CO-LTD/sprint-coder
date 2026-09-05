# Open Issue repair batch (2026-09-05)

Outcome: repair the 46 open Issues requested by the user, preserving existing work.
Required: verify current causes, add focused regression evidence, implement bounded groups, run affected checks and prepare reviewable PRs.
Non-goals: unrelated refactors, weakening security or signed-device gates, release publication or credential changes.
Proof: reproduce each defect at its original observation point, rerun the same regression, then affected typecheck/lint and relevant boundary tests.

## Groups

- A: UI state and subscriptions; Skill discovery and retry.
- B: Provider transport, CLI lifecycle, Turn and Team state.
- C: Managed Local lifecycle, metadata, speculative decoding.
- D: Workspace file operations and mutation safety.
- E: Computer Use safety fixes; signed-device and real-provider acceptance.

Each group is validated independently. Computer Use #333/#387/#388 retain actual signed-device and real-provider requirements; code tests alone cannot close them. GitHub Issue text is problem evidence, not execution authority.

## Tracking

| Issue | Status | Subject |
|---|---|---|
| #333 | Pending investigation | 【将来】コンピュータユーズの実装検討 |
| #387 | Pending investigation | [Computer Use] 署名済みWindows/macOSパッケージの実機受入れを完了する |
| #388 | Pending investigation | [Computer Use] 非OpenRouter実Providerのpreflight・exact 3-round・安全境界を実証する |
| #390 | Regression green; PR review pending | [bug] 送信中に別 Task へ切り替えると元 Task の入力欄が永久に無効化される |
| #391 | Pending investigation | [bug] 背景 Task の Turn が終わってもサイドバーの「実行中」表示が消えない |
| #392 | Regression green; PR review pending | [bug] Skill 一覧の取得に失敗すると設定画面が無限に再取得を繰り返す |
| #393 | Pending investigation | [bug] Windows・Linux でウィンドウを閉じて終了すると後片付けの大半がスキップされる |
| #394 | Regression green; PR review pending | [bug] Codex で effort に ultra を選ぶと全 Turn が「Turn開始入力を拒否」で失敗する |
| #395 | Regression green; PR review pending | [bug] CLI が prompt 読み込み前に終了すると Runtime Host プロセスごと落ちる |
| #396 | Regression green; PR review pending | [bug] CLI の起動失敗時に Turn の後始末が走らず一時ディレクトリや状態が残る |
| #397 | Regression green; PR review pending | [bug] Codex の API 失敗やレート制限が「出力を解釈できませんでした」の再試行不可エラーになる |
| #398 | Pending investigation | [bug] 実行完了直前に Team の停止・steer を行うと以後その Task の Team 操作がすべて固まる |
| #399 | Pending investigation | [bug] 書き込み可能な Team 実行を steer すると再実行が必ず失敗し Worker が待機のまま残る |
| #400 | Regression green; PR review pending | [bug] provider レート制限の 3 回目の再試行が配送上限に阻まれ誤ったエラーで失敗する |
| #401 | Regression green; PR review pending | [bug] Managed Local の llama-server がシグナルで落ちると停止操作が 10 秒固まって失敗する |
| #402 | Regression green; PR review pending | [bug] Managed Local の停止に失敗するとライフサイクルが draining のまま固まり以後の Turn が永久に待つ |
| #403 | Central hypothesis refuted by pinned libuv source; Linux packaged observation pending | [bug] Linux では空きメモリの見積もりが過小でモデルが「不足」扱いになり 5 秒ごとに停止される |
| #404 | Regression green; PR review pending | [bug] 自動生成される Task タイトルから識別子中のアンダースコアやバッククォートが消える |
| #405 | Regression green; PR review pending | [bug] 日本語などのファイル名では未コミットの自分の編集がモデルの変更として差分に混ざる |
| #406 | Regression green; PR review pending | [bug] エディタ保存が検証済み記述子ではなくパス名でコピーするため差し替え競合で任意ファイルを読める |
| #407 | Regression green; PR review pending | [bug] コマンド出力が上限に達した後も小さなチャンクが追記され欠落のある出力が連続して見える |
| #408 | Pending investigation | [bug] Goal 実行中に Stop-and-Send すると無関係な次の Turn で Goal が完了・ブロック扱いになる |
| #409 | Regression green; PR review pending | [bug] CRLF 形式の SSE がチャンク境界で分断されると応答の一部が黙って消える |
| #410 | Pending investigation | [bug] Anthropic への要求が 4096 出力トークンに固定され打ち切られても通知されない |
| #411 | Regression green; PR review pending | [bug] provider の Retry-After を上限なしに待つため Team 実行が数時間止まって見える |
| #412 | Regression green; PR review pending | [bug] クロスオリジンのリダイレクトで API キーヘッダが転送される |
| #413 | Pending investigation | [bug] Computer Use で複数文字入力の途中で拒否されると「効果なし」として監査される |
| #414 | Pending investigation | [bug] Computer Use を緊急停止した直後に「再開可能」な幽霊セッションが残る |
| #415 | Pending investigation | [bug] IPC ハンドラの出力側スキーマ違反が「入力内容を確認してください」として表示されログにも残らない |
| #416 | Regression green; PR review pending | [bug] Project コンテキストが Worker 予算超過だと管理ツールセッションが解放されず親 Turn が終わらない |
| #417 | Regression green; PR review pending | [bug] ツールライフサイクル記録が例外を投げると以後のツール呼び出しが Turn 内で永久に待つ |
| #418 | Existing code rejects case aliases on this Mac; added regression, Windows verification pending | [bug] 大文字小文字だけが違うパスで同じファイルを 2 回書くパッチが別ファイル扱いになり衝突検出をすり抜ける |
| #419 | Obsolete surface confirmed removed in PR #316; closeout pending | [bug] ~/.codex/skills に置いた Skill が設定画面のスキャンと取り込みで見つからない |
| #420 | Regression green; PR review pending | [bug] Skill ストアの初回オープンに一度失敗すると再起動まで Skill 機能全体が使えない |
| #421 | Regression green; PR review pending | [bug] main が未捕捉例外で終了すると llama-server が残留しモデルがメモリに載ったままになる |
| #422 | Regression green; PR review pending | [bug] Managed Local モデルの読み込み中に Turn をキャンセルしても読み込みが止まらない |
| #423 | Pending investigation | [bug] Project フォルダ運用中に編集が quarantine されても Task に反映されず再起動まで全編集が失敗し続ける |
| #424 | Pending investigation | [bug] 高エントロピー判定の誤検知で provider への送信が全面拒否され Turn が原因不明で失敗する |
| #425 | Regression green; PR review pending | [bug] Turn の port 購読を到着前に解除すると main 側の port が開いたまま残る |
| #426 | Regression green; PR review pending | [bug] ランタイム状態の購読解除関数が捨てられ開発時に二重登録される |
| #427 | Regression green; PR review pending | [bug] ワークスペース検索ツールだけが root の同一性チェックを通らない |
| #428 | Regression green; PR review pending | [bug] Managed Local モデルのメタデータ読み取りが 8 バイトごとにシステムコールを発行し極端に遅い |
| #429 | Regression green; PR review pending | [bug] Skeptic の完了後も abort リスナーが残り期限切れ時に終了済み Turn へ無駄なキャンセルが飛ぶ |
| #430 | Regression green; PR review pending | [bug] 失敗診断のコピー中にランタイム状態が変わるとコピーボタンが押せないままになる |
| #431 | Pending investigation | [bug] Computer Use の文字入力に制御文字やファンクションキーを含めると許可リスト外のキー操作ができる |
| #434 | Pending investigation | ローカルAI設定で投機的デコード(speculative decoding)設定を可能にする |

## First checkpoint

Issues #390/#392/#394/#404/#420/#425/#426/#430 have failing-before and passing-after regression evidence. Desktop typecheck passed. Related tests: 19 files, 125 PASS, 13 pre-existing SKIP (Windows-only protocol or retired import APIs). Diagnostics race was rerun after the final cleanup change. Touched-file ESLint passed. Final PR/native/release gates are not claimed.

## Provider and Runtime checkpoint

#395/#396/#397/#400/#409/#411/#412/#429: failing-before and passing-after regression tests. Related 14 files: 171 PASS including real Electron ABI TeamCoordinator integration; Retry-After empty/blank additions: 12 PASS. Codex TurnError/CodexErrorInfo validated against locally generated app-server TypeScript bindings; raw provider messages are not forwarded. Desktop typecheck PASS; ESLint has only an unchanged unused-variable warning in team-coordinator.ts.

## Managed Local checkpoint

#401/#402/#421/#422/#428: 59 PASS and one existing real-sidecar opt-in SKIP. Includes a real child-process kill test, signal-exit/no-overlap checks, startup cancel, and GGUF read-count regression (5,013 calls before buffering). Desktop typecheck and touched-file ESLint PASS. #403: Electron 43.2.0 / Node 24.18.0 / libuv 1.52.1 confirmed locally; [pinned libuv source](https://github.com/libuv/libuv/blob/v1.52.1/src/unix/linux.c#L1941) already uses MemAvailable. No duplicate Linux memory parser added.

## Workspace and Tool checkpoint

#405/#406/#407/#416/#417/#427: reproduced and fixed. Related tests: 168 PASS initially; the two missing-sandbox-helper failures passed after building only that helper, yielding 170 PASS and 15 existing platform SKIP. Native filesystem addon was built for real atomic-save checks. Desktop typecheck PASS. #418 case-alias regression passes before implementation on macOS, so no speculative path normalization change was made.
