# Round 2: Chat Alphaゲート正式通過(2026-07-22開始)

## Issue #307 再発修正（2026-08-22）

### 計画

- [x] 実Ollama 0.32.15と対象Gemma 4モデルで、preload・通常応答・tool call・stream payloadを測定する
- [x] `delta.reasoning` が正規化されず45秒の最初の応答監視に届かない根本原因を確定する
- [x] OpenAI互換stream normalizerへ後方互換のreasoning正規化を追加する
- [x] focused test、desktop typecheck、実Ollama構造確認を実行する
- [x] 固定 `x-ai/grok-4.6` で候補commitをレビューし、検証済み指摘を反映する
- [ ] PR、必須チェック、ReviewBOT、Issue closeoutを処理する

### Next Steps

1. PRと外部レビューを処理する。
2. 必須チェックを最新commitへ固定する。
3. マージ承認が必要な地点で停止する。

### 進捗

- 実装: `delta.reasoning` を既存の `reasoning_delta` へ正規化し、互換別名の二重計上を防止。
- focused test: 30 PASS / 3 opt-in skip。
- desktop typecheck、対象lint、対象format: PASS。
- 実Ollama: 27 PASS / 2条件外skip。対象Gemma 4でpreload→応答→完了→解放、終了時loaded 0を確認。
- ReviewBOT指摘を反映: 同一文字列の互換別名だけを重複排除し、異なる`reasoning_details`は保持。

### Next Tasks

- PR作成後に必須CIとReviewBOTを確認する。

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
- [x] Codex Model選択UI / 実行設定
  - ローカルCodexの`models_cache.json`から表示可能モデルを動的取得し、Autoを含む選択肢をComposerへ追加
  - 選択値をSQLite settingsへ永続化し、Runtime Hostのimmutable start envelopeからCodex CLIの`--model`引数へ反映
  - Mainで一覧外Model IDを拒否し、Rendererには検証済みの表示名・説明だけを公開
  - Computer Use実機操作でGPT-5.6-Terra選択→実AI応答「モデル選択確認OK」→Electron再起動後の選択保持まで確認
- [x] Phase 4冒頭 / Slice 3.6 Intelligence Loop baseline
  - `intelligence_steps` migration v5とimmutable StepSnapshot(model/effort/context・tool digest/policy epoch/workspace・contract revision)を追加
  - Step lifecycle(`prepared→sampling→sampled→dispatching→toolsCommitted→completed`)をdomain state machineとSQLiteで強制
  - Context Compiler minimum(workspace rule authority、world-state diff、history authority正規化、tool call/result pairを壊さないtrim)を追加
  - MockRuntimeを同一Turn内の`model→mock_echo→result→model` 2-Step loopへ接続。production Codex adapterのread-only profileは変更なし
  - answer-only/mock-tool 2-case corpus runner骨格と比較用digest/metricを追加。coding 30-case gateはSlice 4.7
  - workspaceの内容revisionはまだ追跡不能なためStepSnapshotへ`untracked:<canonical workspace identity digest>`を明示保存。FileRevisionToken/実revisionはSlice 4.7
  - 検証: typecheck/test(125件)/lint/format/E2E 4本 green、既存forge dev起動とE2E Electron実起動でsmoke済み
- [x] Slice 4.1 PermissionBroker
  - Capability lattice、Ask/Auto/Fullの個別rule展開、managed deny→reviewerまでの評価順、Task grant expiry/revocation、policyEpoch/CAS/outboxを実装
  - PathGuardをrealpath/symlink chain/inode identity/handle-bound readへ固定。protected root・credential・app-private分類、traversal/escape/TOCTOUをfail-closed化
  - reviewer allow-onceをrequest facts SHA-256、input/spec digest、epoch、high-risk deny、永続one-time consumeへbinding。auditへ絶対pathを保存しない
  - Shellは全segment parse/evaluateをMainの強制入口にし、CommandRunner完成前は全segmentをmanaged deny。write/createもEdit Transaction完成前は実行境界でfail-closed
  - Access mode UI、Main所有Full確認、Task header表示、model/access設定の再起動復元E2Eを追加
  - 検証: typecheck/test(207件)/lint/format/E2E 5本 green、Computer UseでAccess変更・Full native確認・Codex model選択を実機確認
- [x] Slice 4.2 Tool Registry
  - provider/namespace/name/versionを固定するToolId、closed ToolKind、schema/side-effect/risk/capability/targetを持つToolDefinitionを実装
  - provider compatibility・workspace binding・priorityで解決し、Turnごとにdeep-freezeしたToolCatalogSnapshotを作成。ModelSamplerとRuntime protocol v3へ明示伝達
  - Main ToolBrokerでsnapshot外name、epoch変更、Turn終了、input TOCTOU、callId replay、MCP接続をfail-closed化。CommandRunnerは同一registryに予約登録しSlice 4.4まで実行不可
  - Codex production Runtimeは暗号学的に検証したempty catalogのみ受理し、read-only/no-toolsを維持
  - 検証: typecheck/test(234件)/lint/format/E2E 5本 green、Computer UseでCodex model候補8件と選択状態を実機確認、独立要件/テストレビューGO
- [x] Slice 4.3 Approval flow
  - SQLite migration v12/v13へApprovalのimmutable binding、capability別requirement key、`pending→resolved/canceled/stale/expired` CAS、challenge/revision/epoch/expiry、once permit・Task grantを追加
  - Runtime request→PermissionBroker→永続commit→MessagePort→Approval Card→decision→Runtime tool-resultを接続。commit前通知、二重決定、Task/Turn差し替えをfail-closed化
  - Chatへ対象・影響・実行内容・riskと「今回のみ許可 / Task中許可 / 拒否」を表示。Rendererは検証済みDTOとdecisionだけを送信しauthority factsを保持しない
  - 拒否はerror tool-resultとしてIntelligence Loopへ戻し、Runを失敗させず代替回答を継続（FR-APR-06）。CommandRunnerはSlice 4.4まで実行不可を維持
  - 検証: typecheck/test(329件)/lint/format/E2E 6本 green。Computer UseでGPT-5.6-Terra表示、承認カード、拒否後の完了回答を実機確認
- [x] Slice 4.4 CommandRunner
  - immutable `ExecutionSpec`（absolute executable + argv、shellなし、stdin閉鎖、制御environment、Workspace cwd identity）を承認前に固定。実行ファイルはcanonical path/device/inode/metadata/content digestを実行直前に再検証
  - SQLite migration v14へ`prepared→starting→running→exited/canceled/failed/interrupted`とglobal seq付きstdout/stderr chunkを追加。spawn前の`starting` commit、再起動時terminal event、拒否時terminal化、commit-before-publishを実装
  - stdout/stderrは100ms/64KiB batch、async sink backpressure、16MiB cap、UTF-8境界、ANSI/control sanitize、保存前credential redaction、process `close`/pipe drain後のterminal commitを実装
  - cancelはUnix process group / Windows `taskkill /T`で協調停止→grace後強制停止。親が先に終了する孫残留fixture、sink failure、アプリ終了時drainを含めて回収
  - CommandRunnerをToolBroker/Approval/Intelligence Loopへ接続。承認対象はexact spec digest、OS sandboxなしのfull user authorityとして表示し、Workspace外・networkアクセス警告を追加
  - 検証: typecheck/test(354件)/lint/format/E2E 7本 green。model選択・再起動復元E2Eも同時通過
- [x] Slice 4.5 Command and Approval cards
  - SQLite migration v15/v16へCommand Card表示projection、content hash/byte integrity付きoutput paging、Auto reviewerのdecision/audit/one-time permit bindingを追加。権限決定・audit・permit・TurnEventを同一transactionでcommit
  - demo準拠のCommand Cardへpurpose/cwd/exact executable+argv/env delta/risk/status/exit/duration、collapsed tailとexpanded outputを表示。10 MiBの改行なし・dense newline出力をbounded rowへ投影し、入力とscrollを阻害しない構造へ固定
  - Approval Cardのprimary/task/denyをkeyboard操作可能にし、解決後はcompact audit rowへ縮約。challenge/permit secretはRenderer向けevent/list/responseからredact
  - Auto reviewerを固定local/no-I/O production reviewerとして分離し、allow-once限定、high-risk deny、timeout/schema/model failure fail-closed、immutable input/spec/Turn/call digest bindingとcache replay conflict検出を実装
  - Auto許可・拒否・reviewer失敗をeffective decision/source/outcome/model/template/request digest付きcompact auditとして永続表示し、再起動後も復元
  - 検証: typecheck/test(367件)/lint/format/E2E 7本 green、独立要件/テスト再レビューGO。Computer UseでApproval Cardをkeyboard拒否し、Runを失敗させずcompact auditへ遷移することを実機確認
- [x] Slice 4.6 Background execution
  - SQLite migration v17へbranch/policy/context epoch付きBackgroundActivityと`persisted→attached→runtimeAcked` completion ledgerを追加。completionIdをstable context fragment ID、owner/activity-bound SHA-256をdeliveryIdとしてat-least-once再送をdedup
  - immediate/nextSafePointは次のTurnAcceptedと同一transactionでattachし、manualは明示releaseまで保留。ACK前のTurn中断はpersistedへ戻し、workspace/goal/archive/policy epoch変更はquarantineして自動注入しない
  - Runtime protocol v4へbounded context fragmentと`started(acceptedContextFragmentIds)` ACKを追加。Mock/Codex双方でRuntime受理後だけruntimeAckedをcommitし、background/compactionはinstruction authority `none`として固定
  - background payloadは1 fragment 10k token未満・Turnあたり24 KBに制限し、保存前にANSI/control/bidi除去とcredential redaction、content hash再検証を実施。restart-durable process/monitor/scheduler自体は計画どおりPublic Betaへ延期
  - 検証: typecheck/test(374件、SQLite Electron ABI内31件)/lint/format/E2E 7本 green。rollback、restart再送、manual、epoch隔離、重複/conflict、prompt authorityを固定し、Computer UseでCodex/GPT-5.6-Terraのprotocol v4実AI応答「確認OK」を実機確認
- [x] Slice 4.7 Edit Transaction and Standard Assurance
  - [x] FileRevisionTokenをTask/Turn/policy epoch/identity/content hashへ束縛し、Turn開始時のruntime/model snapshotと同様に編集入力を固定
  - [x] structured patch全体のadd/update/delete/rename preflight、anchor/overlap/path collision/revision検証、opaque artifact-backed Edit Saga journalを実装
  - [x] journal-first materialization、source/destination absent/present観測、逆順補償、crash-unknown quarantine、strict persisted schema、stable Saga diff、restart recoveryを実装
  - [x] raw pre/post imageをSQLite/WAL/SHMから排除。app-private artifactはowner/hash/size/secret flagを束縛し、deterministic retry、quota、tamper/symlink/hardlink permission、partial pair cleanup、durable terminal GCを実装
  - [x] 非production S3a safe-point: typecheck/test(403件)/lint/format/E2E 7本 green、独立要件/テスト再レビュー CRITICAL 0 / HIGH 0
  - [x] 非production S3b lease safe-point: workspace実体identity、永続monotonic fence/CAS、Saga immutable binding、policy/clock/expiry fencing、startup Task quarantine、並行executor隔離を実装（migration v20〜v22）
  - [x] S4b1 NativeSafeFs non-mutation safe-point: Main-only N-API loader、component-wise no-follow root pin、root inode OS lock、append-only checksummed durable fence、同期invalidate、lock namespace/owner/mode検証、Electron ABI loadを実装。missing/corrupt/unsupportedはfail-closed、Windows backendとproduction mutationは未公開
  - [x] S4b2 durable Native mutation intent: migration v23、immutable temp/tombstone・artifact mode・exact bigint identity、lease/session/fence binding、全8 forward/compensation topology、multi-step順序、Saga paired CAS、restart recovery binding、v22 fail-closed migrationを実装。Native invalidation失敗時もquarantineをcommitして当該プロセスのmutation authorityをdisable
  - [x] S4b2 gate: typecheck/test(448件、desktop 186 + contracts 14 + domain 248、SQLite Electron ABI内61件)/lint/format/E2E 7本 green、最新コードで`npm start`とdev DB migration v23を確認、独立要件/テスト再レビュー CRITICAL 0 / HIGH 0
  - [x] S4b3a Native observe/stage: async N-APIで全endpoint pin→SHA-256/identity/mode/nlink観測→leaf/root再検証、journal temp限定の`O_EXCL|O_NOFOLLOW` staging、file/parent fsync、session generation線形化と完了後失効検証を実装。root replacement、raw traversal/任意leaf、symlink/hardlink/FIFO、collision、1 MiB invalidation raceをfail-closed化。独立再レビュー CRITICAL/HIGH/MEDIUM 0
  - [x] S4b3a gate: native addon Electron ABI rebuild、typecheck/test(455件、desktop 193 + contracts 14 + domain 248)/lint/format/E2E 7本 green、最新コードで`npm start`のmain/preload/runtime buildとElectron launchを確認
  - [x] S4b3b atomic effects/cleanup: add/delete/renameのkernel no-replace、updateのatomic exchange、全endpoint pre/post exact observation、session generation線形化、全parent fsync、journal temp/tombstone限定のexact/idempotent cleanupを実装。競合target、外部source/content改変、hardlink、raw malformed shapeをfail-closed化
  - [x] S4b3b gate: native addon Electron ABI rebuild、typecheck/test(464件、desktop 202 + contracts 14 + domain 248、Windows 1件skip)/lint/format/E2E 7本 green、`npm start`のmain/preload/runtime buildとElectron launchを確認。独立2系統レビュー CRITICAL 0 / HIGH 0
  - [x] S4b4: deterministic parent/leaf race・fault/crash harness、Saga executor wiring、packaged `app.asar.unpacked`実ロードとplatform gate（`mutation:false`・write tool非公開を維持）
    - 内部分割(2026-07-23 スコープ固定): 4.7a Native操作+staging=済(S4b1-S4b3a) / 4.7b add-update-delete-rename=済(S4b3b) / 4.7c 競合検知+crash復旧=済(S3a/S3b/S4b2) / 4.7d Saga executor wiring=済 / 4.7e packaged実ロード+platform gate=済 / 4.7f 統合テスト+完了確認=済
    - Later送り(記録): Windows/Linux write実証(ADR定義のCI必須、fail-closed維持で安全) / 3 OS CI実走・CI packaged smoke(remote未設定の環境依存) / 非決定論的外部rename raceの完全platform proof(post-observation+quarantine封じ込めで受け入れ条件充足、ADR「close or safely contain」準拠) / Verified profile(Phase 7) / restart-durable process・MCP(Public Beta)
    - 4.7d: NativeSafeFsEditEffectBoundaryをproduction EditSagaExecutor/restart recoveryへ接続。intent journal遷移、lease/session再検証、補償を実Native統合テストで確認。write ToolDefinitionは未登録
    - 4.7e: Node 24でdarwin arm64 packageを生成し、`app.asar.unpacked/native-safe-fs/build/Release/sprint_coder_native_safe_fs.node`を実ロード。probeは`available:true`かつ`mutation:false`で、platform gateは安全側へ閉じる。Node 26 Electron Packagerの停止はNode 24で回避
    - S4b4 harness: test専用addon分離・token認可barrier・kernel直前再検証・cleanup再ハッシュを採用し、コミット`2b4de59`
  - [x] Turn全体baseline diff集約、Acceptance Contract/Evidence Ledger、Standard repair最大1、30-case corpus baseline
    - Turn diff `3e109f8`、contract/evidence `e2f8402`、bounded repair `842e6f4`、30-case baseline `9898250`
- [x] Phase 4 acceptance gate: provider.egress policy/監査、local-only拒否、30-case corpus、未解決High/Critical 0を最終確認
  - provider egress `de7b2f8`。local-only/secret/revokeはRuntime dispatch 0、clean non-localはexact permit再検証後だけ送信し、全判定をpermission auditへ保存
  - 最終gate: typecheck/lint/format green、unit 508 pass + 1 platform skip、E2E 7件 exit 0、darwin arm64 package + unpacked addon probe green。独立production mutationは`mutation:false`のまま非公開

## Phase 5 実装進捗(2026-07-23)

- [x] Slice 5.1 Team persistence
  - SQLite migration v27へ`agent_threads`、`teams`、`agents`、`team_memberships`、`team_messages`とdelivery auditを追加。既存Taskへprimary threadとstable Leader Agentをbackfill
  - Task→Team promotionを冪等commandとしてMain/Preload契約へ公開し、taskId・primary thread・Leader Agent identityを維持
  - Team / Worker / message delivery state machineをdomainへ追加。WorkerはAgent + AgentThread + TeamMembershipとして保存し、parent capability ceilingとcontext inheritance policyを記録
  - Leader↔Workerだけを許可し、Worker間直接messageをdomain/persistenceの両境界で拒否。message sequenceと全delivery transitionを永続化
  - 検証: typecheck/lint/format green、unit 508 pass + 8 platform skip、v1→v27 migration、Electron ABI Team SQLite統合test green
- [x] Slice 5.2 TeamCoordinator
  - budget reservation/settle/release、hard cap、max depth=1、rate limit、delivery envelope/identity検証をdomain・migration v28・SQLiteへ実装
  - Worker startをTask単位queueで直列化し、persist-before-dispatch、最大3回retry/ack/timeout、completion schema検証、Worker→Leader resultを実装
  - process-tree停止、write-capable Worker用worktree作成/cleanup基盤、IPC/preload、startup paused/interrupted復元と未settle budget releaseを実装
- [x] Slice 5.3 Team List View
  - accessible Team List Viewへrole/status/current task/usage/stop/hire/stop-all/message timelineとsource/target focus移動を実装
  - promote→3 Worker順次起動→依頼→Leader結果→stop-all、および再起動paused復元をE2E化
- [x] Phase 5 acceptance gate
  - typecheck/format green、lint error 0（既存warning 1）、unit 527 pass + 8 platform skip、E2E 9/9 pass
  - Worker間直接message拒否、hard cap、max depth=1、rate limit、identity spoof、process tree停止、migration v1→v28を回帰テストで確認

---

# Chat Alpha骨格 実装TODO(commander運用)

- 対象: VE3-PLAN-001 Phase 1〜3のvertical slice(Chat Alpha骨格)
- 体制: Codex=backend / Sonnet=UI / Fable=指揮・監査
- 視覚基準: demo/index.html(2026-07-22ユーザー承認済み)

## 契約(Fableが確定)

- repo構成: 計画書§2どおり(apps/desktop, packages/contracts, packages/domain, npm workspaces)
- preload公開API `window.sprintCoder`: tasks.list/create/messages/rename, turns.start/cancel/subscribe(型は各起動プロンプトに記載)
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
- 追加の起動系バグ2件をFableが特定・修正(commit済み): 6. index.htmlがsrc/renderer配下にありVite rootの`/`が404 → apps/desktop直下へ移動(白画面の原因) 7. main/preload両entryがindex.tsで`.vite/build/index.js`を上書き合戦 → preload出力名を明示分離(window.sprintCoder未公開の原因)
- 2026-07-22 ユーザー実機確認: golden path #1(Task作成→hello送信→Run Card→mock streaming応答)成功のスクリーンショットを受領。Chat Alpha骨格ラウンド完了
- 未了(次ラウンド送り): operations ledger(冪等性、Slice 1.2)、Forge起動時のnative自動rebuild恒久化(workspace hoisting対策)、npm audit 24件(critical 1)、E2E(Playwright Electron、Phase 0 spike対象)、Team/Canvas(Phase 5-6)

## Phase 6ゲート判定(2026-07-24 Fable)

**判定: 通過**(Team Canvasとcinematic motion。実装はSonnetサブエージェント4スライス+レビュー2回+ゲート修正1回、Fableが監督・独立検証)

- コミット列: `5d6238d`(Canvas再構築・視覚正本demo/index.html準拠)→ `f060995`(6.2 SurfaceLayer同一instance morph)→ `0006894`(6.1 canvas_views永続化 migration v29・node drag・LOD・keyboard nav・List fallback)→ `c305195`(6.3+6.4 collision placement・CameraDirector ownership・delivery同期cable・reduced motion textual event)→ `34c0f32`(ゲート修正: 入力サイズ上限・team mode中chromeのinert化・TeamCanvasのtask key化)
- 機械検証: unit 277+276+23、team系E2E 15本(morph連続性: mount count不変・draft/scroll/選択範囲、layout永続化+再起動復元、LOD、List⇔Canvas、camera ownership遷移、collision placement、cable: 雇用時無し/正しいpair/ack因果/offscreen無追従/pan中安全、keyboard nav、reduced motion代替+aria-live)
- 設計逸脱の記録: React Flow不採用 → 設計書既定fallback(custom DOM world)を正式採用(ADR: adr-team-canvas-custom-dom-world-20260724.md)
- 既知の限界(非ブロッキング、follow-up):
  1. IME変換中のmorphは変換状態を維持できない(DOM移動のプラットフォーム制約。コード内に文書化)
  2. mid-stream morphの無欠落は手動確認のみ(自動テスト未整備)
  3. quit時にcanvas view autosaveの直近~1秒が失われうる(既存draft autosaveと同型の設計限界)
  4. focus占有率65–75%は定数で強制(0.70/0.75)、数値アサートは無し
  5. packaged Electronの起動不能はこの開発環境固有(E2Eは全てSPRINT_CODER_E2E_MODE=dev)。CI環境での要再確認はChat Alphaゲートから継続
- 発見・修正された注目バグ: StrictModeのcleanup-only effectがcable描画を全滅させていた潜在バグ(c305195で修正)、team mode中の不可視chrome残留フォーカス(34c0f32でinert化)

## 追記(2026-07-24 Fable): Team操作モデル修正 + Claude runtime + SVGアイコン

- `c0f1acc` Claude Code CLI (v2.1.218) headlessを第2 production runtimeとして追加(ADR: adr-production-runtime-claude-cli-20260724.md、migration v30でruntime_kind CHECK再構築、per-runtime model永続化、egress gate拡張、実CLIスモーク済み)
- `1b4515f` renderer全域の絵文字装飾をインラインSVGアイコン(Lucide ISCパスデータ、依存追加なし)へ置換
- `ccd50f2`+`afdce6d` **Team操作モデルの是正**: ユーザー手動の雇用フォーム/依頼欄を撤去し、FR-TEAM-06/13どおりLeaderのtool use(`team_hire_worker`/`team_send_to_worker`/`team_wait_reports`)が雇用・指示・報告統合を駆動する形へ。Mockランタイムに決定論的チームシナリオ(trigger:「チームテスト」またはTeam存在時)。Workerカードは観測+停止のみ。e2eはLeader主導フローで全acceptance再機械化(15/15)
- 検証: typecheck/lint/unit(301+23+276)/全e2e(既知flake 1件のみ除外)グリーン

## Phase 7ゲート判定(2026-07-24 Fable)

**判定: Team MVP blocking subset 全8項目通過**(コミット列: `8e77eaf` security → `b32b964` a11y → `779ebb2` reliability/perf。実装はSonnet子分2+Fable直接実装、レビュー・検証はFable)

blocking subset証跡:

1. crash recovery/interrupted・paused復元 — golden-path-1-restart-restore + team-flow restart e2e(既存)
2. process tree停止・orphan検出 — process group ADR + cancel e2e + Codex/Claude実CLIスモークでcancel後orphan 0を機械証明
3. sandbox/Broker bypass拒否/workspace外fs/無許可outbound/egress deny(macOS実証) — codex実CLIへの敵対的workspace外書込指示が拒否されることを実機証明、no-toolsプロファイル・egress事前denyをテスト化
4. IPC/path traversal/Markdown・ANSI・URL/secret redaction adversarial — IPC全41ch×プロトタイプ汚染等300ケース、Markdown画像exfil修正、redaction取りこぼし(AWS/.env等)修正、path-guard未型付き例外修正
5. keyboard-only golden path/List View同等/contrast/reduced motion — a11y e2e 11本+contrast機械検証29ペア+200% zoom(List overlayレスポンシブ化を実装)+docs/A11Y_AUDIT.md
6. DB migration/backup・restore/1万event projection — legacy v1→v30チェーン(既存)+破損検知→backup復元→fresh start実装・テスト、1万event再開+projection実測4ms(予算500ms)
7. Composer p95/stream batching/10 Worker LOD — perf-budgets.spec実測: 起動396ms(予算2000)、入力p95 14.2ms(予算16)、10Worker×200msg pan 60.1fps(予算50)、LOD切替確認。NFR-PERF-05 batchingは実装済み(command-runner 100ms/64KB)
8. Phase 4.7 corpus baseline — assurance.test.ts + PHASE_4_7_CORPUS_BASELINE.md(suiteでグリーン維持)

Public Beta送り(計画が明示的に許容する繰り延べ、未実施として記録):

- 10.1: Conversation rewind/branch切替、crash storm circuit breaker、idempotency fuzz、Workspace restore/Safe rewind saga/emergency checkpoint(計画自体がPublic Beta candidate/feature flag指定)、Verified profile
- 10.2: startup遅延化・Timeline virtualization等の最適化(全予算を現状実測でクリアしているため不要と判断)
- 10.3: VoiceOver人手実施(台本はA11Y_AUDIT.mdに整備済み)、NVDA(Windows実機なし=Phase 8 beta gateの対象OS実機E2Eで実施)
- 10.4: session partitioning(SECURITY_CHECKLIST.md open item)
- 既知環境フレーク: command-runner-flow focusテスト(変更前ベースラインから再現する環境起因)

Team MVPリリース阻止条件はすべて解消。残Phase: Phase 8(Release: signing/update/beta gate)のみ。

## 追記(2026-07-24 Fable): Team実実行(モック脱却 第1弾)

- Worker実実行を実装: `main/team-worker-runtime.ts`(RuntimeHostTeamWorkerRuntime)。Leaderが指示したWorkerタスクを実Claude/Codex CLIのephemeralターン(read-only/no-tools、UtilityProcess境界経由、egress gate通過)で実行し、実際の生成結果を報告として返す。probe失敗・egress拒否時は決定論シミュレータへフォールバック
- opt-in: `SPRINT_CODER_REAL_WORKERS=1 npm start`(既定はテスト決定性とコスト保護のためシミュレータ)。README記載
- 実機実証: 「チームテスト:1+1の答え」で調査/実装/レビュー3Workerが実Claudeで観点別報告を返すことをsmokeで確認(14秒)。この過程でclaude adapterの`--permission-mode plan`がplanメカニクスを回答に混入させる品質バグを発見し除去(ADR修正記録あり)。あわせて`npm run typecheck --workspaces`が失敗後も続行するためexit codeで検証すべきという運用教訓を得た(以後の検証はexit code確認)
- 次マイルストーン(未実装・記録): Leader自身の実tool use化 — アプリがMCPサーバとしてteam toolsを実Claude Leaderに提供する方式。現状はLeader=Mockシナリオ+Worker=実AIのハイブリッド

## 追記(2026-07-24 Fable): 雇用ペーシング

- 一括瞬間雇用は「Leaderが動的採用している」体験を壊すため、雇用ごとに1.2秒のペーシングを導入(SPRINT_CODER_TEAM_PACING_MS で調整可)。真の動的採用(実Claude Leaderが依頼内容から役割を決める=MCP化)は引き続き次マイルストーン

## 追記(2026-07-24 Fable): LeaderのMCP化(実Claude LeaderがteamツールをMCP経由で駆動)

- 実装: `SPRINT_CODER_LEADER_MCP=1`かつruntime=claudeかつteam意図(または既存Team)の場合、Turnをmockへ強制せず実Claude CLIへ`--mcp-config`/`--allowedTools mcp__team__*`を渡して直接team_hire_worker/team_send_to_worker/team_wait_reports/team_stop_workerをtool useさせる。env未設定時は既存のmockリルート挙動を完全維持
  - `main/team-tools.ts`: 4ツールの実行ロジックを`executeTeamTool(coordinator, taskId, toolName, args, options)`へ集約。mock ToolBroker登録とMCPブリッジの両方がこの1本の経路を共有。`.strict()` zodスキーマでtaskId/送信元IDのなりすましを実行前に拒否。team_wait_reportsはlongPollオプション付き(既定false=mock互換の即時replay、true=最大60秒ロングポール、`TeamCoordinator.hasBusyWorkers`で全Worker settled検知)
  - `main/team-mcp-bridge.ts`(新規): userData配下ではなく`/tmp`優先のunix socket(sun_path 104byte制限を厳守)でturnId→{taskId,token}を登録管理。行区切りJSON、`timingSafeEqual`による定数時間トークン比較、不正トークンは応答せず即close
  - `runtime-host/team-mcp-server-source.ts`(新規): 依存ゼロの自己完結CJS文字列。newline区切りJSON-RPC 2.0でinitialize/notifications initialized/tools list/tools callを実装し、tools callはunix socket経由でbridgeへ転送するのみ(TeamCoordinatorを直接知らない)
  - `runtime-host/claude-adapter.ts`: teamMcp指定時のみ一時mcp-config.json+スクリプトファイルを書き出し、`--mcp-config --allowedTools mcp__team__* --append-system-prompt <guidance>`を追加。Turn終了時に一時ディレクトリごと削除
  - `runtime-host/protocol.ts`/`main/runtime-host.ts`/`runtime-host/index.ts`: start envelopeへ追加的optional `teamMcp:{socketPath,token,guidance}`を追加(Codexアダプタは無視)
  - `main/ipc.ts`: `startSelectedRuntime`でgate判定、bridge登録/token発行、Turn完了・失敗・キャンセルの全経路で`unregister`を実行。bridge起動失敗時はmockへ安全側フォールバック
- **重要な設計変更(実機検証で確定、当初計画からの逸脱)**: `--safe-mode`はMCPサーバ読み込みそのものを無効化する(CLIの`--help`にも明記、実機でも確認: `--safe-mode`付きだと`--mcp-config`で渡したサーバがconnectされず`mcp_servers:[]`のまま)。そのためteamMcp指定時のみ`--safe-mode`を外し、代わりに`--setting-sources ""`(user/project/localのsettings source全読み込み停止→hooks/CLAUDE.md/plugins/カスタムコマンドが読み込まれないことを実機確認: `plugins:[]`、CLAUDE.md由来の指示が存在しないことをprobeで確認)と`--disable-slash-commands`(`slash_commands:[]`を実機確認)を追加して同等の分離を実現。`--tools ""`(built-in tool空)と`--strict-mcp-config`(指定した1サーバのみ)は維持。`claude-normalizer.ts`の`assertReadOnlyCapabilities`もteamMcp時は「tools/mcp_serversが空であること」ではなく「期待した1サーバ+4ツール名と完全一致すること」を検証するよう拡張(`ClaudeExpectedCapabilities`)
- ハンドシェイク検証: インストール済みClaude CLI(v2.1.218)へ実際にプローブ用MCPサーバを繋いで確認。newline区切りJSON-RPC(Content-Length枠なし)、`initialize`はクライアントの`protocolVersion`をそのまま返せば通る、`tools/call`の`params`に`_meta.claudecode/toolUseId`等が付与される(無視して問題なし)、フルクオリファイド名は`mcp__<serverName>__<toolName>`
- 検証: typecheck(3 workspace) exit 0 / lint exit 0 / test(desktop 701 + contracts 23 + domain 276 = 1000件、Electron ABI内含む) exit 0。format:checkは既存14ファイルの整形崩れ(本マイルストーン範囲外、着手前から存在)のみ残存でexit 1 — 新規/変更ファイルは全てprettier適用済み
  - 新規unit test: bridge認証(不正token即close、token長不一致、unregister後拒否)、executeTeamToolのルーティング/バリデーション/なりすまし拒否、MCPサーバスクリプトのJSON-RPCハンドシェイク(initialize/tools list/tools call/未知method)、team_wait_reportsロングポール(即時報告・busy解消待ち・timeout)
  - 既存e2e(`SPRINT_CODER_E2E_MODE=dev`、環境変数なし): team-flow/team-cables/team-canvas-layout 14/14 green(mockパス無変更を確認)
- **実smoke(1回限定、削除済み一時spec)**: `SPRINT_CODER_LEADER_MCP=1 SPRINT_CODER_REAL_WORKERS=1`・runtime=Claude Codeで「チームで『1+1の答え』を必要最小の人数で検討して、結論を教えてください」を送信。結果: 実Leaderが**自律的に**「計算担当」という(固定シナリオの調査/実装/レビューとは異なる)役割で1名だけを雇用(必要最小人数の判断も自律)→team_send_to_workerで依頼→実Worker(実Claude CLI)が「報告結論: 1+1=2」を返却→team_wait_reportsで受信→Leader最終回答「必要最小の1人（計算担当）で検討しました。結論: 1 + 1 = 2」を合成。Turn完了まで14秒。UI上でWorkerカード(計算担当・done)とLeaderの最終回答を実機確認
- 既知の限界/次点:
  1. Codexランタイムは対象外(MCP転送するstdio機構が確認できていない/ADR記載どおりClaude専用)。Codexでteam意図の場合は従来どおりmockリルート
  2. teamMcp時の`--setting-sources ""`はhooks/CLAUDE.md/plugins/カスタムコマンド/slash commandsを無効化するが、Claude CLI組み込みの標準ツール自体は`--tools ""`で別途無効化しているため二重の安全設計。ただし`--safe-mode`が保証していた項目の完全な一対一対応ではなく、CLIの`--help`記載+実機プローブでの経験的一致であり、将来のCLIバージョンアップで挙動が変わる可能性は残る(normalizerの`ClaudeExpectedCapabilities`検証がfail-closedの防波堤)
  3. team_wait_reportsのロングポールは固定500msポーリング(コールバック/イベント駆動ではない)。60秒×Workerの往復回数分のブリッジ往復が発生するが、実測では実用上問題なし
  4. Leader MCPソケットは複数Turn/複数Taskで1つのbridge・1つのsocketを使い回す設計(turnId×tokenで多重化)。同一プロセス内で同時に複数のteam Turnが走る場合の負荷は未検証

## 追記(2026-07-24 Fable): AI察知によるチーム化

- SPRINT_CODER_LEADER_MCP=1時、team toolsをClaudeの全ターンに常時提供へ変更。キーワード(「チームで」)やボタンなしでも、Leaderが依頼内容から必要性を察知して雇用→自動昇格→Canvas自動遷移。ガイダンスに「本当に有益な時だけ・単純な依頼は直接回答」の抑制を明記
- 実機実証: キーワードなしの並行検討依頼で「数学検討担当」を自己判断で雇用、Canvas自動遷移まで確認(12.7秒)。Mock経路e2eは無変更(3/3)

## 追記(2026-07-24 Fable): Leader MCPの厳密検証

- 恒久opt-inスモーク tests/e2e/leader-mcp-smoke.spec.ts を追加(SPRINT_CODER_LEADER_MCP=1で実CLI実行)
- 実測合格: (1) MCP経由の機械的証明 — Leaderが自己判断で2人雇用(数学検討担当/実装検討担当、固定トリオと不一致)+ペアノ公理からブール代数まで論じる非定型報告=Mock経路では不可能な出力 (2) ⬡ Teamを押さずにCanvas自動遷移(送信前は非表示をアサート) (3) 抑制 — 単純質問「1+1は?」ではチーム未作成(team null)を確認
- follow-up記録: leader-MCPターン後のアプリquitが90秒超かかることがある(runtime-host子プロセス回収待ちの疑い)。スモークはclose 20秒+SIGKILLの保険付き

## Issue #321 Ollama Windows command compatibility (2026-08-23)

- [x] Ollamaのテキスト応答とtool calling対応を実機確認
- [x] WindowsでモデルがUnix形式の`cmd.exe -c/-e`を生成する根本原因を特定
- [x] 信頼済みSystem32の実行ファイルを確定した後に`cmd.exe /c`へ正規化する
- [x] 承認画面と実行対象が同じ`/c`を保持する統合テストを追加する
- [ ] 対象テスト・型チェック・Grok 4.6レビュー・実機E2Eを完了する
- [ ] PR #323をマージし、Issue #321をliveでCLOSEDまで確認する

Next Steps: 変更をコミット・pushし、Grok 4.6レビューとCI後に生成アプリの承認表示で再確認する。

### 実機RCA追記

- RCA Mode: Root Cause Confirmed（A/B/C/D = YES）
- 症状: AppContainer内の`node verify.mjs`が`EPERM: lstat 'C:\\'`で失敗する。
- 原因箇所: `apps/desktop/src/main/command-runner.ts`のWindows制御環境が、Nodeのmain realpath処理に必要な固定オプションを設定していない。
- 独立証拠: 同じsandbox helper・Workspace・Nodeで通常実行はEPERM、`NODE_OPTIONS=--preserve-symlinks-main`固定時はmainを起動してverifier本体まで到達した。
- 除外: Workspace ACL不足ではない。`cmd.exe /c`による同じWorkspaceへの書込みはexit 0で成功した。
- 修正: ユーザー由来`NODE_OPTIONS`を継承せず固定値を設定し、drive rootへACLを広げずNode/npmの相対entrypointを起動可能にする。
- Symptom Gone: 同じ相対Node entrypointをAppContainerで実行するWindows回帰テストとpackaged Ollama E2Eで確認する。

### Codex CLI承認経路の実機RCA追記

- 症状: Codex CLIは正しい`node.exe -e`を生成するが、実行前に`Turn is not eligible to request approval`で拒否される。
- 原因箇所: `codex-adapter.ts`がツール呼び出し前のAssistantプリアンブルでTurnを`synthesizing`へ進め、後続の承認要求が永続層の許可状態から外れる。
- 修正: Assistant deltaでは`executing`を維持し、`turn/completed`でのみ`synthesizing`へ進む。
- 回帰防止: プリアンブルの後にmanaged toolを呼ぶ偽Codex app-serverで、呼び出し時点の最終stageが`executing`で`synthesizing`を含まないことを検証する。

### 最終レビュー修正

- 信頼済み`cmd.exe`のUnix形式スイッチは`/d /s /c`へ正規化し、承認外のCommand Processor AutoRunを無効化する。
- 非System32実行ファイルの仮想`api-ms-*` / `ext-ms-*` importは物理DLLを要求せず、その他の非ローカルDLLは引き続き実在するSystem32ファイルだけを許可する。
- Grok 4.6の再レビューを反映し、信頼済み`cmd.exe`の全形式へ`/d`を強制する。API-setは信頼済みOS schemaに実在する契約だけを許可し、Workspace内の同名DLLによる偽装を拒否する。
