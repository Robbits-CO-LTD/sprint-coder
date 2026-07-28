# UI Agent Delegation

この文書は製品仕様ではなく開発プロセスである。

## Single source of model configuration

正本は[`ui-agent-delegation.env`](ui-agent-delegation.env)の`UI_DELEGATION_MODEL`とする。

UI委託で具体的なmodel IDを使用するのはこの設定だけとする。計画文書、prompt template、
script、CIへmodel IDを複製しない。model変更時はこの設定だけを更新する。

## Invocation

UI Trackの設計・実装はClaude CLIの非対話実行へSlice単位で委託する。

```bash
source docs/process/ui-agent-delegation.env
claude -p --model "$UI_DELEGATION_MODEL"
```

実行時はinstalled CLIの`claude --help`で引数を再確認する。2026-07-28のClaude CLI 2.1.218では
`-p/--print`と`--model`が利用可能である。

`--fallback-model`を指定しない。設定modelが利用不能な場合は別modelへ黙ってfallbackせず、
次を報告して停止する。

```text
UI委託を開始できませんでした。
理由：UI_DELEGATION_MODEL に指定されたモデルを現在のClaude Runtimeで利用できません。
```

`--permission-mode plan`は内部探索Agentが別modelを使用し得るため、model固定のUI委託では使わない。
読み取り専用委託は`dontAsk`とRead／Grepのallowlistを使い、Agent／Taskを明示的に禁止する。
完了結果の`modelUsage`に`UI_DELEGATION_MODEL`以外が含まれる場合、その委託結果を採用しない。

## Preflight

- Claude CLIがPATH上に存在
- `claude -p`が実行可能
- Claude認証が有効
- `UI_DELEGATION_MODEL`が実在し利用可能
- toolsなしの最小非対話requestが成功
- 対象worktreeをClaudeがread/write可能
- 実secretや実ユーザーデータがprompt／fixtureにない

preflightの結果、CLI version、model、exit status、実費を記録する。成功出力へsecretを含めない。

2026-07-28のU0ではCLI 2.1.218、設定model、exit 0を確認した。最小probe実費は$0.092194。
初回U0はPlan modeの内部探索で設定外modelが使われ、$3上限で報告なし終了したため不採用とした。
Agent／Taskを禁止した再実行は設定modelだけを使用し、$0.859953、変更0で完了した。

同日のU1bはAgent／Taskとfallbackを禁止し、設定model自身だけへ最大6fileを委託した。
第1往復は$5上限、第2往復は$3上限で完了report前に停止したため、どちらも自動の完了判定には
使わなかった。生成差分はメインAgentがreviewし、第2往復までの合計差分が1000行以内であること、
対象外fileがないこと、desktop typecheck、対象file lint、virtualization unit 17件のgreenを
確認してU1bを受理した。full suite、E2E、packaged確認は全実装後のfinal gateへ留保した。

同日のU1cもAgent／Taskとfallbackを禁止し、設定model自身だけへ最大4fileを委託した。
第1往復はCLIが許可外commandの確認待ちになったため中断し、差分0、実費$2.712297で不採用とした。
第2往復は完了reportまで到達し、実費$2.8390755でSettings統合を生成した。メインAgentのreviewで
Secret Storageを誤解させる説明と、Connection間でverificationを同時開始できる問題を発見した。
第3往復はその2点を修正し、実費$2.016907だったが、予算上限により最終report前に終了した。
メインAgentが差分を直接reviewし、冗長commentだけを削って4file・1000差分行未満へ戻したうえで、
component test 24件、対象file lint、`git diff --check`のgreenを確認してU1cを受理した。
full suite、E2E、packaged確認は全実装後のfinal gateへ留保した。

同日のU2aは設定model自身だけへ最大6fileを委託し、1往復、実費$2.832971で完了reportを得た。
`modelUsage`は設定modelだけで、Agent／Task、fallback、permission denialは0件だった。
メインAgentは5file・1000差分行未満、backend変更0を確認し、Task切替、stale response、
Task-safe rollback、canonical変更後の表示名をreviewした。純粋unit 15件と対象file lintはgreen。
desktop typecheckは変更箇所ではなく既知のVite二重依存type errorだけで停止した。
Chat／Team／restart／packaged parityは全実装後のfinal gateへ留保した。

同日のCompatibility C1b2は設定model自身だけへ最大3fileを委託した。第1往復は実費
$3.0452085、第2往復は$2.5247585で、どちらも設定modelだけを使用したが予算上限により
完了report前に停止した。第1往復の差分をメインAgentがreviewし、選択中Profileが一覧から消えた
とき固定Providerへ誤dispatchし得る問題を発見した。第2往復で未選択表示、credential消去、
submit／dispatchのfail-closedを追加した。メインAgentが2file・1000差分行未満、Pack A IDの
hard-codeなし、backend変更0を確認し、component test 38件と対象lintのgreenを得て受理した。
実API smokeとpackaged操作は全実装後のfinal gateへ留保した。

## Delegation scope

- Provider settings
- Provider Card、icon
- API key入力とmask表示
- connection verification state
- Model Picker、検索、Provider／capability filter
- model detail、selected model表示
- Team Agent／Activity Card
- Team Canvas model／Connection表示
- keyboard、accessibility、reduced motion
- 大量model表示性能

## Unit of delegation

1回の委託は1つのUI Slice内の1つのreview可能なsub-Sliceに限定する。

- 変更可能ファイル: promptで列挙した最大8ファイル
- 差分上限: 追加＋削除の合計1000行
- 同一sub-Sliceの往復: 最大3回
- backend contract提案: reportのみ。実装禁止

上限へ到達したら追加委託せず、メインAgentがscopeを分割する。上限超過を理由にreviewやtestを
省略しない。

## Required prompt contract

Claudeへ次を明示する。

- Slice objectiveとacceptance criteria
- 変更を許可する絶対path
- 変更禁止path／subsystem
- 利用するbackend type／IPC contract
- design systemと既存component
- keyboard／accessibility／reduced-motion要件
- targeted test command
- file／diff／round上限
- backendを推測変更せずproposalだけを返すこと

## Required report

- 完了／部分完了／未着手
- 変更ファイル一覧
- 満たした受入条件
- 満たせなかった受入条件
- 実行したtestと結果
- 未実行test
- 判断に迷った箇所と採用案
- 必要なbackend contract proposal
- diff file数と追加削除行数

部分完了を完了と記録しない。未実行testをgreenと記録しない。

## Main Agent responsibilities

- UI contract確定
- worktree準備と許可file制限
- backend型とIPC提供
- Claude差分review
- security／accessibility review
- targeted test、packaged app、Computer Use
- merge判断

## Forbidden changes

- Provider Runtime
- TeamCoordinator
- DB migration
- Secret Storage実装
- MCP権限
- usage／課金計算
- 無関係な画面
- repository全体refactor

## Forbidden input

- 実API key
- Authorization header
- CI secret
- Cookie
- access／refresh token
- 実ユーザーの会話、コード、project情報

fixtureは架空データだけを使い、screenshotにもsecret canaryが残らないことをメインAgentが確認する。
