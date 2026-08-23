# PLAN_BINDING

| 受入条件         | 実装path / layer                                                              | 検証                                                                |
| ---------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| AC-1, AC-5       | `.github/workflows/ci.yml` / CI orchestration                                 | workflow回帰テスト、Actions readback                                |
| AC-2, AC-3, AC-6 | `playwright.windows.config.ts` / E2E selection                                | config回帰テスト、Windows Playwright実走                            |
| AC-4             | `playwright.windows.config.ts`, `.github/workflows/ci.yml` / evidence capture | artifact upload定義テスト、失敗時artifact readback                  |
| AC-5, AC-7       | `.github/workflows/ci.yml` / required result chain                            | `e2e-windows -> windows-result -> required` の静的検証とActions結果 |
| AC-3, AC-6       | 開発者向け文書 / maintenance contract                                         | 文書差分確認                                                        |

計画外の製品コード修正、実Provider接続、release workflow変更が必要になった場合は `PLAN_DRIFT_HOLD` とし、Issueを分離する。
