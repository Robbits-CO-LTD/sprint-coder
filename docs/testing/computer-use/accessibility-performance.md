# アクセシビリティ・性能・最終レイアウト

[共通手順](README.md)。対象OS:macOS／Windows／Linux。UI状態はComputer Useで作る。axe、frame timing、DOM寸法、mount/observer、境界APIなどの補助検査は、元ケースと同じ実build・状態で行った証拠が必要。許可された観測経路がなければBLOCKEDとする。UIをプログラム操作する新runnerは追加しない。

<a id="a11y-axe-01"></a>

## a11y-axe-01

旧ケース: `tests/e2e/a11y-axe.spec.ts` — chat view (empty + populated)

- 前提: axe-coreを対象の実Rendererへ安全に監査できる補助手段。Mock、初期設定済み。
- 操作: 空Chatを表示→送信中に追加文を入力して割込みbuttonを表示→入力を消して完了済みChat。各状態をCUで作り監査する。
- 合格条件: 空/完了Chat全体、実行中Composerのみでaxe serious/critical違反0。「割り込んで送信」のaccessible name。
- 証拠・制約: 3つのaxeレポート（engine版・対象build・scope・rule/node/impact）と画面。目視や別DOMでの監査は代替不可。監査経路なしはBLOCKED。

<a id="a11y-axe-02"></a>

## a11y-axe-02

旧ケース: `tests/e2e/a11y-axe.spec.ts` — settings dialog open

- 前提: axe監査手段。
- 操作: 設定dialogを開き演出完了後に実画面全体を監査。
- 合格条件: dialogが表示され、axe serious/critical違反0。
- 証拠・制約: axeレポートとdialog画面。演出中の過渡状態で測定しない。

<a id="a11y-axe-03"></a>

## a11y-axe-03

旧ケース: `tests/e2e/a11y-axe.spec.ts` — approval card visible state

- 前提: axe監査手段、Mock承認probe。
- 操作: 「承認テストをしてください」を送り承認カードを開いたまま監査。
- 合格条件: 承認カードを含む実画面全体でserious/critical違反0。
- 証拠・制約: axeレポートと承認画面。

<a id="a11y-axe-04"></a>

## a11y-axe-04

旧ケース: `tests/e2e/a11y-axe.spec.ts` — team canvas (populated with 3 workers)

- 前提: axe監査手段、Mock Team3Worker完了。
- 操作: Canvasで演出/通知が静止してから監査。Listへ切替、700ms以上の静止後監査。
- 合格条件: Canvas/Listそれぞれ全画面でserious/critical違反0。Canvasはsidebar/headerが非表示状態で測る。
- 証拠・制約: 2レポートと画面。Worker0の空Canvasで代用しない。

<a id="a11y-keyboard-golden-path-01"></a>

## a11y-keyboard-golden-path-01

旧ケース: `tests/e2e/a11y-keyboard-golden-path.spec.ts` — completes entirely via page.keyboard, focus never lost, Tab never traps

- 前提: Mock、初期設定済み。マウス操作なし。
- 操作: Tabで新規Task→日本語送信→Team→L/EnterでLeader→「チームテスト：golden path確認」→3人完了→Escape→右矢印2回→Enter→F→L/Enter→TabでListへ→Tabで戻る→draft入力。
- 合格条件: 全行程でfocusがbody/無指定へ落ちずTab trapなし。Team入場/EscapeはCanvas、node選択1つ、done WorkerのEnterでもCanvas維持、Leader EnterはComposer。Listは3人と単一Team view、戻るでteam toggleへfocus。最後のdraft完全一致、入力/送信有効。
- 証拠・制約: キー操作列と各境界focus、最後の画面。100回以内Tab到達の旧上限を保持し無限探索しない。

<a id="a11y-reduced-motion-01"></a>

## a11y-reduced-motion-01

旧ケース: `tests/e2e/a11y-reduced-motion.spec.ts` — (a) Team-mode entry camera fly is skipped — settles immediately, no rAF-driven transform churn

- 前提: OS reduced motion有効、空Task。frame単位のtransformを観測する補助手段。
- 操作: Teamへ入り直後の約20frameを採取。
- 合格条件: transformは空でなく、全sampleが同一のsettled値。
- 証拠・制約: 20frame値。見た目が速いだけではPASSにしない。

<a id="a11y-reduced-motion-02"></a>

## a11y-reduced-motion-02

旧ケース: `tests/e2e/a11y-reduced-motion.spec.ts` — (a, contrast) without reduced motion, the same entry visibly animates the transform across frames

- 前提: normal motion、同じTask条件。入場前からframe採取を開始。
- 操作: Teamへ入り40frameのtransformを記録。
- 合格条件: 異なるtransformが2種類以上あり通常演出が実際に動く。
- 証拠・制約: 40frame値と動画。開始後に測り始めて演出を取り逃がした場合は再実施。

<a id="a11y-reduced-motion-03"></a>

## a11y-reduced-motion-03

旧ケース: `tests/e2e/a11y-reduced-motion.spec.ts` — (b) Worker spawn animation is instant under reduced motion, full duration otherwise

- 前提: reduced/normalを別profile、3Worker spawn fixture。
- 操作: 各設定でTeamの「チームテスト」を送る。
- 合格条件: Worker spawnのcomputed animation-durationはreduced<1ms、normal>50ms。
- 証拠・制約: 2条件のcomputed styleと画面。

<a id="a11y-reduced-motion-04"></a>

## a11y-reduced-motion-04

旧ケース: `tests/e2e/a11y-reduced-motion.spec.ts` — (c) Chat<->Team morph exit animation is instant under reduced motion, full duration otherwise

- 前提: reduced/normalを別profile、空Team。
- 操作: 入場静止後にChatへ戻る。退出開始の瞬間のdurationを採取。
- 合格条件: 退出durationはreduced<1ms、normal>50ms、reducedは直ちにTeamが消える。
- 証拠・制約: 退出時のMutationObserver相当の補助記録。退出後の要素不存在をduration0と解釈しない。

<a id="a11y-zoom-01"></a>

## a11y-zoom-01

旧ケース: `tests/e2e/a11y-zoom.spec.ts` — chat view at 2.0x: no horizontal scroll, composer usable

- 前提: 200% zoom、Chat。
- 操作: 日本語を入力して送信。
- 合格条件: document/app-shellの横overflow≤4px。textarea/sendの左上≥0、右下がviewport+2px以内。入力/送信が見えMockが20秒以内完了。
- 証拠・制約: zoomと各寸法・完了画面。

<a id="a11y-zoom-02"></a>

## a11y-zoom-02

旧ケース: `tests/e2e/a11y-zoom.spec.ts` — running Composer actions reflow at 150%, 200%, and a 320px effective viewport

- 前提: Mock承認待ちRun、割込み用draft。
- 操作: 150%・200%で操作列を見る。200%のままwindow640×800（effective viewport≤320px）でも見る。
- 合格条件: document/shell横overflow≤4px。150/200%の割込み/送信が表示され各24×24px以上。320px相当でも両操作が見える。
- 証拠・制約: 3条件の画面・viewport/操作寸法。window最小size制限で到達不可ならBLOCKED。

<a id="a11y-zoom-03"></a>

## a11y-zoom-03

旧ケース: `tests/e2e/a11y-zoom.spec.ts` — list view at 2.0x: no horizontal scroll, controls remain reachable

- 前提: Team List、200% zoom。
- 操作: 横scrollと戻るbuttonを確認し戻る。
- 合格条件: document/shell横overflow≤4px。戻るbuttonの左≥0/右≤viewport+2px、到達してChatへ戻れる。
- 証拠・制約: 寸法、List/Chat画面。

<a id="perf-budgets-01"></a>

## perf-budgets-01

旧ケース: `tests/e2e/perf-budgets.spec.ts` — startup, composer latency, and 10-worker canvas pan stay within budget

- 前提: 実ディスプレイで性能記録可能な隔離build。10Worker×各200message描画fixture（元はDOM stress用で実Worker10人の証明ではない）。
- 操作: 起動→Task入力可能まで測定。25ms間隔相当の日本語typing3系列でinput event→次frameのp95を採取し中央値。Canvasを2秒連続pan→zoom out。
- 合格条件: 目標:startup2000ms、入力p95 16ms、pan≥50fps。旧合否上限:local startup<6000ms（旧CI<12000ms）、3系列p95中央値≥0かつ<48ms、local pan>40fps。旧CIはframe>1/transform変化のみで速度保証なし。zoom outでLOD1/2、閾値0.55/0.32。stream batching100ms/64KBは残す単体テストで検証。
- 証拠・制約: 起動timestamp、全latency sample/中央値、fps/frames/transform/LOD、hardware・display・GPU・build。rAF/input計測と同等負荷fixtureなしはBLOCKED。体感だけではPASS不可。

<a id="auto-decision-flood-perf-01"></a>

## auto-decision-flood-perf-01

旧ケース: `tests/e2e/auto-decision-flood-perf.spec.ts` — keeps frames flowing and groups the decisions per Turn

- 前提: Mock Team3人。Auto判定3000件を100件/秒で同じ永続化/event経路へ流すfixture。frame/long task測定。
- 操作: Teamで「チームテスト：Auto判定を大量に記録する」を送る。最初の判定受信から統合回答まで計測、完了後summaryを展開。
- 合格条件: Turnごとsummary1件、初期audit行0。「自動許可 3000件」「2800件は省略、最新200件を表示」と対応するaccessible label。展開で200件、最終3000/3000、最新へが出てtail追従停止。local long task合計<5000ms/elapsed<50000ms（旧CI<15000/<90000）。frame gap/Main応答/雇用区間は別記し旧caseにないgap閾値を捏造しない。
- 証拠・制約: 時刻付きmetrics、雇用区間と判定区間を区別、summary/展開画面。負荷または計測未準備はBLOCKED。

<a id="ui-final-layout-01"></a>

## ui-final-layout-01

旧ケース: `tests/e2e/ui-final-layout.spec.ts` — keeps Composer controls ordered, visible, and interactive

- 前提: 新規Task、統合Pickerまたは旧Picker。旧PickerではCodexを選択してモデル操作可能にする。
- 操作: Composer各controlを確認し＋/Access/モデルを開く→Escape。
- 合格条件: ＋→Access→run controls→送信の順、controls内model→effort。＋はrow左端±1px、横overflow≤1px、両端がComposer内。全control表示。各メニューが開閉しexpanded値一致、model有効。renderer/console error0。
- 証拠・制約: 座標・メニュー画面・redactedログ。

<a id="ui-final-layout-02"></a>

## ui-final-layout-02

旧ケース: `tests/e2e/ui-final-layout.spec.ts` — keeps the custom titlebar separate from content and Team policy visible

- 前提: macOS/Windows/Linuxの対象build。
- 操作: titlebarと本文境界を確認→Team List→policyを開き閉じる。
- 合格条件: macOS/Windowsはtitlebar高さ≥36px、本文開始が下端以後、drag領域。LinuxはOS装飾を使う。Listのpolicyがheader内±1px、overflow≤1px。policyが開閉できrenderer/console error0。
- 証拠・制約: OS別画面、寸法/drag style、ログ。

<a id="task-auto-title-01"></a>

## task-auto-title-01

旧ケース: `tests/e2e/task-auto-title.spec.ts` — names a Task from its first message, then never touches it again

- 前提: 新規Task、Mock。
- 操作: 「ログイン画面のバグを直して

詳細:

- トークンが切れる」を送る。異なる2通目を送り再起動。
- 合格条件: 選択中の空Taskは新しいタスク/未開始。最初の送信で1行目だけが即title、placeholder消失。2通目で改名しない。再起動後も同title。
- 証拠・制約: 送信前/直後/2通目/復元sidebar。

<a id="task-auto-title-02"></a>

## task-auto-title-02

旧ケース: `tests/e2e/task-auto-title.spec.ts` — leaves a manually renamed Task alone

- 前提: 1件目Taskが存在するprofile。
- 操作: 2件目Taskのheaderで「自分で付けた名前」に変更しEnter、その後別内容を送信。
- 合格条件: header/sidebarの手動名が保持され本文で上書きなし。1件目の自動titleも残り2Taskを区別可能。
- 証拠・制約: 2Task/sidebarとheader。
