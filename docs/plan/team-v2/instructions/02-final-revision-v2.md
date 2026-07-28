# Team v2・Multi-Provider計画への最終修正指示 v2

- Source: current Codex task
- Recorded: 2026-07-28
- Status: current

この指示は、既存の「Team v2 マルチAIプロバイダー対応・API検証・Model Picker追加指示」を
修正する。競合する場合は、この最終修正指示v2を優先する。

目的は対応Provider数を減らすことではない。最終的には指定された全Providerへの対応を維持し、
実装方式、Slice構成、初期完成条件、後方互換、検証方法を見直し、Team v2本体の完成を
不必要に遅らせない計画へ修正する。

最初の応答ではコードを変更せず、既存コードを調査したうえで計画文書だけを更新する。

## 0. v1からの主な変更点

- built-in CLI Connectionをrate limit admission controlの対象外とし、既存並列動作を保護する
- queue待ち状態をUIへ必ず表示する
- Connection間fairnessの具体algorithmを指定する
- 実行直前の再検証にtimeout上限を追加する
- Team v2 Coreでconnection ID列だけ先行導入する案をADR検討項目へ追加する
- UI U1へ大量catalog fixtureとcatalog interface依存を追加する
- Claude Opus 5委託を製品計画から分離し、model名を設定値化する
- Compatibility Pack AがInitial GA blockerと誤読されない見出しへ変更する
- この指示文自体をrepositoryで版管理する

## 1. Provider対応を初期releaseと将来拡張へ分ける

### Milestone A — Team v2 Core

対象は動的Agent雇用、階層型Team、管理職による再委譲、最大8件並列、Worker間通信、実行中の
指示修正、attempt、監査、再起動復元、Team Activity Card、階層Canvas、Team Policy、
既存Claude／Codex CLI、既存Chat UIである。

全外部API Providerは実装しない。将来のProvider追加に必要な抽象化は許可するが、既存CLIを
壊さない。P0 ADRで、Core段階にAdapterなしでconnection ID列とrequested／resolved model列を
先行追加するか、Coreデータをconnection ID付きで保存できるか、先行しない場合のbackfill量を
検討する。採用してもAdapter、Secret Storage、外部通信をCoreへ入れない。

### Milestone B — Multi-Provider Initial Release

OpenAI API、Anthropic API、Google Gemini API、xAI API、OpenRouter API、既存Codex CLI、
既存Claude CLIを対象とする。OpenRouterはOpenAI直後に実装する。

### Milestone C — OpenAI-Compatible Provider Packs

Pack AはMistral、DeepSeek、GroqCloud。Pack BはMoonshot、MiniMax、Zhipu、NVIDIA NIM、
Cloudflare Workers AI。初期releaseをblockせず、まずOpenAI互換Provider Profileとして追加し、
会社ごとの専用Adapterを前提にしない。

## 2. Provider Sliceを実装方式単位で分ける

### P0 — 現状調査とArchitecture Decision

コードを変更せず、Claude／Codex CLI Runtime、Agentとexecutionのmodel保存、Chat Picker、
Team selection、Secret Storage、usage、Provider rate limit、TeamCoordinator、最大8並列、
CLI経路、DB migration、Renderer／Main／Preload責務、packaged解決、test fixtureを調査する。

Provider／Connection／Runtime／Model責務、official APIとCLI、built-in rate admission除外、
OpenAI互換Profile、Capability Catalog source、rate limitとTeam並列統合、fairness、Picker移行、
legacy migration、Core connection ID先行導入、Provider固有コード依存方向のADRを作る。

### P1A — Connection Domainとlegacy migration

ProviderConnection、Runtime Kind、Connection ID、requested／resolved provider/model、legacy
Claude／Codex backfill、migration fixture、dual-read、restartを対象とし、実Provider APIは追加しない。

### P1B — 共通Provider基盤

Registry、Adapter Interface、Mock Provider、canonical event、error／usage normalization、
capability schema、connection verification、Secret Storage、secure logger、Provider Profile、
built-in CLI除外を含む二段階Schedulerを対象とする。実Providerを大量に追加しない。

### P2–P6

- P2: OpenAI APIをreference implementationとしてauth、discovery、Chat、Streaming、
  Tool Calling、Structured Output、cancel、usage、resolved model、Chat／Teamへ対応
- P3: OpenRouterを直後に実装し、Gateway/upstream、requested/resolved、pricing、routing、
  大量catalog性能、official routeとの区別へ対応
- P4: Anthropic専用Adapter、Claude CLIとの区別、Streaming、Tool Calling、usage、cancel、
  discovery／curated catalog、Team
- P5: Gemini固有auth／request、Streaming、Tool Calling、Structured Output、multimodal、
  usage、cancel、discovery
- P6: xAI auth、Grok catalog、OpenAI互換再利用、固有差分、Streaming、Tool Calling、usage、
  cancel。互換でも独立Sliceで検証

### C1／C2

C1はProfile EngineとPack A、C2はPack B。Base URL、auth header、catalog、capability/error
override、conformance harnessを使う。失敗時はProfile解決、共通protocol extension、将来専用
Adapter、保留のいずれかをADRへ記録し、generic AdapterへProvider固有分岐を追加しない。

## 3. Model Pickerを独立UI Trackにする

U0は既存Picker、state、conversation保存、restart、Team共有、keyboard、accessibility、
packaged、test fixture、design system、Popoverをコード変更なしで調査する。

U1は`multiProviderModelPickerV2`配下へ新Pickerを追加し、旧Pickerを削除しない。OFFは旧、
ONは新、既存CLIだけでも新を利用、同じ保存データを使用、Provider基盤未完成でも旧を維持、
不具合時にOFFへ戻せる。

U1完了には1000件以上の合成catalog、初期表示／検索／filter／groupの実用速度、2件時点からの
仮想化、共通catalog interfaceだけへの依存、render pathの件数比例同期処理禁止、catalog更新時
1回だけのindex構築を必須とする。fixtureは実通信不要にする。

U2はselection、conversation保存、restart、effort、Runtime解決、Chat、Team、keyboard、
accessibility tree、packagedのparityを比較し、旧Pickerを残す。

U3はUnit、Component、Chat／Team／packaged E2E、keyboard、accessibility、model fixture、
restart、3OS CIがgreen後に既定ONにし、旧Pickerをfallbackとして残す。

U4は独立cleanup PRとし、既定ON、fallback確認、legacy test不要、全test green、
BLOCKER／CRITICAL 0件を削除条件とする。

## 4. UI実装のAgent委託方針

この規定は製品計画へ混ぜず、`docs/process/ui-agent-delegation.md`へ置く。

UI Trackは原則Claude CLIの非対話`claude -p`へ委託する。model名はhard-codeせず、
`UI_DELEGATION_MODEL`の設定値とし、既定値は`claude-opus-5`。将来はこの設定だけを変更する。

対象はProvider settings／Card／API key UI／verification／Picker／検索／filter／icon／detail／
selected model／Team Agent・Activity Card／Canvas model／keyboard／accessibility／reduced motion／
大量model性能。

事前にCLI、`claude -p`、auth、設定model、最小request、worktree accessを確認する。実引数は
installed CLIのhelpで確認する。model利用不能時は黙ってfallbackせず停止・報告する。

委託はUI Slice単位。変更file上限、差分目安1000行、同一Slice最大3往復を定め、超過時は
メインAgentが再分割する。

報告は完了状態、変更file、達成／未達条件、test、判断、backend contract proposalを含める。
メインAgentがcontract、worktree、backend type／IPC、review、security、test、packaged、mergeを
所有する。

Provider Runtime、TeamCoordinator、DB migration、Secret Storage、MCP権限、usage、課金、
無関係画面、全面refactorを委託先へ許可しない。実secret、header、Cookie、token、実ユーザー
データを渡さない。

## 5. Capability Catalog source

`CapabilitySource`は`provider_api | official_curated | unknown`。

`provider_api`はAPI／Runtimeが返したID、availability、resolved model、権限、usage、context。
`official_curated`は公式文書由来のcontext、output、pricing、input、Tool Calling、
Structured Output、reasoningで、可能ならsource、version、reviewedAt、reviewedBy、
pricing effective dateを保存する。

coding、reasoning、speed、cost tendency、quality、latencyは既定unknown。model名、価格、
Provider名から推測しない。unknownでもcatalogをinvalidにせず、UIは0や空欄でなく「不明」とする。

`CatalogValue<T>`はvalue、source、sourceReference、observedAtを持つ。valid identityの最低条件は
connection ID、provider ID、model ID、display name、availability、確認日時。

## 6. Provider rate limitと最大8並列

Team global上限とConnection／Provider上限を二段階admission controlで統合する。

### built-in CLI

`builtin:claude-cli`、`builtin:codex-cli`等は外部API rate limitを持たないため、Connection
admission対象外、またはglobal上限と同値にする。API向け保守値を適用せず、従来の最大8並列と
terminal並列を低下させない。

P1A／P1B完了にはClaude-only、Codex-only、Provider OFFでCoreと同じ並列数を必須とする。
CLI固有上限が必要なら独立設定とADRにする。

### 基本動作とUI

hireはrate limitで拒否しない。assignはexecutionを作り、完了を待たずIDを返す。slotなしは
failedでなくqueue。queued／waitingはglobal concurrencyを消費しない。

Agent Card、Activity Card、Canvas、Listにstate、wait reason、wait開始／経過、Connection名を
表示し、止まって見える状態を作らない。

ConnectionはmaxConcurrentRequests、RPM、TPM、rateLimitMode、observed headersを持つ。初期modeは
auto。情報がない外部APIは同時2件、built-in CLIには適用しない。上限引き上げ時は429警告。

### 429とfairness

Retry-After、headers反映、waiting_rate_limit復帰、exponential backoff＋jitter、既定3 retry、
deadline／Team time到達時だけ`rate_limited`でfailed。credentials等へ誤分類しない。

Connectionごとtoken bucket、Connection内FIFO、Connection間round-robin、Team間の無期限追越し
禁止、agingでstarvation防止。別Connection progress、starvation、restart順序をtestする。
queue timeとAI timeを分離し、wall-clock budgetにはqueueを含める。

## 7. Connection verification TTL

既定TTLは24時間。auth関連設定変更で即時invalidate。expiryは`verification_expired`とし、
設定／selectionを削除せずPickerへ「接続の再確認が必要です」と表示する。新規Chat／Teamは
成功まで開始せず、running attemptは停止しない。

実行直前は非生成API優先、なければ最小token probe。preflight timeoutは3秒。timeout後に
未検証のまま開始せず、進捗／cancelまたは未完了とretryを表示する。timeoutや一時network errorを
invalid API keyへ変換しない。起動、settings、Pickerでbackground確認できるが、有料probeを
毎回全Providerへ送らない。

## 8. Legacy data migration

stable built-in connection IDを割り当て、raw legacy値をdual-readまたはsnapshotで保持する。
解決不能でもunknown legacy runtimeとして履歴表示する。

migrationはtransaction、idempotent、offline、key不要、rollback／backup、no deletion、
audit order維持、conversation／Team参照維持を満たす。

fixtureは初期、Team前、production、Claude-only、Codex-only、mixed、running、interrupted、
unknown modelを含む。

P1A完了には既存Chat／Team／Agent model／execution、restart、pagination、二重migration、
Provider未設定CLI利用、CLI並列維持、Picker OFF／ONを含める。legacy列削除は別cleanup。

## 9. 文書分割

計画は`docs/plan/team-v2/`へREADMEと00–12文書、必要な`slices/`を作る。processは
`docs/process/ui-agent-delegation.md`へ分離する。

READMEはsummary、milestone、Slice、dependency、order、links、current location、blocker、
completionを持つ。Chatには文書一覧、短いmilestone、Provider順、重要判断、未解決、最初の
Sliceだけを返す。

## 10. 禁止事項をCIで検査

TeamCoordinator→Provider Runtime／Registry interfaceだけを許可し、Adapter、SDKへの直接依存を
禁止する。no-restricted-imports、dependency boundary、AST／import graphを使い、Provider名の
実行分岐を検査する。UI表示／fixtureの正当な文字列はallowlistにする。

Main、Preload、Adapter、Team Runtimeの生`console.*`を禁止し、secure loggerを必須にする。
loggerはAuthorization、API key、token、Cookie、x-api-key、Bearer、Provider secret header、
query／body secretを強制redactする。

架空canary`SPRINT_CODER_SECRET_CANARY_7f91c`がconnection test、auth failure、exception、retry、
crash、diagnostic、log、audit、IPC、Renderer、screenshotにないことを確認する。

SQLite、config export、diagnostic、Renderer、crash、Team auditへAPI keyがないことを検査する。
Catalog、Scheduler、Picker OFF／ONと1000件fixtureもCI対象にする。

## 11. 完成定義

Team v2 Core GAは外部APIを待たない。

Multi-Provider Initial GAはOpenAI、Anthropic、Gemini、xAI、OpenRouter、Claude／Codex CLI、
common Picker、verification、Secret Storage、legacy migration、CLI並列維持、Chat、Team、
restart、packaged E2E、3OS CIを必須とする。

Pack A GAとPack B GAはInitial GAをblockしない独立条件とする。Profileだけで対応できる場合は
Pack PRにまとめるが、Provider別config、conformance、real smokeを分けて報告する。

## 12. 最終実装順

```text
Team v2 Slice 0
↓
Team v2 Core A/B/C
↓
Provider P0
↓
Provider P1A
↓
Provider P1B
↓
UI U0
↓
UI U1
↓
Provider P2: OpenAI
↓
Provider P3: OpenRouter
↓
Provider P4: Anthropic
↓
Provider P5: Gemini
↓
Provider P6: xAI
↓
UI U2
↓
UI U3
↓
Multi-Provider Initial GA
↓
Compatibility C1
↓
Compatibility C2
↓
UI U4
```

依存で変更する場合はADRへ理由を書く。巨大PRへまとめず、各Slice green時に停止して証拠を
報告する。

## 13. 計画修正の完了条件

Provider Sliceの方式単位化、OpenRouter前倒し、Profile統合、Pack A/B非block化、UI Track、
feature flag／並走、1000件fixture、UI委託分離とmodel設定値化、委託上限／報告、Catalog source、
unknown、二段階Scheduler、built-in除外、CLI並列維持、queue UI、fairness、429、24h TTL、
3s preflight、legacy migration、Core identity ADR、履歴／restart test、文書分割、architecture CI、
secure logger、canary、Scheduler CI、Milestone完成分離をすべて満たす。

## 14. この指示文の管理

```text
docs/plan/team-v2/instructions/
├── 00-original-team-v2.md
├── 01-multi-provider-addendum.md
└── 02-final-revision-v2.md
```

優先順位は最新ADR、最新指示、過去指示。指示更新時は影響ADRと計画文書を同じPRで更新する。
