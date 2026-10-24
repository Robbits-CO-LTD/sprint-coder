# 設定・Project・ウィンドウ

共通手順は[README](README.md)。明記がないケースはmacOS／Windows／Linuxで共通。全測定値は補助計測が必要であり目視だけではPASSにしない。

<a id="setup-wizard-01"></a>

## setup-wizard-01

旧ケース: `tests/e2e/setup-wizard.spec.ts` — first launch moves through setup once and lands in a usable Task

- 前提: 未使用の隔離profile。
- 操作: 初回起動→「セットアップを始める」→AI確認→続ける→作業場所「あとで設定」→「最初のTaskを始める」。同profileで再起動。
- 合格条件: 歓迎見出しとSVG、Codex/Claude Code確認、作業場所、準備完了が順に表示。wizard中sidebarなし。最初のTaskでsidebarとComposerが使え、reveal演出は終了する。再起動時wizardは出ない。
- 証拠・制約: 歓迎/準備完了/通常画面、再起動画面。

<a id="settings-dialog-01"></a>

## settings-dialog-01

旧ケース: `tests/e2e/settings-dialog.spec.ts` — opens from the sidebar, closes by Escape and by the close button, and returns focus

- 前提: 新規Task。
- 操作: sidebarの設定を開きEscape、再度開き閉じるボタン。
- 合格条件: 両経路でdialogが閉じ、設定ボタンへフォーカスが戻る。
- 証拠・制約: 開閉とfocusの画面。

<a id="settings-dialog-02"></a>

## settings-dialog-02

旧ケース: `tests/e2e/settings-dialog.spec.ts` — traps focus inside the dialog while it is open

- 前提: 設定dialogが開いている。
- 操作: Tabを20回押す。最後にEscape。
- 合格条件: 各回のfocusがdialog内にあり背景に逃げない。Escapeで閉じる。
- 証拠・制約: 20回のfocus記録。

<a id="settings-dialog-03"></a>

## settings-dialog-03

旧ケース: `tests/e2e/settings-dialog.spec.ts` — keeps Runtime selection in the Composer instead of duplicating it in Settings

- 前提: 旧Picker（SPRINT_CODER_MULTI_PROVIDER_MODEL_PICKER_V2=0）。
- 操作: 設定を開きモデル画面を確認して閉じる。
- 合格条件: 設定内にGeneral/Runtime重複選択なし。モデル/effortは表示され、RuntimeはComposerにある。
- 証拠・制約: 設定とComposer画面。

<a id="settings-dialog-04"></a>

## settings-dialog-04

旧ケース: `tests/e2e/settings-dialog.spec.ts` — surfaces CLI detection status, which was previously only a tooltip

- 前提: Codex/Claude CLIの検出完了。
- 操作: 設定の詳細を開く。
- 合格条件: 両CLIの検出済み/利用可能/見つかりません/未検出が行内で読める。「Codexユーザー設定」「ユーザーconfig・MCPをTurnへ引き継ぐ」の旧操作はない。
- 証拠・制約: CLI状態の画面。実際の実行可否とは区別。

<a id="settings-dialog-05"></a>

## settings-dialog-05

旧ケース: `tests/e2e/settings-dialog.spec.ts` — offers and persists full access as the default for a new Task

- 前提: 隔離profile。
- 操作: 新規TaskのAccess既定選択を開いてフルアクセスに設定、設定を閉じ再度開く。
- 合格条件: 選択肢は前回選択した設定・実行前に確認・安全時は自動・フルアクセス。保存値fullが再表示される。
- 証拠・制約: 選択一覧と再表示。実ファイル操作は行わない。

<a id="settings-dialog-06"></a>

## settings-dialog-06

旧ケース: `tests/e2e/settings-dialog.spec.ts` — previews and imports a detected Skill using the typed settings bridge

- 前提: 旧ケースは無効化済み。外部Skill importerを提供する旧製品のみ。
- 操作: 旧手順: e2e-writer候補を選択→内容確認→1件を読み込み→自動選択ON。
- 合格条件: 旧要件:1件検出、Portable/ファイル1件、読み込み済み、自動選択OFF→ON。現行製品は外部importを提供しない。
- 証拠・制約: SKIP（旧無効ケース）。現在のSkills仕様のPASSに混ぜない。

<a id="settings-dialog-07"></a>

## settings-dialog-07

旧ケース: `tests/e2e/settings-dialog.spec.ts` — routes a blocked Skill preview into the managed Portable conversion workflow

- 前提: 旧ケースは無効化済み。unknown-policy: trueを持つe2e-blocked Skill。
- 操作: 旧手順:再読込→候補→内容確認→AIでPortable版へ変換。
- 合格条件: 旧要件:未対応frontmatter説明、設定を閉じimport-skillを選択、ComposerへClaude Skill変換依頼。現行製品では入口廃止。
- 証拠・制約: SKIP（旧無効ケース）。製品を復活させる指示ではない。

<a id="settings-dialog-08"></a>

## settings-dialog-08

旧ケース: `tests/e2e/settings-dialog.spec.ts` — shows only Sprint Coder Skills and no external import controls

- 前提: 外部.claude/.agents/.codex配下にe2e-writerがある隔離Skill home。
- 操作: 設定のSkillsを開く。
- 合格条件: 内蔵SkillとSkill Creator作成Skillを管理する説明。外部e2e-writer、候補選択、import-skillは出ない。
- 証拠・制約: Skills一覧画面。

<a id="settings-dialog-09"></a>

## settings-dialog-09

旧ケース: `tests/e2e/settings-dialog.spec.ts` — progressively reveals the add form, keeps optional fields folded, and clears the draft on cancel

- 前提: 設定のモデルと接続。ダミーキーのみ。
- 操作: 追加フォームを開く。長い日本語名とdummy-keyを入れキー表示切替、詳細を展開、キャンセル、再度開く。Ollamaを選び名前だけ入力。幅600×760でも確認。
- 合格条件: 初期接続行≤64px、詳細は閉。狭幅で横overflowなし。追加は段階表示、OrcaRouter APIあり。API keyは初期password、表示時text/pressed、戻すとpassword。組織ID/Project IDは任意で詳細内。badgeはSPAN。cancelで名前とkeyを消去。Ollamaはkey任意、名前のみでsubmit有効。renderer/console errorなし。
- 証拠・制約: 標準/狭幅/展開/リセット画面、寸法・semantic検査とredactedログ。秘密キーを撮影しない。

<a id="settings-dialog-10"></a>

## settings-dialog-10

旧ケース: `tests/e2e/settings-dialog.spec.ts` — sets Team permission by Provider or by models inside an expanded Provider

- 前提: 2以上Provider、最初のProviderに2以上モデル。
- 操作: Team設定でProviderごと指定。codex検索→Enter→検索消去。全Provider不許可、1つ目を許可し展開してモデル1つだけ残す。2つ目を全許可。保存・閉じ・再表示。
- 合格条件: モデル画面とTeam画面が切替。Providerが縦並び、折畳み時model行なし。検索でモデルが見えEnterで保存可能、検索解除で折畳み復帰。全不許可で保存disabled。1つ目はmixed、2つ目全許可。保存後disabled、再表示でmixed/checkedと選択モデル1件を保持。
- 証拠・制約: 検索/混合選択/再表示画面、checkbox状態。

<a id="settings-skills-blueprint-01"></a>

## settings-skills-blueprint-01

旧ケース: `tests/e2e/settings-skills-blueprint.spec.ts` — navigates Team and Skills settings, then pins and restores skill-creator without sending

- 前提: 新規Task、内蔵Skills。
- 操作: 設定Team→Skillsを巡回。閉じて/skill-creatorから選択し送信せず再起動。chipを押して解除。
- 合格条件: Team既定depth4、concurrency50と調査設定あり。Skillsにskill-creator/sprint-coder-product、組込/常時有効が見える。選択でComposer空、chipあり、メッセージ0件。再起動後chip保持、解除で消える。
- 証拠・制約: 設定/選択/復元画面。

<a id="model-and-access-settings-01"></a>

## model-and-access-settings-01

旧ケース: `tests/e2e/model-and-access-settings.spec.ts` — selects and restores a Codex model and an Access preset

- 前提: 旧Picker、fixture catalog。
- 操作: Codex→GPT-5.6-Terra→安全時は自動を選んで再起動。
- 合格条件: Runtime/モデル/Accessの3選択がCodex／GPT-5.6-Terra／安全時は自動として復元。
- 証拠・制約: 選択と復元画面。固定名は旧fixture基準で実catalogの現在値ではない。

<a id="model-and-access-settings-02"></a>

## model-and-access-settings-02

旧ケース: `tests/e2e/model-and-access-settings.spec.ts` — shows clarified Claude model labels and persists a selected effort level

- 前提: 旧Picker、Claude fixture catalog。
- 操作: Claudeを選びモデル表示とAutoを確認。effortを中→高→Ultracodeと選び再起動、キーで最大選択・Escape、Mockへ切替。
- 合格条件: Sonnet 5、Opus 5＋claude-opus-5、Haiku 4.5、Auto＋claude-sonnet-5をfixtureで表示。Ultracodeはradio semanticsで再起動保持。最大選択/閉じるがキーで可能。Mockでeffortはdisabled。
- 証拠・制約: モデル名/effort/復元とfocus証拠。live catalogとfixtureの違いは別記。

<a id="model-and-access-settings-03"></a>

## model-and-access-settings-03

旧ケース: `tests/e2e/model-and-access-settings.spec.ts` — offers the selected model own levels, and nothing at all for Auto

- 前提: 旧Picker、Codex fixture catalogとそのモデル固有supported reasoning levels。
- 操作: Autoのeffort、具体モデルの選択肢を確認。最高level選択→再起動→Auto→具体モデル。
- 合格条件: Autoは「—」、disabled、Auto以外を選ぶ理由。具体モデルはlow/highを含む4以上のfixture levelsと空でないCLI説明を表示。最高選択を保持しAutoでoverrideを落とす。モデル復帰時に対応levelのみ使用、Claude設定を混ぜない。
- 証拠・制約: catalogとUI照合、再起動画面。実catalogではその実行CLIの提示levelsを基準とし固定列挙で推定しない。

<a id="local-ai-settings-ui-01"></a>

## local-ai-settings-ui-01

旧ケース: `tests/e2e/local-ai-settings-ui.spec.ts` — local model settings opens external Provider connections (${layout})

- 前提: 統合Picker有効。設定layout workspace/legacyそれぞれ。各layoutで幅1200/720/560×高さ900、light/darkを全組合せ（計12条件）。接続一覧を記録。
- 操作: Pickerをキーで開きLocalフィルター→「プロバイダー接続を追加」→追加フォーム。LocalAI/LM Studio/Ollamaを各選択、Tabで名前へ、Escapeで閉じる。
- 合格条件: Localフィルターpressed、旧Local AI Selectorなし。接続数不変、ロード完了、追加toggleがfocusかつ画面内。workspaceはmodels現在地、legacyはsidebarなし。local-ai nav/body/APIなし。3profile名正確、名前未入力でsubmit disabled、名前focusが画面内。横overflow≤1px、閉じるとPickerへfocus復帰、接続を勝手に作成しない。
- 証拠・制約: 12条件の画面、接続ID前後一致。旧localAI API非公開は境界確認が必要。

<a id="local-ai-speculative-settings-01"></a>

## local-ai-speculative-settings-01

旧ケース: `tests/e2e/local-ai-speculative-settings.spec.ts` — preserves retired local models and history while refusing execution without provider fallback

- 前提: 隔離profileに旧managed-local選択のTask/Turn、installed/installingモデル2件、artifact/job/verification/設定、既存会話、32byteの001.ggufとpartialを準備。migration75/76/77/83を保持。
- 操作: 起動後履歴とモデル一覧を確認し「廃止されたモデルへ送信しないでください」を送信。
- 合格条件: 旧会話をそのまま表示。旧selectionを保持するがavailable一覧に旧接続なし。localAI APIなし。「内蔵ローカルAI機能は廃止されました。モデルと接続から別のProviderを選択してください。」のalert。activeTurnなし/queue空、新メッセージなし、fallbackしない。旧DB全レコードと両ファイルbytesが前後一致。
- 証拠・制約: 前後DB/ファイルhash、selection/turn状態、alert画面。legacy DB fixture未準備ならBLOCKED。

<a id="project-sidebar-01"></a>

## project-sidebar-01

旧ケース: `tests/e2e/project-sidebar.spec.ts` — creates, moves, archives and restores Projects with keyboard-friendly controls

- 前提: 隔離root test1/test2、Projectなしの新規Task。
- 操作: Alphaを2フォルダで作り2つ目primary指定。AlphaでTask作成、Beta作成。Project検索でtest2、Betaをキー選択してEscape、移動、未所属化、再移動。送信後Alphaへ移動→/new。Alpha archive/restore、検索、再起動後編集を開く。
- 合格条件: 作成後Pickerへfocus、新規未開始Taskへfocus。パス検索でAlpha、EscapeでPicker復帰。Taskの移動と未所属を反映。Alphaは既存2件→/new後3件。archiveでArchived Projects展開、archive/restore後見出しfocus。Beta検索でも選択中Alphaを失わない。再起動後2rootと2つ目primary保持。
- 証拠・制約: 各操作の画面とroot設定。OS pickerをCUで操作しdialogを差替えない。

<a id="sidebar-collapse-01"></a>

## sidebar-collapse-01

旧ケース: `tests/e2e/sidebar-collapse.spec.ts` — collapsing gives the conversation column the sidebar width back, and the state persists

- 前提: 広いwindow、展開sidebar幅>200px。
- 操作: 折畳み→同profile再起動→展開。
- 合格条件: 折畳み幅0、本文幅が200px超広がる。状態が再起動保持され、展開で幅>200pxへ戻る。
- 証拠・制約: 前後寸法と再起動画面。

<a id="sidebar-collapse-02"></a>

## sidebar-collapse-02

旧ケース: `tests/e2e/sidebar-collapse.spec.ts` — dragging the edge resizes the sidebar, the width persists, and double-click resets it

- 前提: 1440×900。
- 操作: 端を右60pxドラッグ、さらに2000px相当へ広げ、再起動して同size。resizerを左キー操作後ダブルクリック。
- 合格条件: 60px操作で幅>50px増、aria-valuenow/CSS幅が実幅の丸めと一致。上限480px、本文≥520px。再起動差≤1px。左キーで縮み、double-clickで264pxへリセット。
- 証拠・制約: 寸法/aria/CSS測定、各操作画面。

<a id="sidebar-collapse-03"></a>

## sidebar-collapse-03

旧ケース: `tests/e2e/sidebar-collapse.spec.ts` — the keyboard shortcut toggles the sidebar

- 前提: 1440×900、sidebar展開。
- 操作: macOSはCmd+B、Windows/LinuxはCtrl+Bで閉→開。設定dialog内でも同shortcut。
- 合格条件: 閉で幅0/resizerなし、開で幅>200px。aria-keyshortcutsが実shortcutに一致。設定内では背景sidebarを切り替えない。
- 証拠・制約: キー操作・focus・寸法。

<a id="sidebar-collapse-04"></a>

## sidebar-collapse-04

旧ケース: `tests/e2e/sidebar-collapse.spec.ts` — at the minimum window size the sidebar starts collapsed and opens as an overlay

- 前提: window760×560。
- 操作: 自動折畳みを確認→toggle→背景scrim。
- 合格条件: 本文幅はviewport−4px超のまま。sidebarはoverlayで幅>100px、本文を押し縮めない。scrimで閉じscrimも消える。
- 証拠・制約: 狭幅画面と寸法。

<a id="sidebar-collapse-05"></a>

## sidebar-collapse-05

旧ケース: `tests/e2e/sidebar-collapse.spec.ts` — 150% zoom keeps the conversation usable and free of horizontal scroll

- 前提: 150% zoom。
- 操作: Composerへ日本語を入れて送信。
- 合格条件: 横overflow≤2px、Composerが使えMockが30秒以内に完了。
- 証拠・制約: zoom値、寸法、完了画面。

<a id="macos-window-lifecycle-01"></a>

## macos-window-lifecycle-01

旧ケース: `tests/e2e/macos-window-lifecycle.spec.ts` — close hides the window and a second launch restores it without losing the Task

- 前提: 対象OS:macOSのみ。同一profileでMock会話完了。
- 操作: 赤い閉じるでwindowを閉じ、同じアプリ/profileをもう一度起動。
- 合格条件: 最終windowを閉じてもappは生存。2つ目processは10秒以内にexit0、Object has been destroyedなし。元windowが再表示され両メッセージ保持。
- 証拠・制約: OS画面、process exitとログ、復元画面。Windows/Linuxは対象外SKIP。

<a id="window-titlebar-01"></a>

## window-titlebar-01

旧ケース: `tests/e2e/window-titlebar.spec.ts` — uses platform-owned traffic lights on macOS and product-owned controls on Windows

- 前提: OSごとに実行。
- 操作: titlebarを確認。Windowsは最大化→元に戻す→最小化→OSから復元→閉じる。macOSはネイティブtraffic lights。Linuxも外観を確認。
- 合格条件: macOS/WindowsはSprint Coder titlebar。macOSは製品独自window controlsなし、traffic lights座標14,13。Windowsはdrag領域とno-drag controls、最大化で「元に戻す」、復元で「最大化」、minimize/closeが実windowへ作用。Linuxはcustom titlebarなし。
- 証拠・制約: OSごとの画面、native状態とdrag-regionの補助検査。

<a id="hidden-window-01"></a>

## hidden-window-01

旧ケース: `tests/e2e/hidden-window.spec.ts` — hidden E2E accepts input and renders without showing or focusing its native window

- 前提: 旧基盤専用。非表示・非フォーカスwindowを旧ドライバーで操作していた。
- 操作: CUは可視windowのみ操作するため、非表示のままTask作成/送信を代替実行しない。
- 合格条件: 旧要件:visible=false/focused=falseを維持したまま送信完了、本文一致、画像>1000bytes、activate後も非表示/非focus。
- 証拠・制約: BLOCKED（CU可視操作と両立不可）。ネイティブ境界テストで証明する場合もCU合格とは別記。ケースの存在と旧基準は保持。
