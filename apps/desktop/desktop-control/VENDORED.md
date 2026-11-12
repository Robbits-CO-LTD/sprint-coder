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

変えた・足したのは次のファイルだけ（`skills` は、表に書いた 2 つだけ）。

| ファイル | 変えた点 |
| --- | --- |
| `Cargo.toml` | 1 行目に変更の注記を足した。`members` と `default-members` から、入れなかった `crates/macos`・`crates/linux`・`crates/ffi` を外した。ほかは元のまま（`[profile.release.package.agent-desktop-macos]` も残したので、build の時に「どの package にも当たらない」という警告が 1 行出る） |
| `src/Cargo.toml` | 1 行目に変更の注記を足した。入れなかった crate を指す `[target.'cfg(target_os = "macos")'.dependencies]` の `agent-desktop-macos` と、`[target.'cfg(target_os = "linux")'.dependencies]` の `agent-desktop-linux` を外した |
| `Cargo.lock` | 上の 2 つの変更に合わせて、cargo が自動で落とした分だけ（`cargo update` はしていない）。macOS・Linux・FFI の 3 つの crate と、それらだけが使っていた 64 の package が消えた（追加・版の変更は無し）。残った 99 の package の版と checksum は元のまま |
| `crates/windows/src/tree/automation.rs` | 1 行目に変更の注記を足した。UI Automation の client を作る所（`create_bounded_client`）で `SetAutoSetFocus(false)` を呼ぶようにした（失敗したら client を作らずにエラーを返す。そのための `auto_set_focus_error` を足した）。既定の有効のままだと、`set-value`・`clear`・`click`・`toggle`・`expand`・`select` などの pattern の呼び出しが、対象にキーボードのフォーカスを移し、対象の窓を前面に出していた。`focus`・`focus-window`・`--headed` の入力は、自分で前面に出すので変わらない |
| `crates/windows/src/tree/automation_tests.rs` | 1 行目に変更の注記を足した。配る client の `AutoSetFocus` が切れていることを確かめる試験 `the_shipped_client_does_not_move_focus_before_pattern_calls` を足した |
| `src/dispatch/window_owner.rs` | 新しく足したファイル（1 行目に変更の注記）。環境変数 `SPRINT_CODER_DESKTOP_EXPECTED_WINDOW_OWNER`（`<pid>:<process instance>`。instance は refmap の `process_instance` と同じ形）がある時、窓の id を取る command（`snapshot`・`find`・`screenshot`・`resize-window`・`move-window`・`minimize`・`maximize`・`restore`・`focus-window`・`press`・`wait --event`）は、今その id を持つ窓が、ちょうどその pid と process instance の process のものかを先に確かめ、違えば何も読まず・何もせずに `POLICY_DENIED`（details の `kind` は `window_owner_mismatch`）で終わる。値を読めない時は、どの command も同じく終わる。変数が無い時は何も変わらない。判定の unit test を同じファイルに置いた |
| `src/dispatch/mod.rs` | 1 行目に変更の注記を足した。`dispatch` の最初で、上の確かめ（`window_owner::check`）を呼ぶ。batch の各 step も `dispatch` を通るので、step ごとに効く |
| `crates/windows/src/actions/win32_combo.rs`（新しく足したファイル） | 標準の Win32 の combo box（窓の基底の種類が `ComboBox`。`RealGetWindowClassW` で見るので、それを元にした toolkit の箱も含む）で項目を選ぶ所。UI Automation の proxy は `CB_SETCURSEL`・`CB_SELECTSTRING` で選択を書くだけで `CBN_SELCHANGE` を送らないため、持ち主の窓が変更を知らず、選んだ物が働かなかった（文字コード表のフォントが変わらない）。また開いた一覧の項目の Invoke は proxy の click の模倣で、窓を前面に出していた。ここでは `CB_FINDSTRINGEXACT` で項目を探し（同じ文字の項目が 2 つあれば `AMBIGUOUS_TARGET`、無ければ `ELEMENT_NOT_FOUND`）、開いている一覧を `CB_SHOWDROPDOWN` で閉じ、`CB_SETCURSEL` で選び、持ち主へ `WM_COMMAND`（`CBN_SELCHANGE`）を送る。窓の message だけで行い、入力の合成・フォーカスの移動・前面の変更はしない。結果は step `Win32ComboBox.SelectAndNotify` で、選択が残り一覧が閉じていれば verified。項目の文字を持たない owner-draw の箱は対象外（UI Automation の経路に任せる）。項目の ref で指定された時（`click`、値なしまたは項目自身の名前の `select`）は、名前で探し直さず、その項目の SelectionItem で箱をその位置へ動かし（フォーカス・通知なし）、その位置を `CB_SETCURSEL` と `CBN_SELCHANGE` で確定する（同じ名前の項目が 2 つあっても AMBIGUOUS にならない。項目が選ばれたと読めない時は未確認）。名前の一意性を求めるのは箱に名前を渡した時だけ。一覧の窓（`ComboLBox`）は自分の種類の名前で見分け（基底の種類は `ListBox`）、それが属する箱は、一覧の thread の窓のうち `GetComboBoxInfo` がその一覧を指す物として探す（一覧は desktop の子で owner が無く、UI Automation の親をたどっても箱に戻らないことがある）。一覧を閉じる時の通知（`CBN_CLOSEUP`）で持ち主が項目を足す・並べ替えることがあるので、名前の経路は閉じた後に名前で引き直してから選ぶ。確定の後は、保たれた位置・閉じた一覧に加えて、その位置の項目が求めた名前を持つ時だけ verified（`holds_requested`）。項目の ref の経路では、閉じる前と後で項目の数（`CB_GETCOUNT`）と、その名前を持つ項目の位置の並びがどちらも変わらず、項目自身の Select が置いた位置がその中にある時だけ確定を送る（`position_still_names_item`。同じ名前の項目は文字では見分けられないため）。それ以外は確定を送らず未確認で返す。項目の文字は相手から読み出さない（`CB_GETLBTEXT` は書き込み先の大きさを渡せず、長さを聞いてから読むまでに相手が項目を長くすると、こちらの memory を越えて書かれ得るため）。位置の項目が名前を持つかは、こちらが渡す文字で `CB_FINDSTRINGEXACT` をその位置から探させて確かめる（`carries`。相手は読むだけ）。文字を持たない箱（owner-draw で `CBS_HASSTRINGS` が無い）は、項目の ref の経路でも Select の前に対象外にして、従来の経路に任せる。項目自身の Select が届いた後は、続く確定が届かなくても「届いたが未確認」として返す（`after_item_select`）。持ち主へは、人がキーで選んだ時と同じく `CBN_SELENDOK` を `CBN_SELCHANGE` の前に送る（`selection_notifications`。WinForms の `SelectionChangeCommitted` などは `CBN_SELENDOK` で動くため）。`accepts_free_text`（`CBS_DROPDOWNLIST` でない箱）を足した |
| `crates/windows/src/actions/win32_combo_tests.rs`（新しく足したファイル） | 上の判定（窓の種類・`CBS_HASSTRINGS`・検索結果の重複・`WM_COMMAND` の `wParam`・エラーに値の文字を出さないこと）の試験。`holds_requested`・`after_item_select` の試験。`search_start`・`position_still_names_item` の試験。`selection_notifications`・`is_drop_down_list` の試験 |
| `crates/windows/src/actions/win32_combo_live_tests.rs`（新しく足したファイル） | 試験のプロセスが作る見えない窓の本物の combo box で確かめる試験。proxy の `ValuePattern.SetValue` が選択を動かしても持ち主に通知が来ないこと（不具合の原因）、`select`・`set-value` が項目を選んで通知を 1 回だけ送ること、無い項目・重複・値なしの扱い。同じ名前の項目が 2 つある箱で、項目の ref への `select`・`click` がその項目そのものを選ぶこと（一覧の項目は開いている間だけ公開されるので、試験は一覧を開いてから箱の下の一覧をたどる）。閉じる通知で先頭に項目を足す持ち主の箱で、名前の経路が引き直した位置の正しい項目を選ぶこと、項目の ref の経路が位置に入り込んだ別の項目を「確認済み」にも確定にもしないこと。同じ名前の項目 2 件＋閉じる通知で項目を足す箱で、項目の ref が別の項目を確定も確認済みにもしないこと、`carries`・`positions_of` が項目の文字を読み出さずに正しく答えること、文字を持たない owner-draw の箱を項目の ref の経路が横取りしないこと（試験の補助も `CB_GETLBTEXT` を使わない）。持ち主が受けた通知の順番（`CBN_SELENDOK` → `CBN_SELCHANGE`）、`set-value` で同じ名前 2 件は AMBIGUOUS で箱を動かさないこと、drop-down list で無い名前は NOT_FOUND で何も書かないこと、編集できる箱では文字を書いて「項目は選んでいない」と示すこと |
| `crates/windows/src/actions/mod.rs` | 1 行目に変更の注記を足した。`win32_combo` を足した |
| `crates/windows/src/actions/select.rs` | 1 行目に変更の注記を足した。標準の Win32 の combo box（またはその一覧の項目）は `win32_combo` で選ぶようにした。値が空なら対象の項目そのものを選ぶ（一覧や combo box に値なしで使ったら、指定のしかたを書いた `INVALID_ARGS`）。ItemContainer を持つ入れ物では、一覧を開く前にその provider に名前で項目を探させ、見つかれば開かずに選ぶ（WPF の ComboBox で、項目を 1 つずつ読む探索とスクロールの繰り返しが期限を越えていた）。成功の後、開いている combo box の一覧を閉じ、その結果を step `ExpandCollapsePattern.Collapse` として返す。`collapse_container` は受け付けられたかを返すようにした。項目の ref で指定された時（値なし、または項目自身の名前）は `win32_combo_select_item` で識別を保って選ぶ。閉じる step の確認は、その前の選択が確認済みの時だけ数え、未確認の選択の後では確認なしで残す（`close_outcome`。全体の要約が閉じた成功だけで確認済みにならないように。要約の `delivery_summary` 自体は変えていない）。項目の ref の経路は、文字を持たない箱と名前の無い項目では Select の前に対象外とし、閉じる前後で数と同じ名前の項目の位置が変わらない時だけ確定する |
| `crates/windows/src/actions/select_search.rs` | 1 行目に変更の注記を足した。ItemContainer の `FindItemByProperty` で名前の項目を探す `find_listed_item` を足した（2 回目の検索で重複を見つけたら `AMBIGUOUS_TARGET`、見つからない・名前が合わない時は従来の探索に任せる）。2 回目の検索が「探し終えた」（成功の値で項目なし）のか provider の失敗なのかを区別し、失敗なら一意と見なさずに従来の探索に任せる（`listed_item_is_unique`。その試験も足した）。仮想化された項目は名前を実体化の後にしか出さないので、名前を確かめる前に `VirtualizedItem.Realize` する（開いたことの無い WPF の ComboBox で、名前が合わず従来の探索に落ちて期限切れになっていた） |
| `crates/windows/src/actions/select_tests.rs` | 1 行目に変更の注記を足した。未確認の選択の後に一覧を閉じても、全体が確認済みにならないことの試験を足した |
| `crates/windows/src/actions/dispatch.rs` | 1 行目に変更の注記を足した。`click` の対象が標準の Win32 の combo box の一覧の項目なら、Invoke ではなく `win32_combo` で選ぶ。`set-value` で combo box の項目を選ばなかった時は、結果の `details.list_selection` を `not_chosen` にする。項目の `click` は `win32_combo_select_item`（名前で探し直さない）を使う |
| `crates/windows/src/actions/value_write.rs` | 1 行目に変更の注記を足した。標準の Win32 の combo box への `set-value` で、値が項目の 1 つと一致すれば `win32_combo` で選ぶ。一致しなければ従来どおり文字を書き、飛ばした step `Win32ComboBox.SelectAndNotify` を足して「項目は選んでいない」ことを示す（`left_list_unchosen`）。一致した時は、一覧を閉じた後に名前で引き直す `select_text` で選ぶ。名前が複数の項目に当たる時は書き込む前に `AMBIGUOUS_TARGET`、どの項目にも当たらない時は、drop-down list なら書き込まずに `ELEMENT_NOT_FOUND`（書き込みで箱の選択だけが通知なしに動くのを防ぐ）。自由な文字を取る箱でだけ、従来どおり文字を書き、飛ばした step で「項目は選んでいない」と示す |
| `crates/windows/src/actions/mutation.rs` | 1 行目に変更の注記を足した。試験用の走査の一覧 `action_scan_sources` に `win32_combo.rs` を足した |
| `src/cli_args/actions.rs` | 1 行目に変更の注記を足した。`select` の `VALUE` を省けるようにした（既定は空。項目の ref だけを渡すと、その項目を選ぶ） |
| `crates/windows/src/system/launch.rs` | 1 行目に変更の注記を足した。`--activate` を付けない `launch` で、起動したアプリが前面を取り、前面の窓の上に重なっていた（Windows では `--activate` が使われていなかった）。`ForegroundGuard` を足し、起動の間は `LockSetForegroundWindow` で前面を固定し（このプロセスが終われば Windows が解く）、窓が見つかったら固定を解いて、起動の前に前面だった窓のすぐ下へ `SetWindowPos`（`SWP_NOACTIVATE`。起動先が止まっていても待たないよう `SWP_ASYNCWINDOWPOS` も付ける）で置く。固定を解いた直後に起動したアプリが前面を取っていたら、前の窓へ戻す。ただし固定を解く前に前面が前の窓から変わっていたら（利用者のクリックや Alt+Tab、前の窓が閉じた・最小化された）、戻すことも並べ替えることもしない。固定が取れなかった時も同じ（利用者の操作と区別できないため。固定が取れないのはこのプロセスに前面を変える権利が無い時で、起動したアプリも自分から前面を取れず、前の窓へ戻すこともできない）。前の窓が最小化されている時は、前面のまま残っていても、戻すことも並べ替えることもしない（並べ替えると、起動した窓がすべての窓の後ろに沈むため）。この判断を `may_restore_foreground` に切り出し、その unit test を同じファイルに足した。`--activate` の時は何もしない。また、起動したプロセスが自分では窓を出さずに終わる時（電卓の `calc.exe` は、shell に packaged の電卓を起動させてすぐ終わり、窓は親子の関係の無い `CalculatorApp.exe` が出す）、そのプロセスの窓を期限（既定 30 秒）まで待ち続け、その間ずっと前面を固定していた。新しい処理（`observe_launched_window`）では、起動したプロセスが動いている間は今までどおり自分の窓だけを待ち、終わった後は、そのプロセスの子孫（下の `launch_handoff.rs`）の窓だけを受け取り、生きている子孫が無ければすぐに窓なしで返して、`suggestion` に「窓は別のプロセスが出した可能性がある。`list-windows` で探す」を入れる。同じ頃に現れただけの別のアプリの窓は受け取らない。このため `CreateProcessW` が返したプロセスの handle を閉じずに持つ（pid の再利用を防ぐ）。`ForegroundGuard` の並べ替えと前面の戻しは、起動したプロセスの窓だけでなく、結び付けた子孫の窓（shell が枠で包む app なら、枠の中の app のプロセス）にも効くようにした（`window_is_owned_by`） |
| `crates/windows/src/system/launch_handoff.rs`（新しく足した） | 起動したプロセスが終わった後に、そのプロセスが起動したと証明できるプロセス（子孫）を探す。ToolHelp の親の pid と、作られた時刻が親の生きていた間にあることで結び付け、親の handle を持って pid の再利用を防ぐ。子孫の窓は、`process_instance` が一致するものだけを受け取る |
| `crates/windows/src/system/launch_handoff_tests.rs`（新しく足した） | 上の試験。時刻での親子の判断、窓の受け取り（別のプロセス・instance の違う窓は受け取らない）、実物の `cmd.exe` で「子を残さずに終わる」「子を起動して終わる」の 2 つを確かめる |
| `crates/windows/src/tree/walk/walker_source.rs` | 1 行目に変更の注記を足した。ref の照合だけの読み取り（`identity_only`）では、部品を `IDENTITY_SET` の属性だけで読む。窓全体をたどる読み取り（深さ 50。snapshot の照合用の読み取りと、保存した ref の照合）のうち、client 側の provider が出す木（`Skip`。Win32 の部品など）は、先に属性なしで部品を数え（`count_within`。上限 1,000 部品）、上限以内なら根で 1 回だけ `BuildUpdatedCache`（範囲は部分木全体、生の view）を呼び、部品の並びと属性をその cache から読む（`for_whole_root`・`prepare_whole_root`・`cached_children`）。数える時間と 1 回の呼び出しの時間は、それぞれ残りの期限の 4 分の 1 まで（上限 0.5 秒と 1 秒。`prefetch_shares`）で、呼び出しは client の transaction timeout をその時間まで一時的に下げて行う（`with_transaction_timeout`）。上限を超えた・時間切れ・失敗の時は、従来の部品ごとの読み取りに戻り、期限の半分以上がそれに残る。対象の process の中で答えを作る provider（`Batch`。WPF など）と Chromium 由来の窓は、一括の取得をせず従来どおり部品ごとに読む（一括の取得は期限で打ち切っても相手が作り続け、続く読み取りが待たされるため。20,000 項目の WPF の一覧で、相手が 40 秒以上忙しいままになった）。経路の降下用に、通り過ぎる兄弟の属性を読まずに進む `for_descent` を足した。`walk_uia_subtree_for` を足した（`walk_uia_subtree` は従来の引数のまま） |
| `crates/windows/src/tree/walk/cache.rs` | 1 行目に変更の注記を足した。cache request を属性の組と範囲で作れるようにし、部分木全体の request（`build_subtree_cache_request`。tree filter は true condition、つまり生の view）を足した |
| `crates/windows/src/tree/walk/walker.rs` | 1 行目に変更の注記を足した。`TreeSource` に、持っている子の一覧を返す `cached_children`（既定は `None`）を足した |
| `crates/windows/src/tree/walk/walker_enumerate.rs` | 1 行目に変更の注記を足した。`cached_children` が一覧を返した時は、その一覧を同じ上限（兄弟の数の上限・期限・失敗の記録）で使う `read_cached_children` を足した |
| `crates/windows/src/tree/walk/walker_cached_children_tests.rs`（新しく足した） | 持っている子の一覧でたどった結果が、1 つずつ列挙した結果（部品・経路・数・完全さ・失敗）と同じであることの試験 |
| `crates/windows/src/tree/walk/identity_set_tests.rs`（新しく足した） | `IDENTITY_SET` だけで読んだ部品と、全部の属性で読んだ部品とで、照合に使う証拠（role・name・value・description・native id・secure の扱い）が同じであることの試験 |
| `crates/windows/src/tree/walk/walker_prefetch_tests.rs`（新しく足した） | 一括の取得が上限を超えた・数える時間が無い・呼び出しの時間が無い時に、部品ごとの読み取りに戻って根を読み、一括の取得と同じ木を返すこと。数える処理が上限で止まること。一括の取得に使う時間が期限の半分を超えないこと |
| `crates/windows/src/tree/properties/property_ids.rs` | 1 行目に変更の注記を足した。照合に使う証拠の元になる属性だけの組 `IDENTITY_SET` を足した |
| `crates/windows/src/tree/properties/mod.rs` | 1 行目に変更の注記を足した。属性の組を指定して読む `read_live_set`・`read_cached_set` を足した（従来の関数は全部の属性のまま） |
| `crates/windows/src/tree/observe.rs` | 1 行目に変更の注記を足した。観察の要求の `identity_only` を木の読み取りへ渡す |
| `crates/windows/src/tree/resolve/resolve_anchor.rs` | 1 行目に変更の注記を足した。保存した経路の降下に `UiaTreeSource::for_descent`（通り過ぎる兄弟の属性を読まない）を使い、着いた部品は `prepare_root` で属性を読んでから role を確かめる（読めなければ cache なしのまま。role は Unknown になり、従来の読み取り失敗と同じ扱い） |
| `crates/windows/src/system/launch_live_tests.rs` | 1 行目に変更の注記を足した。`--activate` を付けない起動で、起動した窓が前面にならず、前面だった窓より下にあることを確かめる試験 `a_background_launch_keeps_the_foreground_and_stays_below_it` を足した（並べ替えは非同期なので、順番は最大 2 秒、50 ms ごとに見直して確かめる） |
| `crates/windows/src/system/window/frame_identity.rs` | 1 行目に変更の注記を足した。窓をどの process のものとするかの規則 `attributed_owner`（枠が中のアプリを持っていればそのアプリ、でなければ窓の持ち主）を足した。`list-windows` が既に使っている規則（`hosted_application_pid`）と同じで、下の 2 か所がこれを使う |
| `crates/windows/src/system/window/frame_identity_tests.rs` | 1 行目に変更の注記を足した。`attributed_owner` が普通の窓では窓の持ち主、中のアプリを持つ枠ではそのアプリを返すこと、中のアプリを持つ枠として `list-windows` に出る窓のアプリが、同じ pid・process instance・名前で app の一覧にも出ることの試験を足した（その時その枠が無ければ飛ばす） |
| `crates/windows/src/system/app_ops.rs` | 1 行目に変更の注記を足した。app の一覧（`list-apps`、と `press --window-id` などが窓のアプリを引く所）が、窓の process を `attributed_owner` で読むようにした。電卓のような枠の中のアプリは、`list-windows` では中のアプリ（`CalculatorApp.exe`）として出るのに、app の一覧では枠の持ち主（`ApplicationFrameHost.exe`）として出ていたため、`press --window-id` が `APP_NOT_FOUND` で失敗していた |
| `crates/windows/src/system/key_dispatch.rs` | 1 行目に変更の注記を足した。キーを送る直前の「前面の窓が対象の process のものか」の確かめで、前面の窓の process を `attributed_owner` で読むようにした。枠は枠の持ち主の process のものなので、中のアプリへのキーが前面の確かめで必ず止まっていた。中のアプリを持たない枠・別のアプリを持つ枠は、今までどおり別の process と読まれて止まる。キーボードのフォーカスの確かめ（フォーカスのある窓の持ち主）は変えていない |
| `crates/windows/src/input/keyboard/keyboard_map.rs` | 1 行目に変更の注記を足した。記号のキーの名前 `plus`・`minus`・`asterisk`・`slash`・`equal`・`period`・`comma` と、`+` 以外の記号そのもの（`-` `*` `/` `=` `.` `,`）を受け付けるようにした（`+` は組み合わせの区切りなので名前だけ）。押すキーは、その時のキーボードの配列でその文字を出すキー（Shift などを含む。`VkKeyScanW`）。配列に無い記号は、ASCII の値の仮想キー（`+` なら `VK_EXECUTE`）に落とさずに `INVALID_ARGS` で断る。知らないキーの時の候補の一覧に足した名前を載せた |
| `crates/windows/src/input/keyboard/keyboard_map_tests.rs` | 1 行目に変更の注記を足した。記号の名前と文字が、配列で求めた同じキーに解かれること、ASCII の値の仮想キーにならないこと、一覧に無い記号・綴りの違う名前・`+` が断られること、候補の一覧に名前が載ることの試験を足した |
| `crates/core/src/commands/combo.rs` | 1 行目に変更の注記を足した。`press +` などキーが空の組み合わせの `INVALID_ARGS`（`Empty key combo`）に、`+` のキーは `plus` と書く、という `suggestion` を付けた |
| `crates/core/src/commands/combo_tests.rs` | 1 行目に変更の注記を足した。上の `suggestion` と、記号のキーを含む組み合わせの解釈の試験を足した |
| `src/cli_args/actions.rs`（2 回目） | `press` の `COMBO` の説明に、記号のキーの名前を足した |
| `src/cli/help_after.txt` | `--help` の KEY COMBOS に、記号のキーの名前（Windows）と、`+` のキーは `plus` であることを足した |
| `skills/agent-desktop-windows/SKILL.md` | 「Symbol keys」の項を足した（記号のキーの名前、`+` は `plus`、配列どおりに押すこと、電卓に 7+8= を打つ例） |
| `skills/agent-desktop/references/commands-interaction.md` | キーの名前の行に、記号のキーの名前は OS ごとに違うので platform の説明書を読む、と足した |
| `crates/windows/src/tree/chromium.rs` | 1 行目に変更の注記を足した。木の読み取りが Chromium 由来と見なす窓（`has_chromium_provenance`）に、窓の class が `Chrome_WidgetWin_1` の窓に加えて、子孫の窓に Chromium が Web の中身を描く窓（class `Chrome_RenderWidgetHostHWND`）を持つ窓を足した（WebView2 を使う Tauri・WinForms・WPF の窓。窓の外側の class はそのアプリのもので、Tauri は `Tauri Window`）。子孫の窓は `EnumChildWindows` と `GetClassNameW` で見る（相手に message を送らない）。WebView2 の窓は今まで Chromium 由来と見なされず、中身の上の名前の無い入れ子もすべて深さに数えられ（Tauri の窓で、中身の document が深さ 9、その中のボタンが深さ 13）、既定の深さ（10）では中身の部品が出なかった。Chromium の初回の読み取りを待つ判定（`is_chromium_root`）は変えていない |
| `crates/windows/src/tree/chromium_provenance_tests.rs`（新しく足した） | 上の判定の試験。message-only の窓で、3 段下の子孫の `Chrome_RenderWidgetHostHWND` を見つけること、持たない窓・名前の頭だけが同じ class の窓を見つけないこと |
| `crates/windows/src/tree/walk/walker_source.rs`（2 回目） | 木の読み取りの Chromium 由来の判定に `has_chromium_provenance` を使う。WebView2 の窓でも、名前の無い通り抜けの入れ子を深さに数えず、一括の取得をせず部品ごとに読む（Electron の窓と同じ） |
| `skills/agent-desktop-windows/references/chromium-and-electron.md` | 名前も動作も無い通り抜けの入れ子は、Electron の窓と WebView2 の窓では深さに数えないので、既定の深さから始める、と足した |

## build と試験

- build: `node build-desktop-control.mjs`（Windows x64 の時だけ。ほかは何もせずに成功で終わる）。`cargo build --release --locked` を、`rust-toolchain.toml` が効くようにこのフォルダーで動かす。
- upstream の試験（`cargo test`）は、入れなかった `probes`・`tests`・`docs`・`.github` などのファイルを `include_str!` で読むものがあるので、このままでは compile できない。Sprint Coder の CI でも回していない。
