# Team v2・Multi-Provider 改訂計画

- 計画版: v2
- 状態: planning
- 現在地: Team Slice 0、Core A、Core B1a/B1b/B2a/B2b/B3a/B3b/B3c/B4、
  Core C1a/C1b/C2a/C2b/C2c/C2d/C3a/C3b/C4a/C4b/C5a完了
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

- 現行DB migrationはv40。新規Claude／Codex Turn・Agentはbuilt-in connection IDと
  requested model identityを保存し、Runtimeが返したresolved modelを別フィールドへ保存する。
  Taskの明示selectionはcanonical repositoryへ保存され、未設定Taskは旧global Picker設定を読む。
- Teamの旧Worker上限3は撤廃済み。Coordinatorは永続化されたAgent ID、Manager Policy、
  parent/depthに基づく深度4までの再委譲境界を持つ。Canvas／Listは可変人数を表示し、
  5 Workerのpackaged E2Eがgreen。Manager RuntimeにはAgent IDをtoken registrationへ固定した
  Team MCPを渡し、直下Agentのhire／assignと自分が作成したexecutionのsteer／cancelだけを許可する。
- `spawnSlots: 8`とは別に、AI executionをglobal最大8件で動かすSchedulerを実装済み。
- Provider Connection、外部API Adapter、Secret Storage、API rate-limit Scheduler、feature flag基盤は
  未実装。
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
