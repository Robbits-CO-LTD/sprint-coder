# このフォルダーの出どころ

Sprint Coder のデスクトップ操作の実行ファイルは、このフォルダーのソースから build している（repo の root の `build-desktop-control.mjs`。出力は `build/Release/sprint-coder-desktop-control.exe` と、その SHA-256 を書いた `.sha256`）。

- 出典: [vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop)（Apache License 2.0。全文は同じフォルダーの `LICENSE` と `docs/licenses/agent-desktop-license.txt`。upstream に NOTICE は無い）
- 版: 1.2.0（tag `v1.2.0`、commit `2b0a7334fc111730454b726e6800aa41cdafc093`、2026-11-04 の "chore: release 1.2.0 with mcp support (#568)"。`Cargo.toml` の `version = "1.2.0"`、`CHANGELOG.md` の 1.2.0 の節と、npm の `agent-desktop@1.2.0` に一致）
- 取り込んだ日: 2026-11-10
- 取り込み方: 上の commit の git の中身（改行は LF のまま）を、元の構成のままコピーした。

以後の変更は、この repo で行い、下の「変えたファイル」に書き足す。upstream の更新を取り込む時も、ここに版と commit を書く。

## 入れたもの

Windows 用の CLI の build に要る部分だけ。

- `Cargo.toml`（workspace）、`Cargo.lock`、`rust-toolchain.toml`（1.89.0）、`LICENSE`
- `crates/core`、`crates/windows`
- `src`（CLI。upstream の試験のコードも含めて、そのまま）
- `skills`（`crates/core/src/commands/skills.rs` が `include_str!` でバイナリに埋め込む説明書。macOS・Linux・FFI の分も埋め込まれるので全部入れた）

## 入れなかったもの

`crates/macos`、`crates/linux`、`crates/ffi`、`apps`（説明のサイト）、`npm`、`benchmarks`、`probes`、`assets`、`docs`、`tests`、`scripts`、`.github`、`.githooks`、`.agents`、`.claude`、`.git`、root の説明の文書（`README.md`、`AGENTS.md`、`CHANGELOG.md`、`CONCEPTS.md`、`CONTRIBUTING.md` など）、`clippy.toml`、`deny.toml`、`.gitleaks.toml` など build に要らない設定。

macOS は今は無効なので入れていない。Mac に対応する時に、その時の upstream から入れ直す。

## 取り込んだ後に消したもの

build にも同梱にも使わないファイル（2026-11-11）。

- `src/visual_debug/viewer_filter.test.js`（upstream の JS の試験。`src/visual_debug/render.rs` が `include_str!` で埋め込むのは `viewer_filter.js` などで、これは読まれない）

参照を調べて残したもの:

- `skills` の macOS・Linux・FFI の分: `crates/core/src/commands/skills.rs` が OS を問わず `include_str!` で埋め込み、Windows 版でも `skills get macos` などで表示されるので、消すには `.rs` を変える必要がある。
- `crates/core/examples`、`crates/windows/examples`: build（`cargo build --release`）には入らないが、`cargo test` は compile する。`uia_tree_dump.rs` は `crates/windows/src/tree/testdata/` の試験の資料を作る道具。
- Rust の試験（`*_tests.rs`、`src/tests`、`testdata`）: これからソースを直す時の守りなので残す。

## 変えたファイル（Apache License 2.0 の 4 条 b）

`skills` は 1 つも変えていない。変えたのは次のファイルだけ。

| ファイル | 変えた点 |
| --- | --- |
| `Cargo.toml` | 1 行目に変更の注記を足した。`members` と `default-members` から、入れなかった `crates/macos`・`crates/linux`・`crates/ffi` を外した。ほかは元のまま（`[profile.release.package.agent-desktop-macos]` も残したので、build の時に「どの package にも当たらない」という警告が 1 行出る） |
| `src/Cargo.toml` | 1 行目に変更の注記を足した。入れなかった crate を指す `[target.'cfg(target_os = "macos")'.dependencies]` の `agent-desktop-macos` と、`[target.'cfg(target_os = "linux")'.dependencies]` の `agent-desktop-linux` を外した |
| `Cargo.lock` | 上の 2 つの変更に合わせて、cargo が自動で落とした分だけ（`cargo update` はしていない）。macOS・Linux・FFI の 3 つの crate と、それらだけが使っていた 64 の package が消えた（追加・版の変更は無し）。残った 99 の package の版と checksum は元のまま |
| `crates/windows/src/tree/automation.rs` | 1 行目に変更の注記を足した。UI Automation の client を作る所（`create_bounded_client`）で `SetAutoSetFocus(false)` を呼ぶようにした（失敗したら client を作らずにエラーを返す。そのための `auto_set_focus_error` を足した）。既定の有効のままだと、`set-value`・`clear`・`click`・`toggle`・`expand`・`select` などの pattern の呼び出しが、対象にキーボードのフォーカスを移し、対象の窓を前面に出していた。`focus`・`focus-window`・`--headed` の入力は、自分で前面に出すので変わらない |
| `crates/windows/src/tree/automation_tests.rs` | 1 行目に変更の注記を足した。配る client の `AutoSetFocus` が切れていることを確かめる試験 `the_shipped_client_does_not_move_focus_before_pattern_calls` を足した |
| `crates/windows/src/actions/win32_combo.rs`（新しく足したファイル） | 標準の Win32 の combo box（窓の基底の種類が `ComboBox`。`RealGetWindowClassW` で見るので、それを元にした toolkit の箱も含む）で項目を選ぶ所。UI Automation の proxy は `CB_SETCURSEL`・`CB_SELECTSTRING` で選択を書くだけで `CBN_SELCHANGE` を送らないため、持ち主の窓が変更を知らず、選んだ物が働かなかった（文字コード表のフォントが変わらない）。また開いた一覧の項目の Invoke は proxy の click の模倣で、窓を前面に出していた。ここでは `CB_FINDSTRINGEXACT` で項目を探し（同じ文字の項目が 2 つあれば `AMBIGUOUS_TARGET`、無ければ `ELEMENT_NOT_FOUND`）、開いている一覧を `CB_SHOWDROPDOWN` で閉じ、`CB_SETCURSEL` で選び、持ち主へ `WM_COMMAND`（`CBN_SELCHANGE`）を送る。窓の message だけで行い、入力の合成・フォーカスの移動・前面の変更はしない。結果は step `Win32ComboBox.SelectAndNotify` で、選択が残り一覧が閉じていれば verified。項目の文字を持たない owner-draw の箱は対象外（UI Automation の経路に任せる）。項目の ref で指定された時（`click`、値なしまたは項目自身の名前の `select`）は、名前で探し直さず、その項目の SelectionItem で箱をその位置へ動かし（フォーカス・通知なし）、その位置を `CB_SETCURSEL` と `CBN_SELCHANGE` で確定する（同じ名前の項目が 2 つあっても AMBIGUOUS にならない。項目が選ばれたと読めない時は未確認）。名前の一意性を求めるのは箱に名前を渡した時だけ。一覧の窓（`ComboLBox`）は自分の種類の名前で見分け（基底の種類は `ListBox`）、それが属する箱は、一覧の thread の窓のうち `GetComboBoxInfo` がその一覧を指す物として探す（一覧は desktop の子で owner が無く、UI Automation の親をたどっても箱に戻らないことがある）。一覧を閉じる時の通知（`CBN_CLOSEUP`）で持ち主が項目を足す・並べ替えることがあるので、名前の経路は閉じた後に名前で引き直してから選ぶ。確定の後は、保たれた位置・閉じた一覧に加えて、その位置の項目の文字（`CB_GETLBTEXT`）が求めた名前と一致する時だけ verified（`holds_requested`）。項目の ref の経路では、項目自身の Select が置いた位置の項目の文字を、閉じる前と後の両方で確かめ、どちらかが違えば持ち主に確定を送らず未確認で返す。項目自身の Select が届いた後は、続く確定が届かなくても「届いたが未確認」として返す（`after_item_select`） |
| `crates/windows/src/actions/win32_combo_tests.rs`（新しく足したファイル） | 上の判定（窓の種類・`CBS_HASSTRINGS`・検索結果の重複・`WM_COMMAND` の `wParam`・エラーに値の文字を出さないこと）の試験。`holds_requested`・`after_item_select` の試験 |
| `crates/windows/src/actions/win32_combo_live_tests.rs`（新しく足したファイル） | 試験のプロセスが作る見えない窓の本物の combo box で確かめる試験。proxy の `ValuePattern.SetValue` が選択を動かしても持ち主に通知が来ないこと（不具合の原因）、`select`・`set-value` が項目を選んで通知を 1 回だけ送ること、無い項目・重複・値なしの扱い。同じ名前の項目が 2 つある箱で、項目の ref への `select`・`click` がその項目そのものを選ぶこと（一覧の項目は開いている間だけ公開されるので、試験は一覧を開いてから箱の下の一覧をたどる）。閉じる通知で先頭に項目を足す持ち主の箱で、名前の経路が引き直した位置の正しい項目を選ぶこと、項目の ref の経路が位置に入り込んだ別の項目を「確認済み」にも確定にもしないこと |
| `crates/windows/src/actions/mod.rs` | 1 行目に変更の注記を足した。`win32_combo` を足した |
| `crates/windows/src/actions/select.rs` | 1 行目に変更の注記を足した。標準の Win32 の combo box（またはその一覧の項目）は `win32_combo` で選ぶようにした。値が空なら対象の項目そのものを選ぶ（一覧や combo box に値なしで使ったら、指定のしかたを書いた `INVALID_ARGS`）。ItemContainer を持つ入れ物では、一覧を開く前にその provider に名前で項目を探させ、見つかれば開かずに選ぶ（WPF の ComboBox で、項目を 1 つずつ読む探索とスクロールの繰り返しが期限を越えていた）。成功の後、開いている combo box の一覧を閉じ、その結果を step `ExpandCollapsePattern.Collapse` として返す。`collapse_container` は受け付けられたかを返すようにした。項目の ref で指定された時（値なし、または項目自身の名前）は `win32_combo_select_item` で識別を保って選ぶ。閉じる step の確認は、その前の選択が確認済みの時だけ数え、未確認の選択の後では確認なしで残す（`close_outcome`。全体の要約が閉じた成功だけで確認済みにならないように。要約の `delivery_summary` 自体は変えていない） |
| `crates/windows/src/actions/select_search.rs` | 1 行目に変更の注記を足した。ItemContainer の `FindItemByProperty` で名前の項目を探す `find_listed_item` を足した（2 回目の検索で重複を見つけたら `AMBIGUOUS_TARGET`、見つからない・名前が合わない時は従来の探索に任せる） |
| `crates/windows/src/actions/select_tests.rs` | 1 行目に変更の注記を足した。未確認の選択の後に一覧を閉じても、全体が確認済みにならないことの試験を足した |
| `crates/windows/src/actions/dispatch.rs` | 1 行目に変更の注記を足した。`click` の対象が標準の Win32 の combo box の一覧の項目なら、Invoke ではなく `win32_combo` で選ぶ。`set-value` で combo box の項目を選ばなかった時は、結果の `details.list_selection` を `not_chosen` にする。項目の `click` は `win32_combo_select_item`（名前で探し直さない）を使う |
| `crates/windows/src/actions/value_write.rs` | 1 行目に変更の注記を足した。標準の Win32 の combo box への `set-value` で、値が項目の 1 つと一致すれば `win32_combo` で選ぶ。一致しなければ従来どおり文字を書き、飛ばした step `Win32ComboBox.SelectAndNotify` を足して「項目は選んでいない」ことを示す（`left_list_unchosen`）。一致した時は、一覧を閉じた後に名前で引き直す `select_text` で選ぶ |
| `crates/windows/src/actions/mutation.rs` | 1 行目に変更の注記を足した。試験用の走査の一覧 `action_scan_sources` に `win32_combo.rs` を足した |
| `src/cli_args/actions.rs` | 1 行目に変更の注記を足した。`select` の `VALUE` を省けるようにした（既定は空。項目の ref だけを渡すと、その項目を選ぶ） |
| `crates/windows/src/system/launch.rs` | 1 行目に変更の注記を足した。`--activate` を付けない `launch` で、起動したアプリが前面を取り、前面の窓の上に重なっていた（Windows では `--activate` が使われていなかった）。`ForegroundGuard` を足し、起動の間は `LockSetForegroundWindow` で前面を固定し（このプロセスが終われば Windows が解く）、窓が見つかったら固定を解いて、起動の前に前面だった窓のすぐ下へ `SetWindowPos`（`SWP_NOACTIVATE`。起動先が止まっていても待たないよう `SWP_ASYNCWINDOWPOS` も付ける）で置く。固定を解いた直後に起動したアプリが前面を取っていたら、前の窓へ戻す。ただし固定を解く前に前面が前の窓から変わっていたら（利用者のクリックや Alt+Tab、前の窓が閉じた・最小化された）、戻すことも並べ替えることもしない。固定が取れなかった時も同じ（利用者の操作と区別できないため。固定が取れないのはこのプロセスに前面を変える権利が無い時で、起動したアプリも自分から前面を取れず、前の窓へ戻すこともできない）。前の窓が最小化されている時は、前面のまま残っていても、戻すことも並べ替えることもしない（並べ替えると、起動した窓がすべての窓の後ろに沈むため）。この判断を `may_restore_foreground` に切り出し、その unit test を同じファイルに足した。`--activate` の時は何もしない |
| `crates/windows/src/system/launch_live_tests.rs` | 1 行目に変更の注記を足した。`--activate` を付けない起動で、起動した窓が前面にならず、前面だった窓より下にあることを確かめる試験 `a_background_launch_keeps_the_foreground_and_stays_below_it` を足した（並べ替えは非同期なので、順番は最大 2 秒、50 ms ごとに見直して確かめる） |

## build と試験

- build: `node build-desktop-control.mjs`（Windows x64 の時だけ。ほかは何もせずに成功で終わる）。`cargo build --release --locked` を、`rust-toolchain.toml` が効くようにこのフォルダーで動かす。
- upstream の試験（`cargo test`）は、入れなかった `probes`・`tests`・`docs`・`.github` などのファイルを `include_str!` で読むものがあるので、このままでは compile できない。Sprint Coder の CI でも回していない。
