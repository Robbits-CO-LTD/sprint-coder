# Codex CLI / Grok Build参照後 hardening review

- 対象: `docs/PRODUCT_AND_TECHNICAL_DESIGN.md`、`docs/REFERENCE_AGENT_ARCHITECTURE.md`、`tasks/IMPLEMENTATION_PLAN.md`
- 日付: 2026-07-21
- 状態: Reviewed / Critical・High反映済み
- 固定source: Codex `fd3c1dc13d0a0941af406e1bc1f697c9d14110ea`、Grok Build `a881e6703f46b01d8c7d4a5437683546df30449d`

## レビュー体制

| 観点 | Reviewer | 初回評価 | 主眼 |
|---|---|---:|---|
| Architecture / YAGNI | Arendt | Critical 2件 | aggregate、ownership、phase境界 |
| Feasibility / concurrency | Kuhn | 7.8/10 | Actor I/O、outbox、delivery、rewind |
| Security / adversarial | Einstein | 7.8/10 | egress、sandbox、child権限、worktree |

## Blockerと反映

| 重要度 | 指摘 | 設計判断 |
|---|---|---|
| Critical | RunとTurnが二重aggregate | RunはUI labelだけ。domain/API/DBはThread/Turn/Itemへ統一 |
| Critical | ItemとMessage/Approvalの正本が曖昧 | Itemはtyped entityを参照するtimeline projectionと定義 |
| Critical | Tool Brokerがprovider inference egressを制御しない | `provider.egress`を独立capability化し、fragment/data residency/local-only policyを追加 |
| Critical | read-only promptやUtility Processをsandboxと誤認 | OS sandbox probeをManaged条件化。満たさない外部CLIは`trusted-unmanaged` |
| High | ActorがI/O await中にmailboxを止める | Effect + revision付きinternal commandへ変更し、Actorをlive ordering/only writerに限定 |
| High | persist-before-inference後のcrashで二重dispatch | transactional dispatch outboxとattempt dedup、unknownはinterruptedを採用 |
| High | background通知のat-most-onceは欠落する | durable at-least-once + deterministic dedupでexactly-once effect |
| High | Safe rewindをatomicと表現できない | best-effort compensating sagaへ変更。Team MVPはConversation rewindのみ |
| High | ToolKindだけでは実装を一意解決できない | Turnごとのimmutable ToolCatalogSnapshotを追加 |
| High | parent capability ceilingが粗い | resource/operation/expiry/egress/sandboxを含むlatticeとpolicyEpochを採用 |
| High | worktreeをsecurity isolationと誤認 | change isolation限定。OS sandbox、sanitized Git、artifact scan、Broker applyを必須化 |
| High | Auto reviewerがprompt injection経路になる | immutable facts限定、no-tools/no-network、allow-once、high-risk/failure deny、digest監査 |
| High | WorkerとBackgroundActivityが混同 | Worker = Agent + AgentThread + TeamMembership。commandだけをActivity化 |

## Scope/YAGNI修正

- DB Utility Processは固定採用せず、Phase 0計測後にMain保持とのADRを決める。
- Phase 3 production adapterはno-toolsかつ実効OS sandboxを満たす構成だけをManagedとする。
- Phase 3.5はContext minimumとBackground domain/mockまで。実background executionはPhase 4へ移す。
- monitor、scheduler、restart-durable activity、MCP、Workspace restore/Safe rewindはPublic Beta候補。
- 初版eventはschemaVersion、decoder、watermarkまで。汎用upcaster/checksum frameworkは必要になるまで作らない。
- RuntimeHost/ThreadActorはlazy activation、idle passivation、global process budgetを持つ。

## 残るPhase 0判断

以下は4つの判断群であり、成立証拠は`docs/PRODUCT_AND_TECHNICAL_DESIGN.md` §18と`tasks/IMPLEMENTATION_PLAN.md` Phase 0に定義した5 workstream・12実測項目で確認する。

1. production runtime adapterとOS sandbox capability matrix。
2. SQLiteをMainに置くかDB Utility Processへ置くかのp95/p99計測。
3. ChatSurface transition方式とCanvas LOD閾値。
4. 各OSでのprocess tree、filesystem root、network denialの実証方法。

## 最終評価

| 観点 | 点数 | 理由 |
|---|---:|---|
| 完全性 | 9.2 | agent loop、Team、UI、復旧、security enforcementまで追跡可能 |
| 一貫性 | 9.1 | DB/Actor、Thread/Turn/Item、Worker/Activityの正本を統一 |
| 実現可能性 | 8.8 | async effect/outbox、process budget、release cutを具体化 |
| セキュリティ | 9.0 | provider egressとOS sandboxを含む複層境界を仕様化 |
| テスト可能性 | 9.2 | dedup、epoch、sandbox、artifact、adversarial条件をacceptanceへ接続 |
| 総合 | 9.1 | Phase 0 spikeを条件に実装開始できるreviewed baseline |

## 結論

参照repositoryの機能をそのまま合成せず、protocol/actor/tool registry/persistenceの強い構造を採用し、Electron・Team Canvas固有の脅威には追加hardeningを置いた。設計上の未決定はPhase 0で実測できる4件へ限定されている。
