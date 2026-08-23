# Issue #318 実装計画

## 結論

Windowsの主要E2Eを専用Playwright設定で明示選定し、すべての通常CIで実行します。失敗時のtrace・screenshot・実行ログを必ず回収し、その成否を既存の `CI required` へ接続します。

## 受入条件

- **AC-1**: PR、main push、手動実行でWindows主要E2E jobが自動起動する。
- **AC-2**: keyboard smokeに加え、setup wizard、Composer、Settings、project/file、approval、Team UIを実行する。
- **AC-3**: macOS専用、実CLI、credential・課金・外部Provider依存のspecを明示的に除外する。
- **AC-4**: 失敗時にPlaywright trace、screenshot、HTML report、stdout/stderrログをartifactから取得できる。
- **AC-5**: retryは0で、テスト失敗はWindows job、`build (windows-2022)`、`CI required`を失敗させる。
- **AC-6**: 各specは既存の独立profileとmock runtimeを維持し、Linux/macOS/release workflowへ挙動変更を持ち込まない。
- **AC-7**: GitHub Actions上のWindows主要E2Eと必須テストがgreenになる。

## 実装

1. `playwright.windows.config.ts` を追加する。
   - `keyboard-smoke.spec.ts`、`setup-wizard.spec.ts`、`composer-input-boundaries.spec.ts`、`settings-dialog.spec.ts`、`project-sidebar.spec.ts`、`file-edits.spec.ts`、`approval-flow.spec.ts`、`team-flow.spec.ts` を明示列挙する。
   - `workers: 1`、`retries: 0`、`trace: retain-on-failure`、`screenshot: only-on-failure`、list＋HTML reporterを固定する。
   - macOS lifecycleと実CLI opt-in specが対象外である理由をコメントする。共通configは変更しない。
2. `.github/workflows/ci.yml` のWindows E2Eを全通常CIで実行する。
   - `full_matrix` 限定を外し、専用configをdev modeで実行する。
   - PowerShellの `Tee-Object` でstdout/stderrをログファイルへ保存し、native commandの終了コードを保持する。`continue-on-error` は付けない。
   - artifact uploadだけを `if: always()` とし、`test-results`、`playwright-report`、実行ログを回収する。成果物が無い場合はwarningにするが、テスト失敗はjob failureのままにする。
   - `windows-result` はfast/fullのどちらでもWindows E2E成功を要求する。
3. workflow/config回帰テストを追加または更新する。
   - 対象spec、除外方針、retry 0、trace/screenshot、artifact upload、常時実行、required連携を固定する。
4. 開発者向け文書へWindows対象の選定基準、除外規則、ローカル実行方法、成果物の場所を記録する。

## 検証

- 対象workflow/config回帰テスト。
- TypeScript型検査と変更ファイルのformat確認。
- Windowsで `npx playwright test --config playwright.windows.config.ts` を実行し、主要8specがgreenであることを確認する。
- PRの最新commitでWindows主要E2E、`build (windows-2022)`、`CI required` がgreenであることを確認する。
- 固定 `x-ai/grok-4.6` で最終差分をレビューし、未解決の重大指摘を0件にする。

## 非ゴール

- 実Provider API、実CLI credential、課金、コード署名、release workflow変更。
- macOS専用window lifecycleのWindows移植。
- E2Eで新たに見つかった製品不具合の同時修正。別Issueへ分離する。

<!-- issue-planner-id: issue=318; contract-version=1; plan-version=aa4acaafcbd70a978e26c571e001c08a89ca3c9b5af4f4575a722a5ec3ea9232; supersedes=none -->
