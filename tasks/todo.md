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

## レビュー記録

(監査後に追記)
