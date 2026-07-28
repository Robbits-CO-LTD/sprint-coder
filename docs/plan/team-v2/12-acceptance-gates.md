# Acceptance Gates

## Team v2 Core GA

- dynamic hire、depth 4、Manager-only delegation
- 実8並列とqueue表示
- Worker direct messagingと監査
- queued／running steer
- execution／attempt／audit／restart
- Activity Card、Agent Card、hierarchical Canvas、List View、Team Policy
- persistent「～を雇いました」Chat event
- existing Claude CLI／Codex CLIのChat／Team
- packaged E2E、keyboard、accessibility、reduced motion
- Provider Adapter／Secret Storageなしでgreen

Provider数をCore GA条件へ追加しない。

## Multi-Provider Initial GA

- OpenAI、OpenRouter、Anthropic、Gemini、xAI
- Claude CLI、Codex CLI
- common Model Picker default ON、legacy fallbackあり
- API key verification、24h TTL、3s preflight
- Secret Storage、secure logger、canary green
- legacy migration、restart、timeline pagination
- built-in CLIの8並列維持
- Chat／Team／Tool Calling／Streaming／cancel／usage
- packaged E2Eと3OS CI
- 未解決BLOCKER／CRITICAL 0件

## Compatibility Pack A GA

このGateはInitial GAをblockしない。

- Mistral、DeepSeek、GroqCloud
- OpenAI-compatible Profile conformance
- Provider別の設定、conformance result、実API smoke result
- generic RuntimeへProvider名条件分岐なし

## Compatibility Pack B GA

このGateもInitial GAとPack Aをblockしない。

- Moonshot、MiniMax、Zhipu、NVIDIA NIM、Cloudflare Workers AI
- Profile schemaとProvider別conformance
- 専用Adapterが必要なProviderは無制限にSliceを拡大せず、将来Sliceまたは保留ADR

## UI U4 cleanup gate

- Picker V2 default ON
- fallback／rollback確認済み
- legacy Picker test不要
- all automated tests green
- unresolved BLOCKER／CRITICAL 0件
- legacy列削除とは別PR

## Evidence report

各Gateはcommit、環境、OS、fixture、test command、結果、実API実費、screenshot、既知制限、
rollbackを記載する。部分完了をcompleteとしない。未実行testをgreenと記録しない。
