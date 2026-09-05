---
name: sprint-coder-real-ai-smoke
description: >-
  Sprint CoderのmacOS開発buildをComputer Useで実操作し、Chat UIと設定画面の
  視覚崩れ、Ollama必須かつClaude CLIまたはCodex CLI必須の実応答、各AIによる
  隔離workspace内のファイル編集とコマンド実行を受入スモークする。トリガー:
  Sprint Coder開発版の実AIテスト、Computer UseでChat/設定/tool-use確認、
  OllamaとClaude/Codexの実機スモーク。mockだけのE2E、修正、Issue起票には使わない。
---

# Sprint Coder Real AI Smoke

開発buildそのものを目視・実操作し、UIの健全性と実Providerのcoding tool-useを
同じrunで証明する。モデルの成功文ではなく、アプリ状態、実ファイル、実command結果を
一次証拠にする。

## 必須境界

- macOSのUI操作は、現在の`computer-use` Skillを読み、Computer Useで行う。
- 対象は`/Users/yusei/sprint-coder`の現在checkoutから起動した開発buildとする。
  `/Applications/Sprint Coder.app`や古いpackaged buildで代替しない。
- UI操作をshell、Playwright、AppleScriptで代替しない。起動、process照合、fixture作成、
  ファイル実測、ログ確認にはshellを使ってよい。
- 実Providerは`Ollama`を必須とし、さらに`Claude CLI`または`Codex CLI`のどちらか
  1つを必須とする。OpenRouter上のClaudeはCLIの代替にしない。
- 実AI・実tool-useを明示していない依頼へ課金またはモデル実行を拡張しない。
  このSkillを明示した受入スモーク依頼は、下記の限定promptを各必須Providerへ
  1回ずつ送る許可として扱う。
- credentialの入力、保存、再認証、モデルdownload、Provider追加は自動で行わない。
  既存の認証済みCLI接続と導入済みOllamaモデルだけを使う。
- source repositoryをAIの編集対象にしない。runごとにrepo外へ専用の一時workspaceを作り、
  そのdirectoryだけをSprint CoderのProjectとして選択する。
- source、設定、Issue、PRを修正・作成しない。不具合候補はreport-onlyにする。
- prompt本文、response本文、credential、環境変数全体をログや報告へコピーしない。
  nonce、Provider名、Turn状態、tool名、対象relative path、exit code、短い非機密markerだけを残す。
- 必須caseを環境都合で実行できなければ`SKIP`でなく`BLOCKED`とする。両Providerが
  完走しないrunを総合PASSにしない。

## 先に読むもの

1. 現在の`computer-use` Skill全文
2. `.claude/skills/sprint-coder-e2e/SKILL.md`の起動対象・dev build識別・process保護の契約
3. [受入マトリクスと報告契約](references/acceptance-matrix.md)

## 実行前のscope ledger

操作前に次を短く宣言する。

- ユーザーに見える成果: Chat UI、設定画面、2系統の実AI応答、各AIのfile editとcommand
- 必要な変更: repo外の一時workspaceと、その中の使い捨てfixtureだけ
- 非対象: source修正、Issue起票、全Playwright E2E、モデルdownload、credential設定
- 最小証明: Providerごとに別TaskでTurn完了、期待byteの実ファイル、marker付きcommand exit 0

## 実行手順

### 1. sourceと開発buildを束縛する

1. `git status --short`、現在commit、Node 22、依存関係、port 5173の所有processを確認する。
2. ユーザーの既存変更と既存`npm start`を保持する。`pkill`や広いprocess killを使わない。
3. 開発serverがなければ`npm start`を起動し、main/renderer readyを待つ。起動失敗時は
   native ABI、依存関係、port衝突を切り分けるが、製品不具合と決めつけない。
4. PID/command/cwd、renderer URL、画面内versionまたはdevelopment markerのうち
   2つ以上で、Computer Useの対象windowが現在checkoutの開発buildだと照合する。
5. 自分が起動したprocessだけをrun終了時のcleanup候補として記録する。

### 2. 隔離workspaceを用意する

repo外の安全な一時directoryに、Provider別の空directoryを2つ作る。各directoryへ
`README.md`を置き、このrun専用であることと非機密fixtureだけを扱うことを示す。
Providerごとに一意なnonceを生成し、期待値をrun記録へ保持する。

### 3. UIを先に検証する

実Providerを送信する前に、Computer UseでChatと設定を操作する。

- Chat: shell、sidebar、header、message list、composer、Provider/model picker、Project表示、
  send/stop controls、scroll、empty/loading/error領域を確認する。
- 設定: 設定dialogを開き、主要sectionを巡回する。特に「モデルと接続」で
  Cloud AI / 外部Local AI、Claude/Codex CLI、Ollama、接続状態、展開詳細を確認する。
- current windowと実用的な狭幅windowで、重なり、clipping、意図しない横scroll、
  読めない文字、切れたbutton、dialogの画面外逸脱、focus喪失がないか確認する。
- keyboardだけで設定を開閉し、主要controlへ移動し、閉じた後にfocusが戻るか確認する。
- 画面全体に秘密や個人情報があれば全画面captureを避け、対象componentだけを記録する。

見た目の主観だけでFAILにせず、操作不能、情報欠落、重なり、clipping、契約との差を
観測できるものだけをFindingとする。

### 4. 実Providerを選ぶ

設定画面の現在状態と実行前probeを照合する。

- Ollama: service到達、導入済みmodel一覧、選択候補、接続検証結果を確認する。
  最小でtool-use能力が確認できる導入済みmodelを選び、新規pullはしない。
- Cloud CLI: Claude CLIを優先し、利用不能ならCodex CLIを使う。UIのready表示だけでなく、
  CLIの存在と認証状態も秘密を出さないread-only probeで照合する。
- どちらかの必須laneが利用不能なら理由を`blocked_provider`または`blocked_auth`として残す。
  mock、別API、AIの自己申告で置き換えない。

### 5. Providerごとに独立したtool-use Turnを実行する

Ollamaと選んだCLI Providerを、別Project・別Task・fresh contextで1回ずつ実行する。
各TaskでProjectが対応するProvider専用一時directoryを指すことをUIから確認する。

promptは自然言語で次の結果だけを要求し、tool名やJSONをモデルへ教えない。

1. `smoke/<provider>.txt`を作成し、指定nonceを含む1行へ編集する。
2. そのファイルを読み、内容が期待値と一致しなければ非0終了する安全なcommandを実行する。
3. commandから`SC_REAL_AI_OK:<provider>:<nonce>`を標準出力し、結果を短く報告する。

必要なworkspace/command承認は、対象が専用一時directoryと上記の安全なcommandに
一致する場合だけComputer Useで承認する。scopeがrepo、home、network、秘密情報へ広がったら
拒否し、`fail_scope_escape`とする。

各Turnで以下を観測する。

- 実際に選択されたConnection/model
- sent → streaming/executing → completedの状態遷移
- file操作とcommand実行のtool cardまたは承認表示
- 最終回答が空でなく、途中停止・無限loading・error表示で終わっていないこと
- Turn完了後の実ファイルbyte、期待relative path、command exit code 0、完全一致marker

回答が正しく見えても実ファイルかcommand証拠が欠ければFAILとする。UIで表示された
tool結果と、UI外からのread-only実測が一致して初めてPASSにする。

### 6. 結果をまとめてcleanupする

1. [受入マトリクス](references/acceptance-matrix.md)の全caseを`PASS`、`FAIL`、
   `BLOCKED`、`NOT_RUN`で埋める。
2. 独立した不具合候補ごとに症状、期待、実測、再現手順、artifactを整理する。
   Issue起票は現在依頼に明示がない限り行わない。
3. 作成した一時workspaceは証拠確認まで保持し、報告にpathと削除可否を書く。
   削除を依頼されていなければ勝手に消さない。
4. 自分が起動した開発processだけを通常終了する。既存のserver/windowは保持する。
5. 総合判定を出す。UI必須caseと2つのProvider laneがすべてPASSした場合だけ総合PASS。

## 停止理由

`blocked_dev_build`、`blocked_auth`、`blocked_provider`、`blocked_model`、
`fail_ui`、`fail_response`、`fail_file_edit`、`fail_command`、
`fail_scope_escape`、`fail_tooling`のいずれかを使い、観測事実と未確認範囲を併記する。

## 関連Skillとの境界

- `sprint-coder-e2e-patrol`: 広いUI巡回、独立2回再現、Finding/Issue候補化に使う。
- `root-cause-guardrail`: このsmokeで見つかったFAILを修正する段階で使う。
- `issue-closeout`: 修正後のIssue完了判定に使う。

このSkill自体は修正、Issue操作、merge、releaseを行わない。
