# 2026-07-29 Local Final Gate Evidence

## 対象

- Branch: `main`
- 最終hardening commit: `43d66e1`
- Environment: macOS arm64、packaged Electron、Node.js 22でpackage生成
- User data: 実ユーザー状態と分離した一時directory
- Workspace: `/Users/yusei/sprint-coder`

## 自動検証

全実装後の広いgateは一度だけ実行した。

- root typecheck、lint、test: green
- desktop unit: 106 files passed、1451 passed、37 skipped
- contracts: 30 passed
- domain: 284 passed
- packaged E2E: 86 passed、実CLI smoke 3件は通常suiteでskip
- production package build: green

Computer Useで検出した最終hardening後は、変更境界に限定して次を実行した。

```text
npm run typecheck
npm test -- --run \
  src/main/team-mcp-bridge.test.ts \
  src/main/team-coordinator.test.ts \
  src/renderer/components/TeamCanvas/cables.test.ts
npx eslint <touched files>
git diff --check
```

結果:

- targeted test: 21 passed、Windows named-pipe test 1 skipped on macOS
- typecheck、対象lint、diff check: green
- Node.js 22 production package: green

## Computer Use scenario A — 階層Team、通信、復元

実Codex Leaderへ、Sprint Coderの`team_*` MCPだけを使用するよう指示した。

- `team_list_models`の実測結果から、能力`unknown`を推測せずmodelを選択
- Leaderが深さ1 Manager「検証部長」を雇用
- Managerが深さ2 leaf「Package確認」「Desktop確認」を雇用
- 2 leaf executionを並列実行
- leaf間で結果を双方向送信し、双方が受信確認
- 各leafのidentity-bound終端reportをManagerが統合
- Managerのidentity-bound終端reportをLeaderが受信
- 全3 executionが`completed`
- package.jsonの読み取りだけを行い、ファイル変更なし
- production app再起動後も3 Worker階層、完了状態、Activity、通信履歴を復元

## Computer Use scenario B — running steer

実Codex Leaderと実CLI Workerで、running executionへ1回だけ指示修正した。

- initial executionが`running`であることをLeaderが確認
- `team_steer_execution`を1回実行
- attempt 1: `interrupted`、terminal reason `steered`
- 同一executionのattempt 2: `completed`
- identity-bound終端reportへ`STEER_DISPLAY_OK`を保存
- 元の割当を「配信失敗」と誤表示しないことをproduction Canvasで確認
- `⌘Q`から5秒以内にMain／Helper processが完全終了
- ファイル変更なし

## 実API

- OpenRouter: verification、catalog、`openrouter/free` streaming、resolution、usage、
  completionがgreen
- OpenAI、Anthropic、Gemini、xAI、Pack A/B: ローカル／GitHub Actionsに資格情報がないため未実行

未実行Providerをgreenとは記録しない。

## 3OS CI

- Latest run: `30398655748`
- macOS、Windows、Ubuntu jobはいずれもstep開始前にfailure
- GitHub annotation:
  `The job was not started because recent account payments have failed or your spending limit needs to be increased.`

これは製品test failureではないが、3OS CIをgreenとする証拠もない。

## 完成判定

- macOS local Team v2 Coreと実CLI Computer Use: green
- Multi-Provider／Compatibilityの実装とfixture／conformance: green
- Multi-Provider Initial GA、Pack A/B GA、UI U4 cleanup: 未達

残るrelease gateはGitHub Billing復旧後の3OS CIと、資格情報を用意したProvider別実API smokeである。
U4はこれらがgreenかつBLOCKER／CRITICAL 0件になるまで開始しない。
