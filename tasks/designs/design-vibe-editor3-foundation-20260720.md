# vibe-editor3 Foundation 設計レビュー記録

- 対象: `docs/PRODUCT_AND_TECHNICAL_DESIGN.md`
- 日付: 2026-07-20
- 状態: Reviewed / findings integrated

> 2026-07-21の参照agent hardening reviewが後続baseline。最新判断は`design-reference-agent-hardening-20260721.md`を参照する。

## レビュー観点

### A. 技術的実現可能性

- ElectronのMain/Preload/Renderer境界が実装可能か。
- Runtime stream、SQLite event log、cancel/recoveryにraceや欠落がないか。
- ChatSurface shared elementとCanvas性能に成立条件があるか。

### B. アーキテクチャ・YAGNI

- MVPの責務分割が過剰または不足していないか。
- Teamを後付けせず、Chat基盤から自然に積み上げられるか。
- 将来拡張を理由に不要な抽象化を入れていないか。

### C. Devil's advocate・セキュリティ

- Renderer侵害、IPC abuse、path escape、command spoofingを防げるか。
- 承認modeが誤解を生まず、表示と実行が一致するか。
- crash、再送、Worker暴走、update中断でデータと権限が破綻しないか。

## 指摘一覧

| 重要度 | 指摘 | 対応 | 反映箇所 |
|---|---|---|---|
| Critical | Broker非対応Runtimeが承認を迂回できる | Managed modeは全副作用Broker経由を必須化。非対応はread-only、実効sandbox、明示unmanagedに分離 | 設計 §11.2、計画 Phase 0/3 |
| Critical | UtilityProcessをsecurity sandboxと誤認する | crash/performance隔離とsecurity隔離を分離し、最小env・secret・cwd・process tree・残余リスクを定義 | 設計 §7.4、§18.1 |
| High | 同期SQLiteがMainを停止させる | PersistenceClient境界を固定し、Main保持/DB Utility ProcessはPhase 0計測で決定（2026-07-21更新） | 設計 §7/9、計画 Phase 0/2 |
| High | Runtime Adapterがprocess越しに渡せない関数sinkを含む | RuntimeClient/RuntimeHostとversioned serializable protocolへ変更 | 設計 §11.1、計画 Phase 3 |
| High | operationIdの永続重複排除がない | operations ledger、request hash、unknown effectを追加 | 設計 §9、計画 Phase 1 |
| High | 同一DOM instanceを必須にすると実装が詰まる | ADR-002をProposed化し、状態連続性を要件化、3方式をPhase 0で比較 | 設計 ADR-002、計画 Phase 0/6 |
| High | 10 Workerの完全Chat常時mountが重い | focus/activeのみinteractive、他は同じ視覚契約のLOD projection候補をPhase 0で測る | 設計 §4/18、計画 Phase 0/6 |
| High | Shell承認がargv以外の差分を覆わない | immutable ExecutionSpecとdigest、absolute executable/cwd identityを採用 | 設計 §11.3、計画 Phase 4 |
| High | event/chunkが容量・機密・改竄の攻撃面になる | schema/size/rate/quota、保存前redaction、atomic chunk、reconciliationを追加 | 設計 §9、計画 Phase 3/7 |
| High | Team budget競合とsource spoofing | Coordinator発行identity、transactional reserve/settle、hard capを追加 | 計画 Phase 5 |
| High | update trustとdowngrade防止が不足 | publisher/channel/version/metadata/hash/domain検証をrelease gateへ追加 | 計画 Phase 8 |
| Medium | MVPのcut lineがない | Prototype、Chat Alpha、Team MVP、Public Betaを定義 | 設計 §1.3、計画 §1 |
| Medium | aggregateとeventの正本が曖昧 | append-onlyはTurn eventとTeam delivery auditに限定し、他はrelational stateとする（2026-07-21用語更新） | 設計 §9 |
| Medium | WorkspaceがPermissionBrokerより先に機能化される | Phase 2は選択・保存・表示だけに制限 | 設計 §12.2、計画 Phase 2 |
| Medium | Team Listがdebug扱い | 正式なaccessible projectionへ変更 | 計画 Phase 5 |

注: `safeStorage`について同期APIのみとの指摘があったが、2026-07-20時点のElectron公式資料では非同期APIを推奨しているため、設計の非同期API採用を維持した。

## 評価

レビュー完了後に以下を10点満点で採点する。

| 観点 | 点数 | 根拠 |
|---|---:|---|
| 完全性 | 9.0 | FR/NFR、状態、復旧、配布まで追跡可能。provider選定はPhase 0決定 |
| 一貫性 | 8.8 | ChatSurface中心とevent/permission境界が各Phaseで整合 |
| 実現可能性 | 8.4 | DB/Runtime/transitionの危険な前提をSpikeとfallbackへ移した |
| セキュリティ | 8.5 | Critical指摘をrelease blockerとして反映。OS sandbox可否は残余リスク |
| テスト可能性 | 9.1 | contract、state、recovery、adversarial、E2E gateを具体化 |
| 総合 | 8.8 | Team MVP実装へ進める設計baseline。Phase 0 ADR確定が開始条件 |

## レビュー結論

3視点のレビューは完了した。Critical 2件と主要High指摘は設計またはPhase gateへ反映済み。実装開始前にPhase 0でproduction runtime、DB process、ChatSurface transition方式を確定し、ADR-002をAcceptedまたはSupersededへ更新する。
