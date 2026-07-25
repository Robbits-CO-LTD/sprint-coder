# Sprint Coder プロダクト・詳細設計書

- 文書ID: VE3-DESIGN-001
- 状態: Reviewed design baseline
- 作成日: 2026-07-20
- 対象: MVPから正式リリースまで
- 実装基盤: Electron + TypeScript
- 参照分析: `docs/REFERENCE_AGENT_ARCHITECTURE.md`

## 1. 目的とプロダクト原則

Sprint Coderは、ユーザーが一人のAIと自然に会話を始め、仕事が大きくなったときだけ同じ会話をTeam Leaderへ昇格できるデスクトップアプリである。

中心体験は「ChatからTeamへの連続性」である。Team機能を開いた瞬間に別画面へ切り替えず、会話中のChatSurfaceが同一性を保ったまま縮小・移動し、無限Canvas上のLeaderになる。Workerも簡易カードではなく、同じChatSurfaceを持つ。

設計原則:

1. Chat first: 初回起動から入力までの認知負荷を最小化する。
2. Same surface: 通常Chat、Leader、Workerで操作・情報構造を変えない。
3. Progressive disclosure: Team、権限、詳細ログは必要なときだけ見せる。
4. Local first: 履歴、実行イベント、設定は端末内で復元可能にする。
5. Explicit trust: ファイル、Shell、Networkなどの権限境界をUIに出す。
6. Observable execution: AIの生成、検索、コマンド、承認待ちを同じRunカードで追えるようにする。
7. Calm motion: アニメーションは状態変化を説明するために使い、装飾だけの動きにしない。

### 1.1 成功指標

- 新規ユーザーが起動後60秒以内に最初のメッセージを送信できる。
- 通常ChatからTeam作成まで3操作以内で完了する。
- Run実行中、現在の段階・対象・停止方法を5秒以内に理解できる。
- クラッシュ後、確定済みメッセージとRunイベントを欠損なく復元できる。
- Team内で「誰が誰へ何を依頼したか」をCanvasと履歴の両方から追跡できる。
- 主要UI操作のキーボード完結率100%を目標とする。

### 1.2 非目標

- MVPではクラウド同期、組織共有、共同編集を提供しない。
- MVPではプラグインマーケットを提供しない。
- MVPではブラウザをアプリ内へ完全内蔵しない。
- MVPでは任意スクリプトからUIを拡張する仕組みを提供しない。
- MVPでは複数ウィンドウ間の同一Task同時編集を保証しない。

### 1.3 リリース境界

- Prototype: Phase 0。採用技術の成立可否を判断する破棄可能な試作。
- Chat Alpha: Phase 1–3。Task、永続Chat、streaming Run、中止・復元まで。
- Team MVP: Phase 4–6に加え、`tasks/IMPLEMENTATION_PLAN.md`の「Team MVP blocking subset」に定義したsecurity、crash recovery、keyboard/reduced-motion、performance、Standard Assurance gateまで。
- Public Beta: Phase 7全体とPhase 8。署名済み配布、update、対象OS実機検証まで。

Team MVPからは高度なmessage branching、Task pin/archiveの高度化、Mini map、support bundle、telemetry、beta/stable channelを外せる。中心価値であるChat→Leader、Worker、承認、通信表現は外さない。

## 2. ユーザーと主要ユースケース

### 2.1 想定ユーザー

- AIに相談しながら企画・設計・実装を進める個人開発者。
- 複数のAIへ調査・実装・レビューを分担したいパワーユーザー。
- コマンド実行の透明性と権限制御を重視する業務ユーザー。

### 2.2 Job Stories

- 作業を始めるとき、設定画面を巡らず、すぐAIへ相談したい。
- 会話が大きくなったとき、文脈をコピーせず、その会話をLeaderにしたい。
- Teamが動くとき、Workerの担当・進行・出力を一望したい。
- LeaderがWorkerへ依頼するとき、通信先と内容を視覚的に確認したい。
- AIがShellを実行するとき、何を・なぜ・どこで実行するか確認したい。
- 後日Taskを開いたとき、最終回答だけでなく途中の意思決定も復元したい。

## 3. 機能要件

### 3.1 TaskとChat

- FR-CHAT-01: ユーザーは新規Taskを作成、改名、ピン留め、アーカイブできる。
- FR-CHAT-02: 左SidebarにTask履歴を日付グループで表示する。
- FR-CHAT-03: メイン列は最大幅780pxを基準とし、長文の可読性を保つ。
- FR-CHAT-04: Composerは画面下部に追従し、複数行入力、添付、送信、中止を提供する。
- FR-CHAT-05: Enter送信、Shift+Enter改行を既定とし、設定で変更可能にする。
- FR-CHAT-06: メッセージはUser、Assistant、System Notice、Run Card、Approval Cardを表現できる。
- FR-CHAT-07: Assistant回答はMarkdown、コードブロック、表、引用、ファイル参照を安全に描画する。
- FR-CHAT-08: 回答生成中はストリーム表示し、中止後も受信済み内容を保持する。
- FR-CHAT-09: 再生成は元回答を上書きせず、branchとして記録する。
- FR-CHAT-10: 添付ファイルは送信前に一覧・サイズ・種別・参照範囲を確認できる。

### 3.2 Composer設定

- FR-COMP-01: ComposerからModel、Reasoning effort、Access modeを選択できる。
- FR-COMP-02: 通常利用で設定が邪魔にならないよう、選択値は小さなsummary rowへ畳む。
- FR-COMP-03: Access modeは「確認する」「安全時は自動」「フルアクセス」の3 presetを提供する。
- FR-COMP-04: フルアクセス選択時は影響範囲を明記し、意図的な確認操作を一度要求する。
- FR-COMP-05: Goalを設定でき、Task headerとComposerの双方から確認・編集できる。
- FR-COMP-06: Team作成はComposerのTeam actionまたはTask headerから開始できる。

### 3.3 Runとコマンド実行

- FR-RUN-01: 1回のAssistant応答をUI上はRun、domain/API上はTurnとして扱い、一意なturnIdを付与する。
- FR-RUN-02: Runは `queued → understanding → planning → executing → synthesizing → completed` を基本状態とする。
- FR-RUN-03: `waiting_approval`、`blocked`、`canceling`、`canceled`、`failed` を例外状態として持つ。
- FR-RUN-04: Run Cardには経過時間、現在段階、要約、停止ボタンを常時表示する。
- FR-RUN-05: Tool callは検索、ファイル読取、ファイル変更、コマンド、外部通信を区別する。
- FR-RUN-06: コマンドカードには目的、cwd、command、live output、exit code、所要時間を表示する。
- FR-RUN-07: 大量出力はUI上で仮想化し、全文はログファイルまたはイベントDBから参照する。
- FR-RUN-08: stdoutとstderrは順序付きsequenceで保存し、再表示時に同順序を保証する。
- FR-RUN-09: 停止はまず協調キャンセル、猶予後にプロセスツリー終了へ移行する。
- FR-RUN-10: アプリ再起動時、実行中だったRunは `interrupted` として確定し再試行を提示する。
- FR-RUN-11: 長寿命の会話をAgentThread、1回の実行をTurn、message/tool/approvalをItemとして識別する。
- FR-RUN-12: 生成中の追加入力はQueue、Steer、Stop & Sendを選択できる。
- FR-RUN-13: SteerはexpectedTurnIdを必須とし、active Turn不一致時は拒否する。
- FR-RUN-14: User messageとTurn accepted eventのcommit完了前にRuntimeへinferenceを送らない。
- FR-RUN-15: context使用量をfragment種別ごとに表示し、hard cap到達前に自動compactionする。
- FR-RUN-16: background command、monitor、scheduler、Workerの完了を一度だけTurnへ通知する。
- FR-RUN-17: Conversation rewindとWorkspace restoreを別操作として提供し、複合Safe rewindはpreviewを必須とする。

### 3.4 承認

- FR-APR-01: 権限が必要な操作はChat内のApproval Cardで提示する。
- FR-APR-02: Cardには理由、操作対象、影響範囲、実行内容、リスク分類を表示する。
- FR-APR-03: 選択肢は「今回のみ許可」「Task中許可」「拒否」を基本とする。
- FR-APR-04: Shellは正規化後の実行ファイル・引数・cwdを表示し、表示内容と実行内容を一致させる。
- FR-APR-05: 許可はcapability、resource scope、run/task scope、有効期限で記録する。
- FR-APR-06: 拒否してもRun全体を即失敗させず、Runtimeへ拒否結果を返して代替案を生成可能にする。

### 3.5 Team

- FR-TEAM-01: 通常TaskをTeamへ昇格してもtaskId、会話履歴、Run履歴を維持する。
- FR-TEAM-02: 昇格したChatSurfaceがLeaderとなり、別のLeader用UIへ置換しない。
- FR-TEAM-03: Team作成時は役割、目的、人数、予算上限を確認できる。
- FR-TEAM-04: Workerは一人ずつstaggerして出現し、opacity、scale、blurの組合せで浮かび上がる。
- FR-TEAM-05: 雇用時にはLeader–Worker間の線を描画しない。
- FR-TEAM-06: LeaderがWorkerへmessageを送る瞬間だけ、丁寧なBezier曲線の通信ケーブルを描画する。
- FR-TEAM-07: ケーブル上にpacket pulseを流し、送信元・送信先・方向を表現する。
- FR-TEAM-08: 通信完了後、ケーブルは弱い残光を残して消える。常設edgeは表示しない。
- FR-TEAM-09: WorkerはLeaderと同じChatSurfaceを使い、Composer、Run Card、Approval状態を持つ。
- FR-TEAM-10: Worker生成時、Cameraは対象へ大きく寄るが、カードをviewport全体にはしない。
- FR-TEAM-11: Cameraは自動移動後にその位置を維持し、勝手にLeaderへ戻らない。
- FR-TEAM-12: ユーザー操作が始まった場合、進行中の自動Camera animationをキャンセルする。
- FR-TEAM-13: LeaderはWorkerへ指示、追加質問、停止、再開、終了を送れる。
- FR-TEAM-14: Worker間の直接通信はMVPでは禁止し、Leader経由に限定する。
- FR-TEAM-15: Canvas上の状態と時系列の通信履歴を相互に辿れる。
- FR-TEAM-16: WorkerのcapabilityはLeaderおよびTeam policyを上限とし、spawn時に権限を拡大できない。
- FR-TEAM-17: write-capable WorkerはGit repositoryでは専用worktreeをdefault候補とする。
- FR-TEAM-18: Worker completionはstatus、summary、artifacts、verification、unresolved risksを持つstructured envelopeとする。
- FR-TEAM-19: CanvasはAgentThread/Worker/Deliveryのprojectionであり、orchestrationの正本にしない。

### 3.6 Canvas

- FR-CAN-01: Pan、zoom、selection、fit view、node focusを提供する。
- FR-CAN-02: Canvas viewportとnode位置をTask単位で永続化する。
- FR-CAN-03: Nodeの最小表示幅は640px相当、標準は720pxとしChatの可読性を保つ。
- FR-CAN-04: zoom out時は段階的LODで本文を省略し、状態・役割・進捗を残す。
- FR-CAN-05: focus時はカード自体の寸法を変えず、world transformで寄る。
- FR-CAN-06: Workerが増えても既存nodeを突然移動させず、空き領域へ配置する。
- FR-CAN-07: Mini mapはMVP後半で追加し、初期MVPはfit viewと検索で代替する。

### 3.7 設定とワークスペース

- FR-SET-01: Workspaceは「AIが参照・変更できるローカルフォルダ」として明示する。
- FR-SET-02: Workspace未選択でも相談Chatは利用可能にする。
- FR-SET-03: Workspace選択時にroot pathと現在のAccess modeをTask headerへ表示する。
- FR-SET-04: API keyやtokenは平文設定ファイルに保存しない。
- FR-SET-05: Themeは初期リリースではDarkを正本とし、System/Lightは後続にする。

## 4. UX・情報設計

### 4.1 通常Chatレイアウト

```text
┌ Sidebar 264 ┐┌──────────────── Main ────────────────┐
│ New task    ││ Task title        Goal   Team   …    │
│ Search      ││                                       │
│ Pinned      ││      conversation column ≤ 780        │
│ Today       ││      messages / run cards             │
│ Previous    ││                                       │
│ Settings    ││      composer (sticky bottom)          │
└─────────────┘└───────────────────────────────────────┘
```

Sidebarは探索、Mainは思考に責務を分ける。Main headerへ常設するのはTask名、Goal、Team action、overflowのみ。Workspaceは選択済みの場合にpath chipとして表示し、意味の曖昧な単独ボタンにしない。

### 4.2 ChatSurface

ChatSurfaceは以下を内包する再利用可能なproduct surfaceである。

- SurfaceHeader: agent identity、role、status、goal、overflow。
- Timeline: message、Run、Approval、Team event。
- ContextBar: workspace、branch、permission preset、usage。
- Composer: input、attachment、model、effort、access、send/stop。
- SurfaceFooter: recovery、connection、background activity。

通常ChatとCanvas nodeの違いはcontainer layoutとviewport contextだけに限定する。内部component contract、state selector、keyboard behaviorは共有する。性能上、focus中または実行中のnodeだけをinteractive surfaceとしてmountし、他は同じtoken・情報階層のread-only projectionへ落とせる。draft、scroll、selectionはnode外のSurface Stateへ保持し、focus時に復元する。

### 4.3 生成中の表示

生成中は空の吹き出しへ点滅する三点リーダーを置かない。Run Cardを会話の一項目として置き、以下を順に更新する。

1. ユーザーの依頼を理解中
2. 方針を組み立て中
3. ファイル・コマンドを実行中
4. 承認を待っています
5. 回答をまとめ中

「ファイル・情報を確認中」と「コマンドまたは変更を実行中」は分けない。Runtimeから観測できるのは読み取りと書き込み・実行を含む一つのtool実行局面であり、この二つを別stageとして提示すると実際には遷移しないラベルが並ぶ。代わりに、承認待ちを独立したstageとして持つ。承認待ちはユーザーの操作を待って停止している状態であり、実行中と区別できなければ「進んでいないのは誰の番か」が分からない。実装の正はrendererの`STAGE_ORDER` / `STAGE_LABEL`（`store/appStore.ts`）。

各stageは短い現在形のラベルとelapsed timeを持つ。完了したstageは折り畳み、現在stageだけ詳細を開く。回答tokenが届き始めたらRun Cardの下にAssistant messageをstreamし、Run Cardはcompact summaryへ縮む。

### 4.4 コマンドカード

```text
┌ Command · running                         00:08  Stop ┐
│ テストを実行して変更の整合性を確認します               │
│ ~/project  $ npm test                               │
├─────────────────────────────────────────────────────┤
│ PASS src/domain/task.test.ts                         │
│ … live output                                       │
└─────────────────────────────────────────────────────┘
```

defaultでは目的と直近8行を表示する。展開すると全stream、環境差分、exit code、copy controlsを見せる。ANSI colorは安全なsubsetへ変換し、terminal escapeによるリンク偽装を防ぐ。

### 4.5 Approval Card

承認modeの選択UIと個別承認Cardを分離する。Mode selectorは設定、Approval Cardは具体的操作である。Approval Cardは色だけに頼らずicon、risk label、対象path/domainを表示する。

### 4.6 Teamへのshared-element transition

ChatSurfaceのDOM subtreeを複製せず、SurfaceLayer内で同じinstanceを保つ。通常layoutの矩形とCanvas上Leader矩形を測定し、FLIP方式でtransformを補間する。

Transition sequence:

1. 入力を一時ロックし、現在のsurface boundsを取得する。
2. Sidebarと周囲のchromeを120–180msで静かにfade/translateする。
3. 背景にCanvas gridと奥行きを220msで出す。
4. ChatSurfaceを420–560msでLeader位置へscale/translateする。
5. Canvas controlsとTeam headerを遅れてfade inする。
6. Workerを140ms間隔でstagger spawnする。

中断時は最寄りの確定状態へsnapせず、現在transformから短くsettleする。`prefers-reduced-motion` ではcross-fadeと即時layout変更へ置換する。

### 4.7 Worker spawnとCamera

Worker nodeは空き位置へ予約した後、`opacity 0→1`、`scale .94→1`、`blur 10px→0`、`translateY 18px→0` で320–420msかけて浮かび上がる。過剰なspring bounceは使わない。

spawn開始から約120ms後にCameraを対象へ移動し、nodeがviewportの65–75%程度を占めるzoomへ寄せる。node自身は720pxのまま。ユーザーがwheel、pointer、keyboardでCanvasを操作した時点でCamera ownershipをuserへ返す。

### 4.8 通信ケーブル

通信ケーブルは永続的な組織図ではなく、一時的なmessage delivery表現である。

- Leaderのsource anchorとWorkerのtarget anchorからcubic Bezierを生成する。
- path lengthを取得し、stroke-dashoffsetで180–260msかけて描く。
- 2–3個のpacket pulseをpathに沿って送る。
- target到達時にWorker headerへ小さなreceive glowを出す。
- 配送確定後300–500msでopacityを落とす。
- 同時送信は色を増やさず、offsetとpacket timingで区別する。

## 5. 非機能要件

### 5.1 性能

- NFR-PERF-01: warm startでMain window interactiveまで2秒以内を目標とする。
- NFR-PERF-02: Composer入力のp95応答を16ms以内に保つ。
- NFR-PERF-03: 10 Worker、各200 messageのCanvasでpan/zoom 50fps以上を目標とする。
- NFR-PERF-04: 1万Turn eventのTaskを初回表示500ms以内、以後200ms以内を目標とする。
- NFR-PERF-05: stdout streamは100msまたは64KBでbatchし、1行ごとのReact renderを避ける。

### 5.2 信頼性

- NFR-REL-01: 永続イベントはUI通知より先にtransaction commitする。
- NFR-REL-02: schema migrationはbackup、transaction、version記録、rollback方針を持つ。
- NFR-REL-03: Runtime異常終了がElectron mainと他のWorkerへ伝播しない。
- NFR-REL-04: 同一operationIdの再送で副作用を重複実行しない。

### 5.3 アクセシビリティ

- NFR-A11Y-01: WCAG 2.2 AA相当のcontrastを満たす。
- NFR-A11Y-02: focus ringを消さず、Canvas node移動以外は全操作をkeyboardで行える。
- NFR-A11Y-03: streaming更新をlive regionへ逐語送信せず、stage変更だけ通知する。
- NFR-A11Y-04: reduced motion時はCamera fly、packet pulse、blurを抑止する。

### 5.4 セキュリティ

- NFR-SEC-01: Rendererはsandbox有効、Node integration無効、context isolation有効とする。
- NFR-SEC-02: Preloadはraw `ipcRenderer`を公開せず、用途別のtyped methodだけを公開する。
- NFR-SEC-03: MainはIPC payload、sender frame、task/workspace ownershipを検証する。
- NFR-SEC-04: local resourceは `file://` ではなくapp custom protocolで配信する。
- NFR-SEC-05: CSPを `default-src 'self'` 起点で構築し、unsafe-evalをproductionで禁止する。
- NFR-SEC-06: navigation、新規window、external URLをallowlistで制限する。
- NFR-SEC-07: credentialsはElectron safeStorageの非同期APIで暗号化する。
- NFR-SEC-08: Electronは公式サポート中の最新3 stable line内に維持する。

## 6. 技術スタック

| 領域 | 採用 | 理由・制約 |
|---|---|---|
| Desktop | Electron | Node統合をMainへ隔離し、クロスプラットフォームUIを提供 |
| 言語 | TypeScript strict | IPC・event・UI stateの契約を共有 |
| UI | React | ChatSurfaceの同一component再利用とstream更新 |
| Build/Package | Electron Forge | 公式toolchain、maker、fuses、native module対応 |
| Bundler | Forge Vite plugin | 高速開発。experimental表記のためPhase 0でpackage/release spikeを必須化 |
| Canvas | 自前DOM world（追加依存なし） | ref直接変異のカメラ（`TeamCanvas/useCamera.ts`）、world座標のabsolute配置node、world内SVGケーブル。`@xyflow/react`は不採用（ADR-010）。ChatSurfaceはcustom node化せず、SurfaceLayerが単一instanceをanchorへ再親付けする（ADR-002） |
| State | Zustand + reducer | transient UI stateを小さく管理。永続状態はDB/eventから投影 |
| Validation | Zod | IPC、Runtime adapter、永続event境界のruntime validation |
| DB | SQLite + better-sqlite3 + PersistenceClient | connectionの物理配置はMainまたはDB Utility ProcessをPhase 0で比較決定。transaction、WAL、native rebuildをCIで検証 |
| Tests | Vitest + Testing Library | domain、component、IPC contract |
| E2E | Playwright Electron | experimental APIのためgolden-path中心。OS dialogはMain側stub |
| Logging | Pino-compatible structured JSON | secret redaction、correlation ID、support bundle |

依存versionは実装開始時にlockfileへ固定する。本文に将来陳腐化する具体versionを埋め込まず、RenovateまたはDependabotの週次PRとElectron support policy gateで更新する。

## 7. Electronプロセス設計

```text
Renderer (sandboxed React)
  │ typed commands / snapshots
Preload (narrow contextBridge)
  │ validated IPC + MessagePort handoff
Main Process
  ├─ AppKernel / WindowManager
  ├─ IpcRouter / PermissionBroker
  ├─ AgentGateway / ThreadActorRegistry
  ├─ TaskService / TeamCoordinator
  ├─ ApprovalRouter / ToolBroker
  ├─ WorkspaceCheckpointService
  ├─ PersistenceClient / SecretStore
  │    └─ SQLite single writer (Main or DB Utility Process; Phase 0 ADR)
  └─ RuntimeSupervisor
       ├─ Agent Runtime utility process A
       ├─ Agent Runtime utility process B
       └─ Command child process trees
```

### 7.1 Renderer

表示とユーザー入力だけを担当する。filesystem、process spawn、credential、DBへ直接アクセスしない。Server state相当の永続情報はquery facadeからsnapshotを取得し、event streamで追随する。

### 7.2 Preload

`window.sprintCoder`へ用途別APIを公開する。例: `tasks.list()`、`threads.start()`、`turns.subscribe()`、`approvals.resolve()`。任意channel名を指定できるAPI、Node object、Electron event objectを公開しない。unsubscribe関数を必ず返す。

### 7.3 Main

権限のある唯一のapplication control plane。IPC handlerは薄くし、domain commandをserviceへ委譲する。Window lifecycle、custom protocol、session policy、secret、runtime processを所有する。Mainはasync PersistenceClientだけを使い、SQLiteの物理配置はPhase 0でMain直置きとDB Utility Processを比較して決定する。durable stateの正本はDB、ThreadActorはlive command orderingと未確定transitionの唯一のwriterとする。Actorは外部I/Oをawaitしてmailboxを塞がず、Effectを発行して解放し、完了をrevision/effectId付きinternal commandとして再投入する。

### 7.4 Utility process / command process

Agent Runtime HostはUtilityProcessを第一候補とし、Main event loopからAI stream parsingとruntime protocolを隔離する。UtilityProcessはcrash/performance隔離であり、OS security sandboxではない。Runtimeは最小environment、専用cwd、個別secret、独立process group/jobへ制限し、DB/SecretStore handleを渡さない。Shell commandは専用CommandRunnerからspawnし、OS別の終了処理を抽象化する。

## 8. Domain modelと状態機械

### 8.1 集約

- Task: title、goal、workspace、mode、active branch、archive状態。
- AgentThread: runtime session、active Turn、input queue、context ledger、permission snapshot。
- Turn: user input、execution lifecycle、usage、completion/cancel状態。UI上のRunに対応。
- Message: author、content parts、parent/branch、delivery状態。
- ToolCall: catalog revision、provider call、ExecutionSpec、result、lifecycle。
- Team: leaderAgentId、worker membership、budget、lifecycle。
- Agent: threadId、role、runtime configuration、status、surface position。
- Approval: requested capability、resource、decision、scope、expiry。
- TeamMessage: source、target、payload summary、delivery sequence、status。

ItemはaggregateではなくTimeline projectionである。共通headerとしてturnId、kind、ordinal、stateと、Message/ToolCall/Approval/PlanUpdate等の具体entity IDだけを持つ。内容とdecisionの正本は各entity tableに置く。

### 8.2 Turn state machine

```text
queued → understanding → planning → executing → synthesizing → completed
                          │             │
                          └→ waiting_approval ─allow→ executing
                                           └deny→ executing|blocked
any active → canceling → canceled
any active → failed
app exit during active → interrupted
```

transitionはDomain serviceだけが発行できる。不正transitionは保存せず、diagnostic eventを記録する。

### 8.3 Input queue state machine

```text
submitted → accepted → queued → dispatching → running → completed
                  │         │
                  │         └ removed_before_run
                  ├ steer(active expectedTurnId) → attached_to_active
                  └ stop_and_send → cancel_requested → queued_front
```

queue順のdurable正本はDB、ThreadActorはrevision付きworking stateを持つ。同じThreadのTurn start、settings update、steer、interrupt、approval responseは同じmailboxで直列化する。User message、`turn.accepted`、dispatch outboxを一つのtransactionで永続化してからRuntimeへdispatchする。`accepted → dispatchPending → dispatched(runtimeInstanceId, attemptId) → started`を区別し、起動時はdispatchPendingだけを安全に再送する。

### 8.4 Team lifecycle

```text
draft → forming → active → winding_down → completed
          │         │
          └ failed  └ paused ↔ active
```

Workerは `invited → spawning → ready → busy → waiting → done|failed|stopped`。UIのspawn完了とruntime readyは分け、animationが終わってもruntime未接続なら `connecting` を表示する。

### 8.5 Message delivery

`created → persisted → dispatching → delivered → acknowledged`。通信ケーブルは `dispatching` から `delivered` まで表示する。再送は同じmessageIdを使い、Worker側でdeduplicateする。

## 9. 永続化設計

PersistenceClient boundaryを固定し、SQLite connectionをMainで保持するかDB Utility Processへ隔離するかはADR Proposedとする。Phase 0でMain event-loop stall、IPC p95/p99、packaging、failure isolationを測り、応答予算を満たす最小構成を選ぶ。どちらでもRendererとAgent Runtimeへconnectionを渡さず、WAL、foreign key、busy timeoutを設定する。通常起動では全event replayを行わず、version付きprojection snapshotとwatermarkから復元する。Task、Message、Team、Approvalはrelational stateが正本であり、append-only auditをTurn eventとTeam message deliveryに限定する。`turns`は同一transactionで更新するquery用summaryで、Turn eventから再構築可能にする。

主要table:

| table | 主な列 | 用途 |
|---|---|---|
| tasks | id, primary_thread_id, title, goal, workspace_id, mode, timestamps | Task正本 |
| agent_threads | id, task_id, runtime_kind, state, active_turn_id, revision | 会話session正本 |
| turns | id, thread_id, user_message_id, state, usage_json, timestamps | Turn summary projection |
| timeline_items | id, turn_id, kind, entity_id, state, ordinal | 共通timeline projection |
| messages | id, thread_id, turn_id, parent_id, author, content_json | 会話branch |
| tool_calls | id, turn_id, catalog_revision, tool_id, state, spec_digest | ToolCall正本 |
| turn_events | thread_id, seq, turn_id, item_id, type, payload_json | append-only実行履歴 |
| teams | id, task_id, state, leader_agent_id, budget_json | Team正本 |
| agents | id, team_id, thread_id, role, state, runtime_config_json | product agentとThreadの1:1対応 |
| team_messages | id, team_id, source_agent_id, target_agent_id, seq, state | 通信追跡 |
| approvals | id, turn_id, item_id, spec_digest, capability, resource_json, decision | 承認監査 |
| workspaces | id, canonical_path, display_name, trust_state | path scope |
| attachments | id, message_id, path, hash, size, mime | 添付metadata |
| canvas_views | task_id, viewport_json, nodes_json, revision | layout |
| input_queue | thread_id, ordinal, operation_id, mode, payload_json, state | server-authoritative queue |
| dispatch_outbox | turn_id, attempt_id, runtime_instance_id, state, payload_digest | inference dispatch復旧 |
| background_activities | id, owner_thread_id, owner_turn_id, kind, state, wake_policy | background task追跡 |
| context_fragments | id, thread_id, source, trust, token_estimate, hard_cap | context ledger |
| thread_branches | id, thread_id, parent_branch_id, forked_at_seq, head_seq, state | conversation branch/head |
| workspace_checkpoints | id, task_id, turn_id, kind, manifest_path, state | rewind/restore metadata |
| operations | principal, task_id, kind, operation_id, request_hash, state, result_json | 永続重複排除 |
| schema_migrations | version, checksum, applied_at | migration監査 |

Runという語はUI labelに限定し、DB/APIでは`turns/turn_events`へ統一して二重の正本を作らない。`turn_events` は `(thread_id, seq)` unique、`team_messages` は `(team_id, seq)` uniqueとする。保存eventは初版からschemaVersion、eventId、streamId、streamVersion、occurredAt、recordedAt、causationId、correlationId、actor/trust sourceを持ち、forward-compatible decoderとprojection watermarkをPhase 3で実装する。汎用upcaster/checksum frameworkは実際のmigration要求まで作らない。event種別ごとにbytes/depth/rate上限と全体quotaを持つ。大きなstdoutはapp-private chunk fileへ退避し、temp write → fsync → atomic rename → hash確認 → DB commitとし、起動時にorphan/missing chunkをreconcileする。Message本文とTool出力には保存前secret redaction、保存上限、retention、truncation表示を適用する。

`operations` は `(principal, task_id, kind, operation_id)` uniqueとする。同じID・同じrequest hashは保存済み結果を返し、異なるhashはsecurity errorとする。外部副作用は `prepared → dispatched → observed → completed|unknown` で記録し、crash後の`unknown`を自動再実行しない。

`tasks.primary_thread_id`はTask内のprimary threadを一意にする。Team昇格時は既存primary threadへLeader Agentをtransactionで割り当て、Worker spawnはAgentとAgentThreadを同時作成する。TeamMessageはagentIdを正本とし、TeamCoordinatorがthreadIdへ解決する。

ThreadActorは自身のTurn/Message/ToolCall/Approval eventだけを発行する。TeamCoordinatorはmembership、budget、deliveryだけを発行する。Projection Builderが両streamをjoinしてTeam List/Canvasを作り、Coordinatorはread modelを直接変更しない。Canvas位置は独立したUI layout stateとする。

書込順序:

1. Domain commandをvalidationする。
2. transaction内でaggregate更新とevent appendを行う。
3. commit後にin-memory event busへpublishする。
4. Rendererへsequence付きeventを送る。
5. gapを検出したRendererはsnapshot + last sequenceを再取得する。

## 10. IPC契約

IPC contractは `packages/contracts` に置き、Main、Preload、Renderer、Runtime Client/Hostで共有する。ただしRenderer bundleへprivileged implementationを含めない。

Command envelope:

```ts
type CommandEnvelope<T> = {
  requestId: string;
  operationId: string;
  taskId?: string;
  expectedRevision?: number;
  payload: T;
};
```

Result envelope:

```ts
type CommandResult<T> =
  | { ok: true; requestId: string; revision?: number; value: T }
  | { ok: false; requestId: string; error: PublicError };
```

原則:

- commandはinvoke/handle、長時間streamはMessagePortを使う。
- subscriptionはMainでwatermarkを固定し、`snapshot(atSeq=N)`と`events(seq>N)`を原子的に接続する。再接続は`afterSeq`を渡す。
- payloadはZodで両端validationし、unknown fieldは原則rejectする。
- errorはcode、userMessage、retryable、correlationIdだけをRendererへ返す。
- stack、credential、raw filesystem errorをRendererへ漏らさない。
- sender URLはapp custom protocol、top frame、既知window idを照合する。
- 正規Renderer侵害も脅威に含め、task/workspace binding、revision、size/rate limitを検証する。承認はMain生成のimmutable digestとsingle-use challengeへ結び付ける。

主要channel familyはPreload API上の分類であり、Main内部のAgent Gatewayはresource/method形式を正本とする。

- `task:*`: create/list/get/update/archive。
- `thread:*`: start/read/resume/fork/compact。
- `turn:*`: start/queue/steer/interrupt/subscribe/snapshot。
- `item:*`: approve/cancel/readOutput。
- `approval:*`: resolve/listPending。
- `team:*`: create/addWorker/send/stop/subscribe。
- `workspace:*`: select/inspectTrust/revoke。
- `settings:*`: get/update。

Agent Gatewayのcanonical method:

- `thread/start`, `thread/read`, `thread/resume`, `thread/fork`
- `turn/start`, `turn/queue`, `turn/steer`, `turn/interrupt`
- `item/command/approve`, `item/fileChange/approve`
- `team/start`, `worker/spawn`, `delivery/send`

`turn/steer`はexpectedTurnIdを必須にする。experimental method/fieldはRuntime handshakeのcapability negotiationで両端が合意した場合だけ送る。unknown protocol majorは拒否し、minor互換はschema fixtureで検証する。

## 11. Runtime HostとTool実行

### 11.1 Runtime Client interface

```ts
interface RuntimeClient {
  readonly kind: string;
  probe(): Promise<RuntimeCapabilityReport>;
  start(input: StartTurnInput): Promise<{ runtimeInstanceId: string; dispatchAttemptId: string }>;
  respondApproval(input: ApprovalDecision): Promise<void>;
  cancel(turnId: string): Promise<void>;
  dispose(): Promise<void>;
}
```

Main側RuntimeClientとUtility側RuntimeHostを分離する。境界はserializableなversion付きenvelopeだけとし、`hello/capabilities/start/started/event/ack/cancel/canceled/exit/error/heartbeat`を定義する。全messageはprotocolVersion、runtimeInstanceId、threadId、turnId、seq、operationIdを持つ。StreamはMessagePort、controlはcommand/responseとし、ack window、high-water mark、pause/resume、最大buffer、overflow時の停止を定義する。再起動後は旧runtimeInstanceIdのeventを拒否する。

MVPは一つのproduction adapterとdeterministic mock adapterを実装する。二つ目のproduction providerはcontractが安定してから追加する。Provider固有eventはRuntimeHost内部で正規化し、UIへ漏らさない。raw provider payloadの永続化はproduction defaultで無効とし、明示的なdiagnostic sessionだけにsize/retention/secret scan付きで許可する。

ThreadActorはDB、Runtime、Tool、Approvalの完了をmailbox処理中にawaitしない。state transitionからEffectを生成し、`expectedRevision/turnId/effectId/runtimeInstanceId`を持つinternal commandとして結果を再投入する。ThreadActorRegistryはidle actorをpassivateし、DB projectionと未完outboxからlazy rehydrateする。RuntimeHostもTask常駐ではなくlazy poolとし、global/per-provider process budget、idle timeout、memory pressure evictionを持つ。

### 11.2 Tool execution boundary

Team MVPのmanaged accessへ採用するRuntimeは、全副作用をTool Broker経由にでき、Mainが外部観測するOS sandbox probeに合格することを必須条件とする。Broker非対応またはsandbox不能なRuntimeをread-onlyと呼ばず、`trusted-unmanaged`として通常presetと分離する。CapabilityReportの自己申告だけを信用せず、binary digest/version allowlist、direct file open/direct connectのnegative testをPhase 0 gateにする。

Tool Brokerはprovider inference通信によるdata egressを防がない。`provider.egress`をtool network capabilityと分け、providerごとに送信可能fragment分類、data residency/trust、sensitive path/secret scan、最大bytesをpolicy化する。local-only Taskではremote providerを起動拒否し、file内容がcloud providerへ送られることをUIとauditへ明示する。

### 11.3 Tool Registry

Toolの表示名と意味分類を分ける。

- ToolId: provider、namespace、name、versionの安定識別子。
- ToolKind: fileRead、fileWrite、search、shell、network、backgroundTask、agentControlなどのpolicy/risk分類。
- ToolDefinition: input/output schema、side effect、risk、required capability、実行先。
- ToolImplementation: Built-in、CommandRunner、MCP Gatewayの実体。

各Turn開始時にimmutableなToolCatalogSnapshotを生成し、provider-facing nameからToolId、version、schema digestへの対応を固定する。同一ToolKindはpriority、workspace binding、provider compatibilityで解決し、ToolKind単独で実装を一意決定しない。Runtimeからはsnapshot内のnameだけを受理し、dynamic tool変更は次Turnから新revisionを使う。Team MVPはBuilt-inとCommandRunnerに限定し、MCP GatewayはPublic Beta候補とする。

### 11.4 CommandRunner

- shell文字列ではなく executable + argvを正本にする。
- shell syntaxが必要な場合だけ明示的shell modeとして別承認する。
- cwdをWorkspace root配下へcanonicalizeする。
- environmentはallowlist + Task追加分で構築し、secretをlogへ出さない。
- 承認対象をimmutable ExecutionSpec `{absoluteExecutable, argv, cwdIdentity, envDelta(redacted), stdinMode, shell, commandBytesHash}` とし、digest変更時は承認を失効する。
- stdout/stderrにsequenceを付け、backpressureと最大bufferを持つ。
- cancel時は子孫processを含めて終了し、OS別integration testを用意する。
- parserは危険検出と表示補助に限定し、security boundaryにしない。自動allowはshellなし、absolute executable、厳格argv schemaを持つ専用built-inだけとする。shell mode、interpreter code、task runner、Git hook/alias等の実行拡張点はpromptまたはsandbox内denyへ倒す。

### 11.5 Background Activity

background command、monitor、schedulerをBackgroundActivityとして追跡する。Worker自体はAgent + AgentThread + TeamMembershipであり、Worker内のcommand/monitorだけがBackgroundActivityになる。ownerThreadId、ownerTurnId、originWorkerId、branch/policy epoch、wakePolicy、heartbeat、output cursor、volume quotaを持つ。

完了通知はdurable at-least-once + deterministic dedupとする。completionIdをstable context fragment IDに使い、`persisted → attached(targetTurnId) → runtimeAcked`を保存する。同じcompletionIdの再送はContext Builderで一度だけ採用する。rewind、archive、permission revoke、workspace changeで古いepochのcompletionをquarantineする。persistent processはdefault再接続禁止とし、許可型でもrandom lease、OS process handle/job、binary digest、start time、IPC challengeを検証する。

### 11.6 Context Ledgerとcompaction

modelへ渡す各fragmentにorigin trustとinstruction authorityを別々に持たせ、provenance、hash、branch epoch、token estimate、hard cap、retention、compaction policyを付ける。Repository rulesはworkspace-controlled instructionでありsystem/developerへ昇格しない。1 fragmentは10k token未満とし、1k token超をdiagnostic対象にする。Tool/Worker/Web/MCP出力はuntrusted dataとして上限、provider egress policy、保存前redactionを適用する。

Compactionは表示履歴を破壊せず、replacement context projectionとsource watermarkをeventとして保存する。要約は入力fragmentの最低trust/最高riskを継承しauthorityを上げない。Compactorはno-tools、schema-fixedとし、引用した事実と命令候補を分離する。UIは全Timelineと「次Turnへ渡るcontext」を分けて表示できる。

### 11.7 Checkpointとrewind

- Conversation rewind: context/history branchだけを戻す。
- Workspace restore: filesystem/Git checkpointだけを戻す。
- Safe rewind: 両方のcompatible checkpointをpreview後にbest-effort compensating sagaとして複合実行する。

Team MVPはConversation rewindだけを対象とし、Workspace restore/Safe rewindはPublic Beta候補とする。Workspace restoreはManaged Tool Brokerが変更した通常fileだけを保証対象に限定する。manifestはapp-private領域へtyped schema、hash、file identity付きで保存し、path traversal、symlink/hardlink、device/FIFO、submodule、gitdir、normalization未知型を拒否する。

Safe rewind前にworkspace mutation lease、free-space check、restore rehearsal、emergency checkpointを行い、preview digestとcurrent identityをrestore直前に再検証する。競合fileは上書きせず退避し、各stepをjournalへ残す。partial failure時は自動継続せずmanual recovery artifactを提示する。external editorやdisk failureまで含むatomicityは保証しない。per-file/checkpoint/Task/global quotaとcontent-addressed dedupを持ち、保証不能Turnは開始前に表示する。future eventは移動・削除せず、thread_branchesのactive headだけを切り替える。

## 12. Permissionとセキュリティ設計

### 12.1 Capability

- `workspace.read`
- `workspace.write`
- `filesystem.external.read`
- `filesystem.external.write`
- `shell.execute`
- `network.fetch`
- `external.open`
- `secret.use`
- `provider.egress`

Access presetはCapability policyのUI shortcutにすぎず、保存時は個別policyへ展開する。「安全時は自動」は判定理由をeventへ残し、不明な操作は確認へ倒す。

Policy evaluation order:

1. managed administrator deny。
2. project/user deny。
3. parent/Team capability ceiling。
4. Plan/read-only mode ceiling。
5. OS sandbox feasibility。
6. exact remembered grant。
7. narrow allow rule。
8. ApprovalPolicy routing。
9. user/auto reviewer decision。
10. ExecutionSpec digestの実行直前再検証。

denyは常にallowより強く、allowやauto reviewerはsandbox ceilingを変更できない。Shell ruleはparseした全segmentへ同じ評価を適用する。単純prefix allow、parse不能なcommand、subshell/command substitutionは自動許可しない。

Capability ceilingは文字列集合ではなく、`{ capability, resourceSet, operation, expiresAt, providerEgress, sandboxProfile }` のlatticeとして評価する。Workerはspawn時のparent snapshotとpolicyEpochを持ち、ambientなsession grantを継承しない。親の権限取消し・縮小時は子、background activity、未実行outboxを停止して再評価する。最大深度と同時Worker数もceilingに含める。

Auto reviewerは権限境界の代替ではなく、狭いapproval routingである。入力はimmutable ExecutionSpec、policy facts、deterministic risk featuresだけとし、conversation transcriptやtool outputを指示として渡さない。Runtime由来の理由はuntrusted quoteとして分離する。reviewerはno-tools/no-network、一request一decision、`allow once`だけを返せ、high-risk category、schema failure、timeout、model failureはdenyへ倒す。prompt template、model/version、input digest、decisionを監査する。

Full Accessでもadministrator deny、credential/secret保護、audit、Renderer非特権、provider egress policy、app-private data、OS protected resource、署名・update keyへのwrite禁止は解除しない。曖昧なdangerous blocklistではなく、この不変条件をpolicy testで固定する。

### 12.2 Path安全性

- Workspace選択時にrealpathを保存する。Phase 2では選択・保存・表示だけを許可し、列挙・read/writeはPermissionBroker完成後に有効化する。
- 操作直前にも対象parentとsymlink chainを再検証する。可能な操作はPOSIXのdir fd/openat/O_NOFOLLOWまたはWindows handle/final pathのようなhandle基準で行う。
- relative path traversalを拒否する。
- case-insensitive filesystem差異を考慮する。
- rename/deleteは対象identityが承認時から変わっていないか確認する。
- 添付はhashとsizeを取得し、送信前後の差替えを検出する。

### 12.3 Content安全性

- Markdown内HTMLはdefault無効。
- link protocolはhttps、mailto等のallowlistのみ。
- 外部URLを開く前にparse、punycode表示、scheme検査を行う。
- terminal OSC、ANSI control sequenceをsanitizeする。
- promptやtool outputに含まれるcredential patternをsupport logでredactする。

### 12.4 Electron hardening

- `app.enableSandbox()`をwindow生成前に呼ぶ。
- `app.ready`前にcustom schemeをstandard/secureとして登録し、固定resource manifestからだけ解決する。URL pathをfilesystemへ直接joinしない。
- `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`を明示する。
- permission request handlerはdefault deny。
- navigationとwindow open handlerはdefault deny。
- production CSPをcustom protocol response headerで付与する。
- Forge Fusesで不要なNode CLI inspect、run-as-node等を無効化する。
- Electronegativityまたは同等のsecurity lintをrelease gateへ入れる。
- MessagePort/subscriptionはwindow破棄、navigation、Task切替、logout時にMain側で失効し、portごとのstream種別、Task、thread、policyEpoch、最大rate/bytesを固定する。Rendererから来るackやrevisionだけで権限を広げない。

### 12.5 Runtime、worktree、artifact境界

Worktreeは変更競合を分ける仕組みでありsecurity sandboxではない。write-capable Workerは専用worktreeに加えて、そのrootだけをwrite可能にしたOS sandboxを必須とする。Git実行時はrepository hook、global/system config、credential helper、pager、external diff/merge、protocol extensionを無効化したsanitized environmentを使う。submodule、LFS pointer、symlink/hardlink、special file、gitdir、workspace外pathをartifact acceptanceで検査し、Workerが親workspaceを直接変更せずBrokerがreview済みpatchだけを適用する。

Managed Runtimeは実行前probeでOS sandboxとdirect filesystem/process/network denialを実証できるものだけを指す。単なる`read-only` promptやtool非公開はsecurity boundaryに数えない。外部CLIはbinary digest/version allowlist、起動引数、environment、IPC challengeを固定し、満たさないadapterは`trusted-unmanaged`と表示して機密Taskでは拒否する。

## 13. UI system

### 13.1 Dark theme token

```text
bg.canvas       #12110F
bg.surface      #1B1A17
bg.elevated     #24221E
border.subtle   rgba(255,244,224,.09)
text.primary    #F4EFE6
text.secondary  #AAA49A
accent.primary  #E39A62
accent.cool     #78A9C2
state.success   #79B58A
state.warning   #D5A85B
state.danger    #D9786B
```

純黒・純白を避け、暖かいneutralを使う。accentは重要actionと通信pulseへ限定し、大面積に塗らない。spacingは4px base、主要section 24–32px、message間20pxを基準に余白を確保する。

### 13.2 Typography

- UI: system sans、13–15px。
- conversation: 15–16px、line-height 1.65。
- code/terminal: system monospace、12.5–13px、line-height 1.55。
- hierarchyはweightだけでなくsize、spacing、colorで作る。

### 13.3 Motion token

- instant: 90ms
- quick: 160ms
- standard: 240ms
- spatial: 420ms
- cinematic: 最大560ms
- easing UI: cubic-bezier(.2,.8,.2,1)
- easing spatial: cubic-bezier(.22,1,.36,1)

連続ループanimationは実行中indicator以外で使わない。blurはspawn/transition時だけ使い、低性能端末では無効化できるfeature flagを持つ。

## 14. エラー・復旧・観測性

### 14.1 エラー分類

- UserCorrectable: path未選択、権限拒否、入力不足。
- Retryable: provider timeout、temporary network、DB busy。
- RuntimeFatal: adapter crash、protocol mismatch。
- AppFatal: migration failure、DB corruption、Main initialization failure。

UIは分類に応じて「修正」「再試行」「Runtime再起動」「安全モード起動」を提示する。失敗時にraw errorだけを表示しない。

### 14.2 Crash recovery

- 起動時にactive Turnを `interrupted` へ遷移する。
- DB integrity checkとmigration checkを行う。
- canvas draftはdebounce保存し、最後の確定revisionを復元する。
- Runtime processはTask単位でreconnectせず新規起動する。
- support bundleは明示操作で作り、secret scan結果を表示してから保存する。

### 14.3 Logging

すべてのlogにtimestamp、level、process、taskId、threadId、turnId、agentId、correlationIdを可能な範囲で付与する。message本文、prompt全文、credential、絶対pathはdefault logへ含めない。開発時だけopt-in詳細logを提供する。

## 15. テスト戦略

### 15.1 Unit

- Turn/Team/Approval state machine全transition。
- event reducer、sequence gap、idempotency。
- capability policyとpreset展開。
- path canonicalizationとsymlink edge case。
- Runtime event normalizer。
- Canvas camera target計算とmotion reduction。

### 15.2 Contract

- すべてのIPC request/response schema。
- Preload公開API snapshot。
- Runtime Host fixture stream。
- DB migration checksumとforward migration。

### 15.3 Component

- ChatSurfaceをnormal/canvas両containerで同じtest suiteに通す。
- Composer keyboard、送信、stop、attachment。
- Turn Card stage、command output、approval。
- Team cable accessibility fallback。

### 15.4 Integration

- Main IPC handler + temporary SQLite。
- Utility process crash、cancel、backpressure。
- Command process tree終了をmacOS/Windows/Linuxで検証。
- safeStorage unavailable時のfallback禁止と再試行UI。

### 15.5 E2E golden paths

1. 新規Task → message → streaming answer → restart →復元。
2. command approval → live output → completed。
3. command拒否 → Runtime代替回答。
4. Chat → Team昇格 → Worker spawn → Camera focus。
5. Leader → Worker通信 → cable → delivery → response。
6. 実行中強制終了 → 再起動 → interrupted表示。
7. reduced motionとkeyboard-only操作。

### 15.6 Visual / performance

- fixed viewportでChat、Run、Approval、Canvasのscreenshot regression。
- 10 Worker × 200 message fixtureでframe budget計測。
- 10MB command outputでmemoryとscroll応答を計測。

## 16. 配布と運用

- macOS arm64/x64、Windows x64を初期正式対象とする。
- Linuxはdevelopment supportから開始し、auto-updateはdistribution方式に委ねる。
- code signing、macOS notarization、Windows signingをrelease必須とする。
- Forge makerとGitHub Actionsのmatrix buildを使い、artifactを各OSで生成する。
- autoUpdaterはmacOS/Windowsのみ。二重checkを防ぐsingle-flight guardを入れる。
- release channelはstable/betaを分離し、DB migration compatibilityを検査する。
- update適用前にactive Turnがないか確認し、download後のrestartをユーザーが選べるようにする。

## 17. ADR

### ADR-001: Electronを採用する

- Status: Accepted
- Context: ローカルfilesystem、Shell、複数process、成熟したWeb UIを一つのdesktop appで扱う必要がある。
- Decision: ElectronのMain/Preload/Renderer分離を採用する。
- Alternatives: Tauri、Native Swift/WinUI、Web app。
- Consequences: binary sizeとmemoryは増えるが、UI開発速度とcross-platform process integrationを優先する。security hardeningを品質gateにする。

### ADR-002: ChatSurfaceの状態と視覚体系を通常ChatとCanvas nodeで共有する

- Status: Proposed（Phase 0で方式確定）
- Context: Team化で会話の同一性を失うと、学習コストと文脈断絶が生じる。
- Decision: domain identity、draft、scroll、focus、stream、見た目の連続性を必須にする。第一候補はapp rootの安定したSurfaceLayerに単一surfaceを常駐させ、normal/Canvasはanchorだけを持つ方式。
- Alternatives: 外部化したstateのhandoff + shared-element clone、transition overlay後のcontrolled remount。Leader専用cardや別route navigationは不採用。
- Consequences: DOM identityは必須のユーザー価値ではない。Phase 0でmount count、IME、selection、scroll、streamを検証し、最も単純に連続性を満たす方式を採用する。

### ADR-003: append-only Turn event + projectionを採用する

- Status: Accepted
- Context: streaming、tool、approval、cancel、crash recoveryを追跡する必要がある。
- Decision: Turn eventを順序付きで保存し、summary/projectionをtransaction内で更新する。
- Alternatives: message本文へ逐次追記、in-memory state + 最終結果保存。
- Consequences: migrationとevent versioningが必要だが、復元・監査・再描画が安定する。

### ADR-004: Rendererに権限を与えない

- Status: Accepted
- Context: AI生成Markdownとtool outputはuntrusted contentとして扱う必要がある。
- Decision: sandboxed Renderer、narrow preload、Main PermissionBrokerを強制する。
- Alternatives: Node integration有効、汎用IPC bridge。
- Consequences: IPC contractは増えるが、侵害時のblast radiusを小さくできる。

### ADR-005: MVPのWorker間直接通信を禁止する

- Status: Accepted
- Context: 自由なmesh通信は因果関係、権限、予算制御を難しくする。
- Decision: messageはLeader経由に限定する。
- Alternatives: full mesh、shared broadcast bus。
- Consequences: 一部のTeam効率は下がるが、観測可能性と操作理解を優先する。需要計測後に再検討する。

### ADR-006: Task / AgentThread / Turn / Itemをcanonical domainにする

- Status: Proposed（reference review後に確定）
- Context: Chat、streaming、tool、approval、TeamをRun一つで表すとlifecycleとIDが曖昧になる。
- Decision: Taskをproduct container、AgentThreadを会話session、Turnを1回の実行、Itemをmessage/tool/approval単位とする。RunはUI labelに限定する。
- Alternatives: Task/Runの2階層、provider固有session/eventを直接使う。
- Consequences: DB/APIの語彙変更が必要だが、複数Runtimeを同じUIへ正規化できる。

### ADR-007: AgentThreadをactorで直列化する

- Status: Proposed
- Context: queue、steer、interrupt、approval response、settings updateが同時到着する。
- Decision: 1 AgentThread = 1 mailbox + 1 mutable state ownerとする。
- Alternatives: service間shared mutable state、DB lockだけで順序制御。
- Consequences: actor再起動とmailbox backpressureが必要だが、raceの責務が局所化する。

### ADR-008: Managed Runtimeは副作用をTool Brokerへ委譲する

- Status: Proposed
- Context: provider内蔵toolが直接実行されると、表示したapprovalと実際の権限境界が一致しない。
- Decision: Managed modeではRuntimeはstructured tool requestだけを返し、Tool Brokerがpolicy、approval、executionを所有する。
- Alternatives: provider native tools、unmanaged CLI integration。
- Consequences: provider compatibilityが狭まる。非対応providerはread-onlyまたは明示的unmanagedとして隔離する。

### ADR-009: Conversation rewindとWorkspace restoreを分離する

- Status: Proposed
- Context: 会話だけ戻す操作とfilesystemを戻す操作では回復可能範囲と危険性が異なる。
- Decision: 別command・別approvalとし、Safe rewindだけがpreview付きsagaとして両方を組み合わせる。
- Alternatives: 一つのUndo、conversation rollbackのみ。
- Consequences: UI操作は増えるが、外部副作用まで戻ったという誤認を防げる。

### ADR-010: Team Canvasを自前DOM worldで実装する（React Flow不採用）

- Status: Accepted（全文: `tasks/designs/adr-team-canvas-custom-dom-world-20260724.md`）
- Context: §18 spike 3はReact Flow custom node内での720px ChatSurface・nested scroll・keyboard・10 nodeの性能を検証対象とし、不足時のfallbackを「custom DOM world + spatial index」と定義していた。Phase 6着手時点で、視覚正本`demo/index.html`のカメラ演出（morph時のシード→セトル、背景格子の追従、world座標に同期するケーブル）はrefを直接変異する自前カメラで既に忠実に再現できていた。
- Decision: React Flowを導入せず、fallback構成を正式実装として採用する。カメラは`useCamera`（ref + 直接style変異でReact再レンダリングなし）、nodeはworld座標のabsolute配置、ケーブルはworld内SVG、LODはカメラscale閾値の`data-lod`属性、位置と視点は`canvas_views`（migration v29、revision付き楽観ロック）へ永続化する。
- Alternatives: `@xyflow/react`のviewportモデルへ載せ替える、canvas/WebGL描画。
- Consequences: selection・keyboard navigation・fit/focus・drag・位置永続化はReact Flow相当を自前で維持する。node数の設計上限が小さい（Leader 1 + Worker 3、将来10）ためspatial indexは未実装で、上限を引き上げる際の必須検討事項として残る。性能はNFR-PERF-03の実測でゲートする。`canvas_views`のデータモデルとCameraDirectorのownership modelは、将来React Flow導入を再検討する場合にそのまま移植できる境界として設計してある。

## 18. 未決事項とPhase 0 Spike

実装開始前に以下を実測し、ADRを更新する。

1. Forge Vite pluginでMain/Preload/Renderer、native SQLite、package、signingの最小buildが全対象OSで通るか。
2. better-sqlite3の対象Electron ABI prebuild有無とrebuild時間。
3. ~~React Flow custom node内で720px ChatSurface、nested scroll、keyboard、10 nodeの性能が要件を満たすか。~~ 解決済み（ADR-010）: React Flowは検証に進まず不採用となり、fallbackの自前DOM worldを正式実装として採用した。
4. 同一ChatSurface instanceを通常layoutからCanvasへ移すportal/FLIP方式でfocusとselectionが維持されるか。
5. UtilityProcessとruntime CLIのstream/cancel/exit behaviorが各OSで一致するか。
6. providerがBroker方式のtool executionを許すか。許さない場合のCapabilityReportと警告表現。
7. Playwright Electron experimental APIをrelease E2E gateに使える安定性があるか。
8. DB Main直置きとDB Utility Processを比較し、event append中のIPC latency p95/p99を測る。
9. production runtimeがTool Brokerを迂回できないこと、またはmanaged modeで起動拒否されること。Managed候補はMainが外部観測するOS sandbox probeでworkspace外filesystem、direct process spawn、無許可の直接outbound networkを拒否し、許可されたprovider通信だけが`provider.egress` policyと監査を通ることを実証する。
10. ThreadActor mailboxでqueue/steer/interrupt/approvalの順序とbackpressureが成立すること。
11. prompt commit barrier前にRuntime requestが発生しないこと。
12. Conversation rewindのbranch head切替が成立すること。Workspace restore/Safe rewindはPublic Beta向けに保証範囲と失敗回復だけをprobeする。

Spike failure時の代替:

- Forge Vite不成立 → Forge Webpack pluginへ変更。
- native SQLite不成立 → Node built-in SQLiteの採用可能性を対象Electronで再評価。
- React Flow性能不足 → custom DOM world + spatial indexへ変更。**この代替を採用済み**（ADR-010）。spatial indexはnode数上限を引き上げる際の検討事項として残る。
- UtilityProcess互換不足 → child process adapterへ限定しsandbox境界を補強。

## 18.1 残余リスク

UtilityProcessとchild processは同一OS user権限を持ち、単独ではsecurity sandboxにならない。対象OSで実効的sandboxを提供できないRuntimeは、ユーザーが導入元を信頼する必要がある。この前提は初回有効化時に表示し、secretは原則Broker側でheader/signatureへ変換してRuntimeへ生値を渡さない。

## 19. Definition of Ready / Done

### Ready

- 対象FRとacceptance criteriaがIssueへ紐付く。
- IPCとDB migration影響が明記される。
- security capabilityとapproval条件が明記される。
- UI状態、loading、empty、error、recoveryが設計される。
- test fixtureと計測方法が決まる。
- 対象FR/NFRが実装Slice、acceptance、test、release cutへ追跡できる。

### Done

- TypeScript strict、lint、unit、contract、integrationが成功。
- 対象golden path E2Eが各対象OSで成功。
- accessibility keyboard/contrast/reduced motionを確認。
- performance budgetを超過していない。
- migration upgradeとbackup recoveryを検証。
- security checklistとElectron hardening auditを完了。
- user-facing documentationとrelease noteを更新。

## 20. 公式資料

- Electron Process Model: https://www.electronjs.org/docs/latest/tutorial/process-model
- Electron IPC: https://www.electronjs.org/docs/latest/tutorial/ipc
- Electron Context Isolation: https://www.electronjs.org/docs/latest/tutorial/context-isolation
- Electron Sandboxing: https://www.electronjs.org/docs/latest/tutorial/sandbox
- Electron Security Checklist: https://www.electronjs.org/docs/latest/tutorial/security
- Electron safeStorage: https://www.electronjs.org/docs/latest/api/safe-storage/
- Electron MessageChannelMain: https://www.electronjs.org/docs/latest/api/message-channel-main/
- Electron Updates: https://www.electronjs.org/docs/latest/tutorial/updates
- Electron Support Timeline: https://www.electronjs.org/docs/latest/tutorial/electron-timelines
- Electron Forge Vite Plugin: https://www.electronforge.io/config/plugins/vite
- Electron Forge Plugins: https://www.electronforge.io/config/plugins
- better-sqlite3: https://github.com/WiseLibs/better-sqlite3
- Playwright Electron: https://playwright.dev/docs/api/class-electron
- OpenAI Codex source: https://github.com/openai/codex/tree/fd3c1dc13d0a0941af406e1bc1f697c9d14110ea
- xAI Grok Build source: https://github.com/xai-org/grok-build/tree/a881e6703f46b01d8c7d4a5437683546df30449d

## 21. Coding agent参照設計の適用範囲

詳細な調査根拠、採用・非採用判断、Canonical Agent Protocol、Turn algorithm、Team/Worker contractは`docs/REFERENCE_AGENT_ARCHITECTURE.md`を正本とする。

Codex CLIからはThread/Turn/Item、command/event protocol、resource/method API、structured approval、sandboxとreviewerの分離、context hard cap、rollout/projectionを採用する。

Grok BuildからはSessionActor、server-authoritative prompt queue、persist-before-inference、tool registry、background wakeup、checkpoint/rewind、worktreeによる変更分離、ACP/headless共通coreの考え方を採用する。

一方、default sandbox off、単純prefix allow、parent capabilityを越えるsubagent、provider内蔵toolのBroker迂回は採用しない。両repositoryはApache-2.0だが、Sprint Coderではsource copyではなくarchitecture patternだけを独自実装する。
