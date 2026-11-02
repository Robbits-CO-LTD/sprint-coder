# ADR: Computer Use Windows — UIA による背景入力と対象の再検証

- Status: Draft（オーナー承認の前。N9 の実装・公開を承認したものではない）
- Date: 2026-11-02
- Issue: #994（Refs #988, #500）
- 関連: `tasks/designs/adr-computer-use-agent-driven-v2.md`（以下、V2 ADR）T5、§3.6、§5 の user takeover、§6.1 D14、`frontmost` を返さない契約
- 関連: `tasks/designs/adr-computer-use-windows-approval-path-20261102.md`（以下、承認経路 ADR）§2.2、§2.3、§2.7、§2.8。main にある設計であり、N8 の実装済みを意味しない
- 接点: kill-stop ADR（PR #990、審査中）。本 checkout にないため、依頼文の「親が確認済みの所見」を接点の前提とする。未確定の wire 名・台帳 schema は本 ADR で決めない
- 現状の照合基準: `3c9318750e76db23ef6c5ab1d40ad957b0a8e236`。以下の `native/` は `apps/desktop/computer-use-native/`、`main/` は `apps/desktop/src/main/` の略記である。行番号はこの版を指す

## 1. 問題と範囲

#988 D-6 は背景操作を計画に含め、前面確認の不変条件を N9a で置き換えることを決定した。AC-6 は「UIA で直接押せる操作は、対象を前面に出さず、ユーザーのカーソルも動かさずに行う」である。本 ADR はその設計案であり、設計の採否は別途オーナーが判断する。

現行の Windows は UIA pattern を使う入力でも前面を要求する。前面確認だけを削除すると、観測・ダイアログ選択・承認後の復帰が前面に依存したままになり、別の要素への入力や承認の使い回しを招く。本 ADR は入力経路を分け、対象に束縛した UIA 呼出しと、前面を必要とする SendInput の両方を定義する。

成果は、N9 が入力範囲、再検証、takeover、切替、Stop・承認との接点を実装できる設計である。変更は本ファイルだけである。承認経路そのもの（N8）、Stop の土台、ブラウザ・Explorer の有効化（N11）、macOS は対象外である。T5 の目的、deny class、危険面、セキュア欄、§3.6 の実行トリガ拒否は緩めない。

正しさは、現コードとの対応表、状態遷移ごとの拒否条件、N9 の境界テストと Windows 実機受入の定義によって確認する。この文書作成を実機 PASS と扱わない。

## 2. 決定（案）

### 2.1 前面を要求しない入力の範囲

**現状**: `native/computer_use_windows_host.cc:9408` の semantic worker は Invoke、Value、SelectionItem、Toggle、ExpandCollapse を処理する（各呼出しは `:9445`、`:9470`、`:9499`、`:9528`、`:9556`）。`:10454` はこれらを dispatch するが、`:10459` の後検証も前面を要求する。scroll は `:10327` の座標入力であり、`:10363` でカーソルを動かし、`:10391` / `:10403` で wheel を送る。ScrollPattern の背景入力はこの分岐にはない。開始と再開にも `:5652` / `:6140` の `SetForegroundWindow` がある。

**決めること・推奨案**: native が測定した能力と対象束縛から、各入力を `background_semantic` または `foreground_input` に固定する。名称は N9 の新しい内部契約である。モデルから経路を指定して検査を省くことはできない。背景経路は次表の pattern だけを使い、SetForegroundWindow、ShowWindow による復元、SetFocus、SetCursorPos、SendInput、clipboard paste を一切呼ばない。

| 操作・pattern | 背景で行う条件と効果確認 | 前面経路・制限 |
| --- | --- | --- |
| Invoke | 一意の対象に InvokePattern があり、効果分類・承認が成立する。呼出し後に事前に定めた UI 状態の変化を再観測する | HRESULT の成功だけで業務上の完了にしない。効果を定義・確認できない入力は未確認として停止する |
| Toggle | 現在値と希望値を読み、異なる場合だけ Toggle を一度呼ぶ。希望値への変化を読む | Indeterminate、読取り不能、複数回 Toggle が必要な操作は背景実行しない。同値なら入力なしの完了 |
| SelectionItem.Select | 観測した単一要素を Select し、その選択状態を確認する。選択集合・効果分類も束縛する | AddToSelection / RemoveFromSelection、複数選択への拡張は N9 に含めない |
| Value.SetValue | enabled、書込み可能、非 secure の ValuePattern に全文を一度渡し、希望値と一致することを内部で確認する | 本文をログに出さない。TextPattern を文字入力用の代替としない。Value 不在なら §2.4 の前面入力候補 |
| ExpandCollapse | 現在状態から Expand または Collapse を一度呼び、希望状態を読む | LeafNode、未確定状態は実行しない。同値なら入力なしの完了 |
| Scroll / SetScrollPercent | 一意に束縛した scroll container の ScrollPattern に対し、軸・量または到達率を固定する。scrollable、前後の percent / view size と対象範囲を読む | 座標 wheel の量を無条件で ScrollAmount に換算しない。要求と semantic の単位が一致しない場合は別の操作として再計画・承認する |
| ScrollItem.ScrollIntoView | N9 では背景入力として公開しない | 実現・表示・フォーカスへの副作用を今回確定しない。勝手に Realize / ScrollIntoView を挟まない |
| 座標 click / double_click、key、type、drag、座標 wheel | 背景経路には入れない | 前面・対象・focus・geometry の検査を維持する。現行 dispatch の未対応操作を本 ADR だけで追加しない。drag を実装する段でも前面のままとする |
| その他の pattern、任意の UIA メソッド | 許可しない | WindowPattern の移動・閉鎖等を背景操作の一般入口にしない |

背景対象は、存在し、可視で、最小化されておらず、geometry を取得できる束縛済みウィンドウに限る。他の窓による遮蔽は許す。最小化、別 desktop、secure desktop、読取り不能は拒否する。復元を背景操作に混ぜない。新しいダイアログへの自動追従も行わず、再観測または既存の takeover に移る。

UIA の API 自体に「provider がフォーカスやカーソルを変えない」という強制力はない。背景対応とは、上記の対象束縛に加え、その provider・control・pattern の組で非活性化が実機確認されていることを意味する。N9 は Windows 専用の版付き対応表を持ち、未知・更新後の未確認の組は背景能力なしとする。アプリ全体への grant とは別であり、未知を ordinary としない。provider が予期せず前面化・カーソル移動を起こしたら受入 FAIL とし、その組の背景経路を閉じる。元のフォーカスやカーソルを強制的に戻して成功扱いにしない。

**代案・理由**: pattern の存在だけで一律に背景対応とする案は、provider の副作用を AC-6 に反して見逃す。すべて SendInput にする案は AC-6 を満たさない。限定した pattern と実機確認済みの組から開く案を推奨する。

**N9 で作るもの**: 経路の能力宣言・版照合、対応表、pattern ごとの executor と効果確認、semantic scroll の対象・単位を表す閉じた契約を作る。既存の座標 scroll の意味を変更しない。start / resume / observe / preflight / approve / dispatch の全段に経路を通し、背景 start は対象を選択するだけで前面化しない。既に対象が前面なら §2.3 の人による引渡しを要求する。

### 2.2 前面確認に代わる再検証

**現状**: `native/computer_use_windows_host.cc:9798` は observation の存在、active window と前面の一致、cancel epoch、session identity、dialog 集合と active identity、geometry を検査する。`:9925` は要求の observation revision と epoch を照合し、`:9947` で V2 適格性を再判定する。`:7079` の session 検証が呼ぶ `:3578` の dialog 選択も前面に依存する。`:8246` の TargetWindowFacts も前面を要求する。要素の署名は `:8983` で PID、runtime id、control type、geometry、AutomationId を読み、`:9419` で観測時の署名と照合する。探索は `:9330` の束縛 window を根とし、同名の重複を拒否する。

**決めること・推奨案**: 前面入力の検証は維持し、背景入力にだけ次の対象束縛を追加する。共通関数から foreground の一行を消す方法は採らない。

1. Main が session / Task / Turn、grant、policy、送信同意、mode、helper generation、対象隔離を検査する。native は生存するプロセスの PID + 作成時刻、保持した実行中 image identity、署名・package・ruleset、HWND の所有と window identity を照合する。PID、HWND の数値だけを identity としない。
2. 背景の active window は観測で明示的に束縛した window であり、GetForegroundWindow から選び直さない。window の存在、可視性、非最小化、enabled、client geometry / DPI、dialog 集合と owner 関係を再検証する。新規 modal、OS prompt、secure surface、対象の無効化は拒否する。別アプリの通常の前面変更だけは target change としない。
3. 要素は束縛 window の UIA root から再解決する。runtime id、PID、control type、AutomationId、矩形、bounded ancestor chain の各所有 PID / runtime id と root への到達を照合する。runtime id 単独、名前だけ、別 window の ElementFromPoint、現在の focused element で代用しない。欠落・重複・上限超過・要素の交換は入力前拒否である。
4. observation revision、action / payload、経路、pattern、対象署名、祖先・面・origin、効果、geometry、cancel epoch、Stop serial、helper / ticket generation、§2.3 の interaction epoch を authority に束縛する。観測は背景 window 自体から得る。遮蔽した前面画面の pixel や別アプリの focus chain を分類に流用しない。画面が必要なのに対象由来と証明できなければ操作しない。再観測は旧 ticket を失効させる。
5. preflight、承認交換、dispatch の各段で同じ対象から deny class・secure・面・実行トリガを再評価する。背景であることは §3.6 の E1 / E4 拒否や N8 の単発承認を外す理由にならない。
6. pattern と必要状態を読み終えた後、呼出し直前に対象・祖先・geometry と epoch を再検証する。Stop / takeover が更新する取消し状態との同じ claim 境界で、一入力だけを発行する。claim 後に届く取消しを「未送信」に書き換えない。検証中に別の要素へ解決し直して入力しない。
7. 呼出し後も identity、window、geometry、祖先、世代・epoch、dialog 集合、効果を検証し、新しい観測を返す。事前に期待した状態変化だけを効果として認める。要素消失を伴う Invoke は、同じ対象 window 内の事前に定めた遷移先で確認する。判定できなければ `unknown_effect` とする。後検証失敗は巻戻しの証明ではない。

T5 の誤配防止は、OS の前面への配送を使わず、検証した要素の pattern object への呼出しに置き換えることで保つ。別アプリが前面になっても配送先はその窓へ変わらない。対象 provider 内部の動作や、検証直後の対象消失を原子的に止める保証はないため、後検証・再送禁止・対象隔離を併用する。SendInput にこの説明は適用できず、従来の前面・focused element 検証を保持する。

**代案・理由**: 名前だけの再探索、cached element の無検証再利用、foreground チェックだけの除去は、要素再生成・HWND 再利用・dialog の差替えを検知できない。すべての UI 更新を無条件拒否する案は Toggle 等の正常な効果も拒否するため、入力前の同一性と入力後の許された変化を分ける。

**N9 で作るもの**: 背景用 window / dialog 検証、対象 root からの観測・分類、祖先を含む署名、経路付き authority、最後の claim 検査、前後の効果検証を作る。普通の経路と承認経路の両方から同じ検証核を呼ぶ。N1 によるファイル分割後も上記シンボルを追跡する。

### 2.3 user takeover の新しい定義

**現状**: native の前面変化は `:3595` で focus_required または native_dialog_user_takeover になり、`:9803` でも入力を拒否する。`main/computer-use-controller.ts:4516` の userTakeover は paused を通知する。この関数自体は native の入力取消しを行っていない。V2 ADR §5 の paused は人だけが再開できる終端である。

**決めること・推奨案**: 背景操作では「対象について人が操作を引き取った、または人と競合する疑いがある」を takeover とする。

| 出来事 | 背景経路の扱い |
| --- | --- |
| ユーザーが無関係な通常アプリを前面にする・そこで入力する | 継続できる。前面アプリ名や入力本文を収集・公開しない |
| 対象 window またはその owned window が前面になる | 発生源を問わず即座に pause / cancel する。provider の副作用も含む。自動で裏へ戻さない |
| 前面にならない対象へユーザーが click / wheel / pointer 操作を始める | 対象矩形・hit target・capture owner に結び付く入力として takeover。非アクティブ窓への wheel も含む |
| 対象の focus / capture を伴うキー入力、移動・resize、操作元の判定不能 | takeover。対象要素の変更が検証に引っ掛かるまで待たない |
| 別アプリの通常入力でも、対象への所属を判定できない | 安全側に pause。全デスクトップの最終入力時刻だけを所属判定に使わない |
| secure desktop、session lock、監視の欠落・異常 | 新規 claim を閉じて pause。監視回復だけで自動再開しない |

native は背景 session の開始前から foreground 変化と mouse / keyboard / capture の対象所属を監視し、単調増加の interaction epoch と不明状態を保持する。WinEvent と低レベル入力 hook を組み合わせ、イベント callback は最小の metadata だけを記録する。入力本文・キー列・他アプリの名前を保存しない。自分の注入に付けた目印だけを根拠にユーザー入力を無視しない。観測から最後の claim まで epoch が同じことを検査し、監視の初期化失敗・イベント処理の遅延を検出したら閉じる。イベント取りこぼしを完全に証明できるとはしない。

対象が最初から前面にある場合も、background の自動開始は待機とする。人が対象を背景へ移し、明示的に引き渡してから新規観測を行う。前面操作としての明示的な引渡しは §2.4 の一操作に限る例外であり、以後のユーザー入力は同様に takeover である。

takeover は native の claim gate を閉じて cancel epoch / interaction epoch を更新し、Main が pending approval / execution ticket を失効させ paused を通知する。一入力がすでに claim 済みなら、その入力は取り消せない。結果未確認なら §2.5 の対象隔離も行う。再開は V2 ADR の人による再開条件を維持し、同じ Turn のモデルが続行を命令できない。

**代案・理由**: 別アプリへの移動も全停止する案は背景操作の利点を失う。対象が前面になってもキー入力まで待つ案は最初の入力との競合窓を広げる。前面化を保守的な引取り信号とする案を推奨する。ただし OS のイベント通知と UIA の provider 呼出しは原子的ではなく、同時操作が一切起きない保証はしない。発行済みの一操作の残余リスクは §2.5 で表示・隔離する。

**N9 で作るもの**: 入力所属の監視、interaction epoch、native の即時 gate 閉鎖と Main の paused への接続、再開時の新規観測、監視不能の fail-closed を作る。`frontmost` は V2 ADR の理由（攻撃者が誘導できる選択圧）からモデルへ返さない。経路と pause 理由の必要最小限だけを返し、前面アプリの一覧を追加しない。

### 2.4 背景から前面入力への切替

**現状**: `native/computer_use_windows_host.cc:9448` などは pattern 不在を semantic_pattern_unavailable とする。`:9564` は accepted 後の失敗を input_not_confirmed 等に区別する。`:10252` の click は `:10289` でカーソルを動かす。`:9820` は前面を再検証して SendInput を呼ぶ。開始・再開の前面化は §2.1 のとおりで、現行 semantic 分岐には失敗後の自動 SendInput fallback はない。

**決めること・推奨案**: UIA を先に検討する。ただし、入力を一度も発行していないと確認でき、pattern または背景対応能力がない場合だけ前面経路の候補にする。

| UIA の結果 | 次の状態 |
| --- | --- |
| pattern が存在しない、対応表の能力がない。入力前であると確認済み | `awaiting_foreground_handoff`（新規内部状態）へ。入力しない |
| 対象不一致、分類拒否、承認不能、監視不能、Stop、読取り timeout | 拒否 / pause。前面化で安全検査を回避しない |
| pattern を呼んで失敗、応答消失、効果が読めない、後検証失敗 | `unknown_effect`。自動再送・別 pattern・SendInput fallback を禁止し §2.5 へ |
| 希望状態だった、または効果を確認した | 入力なしの完了または確認済み完了。fallback しない |

前面切替は人がカードの「対象を前面にして今回の操作へ進む」を明示操作した場合だけ行う。対象、操作、カーソルが動く可能性、別アプリの入力が中断することを表示する。カード出現自体は showInactive / flashFrame 相当と polite 通知で、承認ボタンに既定 focus を置かない。D14 の非自動フォーカスを維持する。人の明示的な引渡し後の対象前面化だけが、今回の操作のために許された focus 変更である。

引渡し許可は session / Task / Turn、helper generation、対象 identity、元の action と経路変更の intent に束縛した一度限りのものとし、最大 60 秒で失効する。これは操作の危険度の承認を代替しない。消費前に Stop と identity を検査し、前面化が拒否されたら入力しない。前面化の成功を測定し、再観測・再分類を行ってから N8 の必要な承認と新しい execution ticket を得る。古い背景用 ticket は使わない。前面化後に別アプリへ focus が移ったら再前面化せず pause する。execution ticket 発行後には refocus / observe を挟まない。

対象を前面に出すこと自体も取消しと競合する control intent として記録する。引渡し中の Stop は未消費の許可を失効させる。すでに前面化を発行した場合の結果は記録するが、ユーザーの focus を復元する追加操作はしない。一操作の完了後は前面入力の権限を消費し、連続操作を暗黙に許可しない。背景へ戻る場合も人の引渡しと新規観測が必要である。

**代案・理由**: 失敗ごとに自動で前面化する案は D14 の目的に反し、遅延 UIA と二重実行になる。fallback を全廃する案は #988 N9 の方針を満たさない。入力前の能力不足だけを、人の引渡し付きで切り替える案を推奨する。

**N9 で作るもの**: 入力前拒否と発行後不明の型、引渡し intent / UI / 消費、経路変更時の ticket 破棄・再観測・再承認、前面経路への明示遷移を作る。semantic と物理入力が同じ効果であると測定できない場合は、元要求の fallback ではなく新規の操作要求として扱う。

### 2.5 取り消せない UIA 呼出しと Stop の接点

**現状**: `native/computer_use_windows_host.cc:8644` の InvokeWindowsSemanticInput が semantic 入力を扱い、`:9683` は ever_claimed / input_in_flight から未確認を区別する。`:10220` は semantic 入力が in-flight の間、新しい dispatch を拒否する。親が確認した kill-stop §2.1 の前提では、provider 側の UIA 呼出しと proxy の送信済み message は client 終了で取り消せず、SendInput も入力ストリームへの投入にすぎない。

**決めること・推奨案**: 背景操作も kill-stop の control 要求として同じ所有・台帳に登録する。新しい「背景専用 Stop」は作らない。

- Main は helper へ control を送る前に、対象 PID + 作成時刻、helper generation、session / request、経路、未確認状態を停止側の台帳に結び付ける。記録失敗時は入力を発行しない。本文・値・生の UIA tree を台帳に保存しない。
- 未応答、呼出し後の失敗、効果未確認、takeover と claim の競合は、その対象を隔離する。helper の終了確認は「helper から新しい入力が出ない」の証拠であり、「対象が最後の操作を実行しない」の証拠ではない。
- 隔離は PID + 作成時刻の対象プロセスに掛け、同じプロセスの別窓・別 session・前面入力からも迂回できない。SQLite 台帳で再起動をまたいで保持する。遅い成功 receipt だけで、旧 ticket や旧世代の session を復活させない。
- helper 世代の失効では、背景 observation、要素参照、引渡し許可、承認 intent、execution ticket を一括失効させる。再接続後は対象隔離を検査し、新規観測から始める。旧要求を新 helper へ再送しない。
- 対象の終了確認または停止側が定める人の明示再開でのみ隔離を解く。人の再開でも、遅延呼出しを消せた保証はない。「最後の操作が後から反映される可能性がある」を示す。単に画面が変わっていない、待ち時間が過ぎたことを解除根拠にしない。
- provider が固まったときの期限・helper 終了・台帳の recovery は kill-stop の責務である。N9 は timeout を成功に変換せず、未確認の対象と要求を渡す。停止側の確定契約が揃うまで背景入力を公開しない。

**代案・理由**: helper を kill したら再送可能とする案、UIA の HRESULT だけで隔離を解除する案は、遅れて実行される provider 呼出しを見落とす。対象アプリを強制終了する案も、未保存のユーザー作業を失うため採らない。

**N9 で作るもの**: 背景 control と前面引渡しの所有記録、停止側への未確認結果の接続、世代失効、再送禁止、残余リスクの表示を作る。台帳 schema・終了方式を再設計しない。PR #990 の確定内容が本接点と異なる場合は、公開前に設計の整合を取り直す。

### 2.6 承認経路との関係

**現状**: `main/computer-use-controller.ts:5213` は approvalApprove に action / observationRevision / cancelEpoch / approvalGeneration を渡し、`:5244` で dispatchApproved を呼ぶ。`:5254` は呼出し後の例外を unknown_effect とし ticket を使い直さない。これは共有 controller の現状であり、Windows N8 の完成を示すものではない。承認経路 ADR §2.2 は execution ticket の束縛、§2.3 は supervised、§2.8 は非自動フォーカスを定める。

**決めること・推奨案**: 背景操作にも同じ mode / grant / classifier / 操作ごとの承認を要求する。supervised の選択・スクロール等の粒度、plan 対象外の二枚カード、E2 / E3 の単発性、E1 / E4 の無条件拒否は N8 の契約を引き継ぐ。背景という理由で確認を省略しない。

N8 の authority に入力経路・pattern・対象祖先・interaction epoch を追加し、ordinary ticket と execution ticket の両方で照合する。カードが承認するのは表示した対象・操作・経路だけである。背景のカードには「対象を前面にせず操作する」を示し、前面引渡しカードとは区別する。表示値は native の検証済み経路に由来し、モデルの申告で上書きしない。

承認カードの表示・ユーザーによる Sprint Coder への移動は対象の takeover ではない。背景承認後は対象を refocus せずに再観測する。N8 の「同じ対象へ復帰」の Windows 背景経路だけを、同じ identity の背景観測へ置き換える。承認待ちに対象が前面化・変更されたらカードを失効させる。exchange 後に observe / refocus を挟まない制約、期限、trusted activation、Stop と世代失効は維持する。

**代案・理由**: 背景操作を安全とみなして自動承認する案は、Invoke 等が同じ危険な効果を持つことを無視する。承認のたびに対象を前面に戻す案は AC-6 を満たさない。承認の意味を保ち、復帰経路だけ分ける。

**N9 で作るもの**: N8 の契約を拡張する schema / native / Main / 表示の一体変更、背景再観測、route 変更の拒否試験を作る。承認の仕組みやカード数を独自に作り直さない。N8 の実装完了と本 ADR の承認が N9 の前提である。

### 2.7 試験と実機の受入

**現状**: `main/computer-use-windows-input-seam.test.ts:29` は入力 API attempt と guard refusal を区別する試験、`main/computer-use-windows-ticket-seam.test.ts:873` は ticket の発行・束縛・消費・失効の試験である。これらは背景操作の実機受入ではない。UI 検証の正本は `docs/testing/computer-use/README.md` であり、実操作は開発エージェントの Computer Use で行う。

**決めること・推奨案**: 単体・native 境界試験で不正入力が発行されないことを確認し、Windows 実機では foreground と cursor を操作区間全体で受動計測する。開始と終了の screenshot が同じだけでは、一瞬の前面化・移動を見逃すため PASS にしない。

| ケース | 操作と合格条件 |
| --- | --- |
| BG-1 pattern ごとの背景正例 | 合成 fixture の対象窓を非最小化で別アプリの背後に置く。§2.1 の各 pattern の入力・承認を実 UI から開始する。対象効果が一度だけ確認され、区間内で対象が前面にならず、製品から focus / cursor / SendInput API が呼ばれず、ユーザーが動かさない区間の cursor 座標が不変である |
| BG-2 別アプリでの作業 | 別アプリで合成の文を入力しながら背景操作する。文字がそのアプリだけへ届き、カード出現が keyboard focus を変えない。ユーザーによる cursor 移動は別の区間として記録し、背景操作による移動と混同しない |
| BG-3 takeover | 対象の前面化、非アクティブ wheel、click、resize、capture、キー入力を各々行う。次の claim が拒否され、人の再開まで停止する。claim 前・直後・provider 内停止中を別々に試験し、発行済みは未確認として隔離される |
| BG-4 対象差替え | PID / HWND 再利用、runtime id / ancestor 変更、同名重複、geometry / DPI 変化、dialog 発生、最小化、secure desktop、監視失敗を境界 fixture で作る。入力前の失敗は API attempt が 0、発行後は未確認となり fallback しない |
| BG-5 fallback | pattern 不在ではカードが出ても focus は動かない。明示引渡し後だけ前面化し、新しい観測・必要な承認・ticket で一操作する。拒否、期限、Stop、前面化失敗、直後の別アプリへの移動で入力が出ない |
| BG-6 遅延と再起動 | provider を呼出し前・呼出し中・呼出し後の確認前で停止させる。Stop、helper 終了、Main 再起動を行い対象隔離と世代失効を検証する。provider を後で解放し、遅延効果が起こり得ることと二重入力がないことを確認する |
| BG-7 承認 UI | 背景 / 前面の経路表示、supervised の操作ごとの確認、二枚カード、trusted activation、期限・拒否・Stop、Tab / click、キー継続、light / dark、loading / error / disabled を確認する。別アプリ入力中の出現では承認も focus 移動も起こらない |
| BG-8 回帰と非対応 | 前面 SendInput の focus 喪失拒否、危険面・E1 / E4 拒否、旧 helper / 未知能力の gate 閉鎖、macOS の既存承認契約を境界試験で維持する。未確認 provider が背景能力ありと表示されない |

計測はテスト用の受動 observer による foreground WinEvent、cursor 位置のイベント記録と補助 sampling、製品の API attempt カウンタ、fixture の入力回数・効果を相関させる。観測器は入力を生成しない。event 欠落や計測不足があれば BLOCKED とし、sampling だけで一瞬の移動がなかったと断定しない。最小 metadata と合成 fixture の結果だけを証拠に残す。provider の非活性化特性は OS・アプリ / provider 版・control・pattern ごとに記録し、対応表へ反映する。

実機記録は build / SHA、Windows 版、DPI・monitor 構成、fixture / provider 版、操作、期待値、実測値、動画・計測 artifact、各ケースの PASS / FAIL / SKIP / BLOCKED を含める。UI 操作を内部 IPC・DOM・shell スクリプトで代替しない。native fixture や受動計測は補助証拠である。実 Provider 課金は本受入に不要である。

**代案・理由**: screenshot の前後比較だけ、CI の成功だけ、helper のログだけでは AC-6 のユーザー操作を証明できない。実操作と連続する受動証拠を組み合わせる。

**N9 で作るもの**: 上記 fixture / observer、直接関連の Vitest と Windows native seam、既存 Computer Use チェックリストへのケース追加、対応表の実機証拠を作る。実装時は回帰テストの RED → GREEN を記録する。本 ADR では作成も実行もしていない。

## 3. N9 の実装スライス

全スライスは本 ADR のオーナー承認と N8 の後である。停止側の台帳・世代契約に依存する。分割後のコード位置と正式な wire 名は実装時に照合する。新規能力の gate は最後のスライスまで本番で閉じる。各 PR は対象 typecheck と直接関連テストを通し、後続 PR の存在を合格条件にしない。

| # | PR の単位・成果 | 順序 | 試験 |
| --- | --- | --- | --- |
| N9-1 | 経路・pattern・対応能力版の閉じた契約、authority 拡張、native / TS / schema / fixture の一体変更。旧 helper を閉じる | 最初 | 経路差替え、未知欄・版、replay、旧 ticket / 世代、ordinary と承認の取り違え。macOS 契約の維持 |
| N9-2 | 背景 start / resume / observe、window / dialog / root / ancestor 検証、入力所属監視と interaction epoch。入力能力は未公開 | N9-1 | 前面化 API 0、BG-3 / BG-4 の入力前拒否、対象由来の観測と classifier、監視異常、cancel と claim の競合 |
| N9-3 | §2.1 の semantic executor と scroll、効果確認、Stop 台帳への接続、未知効果・世代失効。試験用 gate のみ | N9-2、停止側の確定契約 | pattern 全件の正負例、同値 no-op、最後の検証後の変更、呼出し失敗・遅延・Main 再起動、BG-6、二重発行 0 |
| N9-4 | N8 の背景再観測・ticket 交換・dispatch 接続、前面引渡し intent と UI、一操作ごとの切替 | N9-3 | BG-5 / BG-7、カード中の takeover、期限・Stop・旧世代、経路変更による失効、発行後 fallback 0 |
| N9-5 | 実機対応表の確定、受動 observer とチェックリストの受入、能力 gate の接続 | N9-4 | BG-1〜BG-8 の境界試験と Windows Computer Use。前面・cursor 不変の artifact、未対応の fail-closed。根拠が揃った組だけを公開候補とする |

N9-5 の合格をブラウザ・Explorer の有効化や release の許可と解釈しない。実機の証拠不足は BLOCKED として残し、gate を閉じた状態で引き渡す。

## 4. オーナーに判断してもらうこと

D-6 の計画への採用、AC-6、UIA 優先、N8 の後という順序は既決事項である。次の各項目は一つずつ判断する。

1. §2.1 の pattern ごとの背景入力範囲を採用するか。
2. 背景対応を実機確認済みの provider・control・pattern の組に限り、版付き対応表で開く方針を採用するか。
3. §2.2 の対象・祖先・経路・世代への束縛を、背景経路の前面確認の代わりとするか。
4. §2.3 の、対象が前面になるだけで takeover とする保守的な定義を採用するか。
5. 別アプリでの通常入力は継続し、所属不明なら停止する入力監視方針を採用するか。
6. §2.4 の、入力前の能力不足に限る明示的な前面引渡しを採用するか。
7. §2.5 の残余リスク（発行済み UIA が人の takeover / Stop 後に対象で実行され得る）を、対象隔離と表示を前提に受け入れるか。
8. §2.6 の、背景承認後の refocus を同じ対象への背景再観測に置き換える案を採用するか。
9. §2.7 の実機受入と連続する受動証拠を公開の条件とするか。
10. §3 の PR 分割を採用するか。

### 4.1 承認後の既存 ADR への反映

今回は既存 ADR を変更しない。承認後の別変更で、V2 ADR の T5・冒頭の入力前後再検証を経路別にし、user takeover の定義へ §2.3 を接続する。§3.6 の拒否と D14 の非自動フォーカス、`frontmost` 非公開は維持する。承認経路 ADR §2.2 の focus 再検証・対象への復帰だけを背景経路では §2.2 / §2.6 に置き換え、§2.7 の停止・世代と §2.8 の表示へ接点を追記する。kill-stop 側には背景 control の未確認対象が同じ台帳に入ることを相互参照する。設計承認、実装、実機受入、公開の状態を混同しない。

## 5. 現コードとの対応と未確認事項

| 項目 | 本 ADR の記述 | 現コードの根拠 |
| --- | --- | --- |
| semantic 入力 | §2.1 の五つの既存 pattern | `native/computer_use_windows_host.cc:9408`、`:9445`、`:9470`、`:9499`、`:9528`、`:9556` |
| scroll | §2.1 の現行 scroll は座標 wheel | 同 `:10327`、`:10363`、`:10391`、`:10403` |
| start / resume | §2.1 の前面化 | 同 `:5652`、`:6140` |
| foreground の依存 | §2.2 の session / dialog / target 検証 | 同 `:3578`、`:7079`、`:8246`、`:9798` |
| 要素束縛 | §2.2 の runtime id 等の署名、探索と照合 | 同 `:8983`、`:9330`、`:9419` |
| revision と再分類 | §2.2 の入力前検証 | 同 `:9925`、`:9947` |
| takeover | §2.3 の controller は paused を通知 | `main/computer-use-controller.ts:4516` |
| 入力と不明結果 | §2.4 / §2.5 の accepted と in-flight | `native/computer_use_windows_host.cc:9564`、`:9683`、`:10220` |
| SendInput | §2.4 の前面を必要とする経路 | 同 `:9820`、`:10289` |
| 承認 | §2.6 の交換・dispatch・例外時の未確認 | `main/computer-use-controller.ts:5213`、`:5244`、`:5254` |
| 試験 | §2.7 の既存境界試験 | `main/computer-use-windows-input-seam.test.ts:29`、`main/computer-use-windows-ticket-seam.test.ts:873` |

本 Draft のコードについての記述は上記 base の読取りで確認した。背景操作の実装、native build、実機試験は行っていない。provider の副作用、入力監視の遅延・欠落、kill-stop の正式契約との整合は N9 の公開前に確認する。OS の event と provider 呼出しの間に原子性はなく、悪意ある provider の内部動作を UIA から制限できるとは主張しない。

独立した敵対的レビュー、PR、Review BOT、要塞レビュー、オーナーの設計承認は親の工程である。
