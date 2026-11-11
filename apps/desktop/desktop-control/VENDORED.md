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

`.rs` のソースと `skills` は 1 つも変えていない。変えたのは次の 3 つだけ。

| ファイル | 変えた点 |
| --- | --- |
| `Cargo.toml` | 1 行目に変更の注記を足した。`members` と `default-members` から、入れなかった `crates/macos`・`crates/linux`・`crates/ffi` を外した。ほかは元のまま（`[profile.release.package.agent-desktop-macos]` も残したので、build の時に「どの package にも当たらない」という警告が 1 行出る） |
| `src/Cargo.toml` | 1 行目に変更の注記を足した。入れなかった crate を指す `[target.'cfg(target_os = "macos")'.dependencies]` の `agent-desktop-macos` と、`[target.'cfg(target_os = "linux")'.dependencies]` の `agent-desktop-linux` を外した |
| `Cargo.lock` | 上の 2 つの変更に合わせて、cargo が自動で落とした分だけ（`cargo update` はしていない）。macOS・Linux・FFI の 3 つの crate と、それらだけが使っていた 64 の package が消えた（追加・版の変更は無し）。残った 99 の package の版と checksum は元のまま |

## build と試験

- build: `node build-desktop-control.mjs`（Windows x64 の時だけ。ほかは何もせずに成功で終わる）。`cargo build --release --locked` を、`rust-toolchain.toml` が効くようにこのフォルダーで動かす。
- upstream の試験（`cargo test`）は、入れなかった `probes`・`tests`・`docs`・`.github` などのファイルを `include_str!` で読むものがあるので、このままでは compile できない。Sprint Coder の CI でも回していない。
