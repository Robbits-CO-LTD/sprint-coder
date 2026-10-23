# Issue #903: 内蔵モデル機能の廃止

## 成果

Sprint Coder内でモデルを検索・インストール・実行するManaged Local機能を、UI、IPC、Main runtime、llama.cpp配布から削除する。外部LocalAI、Ollama、LM StudioへのProvider接続を維持する。

- Issue: https://github.com/Robbits-CO-LTD/sprint-coder/issues/903
- 実装開始base: main 669f32a8（#916/#917統合後）。
- #901のダウンロードhash中断経路は機能全体の削除によって到達不能になる。既存アルゴリズムを修正したという扱いにはしない。

## 必要な変更と保持境界

| 経路               | 対応                                                               | 正しさの証明                                              |
| ------------------ | ------------------------------------------------------------------ | --------------------------------------------------------- |
| 起動・終了         | controller、download recovery、sidecar、メモリ監視を削除           | Main entry/配布検証、旧データfixtureでreopen              |
| 設定・モデルpicker | 内蔵install画面と専用APIを削除                                     | 設定/外部Provider UI test、focused E2E                    |
| IPC/契約           | localAI API/channelを削除。未接続backend用schemaは後続PRで削除     | contracts/desktop typecheck、IPC登録test                  |
| Chat/queued turn   | 旧selectionを保持しdispatch前に理由付き拒否                        | catalog欠落・旧selection・再dispatchで他Provider/CLI呼出0 |
| Team worker        | 旧selectionをCLI fallback前に拒否                                  | start/executeともfallback/verification呼出0               |
| Registry           | 旧connection/providerをgeneric compatible解決前に拒否              | reserved identityと通常external connectionの回帰          |
| DB/ファイル        | v75/76/77/83とchecksum、全model metadata、既存モデル/partialを保持 | 旧DB/小さいsentinel modelを再openして不変確認             |
| 配布/CI            | llama.cpp取得・同梱・署名特判・専用smokeを削除                     | Forge test、package起動、各OS必須CI                       |

モデルがcatalogに見つからなくても保存済みselectionをnull化しない。旧selectionのnull化は既存CLI default経路に入るため禁止する。履歴のreadや通常の外部Provider fallback仕様は変更しない。

## 非対象

Computer UseのIssue、汎用Managed Harness/Workspace/権限/egressの仕様、外部Providerのモデル管理、ユーザーのモデルファイル削除、新DB migration、実Provider smoke。旧データは自動削除/移動/再開しない。

## 検証と完了条件

Main/contract/UIの直接testとtypecheckから進め、retirement/既存DB/外部Provider境界、Forge、focused packaged E2Eを確認する。親が統合差分のClaude Opus 5.5 highレビューと最新headの必要CI/ReviewBOTを確認する。実装中の検証、merge、release配布、実Provider応答は別の証拠として報告する。#901/#903のcloseは親のmerge後closeoutで行う。

レビュー取得上限のため、この段階はアプリ入口の撤去を先行する。未接続backendと対応test・schemaは後続PRで同時に削除し、#901/#903はその完了までopenに保つ。
