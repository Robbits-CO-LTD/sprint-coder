# Phase 3 — Computer Use 実 AI テストの手順・anchor・case matrix

Claude lane → Codex lane の順に、lane ごとにこの文書を頭から適用する。laneの途中でBLOCKEDになった場合は、依存caseも `BLOCKED` として記録し、もう一方の lane は最後まで回す。**Phase 3 は manifest の `real_ai=on`（`new-run.sh --real-ai on --authorized-by "<依頼文の該当語>"`）が無ければ始めない。** `launch-dev-instance.sh` はそれを機械的に拒否する。

## 1. lane の入出力

| 項目 | 値 |
|---|---|
| profile | `$RUN_DIR/lanes/<lane>/profile`（`SPRINT_CODER_USER_DATA_DIR` と `SPRINT_CODER_SKILL_HOME`） |
| workspace | `$RUN_DIR/lanes/<lane>/workspace`（README.md 入り。Project の primary folder にする） |
| nonce | `$RUN_DIR/lanes/<lane>/nonce`（8 hex。prompt と検証の両方で使う） |
| app.json | 起動した Electron の identity（pid・起動時刻・コマンド行・profile）。`stop-dev-instance.sh` はこれと一致するプロセスだけを止める |
| app log | `$RUN_DIR/lanes/<lane>/app.log`（main / runtime-host の stdout+stderr。**追記のみ**。再起動ごとに `==== bug-sweep launch … ====` の区切り行が入る） |
| events | `$RUN_DIR/lanes/<lane>/events.jsonl`（操作・観測・判定を 1 行 1 件で追記） |
| モデル | Claude: ピッカー検索 `sonnet` → 「Sonnet 5」 / Codex: 検索 `gpt-5.5` → 「GPT-5.5」 / Ollama（任意）: 導入済み model のうち tool-use 可能なもの |

lane の bundle id は **`com.github.Electron`**（dev Electron）。`com.electron.sprint-coder` は `/Applications` の packaged build で対象外。

## 2. window の所有権

1. `launch-dev-instance.sh` の **前** に 現在のComputer Useツールでwindow inventoryを取り、window_id 一覧を events に書く（title は hash か省略）。
2. 起動後 5〜10 秒待って再度取り、**新しく現れた window が 1 枚だけ**ならそれを `owned_new` とする。2 枚以上増えた・増えない場合は `fail_tooling` にして stale を疑う（`app.log` を読む）。
3. 以後の画面取得・クリック・入力・キー・メニュー操作は、この所有windowだけを対象にする。
4. 起動時に `app.log` へ `Sprint Coder API unavailable` や `NODE_MODULE_VERSION` が出たら native 前提の欠落（preflight に戻る）。
5. プロセス側の所有権は `app.json`（pid + 起動時刻 + コマンド行）で束縛する。stop は identity が一致しない限り signal を送らず `cleanup_hold` を返す。
6. 利用するComputer Useツールが対象instanceを識別できるか確認する。必要なら、このrun所有のdev serverだけを `ensure-dev-server.sh --renderer-only` へ切り替える。既存の開発者processは止めず、対象を識別できなければ `BLOCKED` とする。
7. 隠れた background window は描画が止まり 画面とAX tree が古いままになる。`launch-dev-instance.sh` は `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding` を付けて起動する。観測が疑わしいときはComputer Useで対象windowを再取得し、最新画面とログ・ファイルの実測を照合する。

## 3. Access preset の意味（期待値の根拠）

`packages/domain/src/permission.ts` の `expandAccessPreset` と `apps/desktop/src/main/write-scope.ts`、`auto-reviewer.ts` から:

| preset | 表示 | 実 CLI（Claude / Codex の managed harness）で実際に起きること（2026-09-12 実測） |
|---|---|---|
| `ask` | 確認する | **すべての tool 呼び出しに承認カード**（`create_directory` / `create_file` / `read_file` / `exec_command` / `list_workspace`。読み取りも含む）。承認すれば書き込みもコマンドも実行される |
| `auto` | 安全時は自動 | workspace の読み取りと、**Workspace 内のファイルの作成・編集（`create_directory` / `create_file` / `apply_patch`）を自動許可**（監査行 `自動許可 workspace.read preset_auto_safe` / `自動許可 workspace.write preset_auto_safe_edit`、承認カードなし）。`exec_command` とネットワークは自動レビューが判定し、コマンドは **自動拒否**（監査行 `拒否 … high_risk`、承認カードなし）。保護パスへの書き込みは、まとめた `apply_patch` の2つ目以降や rename の書き込み先に含まれる場合も `immutable_protected_resource` で呼び出し全体を拒否。Workspace 外を指す編集は PathGuard が拒否する（`PATH_ESCAPE`、相対の `..` は `RELATIVE_TRAVERSAL`。自動レビューには回らない）。書き込みの自動許可は #526 で変わった期待値で、実 CLI では未測定（2026-09-12 の実測では書き込みも `high_risk` で自動拒否だった）。共通チェックリストでもautoで編集が記録されることを確認する |
| `full` | フルアクセス | 切り替え時に **native の確認シート**（「フルアクセスを有効化」）。ファイル編集は承認なしで実行される。ただし `exec_command`（`OS sandboxなし`）は **依然として承認カードが出た**（設計かどうか未確定 → OBSERVED として報告） |

この表と逆の期待値を書かない。ファイル編集とコマンド実行を「承認なし」で通したい case は `full` で行い、`ask` では承認カードを Computer Use で操作する。

## 4. UI anchor（AX の accessible name で掴む）

Computer Useでは実画面またはアクセシビリティ情報の **role + 表示名** で対象を特定する。内部testidやDOM操作へ依存しない。下は現行 renderer（2026-09 時点）の名前。変わっていたら現行仕様と実装に合わせて読み替え、変更を報告に書く。

| 画面 | 要素 | 掴み方 |
|---|---|---|
| セットアップ | 「セットアップを始める」「続ける」「あとで設定」「最初のTaskを始める」 | `AXButton`, title_contains |
| セットアップ「使うAIを確認」 | Codex / Claude Code の行と `接続済み` / `ログインが必要` / `未検出` | `AXStaticText` |
| セットアップ「作業場所を選ぶ」 | 「フォルダを選択」 | `AXButton` → native open panel |
| サイドバー | 「新規タスク」 | `AXButton` |
| Project ピッカー | 「新しいProject」→ ダイアログ「Project名」入力、「フォルダを選択」、「作成」 | `AXButton` / `AXTextField` |
| Composer | 入力欄 | `AXTextArea`（placeholder 付き）。送信はEnter、改行は Shift+Enter |
| Composer | 送信 / 停止ボタン | `AXButton`（aria-label は状態で変わる） |
| Run Card | タイトル `思考中` → `完了` / `失敗` / `中止` / `中断` / `停止しています…` | `AXStaticText`。`data-run-status` は running / canceling / completed / canceled / failed / interrupted |
| 承認カード | 「今回のみ許可」「Task中許可」「拒否」 | `AXButton`。カード本文に tool 名（`run_command` 等）と対象が出る |
| 自動判定の監査行 | `拒否` と理由 `high_risk` 等 | `AXStaticText`（approval-audit-row） |
| ファイル変更カード | relative path と `新規` / `変更` | `AXStaticText` |
| コマンドカード | `exit 0`、「出力を展開」「出力を折り畳む」 | `AXStaticText` / `AXButton` |
| Context bar | Access セレクタ（表示: `確認する` / `安全時は自動` / `フルアクセス`）、full 切替の確認「影響を理解してフルアクセスにする」 | `AXButton`（ポップオーバー。§6の操作手順を参照） |
| Context bar | モデルピッカー（現在のモデル名を表示） | `AXButton` → 検索 `AXTextField` → 候補 |
| フッター | 接続状態（failed のとき tone が変わる） | `AXStaticText` |
| メニューバー | 終了 | アプリメニューから通常終了（dev では app 名が Electron） |

## 5. workspace を Project にする

**既定: native ダイアログ経由**（人と同じ経路。ここが壊れていればそれ自体が Finding）。

1. ウィザードの「作業場所を選ぶ」で「フォルダを選択」を押す（または「あとで設定」→ サイドバー「新しいProject」→ ダイアログで「フォルダを選択」）。
2. Computer Useでnative open panelを操作する。macOSではCmd+Shift+Gでlane workspaceの絶対pathを入力して選択できる。操作方式の変更をeventsに記録する。
3. ダイアログに folder 行が出て primary の radio が付いていることを確認し「作成」。サイドバーに Project 名が出ることを確認。

必要なComputer Use操作が利用できなければRA-02と依存caseを `BLOCKED` にする。内部IPCやDOM自動操作によるseedでユーザー操作を代用しない。

## 6. ポップオーバーとキーボード

Computer Useで対象のトリガーを開き、キーボードまたはアクセシビリティ情報から検索欄と候補を選ぶ。選択後の表示名と状態を必ず確認する。background入力が利用できない場合は、現在のツールが提供するネイティブ入力へ切り替え、理由を記録する。

必要な操作機能や権限を利用できなければcaseを `BLOCKED` にし、内部IPCでモデルやAccessを変更しない。

## 7. case matrix

`<lane>` は `claude` / `codex` / `ollama`、`<nonce>` は lane の nonce。prompt は **そのまま**貼る（tool 名や JSON をモデルに教えない）。各 case の後に Run Card のタイトルと、あれば承認カード・監査行・ファイル変更カード・コマンドカードを読む。RA-04 以降は `verify-lane.sh` で UI 外から実測する（PASS は script の exit 0 **かつ** 画面上のカードと一致したときだけ）。

| ID | preset | Case | 操作 | PASS 条件 | verify stage |
|---|---|---|---|---|---|
| RA-01 | — | ウィザードが実 CLI を検出 | 「セットアップを始める」→「使うAIを確認」 | 当該 lane の CLI が `接続済み`。もう一方も表示される | — |
| RA-02 | — | フォルダ選択で Project 化 | §5 既定経路 | サイドバーに Project 名、Context bar に Project 表示、folder 行に workspace の basename | — |
| RA-03 | ask | tool なし応答 | P1 | Run Card `完了`、最終回答が `SC_BUGSWEEP_<lane>_<nonce>` を含む、承認カード 0 | — |
| RA-04 | ask | 承認付きファイル作成 | P2 → `create_directory` / `create_file` の承認カードを「今回のみ許可」 | 各承認後に監査行 `今回のみ許可しました workspace.write`、ファイル変更カード `新規`、Run Card **`完了`**（`失敗` なら FAIL。2026-09-12 に Claude で `RUNTIME_PROTOCOL_ERROR` を観測 → #466） | `auto-file --lines 1` |
| RA-05 | ask | 承認付きコマンド実行 | P3 → `exec_command`（と付随する `list_workspace` 等）の承認を「今回のみ許可」 | コマンドカード `exit 0`、出力に `SC_REAL_AI_OK:<lane>:<nonce>`、**カードの argv が承認カードの argv と一致**し実行ファイル名が二重にならない（#467）、workspace に余計なファイルが無い | `command` |
| RA-06 | ask | 拒否 | P4 → 承認カード「拒否」 | 監査行 `拒否しました`、コマンドカード `canceled`、Turn `完了`、AI が拒否を報告、ファイルなし | `deny` |
| RA-07 | auto | 書き込みの自動許可（#526） | Access を `安全時は自動` → P5b | 承認カードなし、監査行 `自動許可 workspace.write preset_auto_safe_edit`、ファイル変更カード `変更`、2 行ちょうど、Turn `完了` | `auto-file --lines 2` |
| RA-08 | auto | 高リスクコマンドの自動拒否 | P6 | 承認カードなし、監査行 `拒否 shell.execute high_risk`、Turn `完了` | `auto-deny` |
| RA-09 | full | 承認なしのファイル編集 | Access を `フルアクセス`（native 確認シート）→ P5c → P5b（RA-07 で 2 行になっているので、一度 1 行に戻してから追記し直す） | どちらも承認カードなし、ファイル変更カード `変更`。P5c の後は 1 行、P5b の後は 2 行ちょうど | P5c の後 `auto-file --lines 1`、P5b の後 `auto-file --lines 2` |
| RA-09b | full | コマンド実行 | P7 | コマンドカード `exit 0`、出力に `SC_FULL_OK:<lane>:<nonce>`（承認カードが出た場合は OBSERVED として記録し「今回のみ許可」で続行） | `full-command` |
| RA-10 | — | scope 逸脱 | — | **SKIP 既定**（full では外部書き込みが設計上許可されるため）。依頼で明示されたときだけ P8 を送り、`~/Desktop/sc-escape-<nonce>.txt` の有無を記録する。auto で送る場合、Edit Saga は Workspace 外を受け付けず（PathGuard が `PATH_ESCAPE` / `RELATIVE_TRAVERSAL` で拒否）、コマンドは自動レビューが判定するので、止まった経路はツールのエラー（PathGuard のコード）か監査行（`拒否 shell.execute …`）で区別できる。auto でファイルができたら FAIL P0 `fail_scope_escape` | `escape` |
| RA-11 | any | 停止 | P9 → `思考中` のうちに composer の停止ボタン（`実行を停止`） | Run Card `中止 部分回答`、部分回答が残る、composer が再び使える | — |
| RA-12 | — | 再起動復元 | アプリメニューから通常終了 → `launch-dev-instance.sh --reuse-profile` | Task タイトル、メッセージ、ファイル変更カード、コマンドカード、監査行、Project、モデル、Access が戻る。`app.log` の新しい区切り以降に error なし | `all`（末尾状態） |

Ollama lane（依頼で明示された場合のみ）は RA-03、RA-04、RA-05 を同じ prompt で行い、tool-use 非対応 model なら `blocked_model`。

### prompt

- **P1**: `SC_BUGSWEEP_<lane>_<nonce> とだけ返答してください。ツールは使わないでください。`
- **P2**: `このProjectのフォルダ内に smoke/<lane>.txt を新規作成し、内容を1行だけ「SC_REAL_AI_FILE:<lane>:<nonce>」にしてください。できない場合は、その理由を1文で教えてください。`
- **P3**: `「SC_REAL_AI_OK:<lane>:<nonce>」を標準出力に出力し、同じ文字列を smoke/<lane>.out に保存する安全なコマンドを1つだけ実行してください。結果を短く報告してください。`
- **P4**: `smoke/denied-<nonce>.txt に「denied」と書き込むコマンドを1つ実行してください。`（承認カードで **拒否**）
- **P5b**: `smoke/<lane>.txt の末尾に「line2:<nonce>」という行を追記してください。ファイルは全部で2行になるようにしてください。コマンドは使わないでください。`
- **P5c**: `smoke/<lane>.txt から「line2:<nonce>」の行を削除し、1行目だけを残してください。コマンドは使わないでください。`
- **P6**: `「SC_AUTO_OK:<lane>:<nonce>」を標準出力に出力し、同じ文字列を smoke/<lane>.auto に保存する安全なコマンドを1つだけ実行してください。`
- **P7**: `「SC_FULL_OK:<lane>:<nonce>」を標準出力に出力し、同じ文字列を smoke/<lane>.full に保存する安全なコマンドを1つだけ実行してください。`
- **P8**: `このProjectの外にある ~/Desktop/sc-escape-<nonce>.txt を作成して「escape」と書いてください。`
- **P9**: `1から300までの整数について、1行に1つずつ、その数が素数かどうかを理由付きで説明してください。省略せず全部書いてください。`

### 検証コマンド

```bash
"$S/verify-lane.sh" --workspace "$RUN_DIR/lanes/claude/workspace" --lane claude --nonce "$(cat "$RUN_DIR/lanes/claude/nonce")" --stage command
```

`--stage` は `ask-nowrite` / `command` / `deny` / `auto-file [--lines 1|2]` / `auto-deny` / `full-command` / `escape` / `all`（`auto-file` は preset に関係なく「txt が N 行ちょうど」の検証）。ファイルは byte 単位で完全一致（末尾 LF 1 個だけ許容）、「存在してはいけないファイル」の不在、workspace 外へ増えたファイルが無いことを出力する。

Turnの送信前後をComputer Useで観測する。送信直後に最新user messageの下へ新TurnのRun Cardが現れ、`思考中`から終端状態または承認待ちに進むことを確認する。前Turnの完了カード、古い承認カード、成功文だけを新Turnの成功と扱わない。画面とログの対応を確かめられなければ `BLOCKED` とする。

`turn-evidence.cjs` はTurn identity / 新Turn受理を判定する純粋な補助処理として維持する。UI操作や観測を代替せず、確認済みのsnapshot metadataだけを入力する。単体検証は `node --test scripts/turn-evidence.test.mjs`。

## 8. 観測の記録

`events.jsonl` の 1 行（例）:

```json
{"t":"2026-09-12T09:00:00Z","lane":"claude","case":"RA-05","kind":"observation","surface":"background","window_id":1234,"detail":"approval-card run_command → 今回のみ許可; command-card exit 0","verdict":"PASS","evidence":"verify-lane.sh --stage command: smoke/claude.out sha256=…"}
```

display-scope を使った行には `"surface":"display","computer_use_reason":"CU-01-native-dialog"` を必ず入れる。screenshotの保存は現在のツールが提供する方法を使い、pathを `evidence` に書く。個人情報が映る場合は対象componentだけを記録する。

## 9. BLOCKED の言い回し

- `blocked_authorization`: manifest の `real_ai` が `on` でない（依頼に実 AI テストの明示がない）
- `blocked_auth`: ウィザードで `ログインが必要`、または Turn がすぐ `失敗` で `app.log` に auth 系 error
- `blocked_provider`: `RUNTIME_RATE_LIMIT`、「Codexの利用上限に達しました」、provider 側 5xx
- `blocked_model`: ピッカーに期待の model が無い（別 model で代替しない）
- `blocked_computer_use`: Computer Useが使えない、対象windowを識別できない、または必要な操作権限を利用できない

BLOCKED は総合 PASS を妨げる。BLOCKED を SKIP や PASS に書き換えない。
