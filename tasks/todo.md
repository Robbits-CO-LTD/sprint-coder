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
- [ ] Slice 4.7 Edit Transaction and Standard Assurance
- [ ] Phase 4 acceptance gate: provider.egress policy/監査、local-only拒否、30-case corpus、未解決High/Critical 0を最終確認

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
