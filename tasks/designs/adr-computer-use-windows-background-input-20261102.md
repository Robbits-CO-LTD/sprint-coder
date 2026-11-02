# ADR: Computer Use Windows — UIA による背景入力と対象の再検証

- Status: Draft（オーナー承認の前。N9 の実装・公開を承認したものではない）
- Date: 2026-11-02
- Issue: #994（Refs #988, #500）
- 関連: `tasks/designs/adr-computer-use-agent-driven-v2.md`（以下、V2 ADR）T5、§3.6、§5 の user takeover、§6.1 D14、§8 の不変条件、`frontmost` を返さない契約
- 関連: `tasks/designs/adr-computer-use-windows-approval-path-20261102.md`（以下、承認経路 ADR）§2.2、§2.3、§2.7、§2.8。main にある設計であり、N8 の実装済みを意味しない
- 関連: `tasks/designs/adr-computer-use-windows-kill-stop-20261102.md`（以下、kill-stop ADR）。origin/main（`0edfc6e1`）で Accepted（オーナー判断 D-1〜D-5 を反映）。本ファイルの照合基準（下記）には含まれないため、origin/main の版を読んで照合した。本 ADR の kill-stop の節番号は、すべて origin/main の版を指す。kill-stop の実装（N2〜N5）はまだ無い
- 現状の照合基準: `3c9318750e76db23ef6c5ab1d40ad957b0a8e236`。以下の `native/` は `apps/desktop/computer-use-native/`、`main/` は `apps/desktop/src/main/` の略記である。行番号はこの版を指す

## 1. 問題と範囲

#988 D-6 は背景操作を計画に含め、「focus が変わったら止める」という今の不変条件を N9a の設計で置き換えることを決定した。AC-6 は「UIA で直接押せる操作は、対象を前面に出さず、ユーザーのカーソルも動かさずに行う」である。#988 の N9 の方針は「UIA の pattern を先に使い、使えないときだけ前面に出して SendInput を使う」である。本 ADR はその設計案であり、設計の採否は別途オーナーが判断する。N9 の実装は承認の後である。

現行の Windows は UIA pattern を使う入力でも前面を要求する。前面確認だけを削除すると、観測・ダイアログ選択・承認後の復帰が前面に依存したままになり、別の要素への入力や承認の使い回しを招く。本 ADR は入力経路を三つに分け、対象に束縛した背景の UIA 呼出しと、前面を必要とする UIA 呼出し・SendInput を定義する。

成果は、N9 が入力範囲、再検証、takeover、切替、Stop・承認との接点を実装できる設計である。変更は本ファイルだけである。承認経路そのもの（N8）、Stop の土台（N2〜N5）、ブラウザ・Explorer の有効化（N11）、macOS は対象外である。ただし §2.5 は、背景経路のために kill-stop の契約へ追加が要ることを示し、その追加を N3 の範囲に入れることを求める。T5（別アプリへの入力の誤配を防ぐ）の目的、deny class、危険面、セキュア欄、§3.6 の実行トリガ拒否は緩めない。

正しさは、現コードとの対応表、状態遷移ごとの拒否条件、N9 の境界テストと Windows 実機受入の定義によって確認する。この文書作成を実機 PASS と扱わない。

## 2. 決定（案）

### 2.1 入力経路とセッションの形

**現状**: `native/computer_use_windows_host.cc:9408` の semantic worker は Invoke、Value、SelectionItem、Toggle、ExpandCollapse を処理する（各呼出しは `:9445`、`:9470`、`:9499`、`:9528`、`:9556`）。`:10454` はこれらを dispatch し、`:10459` の後検証（`RevalidateWindowsTarget`、`:9803` で前面を要求）を通れば completed とする。つまり今の semantic 入力は「前面での UIA pattern の呼出し」である。scroll は `:10327` の座標入力であり、`:10363` でカーソルを動かし、`:10391` / `:10403` で wheel を送る。ScrollPattern の背景入力はこの分岐にはない。開始と再開は、対象が前面でなければ `:5652` / `:6140` で `SetForegroundWindow` を呼ぶ。現行のセッションは「開始時に前面に出し、前面での UIA 呼出しと SendInput を続けて送る」形である。監査には `main/computer-use-action.ts:12` の `computerUseActionRoute`（`'semantic' | 'visual' | 'none'`、操作の種類からの分類）が `main/computer-use-controller.ts:5181` / `:5451` で route として記録される。

**決めること・推奨案**: 入力ごとの経路を、次の三値の `inputPath`（N9 の新しい内部契約の名前）に native が固定する。モデルから経路を指定して検査を省くことはできない。

| inputPath | 内容 | 使えるセッション |
| --- | --- | --- |
| `background_semantic` | 対象を前面に出さず、§2.2 の束縛で検証した要素の UIA pattern を呼ぶ | 背景セッションだけ |
| `foreground_semantic` | 今の semantic 入力と同じ。前面を検証して UIA pattern を呼ぶ | 前面セッションだけ |
| `foreground_input` | 今の SendInput の入力と同じ。前面・focus・geometry を検証して送る | 前面セッションだけ |

セッションは次の二つの形のどちらかにある。形は native が測定し、Main が状態として持つ。

- **背景セッション**: 対象が前面でなく、背景能力（下記の対応表）がある対象で始める。開始・再開は前面化しない。使えるのは `background_semantic` だけである。他の経路が要る操作は §2.4 の `awaiting_foreground_handoff` へ移る。
- **前面セッション**: 今の形を保つ。前面での UIA 呼出し（`foreground_semantic`）と SendInput（`foreground_input`）を続けて送ってよく、focus の喪失は今どおり pause である（§2.4 の承認の往復だけを例外とする）。#988 の方針どおり、pattern がある操作は `foreground_semantic` を先に使い、使えない操作だけ `foreground_input` にする。

前面セッションになるのは、(a) 開始時に対象がすでに前面にある場合（人が前面にしたものであり、製品は focus を変えない）、(b) 背景セッションから §2.4 の人の引渡しを経た場合、(c) 背景能力の gate が閉じている場合（旧 helper、能力宣言の欠落・版不一致）だけである。(c) は今の挙動そのものであり、gate が閉じている間は開始時の自動前面化（`:5652` / `:6140`）も今のまま残す。gate が開いた後、背景能力がない対象で前面でない場合に開始時に自動で前面化するかは、§2.4 の引渡しに統一する（自動前面化しない）。背景セッションへ戻るのは、前面セッションの pause の後に人が再開し、その時点で対象が前面でなく背景能力がある場合だけで、新規観測から始める。

`inputPath` は監査の既存の route とは別の欄とする。route は操作の種類の分類（semantic / visual / none）のまま残し、`inputPath` は実際に通った経路を記録する。route が semantic の操作は `background_semantic` か `foreground_semantic`、visual の操作は `foreground_input` になる。下記の semantic scroll は新しい閉じた操作として route を semantic にし、`computerUseActionRoute` を N9-1 で同時に直す。kill-stop の台帳には §2.5 の K-4 のとおり `inputPath` の列を足すことを求める。

背景経路（`background_semantic`）は次表の pattern だけを使い、SetForegroundWindow、ShowWindow による復元、SetFocus、SetCursorPos、SendInput、clipboard paste を一切呼ばない。

| 操作・pattern | 背景で行う条件 | 完了と効果の確認 | 制限 |
| --- | --- | --- | --- |
| Invoke | 一意の対象に InvokePattern があり、効果分類・承認が成立する | 今の前面での semantic Invoke と同じ基準とする（`:9445` の呼出しが成功し、呼出し後の再検証を通れば completed。今は `:10459` の前面の再検証、背景では §2.2 の 7 の再検証）。これより強い効果の確認（UI 状態の変化の期待値）は要求しない | `unknown_effect` になるのは timeout、error、呼出し後の再検証の失敗のときだけである（下記） |
| Toggle | 現在値と希望値を読み、異なる場合だけ Toggle を一度呼ぶ | ToggleState を読み直し、希望値であることを確かめる | Indeterminate、読取り不能、複数回 Toggle が必要な操作は背景実行しない。同値なら入力なしの完了 |
| SelectionItem.Select | 観測した単一要素を Select する。選択集合・効果分類も束縛する | IsSelected を読み直す | AddToSelection / RemoveFromSelection、複数選択への拡張は N9 に含めない |
| Value.SetValue | enabled、書込み可能、非 secure の ValuePattern に全文を一度渡す | 値を読み直し、渡した全文と一致することを native の中で確かめる | 本文をログに出さない。TextPattern を文字入力用の代替としない。Value 不在なら §2.4 の前面入力候補 |
| ExpandCollapse | 現在状態から Expand または Collapse を一度呼ぶ | ExpandCollapseState を読み直す | LeafNode、未確定状態は実行しない。同値なら入力なしの完了。topmost の popup や capture を伴う組は §2.3 のとおり背景能力なしとする |
| Scroll / SetScrollPercent（semantic scroll） | 一意に束縛した scroll container の ScrollPattern に対し、軸・量または到達率を固定する。scrollable、前後の percent / view size と対象範囲を読む | percent を読み直す | 座標 wheel の量を無条件で ScrollAmount に換算しない。要求と semantic の単位が一致しない場合は別の操作として再計画・承認する |
| ScrollItem.ScrollIntoView | N9 では背景入力として公開しない | — | 実現・表示・フォーカスへの副作用を今回確定しない。勝手に Realize / ScrollIntoView を挟まない |
| 座標 click / double_click、key、type、drag、座標 wheel | 背景経路には入れない | — | 前面セッションの `foreground_input` として、前面・対象・focus・geometry の検査を維持する。現行 dispatch の未対応操作を本 ADR だけで追加しない。drag を実装する段でも前面のままとする |
| その他の pattern、任意の UIA メソッド | 許可しない | — | WindowPattern の移動・閉鎖等を背景操作の一般入口にしない |

`unknown_effect` は、今の dispatch が accepted=true で返す効果未確認の code に対応させる。pattern 呼出しの timeout（`:9570` の `input_timeout_unconfirmed`）、呼出しの error（`:9564` の分岐の `input_not_confirmed`）、呼出し後の再検証の失敗（`:10461` の `input_not_confirmed`）、in-flight のまま待ちを打ち切った場合（`:9683` の `semantic_input_in_flight`）である。Toggle / SelectionItem / Value / ExpandCollapse / semantic scroll の読み直しが希望状態でない場合は、呼出し後の再検証の失敗に含める。InvokePattern.Invoke は provider が S_OK を返した後で動作してよい非同期の呼出しであり、completed の Invoke が後から効果を起こす余地は今の前面の semantic Invoke と同じく残る（§2.5、§4 の Q14）。

背景対象は、存在し、可視で、最小化されておらず、geometry を取得できる束縛済みウィンドウに限る。他の窓による遮蔽は許す。次は拒否する: 最小化、別の Win32 desktop（入力 desktop と異なる HDESK。secure desktop を含む）、現在の仮想デスクトップにない窓、DWM が cloak した窓、読取り不能。仮想デスクトップ上の別の窓や cloak された窓は `IsWindowVisible` が真のままなので（今の `:8247` は `IsWindowVisible` だけで判定する）、背景対象には `DwmGetWindowAttribute(DWMWA_CLOAKED)` が 0 であることと `IVirtualDesktopManager::IsWindowOnCurrentVirtualDesktop` が真であることを加える。セッション中にユーザーが仮想デスクトップを切り替えて対象が現在の仮想デスクトップから外れたら、新規 claim を閉じて pause する。復元を背景操作に混ぜない。新しいダイアログへの自動追従も行わず、再観測または既存の takeover に移る。

UIA の API 自体に「provider がフォーカスやカーソルを変えない」という強制力はない。背景能力とは、上記の対象束縛に加え、その provider・control・pattern の組で非活性化が実機確認されていることを意味する。N9 は Windows 専用の版付き対応表を持ち、未知・更新後の未確認の組は背景能力なしとする。runtime id が index 由来と判定できる proxy の要素（Win32 ListView / TreeView の UIA proxy など。§2.2 の 3）も背景能力なしとする。アプリ全体への grant とは別であり、未知を ordinary としない。provider が予期せず前面化・カーソル移動・topmost の popup・capture を起こしたら受入 FAIL とし、その組の背景経路を閉じる。元のフォーカスやカーソルを強制的に戻して成功扱いにしない。

**代案・理由**: pattern の存在だけで一律に背景対応とする案は、provider の副作用を AC-6 に反して見逃す。すべて SendInput にする案は AC-6 を満たさない。経路を二値にして前面での UIA 呼出しを廃止する案は、前面セッションで pattern を先に使う #988 の方針を満たさず、今の semantic 入力の扱いが宙に浮く。Invoke に業務上の効果の期待値を求める案は、期待値の出所（モデルの申告は信用できず、classifier は効果を予測しない）が無く、通常の Invoke のほとんどを `unknown_effect` と対象の隔離に落とす。限定した pattern と実機確認済みの組から開き、完了の基準は今の semantic 入力に揃える案を推奨する。

**N9 で作るもの**: `inputPath` とセッションの形の閉じた契約、能力宣言・版照合、対応表、pattern ごとの executor と読み直し、semantic scroll の対象・単位を表す閉じた契約、監査の `inputPath` 欄を作る。既存の座標 scroll の意味を変更しない。start / resume / observe / preflight / approve / dispatch の全段に経路を通し、背景 start は対象を選択するだけで前面化しない。

### 2.2 前面確認に代わる再検証

**現状**: `native/computer_use_windows_host.cc:9798` は observation の存在、active window と前面の一致（`:9803`）、cancel epoch、session identity、dialog 集合と active identity、geometry を検査する。`:9925` は要求の observation revision と epoch を照合し、`:9947` で V2 適格性を再判定する。`:7079` の session 検証が呼ぶ `:3578` の dialog 集合の取得は、`:3584`、`:3622`、`:3689` で `GetForegroundWindow` に依存する。`:8246` の TargetWindowFacts も前面を要求する。観測も前面に依存する。capture の `CaptureWindowWithGraphicsCaptureOnWorker` は対象が前面でなければ失敗し（`:7607`）、この capture は observe（`:11164`）と interlock の visual patch 照合（`:8081`）で使われる。observe は focused element の分類と署名を対象 PID の focus から読む（`:11140`、`:11151`）。target list の `focused` 欄は前面かどうかである（`:3824`）。要素の署名は `:8983` の `ComputeWindowsControlSignature` で PID の一致を確かめ、control type、矩形、runtime id、AutomationId から作る（Name・値・ItemStatus は材料に入らない）。target id は AutomationId を優先し、空のときだけ Name を使う（`:9090`）。dispatch は `:9330` の束縛 window を根に探索して同名の重複を拒否し、`:9418` で観測時の署名と照合する。

**決めること・推奨案**: 前面セッションの検証は今のまま維持し、背景経路にだけ次の対象束縛を追加する。共通関数から foreground の一行を消す方法は採らない。

1. Main が session / Task / Turn、grant、policy、送信同意、mode、helper generation、対象の隔離（§2.5）を検査する。native は生存するプロセスの PID + 作成時刻、保持した実行中 image identity、署名・package・ruleset、HWND の所有と window identity を照合する。PID、HWND の数値だけを identity としない。
2. 背景の active window は観測で明示的に束縛した window であり、GetForegroundWindow から選び直さない。window の存在、可視性、非最小化、非 cloak、現在の仮想デスクトップ、enabled、client geometry / DPI、dialog 集合と owner 関係を再検証する。dialog 集合は束縛 window とその owned window から作り、前面から選ばない。新規 modal、OS prompt、secure surface、対象の無効化は拒否する。別アプリの通常の前面変更だけは target change としない。
3. 要素は束縛 window の UIA root から再解決する。runtime id、PID、control type、AutomationId、矩形、bounded ancestor chain の各所有 PID / runtime id と root への到達に加え、**内容の指紋**を照合する。指紋は Name、ItemStatus と値の種別（値の本文ではない）、親コンテナの中の位置（兄弟の中の index と兄弟の数）、取れれば ItemContainer の項目 identity から native の中で digest として作り、本文を helper の外に出さない。runtime id 単独、名前だけ、別 window の ElementFromPoint、現在の focused element で代用しない。欠落・重複・上限超過・要素の交換は入力前拒否である。runtime id が index 由来と判定できる proxy の要素（Win32 ListView / TreeView の UIA proxy など。ProviderDescription と runtime id の形で判定する。判定の具体は N9-2 で実機確認する）は、並べ替え・挿入・仮想化コンテナの再利用で同じ runtime id のまま中身が入れ替わるため、指紋があっても背景能力なしとする。
4. observation revision、action / payload、`inputPath`、pattern、対象署名と内容の指紋、祖先・面・origin、効果、geometry、cancel epoch、Stop serial、helper / ticket generation、§2.3 の interaction epoch を authority に束縛する。観測は背景 window 自体から得る。遮蔽した前面画面の pixel や別アプリの focus chain を分類に流用しない。背景の capture は前面を条件にしない別の入口とし（遮蔽は許し、最小化・cloak は拒否する）、focused element 由来の欄は背景では「欠落」として扱い、focus が動いたとは扱わない。遮蔽された窓の capture（Windows Graphics Capture）が成り立つかは N9-2 の最初に実機で確かめる。成り立たない場合は pixel の無い観測とし、分類に画面が必要なのに対象由来と証明できなければ操作しない。再観測は旧 ticket を失効させる。
5. preflight、承認交換、dispatch の各段で同じ対象から deny class・secure・面・実行トリガを再評価する。背景であることは §3.6 の E1 / E4 拒否や N8 の単発承認を外す理由にならない。N8 の承認の再測定（interlock の visual patch 照合を含む）も 4 の背景の capture を使う。背景の承認の測定はこの capture が成り立つことを前提とする。
6. pattern と必要状態を読み終えた後、呼出し直前に対象・祖先・内容の指紋・geometry と epoch を再検証する。Stop / takeover が更新する取消し状態との同じ claim 境界で、一入力だけを発行する。claim 後に届く取消しを「未送信」に書き換えない。検証中に別の要素へ解決し直して入力しない。
7. 呼出し後も identity、window、geometry、祖先、内容の指紋（効果で変わる欄は §2.1 の希望状態として扱う）、世代・epoch、dialog 集合を検証し、§2.1 の pattern ごとの読み直しを行い、新しい観測を返す。Invoke は §2.1 のとおり、この再検証を通れば completed とする。再検証に失敗したら `unknown_effect` とする。後検証失敗は巻戻しの証明ではない。

T5 の誤配防止は、背景経路では OS の前面への配送を使わず、検証した要素の pattern object への呼出しに置き換えることで保つ。別アプリが前面になっても、配送先はその要素へ束縛されたままである。provider の実装が物理入力を合成するような組は、§2.1 の対応表の実機確認で背景能力なしとする。対象 provider 内部の動作や、検証直後の対象消失を原子的に止める保証はないため、後検証・再送禁止・対象の隔離（§2.5）を併用する。前面セッションの SendInput にこの説明は適用できず、従来の前面・focused element 検証を保持する。

**代案・理由**: 名前だけの再探索、cached element の無検証再利用、foreground チェックだけの除去は、要素再生成・HWND 再利用・dialog の差替えを検知できない。今の署名だけでは、index 由来の runtime id を持つ項目の中身の入替えを検知できない。背景では対象が隠れていて人が目で気付けないため、内容の指紋を加える。すべての UI 更新を無条件拒否する案は Toggle 等の正常な効果も拒否するため、入力前の同一性と入力後の許された変化を分ける。

**N9 で作るもの**: 背景用 window / dialog 検証、背景の capture と対象 root からの観測・分類、祖先と内容の指紋を含む署名、index 由来の proxy の判定、経路付き authority、最後の claim 検査、前後の再検証を作る。普通の経路と承認経路の両方から同じ検証核を呼ぶ。N1 によるファイル分割後も上記シンボルを追跡する。

### 2.3 user takeover の新しい定義

**現状**: native の前面変化は `:3595` で focus_required または native_dialog_user_takeover になり、`:9803` でも入力を拒否する。`main/computer-use-controller.ts:4516` の userTakeover は paused を通知する。この関数自体は native の入力取消しを行っていない。V2 ADR §5 の paused は人だけが再開できる終端である。helper の protocol は要求と応答の組だけで、native から自発的に送る frame の型が無い（`main/computer-use-native-protocol.ts:13`）。一覧に無い型番号の frame は transport を壊し（`main/computer-use-native-windows.ts:906`）、pending に一致しない frame は捨てられる（同 `:942`）。controller の `subscribe`（`:3918`）は Renderer への status 用で、native の event を受ける口ではない。cancel epoch は Main が進める（controller `:3028`、`:3526`、`:3597`、`:3889` の `cancelEpoch + 1`）。helper には低レベル入力 hook も、その用の message loop を持つスレッドも無い（`SetWindowsHookEx` は 0 件）。

**決めること・推奨案**: 背景セッションでは「対象について人が操作を引き取った、または人と競合する疑いがある」を takeover とする。前面セッションの takeover は今のまま（focus の喪失で pause。§2.4 の承認の往復だけを例外とする）である。

| 出来事 | 背景セッションの扱い |
| --- | --- |
| ユーザーが無関係な通常アプリを前面にする・そこで入力する。Sprint Coder への移動を含む | 継続できる。前面アプリ名や入力本文を収集・公開しない |
| 対象 window、その owned window、対象プロセスの任意の top-level window が前面になる | 発生源を問わず即座に pause する。provider の副作用も含む。自動で裏へ戻さない |
| 前面にならない対象へユーザーが click / wheel / pointer 操作を始める | hit target（WindowFromPoint）・capture owner（GUITHREADINFO）を主に、対象矩形を補助にして対象へ結び付く入力を takeover とする。非アクティブ窓への wheel も含む |
| 対象の移動・resize、操作元の判定不能 | takeover。対象要素の変更が検証に引っ掛かるまで待たない |
| 対象由来の WinEvent（値の変化、Invoked、構造の変化など）が自分の呼出しと対応しない。対象が登録した global hotkey や別の UIA client による操作を含む | 所属不明の takeover として pause |
| 呼出し区間に、対象プロセスの新しい top-level window、topmost / popup window、capture の取得が現れる（ExpandCollapse の dropdown、owner の無い新しい窓など） | 前面化を伴わなくてもユーザーの作業を妨げる副作用として、呼出し後の再検証の失敗（`unknown_effect`）とし、その組の背景経路を閉じる |
| 別アプリの通常入力でも、対象への所属を判定できない | 安全側に pause。全デスクトップの最終入力時刻だけを所属判定に使わない |
| secure desktop、session lock、仮想デスクトップの切替で対象が外れる、監視の欠落・遅延・失明 | 新規 claim を閉じて pause。監視回復だけで自動再開しない |

キー入力は前面のスレッドの focus へ配送されるので、前面でない対象へのキー入力は対象の前面化（2 行目）を伴う（確度: 強い推定。global hotkey は 5 行目で扱う）。このため所属の監視に低レベルのキーボード hook は使わない。

native は背景セッションの開始前から、前面の変化（`EVENT_SYSTEM_FOREGROUND`）、対象プロセスの WinEvent、mouse の対象所属を監視し、単調増加の interaction epoch と不明状態を保持する。mouse の所属には低レベル mouse hook（`WH_MOUSE_LL`）を使う案を推奨する。hook は背景セッションがある間だけ、専用の message pump スレッドに入れ、セッションの終了で外す。callback は最小の metadata（時刻、hit target が対象に属するか）だけを記録し、座標の列・他アプリの名前・入力本文を保存しない。自分の注入に付けた目印だけを根拠にユーザー入力を無視しない（背景経路は入力を注入しない）。大域の低レベル入力 hook の採否は §4 の Q8 で問う。

監視の生存は次で確かめ、どれかに失敗したら背景経路を閉じる（新規 claim の gate を閉じ、pause する）。

- **hook の外れ**: 低レベル hook は callback が `LowLevelHooksTimeout` を超えると OS に通知なく外されうる。`GetLastInputInfo` の tick が進んだのに hook が対応する event を受けていなければ、失明とみなす。
- **pump の停止・遅延**: message pump スレッドは一定間隔で自分宛ての心拍を投げ、その到着の遅れを測る。上限を超える遅れ、または心拍の欠落を遅延・失明とみなす。間隔と上限は N9-3 の実測で決める。
- **初期化・再登録の失敗**: hook・WinEvent の登録失敗、スレッドの異常終了。外れた後に再登録できても、それだけで自動再開しない。

観測から最後の claim まで interaction epoch が同じこと、監視が生きていることを検査する。イベント取りこぼしを完全に証明できるとはしない。

**takeover の通知路と epoch の同期**: 今の protocol には native → Main の非同期の通知路が無いので、次を要件とする（N9-3）。

1. 新しい非要求の event frame（名前は N9-3 で決める）を足す。C++ と TS の MessageType を名前・数値で一致させ（`main/computer-use-windows-transport.test.ts:2518` の完全一致の試験に載せる）、helperGeneration・sessionId・単調増加の event 番号に束縛する。event は takeover の理由と、その時点の interaction epoch だけを運ぶ。
2. native は takeover を検出したら、Main を待たずに自分の claim gate を閉じ、interaction epoch を進めてから event を送る。**native は cancel epoch を自分で進めない。** cancel epoch の所有は今どおり Main だけとし、interaction epoch は native だけが進める別の値とする。
3. Main は event を受けたら、今の Stop / pause と同じ経路で cancel（`cancelEpoch + 1`）を送り、`cancelPendingApprovals`、ordinary ticket と execution ticket の失効、paused の emit（pause の理由つき）を行う。
4. 要求は期待する interaction epoch を運び、native は一致しなければ takeover として拒否する（`invalid_action` にしない）。event が失われても、次の要求はこの照合で拒否されるので、入力は出ない。event と応答の順序が入れ替わっても、epoch の照合で後の要求は拒否される。transport の破損は今の helper の失敗の扱いに従う。

一入力がすでに claim 済みなら、その入力は取り消せない。takeover と claim が競合して結果未確認なら、§2.5 の K-1 で対象を隔離する。再開は V2 ADR の人による再開条件を維持し、同じ Turn のモデルが続行を命令できない。

**代案・理由**: 別アプリへの移動も全停止する案は背景操作の利点を失う。対象が前面になってもキー入力まで待つ案は最初の入力との競合窓を広げる。前面化を保守的な引取り信号とする案を推奨する。低レベル mouse hook を使わない案（WinEvent だけ）は、前面化を伴わない非アクティブ窓への wheel や pointer 操作を検出できない。ただし OS のイベント通知と UIA の provider 呼出しは原子的ではなく、同時操作が一切起きない保証はしない。発行済みの一操作の残余リスクは §2.5 で表示・隔離する。

**N9 で作るもの**: 入力所属の監視、監視の生存確認、interaction epoch、native の即時 gate 閉鎖、event frame と Main の paused への接続、再開時の新規観測、監視不能の fail-closed を作る。`frontmost` は V2 ADR の理由（攻撃者が誘導できる選択圧）からモデルへ返さない。経路と pause 理由の必要最小限だけを返し、前面アプリの一覧を追加しない。

### 2.4 背景から前面入力への切替と承認の往復

**現状**: `native/computer_use_windows_host.cc:9448` などは pattern 不在を semantic_pattern_unavailable とする。`:9564` は accepted 後の失敗を input_not_confirmed 等に区別する。`:10252` の click は `:10289` でカーソルを動かす。`:9820` は前面を再検証して SendInput を呼ぶ。開始・再開の前面化は §2.1 のとおりで、現行 semantic 分岐には失敗後の自動 SendInput fallback はない。承認の後は、controller の `refocusAndReobserve`（`main/computer-use-controller.ts:3819`）が `startSession`（`:3831`）を呼び、native の再開の `SetForegroundWindow`（`:6140`）で対象へ戻ってから再観測する。呼出し元は V1 カードの `resolveApproval`（`:3762`）と native の単発承認の `runNativeApproval`（`:5148`）である。helper は Sprint Coder の子の非前面プロセスで、リポジトリに `AllowSetForegroundWindow` の呼出しは無い。

**決めること・推奨案**: 背景セッションでは UIA を先に検討する。入力を一度も発行していないと確認でき、pattern または背景能力がない場合、または操作が座標・キー・type などの前面だけの操作である場合だけ、前面経路の候補にする。

| UIA の結果・操作 | 次の状態 |
| --- | --- |
| pattern が存在しない、対応表の能力がない、前面だけの操作。入力前であると確認済み | `awaiting_foreground_handoff`（新規内部状態）へ。入力しない |
| 対象不一致、分類拒否、承認不能、監視不能、Stop、読取り timeout | 拒否 / pause。前面化で安全検査を回避しない |
| pattern を呼んで timeout・error、応答消失、呼出し後の再検証の失敗 | `unknown_effect`。自動再送・別 pattern・SendInput fallback を禁止し §2.5 へ |
| 希望状態だった、または §2.1 の基準で完了した | 入力なしの完了または完了。fallback しない |

**人の引渡し**: 前面への切替は、人がカードの「対象を前面にして操作を続ける」を明示操作した場合だけ行う。対象、操作、カーソルが動く可能性、別アプリの入力が中断することを表示する。カード出現自体は showInactive / flashFrame 相当と polite 通知で、ボタンに既定 focus を置かない。D14（承認カードはフォーカスを取らない）は承認カードの到達を明示操作に限る規則で、対象の前面化を直接定めてはいない。しかし D14 の理由（別アプリで入力中の人のキー入力が、非同期に前に出た窓へ届く）は、背景セッション中に対象を自動で前面化した場合にもそのまま当てはまる。このため背景から前面への切替は人の明示的な引渡しに限り、製品が自動で前面化しない。これが D14 の目的を対象の前面化にも及ぼす本 ADR の決定である。

引渡しの許可は session / Task / Turn、helper generation、対象 identity、元の action と経路変更の intent に束縛した一度限りのものとし、最大 60 秒で失効する。これは操作の危険度の承認を代替しない。消費前に Stop と identity を検査する。trusted activation を消費した Main は、その時点の前面プロセス（人がカードを押した Sprint Coder）として、helper の pid を指定して `AllowSetForegroundWindow` を一度だけ呼んでから helper に前面化を指示する。`ASFW_ANY` は使わない。Electron はこの API を公開しないので、Main の Windows addon に足す（確度: 強い推定）。helper の `SetForegroundWindow` は foreground lock で失敗しうるので、前面化の成功を測定し、失敗したら入力せず pause する。成功したら前面セッションへ移り、再観測・再分類を行ってから N8 の必要な承認と新しい execution ticket を得る。古い背景用 ticket は使わない。

**引渡しの単位**: 引渡しの後の前面セッションで、前面入力を何回まで許すかは §4 の Q10 で問う。推奨は「引渡しの後は前面セッションの区間とする」案である。引渡しの後は今の前面セッションと同じく連続入力を許し、focus の喪失（承認の往復を除く）で pause、背景へ戻るのは人の再開と新規観測による。理由は次のとおりである。(a) #988 の方針は「使えないときだけ前面に出して SendInput」であり、操作ごとの人の引渡しまでは求めていない。(b) `type` は 1 dispatch で 1 Unicode scalar なので（承認経路 ADR §2.2 の 8、kill-stop ADR §2.4）、操作ごとの引渡しは文字ごとのカードになる。(c) 前面セッションの安全（T5）は、今どおり前面・focused element の検証と focus 喪失の pause が担い、引渡しの回数に依存しない。(d) D14 が求めるのは自動で focus を奪わないことであり、人が一度引き渡した後の各操作に再同意を求めるものではない。対案は「一操作の完了で前面入力の権限を消費し、次の前面入力にも引渡しを求める」案で、人の関与は強まるが、上記 (b) の負担と #988 の方針より重いことが欠点である。

**承認の往復**: 前面セッションで N8 のカード（supervised の操作ごとの確認、E2 / E3、二枚カード）が要る操作では、人はカードを操作するために Sprint Coder へ移り、承認後は対象へ戻る必要がある。この往復を、通常の focus の喪失と区別する次の状態 `approval_round_trip` として定義する。

- 入る条件: その操作の承認カードが pending で、前面が対象から Sprint Coder の窓へ移ったとき。Sprint Coder の窓は、Main が自分のプロセスの BrowserWindow の HWND として判定し、名前や表示文字列で判定しない。
- 許す窓: 対象（とその owned window）と Sprint Coder の窓だけである。この状態の間は入力の claim を閉じる。第三の窓へ前面が移ったら、通常の focus の喪失として pause し、カードを失効させる。
- 時間の上限: そのカードの期限（native の単調時計で最大 60 秒の intent の残り。承認経路 ADR §2.2 の 3）とする。期限・拒否・Stop・世代失効で状態を終え、pause する。二枚カードでは往復が二回起こりうる。それぞれが同じ条件を満たす必要がある。
- 対象への復帰: trusted activation を Main が消費した後だけ、上記と同じく helper の pid に `AllowSetForegroundWindow` を一度許して対象へ戻す（`refocusAndReobserve` に当たる）。戻った後、identity（PID + 作成時刻）、HWND、geometry、dialog 集合、要素の署名と内容の指紋、interaction epoch、cancel epoch、Stop serial、helper 世代を再検証し、新しい観測と再分類が承認した内容と一致する場合だけ execution ticket へ進む。不一致は再承認を自動発行せず拒否する。exchange 後に observe / refocus を挟まない制約（承認経路 ADR §2.2 の 5）は維持する。
- 背景セッションのカードは、Sprint Coder への移動が §2.3 の表の 1 行目の「無関係な通常アプリ」に当たるので往復の状態は要らない。承認後に対象を前面化せず、§2.6 の背景の再観測で進める。

対象を前面に出すこと自体も取消しと競合する control intent として記録する（§2.5 の K-4）。引渡し中の Stop は未消費の許可を失効させる。すでに前面化を発行した場合の結果は記録するが、ユーザーの focus を復元する追加操作はしない。

**代案・理由**: 失敗ごとに自動で前面化する案は D14 の目的に反し、遅延 UIA と二重実行になる。fallback を全廃する案は #988 N9 の方針を満たさない。前面化の後の focus の移動を一律に pause にする案は、承認カードの操作のための往復で止まり、承認が要る前面入力を完了できない。入力前の能力不足だけを人の引渡し付きで切り替え、承認の往復は窓・時間・再検証で限定して許す案を推奨する。

**N9 で作るもの**: 入力前拒否と発行後不明の型、引渡し intent / UI / 消費、`AllowSetForegroundWindow` の付与と前面化の成否の測定、経路変更時の ticket 破棄・再観測・再承認、`approval_round_trip` の状態と復帰の再検証、前面セッションへの明示遷移を作る。semantic と物理入力が同じ効果であると測定できない場合は、元要求の fallback ではなく新規の操作要求として扱う。

### 2.5 取り消せない UIA 呼出しと kill-stop への追加要求

**現状（コード）**: `native/computer_use_windows_host.cc:8644` の InvokeWindowsSemanticInput が semantic 入力を扱い、`:9683` は ever_claimed / input_in_flight から未確認を区別する。`:10220` は semantic 入力が in-flight の間、新しい dispatch を拒否する。UIA は bounded automation で作られ、transaction timeout は 300 ms、connection timeout は 500 ms である（`:7255`、`:7254`）。pattern 呼出しの timeout は `:9570` で `input_timeout_unconfirmed` になる。

**現状（kill-stop ADR の確定内容）**: kill-stop ADR §2.1 のとおり、provider 側の UIA 呼出しと proxy の送信済み message は client 終了で取り消せず、SendInput も入力ストリームへの投入にすぎない。同 §2.1 は、UIA の client timeout の後は provider 側に呼出しが残っていても receipt で Stop が確定し、この経路には対象の隔離が無いとする。同 §2.2 の台帳は、helper の世代、session id、request id、種類、対象の identity（pid + 作成時刻）、状態を持ち、効果を確定した応答で行を消し、検証済みの close receipt で Stop を確定したセッションの行も「receipt で確定済み」として消す。対象の隔離が作られるのは、helper の終了で確定した `terminated_target_suspect` と、起動時に SQLite に残った台帳の行（同 §2.2 の 5）だけである。隔離が拒否するのは startSession・resume・discovery の入口だけで（同 §2.2 の 2）、解除は対象の終了の照合か承認カードでの再開による（同 §2.2 の 3、4）。同 §2.3 と §5 の 2 は、receipt の経路に対象の隔離が無いことを「今と同じで、この ADR は変えない」としている。

**背景経路との差**: 上の確定内容のままでは、背景経路の主要な失敗で対象が隔離されない。

| 背景経路の出来事 | kill-stop ADR の今の契約 | 背景経路に要るもの |
| --- | --- | --- |
| 実行中のセッションで `input_timeout_unconfirmed`、効果未確認の `input_not_confirmed`、`semantic_input_in_flight`（§2.1 の `unknown_effect`） | 行は効果未確認として残るが、隔離は helper の終了か再起動まで作られない。その後に receipt で Stop を確定すれば行は消え、隔離されない | その時点で対象を隔離する（K-1） |
| takeover と claim が競合し、結果未確認 | helper を終了しない pause から隔離へ入る入口が無い | その時点で対象を隔離する（K-1） |
| 隔離中の対象への、実行中のセッションの dispatch・承認交換・引渡し | 隔離が拒否するのは開始・再開・discovery の入口だけ | 実行中のセッションでも新しい claim を拒否する（K-2） |
| receipt で確定した効果未確認の背景の行 | receipt の時点で消す | 消さずに対象の隔離へ移す（K-3） |
| 経路・前面化の記録 | 台帳に経路の列・前面化の種類が無い | 列と種類を足す（K-4） |

**決めること・推奨案**: 背景操作も kill-stop の control 要求として同じ所有・台帳に登録する。新しい「背景専用 Stop」は作らない。そのうえで、次を **kill-stop への追加の要求** とし、その追加を N3（kill-stop の実装、kill-stop ADR §4 の S2）の範囲に入れることを求める（§4 の Q13）。

- **K-1（実行中の隔離の入口）**: 背景経路の dispatch が accepted=true の効果未確認（`input_timeout_unconfirmed`、`input_not_confirmed`、`semantic_input_in_flight`）で返ったとき、および背景経路で takeover と claim が競合して結果未確認のとき、Main は Stop や helper の終了を待たずに、その要求の対象（pid + 作成時刻）の隔離を作る。隔離の行は kill-stop ADR §2.2 の 5 と同じ SQLite のストアに書き、再起動をまたいで保つ。書けなければセッションを pause し、その対象の開始を拒否する（fail-closed）。隔離の行が持つのは同 §2.2 の 5 と同じく pid、作成時刻、隔離の理由だけである。
- **K-2（隔離の効く範囲）**: 隔離は startSession・resume・discovery の入口に加え、実行中のセッションのその対象への dispatch・承認交換・前面への引渡しを拒否する。K-1 で隔離したセッションは pause し、Controller の通常の resume（paused のための再開）では再開できない。再開は kill-stop ADR §2.2 の 4 の承認カードでの再開による。隔離は PID + 作成時刻の対象プロセスに掛け、同じプロセスの別窓・別 session・前面入力からも迂回できない。
- **K-3（receipt で確定した行を消さない例外）**: `inputPath` が `background_semantic` で効果未確認の行は、検証済みの close receipt で Stop を確定しても消さず、同じ SQLite の transaction で対象の隔離へ移す。K-1 の隔離の書込みと応答の処理の間に Main が crash した場合も、残った行が起動時に隔離へ移る（kill-stop ADR §2.2 の 5）。
- **K-4（台帳の列と種類）**: 台帳の行に `inputPath` の列を足す。前面への引渡し（helper の `SetForegroundWindow`）も control の種類として台帳に記録する。前面化は対象の内容への入力ではなく、win32k の短い呼出しで完了するので、その結果未確認は隔離を作らず pause にする。前面化が遅れて効いた場合の残余リスクは Q14 に含める。

隔離の解除は kill-stop ADR §2.2 の 3（対象の終了の照合）と同 §2.2 の 4（承認カードでの再開）に従う。人の再開でも、遅延呼出しを消せた保証はない。カードは「最後の操作が後から反映される可能性がある」を示す。単に画面が変わっていない、待ち時間が過ぎたことを解除根拠にしない。helper の終了確認は「helper から新しい入力が出ない」の証拠であり、「対象が最後の操作を実行しない」の証拠ではない。遅い成功 receipt だけで、旧 ticket や旧世代の session を復活させない。

helper 世代の失効では、背景 observation、要素参照、引渡し許可、承認 intent、execution ticket を一括失効させる。再接続後は対象の隔離を検査し、新規観測から始める。旧要求を新 helper へ再送しない。provider が固まったときの期限・helper 終了・台帳の recovery は kill-stop の責務である。N9 は timeout を成功に変換せず、未確認の対象と要求を渡す。

**N9 は、N3 で K-1〜K-4 が入るまで背景入力を公開しない。** 背景能力の gate は、N3 の実装に K-1〜K-4 が入り、その試験が通るまで閉じたままにする。N3 がこの追加を採らない場合も、K-1〜K-4 の無い状態で背景入力を開かない。その場合は本 ADR を改めてオーナーに諮る。

completed で返った Invoke の後の非同期の効果（§2.1）は、kill-stop ADR §5 の 2 のとおり隔離されない。これは今の前面の semantic Invoke と同じで、K-1〜K-4 でも変わらない。

**代案・理由**: helper を kill したら再送可能とする案、UIA の HRESULT だけで隔離を解除する案は、遅れて実行される provider 呼出しを見落とす。対象アプリを強制終了する案も、未保存のユーザー作業を失うため採らない。kill-stop を変えずに「timeout の後の遅延実行は隔離されない」を残余リスクとして受け入れる案は、背景ではユーザーが別アプリで作業していて遅延した効果に気付きにくく、前面より危険が大きいため採らない。

**N9 で作るもの**: 背景 control と前面引渡しの台帳への記録（K-4 の列と種類は N3 の台帳に載る）、K-1 の隔離の契機の通知、世代失効、再送禁止、残余リスクの表示を作る。K-1〜K-4 の台帳・隔離の側は N3 が作る。kill-stop の終了方式を再設計しない。

### 2.6 承認経路との関係

**現状**: `main/computer-use-controller.ts:5213` は approvalApprove に action / observationRevision / cancelEpoch / approvalGeneration を渡し、`:5244` で dispatchApproved を呼ぶ。`:5254` は呼出し後の例外を unknown_effect とし ticket を使い直さない。承認の後に対象へ戻るのは `refocusAndReobserve`（`:3819`）で、無条件に `startSession`（`:3831`）を呼び、native の再開の `SetForegroundWindow`（`native/computer_use_windows_host.cc:6140`）を通る。呼出し元は V1 カードの `resolveApproval`（`:3762`）と native の単発承認の `runNativeApproval`（`:5148`）の二つである。承認経路 ADR §2.3 のとおり、Windows の supervised で plan 対象外の入力では V1 カードと native カードが二枚出るので、V1 側の再前面化も実際に通る。N8 の承認の再測定は interlock の visual patch 照合（`native/computer_use_windows_host.cc:8081`）で前面を要求する capture を使う。これは共有 controller の現状であり、Windows N8 の完成を示すものではない。承認経路 ADR §2.2 は execution ticket の束縛、§2.3 は supervised、§2.8 は非自動フォーカスを定める。

**決めること・推奨案**: 背景操作にも同じ mode / grant / classifier / 操作ごとの承認を要求する。supervised の選択・スクロール等の粒度、plan 対象外の二枚カード、E2 / E3 の単発性、E1 / E4 の無条件拒否は N8 の契約を引き継ぐ。背景という理由で確認を省略しない。

N8 の authority に `inputPath`・pattern・対象祖先・内容の指紋・interaction epoch を追加し、ordinary ticket と execution ticket の両方で照合する。カードが承認するのは表示した対象・操作・経路だけである。背景のカードには「対象を前面にせず操作する」を示し、前面引渡しカードとは区別する。表示値は native の検証済み経路に由来し、モデルの申告で上書きしない。

承認後の対象への復帰は経路で分ける。背景セッションでは、V1 カード（`resolveApproval`）と native カード（`runNativeApproval`）のどちらの後も `startSession` による再前面化をせず、同じ identity の背景の再観測（§2.2 の 4 の背景の capture と UIA 読取り）に置き換える。二枚カードでも前面化の API は 0 回である。前面セッションでは今の `refocusAndReobserve` を残し、§2.4 の `approval_round_trip` と復帰の再検証に従う。承認カードの表示・ユーザーによる Sprint Coder への移動は、背景セッションでは takeover ではない（§2.3 の表の 1 行目）。承認待ちに対象が前面化・変更されたらカードを失効させる。exchange 後に observe / refocus を挟まない制約、期限、trusted activation、Stop と世代失効は維持する。背景の承認の再測定は、§2.2 の 4・5 の背景の capture が成り立つことを前提とする。

**代案・理由**: 背景操作を安全とみなして自動承認する案は、Invoke 等が同じ危険な効果を持つことを無視する。承認のたびに対象を前面に戻す案は AC-6 を満たさない。native カードの経路だけを直す案は、V1 カードの `resolveApproval` の再前面化が残り、AC-6 違反と §2.3 の表の 2 行目の takeover を招く。承認の意味を保ち、復帰経路だけ分ける。

**N9 で作るもの**: N8 の契約を拡張する schema / native / Main / 表示の変更、V1 カードと native カードの両方の経路別の復帰、背景再観測、route 変更の拒否試験を作る。承認の仕組みやカード数を独自に作り直さない。N8 の実装完了と本 ADR の承認が N9 の前提である。

### 2.7 試験と実機の受入

**現状**: `main/computer-use-windows-input-seam.test.ts:29` は入力 API attempt と guard refusal を区別する試験、`main/computer-use-windows-ticket-seam.test.ts:873` は ticket の発行・束縛・消費・失効の試験である。これらは背景操作の実機受入ではない。UI 検証の正本は `docs/testing/computer-use/README.md` であり、実操作は開発エージェントの Computer Use で行う。

**決めること・推奨案**: 単体・native 境界試験で不正入力が発行されないことを確認し、Windows 実機では foreground と cursor を操作区間全体で受動計測する。開始と終了の screenshot が同じだけでは、一瞬の前面化・移動を見逃すため PASS にしない。

| ケース | 操作と合格条件 |
| --- | --- |
| BG-1 pattern ごとの背景正例 | 合成 fixture の対象窓を非最小化で別アプリの背後に置く。§2.1 の各 pattern の入力・承認を実 UI から開始する。対象効果が一度だけ確認され、区間内で対象が前面にならず、製品から focus / cursor / SendInput API が呼ばれず、ユーザーが動かさない区間の cursor 座標が不変であり、区間内に新しい topmost / popup window と capture の取得が無い |
| BG-2 別アプリでの作業 | 別アプリで合成の文を入力しながら背景操作する。文字がそのアプリだけへ届き、カード出現が keyboard focus を変えない。ユーザーによる cursor 移動は別の区間として記録し、背景操作による移動と混同しない。背景操作の副作用の popup が前面アプリの作業を妨げない |
| BG-3 takeover | 対象の前面化、対象プロセスの owner の無い窓の前面化、非アクティブ wheel、click、resize、capture、対象由来で自分の呼出しと対応しない WinEvent（別の UIA client・global hotkey）を各々行う。次の claim が拒否され、人の再開まで停止する。claim 前・直後・provider 内停止中を別々に試験し、発行済みは未確認として K-1 で隔離される。event frame の欠落・順序の入替えでも interaction epoch の照合で入力が出ない |
| BG-4 対象差替え | PID / HWND 再利用、runtime id / ancestor 変更、同名重複、geometry / DPI 変化、dialog 発生、最小化、secure desktop、別の仮想デスクトップ、cloak された窓、仮想デスクトップの切替を境界 fixture で作る。**同じ index・同じ runtime id・中身が違う項目**（並べ替え・挿入・再読込み）と、**仮想化コンテナの再利用**（スクロールで同じ要素が別の項目を表す）の負例を含める。index 由来の runtime id の proxy は背景能力なしと判定される。入力前の失敗は API attempt が 0、発行後は未確認となり fallback しない |
| BG-5 fallback と承認の往復 | pattern 不在ではカードが出ても focus は動かない。明示引渡し後だけ前面化し、新しい観測・必要な承認・ticket で操作する。拒否、期限、Stop、前面化失敗（foreground lock を含む）、直後の別アプリへの移動で入力が出ない。supervised の前面 fallback の通し試験として、Sprint Coder への往復で承認を完了でき、第三の窓への移動・期限切れ・復帰後の対象変更では入力が出ない。`AllowSetForegroundWindow` は helper の pid に限られ `ASFW_ANY` を使わない |
| BG-6 遅延と再起動 | provider を呼出し前・呼出し中・呼出し後の確認前で停止させる。Stop を伴わない実行中の `input_timeout_unconfirmed` で K-1 の隔離が作られ、その後の receipt による Stop で隔離が消えない（K-3）。helper 終了、Main 再起動を行い対象の隔離と世代失効を検証する。provider を後で解放し、遅延効果が起こり得ることと二重入力がないことを確認する。隔離のストアに書けないときは入力が出ない |
| BG-7 承認 UI | 背景 / 前面の経路表示、supervised の操作ごとの確認、二枚カード（背景では前面化 API が 0 回）、trusted activation、期限・拒否・Stop、Tab / click、キー継続、light / dark、loading / error / disabled を確認する。別アプリ入力中の出現では承認も focus 移動も起こらない |
| BG-8 回帰と非対応 | 前面セッションの focus 喪失拒否と連続入力、危険面・E1 / E4 拒否、旧 helper / 未知能力の gate 閉鎖と今の前面セッションの維持、監視の失明（hook の外れ、心拍の欠落）での gate 閉鎖、macOS の既存承認契約を境界試験で維持する。未確認 provider が背景能力ありと表示されない |

計測はテスト用の受動 observer による foreground WinEvent、cursor 位置のイベント記録と補助 sampling、製品の API attempt カウンタ、fixture の入力回数・効果を相関させる。観測器は入力を生成しない。event 欠落や計測不足があれば BLOCKED とし、sampling だけで一瞬の移動がなかったと断定しない。最小 metadata と合成 fixture の結果だけを証拠に残す。provider の非活性化特性は OS・アプリ / provider 版・control・pattern ごとに記録し、対応表へ反映する。

実機記録は build / SHA、Windows 版、DPI・monitor 構成、仮想デスクトップの構成、fixture / provider 版、操作、期待値、実測値、動画・計測 artifact、各ケースの PASS / FAIL / SKIP / BLOCKED を含める。UI 操作を内部 IPC・DOM・shell スクリプトで代替しない。native fixture や受動計測は補助証拠である。実 Provider 課金は本受入に不要である。

**代案・理由**: screenshot の前後比較だけ、CI の成功だけ、helper のログだけでは AC-6 のユーザー操作を証明できない。実操作と連続する受動証拠を組み合わせる。

**N9 で作るもの**: 上記 fixture / observer、直接関連の Vitest と Windows native seam、既存 Computer Use チェックリストへのケース追加、対応表の実機証拠を作る。実装時は回帰テストの RED → GREEN を記録する。本 ADR では作成も実行もしていない。

## 3. N9 の実装スライス

全スライスは本 ADR のオーナー承認と N8 の後である。Main の接続は N8-4、UI は N8-6 の後に置く。semantic の入力を開くスライスは、N3 に §2.5 の K-1〜K-4 が入った後である。分割後のコード位置と正式な wire 名は実装時に照合する。背景能力の gate は最後のスライスまで本番で閉じる。各 PR は一つの境界をレビューできる大きさにし、対象 typecheck と直接関連テストを通し、後続 PR の存在を合格条件にしない。

| # | PR の単位・成果 | 依存 | 試験 |
| --- | --- | --- | --- |
| N9-1 | 契約: `inputPath` の三値、セッションの形、能力宣言と対応表の版、authority の拡張（interaction epoch と内容の指紋は欄だけを予約し、値は N9-2 / N9-3 が入れるまで固定の「無し」で背景能力を閉じる）、監査の `inputPath` 欄と `computerUseActionRoute` の semantic scroll。native / TS / schema / fixture の一体変更。旧 helper を閉じる | 本 ADR 承認、N8-4 | 経路差替え、未知欄・版、replay、旧 ticket / 世代、ordinary と承認の取り違え、route と `inputPath` の対応。macOS 契約の維持 |
| N9-2 | native の背景の観測と検証: 背景 start / resume / observe、window / dialog / root / ancestor / 内容の指紋の検証、index 由来の proxy の判定、仮想デスクトップ・cloak、背景の capture（最初に遮蔽窓の capture の成否を実機で確認）。入力能力は未公開 | N9-1 | 前面化 API 0、BG-4 の入力前拒否、対象由来の観測と classifier、focused 欄の欠落の扱い |
| N9-3 | 入力所属の監視と通知: 専用の message pump、低レベル mouse hook（Q8 の判断に従う）、WinEvent、生存確認、interaction epoch、native → Main の event frame（C++ / TS の MessageType の一致）、Main の pause・失効・cancel の接続 | N9-2 | BG-3 の入力前拒否、hook の外れ・心拍の欠落、event の欠落・順序、cancel と claim の競合 |
| N9-4 | semantic executor と semantic scroll、§2.1 の完了と読み直し、台帳への記録（`inputPath`）と K-1 の隔離の契機、未知効果・世代失効。試験用 gate のみ | N9-3、N3（K-1〜K-4 を含む） | pattern 全件の正負例、同値 no-op、最後の検証後の変更、呼出し失敗・遅延・Main 再起動、BG-6、二重発行 0 |
| N9-5 | Main の承認と引渡しの接続: V1 カードと native カードの経路別の復帰、背景の再観測・ticket 交換・dispatch、前面引渡し intent と消費、`AllowSetForegroundWindow`（addon と Main）、`approval_round_trip` | N9-4、N8-4 | BG-5 の境界部分、カード中の takeover、期限・Stop・旧世代、経路変更による失効、発行後 fallback 0、二枚カードの前面化 API 0 |
| N9-6 | Renderer の UI: 背景 / 前面の経路表示、引渡しカード、残余リスクの表示 | N9-5、N8-6 | BG-7、Renderer interaction / activation |
| N9-7 | 実機対応表の確定、受動 observer とチェックリストの受入、能力 gate の接続 | N9-6 | BG-1〜BG-8 の境界試験と Windows Computer Use。前面・cursor 不変の artifact、未対応の fail-closed。根拠が揃った組だけを公開候補とする |

N9-7 の合格をブラウザ・Explorer の有効化や release の許可と解釈しない。実機の証拠不足は BLOCKED として残し、gate を閉じた状態で引き渡す。

## 4. オーナーに判断してもらうこと

D-6 の計画への採用、AC-6、UIA 優先、N8 の後という順序、「focus が変わったら止める」不変条件を N9a の設計で置き換えることは既決事項である。次の各項目は一つずつ判断する。

1. §2.1 の pattern ごとの背景入力範囲（Invoke、Toggle、SelectionItem.Select、Value.SetValue、ExpandCollapse）を採用するか。
2. §2.1 の semantic scroll（ScrollPattern）を、座標 wheel とは別の新しい背景入力として N9 に含めるか。
3. 背景能力を実機確認済みの provider・control・pattern の組に限り、版付き対応表で開く方針を採用するか。
4. §2.2 の対象・祖先・内容の指紋・経路・世代への束縛を、背景経路の前面確認の代わりとするか（index 由来の runtime id の proxy を背景能力なしとすることを含む）。
5. §2.1 の三値の `inputPath` とセッションの形を採用し、前面セッションでは今どおり連続入力と focus 喪失の pause を保つか。
6. §2.3 の、対象（対象プロセスの任意の top-level window を含む）が前面になるだけで takeover とする保守的な定義を採用するか。
7. 背景セッションで、別アプリでの通常入力は継続し、所属不明なら停止する方針を採用するか。
8. 入力所属の監視に、大域の低レベル mouse hook（`WH_MOUSE_LL`）を採用するか。推奨は「採用する。背景セッションがある間だけ専用スレッドに入れ、キーボード hook は使わず、metadata だけを記録する」である。理由は、前面化を伴わない非アクティブ窓への wheel・pointer 操作を WinEvent だけでは検出できないためである。採用しない場合は、非アクティブ窓への pointer 操作を takeover として検出できないことを残余リスクとして受け入れることになる。hook はセキュリティ製品に監視として検出されうること、全 mouse 入力の metadata を helper が受け取ることが欠点である。
9. §2.4 の、入力前の能力不足と前面だけの操作に限る人の明示的な前面引渡しを採用するか（背景から前面へ製品が自動で前面化しない）。
10. 引渡しの単位を、推奨の「引渡しの後は前面セッションの区間とする」案にするか、「一操作で前面入力の権限を消費し、次の前面入力にも引渡しを求める」案にするか（§2.4 の推奨の理由を参照）。
11. §2.4 の `approval_round_trip`（Sprint Coder の窓だけへの往復を、カードの期限内に限り許し、復帰後に再検証する）を採用するか。
12. §2.6 の、背景承認後の refocus を、V1 カードと native カードの両方で同じ対象への背景再観測に置き換える案を採用するか。
13. §2.5 の kill-stop への追加要求 K-1〜K-4 を N3 の範囲に入れ、それが入るまで背景入力を公開しないことを承認するか。
14. 次の残余リスクを受け入れるか。前提は、K-1〜K-4 が N3 に入り、隔離と表示が働くことである。(a) 隔離は新しい入力を止めるだけで、発行済みの UIA 呼出しは人の takeover / Stop の後にも対象で実行されうる。(b) completed で返った Invoke の後の非同期の効果は隔離されない（今の前面の semantic Invoke と同じ。kill-stop ADR §5 の 2）。(c) OS の event と provider 呼出しの間に原子性はなく、takeover と同時の一操作は残りうる。(d) 照合できない対象の隔離は、承認カードで再開するまで再起動をまたいで続く。(e) 前面化（K-4）が遅れて効いた場合、人のキー入力が対象へ届きうる。
15. §2.7 の実機受入と連続する受動証拠を公開の条件とするか。
16. §3 の PR 分割と依存（N8-4 / N8-6 の後、N9-4 は N3 の K-1〜K-4 の後）を採用するか。

### 4.1 承認後の既存 ADR への反映

今回は既存 ADR を変更しない。承認後の別変更で、次を反映する。設計承認、実装、実機受入、公開の状態を混同しない。

- V2 ADR: T5・冒頭の入力前後再検証を経路別にし、user takeover の定義へ §2.3 を接続する。§3.6 の拒否と D14 の非自動フォーカス、`frontmost` 非公開は維持し、D14 の目的が背景から前面への自動前面化にも及ぶこと（§2.4）を追記する。
- V2 ADR §8 の表の「入力前後の identity / focus / geometry / 観測鮮度 / cancel epoch 再検証」の行（「変更禁止。deny class 再判定を追加するだけ」）: 背景経路に限り、focus の再検証を §2.2 の束縛で置き換えることを、Q4・Q5 の承認を根拠に条件つきの置換えとして書く。前面セッションの行の内容は変えない。
- 承認経路 ADR: §2.2 の focus 再検証・対象への復帰を、背景経路では §2.2 / §2.6、前面セッションでは §2.4 の `approval_round_trip` に置き換え、§2.7 の停止・世代と §2.8 の表示へ接点を追記する。
- kill-stop ADR: §2.1、§2.2、§2.3、§5 の 2 に、§2.5 の K-1〜K-4（実行中の隔離の入口、隔離の効く範囲、receipt で確定した背景の効果未確認の行を消さない例外、台帳の `inputPath` の列と前面化の種類）を追記し、§4 の S2（N3）の範囲と試験に加える。Q13 の承認が前提である。

## 5. 現コードとの対応と未確認事項

| 項目 | 本 ADR の記述 | 現コードの根拠 |
| --- | --- | --- |
| semantic 入力 | §2.1 の五つの既存 pattern、前面での UIA 呼出し | `native/computer_use_windows_host.cc:9408`、`:9445`、`:9470`、`:9499`、`:9528`、`:9556`、`:10454`、`:10459` |
| 完了と未確認の code | §2.1 の Invoke の完了、`unknown_effect` の対応 | 同 `:9564`、`:9570`、`:9683`、`:10461` |
| UIA の timeout | §2.5 の bounded automation | 同 `:7254`、`:7255` |
| scroll | §2.1 の現行 scroll は座標 wheel | 同 `:10327`、`:10363`、`:10391`、`:10403` |
| start / resume | §2.1 の前面化 | 同 `:5652`、`:6140` |
| 監査の route | §2.1 の `inputPath` との区別 | `main/computer-use-action.ts:12`、`main/computer-use-controller.ts:5181`、`:5451` |
| foreground の依存 | §2.2 の session / dialog / target 検証 | `native/computer_use_windows_host.cc:3578`、`:3584`、`:3622`、`:3689`、`:7079`、`:8246`、`:9798`、`:9803` |
| 可視の判定 | §2.1 の仮想デスクトップ・cloak | 同 `:8247`（`IsWindowVisible` だけ。`DWMWA_CLOAKED`・`IVirtualDesktopManager` は 0 件） |
| 観測の前面依存 | §2.2 の 4・5 の背景の capture と focused 欄 | 同 `:7607`、`:8081`、`:11140`、`:11151`、`:11164`、`:3824` |
| 要素束縛 | §2.2 の 3 の署名、探索と照合、内容の指紋の欠如 | 同 `:8983`、`:9090`、`:9330`、`:9418` |
| revision と再分類 | §2.2 の入力前検証 | 同 `:9925`、`:9947` |
| takeover | §2.3 の controller は paused を通知 | `main/computer-use-controller.ts:4516` |
| 通知路と epoch | §2.3 の event frame と epoch の所有 | `main/computer-use-native-protocol.ts:13`、`main/computer-use-native-windows.ts:906`、`:942`、`main/computer-use-controller.ts:3918`、`:3028`、`:3526`、`:3597`、`:3889`、`main/computer-use-windows-transport.test.ts:2518` |
| 入力監視・前面の許可 | §2.3 の hook、§2.4 の `AllowSetForegroundWindow` | `apps/desktop/computer-use-native` と `apps/desktop/src` で `SetWindowsHookEx`・`WH_MOUSE_LL`・`AllowSetForegroundWindow` は 0 件 |
| 入力と不明結果 | §2.4 / §2.5 の accepted と in-flight | `native/computer_use_windows_host.cc:8644`、`:9564`、`:9683`、`:10220` |
| SendInput | §2.4 の前面を必要とする経路 | 同 `:9820`、`:10289` |
| 承認後の復帰 | §2.4 の承認の往復、§2.6 の経路別の復帰 | `main/computer-use-controller.ts:3762`、`:3819`、`:3831`、`:5148`、`native/computer_use_windows_host.cc:6140` |
| 承認 | §2.6 の交換・dispatch・例外時の未確認 | `main/computer-use-controller.ts:5213`、`:5244`、`:5254` |
| 試験 | §2.7 の既存境界試験 | `main/computer-use-windows-input-seam.test.ts:29`、`main/computer-use-windows-ticket-seam.test.ts:873` |

本 Draft のコードについての記述は上記 base の読取りで確認した。kill-stop ADR の記述は origin/main（`0edfc6e1`）の版の読取りで確認した。背景操作の実装、native build、実機試験は行っていない。次は未確認であり、N9 の公開前に確認する: provider の副作用、遮蔽窓の Windows Graphics Capture の成否、index 由来の runtime id の判定方法、入力監視の遅延・欠落の検出の実効性、キー入力が前面の対象にしか届かないという前提（強い推定）、`AllowSetForegroundWindow` を Main の addon から呼ぶ形（強い推定）、K-1〜K-4 が N3 に入ること。OS の event と provider 呼出しの間に原子性はなく、悪意ある provider の内部動作を UIA から制限できるとは主張しない。

独立した敵対的レビュー、PR、Review BOT、要塞レビュー、オーナーの設計承認は親の工程である。
