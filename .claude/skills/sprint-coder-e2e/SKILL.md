---
name: sprint-coder-e2e
description: sprint-coder の Playwright Electron E2E（tests/e2e/）を正しく実行し、結果を pass / 既知flake / 意図的skip / 本物の失敗 に判定するための手順。「E2E を流して」「動作確認して」「回帰していないか見て」「golden path を確認して」と言われたとき、および renderer / main / runtime-host / preload を変更したあとに動作を確かめるときは必ずこのスキルを読むこと。実行モード（SPRINT_CODER_E2E_MODE=dev が事実上必須）、開発者の npm start を絶対に止めない前提、変更箇所から実行対象 spec を選ぶ方法、失敗の切り分けと報告フォーマットを含む。E2E を「とりあえず npm run e2e」で流すと環境起因の失敗をアプリのバグと誤読するので、実行前に必ず参照する。
---

# sprint-coder E2E の実行と判定

このリポジトリの E2E は Playwright の **Electron** ドライバで実アプリを起動する。ブラウザテストではないので、web の常識（`page.goto`、`--headed`、trace viewer、リトライで緑にする）はほぼ当てはまらない。実行の失敗はアプリのバグとは限らず、**起動モードの選択ミス**であることが最も多い。だから「走らせる」より先に「どのモードで走るか」を確定させる。

## 1. 実行前に確定させる 3 つのこと

**(a) モードは必ず `dev` を明示する。**

```bash
SPRINT_CODER_E2E_MODE=dev npx playwright test tests/e2e/<spec>.spec.ts
```

環境変数を省くと `resolveE2EMode()`（[tests/e2e/helpers.ts](../../../tests/e2e/helpers.ts)）は `apps/desktop/out/` の中身を見て `packaged` を選ぶ。そこには古い packaged build（`@vibe-desktop-darwin-arm64` — アプリ名が改名前のまま）が残っており、この環境では packaged 起動がハングする（`@electron/packager` の zip 展開が `electron.icns` で決定論的に止まる既知の環境バグ。アプリ側の不具合ではない）。さらに `a11y-axe.spec.ts` は dev モードの CSP 例外（`script-src 'self' http://localhost:*`）に依存しているので、packaged では原理的に通らない。**つまり dev 指定忘れは「テストが落ちた」ではなく「まだ何も試せていない」状態。**

**(b) 開発者の `npm start` は絶対に止めない。**

globalSetup は 5173 に何か listen していればそれを**そのまま再利用**し、無ければ自分で `npm start` を起動して、自分が起動した分だけ後片付けする。ユーザーが手元で回している dev インスタンスを `pkill electron` などで消すと、その人の作業を壊したうえに次の実行が遅くなるだけで、何の得もない。稼働状況は次で確認できる（`[::1]` で listen している点に注意。`127.0.0.1` への curl は失敗する）:

```bash
lsof -nP -iTCP:5173 -sTCP:LISTEN
```

**(c) テスト同士・開発者インスタンスとの衝突は既に解決済み。**

各 spec は `createUserDataDir()` で隔離した `SPRINT_CODER_USER_DATA_DIR` を使うので、SQLite も single-instance lock も独立している。「他のアプリが起動中だから落ちた」という仮説は、まずこの前提を疑う前に他の原因を潰すこと。

## 2. 実行コマンド

dev server が既に上がっていれば 1 spec は数秒で終わる。上がっていない場合、globalSetup が `npm start` を起動して ready を待つのに最大 90 秒かかる（これは失敗ではない）。

```bash
# 単一 spec（最頻。まずこれ）
SPRINT_CODER_E2E_MODE=dev npx playwright test tests/e2e/live-file-edit.spec.ts

# テスト名で絞る
SPRINT_CODER_E2E_MODE=dev npx playwright test tests/e2e/inspector-panel.spec.ts -g "五段階"

# 複数 spec
SPRINT_CODER_E2E_MODE=dev npx playwright test tests/e2e/team-cables.spec.ts tests/e2e/team-morph.spec.ts

# 全 29 ファイル / 78 テスト（workers:1 の直列実行なので数分〜十数分かかる）
SPRINT_CODER_E2E_MODE=dev npm run e2e

# 何が定義されているかだけ見る（アプリを起動しないので速い）
SPRINT_CODER_E2E_MODE=dev npx playwright test --list
```

全件実行は長いので、バックグラウンド実行してログをファイルに落とし、終わってから末尾を読むのが確実:

```bash
SPRINT_CODER_E2E_MODE=dev npm run e2e > /tmp/e2e.log 2>&1
```

設定（[playwright.config.ts](../../../playwright.config.ts)）は `workers: 1` / `fullyParallel: false` / `retries: 0` / test timeout 90s / expect timeout 15s。**リトライが 0 なのは意図的**で、1 回落ちたら落ちたと判断する設計。緑にするために `--retries` を足すのは、判定そのものを壊す行為なので絶対にやらない。

## 3. どの spec を走らせるか

変更が触れた領域から選ぶ。対応表は [references/spec-map.md](references/spec-map.md) にある（spec → 何を守っているか → どんな変更のとき走らせるか）。迷ったら:

- UI コンポーネント 1 つの変更 → 対応する spec + `keyboard-smoke` + `a11y-axe`
- main / IPC / 永続化の変更 → `golden-path-1`（再起動復元）と該当機能の spec
- runtime-host / normalizer の変更 → `golden-path-1/2/3` + `reasoning-pill` + `live-file-edit`
- 広い or 自信がない変更 → 全件

全件を避けたときは、**何を走らせなかったかを報告に書く**。「E2E 通りました」とだけ言うと、走らせていない 60 テストまで緑だったように読まれる。

## 4. 結果の判定

Playwright の `list` reporter の最終行が判定の一次情報。`N passed` 以外（`failed` / `timed out` / `interrupted`）は全部 fail 扱いにする。ただし fail の中身は次の 4 つに切り分ける。切り分けないまま「E2E が落ちています」と報告するのは、判定を放棄して相手に丸投げしているのと同じ。

**(1) 環境起因（アプリは無罪）**

| 症状 | 原因 | 対処 |
|---|---|---|
| ログに `electron-forge package` が流れ始める / `Packaged app not found` | dev モード指定忘れ | `SPRINT_CODER_E2E_MODE=dev` を付けて再実行 |
| `Dev server / main build did not become ready within 90000ms` | dev server が上がらない | `lsof -nP -iTCP:5173 -sTCP:LISTEN` で確認、手元で `npm start` が生きているか見る |
| 起動直後に全 spec が同じ形で即死 | ビルド壊れ（`.vite/build/index.js` が古い等） | `npm run typecheck` を先に通す |

**(2) 意図的な skip**

`leader-mcp-smoke.spec.ts` の 2 テストは `SPRINT_CODER_LEADER_MCP=1` が無いと skip される。実 Claude CLI を叩いて**実際に課金される** opt-in smoke なので、緑を増やすために勝手に有効化しない。skip は失敗ではない。

**(3) 既知の flake**

`command-runner-flow.spec.ts` の focus 系アサーションは dev モードで以前から不安定で、変更のないコミットでも落ちる。ここが落ちたときは自分の変更のせいと決めつける前に、変更前の状態（`git stash` するか元コミットを checkout）で同じ spec を走らせて、同じように落ちるか確かめる。**この比較をやらずに「既知の flake です」と書くのは推測を事実として報告することになる。**

**(4) 本物の失敗**

上のどれでもないもの。ここまで来たら、次の 3 点をログから拾う（これが揃わないと相手は判断できない）:

- 落ちたテストのフルタイトル（`spec.ts:行 › describe › test`）
- expect の期待値と実測値（`Expected: ... Received: ...`）と、どの locator / testid を見ていたか
- 変更前でも落ちるかどうか（回帰なのか元からなのか）

E2E は実 DOM を testid とアクセシブルネームで掴んでいる（`composer-textarea`、`run-card`、`data-run-status` 属性、`役割/目的/依頼` ラベル、`{state} · Worker N/3` の完全一致テキストなど）。**UI の文言や testid を変えたなら、落ちているのはテストの側が古いのであって、アプリの不具合ではない**ことが多い。その場合は spec を実装に合わせて直すのが正しく、逆にアサーションを緩めて（`toHaveText` → `toContainText`、タイムアウト延長、`expect` 削除）通すのは、そのテストが守っていた保証を黙って捨てる行為なので、必要だと判断したら理由を添えて明示的に相談する。

`perf-budgets.spec.ts` は `console.info` で実測値（startup / composer p95 / fps）を出す。アサーションは CI 安全な緩い上限なので、**通っていても実測値をログから拾って報告する**と性能劣化に気づける。

## 5. 報告フォーマット

```
実行: SPRINT_CODER_E2E_MODE=dev npx playwright test <対象>
結果: N passed / M failed / K skipped （所要 X 秒）

[失敗があれば]
- <spec.ts:行 › テスト名>
  期待: ... / 実測: ...
  切り分け: 環境起因 / 既知flake（変更前でも再現: yes|no）/ 本物の失敗
  推定原因: ...

未実行: <走らせなかった範囲と理由>
```

## 6. やらないこと

- `pkill -f electron` など、他人のプロセスを巻き込む止め方（開発者の `npm start` を殺す）
- `--retries` を足す、`test.skip` で落ちるテストを黙らせる、アサーションを緩める
- packaged モードで粘る（この環境では通らないと確定している）
- `SPRINT_CODER_LEADER_MCP=1` を勝手に付ける（実 CLI・実コスト）
- 一部だけ走らせて「E2E 通りました」と書く（範囲を必ず添える）
