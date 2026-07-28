# UI Agent Delegation

この文書は製品仕様ではなく開発プロセスである。

## Single source of model configuration

```text
UI_DELEGATION_MODEL=claude-opus-5
```

UI委託で具体的なmodel IDを使用するのはこの設定だけとする。計画文書、prompt template、
script、CIへmodel IDを複製しない。model変更時はこの設定だけを更新する。

## Invocation

UI Trackの設計・実装はClaude CLIの非対話実行へSlice単位で委託する。

```bash
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

## Preflight

- Claude CLIがPATH上に存在
- `claude -p`が実行可能
- Claude認証が有効
- `UI_DELEGATION_MODEL`が実在し利用可能
- toolsなしの最小非対話requestが成功
- 対象worktreeをClaudeがread/write可能
- 実secretや実ユーザーデータがprompt／fixtureにない

preflightの結果、CLI version、model、exit status、実費を記録する。成功出力へsecretを含めない。

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
