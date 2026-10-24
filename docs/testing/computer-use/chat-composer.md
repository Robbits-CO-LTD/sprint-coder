# Chat・Composer・履歴

共通前提・結果の付け方は[README](README.md)。対象OSは各ケースともmacOS／Windows／Linux。測定条件があるケースは画面証拠と補助測定の両方が揃って初めてPASS。

<a id="golden-path-1-restart-restore-01"></a>

## golden-path-1-restart-restore-01

旧ケース: `tests/e2e/golden-path-1-restart-restore.spec.ts` — message and streamed answer survive an app restart

- 前提: 初期設定済みの隔離profile。Mockの途中応答を観測できる長さ/hold fixtureを用意する。
- 操作: 新規Taskで「このリポジトリの構成を教えて (golden-path-1)」を送信し、runningと空でない途中応答を観測してから完了まで待つ。同じprofileで終了・再起動する。
- 合格条件: 完了前に本文が表示される。送信文が完全一致し「決定論的なモック応答です」を含む回答が完成する。再起動後、同じTaskと両メッセージ全文が復元される。
- 証拠・制約: 途中/完了/再起動の画面、同一Task IDと保存履歴の照合。hold解除が旧Main注入に依存する環境ではその部分はBLOCKED。

<a id="golden-path-2-cancel-01"></a>

## golden-path-2-cancel-01

旧ケース: `tests/e2e/golden-path-2-cancel.spec.ts` — stopping a running turn keeps the partial answer and shows a canceled state

- 前提: Mockの途中応答を停止できるfixture。
- 操作: 依頼を送信し本文が出た後、空のComposerの「実行を停止」を押す。
- 合格条件: 15秒以内にRunがcanceled／「中止」になる。空でない部分回答が通常の履歴として残り、streaming吹き出しが消える。停止ボタンは有効で操作名が「実行を停止」。
- 証拠・制約: 停止直前/直後の画面、時間と部分回答の存在。

<a id="golden-path-3-queue-01"></a>

## golden-path-3-queue-01

旧ケース: `tests/e2e/golden-path-3-queue.spec.ts` — a message queued during Turn 1 auto-starts as Turn 2 and completes

- 前提: 新規Task、Mock応答。
- 操作: Turn1を送信し実行中にTurn2を入力してEnter。キュー表示を観測し、何も押さず完了を待つ。
- 合格条件: キューにTurn2本文と#1が出る。Turn1後にキューが空になりTurn2が自動開始・完了。ユーザー文/回答が各2件で順序・本文に欠落や重複がない。
- 証拠・制約: キュー待ちと完了履歴の画面。

<a id="golden-path-3-queue-02"></a>

## golden-path-3-queue-02

旧ケース: `tests/e2e/golden-path-3-queue.spec.ts` — cancels Turn 1, starts the interruption, then runs the preserved queue

- 前提: Turn1を途中応答で保持できるfixture。
- 操作: Turn1中にTurn3をEnterでキューへ入れる。Turn2の入力後「割り込んで送信」を押し、Turn2開始を確認してからholdを解除する。
- 合格条件: 割込み前の履歴は1件。Turn2が直ちに2件目として始まり、Turn3はキューに残る。最終ユーザー履歴がTurn1→Turn2→Turn3の3件、キュー0件、最終Run completed。
- 証拠・制約: 割込み前/直後/最終の画面とTurn順序。hold解除経路がなければBLOCKED。

<a id="keyboard-smoke-01"></a>

## keyboard-smoke-01

旧ケース: `tests/e2e/keyboard-smoke.spec.ts` — Task creation, composing, and sending complete via keyboard alone

- 前提: 初期設定済みの新規Taskを作れる画面。
- 操作: マウスを使わずTabで新規Taskへ移動してEnter、Tabで入力欄へ移動し日本語を入力してEnter。
- 合格条件: Task作成→入力→送信がキーボードだけで完了。20秒以内のMock完了、送信文字列の完全一致、決定論的応答の表示。
- 証拠・制約: キー操作の記録、フォーカスと最終画面。

<a id="composer-input-boundaries-01"></a>

## composer-input-boundaries-01

旧ケース: `tests/e2e/composer-input-boundaries.spec.ts` — preserves Shift+Enter, committed Japanese text, and long-input scrolling

- 前提: 新規Task、Mock。
- 操作: 「第一行：日本語入力テスト」を日本語IMEで確定。Shift+Enterで改行し、2〜9行目は「長文入力でも欠落や二重化を起こさない。」を各4回入れる。入力欄をスクロールして全文を確認しEnter送信。
- 合格条件: Shift+Enterは送信せず改行、IME確定で欠落/二重化なし。全9行が入力/ユーザー履歴で一致。入力欄高さ≤140px、scrollHeight>clientHeight、左右端がComposer内に収まる。
- 証拠・制約: 入力全文の比較、画面、寸法の補助計測。IMEで変換中Enterと確定後Enterを区別する。

<a id="composer-plus-menu-01"></a>

## composer-plus-menu-01

旧ケース: `tests/e2e/composer-plus-menu.spec.ts` — opens by keyboard, navigates with arrows and Home/End, and Escape returns focus

- 前提: 新規Task。
- 操作: Tabで＋へ、ArrowDown→上下キーで循環→Home/End→Escape、再度＋でArrowUp→Escape。
- 合格条件: ＋は有効。ArrowDownは先頭の画像添付へ、ArrowUpは末尾の画像生成へ。上下移動が2項目を循環しHome/Endが両端へ移る。Escapeで閉じ＋へフォーカスが戻る。
- 証拠・制約: 開閉・フォーカスの画面/アクセシビリティ状態。

<a id="composer-plus-menu-02"></a>

## composer-plus-menu-02

旧ケース: `tests/e2e/composer-plus-menu.spec.ts` — closes on an outside click without hijacking focus

- 前提: ＋メニューが開いている。
- 操作: メニューと重ならないタイムラインの空白をクリック。
- 合格条件: メニューが消え、＋が閉じた状態になる。クリック先のフォーカスを＋が奪わない。
- 証拠・制約: クリック前後の画面。

<a id="composer-plus-menu-03"></a>

## composer-plus-menu-03

旧ケース: `tests/e2e/composer-plus-menu.spec.ts` — does not expose a separate Goal input or plus-menu control

- 前提: 新規Task。
- 操作: 入力欄と＋メニューの内容を確認。
- 合格条件: 独立したGoal入力・Task Goal chip・＋内Goal項目はない。通常placeholderは「メッセージを送信 (Enterで送信 / Shift+Enterで改行)」。
- 証拠・制約: 通常Composerとメニューの画面。

<a id="composer-plus-menu-04"></a>

## composer-plus-menu-04

旧ケース: `tests/e2e/composer-plus-menu.spec.ts` — unavailable items stay focusable and state their reason

- 前提: Mock選択。
- 操作: ＋を開き、添付と画像生成へキーで移動し、利用不可項目を押す。
- 合格条件: 両方が利用不可と説明されつつフォーカス可能。添付は「Codex CLI Runtime」、画像生成は「Codex Runtime」が必要と分かる。操作しても実行せずメニューを閉じない。
- 証拠・制約: キー到達/理由表示。補助検査でaria-disabled=true、native disabled=false。

<a id="composer-plus-menu-05"></a>

## composer-plus-menu-05

旧ケース: `tests/e2e/composer-plus-menu.spec.ts` — selects, removes, sends, and restores image attachment metadata

- 前提: 隔離したfixture.png、旧Picker設定（SPRINT_CODER_MULTI_PROVIDER_MODEL_PICKER_V2=0）、Codexの画像対応fixtureモデル。課金送信は無効化したfixture。
- 操作: ＋からOSファイル選択で画像を添付し削除、再添付して「この画像を確認してください」を送信。同profileで再起動。
- 合格条件: 送信前にfixture.pngが表示され削除可能。送信履歴に本文と参照画像名が残り、再起動後も両方復元。
- 証拠・制約: 送信前/削除後/復元画像、保存した添付metadata。実Providerしか利用できない場合は許可なし送信をしない。

<a id="composer-plus-menu-06"></a>

## composer-plus-menu-06

旧ケース: `tests/e2e/composer-plus-menu.spec.ts` — attaches the clipboard image on paste and shows it as a thumbnail

- 前提: Codex画像対応fixtureモデル。既存クリップボードを保護し8×8 PNGと6016×3384 PNGを用意。
- 操作: 通常のOSコピー/貼り付けで画像をComposerへ貼る。削除して6K画像でも繰り返す。
- 合格条件: 添付は1枚、命名が「貼り付け画像-YYYYMMDD-HHMMSS.png · PNG · …」。縮小thumbnailが見え文字入力は空。削除可能。6Kでも1枚添付されエラーなし。信頼済みpasteなしのclipboard取得は拒否され添付0件。
- 証拠・制約: 画像2サイズの画面。thumbnailはdata:image/webp;base64でpath/URLを露出しないことと未承認clipboard拒否は境界テスト/補助計測が必要。取得できなければその条件はBLOCKED。

<a id="composer-plus-menu-07"></a>

## composer-plus-menu-07

旧ケース: `tests/e2e/composer-plus-menu.spec.ts` — the menu stays inside the Leader node on the Team Canvas

- 前提: Team Canvas、Leaderノード。
- 操作: Leaderの＋メニューを開く。
- 合格条件: 全メニュー辺がLeader枠内（許容1px）で切れず、項目を操作できる。
- 証拠・制約: 4辺の画面と座標測定。

<a id="composer-slash-commands-01"></a>

## composer-slash-commands-01

旧ケース: `tests/e2e/composer-slash-commands.spec.ts` — filters, navigates, dismisses, and runs commands from the composer

- 前提: 新規Task、Mock。
- 操作: 「/」→下矢印でGoal→Enter。Goal本文を入れEnter。「/tea」で候補を絞りEscape。「/team」をTabで実行。
- 合格条件: 初期候補はnew、下でgoal。Goal選択後入力空・フォーカス維持、専用placeholderとarmed表示。Goal開始でarmedが消え本文付き完了region、別Goal入力なし。/teaはTeamのみ、Escape後文字列保持。/team実行でTeamが開き入力空。
- 証拠・制約: 各候補・Goal結果・Team画面。

<a id="composer-slash-commands-02"></a>

## composer-slash-commands-02

旧ケース: `tests/e2e/composer-slash-commands.spec.ts` — does not send an unavailable command as a chat message

- 前提: 画像生成非対応のMock。
- 操作: 「/image」と入力しEnter。
- 合格条件: 利用不可が伝わり、/imageの文字とメニューが残る。チャットメッセージとして送信されない。
- 証拠・制約: メニュー状態、履歴件数。

<a id="codex-imagegen-01"></a>

## codex-imagegen-01

旧ケース: `tests/e2e/codex-imagegen.spec.ts` — is selectable only for Codex, and states the Runtime requirement otherwise

- 前提: 旧Picker、課金しないRuntime選択確認。
- 操作: Mock・Claude・Codexの順に切り替え、それぞれ＋の画像生成項目を確認。
- 合格条件: MockはCodex Runtime要件付きで利用不可、Claudeも利用不可、Codexでは選択可能。
- 証拠・制約: 3状態の画面。固定モデル名はfixtureの値であり現行catalogの根拠にはしない。

<a id="codex-imagegen-02"></a>

## codex-imagegen-02

旧ケース: `tests/e2e/codex-imagegen.spec.ts` — arms for one send only, and can be cancelled before sending

- 前提: Codex選択。
- 操作: 画像生成を選びarmed表示を確認、その表示をクリックして解除。
- 合格条件: 初期armedなし→次回送信の明示表示あり→解除後なし。恒久モードにならない。
- 証拠・制約: 選択前/armed/解除画面。

<a id="codex-imagegen-03"></a>

## codex-imagegen-03

旧ケース: `tests/e2e/codex-imagegen.spec.ts` — puts the directive in the sent message, and reports an unfulfilled request

- 前提: 旧Picker、画像を返さないMock fixture。
- 操作: Codexで画像生成をarmedにしてMockへ戻し「青いアイコンを作って」を送信。
- 合格条件: 保存ユーザー文に$imagegen・依頼文・「コピーや移動は行わないでください」が含まれる。completed後に画像未生成の通知があり、生成画像カード0件。armedは1回で消費される。
- 証拠・制約: 保存文と未生成通知。実画像の生成成功証拠とは区別する。

<a id="codex-imagegen-04"></a>

## codex-imagegen-04

旧ケース: `tests/e2e/codex-imagegen.spec.ts` — an ordinary message shows no image notice at all

- 前提: Mock、armedなし。
- 操作: 通常の依頼を送信して完了まで待つ。
- 合格条件: 画像未生成通知も画像カードも出ない。
- 証拠・制約: 通常回答画面。

<a id="reasoning-pill-01"></a>

## reasoning-pill-01

旧ケース: `tests/e2e/reasoning-pill.spec.ts` — shows a one-line status header while active and keeps it after completion

- 前提: 途中応答を保持できるMock。
- 操作: 依頼を送り実行中ヘッダを観測し、hold解除後完了まで待つ。
- 合格条件: 実行中/完了とも高さ<56px。「思考中」・段階の文字・停止が見える。旧generation indicator/pixel、stage progress/rowがない。途中本文は完成前に見える。完了後「完了」が残る。
- 証拠・制約: 両状態の寸法と画面。

<a id="reasoning-pill-02"></a>

## reasoning-pill-02

旧ケース: `tests/e2e/reasoning-pill.spec.ts` — opens the reasoning panel, streams paragraphs, and never moves the timeline scroll

- 前提: 思考を返すMock。
- 操作: 送信後の思考toggleを開き段落を読み、完了まで待つ。
- 合格条件: 初期閉→開、空placeholderなし、段落重複なし。開閉でタイムラインscrollTopを変えない。完了後も開を保持。panelはregionでaria-liveなし、経過時間はaria-hidden。
- 証拠・制約: 段落比較とscrollTop/アクセシビリティ補助測定。

<a id="reasoning-pill-03"></a>

## reasoning-pill-03

旧ケース: `tests/e2e/reasoning-pill.spec.ts` — completes a keyboard round trip: open, enter the panel, collapse back to the toggle

- 前提: 実行中の思考toggleがある。
- 操作: キーボードEnterで開きTab、toggleへ戻りEnterで閉じる。
- 合格条件: 開閉状態が正しく、開いた後Tabは停止へ到達、閉じた後toggleへフォーカス保持。
- 証拠・制約: キー操作とフォーカス。

<a id="reasoning-pill-04"></a>

## reasoning-pill-04

旧ケース: `tests/e2e/reasoning-pill.spec.ts` — degrades to a non-interactive label when no reasoning arrives

- 前提: 思考イベントを返さないfixture。
- 操作: 依頼を送り思考未取得状態を確認。
- 合格条件: クリック不可の「思考中」ラベル、停止あり、toggleとpanelなし。そのまま完了可能。
- 証拠・制約: no-reasoning状態の画面。実際に思考が来た回ではこの分岐をPASSにしない。

<a id="reasoning-pill-05"></a>

## reasoning-pill-05

旧ケース: `tests/e2e/reasoning-pill.spec.ts` — renders reasoning as plain text, so markup in it cannot become live

- 前提: 無害なテスト文字列を思考へ返すfixture。
- 操作: 「<script>alert(1)</script> を含む依頼で思考を確認」を送りpanelを開く。
- 合格条件: 文字はplain textとして扱われ実行されない。panel内部はP/DIV/SPANのみでscriptノード0。
- 証拠・制約: 画面に加えDOM/境界検査が必要。alertが出なかっただけでPASSにしない。

<a id="reasoning-pill-06"></a>

## reasoning-pill-06

旧ケース: `tests/e2e/reasoning-pill.spec.ts` — keeps every state legible and stops repeated motion when reduced motion is requested

- 前提: OSの動きを減らす設定を有効化。
- 操作: 依頼を送り実行中から完了まで観測。
- 合格条件: 思考中/段階が読める。title animation-name=none、文字fillが透明でない。完了ヘッダ<56px。
- 証拠・制約: 画面、computed style/寸法測定。

<a id="reasoning-pill-07"></a>

## reasoning-pill-07

旧ケース: `tests/e2e/reasoning-pill.spec.ts` — fits the active status header inside the Team Leader node without clipping

- 前提: Team CanvasのLeader。
- 操作: 長い日本語依頼を送り実行中ヘッダを確認。
- 合格条件: ノード用ヘッダのintrinsic height≤40px、左右がLeader内、scrollWidth=clientWidthで切れなし。
- 証拠・制約: ノード画面と寸法測定。

<a id="surface-footer-01"></a>

## surface-footer-01

旧ケース: `tests/e2e/surface-footer.spec.ts` — stays hidden during ordinary idle and running states

- 前提: Mock新規Task。
- 操作: idle→送信中→完了を観測。
- 合格条件: 通常の3状態で接続フッタを出さない。
- 証拠・制約: 3状態の画面。

<a id="surface-footer-02"></a>

## surface-footer-02

旧ケース: `tests/e2e/surface-footer.spec.ts` — reports Runs that were interrupted by a crash, and the notice can be dismissed

- 前提: 実行中断を再現できる隔離profile。
- 操作: 実行中にアプリを終了し同profileで再起動、復旧通知を閉じる。
- 合格条件: 「中断として確定」「1件」を表示。dismissで通知と空フッタが両方消える。
- 証拠・制約: 再起動通知とdismiss後画面。

<a id="surface-footer-03"></a>

## surface-footer-03

旧ケース: `tests/e2e/surface-footer.spec.ts` — stays hidden on the Canvas Leader node while the Runtime is healthy

- 前提: Runtime正常、Team Canvas。
- 操作: Leaderを表示。
- 合格条件: 健康なRuntimeではLeaderにフッタがない。
- 証拠・制約: Canvas画面。

<a id="timeline-scroll-follow-01"></a>

## timeline-scroll-follow-01

旧ケース: `tests/e2e/timeline-scroll-follow.spec.ts` — scrolling up mid-stream holds position, and 最新へ resumes following

- 前提: 履歴が縦に200px以上overflowし、新しい長文をstreamするMock。
- 操作: 初回完了後に次の長文を送り、stream中に最上部へスクロール。4回位置を観測後「最新へ」を押す。
- 合格条件: 初期最新へなし。上へ移動後scrollTop=0を4回維持、増加本文に連れ移動しない。末尾との距離が増える。「最新へ」でボタンが消え、stream中/完了後とも末尾距離≤40px。
- 証拠・制約: 4サンプルの位置/時刻、末尾距離、画面。
