# Team v2 Core Slices

## Slice 0 — Baseline and decisions

### Outcome

実装前baseline、Root Cause Confirmed Gate、Core schema、execution model、connection identityを
確定する。

### Required

- Team unit 2失敗とE2E 3 timeoutの原因箇所・経路・独立証拠
- current Team data flowとstate transition matrix
- connection ID先行導入ADR
- Coreのfeature boundariesとrollback
- 既存CLI packaged resolution確認

### Non-goals

製品機能追加、外部API、Secret Storage。

### Proof

再現command、原因証拠、修正後に使う同一acceptance command、Accepted ADR。

## Core A — Domain and persistence

- parent/depth/canDelegate、Team Policy
- ModelSelection、connection identity
- execution、attempt、instruction revision、queue
- direct message audit
- Team activity event
- restart projectionとmigration fixture

Proof: pure domain state-machine testとpersistence integration。

## Core B — Coordinator and Runtime

- dynamic hire、Manager delegation
- global execution Scheduler 8
- async assign returning execution ID
- queued steer、interrupt-and-resume running steer
- Worker message routing
- stop queued/running、budget、recovery

Proof: deterministic Runtimeで8 parallel、depth、steer、crash／restart。

進捗:

- B1a完了: 旧3 Worker hard cap撤廃、5 Worker雇用回帰、明示的かつcaller-boundな
  `requesterAgentId`を受けるCoordinator境界、Manager Policyに基づく子Agent登録。
- B1b完了: 可変人数Canvas／List表示、先頭3配置互換、4人目以降の決定的配置、
  10 Worker pure geometry test、5 Worker packaged E2E。UI実装は規定どおり
  `UI_DELEGATION_MODEL`を使うClaude CLIへ委託し、メインAgentが差分とtestを再検証した。
- B2a完了: global最大8、Team Policy別上限、FIFO、失敗時枠解放を担うCore admission
  schedulerとdeferred job unit test。
- B2b完了: 永続execution/message/task/deliveryをSchedulerへ接続し、formal
  `team_assign_task`が完了を待たずexecution IDを返す。global 8 running／2 queued、
  attempt、message link、失敗時枠解放をElectron ABIで検証。旧IPC `sendToWorker`は
  後方互換の同期経路として維持する。
- B3a完了: queued instruction revision、queued cancel、Schedulerからの取消、task/delivery終端化、
  Claude/Codex MCP tool公開。revised instructionがruntime開始時に解決されることをElectron ABIで検証。
- B3b完了: running runtime停止、attempt 1 interrupted、同一execution IDのinstruction revisionと
  attempt 2再開、running cancel終端化。active slot終了後だけrequeueするScheduler境界を検証。
- B3c完了: app restartでattempt 1を`interrupted/app_restart`、同一execution IDをqueueへ復元し、
  attempt 2としてScheduler実行を再開。非終端executionを持たない従来Teamのpaused/stopped
  recoveryは維持する。
- B4完了: `canDelegate`を持つ実Claude／Codex Manager RuntimeだけへTeam MCPを渡し、
  token registrationへAgent IDを固定する。Managerは直下Agentのhire／assignと、自分が
  作成したexecutionのsteer／cancelだけを実行できる。model-controlled引数によるidentity
  偽装、legacy direct send／arbitrary stopはfail closedとし、Runtime終了時にtokenを破棄する。

## Core C — User experience and GA

- Agent／Activity Card
- persistent Chat Team event
- hierarchical CanvasとList View
- Team Policy settings
- queue stateとelapsed
- Claude CLI／Codex CLI packaged execution

Proof: component、keyboard、accessibility、Playwright、packaged Computer Use evidence。

進捗:

- C1a完了: 永続executionから、state、queue reason／ordinal、Connection／requested model、
  instruction preview、各timestampを500文字上限の表示専用summaryへ射影し、
  Main→Preload→Rendererの`TeamDetail`契約で配信する。DB変更とUI推測は行わない。
- C1b完了: C1aの共通契約だけを使う再利用可能なActivity componentをCanvas／Listへ接続。
  全8 execution state、全6 queue reason、待機開始、待機順、Connection、instruction previewを
  色だけに依存せず表示する。Claude UI委託は1往復、7ファイル、586差分行で完了し、
  component 34件、renderer lib 197件、typecheck、lint、production package、packaged Team flow
  3件がgreen。
- C2a完了: DB v40の監査イベントを重複保存せず、actor／subject role、execution status、
  queue reason、attempt ordinal、terminal reasonを持つ表示専用summaryへ正規化する。
  TeamDetailは新しい順の最新200件を時系列順で配信し、500件超でも新しい履歴が消えない
  `listLatestTeamV2Activity`を永続化境界へ追加した。
- C2b完了: C2a summaryをChat message間へ`recordedAt`順で差し込み、雇用、委譲、queue、
  execution／attempt lifecycle、steer、報告、停止の全11 typeを日本語履歴カードとして表示する。
  Claude UI委託は1往復、5ファイル、581差分行で完了。component 18件、renderer 276件、
  typecheck、lint、production package、packaged Team flow 3件がgreen。
- C2d完了: C2c初回E2Eで検出したmock-only legacy dispatchを修正し、deterministic Leaderも
  `team_assign_task`でexecution IDを受け取り、必要な回数だけ`team_wait_reports`を行う。
  sampler unit 5件とElectron統合scenarioがgreenで、mockと実CLIの監査経路を一致させた。
- C2c完了: Activity Cardへ永続監査IDを公開し、production packageで雇用3件・委譲3件の
  日本語履歴を確認。同一user-data DBの再起動前後で全activity ID集合が完全一致し、
  重複表示0件のpackaged E2Eがgreen。
- C3a完了: Listのengine／objective文字列とmessage Markdown rendererをCanvasと統一。
  Claude UI委託2往復、1ファイル、30追加／2削除で、typecheck、lint、format、
  packaged Canvas／List parity E2Eがgreen。
- C3b完了: localhost script serverを廃止し、production CSPを変更せずPlaywright protocolから
  local axe dependencyを注入する。axeが検出したTeam execution keyの3.79:1コントラストは、
  既存`--text-secondary` tokenをopacityなしで使いWCAG AAへ修正した。Claude UI委託は
  `claude-opus-5`で1ファイル・8差分行を生成し、報告生成前に委託予算へ到達したため、
  メインAgentが差分レビューと全検証を実施した。format、lint、typecheck、production package、
  packaged axe 4件がgreen。
- C4a完了: 既存Team Policy domain／SQLite transactionを再利用し、`taskId`、完全なpolicy、
  `expectedRevision`を受ける厳格な更新contractをMain／Preloadへ追加。CoordinatorのTask別直列化内で
  更新し、canonical TeamDetailを返して購読者へ通知する。contracts 27件、IPC 403件、
  Coordinator Electron ABI 12件、typecheck、lintがgreen。DB migrationは不要。
- C4b完了: Canvas／Listの両headerから同じnative dialogを開き、最大depth 1–4、同時実行1–8、
  Worker間通信、budget modeを完全なpolicyとしてC4a contractへ保存する。成功時だけcanonical
  TeamDetailへ置換し、stale revision／既存階層違反はdialogを閉じず`role=alert`で再読込導線を
  示す。Claude Opus 5へ規定どおり委託し、3往復上限で共有dialog、store、List接続まで作成。
  メインAgentが未完のCanvas／CSS接続と、Canvas pan／Escapeがtop-layer dialog入力を奪う問題を
  補完・修正した。総差分は1000行未満。renderer 276件、typecheck、lint、production package、
  Canvas／List、keyboard／focus、成功／競合、axeを含むfocused packaged E2Eがgreen。
- C5a完了: production packageの`RunAsNode=false` fuseと、Electron executableをNodeとして
  Team MCP serverへ使う旧実装の不整合を解消した。fuseは無効のまま維持し、Claude／Codexの
  一時stdio serverだけをPATH上の`node`／`node.exe`で起動する。packaged実Claude Leaderが
  Teamを自動展開し、数学／実装の2件の実Worker reportを受信・統合するE2Eが40.9秒でgreen。
  1–8人の人数表現、「N人体制」、全execution IDの終端report待ちを回帰条件へ追加した。
- C5b完了: Codex app-serverのTeam MCP許可surfaceを正本の12ツールへ同期した。さらに
  app-server notificationへ単調なstage遷移とTurn内で安定したassistant message IDを適用し、
  tool前後の複数messageを既存Turn persistenceへ安全に保存する。packaged実Codex Leaderが
  数学担当／実装担当の2 Workerを雇用し、2件の実reportを統合するE2Eが1.4分でgreen。
- 次着手: 3OS CIとWindows／Linux packaged evidenceをrelease環境で取得する。
