# Phase 5 — 潰す（1 Issue ずつの修正ループ）

対象は `$RUN_DIR/issues/index.json` の Issue（依頼で「既存の open bug も」とあれば `gh issue list --label bug --state open` も）。severity（P0 → P3）順、同 severity なら E2E 由来 → 実 AI 由来の順。**並列に merge しない。** 1 件 merge してから次を rebase する。

## 0. 前提

- 司令塔は Fable のまま。実装は `Agent(subagent_type: "general-purpose", model: "opus", isolation: "worktree")` に委譲する（memory: fable-commander-opus-workers）。
- worker には Issue 番号、root-cause gate の結論、触ってよいファイル範囲、追加する回帰テスト、**触ってはいけないもの**（E2E の assertion 緩和、`--retries`、`test.skip`、security allowlist の拡張）を渡す。
- worker の報告は信用せず、司令塔が worktree で検証コマンドを自分で流す。

## 1. root-cause gate（司令塔）

[root-cause-guardrail](../../../../.agents/skills/root-cause-guardrail/SKILL.md) の「Root Cause Confirmed」を満たすまで実装しない。

- 症状の再現（Phase 1 / 3 の証拠）
- 入力から観測点までの経路と `file:line + symbol`
- コード読解以外を含む 2 種類以上の独立証拠（vitest の最小失敗、app.log、DB / ファイルの前後差、E2E の trace）
- 有力な代替原因を 1 つ実測で除外
- 修正後に同じ観測点で何が変わるか

満たせなければ `fix_hold` として Issue 番号と不足証拠を report に書き、次の Issue へ。
memory `sprint-coder-patrol-lessons` の教訓: 起票時の前提が runtime 事実（Electron 内蔵 Node、最近の機能削除、security 影響）で覆ることがある。gate の段階で `git log --since=1.month -- <file>` と Electron の Node version を確認する。

## 2. worktree と branch

```bash
git -C /path/to/sprint-coder fetch origin main
# Agent(isolation: "worktree") が作る worktree を使う。手で作るなら:
git worktree add "$HOME/sprint-coder-fix-<n>" -b fix/issue-<n>-<slug> origin/main
cd "$HOME/sprint-coder-fix-<n>" && npm ci && npm run prepare:desktop --workspace @sprint-coder/desktop
```

fresh worktree は native を build しないと E2E がアプリのバグのように落ちる（memory: sprint-coder-native-prereqs）。`npm ci` が install script を skip したら `node node_modules/electron/install.js` も要る。

## 3. 実装（Opus worker）

- 最小修正 + 原因に隣接する回帰テスト（vitest。E2E で守るべきものなら該当 spec の追加/修正）。
- `[test]` Issue（spec 陳腐化）は spec を実装に合わせる。assertion を緩めて通すのは禁止（`toHaveText` → `toContainText`、timeout 延長、expect 削除）。
- commit message は日本語の Conventional 形式（例: `fix: 承認後のコマンド結果をカードへ反映する`）。末尾に `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。

## 4. 検証（司令塔、worktree 内で自分で流す）

```bash
npm run typecheck
npm run lint
npm run test --workspace @sprint-coder/desktop -- src/main/<近接ファイル>.test.ts   # SQLite/Electron bridge 系は -t を使わず file 単位（memory: sprint-coder-vitest-electron-bridge）
SPRINT_CODER_E2E_MODE=dev npx playwright test tests/e2e/<spec-map で選んだ spec> tests/e2e/keyboard-smoke.spec.ts tests/e2e/a11y-axe.spec.ts
```

- 実 AI 由来の Issue は、その worktree で `ensure-dev-server.sh` / `launch-dev-instance.sh --repo-root <worktree>` を使って該当 lane の case を 1 回だけ再実行し、FAIL が PASS になることを Computer Use で確認する（port 5173 は 1 つの checkout しか使えないので、開発者の dev server が別 checkout で動いていれば `blocked_artifact`。その場合は E2E の再現 spec を追加して代替し、report にその旨を書く）。
- Team / Graph / worker runtime / managed harness を触った修正は、memory `sprint-coder-real-worker-e2e-gap` の opt-in（`SPRINT_CODER_LEADER_MCP=1` 等）を **ユーザーに確認してから** 流す。

## 5. PR

```bash
git push -u origin fix/issue-<n>-<slug>
gh pr create --base main --title "fix: <症状が消える日本語タイトル>" --body-file <body>
```

本文: 症状 / 原因（file:line + mechanism）/ 修正 / 検証（実行したコマンドと結果、未実行範囲）/ `Closes #<n>` / 末尾に `🤖 Generated with [Claude Code](https://claude.com/claude-code)`。

## 6. レビュー BOT

CLAUDE.md の手順どおり BOT の結果を待つ。2026-09 時点で webhook は停止しており、memory `sprint-coder-review-bot` の手順で `ssh yusei2` から手動起動する（20〜40 分。`usageLimitExceeded` で落ちたら Claude fallback を待ち、それでも駄目なら `review_hold`）。指摘は同じ branch へ commit して再レビュー。承認（approve / actionable finding 0）を `gh pr view --json reviews,reviewDecision` で確認する。unverified の finding は一次資料で自分で確かめてから直す。

## 7. merge と close

```bash
gh pr merge <pr> --squash --delete-branch
```

merge 後に [issue-closeout](../../../../.agents/skills/issue-closeout/SKILL.md) の Close Gate を当て、`gh issue view <n> --json state` で `CLOSED` を確認する（`Closes #n` で自動 close されなければ `gh issue close <n> --comment "<PR URL> で修正"`）。次の worktree を `git rebase origin/main` してから続ける。

## 8. 停止条件

- `fix_hold`: root cause 未確定
- `review_hold`: BOT が承認しない / 動かない
- `verify_hold`: 検証コマンドが通らない、または修正が Issue の観測点を変えない
- `scope_hold`: 修正が security allowlist の拡張や仕様変更を伴う → ユーザーに判断を返す

hold の Issue は open のまま、report に理由と次に必要な最小証拠を書く。
