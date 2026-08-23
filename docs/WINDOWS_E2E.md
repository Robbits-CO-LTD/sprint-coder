# Windows主要E2E

GitHub Actionsの `Windows major E2E` は、PR、mainへのpush、手動実行のすべてで起動します。Windows固有のパス、入力、Electron起動の回帰を、マージ前に検出するためのテストです。

## 対象

対象は `playwright.windows.config.ts` で明示します。

| 領域             | spec                                                          |
| ---------------- | ------------------------------------------------------------- |
| 初回セットアップ | `setup-wizard.spec.ts`                                        |
| Composer         | `composer-input-boundaries.spec.ts`、`keyboard-smoke.spec.ts` |
| Settings         | `settings-dialog.spec.ts`                                     |
| Project / file   | `project-sidebar.spec.ts`、`file-edits.spec.ts`               |
| Approval         | `approval-flow.spec.ts`                                       |
| Team UI          | `team-flow.spec.ts`                                           |

各specは専用のprofileを使い、Mock RuntimeとCLI fixtureを固定します。実Provider API、課金、外部通信は使いません。実行順は直列で、失敗時の再試行はしません。

## 除外

- `macos-window-lifecycle.spec.ts`: macOS専用のwindow lifecycleを扱うため。
- `leader-mcp-smoke.spec.ts`、`leader-mcp-codex-smoke.spec.ts`: 実CLIとcredentialを必要とするopt-inテストのため。
- コード署名、実Provider、実課金を必要とするテスト: このCIの対象外。

新しいspecを追加するときは、Windowsで外部credentialなしに決定的に動作することを確認し、設定の明示リストとこの表を同時に更新します。暗黙のskipやファイル名の広いglobだけで対象を増やしません。

## ローカル実行

Node.js 22と依存関係を用意し、Windows PowerShellから実行します。

```powershell
npm ci
npx playwright test --config playwright.windows.config.ts
```

CIは開発モードで起動します。失敗時は `test-results`、`playwright-report`、`windows-e2e.log` を `windows-e2e-<run>-<attempt>` artifactへ保存します。artifactのアップロードだけはテスト失敗後も動きますが、テストの終了コードは保持され、`CI required` は失敗します。
