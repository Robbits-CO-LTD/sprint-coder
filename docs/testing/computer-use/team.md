# Team・Canvas・活動履歴

[共通手順](README.md)。対象OS:macOS／Windows／Linux。通常UIでWorkerを直接雇う入口はない。必要なTeam状態は隔離fixtureか承認済み実ProviderのLeader操作で作る。旧内部API呼び出しをCU操作と呼ばない。fixtureがない条件はBLOCKED。

<a id="a11y-list-view-parity-01"></a>

## a11y-list-view-parity-01

旧ケース: `tests/e2e/a11y-list-view-parity.spec.ts` — role/objective/state/message-lines/team-chip machine-diff identically; List additionally exposes activity + usage

- 前提: Mockの「チームテスト」で3Worker完了済み。
- 操作: Canvasで各role/目的/state/往復message/team chipを記録しListへ切り替えて比較。
- 合格条件: 両viewのWorker role集合3件、目的・state・message行・Team chipが完全一致。各WorkerにLeaderから/Leaderへ各1行（計2行）。Listは「現在:」activity、tokens/tools usageを追加表示しtimeline6件。
- 証拠・制約: 両view画面と項目別比較。

<a id="team-flow-01"></a>

## team-flow-01

旧ケース: `tests/e2e/team-flow.spec.ts` — promotes a Task, and the Leader hires, dispatches, and completes three Workers

- 前提: Mock Team fixtureを有効化。
- 操作: 新規Task→Team→「チームテスト：新機能を進めてください」を送る。
- 合格条件: 依頼前はLeaderによる雇用説明、手動雇用UIなし。調査/実装/レビューの3Workerを順に表示、雇用の通知/読み上げが出る。往復line計6、各done/工程表示、統合結論、completed · Worker 3人、全停止disabled。
- 証拠・制約: 雇用→作業→完了画面と読み上げ/role情報。

<a id="team-flow-02"></a>

## team-flow-02

旧ケース: `tests/e2e/team-flow.spec.ts` — restores an active Team as paused after restart

- 前提: 復元確認roleの未割当Worker1人を持つ隔離Team fixture。
- 操作: 終了→同profile再起動→Team。
- 合格条件: paused · Worker 0人、旧未割当Workerは非表示。「leaderが「復元確認」を雇いました」の履歴は残る。
- 証拠・制約: 前後画面と活動記録。fixture作成ができなければBLOCKED。

<a id="team-flow-03"></a>

## team-flow-03

旧ケース: `tests/e2e/team-flow.spec.ts` — natural team intent fails closed under Mock without fabricating Workers

- 前提: Mock、通常文では組み込みTeam Skill非対応。
- 操作: Chatで「チームでこの仕事を進めてください」。次に手動Teamを開き「やって」。
- 合格条件: 1回目Canvas/Worker0。両回答に「この実行環境では組み込みTeam Skillを利用できないため、Team操作を開始できません。」。手動Canvas表示後もWorker0で架空の雇用なし。
- 証拠・制約: 2回答とTeam画面。

<a id="team-activity-history-01"></a>

## team-activity-history-01

旧ケース: `tests/e2e/team-activity-history.spec.ts` — shows who was hired and delegated to, and restores the identical activities

- 前提: packaged app、Mock。
- 操作: Teamで「チームテスト：活動履歴の永続化を確認してください」。3人完了後の活動summaryを展開し、再起動後Chat/Teamで確認。
- 合格条件: 回答より前に「作業しました」summary1つ、初期折畳み。雇用3・割当3、調査/実装/レビュー各1。activity IDは空なし/重複なし/永続データと一致。再起動後も同ID集合、summaryは折畳み、Team切替で重複しない。
- 証拠・制約: 展開前後/再起動画面とredacted ID集合。DB/状態の照合なしではID条件はBLOCKED。

<a id="team-cables-01"></a>

## team-cables-01

旧ケース: `tests/e2e/team-cables.spec.ts` — hire draws no cable and dismissal removes the Worker from both views

- 前提: 手動雇用の代わりに未割当Worker1人を用意できるfixture。
- 操作: Canvasで雇用直後を確認し「解雇」、Listへ切替。
- 合格条件: 雇用だけではhierarchy edge/cable/glowなし。解雇で両viewのWorker0、status chipも0人。
- 証拠・制約: 雇用直後/両view画面。

<a id="team-cables-02"></a>

## team-cables-02

旧ケース: `tests/e2e/team-cables.spec.ts` — Leader send draws a cable between the correct pair and glows only after ack

- 前提: LeaderとWorker1人、ackを観測可能なfixture。
- 操作: LeaderからそのWorkerへ依頼を送信。
- 合格条件: 2秒以内に正しいsource Leader/target Worker間のcable。ack後3秒以内に対象1人だけglow、20秒以内done。
- 証拠・制約: 動画/時刻付き観測とsource/target/ack metadata。見た目だけでack順序を推定しない。

<a id="team-cables-03"></a>

## team-cables-03

旧ケース: `tests/e2e/team-cables.spec.ts` — two messages queued back-to-back to different Workers both play their cables

- 前提: 未割当Worker実装/レビュー2人。
- 操作: 連続して各Workerへ別依頼を送る。
- 合格条件: 5秒以内に両Workerそれぞれのcable/glowが再生され、後続依頼を取りこぼさない。
- 証拠・制約: 連続送信から両ハイライトの動画、配送metadata。

<a id="team-cables-04"></a>

## team-cables-04

旧ケース: `tests/e2e/team-cables.spec.ts` — a message to an offscreen Worker still plays its cable without moving the camera

- 前提: Worker1人とFit済みCanvas。
- 操作: 空白をpanしてWorkerを画面外へ移し、Workerへ送信。
- 合格条件: cameraはuser所有。画面外宛てもcableが生成されるが、送信後3秒間camera transformは送信前と一致。
- 証拠・制約: 画面外条件/前後camera数値・配送証拠。可視でないcable生成は補助計測。

<a id="team-cables-05"></a>

## team-cables-05

旧ケース: `tests/e2e/team-cables.spec.ts` — cable animation survives an active pan without throwing, and is eventually removed

- 前提: Worker1人、Fit済み。
- 操作: Workerへの送信と同時に空白を300px横/200px縦へpan。
- 合格条件: pan中も例外なし、cableは5秒以内に消える。
- 証拠・制約: 動画とrenderer/console error0のログ。

<a id="team-cables-06"></a>

## team-cables-06

旧ケース: `tests/e2e/team-cables.spec.ts` — reduced motion: no path/packets — immediate highlight plus a mirrored textual event

- 前提: 動きを減らす設定、Worker1人。
- 操作: Leaderから送信して報告を待つ。
- 合格条件: cable path/packetなし、2秒以内に対象をhighlight。「依頼を送信」「報告を受信」の文字イベントと空でないannouncer。
- 証拠・制約: 画面・読み上げ状態、必要ならpath0の補助測定。

<a id="team-canvas-layout-01"></a>

## team-canvas-layout-01

旧ケース: `tests/e2e/team-canvas-layout.spec.ts` — renders five Workers at distinct non-overlapping positions in Canvas and List

- 前提: 未割当Worker5人（調査/設計/実装/レビュー/検証）のfixture。
- 操作: Canvas全体を確認しListへ切替。
- 合格条件: 5枚すべて別座標かつ互いに矩形が重ならない。Listも5人、active · Worker 5人。
- 証拠・制約: Canvas座標比較と両view画面。

<a id="team-canvas-layout-02"></a>

## team-canvas-layout-02

旧ケース: `tests/e2e/team-canvas-layout.spec.ts` — fits ${workerCount} Workers in a six-column grid and persists the view through restart

- 前提: 34人/100人を別profileで用意するfixture。
- 操作: 各条件でFit→保存完了→再起動→Team。
- 合格条件: 34人は6列6行、100人は6列18行、全pair非重複。Fitで全cardがCanvas内±1px。保存nodePositions件数=人数、保存cameraと表示scale差<0.0001/xy差<1px。再起動後未割当Worker0でもnodePositions完全保持、camera scale差<0.0001/xy差<2px。
- 証拠・制約: 実施行: workerCount=34,rowCount=6 と workerCount=100,rowCount=18。座標・保存view比較と画像。

<a id="team-canvas-layout-03"></a>

## team-canvas-layout-03

旧ケース: `tests/e2e/team-canvas-layout.spec.ts` — persists a dragged node position and camera across restart, and hides the stopped Worker

- 前提: 未割当Worker実装1人。
- 操作: nodeをドラッグ、camera pan/zoom後再起動。縮小時hoverも確認。
- 合格条件: LOD1で本文は隠れるがrole/statusは見える。hoverに実装/待機中/「Leaderからの依頼を待っています」。保存revision≥1。再起動後Worker0、保存nodePositions一致、camera xy差≤5px/scale差≤0.05、revision後≥前。
- 証拠・制約: 座標/LOD/hover/再起動の画面と保存値。

<a id="team-canvas-layout-04"></a>

## team-canvas-layout-04

旧ケース: `tests/e2e/team-canvas-layout.spec.ts` — List表示 reflects a hired and dispatched Worker exactly like Canvas表示 does

- 前提: 空Team、List表示。
- 操作: Leader経由のfixtureでWorker1人を雇用・割当し完了後Canvasへ。
- 合格条件: List中もComposerあり、手動雇用UIなし。Worker1人doneが見え、Canvas切替後も同1人。toggleラベルは切替先（Canvas表示/List表示）。
- 証拠・制約: 両view画面とrole/state照合。

<a id="team-canvas-layout-05"></a>

## team-canvas-layout-05

旧ケース: `tests/e2e/team-canvas-layout.spec.ts` — camera ownership starts system, and manual pan and Fit view keep user ownership

- 前提: 空Canvas、normal motion。
- 操作: 入場演出完了→空白pan。Fitボタン→Worker追加、次にFキー→別Worker追加。
- 合格条件: 初期system→手動panでuser。Fit/F後もuser。各追加後1600ms、2frame以上を測りtransformがFit直後と完全一致、一瞬の自動追従もない。最終2Worker。
- 証拠・制約: 全期間のframe transform計測と動画。最終位置のみの一致は不可。

<a id="team-canvas-layout-06"></a>

## team-canvas-layout-06

旧ケース: `tests/e2e/team-canvas-layout.spec.ts` — a manually-repositioned Worker does not collide with a newly hired one

- 前提: Worker1人。
- 操作: 既存nodeを通常新規配置位置へドラッグしてから別Workerを追加。
- 合格条件: 既存/新規Workerの矩形が重ならない。
- 証拠・制約: 移動後/追加後の座標と画面。

<a id="team-canvas-layout-07"></a>

## team-canvas-layout-07

旧ケース: `tests/e2e/team-canvas-layout.spec.ts` — Arrow/Tab select nodes, Enter opens + camera-focuses, Escape returns focus, F fits

- 前提: LeaderとWorker1人。
- 操作: CanvasへfocusしF、ArrowRight/LeftとTab/Shift+Tabで選択、WorkerでEnter、Escape、L/EnterでLeader、FでFit。
- 合格条件: 選択は常に1つでLeader↔Worker移動。EnterはWorker内部へfocusしcamera system、EscapeはCanvasへ戻る。Fをユーザーが押した時はuser所有を維持。
- 証拠・制約: キー列・フォーカス・camera ownerの記録。

<a id="team-morph-01"></a>

## team-morph-01

旧ケース: `tests/e2e/team-morph.spec.ts` — preserves draft, scroll, and the ChatSurface instance across a chat<->team cycle

- 前提: Mock履歴がviewportより240px以上長く、更新が500ms静止。未送信draftと文字選択3〜9、scrollTop80かつ末尾から>40px。
- 操作: Chat→Team→Chatを切り替える。
- 合格条件: draft全文と非空選択3〜9が全遷移で一致。Chat復帰時scrollTopが元と完全一致。ChatSurface mount counterが増えない。
- 証拠・制約: draft/選択/scrollとmount counter前後。mount計測なしでインスタンス保持をPASSにしない。

<a id="team-morph-02"></a>

## team-morph-02

旧ケース: `tests/e2e/team-morph.spec.ts` — rapid double-toggle (enter then exit quickly) ends in a consistent chat state

- 前提: 新規Task、normal motion。
- 操作: Teamへ入り戻るボタンが見えたら即押す（約560ms入場中）。もう一度Teamへ。
- 合格条件: 5秒以内に通常Chatへ戻りTeam残骸なし、Composer使用可。再入場も成功しmount counter不変。
- 証拠・制約: 動画とmount counter。実際に演出途中を押せなければBLOCKEDで再実施。

<a id="team-policy-01"></a>

## team-policy-01

旧ケース: `tests/e2e/team-policy.spec.ts` — edits the canonical policy from Canvas and remains available in List view

- 前提: Team Canvas、元policy/revisionを記録。競合更新fixtureも準備。
- 操作: policyでdepth3/concurrency5/direct messages OFF/budget unlimited保存→再表示→Escape。Listへ切替して開く。開いたまま別更新でconcurrency4を保存し古いdialogで保存。
- 合格条件: 最初は正本値。保存でrevision+1、選択4項目が正本に一致しtriggerへfocus復帰。Listでも値保持、header内±1px/overflow≤1px。「保存できませんでした」alertでdialog維持、競合時正本は4を守る。閉じるでList triggerへfocus。
- 証拠・制約: 値/revision前後、競合画面と保存値、header寸法。競合fixtureなければ該当部分BLOCKED。

<a id="team-task-switch-01"></a>

## team-task-switch-01

旧ケース: `tests/e2e/team-task-switch.spec.ts` — creating and re-selecting Tasks from the List view stays operable

- 前提: 途中Mock応答を止められるprofile。
- 操作: Task Aで送信→停止→Team List。Canvas→Listで戻る。ListからTask B新規→送信停止→Team List→A選択→送信停止→Team→戻る。
- 合格条件: A/B別ID。Canvasではsidebar inert、Listでは操作可能。Task切替で「Teamを準備しています」に止まらずComposer使用可。各停止はcanceled/stream消失/入力有効。Aへ正しく戻りTeamを閉じられる。
- 証拠・制約: 各Task選択と停止結果、inert補助検査。
