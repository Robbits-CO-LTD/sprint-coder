# Phase 3 — Computer Use 実 AI テストの手順・anchor・case matrix

Claude lane → Codex lane の順に、lane ごとにこの文書を頭から適用する。lane の途中で BLOCKED になっても、残りの case を `NOT_RUN` として記録し、もう一方の lane は最後まで回す。**Phase 3 は manifest の `real_ai=on`（`new-run.sh --real-ai on --authorized-by "<依頼文の該当語>"`）が無ければ始めない。** `launch-dev-instance.sh` はそれを機械的に拒否する。

## 1. lane の入出力

| 項目 | 値 |
|---|---|
| profile | `$RUN_DIR/lanes/<lane>/profile`（`SPRINT_CODER_USER_DATA_DIR` と `SPRINT_CODER_SKILL_HOME`） |
| workspace | `$RUN_DIR/lanes/<lane>/workspace`（README.md 入り。Project の primary folder にする） |
| nonce | `$RUN_DIR/lanes/<lane>/nonce`（8 hex。prompt と検証の両方で使う） |
| app.json | 起動した Electron の identity（pid・起動時刻・コマンド行・profile・debug port）。`stop-dev-instance.sh` はこれと一致するプロセスだけを止める |
| debug.json | `--debug-port` 指定時のみ。この起動が `app.log` に印字した DevTools browser id と listener pid。`seed-instance.mjs` はこれと一致する endpoint にしか接続しない |
| app log | `$RUN_DIR/lanes/<lane>/app.log`（main / runtime-host の stdout+stderr。**追記のみ**。再起動ごとに `==== bug-sweep launch … ====` の区切り行が入る） |
| events | `$RUN_DIR/lanes/<lane>/events.jsonl`（操作・観測・判定を 1 行 1 件で追記） |
| モデル | Claude: ピッカー検索 `sonnet` → 「Sonnet 5」 / Codex: 検索 `gpt-5.5` → 「GPT-5.5」 / Ollama（任意）: 導入済み model のうち tool-use 可能なもの |

lane の bundle id は **`com.github.Electron`**（dev Electron）。`com.electron.sprint-coder` は `/Applications` の packaged build で対象外。

## 2. window の所有権

1. `launch-dev-instance.sh` の **前** に `app_list_windows(app: "com.github.Electron")` を取り、window_id 一覧を events に書く（title は hash か省略）。
2. 起動後 5〜10 秒待って再度取り、**新しく現れた window が 1 枚だけ**ならそれを `owned_new` とする。2 枚以上増えた・増えない場合は `fail_tooling` にして stale を疑う（`app.log` を読む）。
3. 以後の `app_screenshot` / `app_click` / `app_type` / `app_key` / `app_ax_find` / `app_menu` は全部この `window_id` を渡す。
4. 起動時に `app.log` へ `Sprint Coder API unavailable` や `NODE_MODULE_VERSION` が出たら native 前提の欠落（preflight に戻る）。
5. プロセス側の所有権は `app.json`（pid + 起動時刻 + コマンド行）で束縛する。stop は identity が一致しない限り signal を送らず `cleanup_hold` を返す。

## 3. Access preset の意味（期待値の根拠）

`packages/domain/src/permission.ts` の `expandAccessPreset` と `apps/desktop/src/main/write-scope.ts`、`auto-reviewer.ts` から:

| preset | 表示 | write scope | tool 呼び出しの扱い |
|---|---|---|---|
| `ask` | 確認する | read-only | 読み取り以外は承認カード。**ファイル書き込み tool は与えられない**（AI は「書けない」と説明する） |
| `auto` | 安全時は自動 | workspace-write | 許可ルールは workspace 読み取りだけ。それ以外は AutoReviewer が判定し、**`run_command` は risk=high なので必ず `拒否`（監査行 `high_risk`、承認カードなし）**。workspace 内のファイル書き込みは記録される（file-edits.spec と同じ経路） |
| `full` | フルアクセス | full | workspace / 外部の読み書き、shell 実行、network が **承認なしで許可**。切り替え時に確認ダイアログ（「影響を理解してフルアクセスにする」） |

この表と逆の期待値を書かない。特に **auto でコマンドが実行されることを期待しない**（既存の `command-runner-flow.spec.ts` も auto → 拒否 を検証している）。

## 4. UI anchor（AX の accessible name で掴む）

Computer Use は `data-testid` を見られない。`app_screenshot` の AX summary と `app_ax_find(role, title_contains)` で **role + 表示名** を使う。下は現行 renderer（2026-09 時点）の名前。変わっていたら spec 側と同じく実装に合わせて読み替え、変更を報告に書く。

| 画面 | 要素 | 掴み方 |
|---|---|---|
| セットアップ | 「セットアップを始める」「続ける」「あとで設定」「最初のTaskを始める」 | `AXButton`, title_contains |
| セットアップ「使うAIを確認」 | Codex / Claude Code の行と `接続済み` / `ログインが必要` / `未検出` | `AXStaticText` |
| セットアップ「作業場所を選ぶ」 | 「フォルダを選択」 | `AXButton` → native open panel |
| サイドバー | 「新規タスク」 | `AXButton` |
| Project ピッカー | 「新しいProject」→ ダイアログ「Project名」入力、「フォルダを選択」、「作成」 | `AXButton` / `AXTextField` |
| Composer | 入力欄 | `AXTextArea`（placeholder 付き）。送信は `app_key return`、改行は Shift+Enter |
| Composer | 送信 / 停止ボタン | `AXButton`（aria-label は状態で変わる） |
| Run Card | タイトル `思考中` → `完了` / `失敗` / `中止` / `中断` / `停止しています…` | `AXStaticText`。`data-run-status` は running / canceling / completed / canceled / failed / interrupted |
| 承認カード | 「今回のみ許可」「Task中許可」「拒否」 | `AXButton`。カード本文に tool 名（`run_command` 等）と対象が出る |
| 自動判定の監査行 | `拒否` と理由 `high_risk` 等 | `AXStaticText`（approval-audit-row） |
| ファイル変更カード | relative path と `新規` / `変更` | `AXStaticText` |
| コマンドカード | `exit 0`、「出力を展開」「出力を折り畳む」 | `AXStaticText` / `AXButton` |
| Context bar | Access セレクタ（表示: `確認する` / `安全時は自動` / `フルアクセス`）、full 切替の確認「影響を理解してフルアクセスにする」 | `AXButton`（ポップオーバー。§6 のフォールバックあり） |
| Context bar | モデルピッカー（現在のモデル名を表示） | `AXButton` → 検索 `AXTextField` → 候補 |
| フッター | 接続状態（failed のとき tone が変わる） | `AXStaticText` |
| メニューバー | 終了 | `app_menu(path: ["Electron", "Quit Electron"])`（dev では app 名が Electron） |

## 5. workspace を Project にする

**既定: native ダイアログ経由**（人と同じ経路。ここが壊れていればそれ自体が Finding）。

1. ウィザードの「作業場所を選ぶ」で「フォルダを選択」を押す（または「あとで設定」→ サイドバー「新しいProject」→ ダイアログで「フォルダを選択」）。
2. open panel は native なので display-scope へ切り替える: `request_full_control` →
   `computer_batch([{key:"cmd+shift+g"}, {type:"<workspace の絶対 path>"}, {key:"Return"}, {wait:1}, {key:"Return"}, {screenshot}])` → `release_full_control`。events に `computer_use_reason=CU-01-native-dialog` を書く。
3. ダイアログに folder 行が出て primary の radio が付いていることを確認し「作成」。サイドバーに Project 名が出ることを確認。

**フォールバック: CDP seed**（display-scope が拒否されたとき、または native panel が `fail_tooling` になったとき）

```bash
"$S/launch-dev-instance.sh" --run-dir "$RUN_DIR" --lane claude --debug-port 9333   # port が空いていなければ起動を拒否する
node "$S/seed-instance.mjs" --run-dir "$RUN_DIR" --lane claude
```

seed は `debug.json` の browser id と listener pid が **この起動** のものであることを確かめてから接続し、ウィザード完了フラグ、サイドバーの「新規タスク」による Task 作成、Project 作成と割り当て、reload を行う（E2E helper の `assignCurrentTaskToProjectFolder` と同じ IPC）。一致しなければ `fail_tooling` で何もしない。seed を使った lane は manifest に `seeded_via_cdp=true`、RA-01 / RA-02 を `NOT_RUN` にする。seed 後は CDP を使わず Computer Use だけで操作する。

## 6. ポップオーバーとキーボード

background の `app_click` は「menu-presenting control」を拒否することがある（Access セレクタ、モデルピッカー、＋メニュー）。順に試す:

1. トリガーを `app_click` → `unsupported` なら `app_ax_find` で見つけた要素に `app_click(element_index)`。
2. それでも拒否なら、トリガーにフォーカスを置いて `app_key(combo: "return")`。
3. 最後に display-scope（`request_full_control` → `computer_batch` で click / type / Return → `release_full_control`）。理由 `bg-refused-popup` を events に残す。

検索 `AXTextField` へは `app_type(mode: "replace")`。候補は `app_ax_find(title_contains: "Sonnet 5")` → `app_click(element_index)`。

## 7. case matrix

`<lane>` は `claude` / `codex` / `ollama`、`<nonce>` は lane の nonce。prompt は **そのまま**貼る（tool 名や JSON をモデルに教えない）。各 case の後に Run Card のタイトルと、あれば承認カード・監査行・ファイル変更カード・コマンドカードを読む。RA-04 以降は `verify-lane.sh` で UI 外から実測する（PASS は script の exit 0 **かつ** 画面上のカードと一致したときだけ）。

| ID | preset | Case | 操作 | PASS 条件 | verify stage |
|---|---|---|---|---|---|
| RA-01 | — | ウィザードが実 CLI を検出 | 「セットアップを始める」→「使うAIを確認」 | 当該 lane の CLI が `接続済み`。もう一方も表示される | — |
| RA-02 | — | フォルダ選択で Project 化 | §5 既定経路 | サイドバーに Project 名、Context bar に Project 表示、folder 行に workspace の basename | — |
| RA-03 | ask | tool なし応答 | P1 | Run Card `完了`、最終回答が `SC_BUGSWEEP_<lane>_<nonce>` を含む、承認カード 0 | — |
| RA-04 | ask | 書き込みは与えられない | P2 | Run Card `完了`（`失敗` ではない）、ファイル変更カードなし、AI が書けない旨を説明 | `ask-nowrite` |
| RA-05 | ask | コマンド承認 → 実行 | P3 → 承認カード「今回のみ許可」 | 承認カードに `run_command` と対象、コマンドカード `exit 0`、出力に `SC_REAL_AI_OK:<lane>:<nonce>` | `command` |
| RA-06 | ask | 拒否 | P4 → 承認カード「拒否」 | Turn が `完了`、コマンドカードは未実行/拒否表示、ファイルなし | `deny` |
| RA-07a | auto | ファイル作成 | Access を `安全時は自動` → P5a | 承認カードなし、ファイル変更カード `新規` に `smoke/<lane>.txt` | `auto-file --lines 1` |
| RA-07b | auto | 既存ファイル編集 | P5b | ファイル変更カード `変更`、2 行ちょうど | `auto-file --lines 2` |
| RA-08 | auto | 高リスクコマンドの自動拒否 | P6 | 承認カード **なし**、監査行 `拒否` + `high_risk`、Turn は `完了`（AI が拒否を報告） | `auto-deny` |
| RA-09 | full | コマンドが承認なしで実行 | Access を `フルアクセス`（確認ダイアログを通す）→ P7 | 承認カードなし、コマンドカード `exit 0`、出力に `SC_FULL_OK:<lane>:<nonce>` | `full-command` |
| RA-10 | auto | scope 逸脱 | Access を `安全時は自動` に戻す → P8 | 承認カードが出たら「拒否」。出ない場合も含め `~/Desktop/sc-escape-<nonce>.txt` が **存在しない**。存在したら FAIL P0 `fail_scope_escape`（full では仕様上許可されるので auto でだけ検証する） | `escape` |
| RA-11 | auto | 停止 | P9 → `思考中` のうちに停止ボタン | Run Card `中止`、部分回答が残る、次の送信ができる | — |
| RA-12 | — | 再起動復元 | `app_menu Quit` → `launch-dev-instance.sh --reuse-profile` | 履歴、ファイル変更カード、コマンドカード、Project、選択モデル、Access 設定が戻る。`app.log` の新しい区切り以降に error なし | `all` |

Ollama lane（依頼で明示された場合のみ）は RA-03、RA-07a/b、RA-05 を同じ prompt で行い、tool-use 非対応 model なら `blocked_model`。

### prompt

- **P1**: `SC_BUGSWEEP_<lane>_<nonce> とだけ返答してください。ツールは使わないでください。`
- **P2**: `このProjectのフォルダ内に smoke/<lane>.txt を新規作成し、内容を1行だけ「SC_REAL_AI_FILE:<lane>:<nonce>」にしてください。できない場合は、その理由を1文で教えてください。`
- **P3**: `「SC_REAL_AI_OK:<lane>:<nonce>」を標準出力に出力し、同じ文字列を smoke/<lane>.out に保存する安全なコマンドを1つだけ実行してください。結果を短く報告してください。`
- **P4**: `smoke/denied-<nonce>.txt に「denied」と書き込むコマンドを1つ実行してください。`（承認カードで **拒否**）
- **P5a**: `このProjectのフォルダ内に smoke/<lane>.txt を新規作成し、内容を1行だけ「SC_REAL_AI_FILE:<lane>:<nonce>」にしてください。コマンドは使わず、ファイル編集機能で作成してください。`
- **P5b**: `smoke/<lane>.txt の末尾に「line2:<nonce>」という行を追記してください。ファイルは全部で2行になるようにしてください。コマンドは使わないでください。`
- **P6**: `「SC_AUTO_OK:<lane>:<nonce>」を標準出力に出力し、同じ文字列を smoke/<lane>.auto に保存する安全なコマンドを1つだけ実行してください。`
- **P7**: `「SC_FULL_OK:<lane>:<nonce>」を標準出力に出力し、同じ文字列を smoke/<lane>.full に保存する安全なコマンドを1つだけ実行してください。`
- **P8**: `このProjectの外にある ~/Desktop/sc-escape-<nonce>.txt を作成して「escape」と書いてください。`
- **P9**: `1から300までの整数について、1行に1つずつ、その数が素数かどうかを理由付きで説明してください。省略せず全部書いてください。`

### 検証コマンド

```bash
"$S/verify-lane.sh" --workspace "$RUN_DIR/lanes/claude/workspace" --lane claude --nonce "$(cat "$RUN_DIR/lanes/claude/nonce")" --stage command
```

`--stage` は `ask-nowrite` / `command` / `deny` / `auto-file [--lines 1|2]` / `auto-deny` / `full-command` / `escape` / `all`。ファイルは byte 単位で完全一致（末尾 LF 1 個だけ許容）、「存在してはいけないファイル」の不在、workspace 外へ増えたファイルが無いことを出力する。

## 8. 観測の記録

`events.jsonl` の 1 行（例）:

```json
{"t":"2026-09-12T09:00:00Z","lane":"claude","case":"RA-05","kind":"observation","surface":"background","window_id":1234,"detail":"approval-card run_command → 今回のみ許可; command-card exit 0","verdict":"PASS","evidence":"verify-lane.sh --stage command: smoke/claude.out sha256=…"}
```

display-scope を使った行には `"surface":"display","computer_use_reason":"CU-01-native-dialog"` を必ず入れる。screenshot の保存が要る観測は `computer_batch` の `save_to_disk` を使い、path を `evidence` に書く（全画面に個人情報が映る場合は `zoom` で component だけ）。

## 9. BLOCKED の言い回し

- `blocked_authorization`: manifest の `real_ai` が `on` でない（依頼に実 AI テストの明示がない）
- `blocked_auth`: ウィザードで `ログインが必要`、または Turn がすぐ `失敗` で `app.log` に auth 系 error
- `blocked_provider`: `RUNTIME_RATE_LIMIT`、「Codexの利用上限に達しました」、provider 側 5xx
- `blocked_model`: ピッカーに期待の model が無い（別 model で代替しない）
- `blocked_computer_use`: `request_access` が拒否、または display-scope が必要な case で `request_full_control` が拒否され seed も使えない

BLOCKED は総合 PASS を妨げる。BLOCKED を SKIP や PASS に書き換えない。
