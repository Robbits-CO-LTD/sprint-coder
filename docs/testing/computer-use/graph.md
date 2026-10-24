# Graph・Mission

[共通手順](README.md)。対象OS:macOS／Windows／Linux。UI操作はCUの実クリック/キーのみ。fixture起動と隔離rootの変更・保存状態の照合はshell可。旧API注入でしか作れない途中状態は、同等のfixtureまたは境界テスト証拠がない限りBLOCKED。安全境界を弱めて検査を通さない。

<a id="archify-graph-01"></a>

## archify-graph-01

旧ケース: `tests/e2e/archify-graph.spec.ts` — binds an authorized file read and detects changed source bytes after restart

- 前提: Graph fixture有効、外部Nodeなしでもbundled rendererが起動する隔離環境。rootにgraph-source.ts（readConfigがconfigを返す）。
- 操作: Projectにrootを割当→[fixture:graph-source-proposal]送信→今回のみ許可。自動表示されたGraphのapi→参照元→現在の内容を確認。shellで同fileをchangedへ変更→一時rename→復帰→再起動→inline Graph再表示。再提案して履歴比較。
- 合格条件: GRAPH_TOOL_FLOW_OK、図ready、根拠=コード参照あり/内容一致。変更を古い根拠として検知し新旧config/changed両方表示、消失時ファイルなし、復帰時変更あり。選択apiと古い参照を再起動保持。再提案後source ID同じ/hash変更、diffに参照コードと新旧値。
- 証拠・制約: 各段階画面、fixture bytes/hashとsource metadata。同root以外は操作しない。

<a id="archify-graph-02"></a>

## archify-graph-02

旧ケース: `tests/e2e/archify-graph.spec.ts` — the model tool path proposes and reads back a draft through the real Main service

- 前提: Graph fixture有効、新規Task、外部Nodeなし。
- 操作: [fixture:graph-proposal]送信。api→選択解除→store→解除→client→解除。関係線requestでEnd→persistへEnter。指示「この接続は追加案です」をチャットへ追加。再起動してinline Graph。
- 合格条件: 自動でGraph tool proposalを表示、Worker/Mission/execution0。api=推定とAPI説明、store=追加案、client=未確認、解除でfocus chip消失。persistの選択/追加案/保存処理説明。draftはpersistと指示を含み送信しない。再起動後persistの選択と根拠説明が復元。
- 証拠・制約: 選択解除の実入力画面、関係線focus/aria、DBの0件確認と復元。

<a id="archify-graph-03"></a>

## archify-graph-03

旧ケース: `tests/e2e/archify-graph.spec.ts` — reviews and restores a proposed Mission without starting executions

- 前提: Teamなし、Graph Mission fixture。
- 操作: [fixture:graph-mission-proposal]送信→計画を展開。閉じて同依頼を再送→履歴diff。再起動してinline Graph計画。
- 合格条件: 初期「利用できるTeamを確認できません」、3工程、前提client・api、src/api.ts、integration-db。再提案diffに完了条件「APIの互換性テストが成功」と資源integration-db-v2。Mission/executionは0のまま。再起動で変更案保持。
- 証拠・制約: 計画/差分/復元画面と実行0の保存状態。

<a id="archify-graph-04"></a>

## archify-graph-04

旧ケース: `tests/e2e/archify-graph.spec.ts` — checks real Task agreement and ${starts ? 'starts only from a trusted control' : 'invalidates changed evidence'}

- 前提: 隔離git Workspace（graph-source.ts ready=true/version1）、client/api/storeの書込み可能fixture Worker3人、bound Mission fixture。starts=falseとstarts=trueを別profileで実施。
- 操作: 提案を送信しreadを今回のみ許可、Teamから戻り計画展開。falseでは根拠fileをready=false/version2に変更。trueでは開始ボタンを実入力で押す。
- 合格条件: 共通:参照先確認済み、Worker3/Mission0/execution0。false:根拠変更でレビューを失効し「根拠ファイルが変わった」。true:信頼済みUI操作なしの直接開始は拒否、実クリックでMission1/execution3だけ開始・全completed、図client completed、「すべての工程が完了」。
- 証拠・制約: 実施行 starts=false/true。直接呼出し拒否は境界テストを参照。実Workerへの切替は別途明示許可がある場合だけ（既定fixture）。

<a id="archify-graph-05"></a>

## archify-graph-05

旧ケース: `tests/e2e/archify-graph.spec.ts` — resumes one interrupted graph step by hand after a relaunch

- 前提: git Workspace、client/apiは書込み、storeだけread-onlyでfirst event後hold。Worker3人、bound Mission。
- 操作: 提案→開始。client/api completed、store runningを2秒確認し終了。holdなしで同profile再起動、3秒触らず待ちinline Graph→「この工程を再開」。
- 合格条件: 再起動後store waiting_resumeで理由表示（資源保持の停止確認待ちも可）、Mission未完了。自動dispatch/増員なし、Worker3/execution3。再開ボタン1つ、信頼なし直接resume拒否。実操作でstore completed、総数3のままMission完了。
- 証拠・制約: 終了前/再開待ち/再開後の画面、件数/状態。書込みstepをこのread-onlyケースに代用しない。

<a id="archify-graph-06"></a>

## archify-graph-06

旧ケース: `tests/e2e/archify-graph.spec.ts` — renders pinned Archify ${kind} inside a sandboxed Task panel

- 前提: architecture/workflowを各別profile、外部Nodeなし、window1024×740。client/api/store、request/persistを含むGraph fixture。
- 操作: モデルtoolで初図→閉じてexisting draft入力→同図提案。theme切替、api選択、指示をdraftへ追加、閉じる。意味変更でapiをAPI boundaryへ、配置のみ変更、履歴比較、失敗提案、再起動。architectureは途中cancelも確認。
- 合格条件: 自動panel表示、sidebar折畳み、Composer幅≥350px。iframe sandbox=allow-scripts、bridge非公開。dark/light切替。draft保持し指示とgraph ID追加、閉でfocus/sidebar復帰。表示URL200→閉後404。cancelで旧revision維持。意味変更revision+1、配置のみはsemantic revision不変/history開保持/「配置・表示のみ」。比較版変更でAPI boundary差分。失敗通知と旧保存図を保持、再起動後draft・failed/Rejected proposal・同graph ID/保存revisionを保持し旧URL404。
- 証拠・制約: 実施行 kind=architecture/workflow。図・差分・失敗・復元画面。sandbox/bridge/URL/各revisionとcancel raceは補助境界計測が必要。

<a id="graph-mission-update-01"></a>

## graph-mission-update-01

旧ケース: `tests/e2e/graph-mission-update.spec.ts` — discusses a selected graph node, stops affected write work, re-agrees and restores the completed Mission

- 前提: 隔離git Workspace、共有資源を保持する先行Missionと変更対象Mission。bound Graph fixture、real workers無効、初期client/api running・store queued。
- 操作: client選択→「この箇所への指示」に[fixture:graph-update-mission]→チャットへ追加→送信/一度許可。変更案の「影響する工程を停止して変更を確認」→差分確認→「この変更に再合意して再開」。先行hold解除→完了→再起動。
- 合格条件: draftにclient IDを含む。未合意の時点でclientはrunningのまま、直接request/agreeは拒否。停止でclient/store waiting_resume、api継続。合意前semantic revision不変、差分に前提工程/client・store。api完了後、再合意してもstoreは共有資源待ち:resumePending=true、step/integration resumeAvailable=false、誤った手動resumeボタンなし。資源解放後全完了、generation=[2,1,2]。再起動後execution ID/state/generation一致、計画開・全工程完了表示。
- 証拠・制約: 各状態/資源待ち/完了/復元画面とredacted Mission metadata。実Provider成功とは区別。再現用複数Mission fixture不足はBLOCKED。

<a id="graph-view-preference-01"></a>

## graph-view-preference-01

旧ケース: `tests/e2e/graph-view-preference.spec.ts` — restores ${kind} selection in the real viewer after reopen and restart

- 前提: architecture/workflowそれぞれGraph fixture、初回api未選択。
- 操作: 対応するproposalを送信。api選択して根拠表示後に履歴を開く。panel閉→inlineから再表示→同profile再起動→再表示。
- 合格条件: api選択は常に1つ、inspectorにapi、history開を両再表示で維持。再表示時viewer URLは更新されるが選択を失わない。
- 証拠・制約: 実施行 kind=architecture/workflow。初回/再表示/再起動画面、選択数・URL補助比較。
