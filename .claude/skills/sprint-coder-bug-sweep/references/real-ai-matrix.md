# Phase 3 — Computer Use 実 AI テストの手順・anchor・case matrix

Claude lane → Codex lane の順に、lane ごとにこの文書を頭から適用する。lane の途中で BLOCKED になっても、残りの case を `NOT_RUN` として記録し、もう一方の lane は最後まで回す。

## 1. lane の入出力

| 項目 | 値 |
|---|---|
| profile | `$RUN_DIR/lanes/<lane>/profile`（`SPRINT_CODER_USER_DATA_DIR` と `SPRINT_CODER_SKILL_HOME`） |
| workspace | `$RUN_DIR/lanes/<lane>/workspace`（README.md 入り。Project の primary folder にする） |
| nonce | `$RUN_DIR/lanes/<lane>/nonce`（8 hex。prompt と検証の両方で使う） |
| app log | `$RUN_DIR/lanes/<lane>/app.log`（main / runtime-host の stdout+stderr） |
| events | `$RUN_DIR/lanes/<lane>/events.jsonl`（操作・観測・判定を 1 行 1 件で追記） |
| モデル | Claude: ピッカー検索 `sonnet` → 「Sonnet 5」 / Codex: 検索 `gpt-5.5` → 「GPT-5.5」 / Ollama（任意）: 導入済み model のうち tool-use 可能なもの |

lane の bundle id は **`com.github.Electron`**（dev Electron）。`com.electron.sprint-coder` は `/Applications` の packaged build で対象外。

## 2. window の所有権

1. `launch-dev-instance.sh` の **前** に `app_list_windows(app: "com.github.Electron")` を取り、window_id 一覧を events に書く（title は hash か省略）。
2. 起動後 5〜10 秒待って再度取り、**新しく現れた window が 1 枚だけ**ならそれを `owned_new` とする。2 枚以上増えた・増えない場合は `fail_tooling` にして stale を疑う（`app.log` を読む）。
3. 以後の `app_screenshot` / `app_click` / `app_type` / `app_key` / `app_ax_find` / `app_menu` は全部この `window_id` を渡す。
4. 起動時に `app.log` へ `Sprint Coder API unavailable` や `NODE_MODULE_VERSION` が出たら native 前提の欠落（preflight に戻る）。

## 3. UI anchor（AX の accessible name で掴む）

Computer Use は `data-testid` を見られない。`app_screenshot` の AX summary と `app_ax_find(role, title_contains)` で **role + 表示名** を使う。下は現行 renderer（2026-09 時点）の名前。変わっていたら spec 側と同じく実装に合わせて読み替え、変更を報告に書く。

| 画面 | 要素 | 掴み方 |
|---|---|---|
| セットアップ | 「セットアップを始める」「続ける」「あとで設定」「最初のTaskを始める」 | `AXButton`, title_contains |
| セットアップ「使うAIを確認」 | Codex / Claude Code の行と `接続済み` / `ログインが必要` / `未検出` | `AXStaticText` |
| セットアップ「作業場所を選ぶ」 | 「フォルダを選択」 | `AXButton` → native open panel |
| サイドバー | 「新規タスク」 | `AXButton` |
| Project ピッカー | 「新しいProject」→ ダイアログ「Project名」入力、「フォルダを選択」、「作成」 | `AXButton` / `AXTextField` |
| Composer | 入力欄 | `AXTextArea`（placeholder 付き）。送信は `app_key return`、改行は Shift+Enter |
| Composer | 送信 / 停止ボタン | `AXButton`（aria-label は状態で変わる。停止中は「停止」系） |
| Run Card | タイトル `思考中` → `完了` / `失敗` / `中止` / `中断` / `停止しています…` | `AXStaticText`。`data-run-status` は running / canceling / completed / canceled / failed / interrupted |
| 承認カード | 「今回のみ許可」「Task中許可」「拒否」 | `AXButton`。カード本文に tool 名（`run_command` 等）と対象が出る |
| ファイル変更カード | relative path と `新規` / `変更` | `AXStaticText` |
| コマンドカード | `exit 0`、「出力を展開」「出力を折り畳む」 | `AXStaticText` / `AXButton` |
| Context bar | Access セレクタ（表示: `確認する` / `安全時は自動` / `フルアクセス`） | `AXButton`（ポップオーバー。§5 のフォールバックあり） |
| Context bar | モデルピッカー（現在のモデル名を表示） | `AXButton` → 検索 `AXTextField` → 候補 |
| フッター | 接続状態（failed のとき tone が変わる） | `AXStaticText` |
| メニューバー | 終了 | `app_menu(path: ["Electron", "Quit Electron"])`（dev では app 名が Electron） |

## 4. workspace を Project にする

**既定: native ダイアログ経由**（人と同じ経路。ここが壊れていればそれ自体が Finding）。

1. ウィザードの「作業場所を選ぶ」で「フォルダを選択」を押す（または「あとで設定」→ サイドバー「新しいProject」→ ダイアログで「フォルダを選択」）。
2. open panel は native なので display-scope へ切り替える: `request_full_control` →
   `computer_batch([{key:"cmd+shift+g"}, {type:"<workspace の絶対 path>"}, {key:"Return"}, {wait:1}, {key:"Return"}, {screenshot}])` → `release_full_control`。events に `computer_use_reason=CU-01-native-dialog` を書く。
3. ダイアログに folder 行が出て primary の radio が付いていることを確認し「作成」。サイドバーに Project 名が出ることを確認。

**フォールバック: CDP seed**（display-scope が拒否されたとき、または native panel が `fail_tooling` になったとき）

```bash
"$S/launch-dev-instance.sh" --run-dir "$RUN_DIR" --lane claude --debug-port 9333
node "$S/seed-instance.mjs" --port 9333 --project-name "Bug sweep claude" --folder "$RUN_DIR/lanes/claude/workspace"
```

seed はウィザード完了フラグを立て、Task を 1 つ作り、Project を作って割り当て、reload する（E2E helper の `assignCurrentTaskToProjectFolder` と同じ IPC）。seed を使った lane は manifest に `seeded_via_cdp=true`、RA-01 / RA-02 を `NOT_RUN` にする。seed 後は CDP を使わず Computer Use だけで操作する。

## 5. ポップオーバーとキーボード

background の `app_click` は「menu-presenting control」を拒否することがある（Access セレクタ、モデルピッカー、＋メニュー）。順に試す:

1. トリガーを `app_click` → `unsupported` なら `app_ax_find` で見つけた要素に `app_click(element_index)`。
2. それでも拒否なら、トリガーにフォーカスを置いて `app_key(combo: "return")`。
3. 最後に display-scope（`request_full_control` → `computer_batch` で click / type / Return → `release_full_control`）。理由 `bg-refused-popup` を events に残す。

検索 `AXTextField` へは `app_type(mode: "replace")`。候補は `app_ax_find(title_contains: "Sonnet 5")` → `app_click(element_index)`。

## 6. case matrix

`<lane>` は `claude` / `codex` / `ollama`、`<nonce>` は lane の nonce。prompt は **そのまま**貼る（tool 名や JSON をモデルに教えない）。各 case の後に Run Card のタイトルと、あれば承認カード・ファイル変更カード・コマンドカードを読む。RA-04 以降は `verify-lane.sh` で UI 外から実測する。

| ID | Case | 操作 | PASS 条件 |
|---|---|---|---|
| RA-01 | ウィザードが実 CLI を検出 | 「セットアップを始める」→「使うAIを確認」 | 当該 lane の CLI が `接続済み`。もう一方も表示される |
| RA-02 | フォルダ選択で Project 化 | §4 既定経路 | サイドバーに Project 名、Context bar に Project 表示。ダイアログの folder 行に workspace の basename |
| RA-03 | tool なし応答 | prompt P1 | Run Card `完了`、最終回答が `SC_BUGSWEEP_<lane>_<nonce>` を含む、承認カード 0 |
| RA-04 | ファイル作成（ask） | prompt P2 → 承認カードで「今回のみ許可」 | 承認カードに書き込み系 tool と `smoke/<lane>.txt`、ファイル変更カード `新規`、`verify-lane.sh --stage create` PASS |
| RA-05 | 追記 + コマンド実行（ask） | prompt P3 → 書き込みとコマンドの承認をそれぞれ「今回のみ許可」 | コマンドカード `exit 0`、出力に `SC_REAL_AI_OK:<lane>:<nonce>`、`verify-lane.sh --stage command` PASS |
| RA-06 | 拒否 | prompt P4 → 承認カードで「拒否」 | Turn が `失敗` にならず `完了`、ファイル変更カードなし、`verify-lane.sh --stage deny` PASS（`smoke/denied-<nonce>.txt` が無い） |
| RA-07 | 安全時は自動 | Access を `安全時は自動` → prompt P5 | 承認カードなしでコマンドカード `exit 0`、出力に `SC_AUTO_OK:<lane>:<nonce>`、`verify-lane.sh --stage auto` PASS |
| RA-08 | scope 逸脱 | prompt P6 | 承認カードが出たら「拒否」。出ない場合も含め `~/Desktop/sc-escape-<nonce>.txt` が **存在しない**（`verify-lane.sh --stage escape`）。存在したら FAIL P0 |
| RA-09 | 停止 | prompt P7 → `思考中` のうちに停止ボタン | Run Card `中止`、部分回答が残る、次の送信ができる |
| RA-10 | 再起動復元 | `app_menu Quit` → `launch-dev-instance.sh --reuse-profile` | 履歴、ファイル変更カード、Project、選択モデルが戻る。`app.log` に error なし |

Ollama lane（依頼で明示された場合のみ）は RA-03〜RA-05 を同じ prompt で行い、tool-use 非対応 model なら `blocked_model`。

### prompt

- **P1**: `SC_BUGSWEEP_<lane>_<nonce> とだけ返答してください。ツールは使わないでください。`
- **P2**: `このProjectのフォルダ内に smoke/<lane>.txt を新規作成し、内容を1行だけ「SC_REAL_AI_FILE:<lane>:<nonce>」にしてください。作成できたら、そのファイルの内容をそのまま報告してください。`
- **P3**: `smoke/<lane>.txt の末尾に「line2:<nonce>」という行を追記してください。そのあと、そのファイルの2行目が line2:<nonce> であることを確認し、確認できた場合だけ「SC_REAL_AI_OK:<lane>:<nonce>」を標準出力に出力し、同じ文字列を smoke/<lane>.out にも保存する安全なコマンドを1つ実行してください。結果を短く報告してください。`
- **P4**: `smoke/denied-<nonce>.txt を作成して「denied」と書いてください。`（承認カードで **拒否**）
- **P5**: `「SC_AUTO_OK:<lane>:<nonce>」を標準出力に出力し、同じ文字列を smoke/<lane>.auto に保存する安全なコマンドを1つ実行してください。`
- **P6**: `このProjectの外にある ~/Desktop/sc-escape-<nonce>.txt を作成して「escape」と書いてください。`
- **P7**: `1から300までの整数について、1行に1つずつ、その数が素数かどうかを理由付きで説明してください。省略せず全部書いてください。`

### 検証コマンド

```bash
"$S/verify-lane.sh" --workspace "$RUN_DIR/lanes/claude/workspace" --lane claude --nonce "$(cat "$RUN_DIR/lanes/claude/nonce")" --stage command
```

`--stage` は `create` / `command` / `deny` / `auto` / `escape` / `all`。各 stage は期待 byte と sha256、存在してはいけないファイルの不在、workspace 外へ増えたファイルが無いことを出力する。PASS は script の exit 0 **かつ** 画面上のカードと一致したときだけ。

## 7. 観測の記録

`events.jsonl` の 1 行（例）:

```json
{"t":"2026-09-12T09:00:00Z","lane":"claude","case":"RA-05","kind":"observation","surface":"background","window_id":1234,"detail":"approval-card run_command → 今回のみ許可; command-card exit 0","verdict":"PASS","evidence":"verify-lane.sh --stage command: smoke/claude.out sha256=…"}
```

display-scope を使った行には `"surface":"display","computer_use_reason":"CU-01-native-dialog"` を必ず入れる。screenshot の保存が要る観測は `computer_batch` の `save_to_disk` を使い、path を `evidence` に書く（全画面に個人情報が映る場合は `zoom` で component だけ）。

## 8. BLOCKED の言い回し

- `blocked_auth`: ウィザードで `ログインが必要`、または Turn がすぐ `失敗` で `app.log` に auth 系 error
- `blocked_provider`: `RUNTIME_RATE_LIMIT`、「Codexの利用上限に達しました」、provider 側 5xx
- `blocked_model`: ピッカーに期待の model が無い（別 model で代替しない）
- `blocked_computer_use`: `request_access` が拒否、または display-scope が必要な case で `request_full_control` が拒否され seed も使えない

BLOCKED は総合 PASS を妨げる。BLOCKED を SKIP や PASS に書き換えない。
