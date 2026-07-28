# Team v2・Multi-Provider 改訂計画

- 計画版: v2
- 状態: planning
- 現在地: Team Slice 0、Core A、Core B1a/B1b/B2a/B2b/B3a/B3b/B3c/B4、
  Core C1a/C1b/C2a/C2b/C2c/C2d/C3a/C3b/C4a/C4b/C5a、Provider P0、
  P1A-a/P1A-b、P1B-a/P1B-b1/P1B-b2/P1B-b3/P1B-c1/P1B-c2a/P1B-c2b、
  UI U0/U1a/U1b/U1c/U2a/U3a、Provider P2a/P2b/P2c1/P2c2/P2c3、P3、P4、P5、P6、
  Compatibility C1a/C1b1/C1b2完了
- 正本: このディレクトリと配下のADR

## 要約

Team v2 Coreと外部API Provider対応を分離する。Coreは既存Claude CLI／Codex CLIだけで、
動的雇用、階層委譲、実8並列、Worker間通信、実行中の指示修正、attempt、監査、再起動復元、
Team Activity Card、階層Canvas、Team Policyを完成させる。

Multi-Provider Initial ReleaseはOpenAI、OpenRouter、Anthropic、Gemini、xAIと既存CLIを対象に
する。その他のProviderはOpenAI-compatible Profileを使うCompatibility Packとして後続化し、
Team v2 Core GAとMulti-Provider Initial GAをblockしない。

## 文書の優先順位

矛盾がある場合は次の順で扱う。

1. 対象となる指示またはADRを明示的にsupersedeする最新ADR
2. [最新の指示文](instructions/02-final-revision-v2.md)
3. [過去の指示文](instructions/)
4. 旧製品設計・旧実装計画

ADRが指示文をsupersedeするときは、対象節、理由、検証証拠をADRへ明記する。指示文を更新する
PRでは、影響を受けるADRと計画文書も同時に更新する。

## Milestone

| Milestone                    | 完成内容                                                          | 後続をblockする条件              |
| ---------------------------- | ----------------------------------------------------------------- | -------------------------------- |
| A: Team v2 Core GA           | 既存CLIでTeam v2本体を完成                                        | 外部API Provider数は条件にしない |
| B: Multi-Provider Initial GA | OpenAI、OpenRouter、Anthropic、Gemini、xAI、Claude CLI、Codex CLI | Compatibility Packは条件にしない |
| C1: Compatibility Pack A GA  | Mistral、DeepSeek、GroqCloud                                      | Initial GAをblockしない          |
| C2: Compatibility Pack B GA  | Moonshot、MiniMax、Zhipu、NVIDIA NIM、Cloudflare Workers AI       | Initial GAとPack Aをblockしない  |

詳細は[scope and milestones](00-scope-and-milestones.md)を参照する。

## Sliceと依存関係

```text
Team Slice 0
  → Team Core A → Core B → Core C
  → Provider P0 → P1A → P1B
  → UI U0 → U1
  → P2 OpenAI → P3 OpenRouter → P4 Anthropic → P5 Gemini → P6 xAI
  → UI U2 → U3
  → Multi-Provider Initial GA
  → C1 → C2
  → UI U4
```

connection ID列の先行導入判断だけはTeam Slice 0で確定し、Provider P0で実績とbackfill量を
再検証する。これはCore実装後に判断しても手遅れになる依存関係を解消するためである。

- [Team v2 Core slices](slices/00-team-v2-core.md)
- [Provider P0–P6](slices/10-provider-p0-p6.md)
- [UI U0–U4](slices/20-ui-u0-u4.md)
- [Compatibility C1–C2](slices/30-compatibility-c1-c2.md)
- [Provider rollout](04-provider-rollout.md)

各Sliceは独立PRとし、合格証拠を報告して停止する。複数Sliceを巨大PRへまとめない。

## 設計文書

- [現状調査](01-current-state.md)
- [Team v2 Core](02-team-v2-core.md)
- [Provider architecture](03-provider-architecture.md)
- [Provider rollout](04-provider-rollout.md)
- [Model Picker migration](05-model-picker-migration.md)
- [Capability Catalog](06-capability-catalog.md)
- [Rate-limit Scheduler](07-rate-limit-scheduler.md)
- [Data migration](08-data-migration.md)
- [Security and secrets](09-security-and-secrets.md)
- [Testing and CI](10-testing-and-ci.md)
- [Risks and rollback](11-risks-and-rollback.md)
- [Acceptance gates](12-acceptance-gates.md)
- [ADR index](adrs/README.md)
- [UI Agent delegation process](../../process/ui-agent-delegation.md)

## 現在地とblocker

- 現行DB migrationはv48。`provider_connections`をconnection domainの正本として追加し、
  安定IDの`builtin:claude-cli`と`builtin:codex-cli`をseedした。新規Claude／Codex Turn・Agentはbuilt-in connection IDと
  requested model identityを保存し、Runtimeが返したresolved modelを別フィールドへ保存する。
  Taskの明示selectionはcanonical repositoryへ保存され、未設定Taskは旧global Picker設定を読む。
- Teamの旧Worker上限3は撤廃済み。Coordinatorは永続化されたAgent ID、Manager Policy、
  parent/depthに基づく深度4までの再委譲境界を持つ。Canvas／Listは可変人数を表示し、
  5 Workerのpackaged E2Eがgreen。Manager RuntimeにはAgent IDをtoken registrationへ固定した
  Team MCPを渡し、直下Agentのhire／assignと自分が作成したexecutionのsteer／cancelだけを許可する。
- `spawnSlots: 8`とは別に、AI executionをglobal最大8件で動かすSchedulerを実装済み。
- Provider Connectionの最小domainとbuilt-in永続化はP1A-a、pre-v35 built-in identity backfillと
  history dual-readはP1A-bで実装済み。独立fixture群はP1A-cへ留保した。外部API Adapter、
  Secret Storage、API rate-limit Scheduler、feature flag基盤はP1B〜P6で実装済み。
- `01-multi-provider-addendum.md`の原文は未提供である。原文を創作せず、提供されるまで
  [blocker placeholder](instructions/01-multi-provider-addendum.md)として扱う。
- Slice 0のRoot Cause Confirmed Gateは完了した。Team unitは26 passed／1 skipped、
  packaged Team E2Eは3 passedで、productionのNode inspector fuseが無効のまま一時test bundle
  だけをPlaywrightで検査する。
- Core C1aで表示専用のTeam execution summaryをMain→Preload→Renderer契約へ追加し、
  C1bで同じTeam Activity componentをCanvas／Listへ接続した。queued／waitingでは理由、
  待機開始、Connection、待機順を明示し、running／terminalでも状態、Connection、指示を表示する。
- Core C3aでCanvas／Listのengine接頭辞と安全なMarkdown message描画を統一し、
  packaged parity E2Eをgreen化した。C3bではproduction CSPを緩めずにPlaywright protocolから
  axeを注入し、検出されたTeam execution labelのコントラストをWCAG AAへ修正した。
  packaged axeはChat、Settings、Approval、3 Worker Teamの4件がgreen。
- Core C4aで既存Team Policy永続化をRendererから安全に更新するoptimistic revision付きの
  Main／Preload IPC契約を追加した。更新後はcanonical TeamDetailを返し購読者へ通知する。
- Core C4bでCanvas／List共通のTeam Policy dialogを追加した。4項目を編集でき、成功時は
  canonical detailへ置換し、revision conflict時はdialogを維持して警告する。packaged E2Eは
  両view、keyboard／focus、競合、axeを含めgreen。
- Core C5aでpackaged Electronの`RunAsNode=false`とTeam MCP server起動方式の不整合を修正した。
  production fuseを緩めず、既存CLIと同じPATH上のNodeで一時stdio serverを起動する。実Claude
  LeaderがTeamを自動展開し、数学／実装の2件の実Worker報告を受信・統合するpackaged E2Eが
  40.9秒でgreen。Team intentは1–8人と「N人体制」を認識し、全executionの終端report待ちも
  組み込みSkillとE2Eへ明記した。
- Provider P0でCore後の実装を再調査し、Provider domain、二段階admission、Capability Catalog／
  Picker、Profile／verification／secrets、legacy migrationをADR-003〜007としてAcceptedにした。
  v35 identity列は新規dataへ有効だがpre-v35 rowのbackfillは未実装、Worker実行時のAgent別
  selection利用も未接続であるため、P1Aの必須残件として明記した。
- Provider P1A-aで共通`ProviderConnection`契約、DB v41、built-in CLI 2件のseed、
  list/get persistence APIを追加した。実Provider API、Secret、Scheduler、legacy backfillを
  含めず、P1A-b/cへ分離した。
- Provider P1A-bでDB v42を追加し、legacy Turnの`runtime_kind/model`、Agent thread、Taskの
  最新Turnまたは旧runtime別設定からbuilt-in requested identityをbackfillした。resolved modelは
  推測せず、Turn／Agentの読み込みはlegacy列へfallbackする。
- Provider P1B-aでProvider-neutralなRuntime／Registry契約、canonical event、
  normalized error／usage、Capability Catalog schema、決定的Mock Runtimeを追加した。
  認証、Secret、外部通信、Scheduler、UIは後続へ分離している。
- Provider P1B-b1でMain／Preload／Runtime Host本番コードの`console.*`をlint errorにし、
  structured header、body、URL query、Errorをsink到達前に強制redactする共通loggerへ置換した。
- Provider P1B-b2でElectron `safeStorage` cipher adapterとMain-only encrypted blob storeを追加し、
  DB v43にはopaqueなsecret referenceだけを保存する。Renderer IPCと平文secret永続化は追加していない。
- Provider P1B-b3でDB v44へverification stateを追加した。外部Connectionは24時間TTLと
  3秒preflightを通るまで新規実行を開始せず、timeoutはinvalid credentialsへ分類しない。
  built-in CLIは`not_required`で既存実行をblockしない。
- Provider P1B-c1でDB v45へConnection rate-limit設定を追加し、concurrency／RPM／TPM、
  Connection間round-robin、Connection内Team round-robin、待機agingを扱うadmission controllerを
  実装した。built-in CLIは`bypass`である。Team Scheduler統合と429再投入はc2で行う。
- Provider P1B-c2aで既存global 8枠SchedulerへConnection admissionを追加した。飽和Connectionの
  jobはactive枠を消費せず`waiting_rate_limit`へ永続化され、他Connectionとbuilt-in CLIは進行する。
  429のsame-attempt retryはc2bへ分離した。
- Provider P1B-c2bで429を専用errorとして扱い、同じexecution／attempt IDの
  `providerCallOrdinal`だけを増やす最大3 retryを実装した。Retry-Afterを優先し、その後は
  jitter付き指数backoffを使う。backoff待機はSchedulerの`notBefore`でactive枠を消費せず、
  上限到達時のterminal reasonは`rate_limited`になる。
- UI U1aでMain-owned catalog query、revision単位index、opaque cursor paging、
  Task canonical selection set、`multiProviderModelPickerV2` flagをIPC契約へ追加した。
  旧runtime get/setもtask-aware入力を受けられるため、両Pickerは同じselectionへ接続される。
- UI U1bでflag ON時だけ使う共通Pickerを追加した。Rendererはcatalog query interfaceだけを読み、
  Main側検索／cursor paging、常時virtualization、keyboard、ARIA、focus復元、不明値表示に対応した。
  flag OFFまたはAPI不在時は旧Pickerを維持する。全体E2Eは全実装後のfinal gateへ留保する。
- UI U1cでSettingsへProvider Connection管理を統合した。built-in CLIと外部APIを明確に区別し、
  OpenAI／OpenRouter／Anthropic／Gemini／xAIの追加、接続状態、再確認、Main-only Secret Storageの
  境界を表示する。Rendererはsecret referenceやbackendの生messageを表示せず、同時verificationを
  UIで防ぐ。component test 24件、対象lint、diff checkはgreenで、全体E2Eはfinal gateへ留保する。
- UI U2aで旧Runtime／Model PickerとV2 Pickerの非同期parityを修正した。Task切替後の遅延応答、
  同一Taskへ戻ったときの古い応答、失敗したselection writeのrollback、canonical selection変更後の
  stale表示名をTask IDと単調tokenで防ぐ。純粋unit 15件と対象lintはgreen。Chat／Team／restart／
  packagedのparity E2Eは全実装後のfinal gateへ留保する。
- UI U3aでV2 Pickerを既定ONにした。`SPRINT_CODER_MULTI_PROVIDER_MODEL_PICKER_V2=0`を
  明示した場合だけ旧Pickerへ戻るため、U4まで即時rollback経路を維持する。flag unit 3件と
  対象lintはgreen。U3の完成判定はfinal gateの3OS／packaged／a11y／全E2Eまで保留する。
- Provider P2aでMain-only credential resolver、OpenAI API認証header、無料のmodel listによる
  接続確認とcatalog discoveryを追加した。401／403、一時障害、network errorを区別し、
  APIが返さないcapabilityは`unknown`を維持する。
- Provider P2bでResponses APIのstreamをcanonical text／reasoning／tool／resolution／usage eventへ
  正規化した。Structured Output request、429情報、AbortSignalとexecution IDによる取消を含む。
- Provider P2c1でOpenAI ConnectionのMain／Preload契約、safeStorage secret reference、
  作成直後のverification、外部catalog統合、canonical selection検証を接続した。
  native SQLiteの直接検査はNode／Electron ABI差のためfinal gateへ留保する。
- Provider P2c2で外部modelを選んだ通常Chat TurnをProviderRuntimeへ接続した。既存の
  provider-egress policyを実行直前に再検証し、context、stream、reasoning、usage、
  resolved provider／model、cancelを既存Turn lifecycleへ統合した。
- Provider P2c3でTeam雇用へWorker別`modelSelection`を追加し、未指定時は親Agentから継承する。
  built-in Workerは従来CLI、外部WorkerはProviderRuntimeへ分岐し、429は同じattemptのretryへ
  戻す。resolved identityとprovider usageはTeam attemptへ永続化する。
- Provider P3でOpenRouterを独立Gateway Runtimeとして登録した。1000件超catalog、価格、
  capability、Responses stream、Tool Calling、Structured Output、取消、429を共通境界へ
  正規化する。requested model、Gateway、選択upstream、routing metadata、usage／costを分離し、
  DB v48でChat TurnとTeam attemptへ完全なresolutionを永続化する。実API smokeはfinal gateへ
  留保する。
- Provider P4でAnthropic公式APIをClaude CLIとは別のConnection／Runtimeとして登録した。
  公式Models APIのpaginationとcapabilityをcatalogへ反映し、Messages SSEのtext、thinking、
  tool use、usage、resolved model、429、取消をcanonical eventへ正規化する。Chat／Teamは
  Provider-neutral経路を再利用し、実API smokeはfinal gateへ留保する。
- Provider P5aでGoogle Gemini APIのConnection、Models API、`streamGenerateContent` SSEを
  共通Runtimeへ接続した。Google固有の認証、content／function declaration／structured output、
  thinking、usage、429、取消をAdapter内へ隔離した。P5bでuser messageへ上限付きinline image
  契約を追加し、Gemini／Anthropic／OpenAI系Adapterが各Provider形式へ明示変換する。
- Provider P6でxAI APIを独立Connectionとして登録した。OpenAI互換のResponses request／SSEを
  共通helperで再利用しつつ、xAI固有のlanguage-model catalog、modalities、context、価格単位、
  billed cost ticks、Grok error／429をAdapter内で正規化する。
- Compatibility C1aで宣言的`ProviderProfile` schemaと汎用OpenAI-compatible Runtimeを追加した。
  ProfileがBase URL、auth header、protocol、model catalog path、credential要件、error override、
  公式sourceを所有する。Chat Completions SSEのtext／reasoning／tool／usage／resolutionと429を
  canonical eventへ正規化し、custom Base URLはHTTPSまたはloopback HTTPだけを許可する。
  contracts 29件、conformance 4件、対象lintはgreen。実Provider登録はC1bへ分離した。
- Compatibility C1b1でMistral／DeepSeek／GroqCloudの公式Profileを登録し、Profile一覧と
  generic Connection作成をMain／Preload IPCへ接続した。3社は専用Adapterを持たず、同じ
  `openai_compatible` Runtimeへ解決される。公式source URLとreview日時をProfileへ保存し、
  secretはMain-only storage、外部APIの初期同時上限は2を維持する。対象10件、contracts 29件、
  対象lintはgreen。設定UIはC1b2へ分離した。
- Compatibility C1b2でProvider設定UIをMainのProfile一覧へ接続した。RendererはPack Aの会社IDを
  hard-codeせず、全Profileをgeneric createへ送る。Profile一覧だけが失敗しても既存5 Providerを
  維持し、選択中Profileが一覧から消えた場合はAPI key等を消去して未選択表示とし、固定Providerへの
  誤dispatchを遮断する。対象component test 38件とlintはgreen。実API smokeはfinal gateへ留保する。
- Core C2aでDB v40の監査イベントを表示専用Team Activity summaryへ正規化し、
  C2bで「誰を雇ったか」「誰へ任せたか」を含む全11 activity typeを通常Chat timelineへ
  永続履歴カードとして表示した。
- C2c初回E2Eで、packaged mock scenarioだけが旧同期sendを使い委譲監査を作らない差を検出した。
  C2dでmock Leaderもproductionと同じformal assign／async execution／wait経路へ移行した。
- C2cはproduction packageで雇用3件・委譲3件を確認し、同一user-data DBで再起動した前後の
  全activity ID集合が一致し、各IDがDOMへ一度だけ表示されることを検証済み。

## 完成判定

完成とは[acceptance gates](12-acceptance-gates.md)の対象Milestoneがすべてgreenで、未解決の
BLOCKER／CRITICALが0件になり、証拠が保存された状態をいう。「Providerを追加した」
「画面が一度動いた」だけでは完成にしない。
