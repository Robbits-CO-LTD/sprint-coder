# macOS のデスクトップ操作: 実 AI の操作試験（2026-11-16）

Sprint Coder の中の実 AI に、macOS のアプリをデスクトップ操作で操作させた記録。開発エージェントの代行や、実行ファイルを直接動かした結果は、ここには数えていない。

## 環境

| 項目 | 値 |
| --- | --- |
| OS | macOS 27.0.1（26A434）、Apple シリコン |
| アプリ | 開発版（`electron-forge` の dev bundle）。段階 2 の commit `12ba8b46`（A〜D）と、レビュー指摘の修正後の `298031b7`（E） |
| 実行ファイル | `sprint-coder-desktop-control`（agent-desktop 1.2.0、段階 1 の `ce6a5185` から build。SHA-256 `0e408f2f…da754e`） |
| 起動 | `open -n -g -a <repo>/node_modules/electron/dist/Electron.app --args … apps/desktop`。LaunchServices 経由で起動し、開発版の Electron が持つアクセシビリティと画面収録の許可を使う。シェルから直接起動した場合は許可が付かない |
| profile | 試験専用の `SPRINT_CODER_USER_DATA_DIR`（新規）。利用者の profile には触れていない |
| AI | Codex CLI（runtime `codex`、要求モデル `auto`）。実際に解決されたモデルの ID は、アプリの記録に残っていない |
| 権限 | 「確認する」。承認カードは、試験の担当（開発エージェント）が押した |
| 対象 | テキストエディット（試験用の書類 `ad-test-doc.txt`）、計算機 |

準備で、試験の経路の外の手段を 1 つ使った。Project の作成は、アプリ自身の `projects.create` を local の debugging port から呼んだ（macOS 標準のフォルダーの選択画面は、裏からは操作できないため）。この port は、その後は画面の文字の読み取りだけに使った。

## 結果

| # | 内容 | 結果 |
| --- | --- | --- |
| A | テキストエディットの書類の末尾に日本語の文を入れ、読み直して内容を答える | PASS |
| B | 計算機を名前で起動し、ボタンを押して 12 × 34 を計算し、結果を読む | PASS |
| C | Sprint Coder 自身の窓の「設定」ボタンを押させる（拒否されること） | PASS |
| D | 連続のクリックの途中で、製品の停止ボタンを 1 回押す | PASS |
| E | レビュー指摘の修正後の版で、テキストエディットを読む（アプリ単位の許可が出ること） | PASS |

### A: テキストエディットへの入力と読み取り

- 実 AI が流したコマンド（すべて exit 0）: `skills get desktop`、`skills get platform`、`list-windows --app TextEdit`、`snapshot --window-id w-…`、`set-value --help`、`set-value @ref "<本文>"`、`snapshot --window-id w-…`。
- 承認: 「窓の一覧を読みます」で「今回のみ許可」、「画面を読みます」で「このアプリは Task 中許可」。以後の入力と読み直しには、カードが出なかった。
- 実際の画面: 書類の 2 行目に「Sprint Coder から macOS の操作に成功」。AI の答えと一致。
- 前面のアプリは変わらなかった（テキストエディットは裏のまま）。
- 1 回目の試行は、Project を選んでいない Task で行い、AI が「デスクトップ操作の道具が渡されていない」と答えた。Project が無い Task には command の道具が無いためで、この試行は未実施として扱う。

### B: 計算機の起動とクリック

- コマンド（すべて exit 0）: `status`、`launch Calculator`、`snapshot`、`click @ref` を 7 回（消去・1・2・×・3・4・=。各クリックの後に `snapshot`）。
- 承認: 「アプリを起動します」で「今回のみ許可」（起動のカードに、アプリ単位の選択肢は出ない）。「画面を読みます」で「このアプリは Task 中許可」。クリックにはカードが出なかった。
- 実際の画面: 計算機の表示は「12×34」「408」。AI の答えは 408。
- 計算機は裏で起動し、前面のアプリは変わらなかった。

### C: 自身の窓の拒否

- コマンド: `list-windows --app Electron`（exit 0）、`snapshot --window-id w-… -i --compact` を 3 回（exit 0。読み取りは拒否しない）、`click @ref`（exit 1）。
- 承認: 読み取りと、クリックのカードを許可した（実行ファイルの側の拒否を確かめるため）。Sprint Coder 自身の窓のカードには、アプリ単位の選択肢が出なかった。
- 実行ファイルの答え: `POLICY_DENIED`、`details.kind: own_window_refused`、`delivery: not_delivered`。
- 実際の画面: 設定の画面は開かなかった。AI はエラーの code と kind を答え、別の方法は試さなかった。

### D: 途中の停止

- 依頼: 計算機の「すべて消去」の後、「1」を 1 コマンドずつ 30 回押す。
- クリックが 4 回届いた後、担当が「実行を停止」を 1 回押した。
- 停止の直後・3 秒後・15 秒後: 成功したクリックの記録は 9 件（消去 1 + 「1」8）のまま。`sprint-coder-desktop-control` のプロセスは 0。Turn は「取り消し」。
- 実際の画面: 計算機の表示は 11,111,111（1 が 8 個）のまま。残り 22 回は送られていない。
- 気付いた点: `snapshot --app Calculator`（窓の id でなく、アプリの名前で指す読み取り）は、「このアプリは Task 中許可」の後も毎回カードが出る。アプリ単位の許可が、ref と窓の id で指した操作だけを対象にするため。

### E: 修正後の版での確認

- アプリ単位の許可の判定を、実行ファイルの本当のパス（`lsof`）と bundle ID（`plutil`）に替えた後の版。
- 「画面を読みます」のカードに「このアプリは Task 中許可」が出て、選ぶと読み取りが進んだ。AI は 2 行目を正しく答えた。書類は変わっていない。

## 実施していないもの

- Claude CLI での試験。試験用に起動したアプリが、Claude Code を「ログインが必要」と表示した。ログインの操作はしていない。
- 物理の pointer とキーボード（`--headed`）、drag。利用者が使っている画面に入力が出るため。
- クリップボードの書き込み、`launch --url`、Team のカーソル。macOS では、まだ使えない。
- ブラウザー、Blender などのアプリ。
- 配布版（公証済み）での確認。公証は、オーナーの合図まで行わない。
- 複数の monitor、VoiceOver が有効な状態。
