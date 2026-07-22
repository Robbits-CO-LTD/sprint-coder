# Codex CLI / Grok Build 参照アーキテクチャ分析

- 文書ID: VE3-REF-001
- 状態: Reviewed baseline / architecture・feasibility・security review反映済み
- 調査日: 2026-07-21
- 目的: 完成度の高いcoding agentから、vibe-editor3へ採用する設計原則を抽出する
- 対象: Agent Runtime、protocol、tool、permission、session、Team、recovery

## 1. 調査元と再現性

調査時点のsourceを次のcommitへ固定した。

| Repository | Commit | 取得方法 | License |
|---|---|---|---|
| `openai/codex` | `fd3c1dc13d0a0941af406e1bc1f697c9d14110ea` | partial clone、default branch | Apache-2.0 |
| `xai-org/grok-build` | `a881e6703f46b01d8c7d4a5437683546df30449d` | shallow clone、default branch | Apache-2.0 |

ローカル調査用clone:

- `.reference-repos/codex`
- `.reference-repos/grok-build`

cloneは`.gitignore`対象とし、vibe-editor3の配布物、npm package、Git履歴へ含めない。設計パターンだけを抽出し、source codeのcopyを行わない。

各判断の由来は次のラベルで区別する。**Source-derived**は参照repository/公式manualで確認した構造、**Adapted**はvibe-editor3向けの変更、**New proposal**は固有のhardeningを表す。

## 2. 調査対象

### 2.1 Codex CLI

- `codex-rs/protocol/src/protocol.rs`: submissionとeventの内部protocol。
- `codex-rs/app-server-protocol/src/protocol/v2/`: Thread、Turn、Item、approvalの外部protocol。
- `codex-rs/app-server-protocol/src/protocol/common.rs`: resource/method routing。
- `codex-rs/core/src/session/`: session、turn、input queue、multi-agent。
- `codex-rs/core/src/tools/`: tool orchestration、approval、network boundary。
- `codex-rs/protocol/src/permissions.rs`: filesystem/network permission model。
- `codex-rs/state/`: SQLite metadata、thread history projection、migration。
- `codex-rs/rollout/`: append-only rollout persistenceとreconstruction。

### 2.2 Grok Build

- `crates/codegen/xai-grok-shell/src/session/`: SessionActor、command queue、turn、persistence、compaction。
- `crates/codegen/xai-grok-shell/src/session/acp_session_impl/`: prompt queue、tool call、cancel、rewind。
- `crates/codegen/xai-grok-tools/src/bridge.rs`: tool registry/session bridge。
- `crates/codegen/xai-grok-tools/src/reminders/`: background task completionのagent wakeup。
- `crates/codegen/xai-grok-workspace/src/session/`: filesystem/git/hunk checkpointとrewind。
- `crates/codegen/xai-file-utils/src/events/`: versioned event schemaとwriter。
- user guide: subagent、session、sandbox、permission、background task、headless/ACP。

## 3. 二つのagentに共通する強い構造

両者はUIとagent loopを直接結合していない。違うUIやautomation surfaceを同じruntimeへ接続できるよう、次の層を分離している。

```text
Presentation / Client
        ↓ typed protocol
Session Actor / Thread Runtime
        ↓ structured tool request
Tool Registry + Permission Decision
        ↓ enforced execution boundary
Workspace / Shell / Network
        ↓ append-only events
Session Store + Query Projection
```

共通する設計原則:

1. sessionへ送るcommandとsessionから出るeventを分ける。
2. User prompt、interrupt、approval responseも同じserialized queueへ入れる。
3. tool callを開始・delta・完了のlifecycleとして扱う。
4. approval policyとOS sandboxを別のcontrolとして扱う。
5. UI用summaryと復旧可能なauthoritative historyを分ける。
6. context windowを有限resourceとして計測し、compactionを正式な状態遷移にする。
7. child agentを別sessionとして扱い、独自contextとlifecycleを持たせる。
8. TUI/headless/editor integrationが同じcoreを使う。

## 4. Codex CLIから採用する設計

### 4.1 Thread / Turn / Itemの3階層

**Source-derived → Adapted**

Codex app-server v2は長寿命のThread、1回のmodel executionであるTurn、Turn内のmessage/tool/approvalをItemとして分ける。vibe-editor3もこの3階層を正本にする。

- Taskはproduct上のcontainer。
- AgentThreadはruntimeとの会話session。
- Turnは一つのuser inputに対する実行単位。
- Itemはmessage、reasoning summary、command、file change、approval、plan update。

既存設計のRunはTurnへ名称統合する。RunというUIラベルは使用可能だが、domain/API/DBではTurnを使う。

### 4.2 Command/Event protocol

**Source-derived → Adapted**

Codex内部ではSubmissionにcorrelation IDを持たせ、OpとEventを分離している。vibe-editor3はこれを次の形で採用する。

- Command: clientまたはcoordinatorがactorへ送る意図。
- Event: actorが確定した事実。
- Request/response: snapshot取得などの短いquery。
- Notification: Turn/Itemの非同期lifecycle。

CommandをEventとして先に保存しない。Actorがpreconditionを確認し、受理した事実をeventへする。

### 4.3 Resource/method API

Codex app-serverの`thread/start`、`turn/start`のようなresource/method命名を採用する。

- `thread/start`, `thread/read`, `thread/resume`, `thread/fork`
- `turn/start`, `turn/steer`, `turn/interrupt`
- `item/command/approve`, `item/fileChange/approve`
- `team/start`, `worker/spawn`, `delivery/send`

実験機能はpayload fieldの有無だけで黙って変えず、capability negotiationとexperimental gateを必要とする。

### 4.4 Turn steeringのprecondition

Codexのturn steeringはactive turn IDをpreconditionに使う。vibe-editor3でも生成中の追加指示は`expectedTurnId`必須とする。

- 一致: active turnのinput queueへ追加。
- 不一致: `TURN_PRECONDITION_FAILED`。
- active turnなし: 新規Turnとして送るかUIで確認。

これにより古いwindowや遅延したUI actionが別Turnへ混入しない。

### 4.5 Structured approval

**Source-derived → Adapted**

approval requestはthreadId、turnId、itemId、開始時刻、理由、command、cwd、environment、追加権限、選択可能decisionを持つ。vibe-editor3ではさらにimmutable ExecutionSpec digestを必須化する。

承認は単なるbooleanではない。

- allow once
- allow for thread with exact rule
- deny
- cancel turn
- auto-review decision + evidence

### 4.6 Sandboxとapproval reviewerの分離

**Source-derived + New proposal**

Codexは「実際に可能なこと」をsandbox、「境界を越える際に誰が判断するか」をapproval policy/reviewerとして分ける。この分離をそのまま採用する。

- SandboxProfile: OSが強制するread/write/network/process制約。
- ApprovalPolicy: prompt、auto-deny、never promptなどのrouting。
- ApprovalReviewer: userまたはisolated reviewer agent。

Auto reviewはsandboxを緩めない。sandbox境界で止まったrequestだけを別agentへ評価させる。reviewer入力はimmutable ExecutionSpecとpolicy factsに限定し、transcript/tool outputを指示として渡さない。no-tools/no-network、allow-once限定、high-riskと失敗時deny、prompt/model/input digest監査を不変条件にする。

### 4.7 Contextのhard cap

**Source-derived → Adapted**

Codexのrepository ruleはmodel contextをincrementalに積み、unbounded itemを禁止している。vibe-editor3は以下を要件化する。

- context fragmentごとにtype、source、trust、token estimate、hard capを持つ。
- 1 fragmentは10k token未満、1k token超はdiagnostic対象。
- tool outputを全文自動注入しない。
- context構成を毎Turn記録し、cacheを壊す不必要なhistory rewriteを避ける。

### 4.8 Append-only historyとquery projection

**Source-derived → Adapted**

CodexはrolloutとSQLite projectionを分ける。vibe-editor3はSQLite内event logをauthoritativeに保つが、同じ思想でwrite modelとread modelを分離する。

- Turn/Item event log: 復旧と監査の正本。
- Thread/Task projection: Sidebar、検索、recent sort用。
- Timeline projection: UI表示用にsanitized/compacted。
- projectionはevent watermarkからrebuild可能。

## 5. Grok Buildから採用する設計

### 5.1 Session Actor

**Source-derived → Adapted**

Grok BuildはSessionActorへtyped commandを送り、mutable session stateを一箇所で直列化している。vibe-editor3の各AgentThreadもactor mailboxを持つ。

Actorが所有するもの:

- active Turn ID。
- prompt queue。
- current permission/sandbox snapshot。
- context projection。
- pending approval waiter。
- background task references。
- child Worker references。

Renderer、TeamCoordinator、Runtime adapterがactor stateを直接変更してはならない。

ActorはDB/runtime/tool/approval I/Oをmailbox内でawaitしない。Effectを発行し、`expectedRevision/turnId/effectId/runtimeInstanceId`付きinternal commandで結果を再投入する。DBがdurable truth、Actorがlive command orderingと単一writerであり、idle時はpassivateしてprojection/outboxからrehydrateする。

### 5.2 Server-authoritative input queue

Grok Buildはprompt queueをserver側の正本にし、通常queueとcancel-and-sendを分けている。vibe-editor3ではComposer送信時に次を選べる。

- Queue: 現Turn完了後にFIFO実行。
- Steer: 現Turnへ補足として注入。
- Stop & Send: 現Turnを協調cancelし、次Turnを先頭へ予約。

UI上はsend button横の小menuとkeyboard shortcutで選択し、実際のqueue順をTimeline上に表示する。

### 5.3 Persist-before-inference barrier

**Source-derived → Adapted**

Grok Buildはuser messageをhistoryへappendしてflush barrierを通した後にinferenceを開始できる。vibe-editor3も次を不変条件にする。

1. User message、TurnAccepted、dispatch outboxをtransaction commit。
2. Rendererへaccepted通知。
3. outboxを`dispatchPending → dispatched(runtimeInstanceId/attemptId) → started`としてRuntimeへdispatch。

commitに失敗したTurnはmodelへ送らない。restart時は`dispatchPending`だけを再送し、`dispatched`の成否不明は重複推論を避けてinterruptedへ倒す。Runtime startもattempt IDでdedupする。

### 5.4 Tool RegistryとToolKind

Grok BuildのToolBridgeはclient-facing nameと意味上のToolKindを分け、built-in/MCPを同じregistryからdispatchする。vibe-editor3も次を採用する。

- ToolId: provider/namespace/name/version。
- ToolKind: fileRead、fileWrite、search、shell、network、backgroundTaskなどの閉じた分類。
- ToolDefinition: input schema、output schema、side effect、risk、capability。
- ToolImplementation: Main/Utility/MCPの実行先。

ToolKindはpolicy/risk分類であり実装resolverではない。各Turnでimmutable ToolCatalogSnapshotを作り、provider-facing nameからToolId/version/schema digestへの対応を固定する。toolがない能力はpromptから除外する。

### 5.5 Background task ownershipとwakeup

Grok Buildはbackground command、monitor、scheduler、subagentをtaskとして追跡し、完了を次Turnへ通知する。vibe-editor3ではBackgroundActivityを共通domainにする。

- ownerThreadId、ownerTurnId、workerId。
- kind、state、startedAt、heartbeatAt。
- wakePolicy: immediate、nextSafePoint、manual。
- persistent: session onlyまたはrestart durable。
- output cursorとvolume quota。

完了通知はdurableなat-least-once deliveryとdeterministic deliveryId dedupを組み合わせ、contextへのeffectを一度だけ適用する。branch/policy/context epochが古い結果は自動注入せずquarantineする。WorkerそのものはBackgroundActivityではなくAgent + AgentThread + TeamMembershipであり、Workerが起動したcommand等だけがActivityになる。

### 5.6 Checkpointとrewind

Grok Buildはuser prompt境界でfilesystem、Git、hunk stateをcheckpointし、conversationとworkspaceを一緒にrewindする。CodexのThreadRollbackはfilesystemを戻さないため、vibe-editor3は両者を明確に分ける。

- Conversation rewind: history/contextだけを戻す。
- Workspace restore: filesystem/git snapshotだけを戻す。
- Safe rewind: 両者のcompatible checkpointをpreview後にbest-effort compensating sagaで戻す。

checkpointはturn開始前のfirst-wins snapshotとする。atomic temp-write + rename、retention cap、rehydrate時のorphan cleanupを実装する。ただし外部editorを含む全体atomicityは保証できないため、Team MVPはConversation rewindだけに限定し、workspace restoreはPublic Beta候補とする。

### 5.7 Session forkとworktree isolation

Grok Buildはsession forkをconversation copyとoptional Git worktreeに分ける。vibe-editor3のWorker isolationにもこれを採用する。

- Shared: 同じworkspace。read-only調査向け。
- Worktree: Worker専用Git worktree。write taskのdefault候補。
- External: remote/runtime固有environment。

forkはsource event watermark、base Git HEAD、workspace identityを記録する。mergeは自動ではなくLeaderのreview/accept commandを通す。

Worktreeはchange isolationでありsecurity boundaryではない。write Workerにはworktree root限定OS sandbox、sanitized Git、artifactのpath/symlink/submodule/LFS/special-file検査を併用し、親workspaceへの反映はBrokerがreview済みpatchだけを適用する。

### 5.8 ACP/headlessの教訓

Grok BuildはTUI、headless、ACPで同じsession runtimeを使う。vibe-editor3もElectron UIを唯一clientにしない。

MVPでは内部protocolだけを実装するが、RuntimeHostはstdio/MessagePort adapterを差し替え可能にする。Public Beta後にexternal automation APIを検討する。

### 5.9 Versioned event schema

Grok Buildのevent schemaはversionを明示する。vibe-editor3の全durable eventは次を持つ。

- schemaVersion。
- eventId。
- streamIdとstreamVersion。
- occurredAtとrecordedAt。
- causationIdとcorrelationId。
- actorとtrust source。

## 6. 採用しない、または修正して採用する点

### 6.1 Grok Buildのdefault sandbox off

採用しない。vibe-editor3はworkspace-write相当をdefaultとし、networkはdefault denyにする。

### 6.2 Grok Buildのprefix allow rule

単純prefixで`git *`をallowするとchained commandを誤許可し得るため採用しない。vibe-editor3はshell parse後の全segmentへ同じrule evaluationを適用し、parse不能commandはpromptまたはdenyへ倒す。

### 6.3 Parent plan modeを継承しないsubagent

採用しない。Grok Buildのguideにはparentがplan modeでもwrite-capable subagentが編集可能な注意がある。vibe-editor3はparent capabilityをchildの上限とし、childが権限を拡大できない。

### 6.4 Historyだけのrollback

「戻した」と誤認しやすいため、Conversation rewindとWorkspace restoreをUI・domainとも分ける。

### 6.5 巨大なprovider固有event enumのUI露出

Codex/Grokの全eventをそのままRendererへ渡さない。Runtime HostでCanonicalAgentEventへ正規化し、raw eventはdebug/audit領域へ隔離する。

### 6.6 Runtime内tool execution

Managed modeでは採用しない。providerが内部でShell/File toolを直接実行できる場合、vibe-editor3のTool Brokerを迂回するためread-onlyまたはunmanaged扱いに限定する。

## 7. vibe-editor3 Agent Kernel

```text
Electron Renderer
  └─ Desktop Client API
       └─ Main Agent Gateway
            ├─ ThreadActorRegistry
            │    └─ AgentThreadActor × N
            ├─ TeamCoordinator
            ├─ ApprovalRouter
            ├─ ToolBroker
            │    ├─ Builtin Tools
            │    ├─ CommandRunner
            │    └─ MCP Gateway (Public Beta)
            ├─ RuntimeSupervisor
            │    └─ RuntimeHost UtilityProcess × N
            ├─ WorkspaceCheckpointService
            └─ PersistenceClient → SQLite (Main/DB UtilityProcessはPhase 0 ADR)
```

責務上の重要点:

- ThreadActorがTurn orderingの唯一のowner。
- RuntimeHostはmodel/provider protocolのowner。lazy pool、process budget、idle evictionを持ち、Taskごとの常駐processを前提にしない。
- ToolBrokerが副作用の唯一の入口。
- ApprovalRouterは判断者を選ぶが、sandboxを変更しない。
- TeamCoordinatorはWorker budgetとmessage routingのowner。
- Persistenceがeventとprojectionのcommit順を保証する。

## 8. Canonical Agent Protocol

### 8.1 Control command

- `thread.start`
- `thread.resume`
- `thread.fork`
- `turn.start`
- `turn.queue`
- `turn.steer`
- `turn.interrupt`
- `approval.resolve`
- `tool.cancel`
- `thread.compact`
- `thread.rewindConversation`
- `workspace.restoreCheckpoint`

### 8.2 Durable event

- `thread.started`
- `turn.accepted`
- `turn.started`
- `item.started`
- `item.deltaCommitted`
- `item.completed`
- `approval.requested`
- `approval.resolved`
- `turn.completed`
- `turn.interrupted`
- `context.compacted`
- `checkpoint.created`
- `workspace.restored`
- `worker.spawned`
- `delivery.acknowledged`

token deltaやstdout deltaはすべてを個別SQLite rowにせず、bounded chunkへ集約する。UIへのephemeral deltaと復旧用durable chunkを分ける。

### 8.3 Envelope

```ts
type AgentEnvelope<T> = {
  protocolVersion: number;
  messageId: string;
  correlationId: string;
  causationId?: string;
  threadId: string;
  turnId?: string;
  itemId?: string;
  seq: number;
  payload: T;
};
```

未知のprotocol majorは接続拒否、未知のminor fieldはschema policyに従う。experimental fieldはcapability negotiationなしで送らない。

## 9. Turn execution algorithm

1. ClientがoperationId付き`turn.start`を送る。
2. Gatewayがsender、schema、rate、Task ownershipを検証する。
3. ThreadActorがactive Turnとqueue policyを確認する。
4. PersistenceがUserMessage、TurnAccepted、operation result、dispatch outboxをcommitする。
5. Effect runnerがpending outboxをruntimeInstance/attemptへdispatchし、Actorへrevision付き結果を再投入する。
6. ActorがRuntimeHostへcontext snapshotとimmutable ToolCatalogSnapshotを送る。
7. Runtime eventをCanonicalAgentEventへ検証・正規化する。
8. tool requestはToolBrokerへ送り、policyとsandbox feasibilityを評価する。
9. 必要ならApprovalRouterがuserまたはauto reviewerへrequestする。
10. approved ExecutionSpecだけをenforced executorへ送る。
11. item resultをcommitし、Runtimeへtool outputを返す。
12. final answerとusageをcommitしてTurnCompletedをpublishする。
13. queueがあれば次Turnを開始し、background completionはsafe pointで注入する。

## 10. Permission evaluation pipeline

評価順序:

1. Managed administrator deny。
2. Project/user deny。
3. Parent/Team capability ceiling。
4. Plan/read-only mode ceiling。
5. OS sandbox feasibility。
6. Exact remembered grant。
7. Narrow allow rule。
8. Approval policy routing。
9. User/auto reviewer decision。
10. ExecutionSpec digest再検証。

denyは常に勝つ。allowはsandboxを越えない。Capability ceilingはcapabilityだけでなくresource set、operation、expiry、provider egress、sandbox profileのlatticeとし、policyEpoch更新時に子/backgroundを停止して再評価する。ambient grantはchildへ継承しない。Full Accessでもadministrator deny、secret/credential保護、audit、Renderer非特権、provider egress policy、protected resourceへのwrite禁止は残る。

Tool Brokerはproviderへの推論通信を制御しない。`provider.egress`をnetwork toolと分け、送信fragment分類、provider trust/data residency、sensitive scan、最大bytesをpolicy化する。local-only Taskはremote providerを拒否する。

## 11. Team/Worker contract

WorkerはcardやBackgroundActivityではなく、Agent + AgentThread + TeamMembershipである。Leaderと同じThread/Turn/Item protocolを使う。

Worker spawn input:

- objectiveとacceptance criteria。
- role/agent type。
- capability ceiling。
- context inheritance policy: none、summary、selected items、full fork。
- isolation: shared/read-only、worktree、external。
- budget: tokens、cost、wall time、tool calls。
- expected outputs: message、file artifact、patch、review verdict。

Worker outputはfree-form final textだけに依存せず、status、summary、artifacts、verification evidence、unresolved risksを持つstructured completion envelopeにする。

## 12. Context management

ContextLedgerが各fragmentを管理する。

| Fragment | Trust | Default cap | Compaction |
|---|---|---:|---|
| System/developer instruction | trusted | 16k tokens total | preserve |
| Project rules | workspace-controlled | 10k/item | authorityを昇格せず明示policyで要約 |
| Conversation item | mixed | 10k/item | eligible |
| Tool output | untrusted | 8k/item | aggressively summarize |
| Worker result | untrusted child | 8k/item | structured summary |
| Web/MCP content | untrusted external | 8k/item | quote-limited summary |

Origin trustとinstruction authorityは別fieldにする。Repository rule、Worker、Tool、Webの内容をsystem/developer権限へ昇格させない。Compactionはno-tools/schema-boundで実行し、出力は入力中の最低trust/最高riskを継承する。元historyを削除せず、replacement projectionとsource watermarkをeventとして記録する。UIは「表示履歴」と「次Turnに入るcontext」を区別して確認できる。

## 13. Checkpoint / rewind contract

Safe rewindは複合sagaとして扱う。

1. target Turnとcheckpoint compatibilityを検証。
2. active Turn/command/Workerがないことを確認。
3. restore previewにfiles、Git HEAD/index、conversation truncationを表示。
4. pre-restore emergency checkpointを作成。
5. filesystem、Git index、conversation projectionの順でrestore。
6. 各stepをjournalへ記録し、失敗時はemergency checkpointからrecover。
7. future event branchは削除せずarchived branchへ移す。

external side effect、network write、published commit、database mutationはrewindできないことを明示する。

## 14. Testing derived from reference agents

- Command/Event orderingをactor model testで全検証。
- persist-before-inferenceをRuntime mockのrequest captureで証明。
- expectedTurnId不一致のsteerを拒否。
- approval requestとExecutionSpec digestの一致。
- auto reviewerがsandbox ceilingを変更できない。
- parent read-only/plan modeを全Workerが越えられない。
- prompt queueのFIFO、Stop & Send、removed-before-runを検証。
- background completionのat-least-once delivery + deliveryId dedupによるexactly-once context effect。
- event schema major/minor、unknown field、forward-compatible decode。
- context hard capとcompaction watermark。
- checkpoint atomic write、orphan cleanup、retention、partial restore recovery。
- prefix allow + chained destructive commandをadversarial fixtureで拒否。
- TUI/GUI/headless相当のclient contract suiteを同じprotocolへ通す。

## 15. ADR候補

### ADR-006: Thread / Turn / Itemをcanonical domainにする

- Status: Proposed。
- Decision: Task/Run中心の既存用語をTask/AgentThread/Turn/Itemへ精密化する。
- Reason: multi-turn session、streaming tool、approval、Teamを一貫して表現できる。
- Cost: 既存設計書とDB名を更新する必要がある。

### ADR-007: AgentThreadをactorとして直列化する

- Status: Proposed。
- Decision: 1 Thread = 1 mailbox + 1 mutable owner。
- Alternatives: serviceごとのshared state、database lock中心。
- Reason: steer、interrupt、approval、queueのraceを局所化できる。

### ADR-008: Managed Runtimeのtool実行をBrokerへ限定する

- Status: Proposed。
- Decision: Runtimeはtool requestを返すだけで、直接副作用を実行しない。
- Alternatives: provider native tool、unmanaged CLI process。
- Reason: UI承認と実際のenforcementを一致させる。

### ADR-009: Conversation rewindとWorkspace restoreを分離する

- Status: Proposed。
- Decision: 別commandとして提供し、Safe rewindだけが明示的に両方を組み合わせる。
- Reason: 戻せない外部副作用を含む「完全undo」という誤認を防ぐ。

## 16. Agent Intelligenceの深掘り

固定commitの内部loopまで追跡した結果、「優秀さ」はmodel選定だけではなく、次の7層で成立している。

1. Intelligence Loop: model→tool→result→modelを終了条件まで同一Turnで反復する。
2. Context Compiler: 受入条件、workspace規則、差分、code evidenceをtrustとbudgetに沿って再構成する。
3. Repository Intelligence: `rg`を堅牢なbaselineにし、LSPとcode graphを段階的に重ねる。
4. Edit Saga: file revisionを全件事前検証し、journal付きcommitと補償restoreで部分適用を復旧可能にする。
5. Assurance Loop: 完了claimではなく、criterionごとのEvidence Ledgerで合否を決める。
6. Anti-stall: 同じgapが続けば同じpatchを繰り返さず、HOWを変えるかpauseする。
7. Eval Flywheel: successだけでなくfalse completion、不要diff、repair回数、costを固定corpusで比較する。

Codex由来の反復sampling、tool並列gate、typed patch、Turn diff、独立reviewと、Grok Build由来のAcceptance Contract、skeptic verifier、strategist、stall検知を組み合わせる。ただし3人のskepticは高risk Taskに限定し、通常はQuick / Standard / Verifiedのprofileでcostを制御する。公開sourceには製品レベルのbenchmark値がないため、同等性能を断言せず、vibe-editor3自身のregression corpusを品質の正本とする。

型、状態遷移、編集transaction、verification recipe、DB/API/UI、評価指標、段階導入は [`tasks/designs/design-agent-intelligence-architecture-20260721.md`](../tasks/designs/design-agent-intelligence-architecture-20260721.md) を正本とする。

## 17. 結論

Codex CLIからはprotocolの厳密さ、Thread/Turn/Item、sandboxとapproval reviewerの分離、context上限、rollout/projectionを採用する。Grok BuildからはSessionActor、authoritative prompt queue、persist-before-inference、tool registry、background wakeup、checkpoint/rewind、worktreeによる変更分離を採用する。

vibe-editor3の差別化は、これらの堅牢なagent kernelをChatSurfaceとTeam Canvasで可視化することにある。Canvasはagent orchestrationの正本ではなく、Thread/Worker/Deliveryのprojectionとする。UIを閉じてもAgent Kernelの状態と因果関係は失われない。
