---
name: sprint-coder-e2e-windows
description: Windows（PowerShell / cmd）環境で sprint-coder の Playwright Electron E2E（tests/e2e/）を実行し、結果を pass / 既知flake / 意図的skip / 本物の失敗 に判定するための手順。Windows 上で「E2E を流して」「動作確認して」「回帰していないか見て」「golden path を確認して」と言われたとき、および renderer / main / runtime-host / preload を変更したあとに動作を確かめるときは必ずこのスキルを読むこと。PowerShell での環境変数の渡し方、dev server を先に手動起動しなければならない理由、packaged / dev モードの選択、ポートとプロセスの確認・掃除（taskkill）、変更箇所から実行対象 spec を選ぶ方法、失敗の切り分けと報告フォーマットを含む。macOS / Linux 向けの手順（`VAR=value command` 形式や lsof / pkill）をそのまま貼ると Windows では動かないので、実行前に必ず参照する。
---

# sprint-coder E2E の実行と判定（Windows 版）

このリポジトリの E2E は Playwright の **Electron** ドライバで実アプリを起動する。ブラウザテストではないので web の常識（`page.goto`、`--headed`、trace viewer、リトライで緑にする）はほぼ当てはまらない。そして Windows では、失敗の大半が**アプリのバグではなく起動の段取り**に由来する。走らせる前に段取りを確定させる。

> **この文書の検証状況**: Windows 固有の記述は [tests/e2e/helpers.ts](../../../tests/e2e/helpers.ts) / [tests/e2e/global-setup.ts](../../../tests/e2e/global-setup.ts) / [playwright.config.ts](../../../playwright.config.ts) の実装（`process.platform === 'win32'` 分岐を含む）から導いたもので、Windows 実機での実行は未検証。実際に走らせて食い違いがあれば、推測を残さずこのファイルを直すこと。

## 1. 実行前に確定させる 3 つのこと

### (a) 環境変数は PowerShell の書き方で渡す

macOS / Linux の `SPRINT_CODER_E2E_MODE=dev npx playwright test ...` という書き方は **PowerShell では動かない**（`SPRINT_CODER_E2E_MODE=dev` がコマンド名として解釈される）。

```powershell
# PowerShell（このセッションの間ずっと有効になる点に注意）
$env:SPRINT_CODER_E2E_MODE = 'dev'
npx playwright test tests/e2e/golden-path-2-cancel.spec.ts
```

```bat
:: cmd.exe
set SPRINT_CODER_E2E_MODE=dev
npx playwright test tests/e2e/golden-path-2-cancel.spec.ts
```

`$env:` はそのシェルセッションに残り続けるので、あとで packaged モードを試すときは `$env:SPRINT_CODER_E2E_MODE = 'packaged'` と明示的に上書きするか、`Remove-Item Env:SPRINT_CODER_E2E_MODE` で消す。**前のテストの残り値のまま走らせて結果を誤読するのが一番ありがちな事故。**

### (b) dev モードで走らせるなら、dev server を自分で先に起動しておく

globalSetup は 5173 に何か listen していればそれを再利用し、無ければ自分で `npm start` を起動しようとする。**この自動起動は Windows では成立しない**: `spawn('npm', ...)` を `shell` 無しで呼んでいるため、Windows では `npm.cmd` を解決できず ENOENT になる（helpers.ts の `ensureDevServerReady`。`error` ハンドラも無いので globalSetup ごと落ちる）。

したがって Windows での正しい順序は:

```powershell
# ターミナル1: 先に起動して、Electron ウィンドウが出るまで待つ
npm start
```

```powershell
# ターミナル2: 5173 が listen していることを確認してから流す
Get-NetTCPConnection -LocalPort 5173 -State Listen
$env:SPRINT_CODER_E2E_MODE = 'dev'
npx playwright test tests/e2e/live-file-edit.spec.ts
```

この順序なら globalSetup は「既存を再利用」パスに入り、自動起動の不発を踏まない。副作用として、**テストが終わっても dev server は落ちない**（自分で起動していないものには手を出さない設計。Windows では `stopDevServer` の後片付け自体も無効化されている ── 負の PID への signal は Windows に存在せず、`ps` ベースの子孫列挙も win32 では空配列を返す）。ターミナル1 の `npm start` は自分で Ctrl+C する。

### (c) テスト同士・開発中インスタンスとの衝突は既に解決済み

各 spec は `createUserDataDir()` で隔離した `SPRINT_CODER_USER_DATA_DIR`（`%TEMP%` 配下）を使うので、SQLite も single-instance lock も独立している。「別のアプリが起動中だから落ちた」という仮説を立てる前に、他の原因を潰すこと。

## 2. dev と packaged のどちらで走らせるか

| | dev | packaged |
|---|---|---|
| 起動対象 | `node_modules/electron` の Electron が `apps/desktop` を直接ロード（renderer は Vite dev server） | `apps/desktop/out/<name>-win32-x64/*.exe` |
| 事前準備 | 別ターミナルで `npm start`（上記 (b)） | 不要。ソースが新しければ globalSetup が `electron-forge package` を自動実行（数分〜10分） |
| `a11y-axe.spec.ts` | **通る**（dev の CSP が `script-src 'self' http://localhost:*` を許可しており、axe をローカル HTTP で注入できる） | **原理的に通らない**（packaged の CSP に localhost 例外が無い） |
| 使いどころ | 日常の開発・回帰確認 | リリース前に「配布物そのもの」を検証したいとき |

macOS 側の手順書は「packaged は使うな」と言い切っているが、あれは **その環境固有**の話（`@electron/packager` の zip 展開が `electron.icns` で決定論的にハングする）。Windows でも同じ症状が出るとは限らないので、packaged を試すこと自体は妥当。ただし:

- `apps/desktop/out/` に**古いビルドが残っていると、モード無指定のとき黙ってそれが起動する**（`resolveE2EMode()` は out/ の中身の有無だけを見て packaged を選び、`findPackagedExecutable()` はディレクトリ名に `win32` を含むものを拾う）。globalSetup がソース mtime と `.e2e-package-stamp` を比較して stale なら再パッケージするが、モードを明示しない限りそもそもどちらで走ったのか読み手に伝わらない。**常にモードを明示する。**
- packaged で `a11y-axe` が落ちたら、それは環境の話であってアクセシビリティの退行ではない。

## 3. 実行コマンド

```powershell
$env:SPRINT_CODER_E2E_MODE = 'dev'

# 単一 spec（最頻。まずこれ）
npx playwright test tests/e2e/live-file-edit.spec.ts

# テスト名で絞る
npx playwright test tests/e2e/inspector-panel.spec.ts -g "五段階"

# 複数 spec
npx playwright test tests/e2e/team-cables.spec.ts tests/e2e/team-morph.spec.ts

# 全 29 ファイル / 78 テスト（workers:1 の直列実行なので数分〜十数分）
npm run e2e

# 何が定義されているかだけ見る（アプリを起動しないので速い）
npx playwright test --list
```

パス区切りはスラッシュのままでよい（Playwright が解釈する）。全件は長いので、ログをファイルに落として終了後に末尾を読むのが確実:

```powershell
npm run e2e *> $env:TEMP\e2e.log
Get-Content $env:TEMP\e2e.log -Tail 40
```

設定は `workers: 1` / `fullyParallel: false` / `retries: 0` / test timeout 90s / expect timeout 15s。**リトライが 0 なのは意図的**で、1 回落ちたら落ちたと判断する設計。緑にするために `--retries` を足すのは判定そのものを壊す行為なのでやらない。

## 4. どの spec を走らせるか

変更が触れた領域から選ぶ。対応表は [references/spec-map.md](references/spec-map.md)（spec → 何を守っているか → どんな変更のとき走らせるか）。迷ったら:

- UI コンポーネント 1 つの変更 → 対応する spec + `keyboard-smoke` + `a11y-axe`
- main / IPC / 永続化の変更 → `golden-path-1`（再起動復元）と該当機能の spec
- runtime-host / normalizer の変更 → `golden-path-1/2/3` + `reasoning-pill` + `live-file-edit`
- 広い or 自信がない変更 → 全件

全件を避けたときは、**何を走らせなかったかを報告に書く**。「E2E 通りました」とだけ言うと、走らせていない 60 テストまで緑だったように読まれる。

## 5. 結果の判定

`list` reporter の最終行が一次情報。`N passed` 以外（`failed` / `timed out` / `interrupted`）は全部 fail 扱いにしたうえで、中身を次の 4 つに切り分ける。切り分けないまま「E2E が落ちています」と報告するのは、判定を放棄して相手に丸投げしているのと同じ。

### (1) 環境起因（アプリは無罪）

| 症状 | 原因 | 対処 |
|---|---|---|
| `Dev server / main build did not become ready within 90000ms`、または globalSetup が spawn 系のエラーで即死 | dev モードなのに `npm start` を先に起動していない（Windows では自動起動が効かない） | ターミナル1 で `npm start` → 5173 の listen を確認 → 再実行 |
| `Get-NetTCPConnection -LocalPort 5173` が何も返さない | dev server が落ちている | `npm start` を起動し直す |
| 覚えのない `electron-forge package` が走り出す / 起動が異様に遅い | packaged モードで走っている（環境変数の消し忘れ・未指定） | モードを明示して再実行 |
| `a11y-axe.spec.ts` だけ落ちる | packaged モードで走っている（CSP に localhost 例外が無い） | dev モードで再実行 |
| `npm run format:check` が全ファイル未整形と言う | `core.autocrlf=true` で CRLF に変換された | `.gitattributes` が `eol=lf` を指定しているので、clone/checkout し直すか改行を LF に戻す（E2E とは別問題だが Windows で必ず踏む） |
| 起動直後に全 spec が同じ形で即死 | ビルド壊れ | `npm run typecheck` を先に通す |

### (2) 意図的な skip

`leader-mcp-smoke.spec.ts` の 2 テストは `$env:SPRINT_CODER_LEADER_MCP = '1'` が無いと skip される。実 Claude CLI を叩いて**実際に課金される** opt-in smoke なので、緑を増やすために勝手に有効化しない。skip は失敗ではない。

### (3) 既知の flake

`command-runner-flow.spec.ts` の focus 系アサーションは以前から不安定で、変更のないコミットでも落ちる（macOS の dev モードで確認済み。Windows でも同種のフォーカス依存は不安定になりやすい）。ここが落ちたときは自分の変更のせいと決めつける前に、変更前の状態（`git stash` するか元コミットを checkout）で同じ spec を走らせて、同じように落ちるか確かめる。**この比較をやらずに「既知の flake です」と書くのは、推測を事実として報告することになる。**

### (4) 本物の失敗

上のどれでもないもの。次の 3 点をログから拾う（これが揃わないと相手は判断できない）:

- 落ちたテストのフルタイトル（`spec.ts:行 › describe › test`）
- expect の期待値と実測値（`Expected: ... Received: ...`）と、どの locator / testid を見ていたか
- 変更前でも落ちるかどうか（回帰なのか元からなのか）

E2E は実 DOM を testid とアクセシブルネームで掴んでいる（`composer-textarea`、`run-card`、`data-run-status` 属性、`役割/目的/依頼` ラベル、`{state} · Worker N/3` の完全一致テキストなど）。**UI の文言や testid を変えたなら、落ちているのはテストの側が古いのであって、アプリの不具合ではない**ことが多い。その場合は spec を実装に合わせて直すのが正しく、逆にアサーションを緩めて（`toHaveText` → `toContainText`、タイムアウト延長、`expect` 削除）通すのは、そのテストが守っていた保証を黙って捨てる行為なので、必要だと判断したら理由を添えて明示的に相談する。

`perf-budgets.spec.ts` は `console.info` で実測値（startup / composer p95 / fps）を出す。アサーションは CI 安全な緩い上限なので、**通っていても実測値をログから拾って報告する**と性能劣化に気づける。なお Windows の実測値は macOS の記録（起動 396ms、composer p95 14.2ms、10 Worker pan 60fps）とは別物なので、比較するなら同じ OS 同士で。

## 6. プロセスとポートの確認・掃除

```powershell
# 5173 を掴んでいるプロセス
Get-NetTCPConnection -LocalPort 5173 -State Listen | Select-Object OwningProcess
Get-Process -Id (Get-NetTCPConnection -LocalPort 5173 -State Listen).OwningProcess

# 取り残された Electron（テストが異常終了した後など）
Get-Process electron -ErrorAction SilentlyContinue | Format-Table Id, StartTime, Path

# どうしても残ったものだけを、PID を指定して落とす（子プロセスごと）
taskkill /PID <pid> /T /F
```

`Stop-Process -Name electron` や `taskkill /IM electron.exe /F` のような**名前一括指定は使わない**。同じ Electron ランタイムで動いている他のアプリ（VS Code、Slack、Discord など）や、開発者がターミナル1 で回している `npm start` まで巻き込んで落とす。落とすなら必ず PID を確認してから。

## 7. 報告フォーマット

```
実行: ($env:SPRINT_CODER_E2E_MODE = 'dev') npx playwright test <対象>   / OS: Windows
結果: N passed / M failed / K skipped （所要 X 秒）

[失敗があれば]
- <spec.ts:行 › テスト名>
  期待: ... / 実測: ...
  切り分け: 環境起因 / 既知flake（変更前でも再現: yes|no）/ 本物の失敗
  推定原因: ...

未実行: <走らせなかった範囲と理由>
```

## 8. やらないこと

- `Stop-Process -Name electron` / `taskkill /IM electron.exe` などの名前一括 kill（無関係なアプリと開発者の dev server を巻き込む）
- `--retries` を足す、`test.skip` で落ちるテストを黙らせる、アサーションを緩める
- モードを明示せずに走らせる（out/ の残骸で packaged が黙って選ばれ、古いビルドを検証してしまう）
- `$env:SPRINT_CODER_LEADER_MCP = '1'` を勝手に付ける（実 CLI・実コスト）
- 一部だけ走らせて「E2E 通りました」と書く（範囲を必ず添える）
