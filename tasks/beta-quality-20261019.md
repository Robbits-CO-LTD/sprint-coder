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

1. [x] 対象機能・テスト・既知の問題・依存と境界の巡回を記録する。
2. [x] #879 の修正と残る #863 の現象を確かめ、必要な最小修正を行う。
3. [x] mock の UI 全回帰と品質チェックを実行する（Computer Use の専用ケースは除外）。
4. [x] 実 AI の workspace / 権限 / コマンド / 停止 / 再起動 / Team / 衝突の結果を確認する。
5. [x] 32 人 Team の実 AI 検証で画面観測と成果物、並行実行、統合を検証する。
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

### 第1回確認時点の未完了条件

残る実 AI 経路、packaged appの全UI回帰、最終headのCIとレビュー、配布物・macOS署名・notarization。未実施をPASSとみなさない。現時点では公開しない。

### 実 AI と32人 Team の追加確認

- Codex の実ファイル編集・コマンド・承認拒否と許可・履歴復元2件、停止・実子プロセス終了・再起動・複数root・日本語UTF-8の4件がPASS。Skill revision、画像PNG生成、reasoning各段階と不正値拒否も実CLIでPASS。
- Team基本ケース1件はLeaderが選んだClaude Workerの利用制限で失敗。外部制限として残し、PASSに含めない。
- `63d19335`のCodex 32人は32件の正確な生成物と統合、実CLI32同時、30以上の同時実行145秒を確認。ただし描画間隔最大59,050ms、rAF応答のtimeoutが1件あり、性能の受け入れはFAIL。従来テストは性能値を記録するだけだったため、rAF/Team取得のtimeout・失敗0、各最大応答と描画間隔3秒以内を明示assertする。

### #863 描画停止のRCA（2026-10-19）

- RCA Mode: **Root Cause Confirmed**。A=YES / B=YES / C=YES / D=YES。
- 症状と再現: 実Codex Leaderに32人の雇用だけを依頼し、Worker実行なしでも描画が46,413ms停止。foregroundでも54,665ms、reduced motionでも75,621ms。独立profileで3回再現した。
- 原因箇所: `apps/desktop/src/main/local-hardware-inventory.ts`のdefault GPU probeが`app.getGPUInfo('complete')`を呼んでいた。
- 原因経路: Teamのmodel一覧/雇用検証 → `ipc.ts`の`refreshModelCatalog` → Managed Local `listModels` / `ManagedLocalController.listProviderModels` → `collectLocalHardwareSnapshot` → GPU complete probe。モデル検証のたびに再収集される。
- 独立証拠: 同一再現のChromium traceでGPU主スレッドの`gpu_info_collector::CollectDawnInfo`が33回、合計77,307ms、1回約2.3～2.5秒。親taskは`gpu_service_impl.cc`の`GetDawnInfo`。rendererの最大taskは72ms、JS timer最大遅延33msで、継続的なJS処理・フォーカス・アニメーション・32 CLI同時実行は原因から除外。
- 修正方針: 消費する`gpuDevice`情報を取得できる`basic`に限定する。Electron同梱型定義もvendor/device IDのみ必要な場合のbasicを推奨。空きRAMのcache、GPU無効化、CSS変更は加えない。別経路のGPU取得は検索で見つからず、GPU memoryは既存の独立probeの観測を保持する。
- 回帰テスト: default probeのbasic指定とdevice facts / memory joinを検証。修正前はcompleteの呼び出しで1 FAIL、最小修正後6 PASS。
- 同じ実Codex Leader / 32人雇用 / 非foreground条件で再検証し、32人雇用完了、最大描画間隔100ms、JS timer最大遅延67ms。Chromium traceの`CollectDawnInfo`は0回（修正前33回）。雇用時の同じ症状が消えたことを確認した。独立コードレビューの追加findingは0。生trace・調査用specはローカル一時領域に保持し、配布sourceには残さない。
- 実作業32人の厳格な性能受け入れも次項で確認した。この再現テストのみを全経路の完了根拠にはしない。

### 修正版 `1c85c840` の実 AI Team

| ケース | 実CLI / 成果物 | 最大rAF応答 / Team取得 | 最大描画間隔 | 判定 |
| --- | --- | --- | --- | --- |
| Codex32人 | 最大32同時、30以上178秒、32正確ファイル、32統合、clean | 259ms / 308ms | 134ms | PASS |
| Claude16 + Codex16 | 最大32同時、30以上144秒、32正確ファイル、32統合、clean | 887ms / 2,233ms | 167ms | PASS |
| 同じファイルの4区画 | Claude2 + Codex2、4変更をすべて統合、clean | 36ms / 26ms | 100ms | PASS |
| 同じ行の衝突 | 1件completed + 1件waiting_resume、Leaderへ衝突report、最終集計1成功/1失敗 | 記録JSON参照 | 3秒以内 | PASS |

- いずれもrAF / Team取得のtimeout・観測失敗0。32人の全CLI start/endを確認し、rate limit / fallback 0。mockを実AIの代わりに数えていない。
- mixed32で全Worker完了後にLeaderが「報告2/32」と待機を継続したが、最終回答は32成功/0失敗で終了し、保存された32のterminal reportと一致した。途中発言だけで報告の消失は断定しない。pinned出力上限超過の仮説は全waitがsucceeded、各結果が1MiB未満であることから支持されなかった。production追加修正はしていない。
- ただし旧scale/overlapはLeaderがdeadlineまで待ち続けてもファイルが正しければ合格し得た。全3ケースで期限内のLeader終了と正しい最終集計を必須にした。保存済みCodex32・mixed32・overlap・conflictの4結果は、新条件でもPASSと再評価できた。
- 02:00 JSTに実Claudeが`SC_QUOTA_OK`を返し、利用制限の回復を確認。残る基本・承認・停止・GraphとGrokの実UI検証は次項の13件で確認した。
- GitHub CI run `39147998939`はhead `1c85c840`で39 SUCCESS / 1 SKIP（full matrix時のfocused Windows jobを意図的に除外）。ReviewBOTは同じheadにLGTM・blocking finding0、未解決thread0。最終version/report変更後のheadは別途確認する。
- 実Electron APIのdevice情報比較でもvendor/device IDとdevice nameは一致。windowなしの比較ではbasic/complete間でactiveフラグに差があったが、既定GPU memoryはどちらもunknown、同じ先頭GPUを選ぶfallbackとなり、現行判定が変わる根拠は見つからなかった。独立レビューも追加finding0。

### 残る実 AI 経路の結果

- 追加13ケースは13 PASS / 0 FAIL / 0 SKIP（11.4分）。ClaudeのTeam承認、停止・子プロセス終了、再起動復元、複数rootと範囲外拒否、日本語と絵文字、Graph、通常編集・コマンド・承認拒否/許可・小Team、CodexのTeam承認・Graph・小Team、Grokの作成/編集を確認した。
- 初回Codex小TeamのClaude利用制限によるFAILは、枠の回復後に同じspecがPASS。生成物2件、report2件、clean repository、再起動後のWorker/report/完了回答の保持まで確認した。
- 先行Codex6件、追加13件、mixed Team3件、Codex-only32人1件で実AI UIは計23ケースPASS。Skill / PNG画像生成 / reasoning各段階は別の実CLI smoke 3件PASS。mockと合算しない。
- Claude停止: 中止確定1,632ms、コマンド終了2,711ms、残存子プロセス0、停止後の会話PASS。アプリ終了1,685ms、コマンド終了と残存0、再起動時の中断通知・履歴・次の会話もPASS。
- Claude / CodexのGraphは各3工程すべてcompleted、指定ファイル生成。Grokも実CLIで生成物の正確さと既存README編集を確認した。
- 同じheadのCI Windows installer jobでManaged Local transport / coding smoke（Qwen実モデルの取得・hash・load・対話・nonce tool往復・停止・削除）がPASS。
- API key未設定の公式API接続先は実接続未実施。契約・stream終端・tool・エラーのunit検証と、実CLI / Managed Local検証を区別する。未実施を実AI PASSに数えない。

### ベータ版の決定

- 祖先の直近公開stableは`v0.5.0`。開始時mainまで531 commitと今回PRの差分を確認（`1c85c840`まで548 commit）。Team / Graph / Provider等の追加を含むMINOR以上の範囲。既存の`v0.7.0-beta.0` / release PR #458でArchify、保存衝突、DFlashを含む0.7.0の目標baseが既に決定・公開されている。同じbeta cycleでbaseを再bumpせず0.7.0を継続する。
- 公開済みとremote tagの最大suffixは14、15は未使用と確認。`0.7.0-beta.15`へ一度だけ更新し、desktop manifestとlockを一致させる。client versionはこのmanifestから組み込まれる。
- Windows署名の明示指定がないため、従来仕様のunsigned Windows配布。macOSは正式Developer ID署名とapp / DMG両方のnotarization Accepted、staple / Gatekeeper検証を必須とする。
- version変更後のpackaged全UI回帰、最終head CI / ReviewBOT、merge SHAのtag、Draft assetsと更新metadataの検証が公開前に残る。
- 配布版の最初の試行はprePackageで停止し、UIテストは未開始。Windows配布はNode 22.23.3を厳密に要求するのにローカル22.23.2を使ったため。公式ZIPのSHA256とrepoにpinされたnode.exeのSHA256、OpenJSの有効署名を確認して22.23.3を隔離cacheに用意し、ゲートを変えずに再実行する。

### Windows配布版とGraph参照の競合

- Node 22.23.3で配布版の全137ケースを実行し、107 PASS / 1 FAIL / 29 SKIP（14.3分）。唯一のFAILは`archify-graph.spec.ts`の変更済みファイルを明示的に再確認する操作で、読取り時点の内容は残るが現在のexcerptが消えていた。29 SKIPを成功に数えない。実AI opt-inは前項で別実行している。
- 34/100人のFit・配置保存・再起動、Task/Chat/Project、設定、モデル/Skill/DFlash、承認/ファイル/コマンド、キーボードとa11y等はPASS。配布版の通知3,000件・100件/秒では32,311ms、1,938 frame、最大描画間隔17ms、long task0。
- 原因: `GraphSourcesPanel`がクリック時のReact propのsequenceでpreviewを保存し、Mainの最新照合通知が届くとsequence不一致で非表示にしていた。focusによる照合がすでに走っていても、propにはまだ旧sequenceが残り得る。通知中の再読取りだけを加えた最初の修正では配布版の同じ操作が再びFAIL（他7件PASS）したため、完了扱いにしなかった。
- Root Cause Confirmed: 旧propのまま読取り後に最新statusを反映するとexcerptが消える回帰testが修正前FAIL。明示操作の開始時にMainの照合完了とsequenceを受け取り、その後に新しく読むよう修正した。途中で通知が進めば最大3回まで照合・再読取りし、古いexcerptを最新sequenceへ付け替えない。完了後の独立した更新は従来どおり非表示にし、自動でsource本文を読み直さない。Mainの保護読取りやworkspace境界は変更しない。
- 関連unit9件PASS（panel4 / status hook2 / monitor3）。独立レビューの追加finding0。調査用specと通知記録はローカル一時領域に移し、製品sourceやGitHubには残さない。
- 通知記録を外した元の配布版Graph8ケースは最終修正で8 PASS（2.5分）。同じ変更済みexcerptの表示・renameによるmissing/復帰・再起動・Graph履歴差分まで成功した。全体検証の唯一のFAILが同じ観測点で消えたことを確認。変更に無関係な成功済みUIや23件の実AIを再実行で水増ししない。
- 最終ローカルgate: lint（警告0）、typecheck、format:check、追加E2EのPrettier、diff checkはPASS。新しいheadの全CI/ReviewBOT、merge、配布asset/更新metadata/macOS notarization、公開とreadbackはこの記録時点では未実施。

### 公開前の反証確認

- 必須: 非Computer Useの不具合修正・実AIとUI確認は達成。最終head CI/review、mergeしたcommitからの配布物、公開/readbackは未達として次工程で確認する。
- 境界: #881を取り込まず、元の作業場所の未commit変更を保持。秘密情報や生traceを公開せず、API key未設定先やSKIPを成功にしない。
- 確認現物: ローカルの同じ修正sourceをfresh packagingしたGraph8件、全体137件の失敗行、実AIの生成物と集計、head `1c85c840`のCI/review。後者は最終headの代用にしない。
- 判定: CONTINUE — ローカル修正と確認は終了。最終headのCI/reviewとmerge後の配布・公開を残し、安全に次工程へ進む。
