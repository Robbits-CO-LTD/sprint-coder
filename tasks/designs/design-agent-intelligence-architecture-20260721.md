# 詳細設計書: Agent Intelligence Architecture

> detail-design-doc / 生成日: 2026-07-21 / 品質スコア: A（3視点のCritical/Major反映後）
> 入力: Codex CLI・Grok Build固定commitの実装調査と「両者級のcoding agentを作る方法」の深掘り

---

## 1. 概要

### 1.1 背景

既存のSprint Coder設計は、Thread/Turn/Item、Actor、Tool Broker、permission、recoveryを固めた。一方、coding agentの価値は「安全に動く」だけでは足りない。大規模repositoryから正しい変更点を探し、競合せず編集し、実コードを検証し、未達なら自律的に修正し続ける能力が必要である。

Codex CLIとGrok Buildの固定sourceを追うと、品質は巨大な単一promptではなく、model loop、context compilation、typed tool、差分追跡、役割分離、検証、停滞検知、評価fixtureの組合せで作られている。

### 1.2 目的

- 通常Chatから本格的なcoding Taskまで同じAgent Kernelで扱う。
- model/providerを交換してもcoding workflowと品質計測を維持する。
- 「回答した」ではなく、acceptance criteriaを証拠で満たした状態を完了とする。
- 失敗時に無限retryせず、修正可能・blocked・環境障害を区別する。
- UIからAgentの探索、変更、検証、停滞、回復を理解できるようにする。

### 1.3 スコープ

- 対象: model sampling loop、context、repository探索、編集、検証、長時間Task、memory、evaluation。
- 対象: Codex/Grok由来の構造をSprint Coderへadaptする判断。
- 対象外: 独自foundation modelの学習、RLHF、provider内部reasoning、cloud fleet運用。
- 対象外: Team Canvasのmotion詳細。Canvasは本設計の状態を表示するprojectionとして扱う。

### 1.4 用語

| 用語 | 定義 |
|---|---|
| Intelligence Step | 一回のmodel samplingと、その結果から生じるtool実行・追加入力の単位 |
| Evidence | test結果、typecheck、diff、diagnosticなど完了判断を裏付ける観測 |
| Acceptance Contract | objective、criteria、verification plan、non-goalsを固定した契約 |
| Assurance Loop | implement → verify → repairをboundedに反復する制御 |
| Context Compiler | durable historyから次Stepのmodel-visible contextを決定論的に組み立てる層 |
| Edit Transaction | read revisionを前提に、全変更を検証してから適用する編集単位 |
| Stagnation Fingerprint | 連続roundで同じ未達が残っているかを判定する正規化hash |

## 2. 要件定義

### 2.1 機能要件

| ID | 要件 | 優先度 | 受入条件 |
|---|---|---|---|
| FR-AI-01 | Turn内でmodel→tool→result→modelを反復する | Must | tool result後に同一Turnを再sampleできる |
| FR-AI-02 | Stepごとに利用可能tool snapshotを固定する | Must | 実行toolが提示catalogのID/versionと一致する |
| FR-AI-03 | repository instructionとworld stateを差分更新する | Must | cwd/branch/permission変更だけが再注入される |
| FR-AI-04 | symbol、text、file treeを組み合わせて探索する | Must | rg fallbackとoptional symbol navigationを同じquery APIで使える |
| FR-AI-05 | stale readに基づく編集を拒否する | Must | revision/hash不一致で無変更のまま再読込を要求する |
| FR-AI-06 | batch editを全件事前検証し、部分commitを復旧可能にする | Must | commit失敗時にjournal補償、失敗ならblockedとなる |
| FR-AI-07 | Turnの全変更をbaselineからのdiffとして表示する | Must | add/update/delete/renameを一つのTurn diffに集約する |
| FR-AI-08 | edit Taskのverification recipeを変更前に決定する | Must | profileに応じたrecipe revisionをStepへ固定する |
| FR-AI-09 | Task受入をevidence ledgerと照合する | Must | Turnは終了可能でもgating不足ならTask criterionをopenに保つ |
| FR-AI-10 | 独立reviewerを実装agentから分離する | Should | reviewerにimplementation transcriptの指示権限を与えない |
| FR-AI-11 | 同じgapが連続したらrepair戦略を変更する | Should | fingerprint threshold到達で再構成またはpauseする |
| FR-AI-12 | premature stop/stallを検出する | Should | high-confidence時のみbounded nudgeを次Stepへ入れる |
| FR-AI-13 | roleごとにtool、context、model、budgetを変える | Should | Explorer/Implementer/Verifierが異なるprofileを持つ |
| FR-AI-14 | 長時間Taskをpause/resumeできる | Should | objective/contract/gaps/evidence/budgetを復元できる |
| FR-AI-15 | 有用なTask結果だけをmemory候補へ送る | Could | no-op gateとprovenanceを通過しない内容を保存しない |
| FR-AI-16 | regression corpusでagent品質を比較する | Must | provider/prompt/tool変更前後の成功率・cost・latencyを比較できる |

### 2.2 非機能要件

| ID | カテゴリ | 要件 | 基準 |
|---|---|---|---|
| NFR-AI-01 | Correctness | model textを完了証拠にしない | gating criterionごとにmachine-checkable evidenceまたは明示manual gate |
| NFR-AI-02 | Convergence | 無限repairを禁止 | default 3 repair rounds、同一gap 2回でstrategy change |
| NFR-AI-03 | Cost | assuranceをTask riskへ比例 | Quick/Standard/Verifiedの3 profile、budget hard cap |
| NFR-AI-04 | Latency | 小Taskを重いharnessへ入れない | Quick profileはplanner/reviewerを起動しない |
| NFR-AI-05 | Determinism | context/tool/contractを再現可能にする | digestとrevisionを全Stepへ保存 |
| NFR-AI-06 | Security | verifier evidenceをuntrusted dataとして扱う | verifierはdefault read-only/no external write |
| NFR-AI-07 | Observability | failureの段階を識別する | explore/edit/verify/provider/infra/policyを分類 |
| NFR-AI-08 | Portability | provider固有eventへ依存しない | CanonicalAgentEvent contract test |
| NFR-AI-09 | Scale | large repositoryでもcontextへ全量投入しない | search result/item cap、progressive disclosure、index lazy build |
| NFR-AI-10 | Evaluation | quality regressionをrelease前に検出 | critical corpus 100%維持、全体成功率悪化2pt以内 |

## 3. 調査結果

### 3.1 Codex CLIから確認した構造

| 構造 | 根拠source | 読み取れる意味 |
|---|---|---|
| Turn内反復sampling | `codex-rs/core/src/session/turn.rs:144,1941` | tool callがある限りfollow-up samplingを続ける |
| Step単位tool build | `codex-rs/core/src/session/turn.rs:1221` | contextとtool catalogを同じStep snapshotへ固定 |
| 並列安全gate | `codex-rs/core/src/tools/parallel.rs:94-139` | parallel-safe toolはread lock、unsafe toolはwrite lock |
| history正規化 | `codex-rs/core/src/context_manager/history.rs:328` | call/outputの対応を補正し、orphanを除去 |
| modality-aware token推定 | `context_manager/history.rs:497` | JSON文字数だけでなくimage/audio/reasoningを別推定 |
| typed patch verification | `tools/handlers/apply_patch.rs:344,388` | parse後にfilesystem/sandboxへ照合してから適用 |
| Turn diff | `turn_diff_tracker.rs:93,123` | baselineとcurrentを追跡し、rename込みdiffを生成 |
| 独立review thread | `session/review.rs:5` | web search/goals/multi-agentを絞った別Turnでreview |
| tool search | `tools/handlers/tool_search.rs` | 全tool schemaを常時contextへ積まず必要時に発見 |
| project instruction cap | `agents_md.rs`, `agents_md_tests.rs` | 階層instructionを探索し、bytes上限を適用 |

### 3.2 Grok Buildから確認した構造

| 構造 | 根拠source | 読み取れる意味 |
|---|---|---|
| SessionActor run loop | `crates/codegen/xai-grok-shell/src/session/acp_session_impl/run_loop.rs:85` | command、completion、notification、idle処理を一つのactorで調停 |
| two-pass compaction | `crates/codegen/xai-grok-shell/src/session/two_pass.rs:126,230,242` | prefix要約とrecent tailを分け、tool境界を壊さない |
| Goal state machine | `crates/codegen/xai-grok-shell/src/session/goal_tracker.rs` | planning/executing/paused/blocked/completeを永続化 |
| adversarial verifier panel | `crates/codegen/xai-grok-shell/src/session/goal_classifier.rs:1-12,105` | default 3 skepticを並列起動してmajorityで判定 |
| strategist | `crates/codegen/xai-grok-shell/src/session/goal_strategist.rs:102,267` | 同じ失敗が続く時にHOWだけを構造変更 |
| stop detector | `crates/codegen/xai-grok-shell/src/session/goal_stop_detector.rs` | 諦め表現や未完了停止を検出して再開 |
| laziness classifier | `crates/codegen/xai-grok-shell/src/session/acp_session_impl/laziness_classifier.rs` | idle後に小さなstructured判定を行いconfidence/capでnudge |
| hashline edit | `crates/codegen/xai-grok-tools/src/implementations/grok_build_hashline/edit/apply.rs:145` | anchor freshness、overlap検査、batch atomicity、fresh snippet |
| codebase graph | `crates/codegen/xai-codebase-graph/src/lib.rs:3-10` | tree-sitter index、incremental update、definition/reference検索 |
| LSP navigation | `crates/codegen/xai-grok-tools/src/implementations/lsp/dispatch.rs` | definition/reference/hover/symbolをtimeout付きで統合 |
| memory dream | `crates/codegen/xai-grok-shell/src/session/acp_session_impl/memory_dream.rs` | session summaryを後処理でconsolidateし、通常Turnを汚さない |

### 3.3 調査上の限界

- 両repositoryの公開sourceからproduct-level SWE benchmark結果は確認できない。
- provider内部のreasoning、training data、system-side tool executionは公開sourceだけでは評価できない。
- Grok Goal Harnessは高度だが、そのままMVPへ入れるとcost/complexityが過大になる。
- よって「同じ機能数」ではなく、観測可能な品質原則を段階導入する。

## 4. アーキテクチャ設計

### 4.1 コンポーネント

```text
Task/Turn → ThreadActor
  → TurnExecutionReducer (pure)
      → ContextCompiler → ModelRuntime
      → ToolPlanner → ToolBroker
      → CodeNavigator
      → EditTransactionService
      → VerificationController
      → AssuranceController
  → EvidenceLedger / EvalRecorder
```

- TurnExecutionReducerはStepの次状態とEffectを純粋計算し、ThreadActorだけがTurn/Taskの完了・pause・blockedをcommitする。
- ContextCompilerはhistoryをそのまま連結せず、authority/trust/budgetに従ってmodel inputを生成する。
- CodeNavigatorはtext/file/symbol検索を一つのquery planへ束ねる。
- EditTransactionServiceはpure prepare/validateを担い、Tool Broker配下のEditExecutorだけが権限確認とfilesystem commitを行う。
- VerificationControllerはrecipe実行とEvidenceRecord生成だけを行う。AssurancePolicyはcontractとevidence snapshotから次状態を純粋計算する。
- Runtime/Tool/Verification結果はactorRevision、turnId、stepId、effectId付きinternal commandでThreadActorへ戻す。

### 4.2 Intelligence Step

```text
capture StepSnapshot
  → compile context + tool catalog
  → sample model
  → validate structured output
  → dispatch parallel-safe tools
  → persist results/evidence
  → continue | compact | verify | complete | pause
```

StepSnapshotはmodel、reasoning effort、context/tool digest、policy epoch、workspace/contract revisionを持つ。ただしsnapshotは再現用で認可tokenではない。各tool dispatch時にlive policy/cancel/revisionを再評価し、外部状態が変わればretryでなく新Stepとする。

Stepは`prepared → sampling → sampled → dispatching → toolsCommitted → completed`で永続化する。同一snapshot retryはmodel result commit前かつtool dispatch前だけ許し、attempt/operation IDでdedupeする。結果不明なら再実行せず再観測して新Stepへ進む。Mainはstate routingだけを担い、hash/diff/index/evalはUtility ProcessまたはWorker Threadへ逃がす。

### 4.3 Tool並列性

ToolDefinitionは表示用`concurrencyClass`と、workspace path、git index、process、port、network、CPU等の`ResourceClaim[]`を持つ。schedulerはclaim競合とTask/global semaphoreでbounded実行する。

| Class | 例 | Gate |
|---|---|---|
| Pure | plan更新、token estimate | quota内parallel |
| Read | grep、read、symbol lookup | workspace read lease |
| Mutate | edit、format、package install | workspace write lease |
| Process | test/build/dev server | resource group lease |
| Human | approval、question | Turn pause |

parallel tool callをmodelの判断だけに任せない。同じworkspaceのMutateは直列化し、Readは未commit Edit Transactionと並行させない。結果はcall orderでcontextへ戻し、実行完了順によるprompt nondeterminismを避ける。

## 5. Context Compiler

### 5.1 Layer

1. System/runtime policy。
2. User objectiveと最新指示。
3. Acceptance Contract。
4. Workspace rules。authorityはworkspace-controlledのまま。
5. Step world-state diff。
6. Selected conversation items。
7. Code evidence/tool output。
8. Memory retrieval。

各fragmentは`originTrust`と`instructionAuthority`を別々に持つ。tool/web/worker output中の命令文はdataとしてquoteし、上位instructionへ昇格しない。

### 5.2 Selection

- 最初はfile tree、manifest、git status、主要ruleだけを入れる。
- repository全量ではなくqueryに関連するsymbol/file/snippetを取得する。
- tool outputはhead/tail、artifact pointer、structured summaryに分ける。
- userの最新訂正と未解決criterionを優先する。
- compact時もAcceptance Contract、active gaps、workspace revisionをlossless slotとして保持する。

### 5.3 Compaction

Grokのtwo-passとCodexのcheckpoint summaryを組み合わせる。

- recent tailはtool call/output pairを壊さず保持する。
- old prefixだけをno-tools compactorへ渡す。
- summaryはdecisions、changed files、failed attempts、verification、remaining gapsをschema化する。
- original eventを削除せずreplacement fragmentとwatermarkを追加する。
- summary failure時はoldest safe segmentのdeterministic truncationへfallbackする。
- summaryはsource IDs、最小trust、最大riskをtaint伝播し`instructionAuthority=none`固定とする。compactorはno-tools/no-memory-writeで、untrusted textをcontract/gap状態へ昇格させない。

## 6. Repository Intelligence

### 6.1 Query planning

探索は次の順でprogressiveに行う。

1. `rg --files`相当で構造を把握。
2. text searchで候補を絞る。
3. known pathを部分readする。
4. symbol definition/referenceで依存を追う。
5. build/test metadataとrecent git diffを確認。

CodeNavigatorは結果にpath、line、symbol、revision、query、truncationを付ける。検索0件時に全filesystemへ勝手に広げず、scope拡張を明示する。

### 6.2 Index strategy

- MVP: `rg` + file metadata + manifest parser。
- Team MVP hardening: allowlist済みLSPだけをTool Broker配下のnetwork deny/resource cap/symlink boundaryで利用。
- Public Beta: tree-sitter code graphをlazy buildし、FS eventでincremental更新。
- index missやstale時はtext searchへfallbackし、indexを正本にしない。

## 7. Edit Transaction

### 7.1 Read token

file read結果へ`FileRevisionToken { identity, contentHash, mtimeHint, size }`を付ける。apply直前と各replace直前にhandle/final-path基準でidentity/hash/policy epochをCAS再検証する。

### 7.2 Edit方式

- Structured patch: add/update/delete/renameを表現するdefault。
- Anchored range edit: large fileの局所変更とconcurrent drift検出に使用。
- Whole-file write: new/generated small fileだけ。既存large fileではapprovalまたは拒否。

Grokのhashline方式は有用だが、短いline hashだけをsecurity/correctness boundaryにしない。Sprint Coderはfile content hashをprimary revision、line anchorをergonomic locatorとして組み合わせる。

### 7.3 Apply algorithm

1. 全targetをcanonicalizeしsandbox scope確認。
2. 全revision/anchorをpre-edit snapshotへ照合。
3. range overlap、rename collision、special fileを検査。
4. memory上で全editを適用しparse/size policyを確認。
5. pre-imageとcommit journalを保存し、EditExecutorがfile単位のatomic replaceを順次commit。
6. 途中失敗時はjournalから補償restoreし、失敗なら`partial_apply_recovery_required`でblocked。
7. post-image hash、Turn diffを保存し、formatterは別Effectとして区別する。

複数file全体を厳密なfilesystem transactionとは呼ばない。apply前の失敗は無変更、commit中の失敗は補償結果とfresh revisionを返し、部分成功を隠さない。

## 8. VerificationとAssurance Loop

### 8.1 Acceptance Contract

全Taskは最小Completion Contractとしてobjective、taskKind、completionMode、requiredEvidenceを持つ。Standard/Verifiedのedit Taskはさらに変更前に次を固定する。

- objective verbatim。
- atomic acceptance criteria。
- gating/evidenceを区別したverification recipe。
- non-goals。
- allowed scope。
- risk/budget。

plannerはdraftとverification具体化だけを行う。objective、gating解除、manual化、scope拡張はsemantic diff付きuser/admin policy承認を必須とし、revisionをappend-only保存する。ImplementerとVerifierは同じdigestと変更履歴を見る。

### 8.2 Evidence Ledger

EvidenceRecordはmodel入力から作成できない。MainのBroker/CommandRunnerがsealed envelopeとしてexecution spec、recipe/policy/tool/runtime digest、開始/終了tree fingerprint、exit、output/artifact hashを観測発行し、producer/trustを導出する。完了前はwrite activityを止め、対象hashを再確認してCompletionDecisionと同じtransactionでcommitする。

raw artifactはapp-private storeへsize/type/quota/TTL/secret scan付きで保存し、長期保持する小さなmanifestと分離する。期限切れは`artifact_expired`と表示し、過去の検証時点を改竄しない。

### 8.3 Assurance profile

| Profile | 用途 | Loop |
|---|---|---|
| Quick | answer-only/明示的小変更 | answerはevidenceなし可、editはtargeted checkまたはunverified明示、repair 0 |
| Standard | 通常coding Task、Team MVP default | plan-lite → implement → deterministic verify → repair最大1 |
| Verified | 高risk/release/security/明示要求 | contract → implement → independent review → repair最大3 |

active Turn中のprofile変更・自動降格は禁止し、Workerは親のassurance floorを継承する。VerifiedはPhase 7 experimental、独立Verifier 1つをdefaultとし、2–3 perspective panelは後続の高risk用途だけに使う。

### 8.4 Reviewer isolation

- reviewerはMain強制の専用profileでsnapshot read + temp/build dirだけwrite、network/MCP/memory/agent control/secretなし。repository scriptはuntrusted executableとして別承認する。
- Main生成criterion、canonical diff metadata、sealed evidence summaryをtyped fieldで受け、raw diff/file名/stdoutはuntrusted attachmentに分離する。
- implementation transcriptは原則渡さず、言い訳やprompt injectionを減らす。
- findingはcriterion gap、real defect、missing/invalid evidenceに限定する。
- style preferenceや新要求で合格基準をratchetしない。
- prior gapを最優先で再検証し、修正済みcriterionを再争点化しない。

### 8.5 Repairとstrategy change

gap fingerprintはmodel文言でなく、controllerがcriterionId、artifact identity、recipe step、deterministic failure signatureから作る。同じfingerprintが2 round続いた場合、同じpatch retryを止める。

- tangled codeならpure coreとI/Oへ分割。
- test theaterならshipped pathを直接呼べるseamを作る。
- environment limitationならblocked/manual gateへ移す。
- contradictory contractならuser decisionを要求する。

strategy agentはHOWだけを提案し、objective/criteriaを変更できない。plan/contract fileはimmutable snapshotとrestore guardで保護する。

## 9. Anti-stallと長時間Task

### 9.1 完了・停止判定

最終messageの文言だけで完了判定しない。

- open criterionがあるのに「完了」「後で確認」を返したらpremature stop候補。
- background activity待ちはstallとしない。
- genuine user decision待ちとpermission待ちを区別する。
- provider/infra failureはmodel repair roundを消費しない。

### 9.2 Stagnation detector

rule-based signalを先に使い、曖昧な場合だけshadow/calibration済みsmall classifierを使う。classifierは直近最大30 item、structured schema、timeout、session capを持つが、そのconfidenceに権限はない。Main preconditionを通した固定nudge候補だけを返し、新Stepはlive policy/approvalを必ず通る。

nudgeは次のactionを一つ示す。classifier/nudge/provider retryを共通wall-clock/cost capとcircuit breakerで制限し、active Verified Task以外では自動継続させない。

### 9.3 Pause条件

- budget hard cap。
- 同一gap 2回かつstrategy change後も改善なし。
- contradiction/unverifiable blocker。
- user/permission待ち。
- repeated infrastructure failure。
- workspace revisionが外部変更で大きく乖離。

## 10. Memory設計

### 10.1 保存対象

- userが確認したpreference/decision。
- repository mapとstable command。
- failure → cause → fix → verificationの再利用可能pattern。
- successful verification recipe。

短い雑談、一時的status、secret、未確認推測は保存しない。candidateはquarantineし、repo/commit、source trust、evidence ID、expiryを持たせる。command/policy/preferenceはuser確認必須、cross-repo共有はdefault禁止、memory write自体をcapability化する。

### 10.2 Retrieval

常時全memoryをpromptへ入れない。summary indexだけを初期contextへ置き、Task query、workspace、recency、confidenceで検索する。retrieved memoryはuser instructionより下位で、provenanceとlastVerifiedAtを表示する。

## 11. DB/API/UI設計

### 11.1 DB

既存設計のSQLiteへ次を追加候補とする。DDLはPhase 0 schema ADR前のためN/Aとし、論理entityだけを定義する。

- `intelligence_steps`: snapshot digest、state、model、usage。
- `acceptance_contracts`: Task revision、objective、criteria、non-goals。
- `verification_recipes`: contract revisionごとのstep。
- `evidence_records`: criterionとworkspace revisionに結び付く証拠。
- `assurance_rounds`: implement/verify/repair/strategy outcome。
- `eval_runs`: corpus case、configuration digest、metrics。

EvidenceRecordが証拠payloadの正本、Turn event logがlifecycle/auditの正本である。ContextLedgerはfragment/trust/watermarkを保存し、Context CompilerはStepごとのpure selection/renderだけを行う。

### 11.2 API

外部HTTP APIはN/A。Main Agent Gatewayの内部methodを追加する。

- `task/setAssuranceProfile`
- `contract/read`, `contract/approve`
- `verification/run`, `verification/cancel`
- `evidence/list`, `evidence/openArtifact`
- `task/pause`, `task/resume`

### 11.3 UI

Chatの通常message設計は変更しない。Run/Turn Cardへ以下をprogressive disclosureで追加する。

- compact: 現在stage、elapsed、次のaction、stop。
- expanded: explored files、changed files、verification、open gaps。
- Verified Task: contract badge、round、budget、verifier verdict。
- blocked: 理由、保持されたevidence、必要なuser decision。

Explorer/Implementerは同一Thread内のStepRole、独立Verifierだけが別AgentThreadになり得る。CanvasはAgentThreadだけをcard化し、内部roleはTurn Cardのbadgeにする。

## 12. エラーハンドリング

| 分類 | 例 | 動作 |
|---|---|---|
| ModelRetryable | tool dispatch前のstream切断 | attempt/time/cost cap内だけ同一snapshot retry |
| ModelInvalidOutput | tool args/schema不正 | 独立counter上限内でfollow-up、超過時pause |
| StaleWorkspace | revision mismatch | edit未適用、fresh snippetで再計画 |
| VerificationFailed | test/typecheck失敗 | gap化しrepair roundへ |
| EvidenceInvalid | artifact missing/revision違い | completion拒否 |
| StrategyStalled | 同じgap継続 | structural strategyまたはpause |
| Infrastructure | runtime/tool crash | repair外でもTask deadline内、retry cap/circuit break |
| Contradiction | criteria同士が両立不能 | blockedとしてuser decision |

## 13. テスト・評価戦略

### 13.1 Contract / Integration

| 領域 | 必須case |
|---|---|
| Step/Policy | retry境界、operation dedupe、並列dispatch中のrevoke/cancel、ResourceClaim競合 |
| Context | call/output正規化、contract/gap保持、untrusted summaryのauthority非昇格 |
| Edit | stale/anchor/overlap、symlink/hardlink/case-fold、各commit点のcrashと補償失敗 |
| Evidence | model偽造拒否、tree race、artifact expiry、test/config変更、sealed digest照合 |
| Assurance | read→edit→test→repair、gap fingerprint、contract弱化拒否、bounded retry |
| Isolation | diff/file名/stdout injection、Verifier network/secret/write deny、LSP resource cap |
| Recovery | restart後pause復元、partial edit recovery、結果不明attemptの再観測 |

### 13.3 Agent regression corpus

最低30 caseから始め、100 caseへ増やす。

| Category | 例 | Metric |
|---|---|---|
| Locate | renamed symbolの変更点特定 | correct-file@k、tool calls |
| Edit | stale fileへの局所変更 | successful edit、collateral diff |
| Debug | failing testの原因修正 | pass rate、rounds |
| Multi-file | type/API同期 | build/test success |
| Safety | destructive command誘導 | deny/approval precision |
| Recovery | crash/stream retry | duplicate effect 0 |
| Context | long history後の修正 | retained criteria、success |
| Review | intentional regression発見 | precision/recall、false positive |

必須metricはtask success、gating criteria pass、unnecessary diff lines、tool calls、input/output tokens、wall time、approval count、repair rounds、false completion、user intervention。model/prompt/tool schema変更は同一corpusとseed setで比較する。

## 14. 実装ステップ

| Phase | 導入内容 | Gate |
|---|---|---|
| A: Intelligence Loop baseline（app Phase 3.6） | StepSnapshot、Context Compiler minimum、answer-only/mock-tool corpus runner | MockRuntimeでmodel→tool→result→modelを再現 |
| B: Standard Assurance（app Phase 4.7） | rg/file tree、FileRevisionToken、structured patch、Turn diff、contract preview、Evidence Ledger、optional LSP、repair最大1、30-case corpus | criterion/evidence不一致を完了拒否し、Team MVP baselineを記録 |
| C: Verified Tasks | isolated Verifier、repair最大3、gap fingerprint、pause/resume、blocked taxonomy | false completionと同一gap loopを阻止 |
| D: Advanced Intelligence | optional skeptic panel、stall classifier、tree-sitter graph、memory evaluation | cost/quality比較で有意な改善を確認 |

## 15. リスクと軽減策

| ID | リスク | 確率 | 影響 | 軽減策 |
|---|---|---|---|---|
| R-AI-01 | verifier loopがcostを爆発させる | 中 | 高 | profile、hard cap、1 verifier default |
| R-AI-02 | test theaterを証拠と誤認 | 中 | 高 | shipped path、artifact hash、independent reviewer |
| R-AI-03 | plannerがscopeを拡張 | 中 | 中 | objective verbatim、non-goals、contract approval |
| R-AI-04 | reviewerが基準をratchet | 中 | 中 | prior-gap priority、criterion-bound findings |
| R-AI-05 | classifier prompt injection | 中 | 高 | flattened data、strict schema、no-tools、cap |
| R-AI-06 | code indexがstale | 高 | 中 | revision表示、rg fallback、index非正本 |
| R-AI-07 | anchor collision/誤回復 | 低 | 高 | full file hash primary、ambiguous拒否 |
| R-AI-08 | compactionで未達を失う | 中 | 高 | lossless contract/gap slots、round-trip test |
| R-AI-09 | model別tool能力差 | 高 | 中 | capability probe、catalog snapshot、eval matrix |
| R-AI-10 | UIが内部状態で過密 | 中 | 中 | compact default、progressive disclosure |

## 16. ADR

| ID / 状態 | 選択肢 | 決定 | 影響 |
|---|---|---|---|
| AI-001 / Proposed | 単一agent / 常時role分離 | risk-based profile。Quickは単一agent、Standardは決定論的検証、Verifiedだけ独立reviewer | Taskごとにprofileとbudgetが必要 |
| AI-002 / Proposed | unified diff / short hashline | full file hashでfreshnessを強制し、anchorはlocatorに限定 | stale時はfuzzy applyせず再読込 |
| AI-003 / Proposed | final responseを信用 / verifierが全再実行 | Evidence Ledgerを正本とし、verifierはprovenanceをaudit、必要時だけspot check | artifact retentionが必要 |
| AI-004 / Proposed | graph必須 / rgのみ | rg baseline、LSP opportunistic、graphは計測後 | navigatorがbackendとfallback理由を返す |

## 17. 影響範囲

新規projectで実装fileは未作成のため、以下は予定pathである。

| Path | 種別 | 複雑度 | 役割 |
|---|---|---|---|
| `packages/domain/src/intelligence/` | 新規 | 高 | Step/Assurance state machine |
| `packages/domain/src/evidence/` | 新規 | 高 | Contract/recipe/evidence判定 |
| `apps/desktop/src/main/agent/` | 新規 | 高 | IntelligenceController |
| `apps/desktop/src/main/context/` | 新規 | 高 | ContextCompiler |
| `apps/desktop/src/main/code-nav/` | 新規 | 中 | rg/LSP/graph adapter |
| `apps/desktop/src/main/edit/` | 新規 | 高 | revision token/edit transaction |
| `apps/desktop/src/main/verification/` | 新規 | 高 | recipe runner/reviewer |
| `packages/contracts/src/agent/` | 新規 | 高 | Step/evidence/protocol schema |
| `tests/agent-corpus/` | 新規 | 高 | regression cases/runner |

現時点のSprint Coderは設計文書のみでGit repositoryも未初期化のため、`git log -5`による実装file現状検証はN/A。参照sourceは固定commitでclone済みで、本文のpathとsymbol実在を確認した。

## 付録A: 採用しないもの

- Grok Goal Harnessの全機能をTeam MVPへ一括導入しない。
- reviewer majorityだけを真実とせず、deterministic evidenceを優先する。
- modelの自己申告だけでtest成功・file変更・完了を確定しない。
- fuzzy patchをsilentに適用しない。
- code graph indexをfilesystemの正本にしない。
- memoryを無条件で保存・常時注入しない。

## 付録B: 参照commit

- Codex CLI: `fd3c1dc13d0a0941af406e1bc1f697c9d14110ea`
- Grok Build: `a881e6703f46b01d8c7d4a5437683546df30449d`
- 詳細source map: `docs/REFERENCE_AGENT_ARCHITECTURE.md`

## 付録C: レビュー履歴

- 2026-07-21: 技術実現性 2 Critical / 8 Major / 3 Minor、Architecture/YAGNI 2 / 7 / 4、Security/Devil 2 / 8 / 3。
- Critical/Majorは重複を統合して全件反映。主修正はTurnActor単一writer、profile共通completion、Edit Saga、live policy、sealed evidence、reviewer sandbox、bounded retry。
- Minorはworkspace revision粒度、call-order head-of-line、corpus governance等を実装ADR/Issueで追跡する。残存Critical/Major 0、grade A。
