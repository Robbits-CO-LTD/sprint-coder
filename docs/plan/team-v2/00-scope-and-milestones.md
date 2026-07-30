# Scope and Milestones

## 目的

ユーザーがChatでTeam作業を依頼したとき、Leaderが必要な人数と役割を決め、適切なモデルを
割り当て、階層的に委譲し、実行中にも軌道修正できるTeamを提供する。重要な出来事はChat履歴へ
残し、詳細はTeam UIで追跡できるようにする。

## Milestone A — Team v2 Core

### 必須

- 明示的なTeam依頼と複雑タスク判定からの自動Team展開
- 固定人数ではない動的Agent雇用
- 最大深度4の親子階層と、Team Policyで指定されたManagerだけの再委譲
- Team全体で実際に最大8件のAI実行を並列化
- Worker同士の直接通信と全messageの監査
- queued中の指示更新、およびrunning attemptを中断して同じWorkerで再開するsteer
- executionとattemptの分離、監査event、再起動復元
- Team Activity Card、Agent Card、階層Canvas、List View、Team Policy
- 既存Claude CLI／Codex CLIと既存Chat UIの安定動作
- 「～を雇いました」など重要Team eventのChat timeline永続表示

### 非目標

- 外部API Adapter
- APIキー入力・保存
- 外部Provider通信
- 外部API向けrate-limit admission

Coreでは将来のProvider追加に必要なconnection ID、requested／resolved model列を先行追加する。
stable IDは`builtin:claude-cli`と`builtin:codex-cli`とし、旧値を保持する。

## Milestone B — Multi-Provider Initial Release

- OpenAI API
- OpenRouter API
- Anthropic API
- Google Gemini API
- xAI API
- 既存Codex CLI／Claude CLI
- Provider Connection、Secret Storage、検証TTL、共通Catalog、共通Picker
- ChatとTeamの両方からの実行
- legacy migration、再起動復元、packaged E2E、3OS CI

OpenRouterはOpenAIの直後に実装し、公式API経由とGateway経由を履歴で区別する。

## Milestone C — Compatibility Packs

### Pack A

Mistral、DeepSeek、GroqCloudをOpenAI-compatible Provider Profileで追加する。Pack A GAは
Initial GAのblockerではない。

### Pack B

Moonshot、MiniMax、Zhipu、NVIDIA NIM、Cloudflare Workers AIを同じProfile Engineへ追加する。
Pack B GAはInitial GAとPack A GAのblockerではない。

## Scope ledger

| Slice | ユーザーに見える成果 | 必須変更 | 非目標 | 最小証拠 |
|---|---|---|---|---|
| Team Core | Teamが階層・並列・steer付きで動く | domain、persistence、runtime、UI | 外部API | 既存CLIのpackaged Team E2E |
| P1A | 旧履歴がconnection IDへ安全に移行 | schema、backfill、dual-read | 実API | 全DB fixtureを二重migration |
| P1B | API実行を安全に接続できる共通基盤 | registry、mock、scheduler、secrets | 大量Provider | mock conformanceとCLI並列回帰 |
| U1 | 新Pickerをflag配下で試せる | catalog client、仮想化、検索 | 旧Picker削除 | 1000件fixture |
| P2–P6 | Initial ProviderをChat／Teamで利用 | Adapterとfixture | Pack A/B | Provider別contract＋smoke |
| C1/C2 | Profile追加で互換Providerを利用 | 設定とconformance | generic分岐の増殖 | Provider別result |
