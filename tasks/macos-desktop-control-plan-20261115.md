# macOS 版デスクトップ操作の作成計画（2026-11-15）

オーナーの指示（2026-11-15）: 「macOS は完全に非対応なので対応させる。agent-desktop を見て作る。まず計画を立て、余計なことはせず、どうしても難しい問題は Issue に上げ、とりあえず使えることを目標にする。Apple の公証は今は使えないので、使えないまま試験する。」

## 1. 到達点

macOS（Apple シリコン）の Sprint Coder で、AI がデスクトップ操作を使える。具体的には次ができること。

- 起動中のアプリの窓を読む（snapshot・find・get）
- ボタンを押す、文字を入れる、メニューを選ぶ（click・type・set-value・select）
- アプリを名前で起動する（launch）
- Stop で操作が止まる
- Sprint Coder 自身の窓は、どの権限でも操作できない

最初の到達点は「開発版（`npm start`）で、実 AI がテキストエディットと計算機を操作できる」こと。配布物への同梱は、その次の段階で行う。

## 2. 今の状態（調査で確かめた事実）

### 2.1 Sprint Coder 側

- デスクトップ操作は、`apps/desktop/desktop-control` に取り込んだ agent-desktop 1.2.0（Rust の CLI）を、`exec_command` の経路で 1 コマンド 1 プロセスとして起動する。専用の IPC は無い。
- `desktopControlSupported` が `win32 && x64` だけ true を返す。macOS では AI への案内・Team の項目・承認カードがすべて出ない。
- **macOS で止めてある直接の理由は、起動の規則。** `prepareExecutionImage` は、macOS では `/usr/bin` など root 所有の場所にある実行ファイルしか起動を許さない（`macOS cannot safely launch this mutable native execution image`）。アプリに同梱した実行ファイルは通らない。
- 先例がある。sandbox runner は、同梱の実行ファイルを SHA-256 の照合の後にパスで起動していて、`prepareExecutionImage` を通らない。
- macOS の状態の置き場所が未設定（`configureDesktopControlStateRoot` が win32 だけ）。POSIX の runner は `HOME` を渡さない。
- 起動の名前解決（スタートメニュー）、許可しないアプリの一覧、AI への案内文、ブラウザーの一覧は Windows の名前で書かれている。
- 配布の設定（`forge.config.ts`）、build（`build-desktop-control.mjs`）、CI の準備（`prepare-desktop-control`）は Windows だけ。

### 2.2 agent-desktop 1.2.0 の macOS 実装

- **常駐プロセス（command host）は 1.1.0 で削除済み。** 1 コマンド 1 プロセスで、Windows と同じ形で使える。11 月 1 日の検証（1.0.2）で見つけた「権限を借りられる」「Stop の後に書き込みが届く」は、この作りでは起きない。
- `crates/macos` は Rust 約 3.5 万行（試験を除く）と Objective-C 約 2,400 行。取り込み済みの core に合わせると、compile エラーは 4 件だけ（`LaunchResult` の新しい欄が 2 か所、`LocatorRefEvidence.runtime_id` が 2 か所）。
- 権限は、起動元のアプリに付く（Sprint Coder.app、開発版では Electron.app）。通常のコマンドは権限の確認の画面を出さず、無ければ `PERM_DENIED` を返す。
- 窓の id は `w-<CGWindowID>`、プロセスの識別は `macos-proc-v1:<開始秒>:<マイクロ秒>`。
- 起動は、アプリの表示名か bundle ID だけを受け取り、LaunchServices で解決する。`--activate` を付けなければ前面に出さない。
- クリップボードは、別の実行ファイル（`agent-desktop-macos-helper`）が要る。
- Stop で残り得るもの: すでに送った AX の呼び出し（Windows の UIA と同じ）、自分のプロセスグループを持つ子（screencapture、osascript、カーソルの描画）。

### 2.3 この Mac の試験の環境

- 開発版の Electron.app（ad-hoc 署名）には、アクセシビリティと画面収録の許可が付いている。`open` で起動すれば、その子プロセスも許可を使える（実測）。
- シェルから直接起動した場合は、許可が無い（`PERM_DENIED`）。
- upstream の 1.2.0 の macOS 版は build でき、アプリの一覧までは許可なしで動く。

## 3. 設計の判断

| # | 判断 | 理由 |
| --- | --- | --- |
| D1 | `crates/macos` は upstream の同じ commit（1.2.0、`2b0a7334`）から取り込む | 取り込み済みの core と版が合う。1.3 系へ上げると、Windows 用に直した core の付け替えが要る |
| D2 | 対象は Apple シリコンだけ | 配布物が arm64 だけ。build は host と同じ arch しか作れない |
| D3 | macOS の起動の規則に、同梱の実行ファイルだけの例外を足す。条件は「パスが同梱の実行ファイルそのもの」「中身の SHA-256 が封印と一致」「相対の読み込みパスを持たない」「Workspace の外」。満たせばパスで起動する | sandbox runner と同じ扱い。それ以外の実行ファイルは今のまま拒否する |
| D4 | Sprint Coder 自身の窓を操作させない仕組みを、macOS の adapter にも入れる。有効にする PR より前に入れる | 安全に関わる。Windows は `own_window.rs` で実装済みで、macOS は素通しになっている |
| D5 | 最初の段階では、Team のカーソルは macOS では切る | カーソルの描画は別プロセスで、Windows 用の起動と終了の仕組みに依存している。基本の操作には要らない |
| D6 | 最初の段階では、クリップボードの書き込みと `launch --url` は macOS では使えないままにする | 別の実行ファイルの同梱と、ブラウザーの一覧の Mac 版が要る。基本の操作には要らない |
| D7 | `launch` の解決先は、標準のアプリの場所に限る（`/Applications`、`/System/Applications`、`/System/Library/CoreServices`、`~/Applications`） | LaunchServices は、Workspace の中に置かれたアプリも解決し得る。Windows の「標準のフォルダーだけ」と同じ線を引く |
| D8 | 状態の置き場所は `userData/desktop-control`（0700）にし、`AGENT_DESKTOP_HOME` で渡す | `HOME` が渡らないので既定の `~/.agent-desktop` は使えない。refmap に欄の文字が入るので、他から読めない場所にする |
| D9 | 公証・release・tag には触らない。試験は未署名の手元 build で行う | オーナーの指示 |

## 4. 段階

PR は 1 件ずつ出し、merge してから次へ進む。実装は Codex、指揮と検証は Claude（AGENTS.md の役割分担）。

### 段階 1: macOS 用の実行ファイルを build できるようにする（機能は無効のまま）

- `crates/macos` を upstream の 1.2.0 からそのまま取り込む（1 つ目の commit。中身は upstream と同一）。
- workspace と `src/Cargo.toml` に macOS を戻し、`Cargo.lock` に macOS 用の依存を戻す。
- core に合わせて compile を通す（4 件）。
- D4: macOS の adapter に、`SPRINT_CODER_DESKTOP_REFUSED_WINDOW_OWNER` の拒否を入れる。
- D7: `launch` の解決先の制限を入れる。
- `build-desktop-control.mjs` を darwin-arm64 でも動かす。出力は `build/Release/sprint-coder-desktop-control` と `.sha256`。
- `VENDORED.md` に、入れたものと変えたファイルを書く。
- `desktopControlSupported` は変えない（macOS では無効のまま）。

受入条件:

- macOS で `node build-desktop-control.mjs` が成功し、実行ファイルと封印ができる。
- Windows の build の手順と出力が変わらない。
- 取り込んだ Rust の試験（操作を伴わないもの）が macOS で通る。
- 開発版の Electron から起動して、テキストエディットで snapshot・click・type が動く。
- 拒否の変数に Electron の pid を入れると、その窓への操作が `POLICY_DENIED` になり、読み取りは通る。
- 標準の場所の外にあるアプリの `launch` が拒否される。

### 段階 2: 開発版で有効にする

- D3: 起動の規則の例外。
- `desktopControlSupported('darwin', 'arm64')` を true にする。実行ファイルの名前とパスを OS で分ける。
- D8: 状態の置き場所。
- 自身の識別（`darwin:` の開始時刻を `macos-proc-v1:` の形にする）と、`launch` で Sprint Coder 自身を拒否する判定の Mac 版。
- アプリ単位の許可を出さないアプリの一覧（Finder、Dock、端末、ブラウザーなど）と、`.app` の扱い。
- AI への案内文と skill の参照を macOS 用にする。権限が無い時（`PERM_DENIED`）に、利用者へ何を頼むかを案内に入れる。
- D5・D6 の切り方（Team のカーソル、クリップボードの書き込み、`launch --url`）。
- 「macOS では無効」を固定している試験を直す。

受入条件:

- 関係する Vitest、typecheck、lint が通る。
- 開発版で、実 AI がテキストエディットに文字を入れ、計算機で計算できる。承認カードに対象と動きが出る。
- 操作の途中の Stop で、実行ファイルのプロセスが残らない。
- 実 AI に Sprint Coder 自身の窓を操作させようとしても、拒否される。
- Windows の試験が変わらず通る。

### 段階 3: 配布物に入れる

- `forge.config.ts`: macOS の `Contents/Resources` に実行ファイルと封印を入れ、署名の後に封印を作り直す（sandbox runner と同じ順）。
- CI の `prepare-desktop-control` と cache を macOS でも動かす。release の workflow の build の段を macOS でも動かす。
- 手元で `npm run package` を行い、実行ファイル・封印・ad-hoc 署名を確かめる。
- README の記載。

受入条件:

- 手元の package の中の実行ファイルが封印と一致し、`codesign --verify --deep --strict` が通る。
- 配布の設定の試験と workflow の試験が通る。
- 公証を通した配布物での確認は、オーナーの合図の後に行う（未実施として残す）。

### 段階 4: 残りを足す（影響の大きい順）

- 権限の案内を画面に出す（設定の中に状態と「システム設定を開く」）。
- Team のカーソルを macOS でも出す。
- クリップボードの書き込み（別の実行ファイルの同梱）。
- `launch --url`（ブラウザーの一覧の Mac 版）。
- フルアクセスの説明文の「エクスプローラー」を macOS では Finder にする。
- Website と release の本文の「Windows だけ」の記載。配布する時に直す。

## 5. 対象外

- Intel の Mac、Linux。
- 公証、release、tag、既存の 0.8.0 への macOS 版の追加（[Issue #1315](https://github.com/Robbits-CO-LTD/sprint-coder/issues/1315)）。
- agent-desktop の版上げ（1.3 系）。
- 以前の「Computer Use（ベータ）」の DB の表の整理。

## 6. 試験の方針

- 途中の検証は、変えたファイルの近くの試験・型検査・lint に絞る。
- 実機の試験は、この Mac の開発版（`open` で起動した Electron.app）で行う。許可は付いているので、設定の操作は要らない。
- 製品の経路の試験は、`sprint-coder-computer-use-real-ai-test` Skill に従い、Sprint Coder の中の実 AI（Claude CLI・Codex CLI）に操作させる。開発エージェントの代行や内部の seam の成功で代えない。
- 手元の package（ad-hoc 署名）は、build のたびに識別が変わり、許可を付け直す必要がある。そのため、package での実操作はオーナーが戻ってから行い、それまでは構造の確認までにする。
- Windows の実機の確認は、この計画の中ではできない。共有のコードを変えた分は、試験と CI の Windows の compile で守る。

## 7. Issue に上げる条件

その場で解けない次のような問題は、Issue に上げて先へ進む。

- 特定のアプリで、裏の操作が前面を取る・効かない。
- Stop の後に残る子プロセスが、利用者の操作を邪魔する。
- 公証を通した配布物でしか確かめられない問題。

## 8. 残りの一覧

段階ごとに、直さずに残したものをここに足す。

### 段階 1 の独立レビューで出て、残したもの

安全の規則（自身の窓の拒否）に関わるもの:

- 通知の command: Sprint Coder が前面にある時、通知センターを閉じる Escape や、前面の戻しが拒否される。その時、通知への操作は届いた後なのに「何も送っていない」と返る。
- Chromium の窓の読み取りの前に行う有効化（`activate_renderer_accessibility`）も拒否の対象なので、Sprint Coder 自身の窓の snapshot・find が `POLICY_DENIED` になり得る。「読み取りは拒否しない」という契約との差。害は無いので、そのままにしている。
- guard は、操作の範囲（scope）が設定されていない thread では通す作り。今はすべての経路に scope があるが、process 全体で持つ形に固めたい。
- Sprint Coder が前面にある時の、menu bar への物理クリックの扱いは未確認。
- 間接の経路（Dock からの終了、システム設定の切り替え、通知の action）は対象外。Windows も同じ。

動作と報告に関わるもの:

- drag が拒否された時に、どこでボタンを離したかを結果に出していない。
- 実行中のアプリへ接続する経路（attach）のエラーの一部に、「届いていない」の印が付かない。
- 拒否の変数がある時、宛先の無いキーと mouse の event ごとに、前面のアプリや窓の一覧を読む。遅さは実測していない。

取り込んだ upstream のコードに関わるもの:

- `AXValueGetValue` に渡す前の型の確認が無い箇所がある（`node_attribute_decode.rs` ほか）。相手のアプリが別の型を返した時の挙動は未確認。
- 起動のたびに、古い版（1.0 系）の常駐プロセスを探して終了させる処理（`stop_legacy_command_hosts`）が残っている。利用者が別に入れた古い agent-desktop に作用し得る。
- 権限が無い時の案内の文言が upstream のまま（「agent-desktop を起動するアプリ」）。
- screenshot の一時ファイルが、強制終了の時に `$TMPDIR` に残り得る。

試験と CI:

- PR の CI では macOS の Rust を compile しない。release の前の全試験と release の workflow で build する。
- CLI の試験（`cargo test -p agent-desktop`）は、取り込んでいない upstream のファイルを読むので compile できない。Windows と同じ。

### 段階 2 の独立レビューと実機の試験で出て、残したもの

安全に関わるもの:

- 開発版では、実行ファイルと封印が repo の中の同じフォルダーにあり、どちらも書き換えられる。Sprint Coder の repo を Workspace にした AI が両方を書き換えると、別の Workspace の Turn がそれを囲いの外で動かし得る。Windows の開発版と同じ。配布版は、署名済みのアプリの中に入る。
- アプリ単位の許可の判定に使う bundle ID は、その bundle の Info.plist の値をそのまま使う。署名は確かめていない。
- 状態の置き場所を 0700 にする処理に、確認と変更の間の隙がある。入れ替えられた時は、その後の確認で使わない側に倒れる。

使い勝手に関わるもの:

- Project を選んでいない Task で頼むと、AI は「デスクトップ操作の道具が渡されていない」と答える。Project を選ぶよう案内していない。
- アプリの名前で指す読み取り（`snapshot --app …`）は、「このアプリは Task 中許可」の後も毎回カードが出る。アプリ単位の許可は、ref と窓の id で指した操作だけが対象。
- `launch` を bundle ID で指した時、最初の 1 回は標準のアプリの場所の bundle を全部読むので、数秒かかることがある（Main の thread を止める）。
- 標準のアプリの場所のサブフォルダーにあるアプリは、「見つからない」と断る。
- 実行ファイルのパスに日本語などを含むアプリで、アプリ単位の許可が出るかは未確認（読めない時は出さない）。

試験:

- Claude CLI での実 AI の試験は未実施。`open` で起動した開発版が、Claude Code を「ログインが必要」と表示した。原因は調べていない。
- 物理の pointer とキーボード（`--headed`）、drag の実機の確認は未実施。
- 実 AI の試験の記録: `tasks/evidence/macos-desktop-control-real-ai-20261116.md`
