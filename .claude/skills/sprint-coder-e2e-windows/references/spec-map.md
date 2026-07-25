# spec 対応表（29 ファイル / 78 テスト）

変更した場所から走らせる spec を選ぶための表。「守っているもの」は、その spec が落ちたとき**何が壊れた可能性があるか**を読むためのもの。

最新の一覧は次で取れる（アプリを起動しないので数秒）:

```bash
SPRINT_CODER_E2E_MODE=dev npx playwright test --list
```

## golden path（設計書 §15.5）— 迷ったら常に走らせる

| spec | 守っているもの | 走らせるべき変更 |
|---|---|---|
| `golden-path-1-restart-restore.spec.ts` | 新規Task → 送信 → streaming → 再起動 → SQLite から復元 | main/persistence、IPC、store、再起動時の復元パス |
| `golden-path-2-cancel.spec.ts` | streaming 中の停止で部分回答が残り `data-run-status=canceled` になる | RunCard、cancel/abort、runtime-host |
| `golden-path-3-queue.spec.ts` | Turn 1 中に積んだ入力が Turn 2 として自動開始 | Composer の queue、Turn の連鎖 |

## Chat / Composer / Timeline

| spec | 守っているもの | 走らせるべき変更 |
|---|---|---|
| `keyboard-smoke.spec.ts` | Task作成→入力→送信をマウス無しで完走 | Composer、Sidebar、フォーカス順 |
| `composer-plus-menu.spec.ts` (5) | ＋メニューのキーボード操作、外側クリック、Goal 設定、Canvas 上での収まり | Composer、TaskHeader/GoalChip、メニュー実装 |
| `timeline-scroll-follow.spec.ts` | streaming 中に上へスクロールすると追従が止まり「最新へ」で復帰 | ChatSurface のスクロール制御 |
| `reasoning-pill.spec.ts` (5) | thinking pill が Run Card を1行に畳む / reasoning パネルの streaming・キーボード往復・reasoning 無しの退化・**plain text 描画（markup を live 要素にしない）** | ReasoningPanel、RunCard、reasoning-batcher、normalizer |
| `surface-footer.spec.ts` (3) | 接続状態表示、Turn の running→idle、クラッシュで中断した Run の通知、Canvas Leader 上でも収まる | フッター、接続状態、interrupted 復旧 |
| `task-auto-title.spec.ts` (2) | 初回メッセージから自動命名し、以後触らない／手動改名は尊重 | main/task-title、Sidebar |
| `sidebar-collapse.spec.ts` (3) | 折りたたみで会話列が幅を取り戻す・状態が永続、最小サイズでオーバーレイ、150% ズームで横スクロールなし | Sidebar、レイアウト CSS |
| `settings-dialog.spec.ts` (4) | 開閉とフォーカス復帰、フォーカストラップ、キーボードのみで Runtime/model/effort 変更＋再起動後も保持、CLI 検出状態の表示 | SettingsDialog、設定の永続化 |

## Runtime / モデル / 実行

| spec | 守っているもの | 走らせるべき変更 |
|---|---|---|
| `model-and-access-settings.spec.ts` (3) | Codex モデルと Access プリセットの選択・復元、Claude のモデル表記と effort 永続化、モデル別 effort（Auto は出さない） | runtime-selector / model-selector / effort-selector、設定 |
| `approval-flow.spec.ts` | 拒否が永続化され、Turn を失敗させずに runtime へ返る | approval-coordinator、ApprovalCard |
| `command-runner-flow.spec.ts` | 安全に拒否 → 承認された「まさにそのコマンド」を1回だけ実行 | command-runner、承認フロー。**focus 系アサーションに既知の flake あり** |
| `codex-imagegen.spec.ts` (4) | Codex 選択時のみ画像生成が使える／1回だけ武装／メッセージに指示が入る／通常送信では何も出ない | Composer ＋メニュー、Codex アダプタ |
| `leader-mcp-smoke.spec.ts` (2) | Leader の team 操作が実 MCP を通ること（**opt-in / 実 CLI・実課金**） | 既定では skip。`SPRINT_CODER_LEADER_MCP=1` を勝手に付けない |

## ファイル編集 / Inspector

| spec | 守っているもの | 走らせるべき変更 |
|---|---|---|
| `file-edits.spec.ts` (2) | ask プリセットでは書かず不足条件を提示／auto では編集を記録し、その Turn に紐づき再起動後も再生 | edit-saga、write-scope、path-guard、FileChangeCard |
| `live-file-edit.spec.ts` (3) | 本文が**実際に伸びる**こと、Runtime が報告しない書き込みを watcher が拾うこと、Workspace 外・symlink 先を絶対に映さないこと | workspace-file、workspace-watcher、LiveFileEdit、partial-json-string |
| `inspector-panel.spec.ts` (6) | 既定は非表示・幅の循環と永続、再親化された ChatSurface の子孫にならない、Chat↔Team 往復で幅維持、List 表示中はレール、五段階ゲージが後退しない、条件不足時に空窓を出さない | InspectorPanel、SurfaceLayer / portal 構造 |

## Team（Canvas / List）

| spec | 守っているもの | 走らせるべき変更 |
|---|---|---|
| `team-flow.spec.ts` (3) | Leader が自律的に 3 Worker を hire/dispatch して停止、再起動で paused 復元、自然な依頼で自動昇格＋Canvas 自動オープン | team-coordinator、team-tools、昇格ロジック |
| `team-morph.spec.ts` (2) | Chat↔Leader の morph で draft・スクロール・ChatSurface インスタンスが保たれる、高速二度押しでも状態が壊れない | SurfaceLayer、morph アニメーション |
| `team-canvas-layout.spec.ts` (5) | ドラッグ位置とカメラの再起動越し永続、LOD、List と Canvas の一致、カメラ所有権（system↔user）と Fit、配置衝突回避、キーボードナビ | TeamCanvas、placement、cameraOwnership、useCamera |
| `team-cables.spec.ts` (6) | hire 中はケーブルを出さない、送信で正しいペアに描画し ack 後だけ光る、連続2件、画面外 Worker でもカメラを動かさない、pan 中も壊れない、reduced motion では代替テキスト | cables.ts、WorkerNode |

## アクセシビリティ / 性能（品質ゲート）

| spec | 守っているもの | 走らせるべき変更 |
|---|---|---|
| `a11y-axe.spec.ts` (4) | chat / settings / approval / team canvas で axe の serious・critical ゼロ | 任意の UI 変更。**dev モード必須**（CSP 例外に依存） |
| `a11y-keyboard-golden-path.spec.ts` | Task→送信→Team→Canvas→List→戻る をキーボードのみで完走、フォーカスを失わず Tab が閉じ込められない | フォーカス管理、tabindex、ダイアログ |
| `a11y-list-view-parity.spec.ts` | List 表示が Canvas と役割・目的・状態・メッセージ行・chip で一致し、追加で活動と使用量を出す | TeamListView、TeamCanvas の表示情報 |
| `a11y-reduced-motion.spec.ts` (4) | reduced motion でカメラ fly / Worker spawn / Chat↔Team morph が即時化（かつ通常時はちゃんとアニメする対照テスト付き） | アニメーション全般、`prefers-reduced-motion` 分岐 |
| `a11y-zoom.spec.ts` (2) | 200% ズームで chat / list に横スクロールが出ず操作可能 | レイアウト CSS、固定幅の追加 |
| `perf-budgets.spec.ts` | 起動→操作可能、Composer 入力 p95、10 Worker Canvas の pan fps（NFR-PERF-01/02/03） | レンダリング負荷に触る変更。**通っても console.info の実測値を報告に載せる** |

## 参考: よく使われる testid

`composer-textarea` / `composer-send-button` / `sidebar-new-task-button` / `run-card`（`data-run-status` 属性）/ `streaming-assistant-message` / `assistant-message` / `user-message` / `inspector-panel` / `inspector-toggle` / `live-edit-body` / `live-edit-path` / `live-edit-state` / `team-toggle` / `team-list` / `team-worker` / `runtime-selector` / `model-selector` / `effort-selector` / `access-selector` / `settings-dialog` / `approval-card`

これらの名前や画面文言を変えた場合、E2E の失敗はアプリのバグではなく spec の追随漏れ。spec 側を実装に合わせて直す。
