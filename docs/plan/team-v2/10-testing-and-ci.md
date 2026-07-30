# Testing and CI

## Verification ladder

1. touched package typecheck／targeted unit
2. Slice subsystem test
3. affected integration／packaged boundary
4. Milestone final gate: full suite、3OS、real smoke、Computer Use

同じ高コストgateを小変更ごとに繰り返さない。失敗時は最小の失敗testへ戻り、原因確定後に
広いgateを再実行する。

## Architecture tests

TypeScript compiler APIでimport graphとASTを検査する。

- Team CoreからProvider Adapter、Provider SDKへのimport禁止
- Team CoreはProviderRuntime／ProviderRegistry interfaceだけを参照
- Team Coreのswitch／ifでProvider名文字列を実行分岐に使うことを禁止
- UI label、fixture、Profile dataはallowlist
- ESLint `no-restricted-imports`を同じ境界へ設定

単純grepだけを合格証拠にしない。

## Scheduler tests

- built-in CLIにAPI既定2並列を適用しない
- Provider機能OFFでCoreと同じ8並列
- Claude-only／Codex-onlyで8並列
- 1 Connection飽和中に別Connectionが実行
- starvationなし
- 429がcredentialsへ分類されない
- queue orderとwait reasonがrestart後に復元
- queue waitとAI timeを別集計

## Picker tests

OFF／ONの双方でChat、model保存、restart、Team、Claude CLI、Codex CLIを検証する。ONでは
1000件以上のfixture、検索、filter、group、仮想化、viewport外非描画、keyboard、
accessibility treeを検査する。

## Migration tests

[data migration](08-data-migration.md)の全fixtureを各OSで実行する。migration前backup、途中失敗、
二重実行、unknown legacy、running／interrupted attempt、timeline paginationを含める。

## Provider tests

- Mock Provider contract
- canonical stream fixture
- Tool Calling／Structured Output fixture
- cancellation
- usage／resolved model
- normalized error
- verification TTL
- Profile conformance
- release時だけの実API smoke

実API smokeはsecret付きの保護されたrelease jobまたはローカルrelease gateで行い、fork PRへ
secretを渡さない。生成tokenを最小化し、実費を報告する。

実行ハーネスは`provider-release-smoke.test.ts`、保護workflowは`provider-smoke.yml`とする。
通常のunit testでは外部通信せず、`SPRINT_CODER_PROVIDER_SMOKE=1`の明示時だけ有効になる。
`SPRINT_CODER_PROVIDER_SMOKE_REQUIRED`へ列挙したProviderは、secretやsmoke modelがなければ
skipではなくfailedとする。各Providerはverification、catalog、実streaming、resolution、
usage、completionを個別に検証し、secretを含まないJSON evidenceを出力する。

## Packaged and Computer Use

- 3OS CIでtypecheck、lint、unit、package smoke
- 対象boundary変更時にpackaged E2E
- Initial GAで3OS packaged E2E
- macOS最終gateで他の同名Electron processを終了・識別してからpackaged appを起動
- Computer UseでChat→Team→雇用履歴→queue表示→steer→report→restartを操作
- screenshot、event ID、DB projection、test logを同じevidence bundleへ保存

自動testとComputer Useのどちらか片方だけで完成としない。

## 2026-07-28 local final gate

- full typecheck、lint、format check: green
- desktop unit: 106 files passed、3 skipped、1444 passed、23 skipped
- contracts 30、domain 284: green
- production package build: green
- packaged E2Eの初回16 failureは、legacy Picker flag、Team Runtime fallback、a11y label、
  Codex app-server stage／message identityの実不具合として修正し、対象再検証green
- 実Claude Leader: 2 Workerの実reportを受信し統合
- 実Codex Leader: 数学担当／実装担当の2 Workerを雇用し、実reportを受信し統合
- OpenRouter: 認証、368-model catalog、`openrouter/free` streaming、resolution、usage、
  completionが実APIでgreen
- Computer Use: macOS production packageの共通Picker、Capability unknown表示、Team Canvas、
  accessibility treeを確認

未実行は3OS CI、Windows／Linux package、資格情報がないProviderの実API smokeである。
これらをgreenと記録しない。

2026-07-29の追加Computer Useと最終hardening結果は
[evidence report](evidence/2026-07-29-local-final-gate.md)へ記録する。これは実装中の
全体suite再実行ではなく、最終gateで未取得だったrunning steer／再起動／正常終了の実機証拠と、
そこで検出した2件のtargeted regression testである。

## Existing failing baseline

Team unitの2失敗とTeam E2Eの3 timeoutはSlice 0でRoot Cause Confirmed Gateを通す。test timeout延長、
skip、assertion削除だけでは修正としない。
