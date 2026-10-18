# Computer Use 以外の品質確認と次期ベータ

## 依頼と範囲

- Sprint Coder 自身の Computer Use は変更・機能評価の対象外。未マージの #881 は取り込まない。
- Task / Chat / Project、モデルと接続、ファイル編集・コマンド・承認、再起動復元、Team / Graph、Skill、設定、アクセシビリティ、配布・更新を対象とする。
- 実 AI を使って生成物・実行結果・停止・永続化を確認する。AI の成功文だけで合格にしない。
- 不具合は失敗証拠と原因を確認して局所修正する。新規の機能拡張は行わない。
- 必須の検証に失敗・未実施・外部制限が残れば公開しない。絶対的な無欠陥を宣言せず、検証範囲と限界を記録する。

## 開始点

- main: `1f25a3d7ab0b2ff963c585165dea3c7583424b3a`
- 最終公開ベータ: `v0.7.0-beta.14`
- 対象の既知の未解決不具合: #863（32 人 Team の画面停止）。修正候補 #879 の実 AI 再検証が必要。
- Claude CLI は直前の検証で `429 usage_limit_reached`。復旧確認できるまで実 AI の Claude 検証は未実施扱い。

## 段階と終了条件

1. [ ] 対象機能・テスト・既知の問題・依存と境界の巡回を記録する。
2. [ ] #879 の修正と残る #863 の現象を確かめ、必要な最小修正を行う。
3. [ ] mock の UI 全回帰と品質チェックを実行する（Computer Use の専用ケースは除外）。
4. [ ] 実 AI の workspace / 権限 / コマンド / 停止 / 再起動 / Team / 衝突の結果を確認する。
5. [ ] 32 人 Team の実 AI 検証で画面観測と成果物、並行実行、統合を検証する。
6. [ ] コードレビュー、未解決 thread 0、最新 head の全 CI、packaged E2E を確認する。
7. [ ] 公開済み stable からの変更全体で版を一度決め、release PR を検証・merge する。
8. [ ] 正確な merge commit の Windows / macOS 配布物・更新情報・macOS notarization を検証し、条件を満たせばベータを公開する。

## UI 検証マトリクス

すべて隔離したローカルの使い捨て profile と workspace を使う。L1 は表示、L2 は操作と結果。各 spec の assertions を期待値の契約とし、スクリーンショット・終了集計・生成物を証拠にする。

| 分野                  | L1 / L2 と期待する結果                                                | 状態の復元                     |
| --------------------- | --------------------------------------------------------------------- | ------------------------------ |
| Task / Project / Chat | 作成・切替・改名・入力・送信・履歴、フォルダ割当が機能する            | 所有 profile に隔離            |
| モデル / 設定 / Skill | Picker、Access、設定保存、Skill 選択と再起動後の保持                  | 同じ profile で再起動して確認  |
| Workspace             | 実 AI による作成・編集・読み取り、差分と正しい生成物                  | 使い捨て git repository        |
| Command / 承認        | 実コマンドの結果、許可・拒否・Task 中許可、監査が一致する             | テスト用 repository と profile |
| 停止 / Queue / 復元   | 停止後の子プロセス・Turn 終了、次の送信、再起動後の履歴               | 所有アプリを正常終了           |
| Team / Graph          | 雇用・割当・報告・統合・衝突・再開・履歴、UI 応答                     | 所有 worktree のみを片付ける   |
| UI / a11y / 性能      | キーボード、zoom、theme、reduced motion、スクロール追従、フレーム応答 | profile 単位で分離             |
| 配布と更新            | packaged app 起動、version、platform 別成果物と更新メタデータの一致   | Draft で検証後に公開           |

## 結果

### Windows 開発版・第1回

- 対象: `f3f24ad78df92cd2b1ca54e7f04d1185d8ab2fd2`（main + #879 候補）、Node 22.23.2、Electron 43.5。
- typecheck / format:check: PASS。lint: errors 0、warnings 2（未使用の私有 helper と catch binding）。
- UI: 136 件、94 PASS / 13 FAIL / 29 SKIP。SKIP は実 AI opt-in と OS/対象外条件であり、合格に含めない。
- AutoDecision flood: 3,000 件、100 件/秒、32,215 ms。long task 0、Main 往復最大 30 ms。これは mock の結果であり、#863 の実 AI 32 人合格の代用ではない。
- 性能: 起動 3,075 ms、入力 p95 15.9 ms、10 Worker の pan 56 fps。
- 証拠（ローカル）: `%TEMP%/beta-quality-20261019/mock-dev/` と `%TEMP%/beta-quality-mock-dev.log`。生ログ・画面は GitHub に投稿しない。

失敗の切り分けと修正:

1. Graph 5 件: `.codex` 配下の checkout をテスト workspace に使ったため、正しく app-private として拒否された。通常のユーザーホームに fixture を作るよう修正。保護規則は変更しない。
2. DFlash: draft の artifact metadata がない fixture は選択対象にならない。installed metadata を用意し、実ファイル欠落時の保存拒否を引き続き検証する。不完全な draft の除外も検証する。
3. Model 3 件: Grok の E2E probe が `e2e-fixture` という不正な version 形式を返し、hello が破棄され、他 Provider も UI の Promise.all で待たされた。protocol validator を通す回帰テストで修正前 FAIL を確認。fixture のみ有効形式へ修正。
4. Settings: 既定 concurrency は実装・domain test とも 50。古い E2E 期待値 8 を 50 に訂正。
5. 最終レイアウト: Mock では legacy model selector が意図的に無効。操作前に UI で Codex を選ぶ手順を追加。
6. Team cable: 固定した drag 開始点が animation 中の Leader timeline に重なっていた。hit-test で実際の空白を選択し、Worker が実際に画面外になったことも検証する。アプリの文字選択・pan の保護は変えない。
7. 大人数の配置保存: 実 UI scale=0.173333 が保存の下限0.18に拒否された。独立レビューで clamp だけでは Fit の全体包含が失われると確認。renderer / contract / persistence の下限を0.04に揃え、計算値もその範囲に収める。34 /100 人の全体包含・配置保存・再起動復元を追加検証する。

Graph / DFlash / モデル / Skills の再検証16件 PASS。camera/placement unit41件 PASS、SQLite実行（Electron ABI）Canvas11件 PASS。typecheck、lint（warnings 0）、format:check PASS。追加変更後の最終ゲートは別途実行する。

### 依存関係

- manifest と lock のコピーのみを隔離ディレクトリで audit。元の production audit は 6 件（high 2 / moderate 1 / low 3）。severity は到達可能性の証明ではない。
- sharp 0.35.5、undici 7.30.1、yaml 2.9.1、推移依存 DOMPurify 3.4.17 の修正を準備。Mermaid の major 更新などは追加しない。
- sharp の librsvg advisory の対象条件は Linux glibc。Windows で同じ exploit が再現したという意味ではない。
- 更新後の隔離 production audit は high 0 / moderate 0 / low 2（KaTeX と依存元 Mermaid）。関連の画像・接続・catalog unit tests は PASS、Windows の POSIX 専用9件は SKIP。Grok lifecycle の1件は rootから誤って実行した際の既定5秒timeoutに失敗し、プロジェクトの20秒configで同じ検証がPASS（5.86秒）した。CI は未完了。

### 未完了の公開条件

UI 残件、実 AI 全経路、実 AI 32 人 Team、packaged app、最新 head の CI とレビュー、配布物・署名・notarization。Claude の利用制限による未実施を PASS とみなさない。現時点では公開しない。
