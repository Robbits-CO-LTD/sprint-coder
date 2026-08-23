# coverage_map

| ユーザーフロー   | 対象spec                                                      |
| ---------------- | ------------------------------------------------------------- |
| 初回セットアップ | `setup-wizard.spec.ts`                                        |
| Composer入力     | `composer-input-boundaries.spec.ts`、`keyboard-smoke.spec.ts` |
| Settings         | `settings-dialog.spec.ts`                                     |
| Project / file   | `project-sidebar.spec.ts`、`file-edits.spec.ts`               |
| Approval         | `approval-flow.spec.ts`                                       |
| Team UI          | `team-flow.spec.ts`                                           |

明示除外: `macos-window-lifecycle.spec.ts`（macOS専用）、`leader-mcp-smoke.spec.ts` と `leader-mcp-codex-smoke.spec.ts`（実CLI・credential opt-in）。実Provider、実課金、外部通信は既存mock固定環境により実行しない。
