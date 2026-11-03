# ADR: Computer Use Windows — UIA による背景入力と対象の再検証

- Status: Accepted（N9a の設計。2026-11-03 N9 P0 で整合を反映。実装・実機受入・公開の完了を意味しない）
- Date: 2026-11-02
- Issue: #994（Refs #988, #500）
- 関連: `tasks/designs/adr-computer-use-agent-driven-v2.md`（以下、V2 ADR）T5、§3.6、§5 の user takeover、§6.1 D14、§8 の不変条件、`frontmost` を返さない契約
- 関連: `tasks/designs/adr-computer-use-windows-approval-path-20261102.md`（以下、承認経路 ADR）§2.2、§2.3、§2.7、§2.8。N8-1〜N8-6 は main に反映済み
- 関連: `tasks/designs/adr-computer-use-windows-kill-stop-20261102.md`（以下、kill-stop ADR）。Accepted。K-1〜K-5 は §2.2・§2.3 に統合済み
- 実装状況（2026-11-03）: N3 PR1〜PR9・N8-1〜N8-6 は main、N3 PR10・PR11 は作業中。背景入力の公開は N3 の有効化後の §5.1 P8 だけで行う
- 旧コードの照合基準: `3c9318750e76db23ef6c5ab1d40ad957b0a8e236`。以下の `native/` は `apps/desktop/computer-use-native/`、`main/` は `apps/desktop/src/main/` の略記である。行番号はこの旧版を指す。「現状」のコード説明は設計時の比較資料であり、現在の実装状況は上記と §5 を参照する

## 1. 問題と範囲

#988 D-6 は背景操作を計画に含め、「focus が変わったら止める」という今の不変条件を N9a の設計で置き換えることを決定した。AC-6 は「UIA で直接押せる操作は、対象を前面に出さず、ユーザーのカーソルも動かさずに行う」である。#988 の N9 の方針は「UIA の pattern を先に使い、使えないときだけ前面に出して SendInput を使う」である。本 ADR はその設計を定める。設計の決定と実装・実機受入・公開の状態を分けて扱う。

現行の Windows は UIA pattern を使う入力でも前面を要求する。前面確認だけを削除すると、観測・ダイアログ選択・承認後の復帰が前面に依存したままになり、別の要素への入力や承認の使い回しを招く。本 ADR は入力経路を三つに分け、対象に束縛した背景の UIA 呼出しと、前面を必要とする UIA 呼出し・SendInput を定義する。

成果は、N9 が入力範囲、再検証、takeover、切替、Stop・承認との接点を実装できる設計である。P0 の変更は本 ADR と kill-stop ADR の背景入力に関わる段落だけである。承認経路そのもの（N8）、Stop の土台（N2〜N5）、ブラウザ・Explorer の有効化（N11）、macOS は対象外である。ただし §2.5 は、背景経路のために N3 に統合済みの kill-stop 契約との接続を定める。T5（別アプリへの入力の誤配を防ぐ）の目的、deny class、危険面、セキュア欄、§3.6 の実行トリガ拒否は緩めない。

正しさは、現コードとの対応表、状態遷移ごとの拒否条件、N9 の境界テストと Windows 実機受入の定義によって確認する。この文書作成を実機 PASS と扱わない。

## 2. 決定

**保存先の読み替え（2026-11-03）**: K-1・K-3 の「SQLite のストア」は、kill-stop ADR §2.2 の 5 で採用した B（Windows の SID ごとの LocalAppData の共通 SQLite）を指す。台帳は instanceId ごと、対象の隔離は共有し、移管は原子的に行い、最初にコミットされた理由を保持する。

### 2.1 入力経路とセッションの形

**現状**: `native/computer_use_windows_host.cc:9408` の semantic worker は Invoke、Value、SelectionItem、Toggle、ExpandCollapse を処理する（各呼出しは `:9445`、`:9470`、`:9499`、`:9528`、`:9556`）。`:10454` はこれらを dispatch し、`:10459` の後検証（`RevalidateWindowsTarget`、`:9803` で前面を要求）を通れば completed とする。つまり今の semantic 入力は「前面での UIA pattern の呼出し」である。scroll は `:10327` の座標入力であり、`:10363` でカーソルを動かし、`:10391` / `:10403` で wheel を送る。ScrollPattern の背景入力はこの分岐にはない。開始と再開は、対象が前面でなければ `:5652` / `:6140` で `SetForegroundWindow` を呼ぶ。現行のセッションは「開始時に前面に出し、前面での UIA 呼出しと SendInput を続けて送る」形である。監査には `main/computer-use-action.ts:12` の `computerUseActionRoute`（`'semantic' | 'visual' | 'none'`、操作の種類からの分類）が `main/computer-use-controller.ts:5181` / `:5451` で route として記録される。

**決めること・推奨案**: 入力ごとの経路を、次の三値の `inputPath`（N9 の新しい内部契約の名前）に native が固定する。モデルから経路を指定して検査を省くことはできない。

| inputPath | 内容 | 使えるセッション |
| --- | --- | --- |
| `background_semantic` | 対象を前面に出さず、§2.2 の束縛で検証した要素の UIA pattern を呼ぶ | 背景セッションだけ |
| `foreground_semantic` | 今の semantic 入力と同じ。前面を検証して UIA pattern を呼ぶ | 前面セッションだけ |
| `foreground_input` | 今の SendInput の入力と同じ。前面・focus・geometry を検証して送る | 前面セッションだけ |

セッションは次の二つの形のどちらかにある。形は native が測定し、Main が状態として持つ。

- **背景セッション**: 対象が前面でなく、背景能力がある対象で始める。開始の判定は**対象の単位**で行う。対象の窓が下記の背景対象の条件を満たし、対象の provider の種別（とアプリの identity・版）について下記の対応表に背景能力のある組が一組以上載っていれば、背景セッションで始められる。操作ごとの判定（その要素・control・pattern の組が対応表にあり、§2.2 の束縛が成り立つか）はこれとは別に、入力のたびに行う。開始・再開は前面化しない。使えるのは `background_semantic` だけである。他の経路が要る操作は §2.4 の `awaiting_foreground_handoff` へ移る。
- **前面セッション**: 今の形を保つ。前面での UIA 呼出し（`foreground_semantic`）と SendInput（`foreground_input`）を続けて送ってよく、focus の喪失は今どおり pause である（§2.4 の承認の往復だけを例外とする）。#988 の方針どおり、pattern がある操作は `foreground_semantic` を先に使い、使えない操作だけ `foreground_input` にする。

前面セッションになるのは、(a) 開始時に対象がすでに前面にある場合（人が前面にしたものであり、製品は focus を変えない）、(b) 背景セッションから §2.4 の人の引渡しを経た場合、(c) 背景能力の gate が閉じている場合（旧 helper、能力宣言の欠落・版不一致）だけである。(c) は今の挙動そのものであり、gate が閉じている間は開始時の自動前面化（`:5652` / `:6140`）も今のまま残す。gate が開いた後に、前面でもなく背景能力も無い対象を開始する場合は、背景セッションにはできない（背景セッションは背景能力のある対象でしか始めない）。この場合は**開始を拒否する**（理由は前面が要ることを示す値にし、名前は N9-1 で決める）。この拒否の対象は、人の Start・quick start・startForAgent を含むすべての新しい開始である。人が押した §2.4 の引渡し、§2.4 の承認の往復の復帰、人による前面セッションの再開の前面化（今の `resume`（`main/computer-use-controller.ts:2948`）と承認後の `refocusAndReobserve` が呼ぶ `startSession` の自動前面化、native の StartWindowsExistingSession（旧 `:6140`））だけは対象外とし、それぞれ trusted activation と §2.4 の条件で守る。StartWindowsNewSession（旧 `:5652`）は例外ではなく、gate 開放後に対象が非前面なら前面化へ到達させない。製品は自動で前面化せず、自動の引渡しカードも出さない。人が対象を自分で前面にしてから開始し直せば、(a) の前面セッションになる。前面セッションとして自動で前面化して始める案は、別アプリで入力中の人のキーを対象へ流す D14 と同じ危険があるので採らない。背景セッションの途中で前面が要る操作になった場合だけが §2.4 の引渡しである。背景セッションへ戻るのは、前面セッションの pause の後に人が再開し、その時点で対象が前面でなく背景能力がある場合だけで、新規観測から始める。

`inputPath` は監査の既存の route とは別の欄とする。route は操作の種類の分類（semantic / visual / none）のまま残し、`inputPath` は実際に通った経路を記録する。route が semantic の操作のうち、pattern 入力の invoke / set_text / select / toggle / expand_collapse は `background_semantic` か `foreground_semantic` になる。同じく route が semantic の copy は対象への入力ではない別の経路（`main/computer-use-controller.ts:4576` の `executeCopy`、native は `:11321` の copy の分岐）で、`inputPath` を持たない。route が visual の操作は `foreground_input`、none（wait / finish）は `inputPath` を持たない。下記の semantic scroll は新しい閉じた操作として route を semantic にし、`computerUseActionRoute` を N9-1 で同時に直す。新しい操作なので、N8 の承認の operation の列挙（承認経路 ADR §2.2 の表と、§3 の N8-1 の classifier の正例との連動試験、N8-2 の strict schema）にも semantic scroll を足す必要がある。この拡張は N9-1 で N8 の契約を拡張する変更として行い、N8 の列挙に無いまま背景で承認しない。kill-stop の既存台帳には背景を `background_semantic`、前面二種を既存の `normal` として対応させる。三値をそのまま保存形式へ追加しない。

背景経路（`background_semantic`）は次表の pattern だけを使い、SetForegroundWindow、ShowWindow による復元、SetFocus、SetCursorPos、SendInput、clipboard paste を一切呼ばない。

| 操作・pattern | 背景で行う条件 | 完了と効果の確認 | 制限 |
| --- | --- | --- | --- |
| Invoke | 一意の対象に InvokePattern があり、効果分類・承認が成立する | 今の前面での semantic Invoke と同じ基準とする（`:9445` の呼出しが成功し、呼出し後の窓の単位の再検証を通れば completed。今は `:10459` の `RevalidateWindowsTarget`、背景では §2.2 の 7 の窓の単位の再検証）。要素の祖先・内容の指紋の照合は呼出し前だけに行い、呼出し後には行わない（Name や兄弟の数を変えるのが Invoke の通常の効果だからである）。これより強い効果の確認（UI 状態の変化の期待値）は要求しない | `unknown_effect` になるのは timeout、error、呼出し後の再検証の失敗のときだけである（下記）。dialog を開く Invoke（保存・開く・設定など）は、窓の単位の再検証の dialog 集合の変化で、背景では毎回 `unknown_effect` と対象の隔離（§2.5 の K-1）になり、続けるには Stop の後に K-5 のカードで新しいセッションを始める必要がある。背景入力の範囲の判断材料として Q1 に書く |
| Toggle | 現在値と希望値を読み、異なる場合だけ Toggle を一度呼ぶ | ToggleState を読み直し、希望値であることを確かめる | Indeterminate、読取り不能、複数回 Toggle が必要な操作は背景実行しない。同値なら入力なしの完了 |
| SelectionItem.Select | 観測した単一要素を Select する。選択集合・効果分類も束縛する | IsSelected を読み直す | AddToSelection / RemoveFromSelection、複数選択への拡張は N9 に含めない |
| Value.SetValue | enabled、書込み可能、非 secure の ValuePattern に全文を一度渡す | 値を読み直し、渡した全文と一致することを native の中で確かめる | 本文をログに出さない。TextPattern を文字入力用の代替としない。Value 不在なら §2.4 の前面入力候補 |
| ExpandCollapse | 現在状態から Expand または Collapse を一度呼ぶ | ExpandCollapseState を読み直す | LeafNode、未確定状態は実行しない。同値なら入力なしの完了。topmost の popup や capture を伴う組は §2.3 のとおり背景能力なしとする |
| Scroll / SetScrollPercent（semantic scroll） | 一意に束縛した scroll container の ScrollPattern に対し、軸・量または到達率を固定する。scrollable、前後の percent / view size と対象範囲を読む | percent を読み直す | 座標 wheel の量を無条件で ScrollAmount に換算しない。要求と semantic の単位が一致しない場合は別の操作として再計画・承認する |
| ScrollItem.ScrollIntoView | N9 では背景入力として公開しない | — | 実現・表示・フォーカスへの副作用を今回確定しない。勝手に Realize / ScrollIntoView を挟まない |
| 座標 click / double_click、key、type、drag、座標 wheel | 背景経路には入れない | — | 前面セッションの `foreground_input` として、前面・対象・focus・geometry の検査を維持する。現行 dispatch の未対応操作を本 ADR だけで追加しない。drag を実装する段でも前面のままとする |
| その他の pattern、任意の UIA メソッド | 許可しない | — | WindowPattern の移動・閉鎖等を背景操作の一般入口にしない |

`unknown_effect` は、今の dispatch が accepted=true で返す効果未確認の code に対応させる。pattern 呼出しの timeout（`:9570` の `input_timeout_unconfirmed`）、呼出しの error（`:9564` の分岐の `input_not_confirmed`）、呼出し後の再検証の失敗（`:10461` の `input_not_confirmed`）、in-flight のまま待ちを打ち切った場合（`:9683` の `semantic_input_in_flight`）である。Toggle / SelectionItem / Value / ExpandCollapse / semantic scroll の読み直しが希望状態でない場合は、呼出し後の再検証の失敗に含める。InvokePattern.Invoke は provider が S_OK を返した後で動作してよい非同期の呼出しであり、completed の Invoke が後から効果を起こす余地は今の前面の semantic Invoke と同じく残る（§2.5、§4 の Q18）。

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
   P2c は通常・承認共通の検証と合成 fixture までを実装し、未知の provider は拒否する。ProviderDescription・runtime ID による実 provider の許可表は P7a/P7b・N13b の実機確認後に接続する。
4. observation revision、action / payload、`inputPath`、pattern、対象署名と内容の指紋、祖先・面・origin、効果、geometry、cancel epoch、Stop serial、helper / ticket generation、§2.3 の interaction epoch を authority に束縛する。観測は背景 window 自体から得る。遮蔽した前面画面の pixel や別アプリの focus chain を分類に流用しない。背景の capture は前面を条件にしない別の入口とし（遮蔽は許し、最小化・cloak は拒否する）、focused element 由来の欄は背景では「欠落」として扱い、focus が動いたとは扱わない。遮蔽された窓の capture（Windows Graphics Capture）が成り立つかは N9-2 の最初に実機で確かめる。成り立たない場合は pixel の無い観測とし、分類に画面が必要なのに対象由来と証明できなければ操作しない。再観測は旧 ticket を失効させる。
   P2b では 4 の pixel の無い観測を後段の契約変更へ分け、背景の画像取得に失敗したら観測そのものを拒否する（前面化・別画面の画像による代替なし）。
5. preflight、承認交換、dispatch の各段で同じ対象から deny class・secure・面・実行トリガを再評価する。背景であることは §3.6 の E1 / E4 拒否や N8 の単発承認を外す理由にならない。N8 の承認の再測定（interlock の visual patch 照合を含む）も 4 の背景の capture を使う。背景の承認の測定はこの capture が成り立つことを前提とする。
6. pattern と必要状態を読み終えた後、呼出し直前に対象・祖先・内容の指紋・geometry と epoch を再検証する。Stop / takeover が更新する取消し状態との同じ claim 境界で、一入力だけを発行する。claim 後に届く取消しを「未送信」に書き換えない。検証中に別の要素へ解決し直して入力しない。
7. 呼出し後は**窓の単位**の再検証を行う。項目は今の `RevalidateWindowsTarget`（`:9798`〜`:9817`）に合わせる。今の項目は、親プロセスの生存、observation の存在、active window と前面の一致、session と要求の cancel epoch、`ValidateWindowsSession` による session の検証、dialog 集合の digest、active window / identity / kind、geometry である。背景ではこのうち前面の一致を 2 の束縛 window の検証に替え、helper / ticket 世代と interaction epoch を加える。要素の祖先・内容の指紋の照合は 6 の呼出し前だけに行い、呼出し後には行わない（Invoke は Name や兄弟の数を変えるのが通常の効果であり、今の前面の semantic 入力も呼出し後に要素を照合しない）。Toggle / SelectionItem / Value / ExpandCollapse / semantic scroll は、これに加えて §2.1 の pattern の状態の読み直しで効果を確かめる。Invoke は §2.1 のとおり、窓の単位の再検証を通れば completed とする。新しい観測を返す。再検証か読み直しに失敗したら `unknown_effect` とする。後検証失敗は巻戻しの証明ではない。

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

native は背景セッションの開始前から、前面の変化（`EVENT_SYSTEM_FOREGROUND`）、対象プロセスの WinEvent、mouse の対象所属を監視し、単調増加の interaction epoch と不明状態を保持する。mouse の所属には低レベル mouse hook（`WH_MOUSE_LL`）を使う案を推奨する。hook は背景セッションがある間だけ、専用の message pump スレッドに入れ、セッションの終了で外す。callback は最小の metadata（時刻、hit target が対象に属するか）だけを記録し、座標の列・他アプリの名前・入力本文を保存しない。自分の注入に付けた目印だけを根拠にユーザー入力を無視しない（背景経路は入力を注入しない）。低レベル mouse hook の採否は §4 の Q10 で問う。

監視の生存は次で確かめ、どれかに失敗したら背景経路を閉じる（新規 claim の gate を閉じ、pause する）。

- **hook の外れ**: 低レベル hook は callback が `LowLevelHooksTimeout` を超えると OS に通知なく外されうる。外れの検出には、mouse hook と独立した**マウス由来の信号**を使う。推奨は、マウスに限った Raw Input（`RIDEV_INPUTSINK`。前面でなくても受けられる）を hook とは別のスレッドで受け、マウスの Raw Input が来たのに対応する hook の event が一定時間内に無ければ失明とみなす案である。代案は、`GetCursorPos` の座標の変化を一定間隔で読み、変化に対応する hook の event が無ければ失明とみなす案である（クリックや wheel だけの入力は拾えない）。`GetLastInputInfo` はキー入力でも進むので、マウスだけの hook との照合に使うと、別アプリでの文字入力のたびに失明と誤判定する。このため `GetLastInputInfo` を失明の単独の根拠にしない。RIDEV_INPUTSINK の登録には hwndTarget を必須とする。message-only window への WM_INPUT 配送と、SendInput 由来のマウスが Raw Input と hook の双方に現れるかは P3b・P7 で実測する。照合の許容時間は実測で決め、未確定なら公開しない。
- **pump の停止・遅延**: hook の message pump スレッドと Raw Input の受信スレッドは、それぞれ一定間隔で自分宛ての心拍を投げ、その到着の遅れを測る。どちらかで上限を超える遅れ、または心拍の欠落があれば、遅延・失明とみなす。間隔と上限は N9-3 の実測で決める。
- **Raw Input の最小 metadata**: Raw Input の受信も hook と同じく最小の metadata だけを扱う。保存・照合に使うのは到着の時刻と件数だけで、座標・移動量・ボタンの状態を保存しない。
- **初期化・再登録の失敗**: hook・Raw Input・WinEvent の登録失敗、スレッドの異常終了。外れた後に再登録できても、それだけで自動再開しない。

観測から最後の claim まで interaction epoch が同じこと、監視が生きていることを検査する。イベント取りこぼしを完全に証明できるとはしない。

**takeover の通知路と epoch の同期**: 今の protocol には native → Main の非同期の通知路が無いので、次を要件とする（N9-3）。

1. 新しい非要求の event frame（名前は N9-3 で決める）を足す。C++ と TS の MessageType を名前・数値で一致させ（`main/computer-use-windows-transport.test.ts:2518` の完全一致の試験に載せる）、helperGeneration・sessionId・単調増加の event 番号に束縛する。event の種類は二つである。(i) 背景セッションの takeover（理由と、その時点の interaction epoch だけを運ぶ）。(ii) 前面セッションの `approval_round_trip` 中の前面の移動（§2.4。往復の id と、移った先が「対象とその owned window」「Sprint Coder の窓」「その他」のどれかと、前面の変化の番号だけを運び、窓の名前・HWND・PID は運ばない。判定は native が行い、Sprint Coder の窓の特定に要る値は Main が往復の開始のときに渡す）。
2. native は takeover を検出したら、Main を待たずに自分の claim gate を閉じ、interaction epoch を進めてから event を送る。**native は cancel epoch を自分で進めない。** cancel epoch の所有は今どおり Main だけとし、interaction epoch は native だけが進める別の値とする。
3. Main は takeover の event を受けたら、`cancelPendingApprovals`、ordinary ticket と execution ticket の失効、paused の emit（pause の理由つき）を行い、cancel（`cancelEpoch + 1`）を送る。今の pause（`main/computer-use-controller.ts:4516` の `userTakeover`）は状態を paused にして emit するだけで cancel を送らず、今の cancel は、Stop（`:3597` の `completeStop`）、開始待ちの Stop（`:3526`）、中断された再開（`:3028` の `resume`）と承認後の復帰（`:3889` の `cleanupAbandonedRefocus`）の後始末から、どれも close とともに送られる。したがって、close を伴わない「pause のための cancel」は新しい経路として N9-3 で作る。この cancel は session を閉じず、native の claim gate と取消し状態を Main の epoch に揃えるためのものである。人の再開のときは、Main が持つ進めた後の cancel epoch をそのまま使い、新規観測をその epoch で取り直す（旧 epoch に戻さない。旧 epoch の要求・ticket は失効したままである）。interaction epoch は再開の新規観測の時点の値を新しい束縛にする。
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

**引渡しの単位**: 引渡しの後の前面セッションで、前面入力を何回まで許すかは §4 の Q12 で問う。推奨は「引渡しの後は前面セッションの区間とする」案である。引渡しの後は今の前面セッションと同じく連続入力を許し、focus の喪失（承認の往復を除く）で pause、背景へ戻るのは人の再開と新規観測による。理由は次のとおりである。(a) #988 の方針は「使えないときだけ前面に出して SendInput」であり、操作ごとの人の引渡しまでは求めていない。(b) `type` は 1 dispatch で 1 Unicode scalar なので（承認経路 ADR §2.2 の 8、kill-stop ADR §2.4）、操作ごとの引渡しは文字ごとのカードになる。(c) 前面セッションの安全（T5）は、今どおり前面・focused element の検証と focus 喪失の pause が担い、引渡しの回数に依存しない。(d) D14 が求めるのは自動で focus を奪わないことであり、人が一度引き渡した後の各操作に再同意を求めるものではない。対案は「一操作の完了で前面入力の権限を消費し、次の前面入力にも引渡しを求める」案で、人の関与は強まるが、上記 (b) の負担と #988 の方針より重いことが欠点である。

二枚カードでは、V1 の Returned から再観測に束縛した native offer が成立した時点で一枚目を正常終端とし、id を使用済みとして保持する。入力は許さず、次のカードは新しい id で Begin する（終端後の Sprint Coder への移動は第三の窓にしない）。
往復中の preflight の replay・binding denied・offer 拒否・interlock 拒否など、ordinary 交換または native offer の正常終端以外は失敗保持し、自動再承認しない。

**承認の往復**: 前面セッションで N8 のカード（supervised の操作ごとの確認、E2 / E3、二枚カード）が要る操作では、人はカードを操作するために Sprint Coder へ移り、承認後は対象へ戻る必要がある。この往復を、通常の focus の喪失と区別する次の状態 `approval_round_trip` として定義する。

- 入る条件と要求: その操作の承認カードが pending になった時点で、Main が native に往復の開始を新しい要求で伝える。V1 カードの間は Main から native への要求が今は無いので、既存の要求には載せない。往復の開始の要求は、往復の id（Main が発行し、session・Task・Turn・helper 世代・cancel epoch に束縛する）、Sprint Coder の窓の特定に要る値、60 秒以下の長さ（duration。native が開始要求を受信した時点から自身の単調時計で計測し、プロセス間の絶対時刻は渡さない）を運ぶ。往復の終わり（承認・拒否・期限・Stop）も同じ id を持つ新しい要求で伝える。名前と形は N9-1 の契約で決める。native はこの id で往復を識別し、id の違う終わりの要求・復帰の指示を拒否する。native の開始受理の応答を Main が得た後だけ、前面が対象から Sprint Coder の窓へ移るのは、往復の中の許す移動である。
- Sprint Coder の窓の特定: 窓の所有プロセスの PID と、そのプロセスの作成時刻・実行中の image identity で特定し、窓のタイトルや表示文字列では判定しない。Main は往復の開始のときに、自分のプロセスの PID・作成時刻・image identity を native に渡す（この値は Main と native の外に出さない。V2 ADR §8 の「PID を Main/native の外に出さない」と同じ）。
- 監視と受け渡し: 前面の移動の判定は native が行う。native は §2.3 と同じ前面の変化の監視（`EVENT_SYSTEM_FOREGROUND`）で、移った先を「対象とその owned window」「Sprint Coder の窓」「その他」の三つに分け、§2.3 の event frame の (ii) で Main に伝える。Main は「その他」を受けたら下の第三の窓の扱いにする。native は「その他」を検出したら、Main を待たずにその往復の失敗を自分で保持し、その往復の id による復帰の前面化の指示と、ticket の交換（approvalApprove）を拒否する。このため、event frame の (ii) の「その他」が Main に届かなかった・遅れた場合も、入力は出ない。開始受理前の前面の移動は、今どおり前面セッションの focus の喪失である。
- 許す窓: 対象（とその owned window）と Sprint Coder の窓だけである。この状態の間は入力の claim を閉じる。第三の窓へ前面が移ったら、通常の focus の喪失として pause し、カードを失効させる。File Explorer のフォルダの窓とデスクトップも第三の窓であり、pause する。往復の間に拒否した入力は、往復が終わった後も旧 ticket・旧 observation で再実行しない。往復の後の入力は、復帰の後の新しい観測と、そこから得た ticket だけで行う。
- 往復の間に生きている規則: 往復は前面セッションの中の状態である。前面セッションでは §2.3 の背景セッションの監視（低レベル mouse hook、interaction epoch）を動かさず、takeover は今どおり focus の喪失・dialog の変化・対象の変更・Stop・世代失効で扱う。往復が例外にするのは、Sprint Coder の窓への前面の移動と、それによる下の focus の喪失の検知だけである。それ以外の規則（対象 PID の別 top-level を含む第三の窓、対象の変更・新しい dialog、自分の呼出しに対応しない対象 WinEvent、Stop、世代失効、カードの期限）は往復の間も生きている。前面往復中も EVENT_SYSTEM_FOREGROUND と対象 WinEvent の監視を動かし、登録の成否と message pump の心拍を検査する。登録失敗・心拍欠落は native が往復の失敗として保持し、自動再開しない。背景用 mouse hook・interaction epoch は導入しない。
- 往復の間の native の focus の喪失の扱い: 前面セッションの native は、今は前面が対象でも対象の dialog でもないことを dialog 集合の取得で `focus_required`（`native/computer_use_windows_host.cc:3599`）として検知し、入力を拒否する。往復の間、Sprint Coder の窓への移動によるこの検知は、入力の拒否（claim を閉じたまま）にとどめ、claim gate を takeover として閉じる処理を起こさない（前面セッションに interaction epoch は無い）。第三の窓への移動、期限切れは pause にする。
- 対象が最大化されていてカードが背後に出た場合: カードは showInactive で出るので、対象の背後に隠れうる。人がタスクバーの点滅などからシェルを前面にせず直接 Sprint Coder へ移る場合だけ、許す移動である。シェル経由は例外が確定するまで pause する。カードに届くまでの間も往復の状態にあり、claim は閉じたまま、時間はカードの期限で数える。タスクバーの click でシェルの窓が一時的に前面になる場合を「移動の途中」として許す例外は、**未確定事項**とする。N9-5 の実機確認で、その窓を窓の class（`Shell_TrayWnd` など）とプロセス（PID と image identity）の組で特定できると確かめるまでは、シェルの窓も「その他」として pause する（fail-closed）。確かめた後に例外を開くかは、その結果とともに改めて決める。Sprint Coder を前面にする操作の途中で第三の窓（タスクバーの一覧から選んだ別アプリなど）が前面になれば pause する。
- 時間の上限: native カードではそのカードの期限（native の単調時計で最大 60 秒の intent の残り。承認経路 ADR §2.2 の 3）とする。二枚カードの 1 枚目の V1 カードは、今の期限が 60 分（`main/computer-use-controller.ts:4466` の `expiresAt`、`:4502` の timer）で native の intent を持たないので、V1 カードの往復の上限は往復の開始から 60 秒に固定し、往復の開始の要求で native に渡す。期限・拒否・Stop・世代失効で往復を失敗として保持し、pause する。V1 の往復が 60 秒で期限切れになったら Main は cancelPendingApprovals でカード本体も失効させ、既存の 60 分の timer で生き残らせない。P3c は 60 秒での native の失敗保持・復帰拒否・交換拒否を試験で固定する。RT_v1_timeout_cancels_pending_card のカード本体の失効（Main の cancelPendingApprovals）は P3d の受入条件とする。native カードの duration は intent の残時間以下とする。二枚カードでは往復が二回起こりうる。それぞれが同じ条件を満たす必要がある。
- 対象への復帰: trusted activation を Main が消費した後だけ、上記と同じく helper の pid に `AllowSetForegroundWindow` を一度許して対象へ戻す（`refocusAndReobserve` に当たる）。復帰の startSession（existing）と approvalApprove にも往復 id を必須とし、native は欠落・不一致・終了済み・失敗保持の id を拒否する。有効な往復 id による復帰だけを許し、往復中または失敗後の通常の前面化 startSession は id の有無によらず拒否する。失敗保持は人の再開まで続ける。戻った後、identity（PID + 作成時刻）、HWND、geometry、dialog 集合、要素の署名と内容の指紋、cancel epoch、Stop serial、helper 世代を再検証し（前面セッションは interaction epoch を持たないので、復帰の再検証には入れない）、新しい観測と再分類が承認した内容と一致する場合だけ execution ticket へ進む。不一致は再承認を自動発行せず拒否する。exchange 後に observe / refocus を挟まない制約（承認経路 ADR §2.2 の 5）は維持する。
- 終了の順序: 正常時は、生きた往復 id で復帰・再観測・再分類・承認交換を行い、その後に end を送る。先に end を成功させて終了済み id で復帰しない。失敗保持した id への end は失敗を返し、保持を消さない。Main は失敗を受けたら pause しカードを失効させる。end 先着でも既存 startSession の迂回を許さない。P3c の境界は「復帰 → 新観測・再分類 → 新 ticket への交換 → end → 一回の dispatch」とする。end は交換後だけ成功し、交換後から dispatch 完了までは observe / refocus を拒否する。end は ticket の既存の期限や一回限りの消費条件を延長しない。失敗保持した session の通常の existing start / resume では解除せず、人の復旧では session を close して新規開始する。往復中の claim 禁止、旧 ticket 再利用禁止、交換後の observe / refocus 禁止は維持する。
- 背景セッションのカードは、Sprint Coder への移動が §2.3 の表の 1 行目の「無関係な通常アプリ」に当たるので往復の状態は要らない。承認後に対象を前面化せず、§2.6 の背景の再観測で進める。

対象を前面に出すこと自体も取消しと競合する control intent として記録する（§2.5 の K-4）。引渡し中の Stop は未消費の許可を失効させる。すでに前面化を発行した場合の結果は記録するが、ユーザーの focus を復元する追加操作はしない。

**代案・理由**: 失敗ごとに自動で前面化する案は D14 の目的に反し、遅延 UIA と二重実行になる。fallback を全廃する案は #988 N9 の方針を満たさない。前面化の後の focus の移動を一律に pause にする案は、承認カードの操作のための往復で止まり、承認が要る前面入力を完了できない。入力前の能力不足だけを人の引渡し付きで切り替え、承認の往復は窓・時間・再検証で限定して許す案を推奨する。

**N9 で作るもの**: 入力前拒否と発行後不明の型、引渡し intent / UI / 消費、`AllowSetForegroundWindow` の付与と前面化の成否の測定、経路変更時の ticket 破棄・再観測・再承認、`approval_round_trip` の状態と復帰の再検証、前面セッションへの明示遷移を作る。semantic と物理入力が同じ効果であると測定できない場合は、元要求の fallback ではなく新規の操作要求として扱う。

### 2.5 取り消せない UIA 呼出しと kill-stop への追加要求

**現状（コード）**: `native/computer_use_windows_host.cc:8644` の InvokeWindowsSemanticInput が semantic 入力を扱い、`:9683` は ever_claimed / input_in_flight から未確認を区別する。`:10220` は semantic 入力が in-flight の間、新しい dispatch を拒否する。UIA は bounded automation で作られ、transaction timeout は 300 ms、connection timeout は 500 ms である（`:7255`、`:7254`）。pattern 呼出しの timeout は `:9570` で `input_timeout_unconfirmed` になる。

**kill-stop ADR との接続**: K-1〜K-5 は同 ADR §2.2・§2.3 に統合済みで、N3 PR1〜PR9 は main にある。実行中の背景の応答消失・効果未確認・takeover 競合は隔離し（K-1）、同一対象への全入力経路を拒否する（K-2）。正常な receipt でも背景の未確認行は同一 transaction で隔離へ移す（K-3）。前面化だけの未確認行は pause するが隔離を作らず（K-4）、receipt Stop 後は K-5 の承認による新しい session だけを許す。前面経路の receipt に隔離が無い説明を背景へ適用しない。N9 は実 dispatch をこの契約へ接続し、N3 PR10・PR11 の有効化後に公開する。

今のコードでは、semantic owner の uncertain は `main/computer-use-native-windows.ts:301` の `markSemanticUncertain` が立てる。呼ぶのは要求の timeout（`:829`）、write の失敗（`:887`、`:896`）、応答の binding の不一致（`:945`）、`semantic_input_in_flight` の error 応答（`:970`）、不正な応答（`:1003`）、`failAll`（`:1009` の中の `:1015`。`abortTransport` は `:1023` で `failAll` を呼ぶ）である。検証済みの close の proof を受けた `confirmSessionClosed`（`:278`）は `:296` で uncertain を false に戻す。kill-stop ADR §2.2 のとおり `pending` と semantic owner は判定の情報源にしてはならない（semantic でない dispatch には残らず、対象の identity も持たない）ので、K-1 の判定の情報源は台帳の行（応答待ち／効果未確認の 2 値）とし、上の出来事は隔離を作る契機としてだけ使う。

**決めること・推奨案**: 背景操作も kill-stop の control 要求として同じ所有・台帳に登録する。新しい「背景専用 Stop」は作らない。次は kill-stop ADR に統合済みの **背景経路の契約** であり、N9 は N3 の台帳・隔離・再開へ接続する。

- **K-1（実行中の隔離の入口）**: `inputPath` が `background_semantic` の台帳の行について、次のどれかが起きたとき、Main は Stop や helper の終了を待たずに、その行の対象（pid + 作成時刻）の隔離を作る。(a) dispatch が accepted=true の効果未確認（`input_timeout_unconfirmed`、`input_not_confirmed`、`semantic_input_in_flight`）で返った。(b) 応答が無いまま、その要求が transport timeout・`failAll`・`abortTransport` で終わった（§2.4 の表の「応答消失」）。(c) その要求で semantic owner が uncertain になった。(d) takeover と claim が競合して結果未確認になった。隔離の行は kill-stop ADR §2.2 の 5 と同じ SQLite のストアに書き、再起動をまたいで保つ。書けなければセッションを pause し、その対象の開始・dispatch を拒否する（fail-closed）。隔離の行は同 §2.2 の 5 の pid・作成時刻・最初に確定した理由と、同 §2.6 の共有 revision の条件に従う。承認時の条件付き解除も同 ADR に従う。
- **K-2（隔離の効く範囲）**: 隔離は startSession・resume・discovery の入口に加え、実行中のセッションのその対象への dispatch・承認交換・前面への引渡しを拒否する。K-1 で隔離したセッションは pause し、Controller の通常の resume（paused のための再開）では再開できない。同じセッションをそのまま再開する経路は作らない。セッションを Stop した後、helper の世代が変わった後なら kill-stop ADR §2.2 の 4 の承認カードでの再開、世代が変わらないまま receipt で Stop した後なら K-5 の新しいセッションの開始による。隔離は PID + 作成時刻の対象プロセスに掛け、同じプロセスの別窓・別 session・前面入力からも迂回できない。
- **K-3（receipt で確定した行を消さない例外）**: `inputPath` が `background_semantic` で、receipt で確定していない応答待ち・効果未確認の行は、検証済みの close receipt で Stop を確定しても消さず、同じ SQLite の transaction で対象の隔離へ移す。`confirmSessionClosed` が semantic owner の uncertain を戻しても、この行の扱いは変わらない。K-1 の隔離の書込みと応答の処理の間に Main が crash した場合も、残った行が起動時に隔離へ移る（kill-stop ADR §2.2 の 5）。
- **K-4（台帳の列と種類、終了時の判定の例外）**: 既存の台帳の経路欄へ背景を `background_semantic`、前面二種を `normal` として記録する。前面への引渡し（helper の `SetForegroundWindow`）も control の種類（前面化）として台帳に記録する。前面化は対象の内容への入力ではなく、win32k の短い呼出しで完了するので、その結果未確認は隔離を作らず pause にする。kill-stop ADR §2.2 の終了時の判定は、応答の無い・効果未確認の行が残る世代を `terminated_target_suspect` として対象を隔離するので、これと食い違わないよう、前面化の種類の行をこの判定と起動時の隔離への移行（同 §2.2 の 5）の対象から除く例外を、kill-stop 側の判定の例外として N3 に入れる。前面化が遅れて効いた場合の残余リスクは Q21 に含める。
- **K-5（Stop の後の新しいセッションの開始での隔離の解除）**: K-1 で隔離した対象について、そのセッションを receipt で Stop した後、同じ対象に新しいセッションを始めるときに、承認カードで対象の隔離を解く経路を足す。同じセッションをそのまま再開はしない。カードは、対象（検証済みのラベル）、隔離の理由（応答消失・効果未確認・takeover との競合の別）、「最後の操作が後から反映される可能性がある」を示し、trusted activation を必須にする。新しいセッションは新しい session id・ticket・cancel epoch で始め、新規観測から始める（背景セッションなら、その時点の interaction epoch を束縛する）。隔離の前の観測・要素参照・ticket・承認 intent は使わない。対象の隔離の行は、このカードの承認で解除する。**K-5 のカードの承認は、client の semantic owner の uncertain / closeCandidate、host の `activeStopQuarantines`、native の in-flight を外す根拠にしない。** 今のコードでは、これらは host 全体の入力を拒否する。client は `hasUnconfirmedSemanticInputs`（`main/computer-use-native-windows.ts:272`）が uncertain・closeCandidate の owner を見て、`assertSemanticAvailable`（`:312`、呼出しは `:554`）で Stop 以外の操作を拒否する。host は `inputQuarantined`（`main/computer-use-native-host.ts:247`）で semantic の未確認と `activeStopQuarantines` を見て入力を拒否する。native は in-flight の間 dispatch を拒否する（`native/computer_use_windows_host.cc:10220`）。client・Host の拒否は kill-stop ADR の receipt・helper 終了による確定条件に従う。native の in-flight は呼出しの終了または helper の終了で解ける。カード承認ではどれも解けず、残る間は dispatch を拒否する。Host の inputQuarantined() が残る間はカード承認自体も拒否する。

隔離の解除は、kill-stop ADR §2.2 の 3（対象の終了の照合）、同 §2.2 の 4（helper の世代が変わった後の承認カードでの再開）、K-5（Stop の後の新しいセッションの開始での承認カード）に従う。人の再開でも、遅延呼出しを消せた保証はない。カードは「最後の操作が後から反映される可能性がある」を示す。単に画面が変わっていない、待ち時間が過ぎたことを解除根拠にしない。helper の終了確認は「helper から新しい入力が出ない」の証拠であり、「対象が最後の操作を実行しない」の証拠ではない。遅い成功 receipt だけで、旧 ticket や旧世代の session を復活させない。

helper 世代の失効では、背景 observation、要素参照、承認の往復、引渡し許可、承認 intent、execution ticket を一括失効させる。再接続後は対象の隔離を検査し、新規観測から始める。旧要求を新 helper へ再送しない。provider が固まったときの期限・helper 終了・台帳の recovery は kill-stop の責務である。N9 は timeout を成功に変換せず、未確認の対象と要求を渡す。

**N9 は、N3 で K-1〜K-5 が入るまで背景入力を公開しない。** 背景能力の gate は、N3 の実装に K-1〜K-5 が入り、その試験が通るまで閉じたままにする。実装済みであることだけでは公開せず、N3 PR10・PR11 の有効化と §5.1 P8 の条件を要する。

completed で返った Invoke の後の非同期の効果（§2.1）は、kill-stop ADR §5 の 2 のとおり隔離されない。これは今の前面の semantic Invoke と同じで、K-1〜K-5 でも変わらない。

**代案・理由**: helper を kill したら再送可能とする案、UIA の HRESULT だけで隔離を解除する案は、遅れて実行される provider 呼出しを見落とす。対象アプリを強制終了する案も、未保存のユーザー作業を失うため採らない。kill-stop を変えずに「timeout の後の遅延実行は隔離されない」を残余リスクとして受け入れる案は、背景ではユーザーが別アプリで作業していて遅延した効果に気付きにくく、前面より危険が大きいため採らない。

**N9 で作るもの**: 背景 control と前面引渡しの台帳への記録（K-4 の列と種類は N3 の台帳に載る）、K-1 の隔離の契機の通知、世代失効、再送禁止、残余リスクの表示を作る。K-1〜K-5 の台帳・隔離・再開の側は N3 が作る。kill-stop の終了方式を再設計しない。

### 2.6 承認経路との関係

**現状**: `main/computer-use-controller.ts:5213` は approvalApprove に action / observationRevision / cancelEpoch / approvalGeneration を渡し、`:5244` で dispatchApproved を呼ぶ。`:5254` は呼出し後の例外を unknown_effect とし ticket を使い直さない。承認の後に対象へ戻るのは `refocusAndReobserve`（`:3819`）で、無条件に `startSession`（`:3831`）を呼び、native の再開の `SetForegroundWindow`（`native/computer_use_windows_host.cc:6140`）を通る。呼出し元は V1 カードの `resolveApproval`（`:3762`）と native の単発承認の `runNativeApproval`（`:5148`）の二つである。承認経路 ADR §2.3 のとおり、Windows の supervised で plan 対象外の入力では V1 カードと native カードが二枚出るので、V1 側の再前面化も実際に通る。N8 の承認の再測定は interlock の visual patch 照合（`native/computer_use_windows_host.cc:8081`）で前面を要求する capture を使う。これは設計時の比較資料である。N8-1〜N8-6 は main に反映済みで、N9 では背景の復帰を接続する。承認経路 ADR §2.2 は execution ticket の束縛、§2.3 は supervised、§2.8 は非自動フォーカスを定める。

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
| BG-5 fallback と承認の往復 | pattern 不在ではカードが出ても focus は動かない。明示引渡し後だけ前面化し、新しい観測・必要な承認・ticket で操作する。拒否、期限、Stop、前面化失敗（foreground lock を含む）、直後の別アプリへの移動で入力が出ない。supervised の前面 fallback の通し試験として、Sprint Coder への往復で承認を完了でき、第三の窓への移動・期限切れ・復帰後の対象変更では入力が出ない。`AllowSetForegroundWindow` は helper の pid に限られ `ASFW_ANY` を使わない。対象が最大化されカードが背後に出ても、シェルを前面にせず直接 Sprint Coder へ移った場合だけ pause しない。タスクバー click でシェルが前面になれば pause する。往復の間の Sprint Coder への移動で claim gate を takeover として閉じる処理を起こさない。前面セッションに interaction epoch の検査を要求しない。往復の前面の移動を native が判定し、event frame で Main に届く。(ii) の「その他」が欠けた・遅れた場合も、native が保持した往復の失敗で復帰の前面化と ticket の交換が拒否され、入力が出ない。id の違う終わりの要求・復帰の指示は拒否される。往復の間に拒否した入力が、往復の後に旧 ticket・旧 observation で再実行されない。シェルの窓（未確定の例外）、File Explorer のフォルダの窓、デスクトップへの移動は pause する。V1 の往復は native 受信時から単調時計で最大 60 秒とし、期限でカード本体も失効する。開始受理前の例外適用、WinEvent 登録失敗・pump 心拍欠落、id 欠落・終了済み・失敗保持、失敗後の end 先着と id なし existing start の迂回を負例にする。正常時は復帰・再観測・交換の後に end とする。開始の拒否の境界として、人が押した引渡し・往復の復帰の前面化は拒否されない |
| BG-6 遅延と再起動 | provider を呼出し前・呼出し中・呼出し後の確認前で停止させる。Stop を伴わない実行中の `input_timeout_unconfirmed` で K-1 の隔離が作られ、その後の receipt による Stop で隔離が消えない（K-3）。**応答消失**（transport timeout・`failAll`・`abortTransport`、semantic owner の uncertain）の後に receipt で Stop を確定しても、`confirmSessionClosed` が uncertain を戻しても隔離が消えない。K-1 で隔離した対象について、receipt で Stop した後に新しいセッションを K-5 の承認カードで始めると、新しい session id・ticket と新規観測から始まり、隔離の前の ticket・観測は使えない。前面化の行だけが残った世代の helper の終了は `terminated_target_suspect` にならない（K-4）。K-5 は receipt で Stop した後の新しいセッションの開始でだけ使え、同じセッションの再開には使えない。**uncertain・closeCandidate・`activeStopQuarantines`・native の in-flight が残る状態で dispatch が拒否され、Host の inputQuarantined() が残る間は K-5 のカード承認自体も拒否される**負例を含める。helper 終了、Main 再起動を行い対象の隔離と世代失効を検証する。provider を後で解放し、遅延効果が起こり得ることと二重入力がないことを確認する。隔離のストアに書けないときは入力が出ない |
| BG-7 承認 UI | 背景 / 前面の経路表示、supervised の操作ごとの確認、二枚カード（背景では前面化 API が 0 回）、trusted activation、期限・拒否・Stop、Tab / click、キー継続、light / dark、loading / error / disabled を確認する。別アプリ入力中の出現では承認も focus 移動も起こらない |
| BG-8 回帰と非対応 | 前面セッションの focus 喪失拒否と連続入力、危険面・E1 / E4 拒否、旧 helper / 未知能力の gate 閉鎖と今の前面セッションの維持、監視の失明（hook の外れ、心拍の欠落）での gate 閉鎖、**キーボードだけの別アプリの入力では失明と判定しない**正例、**hook の除去の後のマウスの移動で gate が閉じる**負例、gate が開いた後の前面でも背景能力も無い対象の、人の Start・quick start・startForAgent を含むすべての新しい開始の拒否（自動前面化 0）と、人による前面セッションの再開の前面化が拒否されない境界、macOS の既存承認契約を境界試験で維持する。未確認 provider が背景能力ありと表示されない |

計測はテスト用の受動 observer による foreground WinEvent、cursor 位置のイベント記録と補助 sampling、製品の API attempt カウンタ、fixture の入力回数・効果を相関させる。観測器は入力を生成しない。event 欠落や計測不足があれば BLOCKED とし、sampling だけで一瞬の移動がなかったと断定しない。最小 metadata と合成 fixture の結果だけを証拠に残す。provider の非活性化特性は OS・アプリ / provider 版・control・pattern ごとに記録し、対応表へ反映する。

実機記録は build / SHA、Windows 版、DPI・monitor 構成、仮想デスクトップの構成、fixture / provider 版、操作、期待値、実測値、動画・計測 artifact、各ケースの PASS / FAIL / SKIP / BLOCKED を含める。UI 操作を内部 IPC・DOM・shell スクリプトで代替しない。native fixture や受動計測は補助証拠である。実 Provider 課金は本受入に不要である。

**代案・理由**: screenshot の前後比較だけ、CI の成功だけ、helper のログだけでは AC-6 のユーザー操作を証明できない。実操作と連続する受動証拠を組み合わせる。

**N9 で作るもの**: 上記 fixture / observer、直接関連の Vitest と Windows native seam、既存 Computer Use チェックリストへのケース追加、対応表の実機証拠を作る。実装時は回帰テストの RED → GREEN を記録する。本 ADR では作成も実行もしていない。

## 3. N9 の実装スライス

N8-1〜N8-6 は main に反映済みである。以下の N9-1〜N9-7 は機能区分として残し、実際の PR 分割・依存・公開条件は §5.1 の P0〜P8 に従う。Main の接続は N8-4、UI は N8-6 の後に置く。semantic の入力を開くスライスは、N3 に §2.5 の K-1〜K-5 が入った後である。分割後のコード位置と正式な wire 名は実装時に照合する。背景能力の gate は最後のスライスまで本番で閉じる。各 PR は一つの境界をレビューできる大きさにし、対象 typecheck と直接関連テストを通し、後続 PR の存在を合格条件にしない。

| # | PR の単位・成果 | 依存 | 試験 |
| --- | --- | --- | --- |
| N9-1 | 契約: `inputPath` の三値、セッションの形、能力宣言と対応表の版、authority の拡張（interaction epoch と内容の指紋は欄だけを予約し、値は N9-2 / N9-3 が入れるまで固定の「無し」で背景能力を閉じる）、監査の `inputPath` 欄と `computerUseActionRoute` の semantic scroll、N8 の承認の operation の列挙と strict schema への semantic scroll の追加、往復の開始と終わりの新しい要求（往復の id、60 秒以下の長さ（duration。native が開始要求を受信した時点から自身の単調時計で計測し、プロセス間の絶対時刻は渡さない）、Sprint Coder の窓の特定の値）。復帰の startSession（existing）と approvalApprove の往復 id 欄も追加（欠落・終了済み・失敗保持を拒否）。native / TS / schema / fixture の一体変更。旧 helper を閉じる | 本 ADR 承認、N8-4 | 経路差替え、未知欄・版、replay、旧 ticket / 世代、ordinary と承認の取り違え、route と `inputPath` の対応。macOS 契約の維持 |
| N9-2 | native の背景の観測と検証: 背景 start / resume / observe、window / dialog / root / ancestor / 内容の指紋の検証、index 由来の proxy の判定、仮想デスクトップ・cloak、背景の capture（最初に遮蔽窓の capture の成否を実機で確認）。入力能力は未公開 | N9-1 | 前面化 API 0、BG-4 の入力前拒否、対象由来の観測と classifier、focused 欄の欠落の扱い |
| N9-3 | 入力所属の監視と通知: 専用の message pump、低レベル mouse hook（Q10 の判断に従う）、WinEvent、生存確認、interaction epoch、native → Main の event frame（C++ / TS の MessageType の一致。takeover と、往復の前面の移動の二種類）、Main の pause・失効と close を伴わない cancel の新しい経路、前面往復中の WinEvent 登録・pump 心拍検査と失敗保持 | N9-2 | BG-3 の入力前拒否、hook の外れ・心拍の欠落・キーボードだけの入力での誤判定 0、event の欠落・順序、cancel と claim の競合、再開時の epoch |
| N9-4 | semantic executor と semantic scroll、§2.1 の完了と読み直し、台帳への記録（`inputPath`）と K-1 の隔離の契機、未知効果・世代失効。試験用 gate のみ | N9-3、N3（K-1〜K-5 を含む） | pattern 全件の正負例、同値 no-op、最後の検証後の変更、呼出し失敗・遅延・Main 再起動、BG-6、二重発行 0 |
| N9-5 | Main の承認と引渡しの接続: V1 カードと native カードの経路別の復帰、背景の再観測・ticket 交換・dispatch、前面引渡し intent と消費、`AllowSetForegroundWindow`（addon と Main）、`approval_round_trip`（往復の開始と終わりの要求の送信、Sprint Coder の PID・作成時刻・image identity の受け渡し、native の往復の失敗の保持、event frame の (ii) の処理、V1 カードの往復の 60 秒の上限とカード本体の失効、end 先着・id なし復帰拒否、正常時の復帰・交換後の end） | N9-4、N8-4 | BG-5 の境界部分、カード中の takeover、期限・Stop・旧世代、経路変更による失効、発行後 fallback 0、二枚カードの前面化 API 0 |
| N9-6 | Renderer の UI: 背景 / 前面の経路表示、引渡しカード、残余リスクの表示 | N9-5、N8-6 | BG-7、Renderer interaction / activation |
| N9-7 | 実機対応表の確定、受動 observer とチェックリストの受入（P7）、能力 gate の接続（P8 だけ） | N9-6 | BG-1〜BG-8 の境界試験と Windows Computer Use。前面・cursor 不変の artifact、未対応の fail-closed。根拠が揃った組だけを公開候補とする |

N9-7 の合格をブラウザ・Explorer の有効化や release の許可と解釈しない。実機の証拠不足は BLOCKED として残し、gate を閉じた状態で引き渡す。

## 4. 設計判断の項目（N9a 時点の記録）

D-6 の計画への採用、AC-6、UIA 優先、N8 の後という順序は既決事項である。「focus が変わったら止める」という今の不変条件を N9a の設計で置き換えること自体も D-6 で既決である。置き換えの中身は §2 の決定に従う。具体的には Q4（背景経路の束縛）、Q5・Q6（経路とセッションの形）、Q8（takeover の定義）である。以下の Q1〜Q23 は設計時の判断項目として番号を保持する。P0 での一意化は §2 と §5.1 に反映し、未決事項は §5.2 に分ける。

1. §2.1 の pattern ごとの背景入力範囲（Invoke、Toggle、SelectionItem.Select、Value.SetValue、ExpandCollapse）を採用するか。判断材料: dialog を開く Invoke（保存・開く・設定など）は、背景では毎回 `unknown_effect` と対象の隔離になり、続けるには Stop と K-5 のカードによる新しいセッションの開始が要る。
2. §2.1 の semantic scroll（ScrollPattern）を、座標 wheel とは別の新しい背景入力として N9 に含めるか（N8 の operation の列挙の拡張を伴う）。
3. 背景能力を実機確認済みの provider・control・pattern の組に限り、版付き対応表で開く方針を採用するか。
4. §2.2 の対象・祖先・内容の指紋・経路・世代への束縛を、背景経路の前面確認の代わりとするか（index 由来の runtime id の proxy を背景能力なしとすることを含む）。
5. §2.1 の三値の `inputPath`（background_semantic / foreground_semantic / foreground_input）と、背景セッション・前面セッションの二つの形を採用するか。
6. 前面セッションでは、今どおり連続入力を許し、focus の喪失で pause する（§2.4 の承認の往復だけを例外とする）か。
7. gate が開いた後、前面でもなく背景能力も無い対象の、人の Start・quick start・startForAgent を含むすべての新しい開始を、自動で前面化せずに拒否するか（§2.1。人が押した引渡し・往復の復帰・人による前面セッションの再開は対象外）。
8. §2.3 の、対象（対象プロセスの任意の top-level window を含む）が前面になるだけで takeover とする保守的な定義を採用するか。
9. 背景セッションで、別アプリでの通常入力は継続し、所属不明なら停止する方針を採用するか。
10. 入力所属の監視に、大域の低レベル mouse hook（`WH_MOUSE_LL`）を採用するか。推奨は「採用する。背景セッションがある間だけ専用スレッドに入れ、キーボード hook は使わず、metadata だけを記録する。生存はマウスに限った Raw Input との照合で確かめる」である。理由は、前面化を伴わない非アクティブ窓への wheel・pointer 操作を WinEvent だけでは検出できないためである。採用しない場合は、非アクティブ窓への pointer 操作を takeover として検出できないことを残余リスクとして受け入れることになる。hook はセキュリティ製品に監視として検出されうること、全 mouse 入力の metadata を helper が受け取ることが欠点である。
11. §2.4 の、入力前の能力不足と前面だけの操作に限る人の明示的な前面引渡しを採用するか（背景から前面へ製品が自動で前面化しない）。
12. 引渡しの単位を、推奨の「引渡しの後は前面セッションの区間とする」案にするか、「一操作で前面入力の権限を消費し、次の前面入力にも引渡しを求める」案にするか（§2.4 の推奨の理由を参照）。
13. §2.4 の `approval_round_trip`（Sprint Coder の窓だけへの往復を、カードの期限内（V1 カードは 60 秒）に限り許し、native が前面の移動を判定して失敗を保持し、復帰後に再検証する。シェルの窓の例外は未確定で、それまでは pause する）を採用するか。
14. §2.6 の、背景承認後の refocus を、V1 カードと native カードの両方で同じ対象への背景再観測に置き換える案を採用するか。
15. §2.5 の kill-stop への追加要求 K-1〜K-5 を N3 の範囲に入れることを承認するか（K-5 は、receipt で Stop した後に新しいセッションを始めるときに承認カードで対象の隔離を解く経路で、同じセッションの再開ではなく、client・host・native の未確認による拒否を外さない）。
16. N3 に K-1〜K-5 が入るまで、背景入力を公開しないことを承認するか。
17. 残余リスク (a): 隔離は新しい入力を止めるだけで、発行済みの UIA 呼出しは人の takeover / Stop の後にも対象で実行されうる。前提は、K-1〜K-5 が N3 に入り、隔離と表示が働くことである。これを受け入れるか。
18. 残余リスク (b): completed で返った Invoke の後の非同期の効果は隔離されない（今の前面の semantic Invoke と同じ。kill-stop ADR §5 の 2）。これを受け入れるか。
19. 残余リスク (c): OS の event と provider 呼出しの間に原子性はなく、takeover と同時の一操作は残りうる。これを受け入れるか。
20. 残余リスク (d): 照合できない対象の隔離は、承認カードで再開するまで再起動をまたいで続く。これを受け入れるか。
21. 残余リスク (e): 前面化（K-4）が遅れて効いた場合、人のキー入力が対象へ届きうる。前面化の行は隔離を作らない（K-4）。これを受け入れるか。
22. §2.7 の実機受入と連続する受動証拠を公開の条件とするか。
23. §3 の PR 分割と依存（N8-4 / N8-6 の後、N9-4 は N3 の K-1〜K-5 の後）を採用するか。

### 4.1 承認後の既存 ADR への反映

P0 では kill-stop ADR の背景段落を同期する。V2 ADR と承認経路 ADR への反映は別変更で行う。設計承認、実装、実機受入、公開の状態を混同しない。

- V2 ADR: T5・冒頭の入力前後再検証を経路別にし、user takeover の定義へ §2.3 を接続する。§3.6 の拒否と D14 の非自動フォーカス、`frontmost` 非公開は維持し、D14 の目的が背景から前面への自動前面化にも及ぶこと（§2.1 の開始の拒否と §2.4）を追記する。
- V2 ADR §8 の表の「入力前後の identity / focus / geometry / 観測鮮度 / cancel epoch 再検証」の行（「変更禁止。deny class 再判定を追加するだけ」）: 背景経路に限り、focus の再検証を §2.2 の束縛で置き換えることを、条件つきの置換えとして書く。置き換えること自体は D-6 で既決であり、置き換えの中身（§2.2 の束縛、経路とセッションの形）は Q4・Q5・Q6 の承認で決まる。前面セッションの行の内容は変えない。
- 承認経路 ADR: §2.2 の focus 再検証・対象への復帰を、背景経路では §2.2 / §2.6、前面セッションでは §2.4 の `approval_round_trip` に置き換え、§2.7 の停止・世代と §2.8 の表示へ接点を追記する。
- kill-stop ADR（統合済み）: §2.1、§2.2、§2.3、§5 の 2 に、§2.5 の K-1〜K-5（実行中の隔離の入口、隔離の効く範囲、receipt で確定した背景の応答待ち・効果未確認の行を消さない例外、台帳の `inputPath` の列と前面化の種類および終了時の判定の例外、receipt で Stop した後の新しいセッションの開始での承認カードによる隔離の解除）を統合済み。P0 では in-flight の解除条件と公開依存を同期する。

## 5. PR 分割・現コードとの対応・未確認事項

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
| 前面セッションの focus 喪失 | §2.4 の往復の間の native の検知 | `native/computer_use_windows_host.cc:3599` |
| 呼出し後の窓の単位の再検証 | §2.2 の 7 の項目 | 同 `:9798`〜`:9817`（`RevalidateWindowsTarget`） |
| copy の経路 | §2.1 の route と `inputPath` の対応 | `main/computer-use-controller.ts:4576`、`native/computer_use_windows_host.cc:11321` |
| pause と cancel | §2.3 の close を伴わない cancel の新しい経路 | `main/computer-use-controller.ts:4516`（cancel を送らない）、`:3028`、`:3526`、`:3597`、`:3889`（cancel は close とともに送る） |
| host 全体の拒否 | §2.5 の K-5 が外さないもの | `main/computer-use-native-windows.ts:272`、`:312`、`:554`、`main/computer-use-native-host.ts:247`、`native/computer_use_windows_host.cc:10220` |
| V1 カードの期限 | §2.4 の V1 カードの往復の上限 | `main/computer-use-controller.ts:4466`、`:4502` |
| 人による再開の前面化 | §2.1 の開始の拒否の対象外 | `native/computer_use_windows_host_v2_targets.inc` の StartWindowsExistingSession（現行 :2180）。StartWindowsNewSession（現行 :1676）は拒否側 |
| semantic owner の uncertain | §2.5 の K-1・K-3 | `main/computer-use-native-windows.ts:278`、`:296`、`:301`、`:829`、`:887`、`:896`、`:945`、`:970`、`:1003`、`:1009`、`:1015`、`:1023` |
| 入力監視・前面の許可 | §2.3 の hook、§2.4 の `AllowSetForegroundWindow` | `apps/desktop/computer-use-native` と `apps/desktop/src` で `SetWindowsHookEx`・`WH_MOUSE_LL`・`AllowSetForegroundWindow` は 0 件 |
| 入力と不明結果 | §2.4 / §2.5 の accepted と in-flight | `native/computer_use_windows_host.cc:8644`、`:9564`、`:9683`、`:10220` |
| SendInput | §2.4 の前面を必要とする経路 | 同 `:9820`、`:10289` |
| 承認後の復帰 | §2.4 の承認の往復、§2.6 の経路別の復帰 | `main/computer-use-controller.ts:3762`、`:3819`、`:3831`、`:5148`、`native/computer_use_windows_host.cc:6140` |
| 承認 | §2.6 の交換・dispatch・例外時の未確認 | `main/computer-use-controller.ts:5213`、`:5244`、`:5254` |
| 試験 | §2.7 の既存境界試験 | `main/computer-use-windows-input-seam.test.ts:29`、`main/computer-use-windows-ticket-seam.test.ts:873` |

上表の旧行番号は設計時の base の参照であり、現在の実装状況の根拠にはしない。背景操作の実装、native build、実機試験は行っていない。次は未確認であり、N9 の公開前に確認する: provider の副作用、遮蔽窓の Windows Graphics Capture の成否、index 由来の runtime id の判定方法、入力監視の遅延・欠落の検出の実効性、キー入力が前面の対象にしか届かないという前提（強い推定）、`AllowSetForegroundWindow` を Main の addon から呼ぶ形（強い推定）、マウスに限った Raw Input での hook の生存の照合の実効性、往復の間のタスクバーのシェルの窓を class とプロセスの組で特定できるか（それまでは pause）、実 dispatch と K-1〜K-5 の接続および N3 PR10・PR11 の有効化。OS の event と provider 呼出しの間に原子性はなく、悪意ある provider の内部動作を UIA から制限できるとは主張しない。

独立した敵対的レビュー、PR、Review BOT、要塞レビュー、オーナーの設計承認は親の工程である。

### 5.1 P0〜P8 の PR 分割と公開条件

N3 PR1〜PR9・N8-1〜N8-6 は main に反映済み、N3 PR10・PR11 は作業中である。N9-1〜N9-7 の機能区分を次の PR に分ける。N/ は native/、M/ は main/、R/ は apps/desktop/src/renderer/、C/ は packages/contracts/src/ を指す。予算は差分の目安であり、各 PR は追加・削除・試験・文書を含め 1,499 行以下とする。超える場合は公開条件を緩めず機能境界で再分割する。

| PR・予算 | 変更ファイル・成果 | 単独受入・依存 |
|---|---|---|
| P0：〜300行 | 背景ADR、kill-stop ADRの矛盾・用語・依存更新 | §2 の状態・拒否条件の解釈が一意。実装前 |
| P1a：〜1,200行 | `N/computer_use_protocol.h`、`M/computer-use-native-protocol.ts`、`M/computer-use-controller.ts`の内部型、`C/index.ts`、関連schema試験 | session形・三値経路・能力版・authority欄。C++/TS一致、旧helper拒否。背景gate無効 |
| P1b：〜1,200行 | 同wire関連、`N/computer_use_windows_approval_wire.h`と試験 | 往復begin/end・復帰・approveのid、duration、event契約。欠落・未知欄拒否。P1a後 |
| P1c：〜1,200行 | `M/computer-use-action.ts`、contracts、classifier・approval operation列挙と関連試験 | semantic scrollを別操作として定義。座標wheel不変、classifier/schema一致。P1a後 |
| P2a：〜1,300行 | `N/computer_use_windows_host_v2_targets.inc`、`…_session.inc`、`…_target_facts.h`、start seam | 背景開始・再開、全新規Start非前面化、cloak/desktop拒否。P1a後 |
| P2b：〜1,300行 | `N/…_observe.inc`、`…_capture.inc`、`computer_use_windows_interlock_capture.h` | 背景対象由来の観測・capture、focused欠落。分類根拠不足は拒否。P2a後 |
| P2c：〜1,300行 | 新規案 `N/computer_use_windows_background_binding.h`、既存semantic/preflight/approval測定の接続 | 祖先・内容指紋・proxy除外、普通／承認共通検証、BG-4。P2b後。P2c は未知 provider 拒否と合成 fixture まで、実 provider の許可表は P7a/P7b・N13b の実機確認後 |
| P3a：〜1,200行 | 新規案 `N/computer_use_windows_background_monitor.h`、host接続、native seam | WinEvent・mouse所属判定、interaction epoch、claim競合。P2c・P1b後 |
| P3b：〜1,200行 | 同monitorと専用試験 | Raw Input受信、独立pump、心拍・登録失敗・hook失明検知。P3a後。実測閾値未確定なら公開不可 |
| P3c：〜1,200行 | 新規案 `N/computer_use_windows_approval_round_trip.h`、session・approval接続 | 往復状態機械、前面監視、idなし迂回拒否、end先着・期限・失敗保持。P1b後 |
| P3d：〜1,200行 | `M/computer-use-native-windows.ts`、`…-native-host.ts`、controller、transport試験 | event配送、世代・順序検査、カード失効、closeなしcancel、人の再開。P3a〜c後 |
| P4a：〜1,300行 | `N/…_uia_semantic.inc`、`…_input.inc`、新規背景executor seam | 既存五patternの単発実行・読み直し・禁止API 0。P2c・P3d後、試験gateのみ |
| P4b：〜1,000行 | 同executorとscroll専用試験 | Scroll/SetScrollPercent、単位一致、ScrollIntoView非公開。P1c・P4a後 |
| P4c：〜1,300行 | `M/computer-use-native-host.ts`、windows client、stop-outcome／ledger／transport試験 | 実dispatch→背景台帳→K-1〜K-5、保存失敗・receipt・再起動。N3 PR9＋P4a/b後 |
| P5a：〜1,200行 | controller、approval-path／native-host-approval試験 | 背景のV1/native両復帰を背景再観測へ。二枚カード前面化0。P4c後 |
| P5b：〜1,300行 | controller、windows adapter、approval-async／transport試験 | 前面往復接続、V1の60秒失効、通知欠落、end順序。P3c/d・P5a後 |
| P5c：〜1,300行 | Windows addon、`binding.gyp`必要部分、controller、start接続 | 引渡しintent、helper PID限定AllowSetForegroundWindow、K-4記録、前面化失敗拒否。P5b後 |
| P6：〜1,200行 | `R/components/ComputerUsePanel.tsx`とinteraction試験、表示contracts、必要なIPC部分 | 経路表示・引渡し・残余リスク、BG-7。P5c後。main にある N8-6 の既存カードへ統合 |
| P7a：〜1,300行 | 新規native合成fixture・受動observer、build/test登録 | 遅延provider・API試行・focus/cursor・監視計測装置。公開gate無効 |
| P7b：〜1,000行 | `docs/testing/computer-use/`、新規版付き背景対応表、証拠索引 | BG-1〜8実機受入、OS/provider/control/pattern別の対応根拠。P6・P7a後 |
| **P8：〜800行・最後** | eligibility/provenance、manifest生成・handshake接続、`M/index.ts`等の本番配線とgate試験 | **N3 PR10・PR11有効化後**。必要なN8/N7条件、K-1〜K-5、BG受入が揃った組だけ公開 |

P0〜P7 は背景 gate を既定無効に保つ。環境変数・Renderer・モデル指定では開けない。wire の producer・parser・fixture は native と TS を同じ PR で揃える。公開は最後の P8 だけとし、N3 PR10・PR11 の有効化、必要な N8/N7 条件、K-1〜K-5 の実 dispatch 接続試験、BG-1〜BG-8 の実機受入が揃った provider・control・pattern の組に限る。内部試験 gate の成功を本番配線の証明にしない。N9 の能力公開は release 公開や N11 のブラウザ・Explorer 有効化の許可ではない。

現在の接続点は、native/computer_use_windows_host_v2_targets.inc の StartWindowsNewSession（前面化 :1676）と StartWindowsExistingSession（前面化 :2180）、main/computer-use-controller.ts の refocusAndReobserve（:4288）、cancelPendingApprovals（:4364）、V1 の expiresAt（:4942）と timer（:4978）、userTakeover（:4992）で確認した。新規開始の前面化を人の再開の例外に含めない。V1 の現行 60 分と userTakeover の pause 通知だけでは往復の 60 秒失効を満たさないため、P5b でカード失効を接続する。

### 5.2 未決事項と実測待ち

- message-only window への WM_INPUT 配送、SendInput 由来 mouse の Raw Input / hook の対応、照合許容時間と pump 心拍の間隔・上限は実測待ち。hwndTarget 必須と失敗時の fail-closed は決定済みであり、値を仮定して公開しない。
- シェルの窓を識別できるか、その結果で往復の例外を開くかは未決。現在はシェルが前面になれば pause とする。
- 正常往復は生きた id で復帰・再観測・交換してから end とする。交換済み ticket の end 時の扱いと dispatch までの詳細な状態遷移は P3c で明文化し、Main / native の対試験で固定する。往復中の claim 禁止と失敗保持を弱めない。
- provider の非活性化、遮蔽窓 capture、index 由来 proxy の識別、監視・AllowSetForegroundWindow の実効性は実機未確認。対応表の公開可能な組と必要な N7 条件の充足は P7・P8 で確認する。
