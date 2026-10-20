# PRの変更範囲に応じてCIを短縮する計画

- 作成日: 2026-10-20（Asia/Tokyo）
- 状態: ユーザーの短縮作業指示により第1段階を実装・検証中。branch rule・製品コードは未変更。
- 対象: `Robbits-CO-LTD/sprint-coder`
- 基準: remote main `881ea8514138c88d90a059bc61791a38af1fc609`。現行 `ci.yml` のGit blob `b6194dcfba929db82f15f35369b240efff1ef927` が作業checkoutと一致することを確認。
- 以前の [全PR全検証を維持する計画](ci-runtime-reduction.md) と異なり、今回は「必要最低限にできないか」という依頼に対する変更範囲別の計画。続く「短縮作業を行いなさい」の指示で第1段階に着手した。

## 1. 結論と目標

PRは変更に直接関係する検証だけを必須にし、main pushでは現行の広い回帰検証を非同期で実行する。DB・権限・native・依存関係・build/CIなどの高リスク変更は、初期導入ではPRでも現行fullを維持する。

最初は文書とRendererのみの変更を短縮し、Mainの任意ファイルに対する高度な影響解析を導入条件にしない。標準hosted runnerを使い、有料runner・新しい常駐runner・新しい定期実行は導入しない。

| 変更 | 目標（cache warm、待ち行列を除く） | 備考 |
| --- | --- | --- |
| 文書のみ | 30秒以内 | 分類・必要な文書check・結果集約のみ |
| Rendererの純粋な表示関数・局所コンポーネント | 1〜2分 | 型・lint・format・Rendererテスト |
| 画面の操作・layout・global CSS | 2〜3分 | 上記と変更に対応する短いdev Electron E2E |
| DB・権限・native・CIなど | 当初は現状相当 | 実行対象を減らす根拠の確認後に別段階で短縮 |

数値は未実装の目標であり、達成実績ではない。全体時間はrunner/concurrency待ちを別途含む。全PRの一律2分化は目標にしない。

## 2. 現行CIの実測

2026-10-20の取得時点の直近16 runを照会し、そのうち新しい完了10 runの全job/step時刻を取得した。失敗・取消も下表に残した。取得時に実行中だったrunは完了時間の集計対象外。

測定値は `workflow.created_at → CI required.completed_at`。workflowのupdated_atは後処理も含むため、下表の必須check完了時間とは区別する。

| run | event | 結果 | 必須checkまで |
| --- | --- | --- | --- |
| [39253196939](https://github.com/Robbits-CO-LTD/sprint-coder/actions/runs/39253196939) | push | success | 10分35秒 |
| [39383582079](https://github.com/Robbits-CO-LTD/sprint-coder/actions/runs/39383582079) | pull_request | success | 10分46秒 |
| [39386680309](https://github.com/Robbits-CO-LTD/sprint-coder/actions/runs/39386680309) | pull_request | success | 6分42秒 |
| [39408296264](https://github.com/Robbits-CO-LTD/sprint-coder/actions/runs/39408296264) | push | failure | 7分12秒 |
| [39409259896](https://github.com/Robbits-CO-LTD/sprint-coder/actions/runs/39409259896) | pull_request | success | 6分53秒 |
| [39410605275](https://github.com/Robbits-CO-LTD/sprint-coder/actions/runs/39410605275) | pull_request | cancelled | 6分55秒 |
| [39411203185](https://github.com/Robbits-CO-LTD/sprint-coder/actions/runs/39411203185) | pull_request | success | 12分18秒 |
| [39412648525](https://github.com/Robbits-CO-LTD/sprint-coder/actions/runs/39412648525) | push | success | 9分20秒 |
| [39414302420](https://github.com/Robbits-CO-LTD/sprint-coder/actions/runs/39414302420) | pull_request | cancelled | 9分35秒 |
| [39415298517](https://github.com/Robbits-CO-LTD/sprint-coder/actions/runs/39415298517) | pull_request | cancelled | 4分28秒 |

完了10件はsuccess 6・failure 1・cancelled 3。successのPRは4件で、中央値8分49.5秒、範囲6分42秒〜12分18秒。取消・失敗を成功時の短縮実績には使わない。標本は小さく、主にUI変更PRなので全変更種別の代表値ではない。

これらは各40 job、Windows focused smokeがskipされ39 jobが実行された。success PRの合計job時間は101.4〜110.4分で、39 jobを並列に動かしても最後の数job待ちが残る。

- 型checkはjob実行48〜50秒、lint 36〜43秒、format 28〜33秒程度。既存の並列qualityは短く、まず維持する。
- run 39411203185のmacOS shard 2は607秒。内訳は通常test 241秒、Coordinator Electron 282秒、Graph Electron 49秒であり、runner待ちだけでは説明できない。
- 同runはworkflow作成からquality開始まで107秒。runner/concurrencyの前段待ちも別に存在する。
- run 39409259896のWindows installerは396秒で、うちmakeが267秒。UI変更でもこれを待っている。
- 結果集約2段は、run 39386680309では最後の実作業終了から約10秒。整理対象ではあるが、数分の主因とはしない。

## 3. 確認した原因

1. [ci.yml:19](../.github/workflows/ci.yml#L19) のclassifyは差分を見ず、常に `full_matrix=true` を返す。
2. falseへ変えるだけでは不十分。macOS全test、Windows bridge、Computer Use native、Windows major E2E、packaged Archifyにも別途条件が必要。現在の [CI required](../.github/workflows/ci.yml#L1104) はそれらすべてを待つ。
3. 依存tree・SQLite ABI・NativeSafeFs・Rust helperのcacheは [既にある](../.github/actions/install-deps/action.yml)。単なるcache追加を主対策にしない。
4. Windows installerとpackaged Archify 2 shardで少なくとも3回packageする。macOSは既に同一jobのfresh packageを使っており、同じ重複とは扱わない。
5. macOSは1 job内で通常test→Coordinator→Graphを直列に実行する。full側の第二段階改善候補だが、無制限のshard追加は収集コスト・runner待ちを増やす。

## 4. PRで残す最小検証

複数区分に該当したら必要checkの和集合を取る。full条件が一つでもあればfullを優先する。

| 区分 | 対象例 | PRで必須 | PRから後段へ移す検証 |
| --- | --- | --- | --- |
| docs | README、説明用docs、計画Markdown | 差分の形式・変更したリンクの確認。文書checkerを新規依存として増やさない | application test、native、package、E2E |
| renderer | `src/renderer` の表示部品・CSS・表示専用関数、対応test | 全workspace typecheck、既存lint/format、Renderer testをLinux 1 OS。layout・focus・keyboard・global CSSには対応dev E2Eを追加 | Main全suite、3 OS suite、native gate、installer、無関係なpackaged E2E |
| ui-state | Renderer store・IPC型・Preload・UI制御 | 初期はfull。次段階でstore/Preload/IPCの固定結合testと対応E2Eへ限定 | 固定対応表を検証してから無関係な機能を省略 |
| shared | contracts/domain、共有IPC・状態契約 | 初期はfull。次段階で両package全test、全型check、利用先subsystemへ限定 | 共有indexの広い影響を確認してから省略 |
| subsystem | Main/Runtimeの局所機能 | 初期はfull。次段階で関連unitと呼出し元の固定integration。process起動/stopはWindowsとPOSIXの該当test | 無関係な機能・画面 |
| high-risk | persistence、Coordinator、DB、permission、Workspace I/O、native、共有header、loader、sandbox | 初期は現行full。後に対象OS・対象境界を立証できた場合だけ縮小 | OS境界testを単純にmainへ送らない |
| infrastructure/unknown | manifest/lock、build・Forge・Vite・CI・selector・test runner設定、未分類 | full | なし |

Renderer内でもstore、IPC型、shared logic、OS固有判定を使う機能は軽量区分へ無条件に入れない。テスト・fixture・resource・promptの変更は拡張子だけでdocs扱いしない。

E2E spec自体が変わった場合、そのspecと利用する機能を必ず選ぶ。例えばPR #897の `sidebar-collapse.spec.ts` は現行Windows majorの固定9 specには含まれず、既存固定suiteだけでは今回の変更specを保証できない。Rendererとの混合差分なら当該specをUI checkへ併合し、関係を分類できなければfullと当該specを実行する。

PR #896はRendererのみで短縮候補。PR #897は操作・layoutとE2Eの追加が必要。PR #898はUIというタイトルでもpersistence・Coordinator・contractsを含むためfull。タイトルやラベルだけで軽量判定しない。

## 5. 分類と結果集約の契約

- 既存CIはPR/pushで起動し続け、workflow全体を `paths-ignore` で消さない。docsでも `CI required` は報告する。workflow全体のpath skipは必須checkをPendingにし得る（[GitHub公式](https://docs.github.com/en/enterprise-cloud@latest/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)）。
- PRはbase/headとmerge-baseを特定し、PR全体の差分を分類する。最後のcommitだけで分類しない。check対象のmerge SHAと分類したbase/headをsummaryへ記録する。
- 差分取得は完全なgit diffを使い、削除・rename元/先も評価する。取得失敗、未知path、空差分の理由不明、選択失敗はfullへ戻す。diffの取得自体を確認できなければgateを失敗させる。
- `vitest related` は補助に留める。動的なパスのimportは依存抽出できず（[Vitest公式](https://vitest.dev/guide/cli.html#vitest-related)）、このrepoにも文字列で読むCSS/native/fixture、別Electron process内のsuiteがある。固定対応表を併用する。
- `windows-hide.test.ts` のようなsource読取test、CSS contrast test、native seamを明示mapする。変更testを必ず含め、対象0件を無条件PASSにしない。
- classifierは `mode`、必要job集合、選択理由を返す。qualityは分類後に従来の3並列で実行する。docsでは省略し、分類jobの待ちも目標時間に含めて実測する。
- 各jobの `if` と最終gateの期待job集合を同じ分類結果から決める。予定jobがfailure/cancelled/skippedならgateは失敗。予定外jobのskipだけを許可し、単なる「失敗がない」を成功条件にしない。
- `CI required` は `always()` で1段集約する。既存の中継 `build (...)` check名は、実装時のrules再確認後に整理する。今回の照会ではmainの旧branch protectionは404、適用branch rulesは0件。保護設定そのものの変更は本計画の対象外。
- main pushと既存workflow_dispatchはfull。dispatchの成功をPR上の必須checkの代わりとして扱わない。merge queueを今後導入する場合は別途merge_groupを配線する。
- mainは最新状態のfull検証を保証対象とし、すべての中間SHAの完走は要件にしない。PR更新時は古いrunを取消するが、main側は実行中runを取消しない構成へ分け、連続mergeで実行が終わらない状態を避ける。取消・pending・未完了を成功に数えない。
- 次PRの作成・検証・低リスクmergeはmain fullの実行と並行できるが、main失敗が判明したら、原因対応または修正確認まで次のmergeを止める。release前は対象commitのfull成功を必須とする。PRの短縮と引き換えにmainで初めて検出する回帰の可能性がある運用を明示する。
- nativeを選んだjobでは対象artifactの実loadと予定ケースの実行を確認する。addon未作成によるskipを通過扱いにせず、既存Electron bridgeのPASS集合照合を保つ。

## 6. 段階別の実装計画

### 第1段階: UI・文書PRを先に短くする

対象: `.github/workflows/ci.yml`、新しい純粋な分類moduleとそのtest、UI用のfocused test/E2E設定。既存qualityの並列構成・cache・全検証コマンドは維持する。

1. docs / renderer / fullを判定する小さなselectorを作る。最初はui-state、shared、Main、native、buildはfullへ倒す。
2. Renderer test一覧と、画面操作に対応する既存E2E specの固定mapを用意する。docs、component、global CSS、keyboard、E2E変更を検査する。dev E2Eは既存のSQLite/NativeSafeFs/sandboxなどの前提を満たし、generateAssetsのnative・sidecar準備も含めて起動時間を測る。速さのためにnative load失敗や未実行を成功へ変えない。
3. 重い全jobの選択条件と `CI required` を同時に変更する。false出力だけを先行変更しない。
4. CI変更PRそのものは現行相当fullで検証し、分類fixtureでskip/取消/分類失敗時に緑にならないことを確認する。
5. 文書だけ、PR #896型の表示変更、PR #897型の操作変更、PR #898型の混合変更を使い、想定job集合を確認する。実CIでwarm/cold各1回を測る。高コスト試験の同条件反復は増やさない。

### 第2段階: Mainと共有層をsubsystem単位へ

第1段階の実績を見てから、Main・store・共有契約ごとの固定対応表を足す。最初は全検証を維持したrunで選択候補を記録し、source読取、fixture、子Electron、IPC境界の取りこぼしを確認する。対象を説明できるsubsystemから必要checkへ切り替える。

権限・DB・ファイル操作・native・依存全体は自動的に軽量化しない。テスト総数や件数一致だけで選択の正しさを証明しない。

### 第3段階: 必要なfull CIそのものを短縮する

- Windowsは同一SHAのfresh packageを1回作り、installerとpackaged Archifyで再利用する案を比較する。artifactのupload/downloadと依存直列化を含めた実測で有利な場合だけ採用する。
- macOS shardを現在のstep時間で再配分する。Coordinator/Graphの起動・collection重複は実測してから別sliceで改善する。
- 既存cacheの入力・ABI検証を維持し、workflow変更でRust cacheが必要以上に無効化される箇所を確認する。
- runnerやVitest workerをむやみに増やさず、WindowsのACL/process競合とGUI focusを分離する。

各段階は独立したcheckpointとして実装し、PRは1件ずつ消化する。現在の既存PRを越えて新しい実装PRを勝手に増やさない。

## 7. 合格条件と運用上の差

- 通常UIのPRで無関係なnative/installer/full Electron bridgeが起動しない。
- 新しい変更file・fixture・rename・削除、分類失敗、選択jobの失敗/取消/skipを分類testとgate testで確認する。
- 変更specと選択した必須UIケースは、収集され実行されPASSしたことをreportで確認する。job自体がsuccessでも、必須ケースの未収集・0件・想定外skipはFAIL。OS非対象など実行予定外のケースは理由を明示する。
- 変更したUI操作とIPC/OS境界には、その境界を実行するtestを残す。
- mainの広い回帰検証とreleaseの独立検証を残す。main失敗時は原因確認まで次のmergeを止める。CI短縮のため失敗testを削除・skipしない。
- PRの結果だけでは確認しないOS/機能の回帰がmainで初めて分かる可能性がある。これは全PR全検証から変わる保証範囲であり、ゼロバグを保証しない。
- PR必須check完了時間、queue/concurrency待ち、job実行時間、job分数、cache hit/missを分けて記録する。成功例だけを選ばず失敗/取消も併記する。
- 実装と実行結果を分けて報告する。新しいCIの時間はActionsの実測後にだけ記載し、分類テストの成功を実CIの短縮実績にしない。

## 8. 計画の前提確認

調査・設計・検証・導入・復旧の経路を上記で分けた。適用しないUI/API/DBの設計項目は、本変更が製品挙動を変更しないため対象外。GitHub skip/needsの契約は公式資料、Vitestの選択限界は公式資料と現在のsource読取テスト、Electron ABIは既存ブリッジ実装で確認した。

新selectorの実装と速度、focused UI E2Eの起動時間、cold cache時の目標達成は未検証。実装時は最新head・branch rules・既存PRの状況を再確認する。問題があればselectorをfull固定に戻すだけで現行の検証範囲へ復帰できるようにする。


## 第1段階の実装と検証

- 実装base: `56e86baf9be5d37cbbf8d2eabf7d5e4443e404b1`。隔離worktreeの `codex/ci-scoped-pr` branchで作業し、元checkoutのpatrol記録や他の作業は保持する。
- `ci-scope.mjs` がPR全体のmerge-base diffを分類し、docs / renderer / fullを選ぶ。削除・rename・未知パスはfull。実行対象SHAとPR base/headをsummaryに残す。
- 初期のRenderer軽量対象は確認済みの表示部品・表示関数に限定。Workspace削除を扱うTeamRetainedWorktreesなどの操作境界や未知componentはfullにする。
- `CI required` はclassifyと全予定jobのsuccessを要求する。失敗・取消・予定jobのskip/欠落を拒否する。既存のfull matrix、native、installer、Electronブリッジのassertionは保持する。
- `ci-renderer-tests.mjs` がRenderer unitの0件・失敗・skipを拒否する。focused E2Eは事前収集したケースと実行reportを比較し、必須ケースの欠落・予定外skip・再試行を拒否する。事前宣言された非対象skipは別集計する。
- 新しい依存関係・課金runner・定期実行は追加しない。文書はclassify＋gate、表示関数はquality 3 job＋Renderer＋classify＋gate、操作を含む表示部品はfocused E2Eを追加する。
- ローカル検証: 全workspace型check、lint、Prettier、actionlint、Renderer 106 files / 1005 tests PASS。分類・report・workflow接続のfocused testは最終版で確認する。Actionsの実測は別途記録する。
- 復旧: 分類をfull固定に戻すと既存検証範囲へ復帰できる。新gate自体の問題ではこのCI変更commitをrevertする。branch rulesの変更は不要。


### 実行確認

- ローカル: CI関連7ファイルは173 PASS・既存のOS別2 SKIP、全workspace型checkと更新後desktop型check、lint、Prettier、actionlintはPASS。
- 新runnerの実Electron E2E: `keyboard-smoke.spec.ts` の必須1 case PASS、0 SKIP。隔離worktreeのfresh build（localhost:5174）と専用データ領域を使用し、既存の5173は保持した。事前収集と実行reportの一致を確認。実画面操作は6.0秒、build/setupは別計測。
- 初回Actions [39422374321](https://github.com/Robbits-CO-LTD/sprint-coder/actions/runs/39422374321): 新Renderer jobとqualityはPASS。旧集約job名・無条件Windows E2E・shellコマンド文字列に固定されたworkflowテスト3箇所でFAILしたため残りを取消した。製品の実行失敗ではなく、旧CI契約への固定が原因とログ・対象テストで確認した。
- 対応: 既存workflowテストを新gateの依存入力へ接続し、同じ失敗・取消・skip拒否を分類/集約テストで維持した。新CIの専用契約test stepへこれらの既存workflowテストも含めた。修正後Actionsは最新headで再確認する。
- 軽量PRの所要時間はまだ実測していない。上記の分類テストやfull runを、短縮達成の証拠として扱わない。
