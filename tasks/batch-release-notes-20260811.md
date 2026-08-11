# バッチリリースノート（2026-08-11）

- 統合ブランチ: `codex/batch-20260811-planned`
- ベース: `origin/main` (`33e021e`)
- Issue統合HEAD（本ノート追加前）: `bb15834`
- リリース版: 未確定（この文書では版番号を付与しない）
- mainへのマージ: Release PRの承認待ち

## 変更内容

### Issue #190: Team依頼の役割指定を正しく認識

「リーダーは〜、ワーカーは〜」のように役割を明示した依頼をTeam実行として認識し、必要な`sprint-coder-team`機能をTurnへ封入するよう修正しました。

- E2E: PASS（3 passed / 0 failed / 1 skipped）
- 境界: fresh profileがonboardingで停止したため、Composerからの送信とTeam Canvasの目視はコードパス整合性テストで代替。設定済みprofileでの手動GUI確認を推奨します。

### Issue #191: 回答済みTurnの完了判定を修正

回答本文を出し切った通常の調査Turnを、Workerが0件という理由だけで`RUNTIME_PROTOCOL_ERROR`にしないよう完了判定を修正しました。明示的にTeam実行を要求したTurnの失敗判定は維持しています。

- E2E: PASS（5 passed / 0 failed / 1 skipped）
- 境界: fresh profileがonboardingで停止したため、Composer送信後のRunCard表示は実Provider/CLIアダプターとRunCard描画テストで代替。設定済みprofileでの手動GUI確認を推奨します。

### Issue #192: Main側プロトコルエラーの診断を永続化

Main側で`RUNTIME_PROTOCOL_ERROR`が発生し、アダプター由来の診断がない場合にも、安全な診断情報を生成・保存し、ログとRuntime状態から同じ診断IDを追跡できるようにしました。

- E2E: PASS（5 passed / 0 failed / 1 skipped）
- 境界: GUIにはMain側プロトコル障害を決定的に注入する機能がないため、IpcRouterと実Electron SQLite再起動で代替。Project Chat上の失敗表示と再起動後の診断表示は手動GUI確認を推奨します。

### Issue #182: Runtime Host拒否時のqueued滞留を解消

Runtime Hostが不正な開始要求を拒否した場合や応答しない場合に、Turnを永久に`queued`へ残さず、期限付きで安全に失敗へ遷移させるようにしました。遅延・重複応答も一度だけ処理します。

- E2E: PASS（6 passed / 0 failed / 1 skipped）
- 境界: 公開UIからRuntime Hostの偽造・無応答を注入できないため、プロトコル/Main/Rendererの実コードパスで代替。実Codex/ClaudeとProject Memoryを使った起動待ち・拒否表示は手動GUI確認が必要です。

### Issue #186: 実行中Composerの停止・キュー・割り込みを追加

Turn実行中のComposerから、現在の実行を停止する、次の依頼をキューへ積む、現在の実行へ割り込んで送信する、の3操作を使い分けられるようにしました。下書きや添付の復元、IME、アクセシビリティ、狭幅表示も保護しています。

- E2E: PASS（8 passed / 0 failed / 0 skipped）
- 境界: proxyなし。packaged Electron UIで停止・キュー・割り込みを直接操作して確認済みです。

## 関連Issue

- [#190](https://github.com/Robbits-CO-LTD/sprint-coder/issues/190)
- [#191](https://github.com/Robbits-CO-LTD/sprint-coder/issues/191)
- [#192](https://github.com/Robbits-CO-LTD/sprint-coder/issues/192)
- [#182](https://github.com/Robbits-CO-LTD/sprint-coder/issues/182)
- [#186](https://github.com/Robbits-CO-LTD/sprint-coder/issues/186)
