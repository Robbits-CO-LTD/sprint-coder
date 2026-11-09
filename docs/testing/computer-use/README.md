# Computer UseによるUI・E2E検証

UI・E2E・ユーザー操作の動作確認は、**開発エージェントのComputer Useで実アプリ／ブラウザを操作**して行う。Playwrightのテストコード・設定・実行手順を追加しない。単体・結合テストはVitestを使用する。これはSprint Coder製品自身のComputer Use機能を使う義務ではない。

このフォルダは検証手順の正本であり、過去の自動テストを実行した結果や、移行時に全項目が合格したという記録ではない。

## チェックリストを選ぶ

| 変更・症状                                                | 手順                                                   |
| --------------------------------------------------------- | ------------------------------------------------------ |
| 送信、停止、キュー、IME、添付、画像生成、思考、スクロール | [Chat・Composer](chat-composer.md)                     |
| 初期設定、Provider設定、Skills、Project、sidebar、window  | [設定・Project](settings-projects.md)                  |
| Team、活動履歴、Canvas配置、通信、policy                  | [Team](team.md)                                        |
| Graph選択、根拠、履歴、Mission開始・停止・再開            | [Graph](graph.md)                                      |
| キーボード、axe、zoom、動きを減らす、性能、最終layout     | [アクセシビリティ・性能](accessibility-performance.md) |
| 承認、ファイル編集、command、実CLI、実Worker              | [Workspace・実Provider](provider-workspace.md)         |
| サイトのdesktop/mobile、動画、録画ラベル                  | [公式サイト](website.md)                               |
| 元ケース名、parameter、取りこぼし確認                     | [移行対応表](migration-map.md)                         |

元Desktop50ファイルの126定義をparameter展開して140ケース、サイト18ケース、録画ラベル112条件を引き継いだ。旧ケース名は履歴の照合用であり、旧ドライバーAPIを実行する手順ではない。内部assertionも各手順の合格条件へ保持し、観測できない条件を省略して合格にしない。

## 実施準備と操作

1. 対象commit/未commit差分、build種別（dev / packaged / installed release）、OS、CPU/GPU、表示scale、viewport、選択Provider/CLI/modelを記録する。変更に関係するケースIDとparameterを選ぶ。複数OSのケースを1台の結果で合格にしない。
2. 本人の通常profile・Workspaceから隔離したprofileとfixtureを作る。shellは起動、fixture準備、ログ・DB・ファイル・processの照合に使用できる。アプリ内のクリック・キー入力・送信・承認・スクロールはComputer Useから行う。内部API、DOMイベント合成、store書換えによる画面遷移をComputer Useの操作証拠にしない。
3. Node.js 22で依存を用意し、開発buildでは `npm run prepare:desktop --workspace @sprint-coder/desktop` で対象Electron用のnative依存を準備してから `npm start`。packaged確認では `npm run package` の成果物を起動する。起動前に既存dev serverや別profileのappを確認し、別作業のprocessを停止しない。build成功と実起動成功を区別する。
4. 起動時に `SPRINT_CODER_USER_DATA_DIR` と `SPRINT_CODER_SKILL_HOME` を同じ隔離profileの絶対pathへ指定する。`SPRINT_CODER_E2E_BACKGROUND=1` は可視windowをフォーカスを奪わずに起動する既存の補助フラグであり、テストrunnerではない。非表示専用フラグはCU検証で使わない。初回wizardはUIで通る。
5. 各手順の前提を画面と補助証拠で確認し、実際に操作して期待値を照合する。画像、フォーカス、状態遷移、必要な測定結果を紐付ける。変更範囲に応じてlight/dark、loading/empty/error/disabled、keyboardを確認する。
6. 自分が起動したアプリを通常終了し、必要な再起動検証が完了してから自分のserverを終了する。fixtureと証拠の保持/破棄を記録する。本人のclipboard、OS設定、theme/zoomを変えた場合は元へ戻す。

代表smokeは起動→setup→Task作成→入力→設定の開閉でよいが、送信・実応答・保存・再起動などの未実施項目をそれで合格にしない。実Providerへの送信が不要なUI確認では送信しない。

## fixture・補助計測と合格条件

- Mock/Graph/Teamの台本、途中hold、旧DBなど、手順が要求するfixtureは隔離環境だけで使う。通常UIで作れない状態に対して新たな製品の迂回APIを追加しない。同等fixtureの供給方法が未整備なら、そのケースをBLOCKEDにする。旧holdをMain注入で解除していた場合も、代替準備なしに完了した扱いにしない。
- 旧fixtureのモデル名（例GPT-5.6-Terra）はそのfixtureの期待値。live実機のモデル可用性はアプリが実際に起動するCLIのcatalogとPickerを照合する。shellの別CLIや古いcacheだけで判定しない。
- axe監査、frame/input timing、DOM寸法、mount counter、trusted操作拒否、IPC所有権、保存ID一致などは目視だけでは証明できない。利用可能な読み取り専用の診断/開発者ツール/境界テストと画面証拠を組み合わせる。同じbuild・条件での必要な測定を得られない場合はBLOCKED。製品CSP・sandbox・trusted境界を緩めない。
- [real-ai-team-concurrency.ts](../../../tests/computer-use/real-ai-team-concurrency.ts) は保存DBとMainのWorkerログから実CLI同時実行区間を集計する補助関数。`parseWorkerEvents` / `runningConcurrency` を用い、rate-limit、開始/終了ログ欠落、fallbackを判定不能として扱う。画面の人数やworktreeの存在だけで同時実行を証明しない。
- [send-observation.ts](../../../tests/computer-use/send-observation.ts) は既存Rendererでの受動的な入力event/寸法/件数の観測と、public Turn snapshotの許可項目だけを抽出する補助処理。操作を発生させず、本文や生のsnapshotを記録しない。許可された診断経路がなければ利用不能と記録する。この補助処理自体のテスト成功はCU受入の代わりにはならない。
- 数値の目標と旧合否上限は区別して保存する。性能測定でsample欠落やfixture不足を良好な値に置き換えない。Computer Use呼出し時間と製品応答時間を分ける。
- 課金・credential・networkを伴う実Provider/実Workerは**明示許可がある場合のみ**。対象Provider・人数・目的・費用を伴う条件を記録し、Mock結果を実Provider成功と呼ばない。

## 結果の記録

| 状態    | 意味                                                                             |
| ------- | -------------------------------------------------------------------------------- |
| PASS    | 指定parameterと全合格条件を実操作・必要な補助証拠で満たした                      |
| FAIL    | 前提が成立した状態で製品の実結果が期待値に反した                                 |
| SKIP    | 対象外OS、実Provider許可なし、元から無効化済み等の明示理由で実施しなかった       |
| BLOCKED | 必要なComputer Use、fixture、計測、native/Provider環境等がなく合否を決められない |

各ケースの実施記録には次を含める。未実施を空欄のままPASS集計へ入れない。

- ケースIDとparameter、対象build/SHA/差分、日時、OSと表示条件。
- 実際に用意したfixture、Provider/接続/CLI/model、課金検証の許可範囲。
- 操作順序、期待値、実結果と数値、PASS/FAIL/SKIP/BLOCKED、理由。
- スクリーンショット/動画/最小metadata/補助測定のpath。秘密、prompt/response全文、環境変数全体を診断ログへ記録しない。合成fixture文と必要な受入値だけを最小限比較する。
- 残件、未確認OS・ケース、後片付けの状態。部分的に確認できた項目は分けて記し、ケース全体をPASSに繰り上げない。

CIではVitest、型検査、lint、native、package/installer等の残存gateを検証する。CI成功はComputer Useの実施証拠ではなく、Computer Useが使えない時も代わりに合格扱いにはしない。
