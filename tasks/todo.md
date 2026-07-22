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
- 未了(次ラウンド送り): operations ledger(冪等性、Slice 1.2)、Forge起動時のnative自動rebuild恒久化(workspace hoisting対策)、npm audit 24件(critical 1)、E2E(Playwright Electron、Phase 0 spike対象)、Team/Canvas(Phase 5-6)
