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
| `crates/windows/src/system/launch.rs` | 1 行目に変更の注記を足した。`--activate` を付けない `launch` で、起動したアプリが前面を取り、前面の窓の上に重なっていた（Windows では `--activate` が使われていなかった）。`ForegroundGuard` を足し、起動の間は `LockSetForegroundWindow` で前面を固定し（このプロセスが終われば Windows が解く）、窓が見つかったら固定を解いて、起動の前に前面だった窓のすぐ下へ `SetWindowPos`（`SWP_NOACTIVATE`。起動先が止まっていても待たないよう `SWP_ASYNCWINDOWPOS` も付ける）で置く。固定を解いた直後に起動したアプリが前面を取っていたら、前の窓へ戻す。ただし固定を解く前に前面が前の窓から変わっていたら（利用者のクリックや Alt+Tab、前の窓が閉じた・最小化された）、戻すことも並べ替えることもしない。固定が取れなかった時も同じ（利用者の操作と区別できないため。固定が取れないのはこのプロセスに前面を変える権利が無い時で、起動したアプリも自分から前面を取れず、前の窓へ戻すこともできない）。前の窓が最小化されている時は、前面のまま残っていても、戻すことも並べ替えることもしない（並べ替えると、起動した窓がすべての窓の後ろに沈むため）。この判断を `may_restore_foreground` に切り出し、その unit test を同じファイルに足した。`--activate` の時は何もしない |
| `src/dispatch/window_owner.rs` | 新しく足したファイル（1 行目に変更の注記）。環境変数 `SPRINT_CODER_DESKTOP_EXPECTED_WINDOW_OWNER`（`<pid>:<process instance>`。instance は refmap の `process_instance` と同じ形）がある時、窓の id を取る command（`snapshot`・`find`・`screenshot`・`resize-window`・`move-window`・`minimize`・`maximize`・`restore`・`focus-window`・`press`・`wait --event`）は、今その id を持つ窓が、ちょうどその pid と process instance の process のものかを先に確かめ、違えば何も読まず・何もせずに `POLICY_DENIED`（details の `kind` は `window_owner_mismatch`）で終わる。値を読めない時は、どの command も同じく終わる。変数が無い時は何も変わらない。判定の unit test を同じファイルに置いた |
| `src/dispatch/mod.rs` | 1 行目に変更の注記を足した。`dispatch` の最初で、上の確かめ（`window_owner::check`）を呼ぶ。batch の各 step も `dispatch` を通るので、step ごとに効く |
| `crates/windows/src/system/launch_live_tests.rs` | 1 行目に変更の注記を足した。`--activate` を付けない起動で、起動した窓が前面にならず、前面だった窓より下にあることを確かめる試験 `a_background_launch_keeps_the_foreground_and_stays_below_it` を足した（並べ替えは非同期なので、順番は最大 2 秒、50 ms ごとに見直して確かめる） |

## build と試験

- build: `node build-desktop-control.mjs`（Windows x64 の時だけ。ほかは何もせずに成功で終わる）。`cargo build --release --locked` を、`rust-toolchain.toml` が効くようにこのフォルダーで動かす。
- upstream の試験（`cargo test`）は、入れなかった `probes`・`tests`・`docs`・`.github` などのファイルを `include_str!` で読むものがあるので、このままでは compile できない。Sprint Coder の CI でも回していない。
