# ADR-006: Provider Profile、接続検証、Secret Storage

- Status: Accepted
- Date: 2026-07-28
- Supersedes: `instructions/02-final-revision-v2.md` §2、§7、§10の未決設計

## Provider Profile

OpenAI-compatible Providerはschema検証されたProfileでbase URL、auth header、catalog strategy、
capability override、error mapping override、curated rate defaultを表す。generic Adapterに
Provider名条件分岐を追加しない。

conformance失敗は、Profile修正、複数Providerに有効なprotocol extension、専用Adapterの将来Slice、
対応保留の順に判断しADRへ残す。Compatibility Sliceを無制限に拡大しない。

## Verification

- 既定TTLは24時間。
- API key、base URL、organization／project／account ID変更で即失効。
- 期限切れは`verification_expired`とし、selectionとcatalog cacheを削除しない。
- 新規実行だけを止め、実行中attemptは止めない。
- preflightは非生成APIを優先し3秒で打ち切る。未検証のまま実行しない。
- network／timeout／Provider障害をinvalid credentialsへ変換しない。

OpenAI、OpenRouter、Anthropic、Gemini、xAIはいずれもmodel discovery endpointを持つため、
初期verificationは生成probeではなくmodel list／retrieveを第一候補にする。権限が分離される
Connectionだけ、明示費用上限付き最小probeをfallbackにする。

## Secret Storage

secretはMain-onlyのElectron `safeStorage` wrapperへ保存し、SQLiteにはopaque secret referenceだけを
保存する。Renderer／Preloadへ完全値を返さない。production Main／Preload／Adapter／Team Runtimeの
`console.*`をCIで拒否し、logger呼び出し側に依存しない強制redactionを行う。

canary secretをconnection test、auth failure、retry、crash／diagnostic、log、audit、IPC、
Renderer state、screenshot fixtureまで追跡し、SQLite dumpとexportも検査する。

## Evidence

- 現在はredactorだけ存在: `main/secret-redactor.ts:66-97`
- production consoleが残る: `main/index.ts:101,197,204`、`main/team-mcp-bridge.ts:135`
- OpenRouterは429／503の`Retry-After`とstream途中errorを公式に定義する。
- Anthropicは429と`retry-after`、Geminiは429 `RESOURCE_EXHAUSTED`、xAIは429を認証失敗と区別する。
