# Round 2: Chat Alphaゲート正式通過(2026-07-22開始)

Wave 1(並列):
- [ ] A(Codex): operations ledger / MessagePort+snapshot+afterSeq / input queue(Queue/Steer/Stop&Send) / goal・pin・archive・draft・workspace永続化 / contracts v2
- [ ] B(Sonnet): Markdown+sanitizer描画 / pin・archive・goal・workspace UI / draft永続化接続 / queue・steer UI / snapshot復元
- [ ] C(Sonnet): eslint+prettier+CI(GitHub Actions 3OS matrix)
Wave 2(完了 2026-07-22):
- [x] D(Codex): Production adapter(Codex CLI、read-only/no-tools、UtilityProcess)+ ADR
- [x] E(Sonnet): Playwright E2E 4 specs(devモードfallbackで3回連続green)
- [x] F(Codex+Sonnet): Context Ledger minimum + context %UI
- [x] Fable: 全wave監査済み

## Chat Alphaゲート判定(2026-07-22 Fable)

**判定: 実質通過**(環境依存2件を除く)
- 通過: 永続Chat/復元、streaming/中止/interrupted、input queue、operations ledger、snapshot+afterSeq、Markdown安全描画、Workspace選択、Codex production runtime(実CLI裏取り済み)、Context Ledger、キーボード完結、E2E 4本、114テスト、lint/format/CI定義
- 環境依存の残件:
  1. ローカルpackaging不能 — extract-zipがElectron zipのelectron.icnsで決定論的ハング(Node 26/22両方で再現=バージョン非依存のマシン固有問題)。CI(GitHub Actions)では別環境のため要確認
  2. CI実走 — GitHub remote未設定のため未実行
- 意図的延期: Slice 3.6 Intelligence Loop baseline(Phase 4のtool loopと不可分のためPhase 4冒頭へ)、MessagePort以外のSlice 1.2完遂項目は完了済み

## Phase 4 実装進捗(2026-07-22)

- [x] Production Runtime probe hotfix
  - UtilityProcess子側のIPC取得を実行時にundefinedとなる`electron/utility.parentPort`からElectron正本の`process.parentPort`へ修正
  - 同一UtilityProcess診断で`codexAvailable:true`を確認し、Computer Use実機操作でCodex選択→実AI応答「疎通確認OK」まで完走
- [x] Phase 4冒頭 / Slice 3.6 Intelligence Loop baseline
  - `intelligence_steps` migration v5とimmutable StepSnapshot(model/effort/context・tool digest/policy epoch/workspace・contract revision)を追加
  - Step lifecycle(`prepared→sampling→sampled→dispatching→toolsCommitted→completed`)をdomain state machineとSQLiteで強制
  - Context Compiler minimum(workspace rule authority、world-state diff、history authority正規化、tool call/result pairを壊さないtrim)を追加
  - MockRuntimeを同一Turn内の`model→mock_echo→result→model` 2-Step loopへ接続。production Codex adapterのread-only profileは変更なし
  - answer-only/mock-tool 2-case corpus runner骨格と比較用digest/metricを追加。coding 30-case gateはSlice 4.7
  - workspaceの内容revisionはまだ追跡不能なためStepSnapshotへ`untracked:<canonical workspace identity digest>`を明示保存。FileRevisionToken/実revisionはSlice 4.7
  - 検証: typecheck/test(125件)/lint/format/E2E 4本 green、既存forge dev起動とE2E Electron実起動でsmoke済み
- [ ] Slice 4.1 PermissionBroker

---

# Chat Alpha骨格 実装TODO(commander運用)

- 対象: VE3-PLAN-001 Phase 1〜3のvertical slice(Chat Alpha骨格)
- 体制: Codex=backend / Sonnet=UI / Fable=指揮・監査
- 視覚基準: demo/index.html(2026-07-22ユーザー承認済み)

## 契約(Fableが確定)

- repo構成: 計画書§2どおり(apps/desktop, packages/contracts, packages/domain, npm workspaces)
- preload公開API `window.vibe`: tasks.list/create/messages/rename, turns.start/cancel/subscribe(型は各起動プロンプトに記載)
- Turn stage: understanding→planning→executing→synthesizing(FR-RUN-02のサブセット)
- 永続化: Main直置きSQLite(ADR-Phase0比較は保留、暫定採用と記録)
- Runtime: deterministic MockRuntimeAdapterのみ(Phase 3.2)。production adapterは次ラウンド

## チェックリスト

- [x] git init + baseline commit
- [ ] Codex: backend scaffold + main/preload/contracts/domain/persistence/mock runtime
- [ ] Sonnet: renderer UI(App.tsx以下、デモ準拠デザイン)
- [ ] Fable: git diff監査(セキュリティNFR-SEC-01..05、契約一致、TS strict)
- [ ] 検証委譲: npm install / typecheck / test / 起動smoke
- [ ] 差し戻し or 統合修正
- [ ] ユーザー報告

## 境界(コンフリクト防止)

- Codex所有: ルートpackage.json、apps/desktop設定類、src/main/**、src/preload/**、packages/**、src/renderer/main.tsx・index.html(App.tsxは存在しない場合のみplaceholder作成、上書き禁止)
- Sonnet所有: apps/desktop/src/renderer/**(main.tsx・index.htmlを除く)。package.json・設定・main/preload/packagesに触れない

## レビュー記録(2026-07-22 Fable監査)

- 委譲結果: Codex=backend(契約・domain・永続化・mock runtime・hardened main/preload)、Sonnet=renderer UI一式。いずれも一発合格(大規模差し戻しなし)
- Fable適用の統合修正:
  1. apps/desktop/package.json: `main` の指す先がビルド産物と不一致(.vite/build/main.js→index.js)+ CJSバンドルに対する `"type":"module"` を除去 → 起動不能の根本原因
  2. src/main/index.ts: `import.meta.dirname`(CJSでundefined)→ `__dirname` に置換(preloadパス・renderer root)
  3. src/main/index.ts: whenReady失敗の握りつぶしを解消(dialog.showErrorBox+app.exit(1)、Slice 1.1のfatal screen要件)
  4. 検証エージェント適用: preloadのPublicErrorをErrorインスタンス化(renderer側 "[object Object]" 防止)
  5. better-sqlite3をElectron ABI向けにrebuild(@electron/rebuild、リスクR2が実際に発現)
- 検証: npm install成功 / typecheck 3 workspace成功 / test 104件全PASS / Electron実起動でRenderer window生成・DB(WAL)作成をmacOS実機確認
- 追加の起動系バグ2件をFableが特定・修正(commit済み):
  6. index.htmlがsrc/renderer配下にありVite rootの`/`が404 → apps/desktop直下へ移動(白画面の原因)
  7. main/preload両entryがindex.tsで`.vite/build/index.js`を上書き合戦 → preload出力名を明示分離(window.vibe未公開の原因)
- 2026-07-22 ユーザー実機確認: golden path #1(Task作成→hello送信→Run Card→mock streaming応答)成功のスクリーンショットを受領。Chat Alpha骨格ラウンド完了
- 未了(次ラウンド送り): operations ledger(冪等性、Slice 1.2)、Forge起動時のnative自動rebuild恒久化(workspace hoisting対策)、npm audit 24件(critical 1)、E2E(Playwright Electron、Phase 0 spike対象)、Team/Canvas(Phase 5-6)
