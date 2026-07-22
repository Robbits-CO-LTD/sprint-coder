# vibe-editor3 実装計画

- 計画ID: VE3-PLAN-001
- 作成日: 2026-07-20
- 前提設計: `docs/PRODUCT_AND_TECHNICAL_DESIGN.md`
- 方針: vertical sliceで常に起動可能な状態を保ち、Teamは安定したChat/Run基盤の上へ実装する

## 1. 全体ロードマップ

| Phase | 目的 | 完了成果 | 目安 |
|---|---|---|---|
| 0 | 技術的不確実性の除去 | Electron spike、ADR更新、計測結果 | 3–5日 |
| 1 | 安全なElectron骨格 | signed前段package、sandboxed window、CI | 4–6日 |
| 2 | 永続Task Chat | Sidebar、Chat、Composer、SQLite復元 | 8–12日 |
| 3 | Runtimeと生成表示 | streaming Run、stop、event log | 8–12日 |
| 4 | Tool・承認 | Command Card、PermissionBroker、Approval | 8–12日 |
| 5 | Team domain | Leader/Worker lifecycle、message routing | 8–10日 |
| 6 | Team Canvasとmotion | shared surface、spawn、camera、cable | 10–15日 |
| 7 | Hardening | recovery、a11y、performance、security | 8–12日 |
| 8 | Release | signing、update、beta、docs | 5–8日 |

期間は1人の実装目安であり、日付約束ではない。Phaseごとにdemo可能なacceptance gateを通してから次へ進む。Phase 0の3–5日は調査timeboxであり、未通過Gateを推測で承認する期限ではない。期間内に成立証拠が得られなければ、fallback採用、Phase 0延長、またはNo-GoをADRへ記録する。

Release cutは `Prototype = Phase 0`、`Chat Alpha = Phase 1–3`、`Team MVP = Phase 4–6 + 必須hardening`、`Public Beta = Phase 7–8` とする。

### 1.1 要件トレーサビリティ

Issue作成時は対象IDを行単位へ展開し、次の対応を維持する。要件、実装Slice、acceptance、test、release cutのいずれかが未記入のIssueはReadyにしない。

| 要件群 | 主な実装Phase | 必須検証 | 最初のrelease cut |
|---|---|---|---|
| FR-CHAT / FR-COMP / FR-SET | 1–3 | Chat component、IPC integration、再起動復元、keyboard E2E | Chat Alpha |
| FR-RUN | 3–4 | state/sequence contract、stream/cancel/recovery E2E、performance | Chat Alpha（tool非依存）/ Team MVP（全体） |
| FR-APR | 4 | policy contract、表示内容=ExecutionSpec、deny/expiry/adversarial E2E | Team MVP |
| FR-TEAM | 5–6 | lifecycle/delivery contract、budget/capability、3 Worker E2E | Team MVP |
| FR-CAN | 0,6 | interaction/component、LOD performance、keyboard/list fallback | Team MVP |
| NFR-PERF / NFR-REL | 0,3–7 | budget計測、crash/replay/backup/process termination | 各cutの対象経路 |
| NFR-A11Y | 2,6–7 | keyboard、contrast、screen reader、reduced motion | Team MVP必須subset |
| NFR-SEC | 0–4,7–8 | sandbox probe、IPC/path/egress adversarial、hardening audit | Team MVP必須subset |

## 2. Repository構成案

```text
vibe-editor3/
├─ apps/desktop/
│  ├─ src/main/             # Electron Main、services、IPC
│  ├─ src/preload/          # narrow typed bridge
│  ├─ src/renderer/         # React UI
│  ├─ forge.config.ts
│  └─ vite.*.config.ts
├─ packages/contracts/      # Zod schema、public types、event versions
├─ packages/domain/         # pure state machines、policy、reducers
├─ tests/fixtures/          # runtime streams、large tasks、DB snapshots
├─ docs/                    # product、architecture、security、release
├─ tasks/                   # plans、design reviews
└─ package.json             # npm workspaces
```

初期packageは `apps/desktop`、`contracts`、`domain`だけに固定する。UIはrenderer配下、Runtimeはmain/utility配下から始める。抽出は2 consumer以上、循環依存解消、独立build/testのいずれかを満たす場合だけ行う。依存方向は `main/preload/renderer → contracts`、`main/renderer → domain`、`domain → 外部依存なし` とする。

## 3. Phase 0 — Architecture spikes

各spike作業単位は半日〜1日でtimeboxし、完成ではなく採用可否、撤退条件、ADRを成果にする。5 workstream・12実測項目を3–5日内で並行評価する想定だが、Gate未通過を期限だけでAcceptedにしない。優先順位はpackage/native SQLite、Runtime cancel・sandbox・Broker enforcement、ChatSurface/Canvasの順。

### 3.1 Electron/Forge spike

- [ ] Electron ForgeのTypeScript templateから完全に新規の最小appを作る。
- [ ] Renderer sandbox、context isolation、custom protocol、CSPを設定する。
- [ ] Forge Vite pluginでdevelopment、package、makeをmacOSで実行する。
- [ ] GitHub ActionsでWindows、macOS、Linuxのpackage smokeを実行する。
- [ ] Fuses pluginとsecurity lintを導入し、設定をreportへ残す。
- [ ] Vite pluginのexperimental制約と破壊変更追従コストを記録する。

Gate: 3 OSでwindow起動、preload typed ping、package smokeが通る。失敗時はWebpack pluginへ切り替えるADRを作る。

### 3.2 Persistence spike

- [ ] better-sqlite3をDB Utility Processへ導入し、Main直置きとのIPC latency差を測る。
- [ ] native module unpack/rebuildをpackage後のbinaryで確認する。
- [ ] WAL、transaction、migration、1万event append/replayを計測する。
- [ ] 強制終了後にDB integrity、最後のcommit、chunk orphan reconciliationを確認する。

Gate: package版でmigrationとread/writeが成功し、1万event replayが500ms目標内。未達ならindex/projectionを調整する。

### 3.3 Canvas/motion spike

- [ ] React Flow custom nodeへ実寸ChatSurface prototypeを置く。
- [ ] 10 node × 200 messageのLOD表示を計測する。
- [ ] normal layoutからCanvasへ同一DOM instanceを移すFLIP prototypeを作る。
- [ ] Worker focus camera、user interruption、reduced motionを試す。
- [ ] Bezier cableとpacket pulseをSVG overlayで試す。

Gate: 50fps目標、focus/selection維持、nested scrollingの操作衝突が解消される。

### 3.4 Runtime spike

- [ ] 最初のproduction runtimeを明示選定し、stream、Tool Broker、approval callback、cancel、resume、usage、parallel limitのcapability matrixを作る。
- [ ] UtilityProcess内adapterからfixture streamを流す。
- [ ] cancel、crash、large output、out-of-order eventを検証する。
- [ ] macOS/Windows/Linuxのprocess tree終了方法を確認する。
- [ ] Broker bypass、secret非継承、旧runtimeInstance event拒否を攻撃fixtureで確認する。
- [ ] Managed候補について、Mainが外部観測するOS sandbox probeでworkspace外filesystem、direct process spawn、無許可の直接outbound networkを拒否できることを各対象OSで確認する。許可されたprovider通信は監査可能な制御経路だけを使う。
- [ ] `provider.egress` deny時にremote inferenceへfragmentが送信されず、自己申告ではなくnetwork観測と監査eventで確認できることを検証する。

Gate: start/stream/cancel/exitが正規eventへ変換され、Main/Renderer crashへ波及しない。Managedとして採用するにはBroker bypass、workspace外filesystem、direct process、無許可outbound network、provider egress denyのnegative testを全て通す。許可されたprovider通信は`provider.egress` policyと監査を通る。未達adapterは`trusted-unmanaged`へ分類し、通常presetと機密Taskから分離する。

### 3.5 Agent Kernel protocol spike

- [ ] `Task → AgentThread → Turn → Item`のIDとlifecycleをfixtureで検証する。
- [ ] ThreadActor mailboxでstart/queue/steer/interrupt/approvalを直列化する。
- [ ] User message commit前にMockRuntime requestが発生しないbarrier testを作る。
- [ ] ToolKindを分類として使い、immutable ToolCatalogSnapshotがprovider nameをToolId/version/schema digestへ固定できるか試す。
- [ ] Codex/Grokのraw fixtureをCanonicalAgentEventへ正規化する。

Gate: reference分析のADR-006〜009をAcceptedまたはSupersededへ確定できる。

## 4. Phase 1 — Electron foundation

### Slice 1.1: Boot and window

- AppKernel、single-instance lock、WindowManagerを実装。
- `app://` custom protocolでlocal renderer assetを配信。
- sandbox、navigation deny、window-open deny、permission denyを設定。
- preloadに `app.getInfo()` とhealth eventだけを公開。
- fatal initialization screenとlog directoryを用意。

Acceptance:

- development/package双方で同じwindowが起動する。
- Renderer devtoolsからNode/Electron APIへ直接アクセスできない。
- 不正navigation、window open、未知IPCが拒否される。

### Slice 1.2: Contracts and IPC router

- Zod schema registry、CommandEnvelope、PublicError、永続operations ledgerを実装。
- sender validation、request correlation、structured logを共通化。
- Preload APIの型生成または手動型同期testを用意。
- MessagePort subscription handshakeの最小実装。
- snapshot watermark + afterSeqの原子的subscription、port binding/closeを実装。
- resource/method命名、protocol capability handshake、experimental gateを実装。

Acceptance:

- malformed payload、unknown field、untrusted senderのtestが通る。
- subscribe ready前のeventを発生させないcontract testが通る。
- 同一operationIdの同一hashは結果を再送し、異なるhashは拒否する。

### Slice 1.3: CI baseline

- format、lint、typecheck、unit、package smokeをCI化。
- dependency license/SBOM、security lintを追加。
- artifact retentionとfailure log redactionを設定。

## 5. Phase 2 — Persistent Chat vertical slice

### Slice 2.1: Schema and repositories

- tasks、messages、workspaces、schema_migrationsを作る。
- migration runner、backup、transaction wrapperを実装。
- TaskRepositoryとMessageRepositoryをPersistenceClient越しにintegration testする。Main保持/DB Utility Processの採用結果に依存させない。
- development fixture loaderを用意する。

### Slice 2.2: Application shell

- warm dark token、typography、spacing、focus ringを実装。
- Sidebar、Task header、empty state、settings entryを実装。
- resizable Sidebarを追加するが、初期幅264pxと最小220pxを守る。
- Task listをvirtualized表示し、search/pin/archiveを追加。

### Slice 2.3: ChatSurface and Composer

- SurfaceHeader、Timeline、ContextBar、Composerを実装。
- User/Assistant/System message rendererを実装。
- Markdown sanitizer、code block、copy、file referenceを実装。
- Composer keyboard、multiline、draft persistenceを実装。
- Model/effort/access summary menuを実装。
- Workspace選択はOS dialogをMain経由で実装し、canonical path保存とchip表示だけを行う。列挙/read/writeはPhase 4まで禁止。
- Phase 2末尾にdeterministic mock echo/streamを接続し、Assistant応答を含むChatとして評価する。

Acceptance:

- 起動 → Task作成 → message保存 → app再起動 →同内容復元。
- ChatSurfaceがfull pageとfixed-size harnessの両方で同じtest suiteを通る。
- keyboardだけでTask作成、入力、送信、履歴移動ができる。

## 6. Phase 3 — AgentThread、Runtime、streaming Turn

### Slice 3.1: Thread / Turn / Item event model

- agent_threads、turns、items、turn_events、input_queue tableとversioned event schemaを追加。
- Turn state machine、event reducer、projectionを実装。
- snapshot + sequence gap recoveryを実装。
- event schemaVersion、forward-compatible decoder、projection watermarkを最初から実装する。汎用upcaster/checksum frameworkはmigration要求が生じるまで作らない。
- app起動時のactive Turn interruption処理を追加。
- ThreadActorRegistryと1 Thread 1 mailboxを実装。
- Actorは外部I/OをawaitせずEffectを発行し、revision付きinternal commandで結果を再投入する。idle passivation/lazy rehydrateを実装。
- Queue、Steer(expectedTurnId)、Stop & Sendを実装。
- dispatch_outboxを`dispatchPending → dispatched(runtimeInstanceId/attemptId) → started`で実装し、restart時はpendingだけ再送、dispatched不明はinterruptedへ倒す。

### Slice 3.2: Mock runtime end-to-end

- deterministic MockRuntimeAdapterを実装。
- Turn start → stage → token → completedをMessagePortでstream。
- slow、failure、cancel、approval fixtureを用意。
- renderer refresh/reconnectで途中eventを復元。
- persist-before-inference barrierをMockRuntime request captureで検証。

### Slice 3.3: Production adapter

- Runtime probe、launch、protocol parser、normalizerを実装。
- Main RuntimeClient / Utility RuntimeHostのserializable protocol、ack window、backpressure、heartbeat、exit mappingを実装。
- secret/environment injectionをMainのSecretStore経由に限定。
- Managed modeではTool Broker非対応Runtimeを起動拒否し、read-only/unmanaged modeを分離。
- Phase 4以前のproduction adapterはOS sandbox probe済みno-tools/read-only profileだけを許可し、最小deny-only Brokerで全tool requestを拒否する。prompt上のread-onlyだけなら`trusted-unmanaged`扱いにする。
- provider raw eventをCanonicalAgentEventへ変換し、raw payloadをRendererへ出さない。
- productionでraw provider payloadを永続化しない。
- provider固有errorをPublicErrorへ変換。

### Slice 3.4: Turn UI

- stage timeline、elapsed time、compact completion summaryを実装。
- streaming Assistant responseを実装。
- Stop/canceling/canceled/interrupted/retryを実装。
- screen readerにはstage変更だけをannounce。
- queued input、Steer、Stop & Send、active Turn IDをChat内で表示。

### Slice 3.5: Context minimum and background domain

- ContextLedger、fragment trust、token estimate、hard capを実装。
- compaction event、replacement projection、source watermarkを実装。
- BackgroundActivityのschema/state machineとdeterministic mockだけを実装する。実process、heartbeat、wakeupはPhase 4へ送る。
- context inspectorに全Timelineと次Turn投入contextを分けて表示。

### Slice 3.6: Intelligence Loop baseline

- StepSnapshotへmodel、effort、context/tool digest、policy epoch、workspace/contract revisionを保存する。
- model→mock tool→result→modelを同一Turnで反復し、Phase 3 production adapterではtoolをdenyする。
- Context Compilerへworkspace rules、world-state diff、history正規化、tool境界を守るcompactionを実装する。
- answer-only/mock-tool corpus runnerの骨格だけを作り、coding casesはPhase 4.7からgate化する。

Acceptance:

- token先頭欠落なし、重複なし、sequence gap復旧あり。
- cancelからprocess停止までのp95を定義・計測する。
- 強制終了後、partial answerとTurn eventが復元される。
- dispatchPendingだけが安全に再送され、dispatched成否不明は二重推論せずinterruptedになる。

## 7. Phase 4 — Tools, terminal output, approvals

### Slice 4.1: PermissionBroker

- Capability、resource scope、preset expansionをdomainへ実装。
- Ask/Auto/Fullのpolicy engineとaudit reasonを実装。
- session grant expiryとrevocationを実装。
- capability lattice、resource set、operation、provider egress、sandbox profile、policyEpochを実装し、revoke/downgrade時に子とbackgroundを停止・再評価する。
- path realpath、symlink、TOCTOU guardを実装。
- managed deny → project deny → parent ceiling → mode ceiling → sandbox → grant → allow → reviewerの評価順を実装。
- shellの全segmentを解析し、prefix allowやparse不能commandを自動許可しない。

### Slice 4.2: Tool Registry

- ToolId、閉じたToolKind、ToolDefinition、ToolImplementationを実装。
- Built-in、CommandRunnerを同じTool Brokerへ登録する。MCP用のregistry interfaceだけを予約する。
- Team MVPはBuilt-inとCommandRunnerを登録し、MCPはPublic Betaへ送る。
- Turnごとにimmutable ToolCatalogSnapshotを作り、provider name → ToolId/version/schema digestを固定する。ToolKindは分類にだけ使い、単独で実装を解決しない。
- tool schema version、side effect、risk、required capabilityをcontract test。

### Slice 4.3: Approval flow

- approvals tableとstate machineを追加。
- Runtime request → broker → persisted approval → UI → decision → runtime responseを接続。
- once/task/denyを実装。
- stale approval、double response、run canceled中responseをtest。

### Slice 4.4: CommandRunner

- immutable ExecutionSpec、absolute executable、argv/cwd identity/env delta/stdin/shell digestを実装。
- stdout/stderr sequencing、batching、chunk persistenceを実装。
- cooperative cancel、grace period、process tree killを実装。
- Unix process group、Windows Job Objectまたは採用代替を実証し、PID/startTime leaseでorphan誤終了を防ぐ。
- persistent processはrandom lease、OS process handle/job、binary digest、IPC challengeで同定し、restart後の自動再接続をdefault無効にする。
- ANSI sanitizerとoutput virtualizationを実装。

### Slice 4.5: Command and Approval cards

- collapsed command summary、live last lines、expanded outputを実装。
- purpose、cwd、command、risk、exit、durationを表示。
- Approval Cardのprimary/secondary/destructive actionsをkeyboard対応。
- Auto modeで自動許可した理由をcompact audit rowに表示。
- Auto reviewerをno-tools/no-network、allow-once限定、high-risk deny、immutable input digest監査で実装。

### Slice 4.6: Background execution

- durable completion ledger、deliveryId dedup、branch/policy/context epoch、safe-point wakeupを実装。
- deliveryとTurnAcceptedを同一transactionで接続し、at-least-once delivery / exactly-once effectを保証する。
- restart-durable process、monitor、schedulerはPublic Betaへ送る。

### Slice 4.7: Edit Transaction and Standard Assurance

- file identity/content hash/sizeを持つFileRevisionTokenをread結果へ付与する。
- structured patchをdefaultにし、全anchor・overlap・revisionを先に検証する。multi-file commitはjournalと補償restoreを持つEdit Sagaとし、厳密なatomicityを主張しない。
- baselineからadd/update/delete/renameを集約するTurn diffを実装する。
- plan-liteのAcceptance Contractとcriterion別Evidence Ledgerを保存し、gating evidence不足時はcompletedを拒否する。
- Standard profileは決定論的verificationとrepair最大1に限定する。provider/infra failureはrepair budgetを消費しない。
- locate/edit/debug/multi-file/safety/recovery/context/reviewを含む30-case corpusを固定し、Standard profileのbaselineを記録する。

Acceptance:

- 表示したcommandと実行したargvがcontract testで一致する。
- 10MB outputでも入力・scrollが固まらない。
- workspace外writeとsymlink escapeが必ず承認または拒否になる。
- Full accessでもcredential loggingとRenderer直接権限は有効化されない。
- remote providerへのcontext送信は`provider.egress` policyで拒否・監査でき、local-only Taskから外部接続できない。
- Auto reviewerはtranscript/tool outputのprompt injection、timeout、schema failure、high-risk requestを許可しない。
- 30-case corpusでgating criteria、false completion、unnecessary diff、repair round、costを記録し、未解決High/Criticalを0件にする。

## 8. Phase 5 — Team domain without Canvas

### Slice 5.1: Team persistence

- teams、agents、team_messages tableとmigrationを追加。
- Team/Worker/message delivery state machineを実装。
- TaskからTeamへのpromotion commandを実装。
- taskIdとleader agent identityの継続をtest。
- WorkerをAgentThreadとして保存し、parent capability ceilingとcontext inheritance policyを記録。
- WorkerをAgent + AgentThread + TeamMembershipとして保存し、WorkerそのものをBackgroundActivityとして扱わない。

### Slice 5.2: TeamCoordinator

- DB transactionでglobal/team/workerの費用、token、時間、tool call、spawn slotを実行前reserveし、完了時settleする。
- Worker start queueとbackpressureを実装。
- Coordinatorだけがsource/target envelopeを発行し、runtime申告identityを信用しない。
- Leader→Worker messageをpersist-before-dispatchで配信。
- idempotent retry、ack、timeout、worker crashを実装。
- Worker→Leader resultを同じdelivery modelで戻す。
- Worker completionをstatus/summary/artifacts/verification/risksのschemaで検証。
- write-capable Workerの専用worktree作成、base HEAD記録、cleanup policyを実装。
- worktreeはchange isolationに限定し、OS sandbox root、sanitized Git、artifact scan、Brokerによるreview済みpatch適用を必須化。

### Slice 5.3: Team List View

- Canvas前に正式なaccessible Team List Viewを作る。Canvasと同じselector/commandを使う別projectionとする。
- worker role、status、current task、usage、stopを表示。
- message timelineからsource/targetへ移動できるようにする。

Acceptance:

- 3 Workerを順次起動し、それぞれへ依頼し、結果をLeaderへ戻せる。
- app再起動後、実行中Teamをinterrupted/pausedとして安全に復元。
- Worker間直接messageがdomainで拒否される。
- hard cap、max depth=1、rate limit、stop-allでprocess treeまで停止できる。

## 9. Phase 6 — Team Canvas and cinematic motion

### Slice 6.1: Canvas base

- React Flow viewport、pan/zoom、selection、fit/focusを実装。
- Canvas view/node positionをrevision付きで保存。
- ChatSurface custom nodeとLODを実装。
- Canvas keyboard navigationとlist fallbackを接続。

### Slice 6.2: Chat → Leader morph

- SurfaceLayerとlayout ownership modelを実装。
- ChatSurface instanceを維持するportal/FLIP transitionを実装。
- focus、selection、scroll position、draftを遷移前後で保持。
- animation interruptionとreduced motion variantを実装。

Acceptance:

- domain identity、draft、IME、selection、scroll、streamの連続性を確認する。同一instance方式の場合だけmount count=1も確認。
- transition中にRun streamが続いても欠落・layout jumpがない。
- reduced motionでは560ms以内の大移動を行わない。

### Slice 6.3: Worker spawn and camera director

- collision-aware placementとposition reservationを実装。
- staggered fade/scale/blur spawnを実装。
- CameraDirectorのownership `system | user` を実装。
- nodeを65–75%占有でfocusし、カード寸法は不変にする。
- user inputで自動animationをcancelし、そのviewportを維持。

### Slice 6.4: Communication cable

- transient delivery overlayをCanvas transformと同期。
- cubic Bezier、draw-on、packet pulse、receive glow、fadeを実装。
- team_message stateとanimation lifecycleを接続。
- 同時delivery、offscreen target、zoom/pan中をtest。
- reduced motionでは静的な短時間highlight + textual eventに置換。

Acceptance:

- Worker雇用時に線が出ない。
- Leader送信時だけ正しいsource/target間に曲線が出る。
- delivery ackと視覚表現の因果が一致する。
- focus後に自動でLeaderへ戻らない。

## 10. Phase 7 — Hardening

### Team MVP blocking subset

Phase 4–6完了後、次を全て満たすまでTeam MVPとしてreleaseしない。Phase 7のその他項目はPublic Betaへ送れる。

- active Turn/Teamのcrash recoveryと、再起動後の安全な`interrupted|paused`復元。
- Command/Runtime/Workerのprocess tree停止とorphan検出。
- Managed RuntimeのOS sandbox、Broker bypass拒否、workspace外filesystem、無許可outbound network、provider egress denyの対象OS実証。
- IPC sender/payload、path traversal、Markdown/ANSI/URL、secret redactionのadversarial test。
- keyboard-only golden path、Canvasと同等のList View、contrast、reduced motion。
- DB migration、backup/restore、1万event projection復元。
- Composer p95、stream batching、10 Worker Canvas LODのperformance budget。
- Phase 4.7のStandard Assurance 30-case corpus baseline。

### 10.1 Reliability

- DB corruption simulation、backup restore、安全モードを実装。
- runtime crash stormへcircuit breakerを追加。
- schemaVersion decoderと古いfixtureのcompatibility test。必要なversion差分だけ個別migrationを追加。
- multi-click、IPC retry、window reloadのidempotencyをfuzz test。
- Conversation rewindとbranch head切替を実装。
- Workspace restore、Safe rewind saga、emergency checkpointはPublic Beta candidateとしてfeature flag下で検証し、Team MVP gateから外す。
- Verified profileとしてisolated read-only Verifier、repair最大3、gap fingerprint、strategy change、pause/resumeをfeature flag下で実装する。
- 同一gapが2回続いた場合は同じ修正を反復せず、構造変更または明示pauseへ遷移する。

### 10.2 Performance

- React Profilerとtraceでrender hot pathを修正。
- Timeline virtualization、memoized selector、stream batchingを調整。
- Canvas LOD thresholdをfixtureで決める。
- startupを計測し、DB openとruntime probeを遅延化。

### 10.3 Accessibility

- axe component testとmanual keyboard audit。
- VoiceOver/NVDAの主要golden pathを確認。
- contrast、200% zoom、reduced motion、high contrastを確認。
- Canvasと同等情報をlist viewで提供。

### 10.4 Security

- Electron公式security checklistを項目ごとに証跡化。
- IPC sender/payload/property-based test。
- Markdown、ANSI、URL、path traversalのadversarial fixture。
- secret redactionとsupport bundle scan。
- packaged appへElectronegativity/security lint。
- dependency auditだけに頼らず、Fusesとruntime capabilityをmanual review。

## 11. Phase 8 — Release

### 11.1 Packaging

- macOS arm64/x64 signing + notarization。
- Windows x64 signing + installer。
- Linux dev artifactとdistribution方針文書。
- app data location、uninstall時保持、backup/exportを文書化。

### 11.2 Update

- macOS/Windows autoUpdaterをsingle-flightで実装。
- publisher/certificate identity、channel、monotonic version、metadata/hash、redirect/domain allowlistを検証し、失敗時は適用しない。
- beta/stable channel、download status、restart laterを実装。
- active Turn中はautomatic restartを禁止。
- rollback不能migrationを含むreleaseは段階配布とbackupを必須化。
- schema compatibility range、migration前backup整合確認、旧binaryのnew-schema拒否、expand→migrate→contractを検証。

### 11.3 Beta gate

- 主要E2Eを対象OS実機で実行。
- 10個以上の実Taskでdogfood。
- Phase 4.7で固定した30-case corpusを同一case/seed/config記録で再実行し、task success、false completion、unnecessary diff、repair round、costをTeam MVP baselineと比較する。
- crash-free session、startup、Run completion/cancel、approval rateをprivacy-preservingに計測するか、telemetryなし運用を明示選択。
- onboarding、permission説明、support bundle手順を完成。

## 12. Issue分割

1 Issue = 1 vertical sliceまたは1 cross-cutting gateを基本とする。推奨Epic:

- E1 Electron Foundation
- E2 Persistent Chat
- E3 Runtime & Streaming
- E4 Permissions & Tools
- E5 Team Orchestration
- E6 Team Canvas & Motion
- E7 Reliability & Security
- E8 Distribution

各Issue必須項目:

- 対象FR/NFR。
- user-visible acceptance criteria。
- domain/IPC/DB変更。
- failure/recovery state。
- security capability。
- test planとperformance budget。
- out of scope。

## 13. 品質ゲート

PRごと:

- format、lint、TypeScript strict。
- 変更domainのunit/contract test。
- IPC変更時はMain/Preload/Renderer三者の同期test。
- DB変更時はfresh + previous fixture migration test。
- UI変更時はkeyboard、loading、empty、error、reduced motion。
- screenshot差分は意図をreviewする。

Phaseごと:

- demo scriptを人が実行する。
- performance budgetを計測する。
- threat model差分をreviewする。
- 未解決のHigh/Critical defectを0件にする。
- ADRと設計書を実装結果へ同期する。

Releaseごと:

- 3 OS package smoke、対象正式OS E2E。
- signing/notarization。
- clean installとupgrade install。
- DB backup/restore。
- auto-update staging test。
- SBOM、license、security checklist。

## 14. リスク登録簿

| ID | リスク | 兆候 | 対策 | Owner phase |
|---|---|---|---|---|
| R1 | Forge Vite experimental破壊変更 | package/upgrade failure | version pin、Phase 0、Webpack fallback | 0–1 |
| R2 | native SQLite ABI不整合 | package版だけ起動失敗 | 3 OS CI、auto-unpack、rebuild test | 0–2 |
| R3 | ChatSurface共有が複雑 | focus喪失、二重DOM | portal spike、identity test、single owner | 0,6 |
| R4 | Canvas内large Chatが重い | pan/zoom frame drop | LOD、virtualization、visible-only render | 0,6–7 |
| R5 | Runtime provider差異 | stage/cancel不整合 | adapter normalizer、capability probe | 3 |
| R6 | command processが残る | zombie、resource leak | OS別process tree test、supervisor | 4,7 |
| R7 | approval表示と実行内容差 | trust/security incident | argv正本、immutable request、contract test | 4 |
| R8 | event log肥大 | startup/DB size増大 | chunk、projection、retention/export | 3,7 |
| R9 | Team runaway cost | Worker無限起動 | budget、slot、max worker、stop all | 5 |
| R10 | motion sickness | 操作困難 | reduced motion、user interrupt、上限560ms | 6 |
| R11 | Playwright Electron不安定 | flaky release gate | contract/component重視、OS smoke補完 | 0,7 |
| R12 | updaterで実行中作業消失 | restart中断 | active Turn guard、restart later | 8 |
| R13 | Thread command race | 古いSteerや二重Turn | actor mailbox、expectedTurnId、operation ledger | 3 |
| R14 | context膨張・prompt injection | cost増大、指示汚染 | trust分類、hard cap、compaction ledger | 3,7 |
| R15 | child権限昇格 | Plan/read-only中のwrite | parent capability ceiling、spawn contract | 5,7 |
| R16 | rewind不完全 | 会話とfileの不一致 | separate commands、preview、emergency checkpoint | 7 |
| R17 | provider egress漏洩 | local-only dataがremote推論へ送信 | 独立egress capability、fragment scan、provider trust policy | 0,3,4 |
| R18 | worktreeをsandboxと誤認 | Workerが親workspaceやcredentialへ到達 | OS sandbox root、sanitized Git、artifact acceptance | 0,5,7 |

## 15. 最初の15 Issue候補

1. `chore: Electron Forgeの3 OS spikeを構築する`
2. `feat(security): sandboxed windowとcustom protocolを実装する`
3. `feat(ipc): typed IPC routerとsender検証を実装する`
4. `feat(persistence): SQLite migration基盤を実装する`
5. `feat(chat): Task作成と履歴Sidebarを実装する`
6. `feat(chat): 共通ChatSurfaceとComposerを実装する`
7. `feat(agent): Thread/Turn/Item protocolを実装する`
8. `feat(agent): ThreadActorとauthoritative input queueを実装する`
9. `feat(run): persist-before-inferenceとmock streamingを実装する`
10. `feat(runtime): production RuntimeHost adapterを実装する`
11. `feat(context): ContextLedgerとcompactionを実装する`
12. `feat(tools): ToolCatalogSnapshotとTool Brokerを実装する`
13. `feat(permissions): PermissionBrokerと承認flowを実装する`
14. `feat(command): live Command Cardとprocess cancelを実装する`
15. `feat(rewind): Conversation rewindとbranch headを実装する`

Team Canvas Issueは上記のChat、Run、Permission gate完了後に作る。先にmotionだけをproduction UIへ入れない。

## 16. 実装開始時のチェックリスト

- [ ] Phase 0の対象OSとproduction runtimeを確定する。
- [ ] Git repositoryを初期化し、branch protectionとCIを設定する。
- [ ] package managerとNode/Electron support policyを決める。
- [ ] design docを`Approved`へ更新する。
- [ ] telemetryを導入するか、導入しないかを明示決定する。
- [ ] code signing identityとrelease repositoryを準備する。
- [ ] 最初のIssueへFR/NFRとacceptance criteriaを転記する。
