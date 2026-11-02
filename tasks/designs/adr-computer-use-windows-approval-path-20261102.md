# ADR: Computer Use Windows — 単発承認と supervised の承認経路

- Status: Draft（オーナー承認の前。設計の推奨案であり、有効化の承認ではない）
- Date: 2026-11-02
- Issue: #991（Refs #988, #500）
- 関連: `tasks/designs/adr-computer-use-agent-driven-v2.md`（以下、V2 ADR）§3.2.3〜§3.2.5、§3.6、§4、§9 C5 / C6、S4-4 承認 ticket の契約と補遺、§10 Q1 / Q2
- 接点: `tasks/designs/adr-computer-use-windows-kill-stop-20261102.md`（別 PR で進行中。現 checkout の実装済み契約とは扱わない）
- 現状の照合基準: `1899ca3c187bdf4cc212e2dad1f282bbe1eeb6e5`。以降の差分は本 ADR のみである。今回も現コードで照合した。以下の `file:line` はこの版を指す。`main/` は `apps/desktop/src/main/`、`native/` は `apps/desktop/computer-use-native/`、`renderer/` は `apps/desktop/src/renderer/` の略記である。

## 1. 問題と範囲

Windows には ordinary ticket の経路があるが、人の承認を native の単発 execution ticket に交換する経路がない。V2 ADR の判断 C は、この間、上限クラス C と未署名アプリを `observe_only` に下げている。#988 D-7 の承認済み方針に従い、N8 で経路を作るための設計を定める。N8 の着手は本 ADR のオーナー承認と N1（host.cc の分割）の後である。

成果は、危険な操作に「今回のみ許可」を出し、同じ対象・同じ操作だけを一度実行できる設計である。E2 / E3 は単発承認、上限クラス C と適格な未署名アプリは操作ごとの確認にする。実行ファイル・インストーラを開く E1 / E4 は、人が承認しても拒否する。承認はアプリの初回許可や Provider への送信同意を代替しない。

本 ADR は設計だけである。ブラウザ・Explorer の有効化は N12 の実測後の N11、背景操作は N9a、Stop の土台は N0〜N5 が担当する。N8 はそれらとの接点を作るが、対象の拡大や停止方式の決定を引き取らない。N7（PR-6）は N8 の経路と検証を前提に Windows V2 を有効化する。release の切替は別工程である。

## 2. 決定（案）

### 2.1 Windows で承認経路を開く条件

**現状**: `main/computer-use-eligibility.ts:143` の `computerUseApprovalPathEnabled` は darwin、承認メソッドの存在、classifier 2、route v2、実効 `v2-denylist` を要求する。`main/computer-use-native-host.ts:561` は session の束縛がなければ `unbound` にし、`:566` で同じ述語を使う。`:571` は preflight / approvalApprove / approvalDiscard / dispatchApproved の全存在を要求する。`main/computer-use-eligibility.ts:114` の attest は gate-open とコンパイル済み classifier 2 に由来する。`main/computer-use-native-windows.ts:131` は preflight を配線するが、承認メソッドはまだ配線しない。

**決めること・推奨案**: Windows も同じ session 単位の述語で開く。ただし `platform === 'win32'` を加えるだけにはしない。session の gate は条件 1〜3 が成立したときだけ開く。条件 4 は入力ごとの追加検査である。

1. Main の pin、manifest、native handshake の platform 別 eligibility が一致し、パッケージ・署名・provenance の gate が開いている。classifier は正確に 2、`ticketRequired` と Windows V2 の `interlockEnforced` は true である。現在の比較関数が未実装の attest を検査済みだとは扱わない。`interlockEnforced` と版表の本番接続は N7 が担当する。
2. Windows adapter と接続先 helper の双方に承認の全操作があり、wire 契約と版が一致する。TS に関数を置いただけでは能力の証明にならない。helper の承認能力を handshake で検査し、欠落・未知の版では閉じる。
3. 現在の helper 世代に属する生きた session が route v2、実効 `v2-denylist` に束縛されている。route v1、未束縛、失敗した start、close 済み、旧 helper 世代では閉じる。
4. Windows の操作入口では、control のある session の操作 mode が `supervised` または `full_access_app` であることも検査する。これは Windows 専用の追加ガードであり、共有 `computerUseApprovalPathEnabled` の入力へ操作 mode を追加しない。現行の `effectiveMode` は eligibility mode である（`main/computer-use-eligibility.ts:143`）。darwin の入力と真偽表は変更しない。`observe_only` はカードから昇格できない。

環境変数、Renderer、モデルの指定では開かない。force-v1 は閉じる方向だけに使う。承認経路が利用不能なら、C / 未署名の control は公開せず、拒否または `observe_only` に留める。

**代案・理由**: OS 名だけで開く案、旧 preflight に TS の承認を足す案は、native が単発性を保証しないため採らない。macOS と別の承認仕様にする案も、共有 controller の監査・再検証を分岐させるため採らない。

**N8 で作るもの**: helper の能力宣言と wire 操作、adapter のメソッド、session / helper 世代を含む gate、未実装能力の負例を作る。本番版を上げる N7 より前は、試験用 build / fixture だけで経路を駆動する。共有述語の既存 darwin の真偽表、v1 / unbound の拒否は維持する。

### 2.2 E2・E3 の単発承認と ticket

**現状**: `native/computer_use_windows_host.cc:10947` の ruleset は download_open / file_manager_open を false に固定する。`:11020` の binding 検査後、`:11037` で interlock を評価し、拒否がなければ `:11057` から ordinary ticket を作る。`native/computer_use_effect_classifier.h:993` は面、開く効果、対象、拡張子から E2 / E3 を分類する。拡張子不明は `:1005` で takeover である。macOS の承認測定は `native/computer_use_macos.mm:5821` と `:6729`、portable な測定は `native/computer_use_effect_measurement.h:381` にある。

**決めること・推奨案**: Windows native の preflight、承認交換、承認後 dispatch の各境界で、同じ capture と classifier により対象を測定する。N1 後の分割先は実装時に追跡するが、現在の `HandleWindowsPreflight` と `EvaluateWindowsInterlockOnLane` に相当する境界を正本とする。Main の文言やモデルの「文書である」という申告では判定しない。

現行 `native/computer_use_effect_measurement.h:388` の `MeasureApproval` は AX 用の `BuildShadowFacts` を呼ぶ。一方、Windows は `native/computer_use_windows_interlock_capture.h:98` の `BuildWindowsShadowFacts` に、取消し・予算・完全性、実パス、chain のプロセス所有、非 web の追加規則を重ねる。N8-1 は測定関数を検証済み facts を受け取る核と OS 別の入口に分け、Windows の全承認境界でこの追加規則を通った同一 facts と decision を authority の生成にも使う。Windows から AX 用入口を呼ばない。macOS の既存入口・測定値は維持する。

- E2 はダウンロード面の祖先と開くコントロール、E3 はファイルブラウザ面の項目と既定アクションに結び付ける。UIA の要素・祖先、面、対象ファイルの拡張子、操作種別を取得する。座標クリックもその位置の対象を解決する。表示名だけの拡張子推測、他の項目の filename の流用は不可である。
- E3 は現在の選択集合が操作対象の 1 項目だけと一致することを、preflight / approve / approved dispatch の 3 境界で測り直す。シェルビューの正本である `IFolderView2` の `SVGIO_SELECTION` による選択数と全選択項目を必須とし、UIA 対象と実パスへ結び付ける。取得できない面は takeover とする。`IUIAutomationSelectionPattern::GetCurrentSelection` は照合用とし、正本と食い違えば takeover とする。画面内の UIA 要素だけで選択数を確定しない。複数選択、別項目の事前選択、選択なし、読取り不能、不一致は takeover とする。選択数と対象の実パスの digest を native authority に含め、外へ出さない。クリック後に選択が変わるという予測で事前条件を省略しない。
- native が対象を一意に結び付けられない、読み切れない、拡張子が不明、origin / 面が不明なら takeover とし、確認カードを安全性の代用にしない。入力経路ごとの実測を通っていないものは閉じたままにする。
- カードには対象アプリ（表示名はアプリ提供値と区別）、操作「ダウンロードを開く」または「ファイルを開く」、対象項目の安全に表示できるラベルと拡張子、外部アプリが開く可能性、残り期限を示す。入力本文やファイル内容は取得しない。E2 / E3 は対象ラベルと実パス由来の拡張子が検証できなければ承認しない。このラベル必須条件は E2 / E3 に限る。内部 path / PID / HWND / token / authority digest は Renderer・モデル・会話・監査へ出さない。必要な表示情報は native の測定結果から専用の表示用データとして Main が検査・無害化し、命令として扱わない。
- native のカードは `allow_once` / `deny` のみで、plan grant、今後も許可、タスク全体の許可を作らない。`full_access_app` も E2 / E3 を省略できない。

**表示用の契約**: 現行 offer receipt は `approvalGeneration` / `remainingMs` / `effect` だけを追加し、余分な key を拒否する（`main/computer-use-native-host.ts:1554`, `:1602`）。N8-2 で Windows 用の receiptVersion 3 の offer receipt と strict schema を同時に追加し、native 測定由来の `display`（対象ラベル、拡張子、効果、外部アプリの可能性、未署名警告の区分）を運ぶ。文字列長・列挙値・必須欄・未知 key を検査し、欠落や不一致を拒否する。表示値を authority に結び付け、再測定で変われば拒否する。path や本文をラベルに転用せず、制御文字に加えて双方向制御・ゼロ幅・その他の Unicode Cf 文字を Main で除去し、表示長を制限する。拡張子は native が実パスから測った値をラベルとは別欄に表示する。除去後に空となったラベルは未検証として扱う。共有内部型と Renderer へ出す contracts も同じ PR で揃える。macOS の既存 receipt v1 / v2 は strict な旧形を維持し、内部の表示データの既定値を `null`（追加欄なし）とする。Windows の新 receipt にこの既定値を適用して不足を隠さない。receiptVersion 3 は Windows の能力宣言と route v2 に束縛し、darwin や能力未宣言の接続では拒否する。N8-4 で controller に接続し、N8-6 で欄を表示する。

Windows の `display` は次の効果別 strict object とする。表の全欄を必須 key とし、省略は許さない。`null` は表で明示した欄だけに許し、未知 key、効果と不一致の値、長さ超過は拒否する。これは N8 の新契約である。

| effect（外側の effect と同値） | operation（許す列挙値） | targetLabel | extension | externalApplication | unsignedWarning |
| --- | --- | --- | --- | --- | --- |
| `supervised_action` | `click`, `double_click`, `invoke`, `set_text`, `type`, `key`, `scroll`, `select`, `toggle`, `expand_collapse` | 検証済みラベルまたは `null` | `null` のみ | `not_applicable` のみ | `none` または `main_image_only` |
| `high_impact_confirmation` | `click`, `double_click`, `invoke`, `key` | 検証済みラベルまたは `null` | `null` のみ | `not_applicable` のみ | `none` または `main_image_only` |
| `download_open` | `click`, `double_click`, `invoke`, `key` | 検証済みラベル必須、`null` 不可 | 実パス由来の拡張子必須、`null` 不可 | `may_open` のみ | `none` または `main_image_only` |
| `file_manager_open` | `click`, `double_click`, `invoke`, `key` | 検証済みラベル必須、`null` 不可 | 実パス由来の拡張子必須、`null` 不可 | `may_open` のみ | `none` または `main_image_only` |

`operation` は native action と一致させ、列挙への一致だけで効果を認めない。classifier の肯定的根拠と既存の拒否条件を別途満たす必要がある。`targetLabel` は本文や path を含まない表示用文字列（UTF-8 で 1〜512 bytes）、`extension` は先頭の点を除いた小文字 ASCII の英数字・ハイフン（1〜64 bytes）とする。E1 / E4 は表示 schema に通っても承認不能である。`unsignedWarning` は検証済み identity に由来し、未署名では `main_image_only` を必須とする。対象アプリと期限は既存 session / receipt に由来し、display で上書きしない。

ラベルが検証できない `supervised_action` は `targetLabel=null` とし、操作の種別と「対象のラベルを検証できない」をカードに表示して承認できる。`high_impact_confirmation` でも同様に未検証を表示するが、confirmation の肯定的根拠自体が欠ければ承認しない。E2 / E3 はラベルまたは拡張子の欠落・未検証で takeover とし、カードを出さない。RLO を含む合成ファイル名は表示偽装の負例とし、Cf 除去と独立した拡張子表示、実拡張子が E1 / E4 の場合の拒否を試験する。

**ticket の共通契約**: V2 ADR S4-4 と補遺、および `native/computer_use_native_approval_ticket.h:36`、`native/computer_use_native_approval_flow.h:120` を引き継ぐ。

1. native 内に session ごとの pending / ready slot を置く。intent / execution token は native の CSPRNG で作り、helper の外に出さない。Main は sessionId / approvalGeneration と helperGeneration の組で参照する。ordinary ticket と承認 token を交換しない。
2. intent は session、Task、Turn、元の request ID、action / payload digest、authority digest、cancel epoch、approval generation、元の観測 revision / ticket generation、classifier / ruleset / lexicon 版、効果クラスに束縛する。Windows の authority は検証済みの実行中 identity、PID と作成時刻、window、geometry、対象要素・祖先・面・origin・拡張子と効果を版付きで構成する。helper 世代も参照と検証の束縛に含める。revision 入りの context digest で authority を代用しない。
3. intent の期限は native の単調時計で最大 60 秒、カードは残り時間以下である。approval ID / revision / challenge / decision / Task / Turn に束縛した trusted activation を Main が消費した後だけ、同じ対象へ復帰して再観測する。
4. Main の Stop、policy、grant、Provider 送信同意、session / Turn、gate を再検証する。native は identity、mode、focus、geometry、payload、authority、効果、版、epoch / 世代を測り直す。新しい観測 revision と ticket generation は元より大きく、実行 request ID は元と異なる。変更時は再承認を自動発行せず拒否または takeover とする。
5. `approvalApprove` は入力せず、intent を消費して execution ticket を作る。有効期間は最大 5 秒と intent の残りの短い方である。新しい request ID / revision / ticket generation / context digest に束縛する。交換後から `dispatchApproved` まで observe / preflight / refocus を挟まない。
6. `dispatchApproved` は入力直前に再測定し、単発で ticket を消費する。再分類結果が同じ `kApproval` であること自体は拒否理由にしない。効果が普通の操作へ変わった場合も、承認した効果と異なるので拒否する。ordinary dispatch は承認 ticket を受け付けず、ticket 不備から旧 dispatch へ戻らない。
7. 同じ approval generation の試行は成功・失敗とも使い切る。異なる世代の遅延応答で新しい slot を壊さない。replay / in-flight を消費より先に処理し、timeout 後に入力を再送しない。`approvalApprove` / discard の失敗は入力前の拒否、`dispatchApproved` 後の無応答は `unknown_effect` とする。

   Windows の dispatch 再測定の期限は `min(execution ticket の期限, 測定開始 + 150 ms)` とする（N8 の新しい受入上限）。測定前に期限を検査し、UIA / shell / 関連付けの測定後かつ入力 claim 直前にも単調時計で検査する。待ち時間も 5 秒に含み、測定で期限を延長しない。上限に達した測定は失敗として slot を消費し、遅い結果を捨て、入力しない。OS 呼出しが戻らない場合の終了は N0〜N5 に委ね、Stop serial / epoch / helper 世代を claim 直前にも検査する。

8. 元の tool call、提示で拒否確定した native request、承認後の新しい native request を別の相関として監査する。本文・token・authority/context digest を記録しない。`type` は 1 Unicode scalar だけが承認単位であり、複数文字を包括許可しない。既存の先頭での `native_approval_multi_scalar_type`、途中での `partial_type` を維持する。`main/computer-use-controller.ts:4815` は `type` だけを scalar に分割するため、supervised の 2 scalar 以上の `type` は先頭の offer で拒否される（`:4890`）。一方 `set_text` は全文と対象を payload digest に束縛した一回の原子操作であり、一回の承認で全文を書き込む。「複数文字を包括許可しない」は分割した `type` の複数入力をまとめて承認しない意味である。

**代案・理由**: Main の一回限りフラグだけで ordinary ticket を再利用する案は、カード到達によるフォーカス・revision の変更と競合を扱えない。ファイル全体・フォルダ全体に許可する案は Q1 と単発性に反するため採らない。

**N8 で作るもの**: native の private slot、承認測定、3 操作（approve / discard / approved dispatch）、Windows の版 3 receipt、Main のカードとの接続を作る。E2 / E3 の分類・ticket の試験は fixture で作るが、本番の効果 gate は §2.6 の C6 の根拠が揃うまで false にする。Explorer の適格化は N11 である。

### 2.3 上限クラス C の操作ごとの確認

**現状**: `main/computer-use-deny-ruleset.generated.ts:55` の upper 上限は `observe_only` である。`native/deny-ruleset.json:895` 以降は未署名、IDE 等、ブラウザを同じ C の upper 規則に置く。`native/computer_use_effect_classifier.h:927` は observe を ordinary とし、`:1023` は supervised の一般操作を承認にする。`main/computer-use-controller.ts:5738` は mode / maximumMode を以前の束縛と合わせて狭める。

**決めること・推奨案**: 適格で承認能力が揃った C は `supervised` を上限にする。操作の扱いは次のとおりである。

| 操作 | supervised での扱い |
| --- | --- |
| observe、一覧、状態取得 | 入力を起こさない既存の権限内の読取りとして、操作承認は不要 |
| click、invoke、key、type、scroll など、対象へ入力する一般操作 | 毎回 native の `supervised_action` 承認。選択・通常スクロールも省略しない |
| E2 / E3、高リスク確定 | 該当する効果の単発承認。無効な効果 gate なら拒否 |
| E1 / E4、禁止面、secure、分類不能 | 承認で解除しない。拒否または takeover |
| Stop、拒否、承認後の管理上の復帰・再観測 | 入力許可を増やさない制御であり、追加の操作承認は不要 |

V2 ADR §3.6 の「閲覧・選択・整理は無確認」は、将来適格になる署名済みファイルブラウザの `full_access_app` に対する E3 の例外である。supervised の全操作確認を緩める例外ではない。貼り付けの専用承認は既存の別契約を維持し、N8 でまとめて許可する変更はしない。

upper 上限を一括で `supervised` にするとブラウザも上がるため、規則ごとの上限を表現し、複数一致では最も低い上限を採る。ブラウザ規則は `observe_only`、C / unsigned 規則は条件を満たすと `supervised` とする。表を正本に native と Main を同時生成し、golden vector を一致させる。承認経路が閉じた session の fallback は必ず低い側にする。

上限の決定は二段階に分ける。N8-5 の native 列挙と Main 初回許可は、アプリごとの静的な潜在上限を生成表から計算し、Windows の build / handshake の承認能力がなければ提示上限を `observe_only` に下げる。この時点では session 述語を呼ばず、潜在上限を control の許可と解釈しない。start では native が route / eligibility / helper 世代を束縛した後、入力可能な session を返す前に §2.1 の条件 1〜3（能力・route・世代）だけで Windows gate を評価し、C / unsigned の mode と maximumMode を、gate が開けば最大 `supervised`、閉じれば `observe_only` に下げる。条件 4 の操作 mode は start の gate 評価には使わず、入力のたびに Windows の入口で検査する。Main host も start receipt と gate を照合し、controller がこの低い値を保存する。不一致は start 拒否とする。開始後に gate が閉じた場合は host と native が即座に入力を拒否し、controller はカード・plan を失効させ上限を下げる。gate の復旧だけで同じ session を昇格させない。

表の意味変更に伴う Windows ruleset の版・content hash・ledger・native / TS の生成物の整合は N8-5 が担当する（現行の正本契約は `native/deny-ruleset.json:2`）。N7 は生成済みの値を platform × eligibility mode の manifest / Main pin / handshake の版表へ接続して公開する。N7 が古い hash を新しい意味へ流用することはない。classifier、effect lexicon、eligibility ruleset の版を混同せず、macOS の eligibility の版・hash は保持する。

既存 session の `observe_only` を途中で上げない。新しい gate・identity・上限を取得した初回許可と新規 session から適用する。承認カードも mode を引き上げず、Main と native の単調束縛を保持する。

**代案・理由**: スクロールを無確認にする案は、値を変更する wheel 操作を含み、Q1 の各操作確認と一致しない。アプリ単位の包括許可は採らない。V1 のカードと native のカードを一枚に統合する改善も今回は採らない。V2 ADR S4-4 補遺 `:1054` の 2026-10-14 の決定 A（二枚カード）を維持する。supervised の許可可能な入力で V1 plan 対象外なら、V1 カードと native カードが毎回二枚になる（V1 判定は `main/computer-use-controller.ts:5782`）。V1 plan が適用されても native カードは毎回必要である。頻度が低いとは説明しない。複数 scalar の type はカードを出して一括許可するのでなく §2.2 の拒否になる。

**native Document の接続**: 現行 `native/computer_use_native_interlock.h:419` は origin を解決した再分類が ordinary のときだけ例外を通し、approval は `kAnotherRuleRemains` の takeover になる（`:427`）。N8-1 は Windows 承認 gate が成立するときだけ、既存の例外条件（読取り可能、非 web の肯定的証拠、Document、origin unknown。`:339`）と Windows capture の所有・完全性を満たした facts の origin を ordinary に確定して再分類し、approval を offer 判定へ渡す。これにより C / unsigned の native Document の入力も `supervised_action` のカードになる。web / 不明 / 不完全、blocked、承認 gate 不成立は緩めない。再測定・authority も確定後の同じ facts を使い、ordinary ticket への落下を禁止する。共有 strict 写像の既定は変えず Windows の承認入口を追加し、macOS の期待値を維持する。

**N8 で作るもの**: 上限の分離、契約型の supervised 対応、native / Main の一致試験、操作表と単調束縛の回帰試験を作る。darwin の規則・mode を変更せず、Windows の期待値を変える試験には変更理由を明示する。

### 2.4 未署名アプリの digest 束縛

**現状**: `native/deny-ruleset.json:282` の通常 root の route は valid / unsigned を含むが、署名 invalid を同じものとして認めない。`:898` は unsigned を C とする。`main/computer-use-grant-identity.ts:192` は Windows の signerDigest がない場合を unverified とし、path と executableDigest を grant digest に含める。`:378` の照合は identity / path の変化と未署名 digest の不一致を拒否する。

**決めること・推奨案**: 「未署名」と「検証不能」を混同しない。native が unsigned と確定し、必須 facts、実行中イメージと検証ファイルの対応、root、ユーザー・integrity・session、禁止クラスの検査を通ったものだけを digest 完全一致の supervised にする。signature invalid、facts 欠落、W-UR は拒否のままであり、Main の unverified 表示を許可根拠にしない。

native は file handle に結び付いた executable digest と実行中 identity を start / resume / 入力前、および承認交換・消費時に照合する。path 上の別ファイルを hash して一致したことだけでは通さない。digest、file identity、署名区分が変われば進行中の session・承認を失効させ、保存 grant も再利用しない。新しい digest のアプリとして、再列挙と初回許可カードから確認し直す。カードに「このアプリは署名で本人確認できません」「更新・変更後は再確認が必要」を表示する。加えて「確認するのは主実行ファイルの一致であり、DLL・プラグイン・スクリプト等の安全性は保証しない」と明示する。digest 束縛をアプリの全構成や挙動の検証と表現しない。

**代案・理由**: path または表示名だけの束縛は、同名ファイルの置換を防げない。未署名をすべて許可する案は W-UR と Q2 を壊す。一律 observe_only を継続する案は安全だが、D-7 の目的を満たさない。

**N8 で作るもの**: §2.3 の上限変更と digest 再検証の接続、カードの説明、digest 変更・署名区分変更・同名置換・旧承認の負例を作る。既存の Windows v2 package identity の例外を未署名へ広げない。実行中イメージ照合の土台は再実装せず、その不一致で入力 0 件になることを境界試験する。

### 2.5 実行ファイル・インストーラを承認で通さない

**現状**: `native/computer_use_effect_classifier.h:959` は E1 / E4 の拡張子を E2 / E3 より先に拒否し、`:979` はインストール語の実行を拒否する。`:950`、`:955`、`:957` は secure / credential / surface を拒否する。`native/deny-ruleset.json:765` 以降に W6 の規則がある。`native/computer_use_native_interlock.h:390` の strict 写像では `kApproval` が `kOrdinary` と同じ「拒否なし」になる。現状の Windows preflight の普通 ticket 発行と合わせると、v2 有効化前に承認を捕捉する必要がある。

**決めること・推奨案**: アプリ適格性と操作効果を二重に検査する。W-SYS、W4、W6、W7、W8、W9、W10、W-PX、W-UR 等の拒否は最優先で、承認を発行しない。W6 の manifest / leaf / class、root の制限、署名の有効性は既存の拒否境界として維持する。署名が有効な installer、Microsoft 署名の実行物であっても E1 / E4 の例外にはしない。

現行の辞書 `native/computer_use_effect_classifier.h:268` / `:277` には `.msu .msp .mst .appinstaller .application .scf .chm .diagcab .xll .iso .img .vhd .vhdx .library-ms .search-ms .searchconnector-ms .rdp` がない。N8-1 はこれらに加え `.ppkg .jnlp .wsc .sct .ws .ahk .au3 .rb .pl` を E1 に追加し、インストーラ型 `.msu .msp .mst .appinstaller .application .ppkg` を E4 にも追加する。既存の E1 内の `.appx` も E4 に揃える。辞書は閉じた完全リストによる安全証明ではなく拒否の最低線である。effect lexicon の版・digest と対応する fixture を同じ PR で更新し、classifier 2 というアルゴリズム版とは区別する（現行の版と digest は `:66`, `:323`）。effect lexicon の版は platform 共通の単一定数（`native/computer_use_effect_classifier.h:66`）であり、digest も共有表と版から計算し pin する（`:307`, `:319`, `:328`）。N8-1 で共通の版と pinned digest を上げ、macOS の承認 fixture・harness の版固定も同じ PR で更新する。追加拡張子で macOS の拒否が増えることは意図した変更として回帰試験に記す。追加拡張子以外の承認・拒否期待は維持する。これは platform 別 eligibility の版とは別であり、macOS の eligibility の版・hash は保持する。

preflight / approve / approved dispatch の 3 境界で、拡張子辞書に加え、解決した実パスに対する関連付けを fail-closed に検査する。`AssocIsDangerous`、`ASSOCSTR_EXECUTABLE` による handler、`PerceivedType=application` 等を組み合わせ、実行・インストール・スクリプト・遠隔起動に該当すれば拒否、照会失敗・未対応 handler・証拠不足なら takeover とする。handler が exe であるというだけでは文書 viewer と区別できないため、通常文書を表示する handler と証明できた組だけを扱い、それ以外を許可しない。API の false 一つを安全性の証明にしない。検査する verb は、その入力が実際に呼ぶ既定 verb に限り、UserChoice / ProgID を解決する。DelegateExecute・DropTarget・シェル拡張の既定項目は takeover とする。handler の実行ファイルと `ASSOCSTR_COMMAND` のコマンド全体、関連付けの測定結果を authority に束縛し、変更を拒否する。許可表との一致は引数まで含め、exe の一致だけでは通さない。N8-1 の成果物として文書 viewer の許可リスト（型と handler の組、許すコマンド・引数、確認済み署名主体）を持ち、署名の有効性と主体を測定して照合する。許可表は effect lexicon と同じ版・digest の管理下に置き、digest 計算の入力にも含め、fixture と同じ PR で更新する。実機の測定が揃うまで handler が判断できないものは takeover とする。未知の拡張子、曖昧な実パスも takeover とする。関連付けによる実行は拒否側に置き、この検査後に残るリスクは無害な型の悪性文書である。

シェルビュー外（IDE のツリー等）でも E1 / E4 の拒否を省略しない。表示名の実行拡張子や install 語は拒否側の手掛かりとしてのみ使える。表示名が文書らしいことを承認の肯定根拠にしない。開く操作で実パスと関連付けを確定できなければ takeover とし、supervised の一般操作へ読み替えて逃がさない。

`kApproval` を ordinary ticket に落としてはならない。Windows v2 preflight は classifier の元の decision を保持し、`kApproval` は有効な効果に限り offer、それ以外は拒否にする。ordinary dispatch 側も再分類で `kApproval` が出たら入力しない。承認後の専用経路だけが、同じ `kApproval` と execution ticket の一致を消費できる。共有 strict 写像を「承認済み」の証明と解釈しない。Main だけが見た highImpact と surface の拒否も維持する。

**2-A の高リスク確定と V1**: Windows の現行 V1 は `native/computer_use_windows_host.cc:9254` で単一 high-impact bit を判定する。N8-1 で Windows 専用の分割表を作り、要素・祖先の risk を confirmation / other に分ける。共有の macOS 語彙表は拡張せず、macOS の `ClassifyHighImpactText` をそのまま流用しない。Windows V1 の `ContainsWindowsRiskText`（`native/computer_use_windows_host.cc:8715`）の全語、すなわち substring の 36 語、bounded の payment_terms 15 語と shell_terms 9 語（`:8757`, `:8765`）と、Windows の confirmation / other の和集合が完全一致することを凍結コピーとの比較で harness に固定する。substring / bounded の照合条件も維持する。`pwsh` / `wsl` 等の Windows 固有語と分類できない語は other 側に置く。macOS の語彙・期待値は変えない。macOS 相当の `native/computer_use_native_approved_risk.h:159` の契約を適用し、真正な execution ticket を検証した approved dispatch だけが、効果が `high_impact_confirmation`、confirmation の肯定的根拠があり other がない場合に、その high-impact 理由だけを緩める。Windows の入口では `metadata_complete=false` を緩和より先に拒否する。現行 Windows は `native/computer_use_windows_host.cc:9254` で完全性を渡し、`native/computer_use_preflight_classifier.h:63` で拒否するが、共有 `NativeRiskBits`（`native/computer_use_native_approved_risk.h:146`）に完全性の欄はなく、`:166` は true を渡す。Windows ではこの true を流用しない。欄を足す場合も darwin の既存値と判定を保ち、Windows の欠落値を true に既定化しない。secure、未分類、terminal / installer / 管理者等の other、Main の根拠だけの highImpact は拒否を維持する。他の三効果・ordinary dispatch は V1 と同じである。承認済みというだけで V1 全体を外さない。N8-2 が ticket 消費後の専用 dispatch へ接続する。`wsl + pay`、`pwsh + checkout`、metadata 不完全 + confirmation のみ、語の混在、偽 ticket、未承認の確定、secure、本文未読の負例を固定する。

**代案・理由**: 署名済みなら実行を認める案、人が許可すれば W クラスも解除する案は Q1 に反する。strict 写像だけを変更して macOS の正当な承認を一律拒否する案も採らない。

**N8 で作るもの**: decision を失わない Windows 分岐と、E1 / E4 優先、偽 ticket、承認後に文書から実行物へ変化、kApproval の ordinary dispatch 拒否の試験を作る。N7 はこの試験の PASS を有効化の前提にする。

### 2.6 C5 の 2-A、C6 と人の根拠

**現状**: V2 ADR `:841` と `:946` は初回有効化を `high_impact_confirmation` / `supervised_action` に限定し、E2 / E3 は C6 の実機根拠まで閉じる。現在の Windows の二つの false は `native/computer_use_windows_host.cc:10947` にある。`native/computer_use_effect_measurement.h:398` は ruleset と attest を使って offer を判断する。pure の測定関数があることは実機で対象が正しく読める証明ではない。

**決めること・推奨案**: Windows も 2-A → C6 の順を守る。macOS の AX の測定を Windows UIA の合格証明に流用せず、platform ごとの根拠を揃える。#777 は実測項目・観測結果の参照先であり、本 ADR は資料に含まれない結果を PASS と推定しない。Windows の不足分は N12 と人の受入で補う。

| 段階 | 人が実機で確かめること | 自動試験で確かめること | 公開条件 |
| --- | --- | --- | --- |
| 2-A | IDE 等の一般操作と高リスク確定を正しい対象として表示すること。通常操作の過剰停止、統合ターミナル等の拒否、非自動フォーカス、承認・拒否・期限切れ・Stop、承認前後の対象復帰。UIA の測定待ちと Stop の体感・期限を対象 build で記録する | 判定表、ticket の寿命と束縛、入力 0 / 1 件、mode、未知 facts、cancel と競合、旧 helper 応答、receipt 検証 | Windows の根拠と N8 の試験が揃ってから N7 が platform 別版・attest を接続する |
| C6 | ダウンロード面と Explorer の invoke、Enter、ダブルクリック、視覚クリック、メニュー、Open with、ドラッグについて、開く・選択・リネーム等の実際の効果、UIA の対象・祖先・拡張子、言語と関連付けを確認する。画面外に事前選択がある仮想化一覧を含め、複数選択・別項目の事前選択でカードが出ず入力もないことを確かめる。未対応経路も明記する | 各入力経路の fixture、画面外に事前選択がある仮想化一覧、複数選択・事前選択・選択数取得失敗・三境界間の選択変化、E1 / E4 の優先、未知拡張子、対象すり替え、承認 replay、効果 gate が false の拒否 | N12 の実測と C6 の人の根拠を確認後、N11 が必要な対象・効果だけを有効化する |

人の記録は OS / build / アプリ版 / 操作 / 期待と実際 / 証拠 / PASS・FAIL・SKIP・BLOCKED を持つ。合成文書を使い、秘密・本文をログや fixture に残さない。UIA tree が読めることだけで、入力効果や誤承認防止を PASS にしない。未証明の経路は閉じる。browser の sensitive origin（#777 の実測 6）は N12 / N11 の前提であり、N8 の完了だけで解除しない。

**代案・理由**: 四効果の同時有効化、自動 harness だけで C6 完了とする案は、UIA が示すものと実アプリの動作の差を検証できないため採らない。macOS の全作業完了を Windows の条件にする案も採らず、共有コードの回帰と Windows 固有の人の根拠を条件にする。

**N8 で作るもの**: 2-A / C6 を独立に閉じられる効果 gate と試験、上表に沿った Windows 受入項目を作る。C6 未達でも経路の実装はレビューできるが、#988 AC-4 の E2 / E3 の実利用完了とは報告しない。

### 2.7 承認中の Stop と helper 世代

**現状**: `main/computer-use-controller.ts:3895` は pending approval を取り消し、`:5027` は承認遷移中の abort / session / epoch / Turn / 期限を検査する。`main/computer-use-native-windows.ts:263` は helperGeneration を保持する。現在の portable intent（`native/computer_use_native_approval_ticket.h:36`）に helperGeneration はなく、Windows の承認経路自体も未実装である。

**決めること・推奨案**: helper の世代に ticket を束縛する。名前は現行 client と kill-stop 草案に合わせ `helperGeneration` とし、N0〜N5 の確定契約に合わせて wire 上の表現を調整する。sessionId が UUID だから十分、とはしない。Main の session / pending approval / dispatch の所有者は helper 世代を保持し、native の slot もその接続世代から持ち出せない構造にする。共有 portable 型を変更する場合は、darwin には従来の束縛を保つ明示的な経路を設け、Windows の検査を default 値で省略できないようにする。

Stop 要求で Main のカードを直ちに無効化し、以後 approve / dispatchApproved を送らない。native は cancel epoch と元 frame の Stop serial を、測定後の slot 採用・入力 claim の直前に再検査する。承認中の待ちが Stop を待たせてはならない。worker の遅い結果は自分の session / helper / approval 世代が生きているときだけ採用する。

helper 世代が失われたら、その helper の全 session の pending / ready ticket とカード、route 束縛を失効させる。旧 helper の応答・カード・approve の成功結果を新 helper へ転送しない。新世代は再列挙・再観測と新しい許可の検査から始める。discard の送信先が既に消えていても Main の失効を保ち、新 helper に同じ discard を送らない。

Stop の確定、終了確認の期限、未確認入力の対象隔離は N0〜N5 の責務である。N8 はそれを解除しない。`dispatchApproved` を送った後は、その応答が無ければ未確認 control として停止側へ渡す。helper の終了は、既に送った SendInput や UIA 呼出しの効果を取り消す証拠ではない。対象隔離を解除する承認と操作 ticket の承認を同じ権限として扱わない。

**代案・理由**: sessionId だけの照合や再接続後の自動再送は、古い承認の復活・二重入力を招く。N8 に独自の kill / Stop 確定を追加する案は責務を重複させるため採らない。

**N8 で作るもの**: 世代を伝える接点、全カードの失効、旧世代の遅延応答拒否、approve 成功と Stop の競合、dispatch 後の不明効果の試験を作る。停止土台の実装自体には手を広げない。

### 2.8 承認 UI とキーボード

**現状**: `renderer/components/ComputerUsePanel.tsx:1333` の承認 section は polite live region で、`:1395` の許可ボタンには autoFocus がない。`main/ipc.ts:4915` は非表示なら showInactive、pending の変化で flashFrame を呼ぶ。`renderer/components/ComputerUsePanel.interaction.test.tsx:438` はカード出現・解決時にキーボードフォーカスを奪わないことを試験する。`main/computer-use-controller.ts:4938` は native の残り時間以下にカード期限を制限し、`:4955` は plan 不可・allow_once / deny を固定する。

**決めること・推奨案**: 既存カードの枠と activation 経路を Windows に使い、表示欄は §2.2 の native 測定由来情報と §2.4 の警告を追加する。カードの表示内容まで現状のままとはしない。カード生成時には許可にも拒否にも自動フォーカスを置かない。Windows でも Electron の showInactive と flashFrame により、前面で入力しているアプリからフォーカスを奪わず通知する。show + focus への fallback は作らない。通知が目立たない場合でも、無操作で許可しない。

人がアプリへ移り、Tab / Shift+Tab またはクリックで明示的にボタンへ到達した後、Enter / Space / クリックで決定する。trusted activation の消費と intent 一致を必須にし、カード出現直前から押されていたキーで許可されないことを確認する。拒否・期限切れ・Stop 後のボタンと古いカードは承認不能にする。polite の読み上げ、対象・効果のラベル、light / dark、フォーカス表示、Stop への到達を保持する。

**代案・理由**: show + focus、許可ボタンを既定にする案は、別アプリでの通常の Enter を承認へ転用し得るため採らない。OS ダイアログへ置換する案は既存 activation と会話内の状態を二重管理するため採らない。

**N8 で作るもの**: §2.2 と §2.4 の表示、Windows の通知接続の確認、Renderer の回帰試験と Windows 実機の Computer Use 受入を作る。自動テストは trusted activation の偽造拒否を証明し、別アプリからフォーカスを奪わない OS の挙動は人の実機証拠で証明する。

## 3. N8 の実装スライス（PR の単位）

N1 とオーナー承認の後、次の順で進める。各 PR は一つの境界をレビューできる大きさにし、本番 Windows V2 の有効化は N7 に残す。振る舞いを変えるスライスは回帰テストの RED → GREEN を記録する。

| # | 境界と成果 | 依存 | 試験・完了の証拠 |
| --- | --- | --- | --- |
| N8-1 | native の測定・判定核: Windows facts 入力への分離、Document の条件付き再分類、E1 / E4 辞書と共通 lexicon 版・pin・macOS fixture / harness の更新、型と handler・引数・署名主体の版管理された文書 viewer 許可リスト、実パスの関連付け・E3 単一選択の測定、V1 approved-risk の限定緩和。能力は未公開 | N1、本 ADR 承認 | C++ harness / Windows seam。四効果の gate 表、authority / payload 変更、AX 入口の誤用、chain 所有不明、非 web 不明、Document approval の takeover 落ち、画面外に事前選択がある仮想化一覧、シェル選択の取得不能・UIA 不一致、複数選択・別項目の事前選択・選択読取り失敗・三境界での変化、追加拡張子全件、危険・不明・変更された関連付け、IDE の未知実パス、Windows V1 凍結コピーとの和集合・照合条件一致、wsl + pay、pwsh + checkout、metadata 不完全 + confirmation のみ、confirmation / other 混在、secure の負例。macOS の追加拡張子の拒否増加とその他の承認期待維持 |
| N8-2 | wire 契約の一体変更: C++ MessageType と TS MessageType、能力宣言、Windows の新 offer receipt / strict schema、内部型と表示 contracts を同一 PR で追加する。helper の approve / discard / approved dispatch、private slot、世代・Stop claim、N8-1 の再測定と approved-risk を接続する。本番 gate は閉じる | N8-1、停止側の世代契約 | MessageType の名前・数値の完全一致、receipt の不明欄・欠落・不正表示値、四効果それぞれの display 欠落・余剰欄・不許可 null・列挙値不一致、RLO ファイル名、macOS の旧 receipt と既定表示 null、60 秒 / 5 秒、境界時刻・逆行・overflow、150 ms 超過・測定中期限切れ、replay、世代違い、Stop 競合、無応答の control 所有者、kApproval の ordinary ticket 発行・dispatch 拒否、ordinary 入力 0、approved 入力は一度以下 |
| N8-3 | TS の実行接続: N8-2 の確定済み wire を使う Windows transport / adapter / host と gate。MessageType の片側追加や schema の後追いをしない | N8-2 | contracts / host / transport の単体・結合。欠落能力、版不一致、v1 / unbound、darwin の述語不変、旧 helper、入力前失敗と unknown_effect の区別 |
| N8-4 | TS: controller の既存 native カードへの接続、表示情報の転送、helper 世代失効、監査相関 | N8-3 | approval-path / native-host-approval / controller / activation / persistence。承認後再観測、拒否、期限、Stop、plan 対象外で毎回二枚、native plan 不可、複数 scalar type 拒否、set_text 全文の単発束縛、本文・token 非露出 |
| N8-5 | native・TS の上限表: C / unsigned と browser の分離、Windows ruleset の版・hash・ledger と生成物、列挙・初回許可・start・開始後の低下、digest 再確認。本番適用は gate 成立時のみ | N8-4 | 同一 golden vector の native / Main 一致、開始前能力なし・start route v1・開始後 gate 消失、browser observe_only、Explorer 不適格、unsigned digest 変更、invalid 署名拒否、旧 session 非昇格、grant identity |
| N8-6 | UI: 既存 activation 経路のまま表示欄を追加し、通知・キーボードと 2-A / C6 の受入項目を揃える | N8-4、N8-5 | Renderer interaction / activation と Windows Computer Use。測定情報・ラベル未検証の一般操作・E2 / E3 の必須表示、RLO ファイル名の無害化と独立拡張子欄、主イメージ限定の警告、別アプリ入力中の通知、明示 Tab、キー継続、拒否・Stop・期限、light / dark。結果と artifact を残す |

現行 `main/computer-use-windows-transport.test.ts:2518` は TS の全 MessageType と C++ enum の名前・数値の完全一致を強制する。したがって N8-2 を native だけの変更にはしない。N8-2 の wire 定義・producer・parser・fixture を一体で緑にし、N8-3 はそれを呼び出す接続だけを追加する。各スライスは後続 PR を待たず単独で検証可能である。

各スライスで対象 typecheck と直接関連テストを実施する。native の Windows 試験と実機受入は、対応した実行環境で行い、未実行を PASS にしない。共有変更では既存 macOS の approval-path、native-host-approval、native-classifier-route、approved-risk、preflight-offer、grant-identity、controller、Renderer interaction と portable harness の関連ケースを維持する。Windows を常に拒否する旧テストだけは、新しい条件付き gate の真偽表として意図を明示して更新する。darwin の期待を緩めて通さない。

N7 は N8-1〜6 と Windows の 2-A の根拠を確認し、platform × mode の版、interlockEnforced、build / CI の公開条件を一つの有効化 checkpoint で検証する。macOS の eligibility の版は一緒に上げない。N8-1 の共通 effect lexicon の版更新とは区別する。N11 は N12 と C6 の根拠の後で browser / Explorer の適格性と E2 / E3 の効果 gate を接続する。N8 の fixture で E3 が通ることを Explorer 公開の証明としない。

## 4. オーナーに判断してもらうこと

D-7、AC-4 / V2 Q1 の「E2 / E3 は単発承認、上限クラスは操作ごとの確認」と実行物拒否、C5 の 2-A → C6 の公開順序、S4-4 補遺（V2 ADR `:1054`、2026-10-14）の二枚カードは既決事項であり、再承認を質問しない。supervised の plan 対象外の入力では毎回二枚、複数 scalar の type は拒否されるという前提で、次の設計上の判断だけを求める。

1. §2.1 の Windows gate を採用するか。
2. §2.2 の E3 の選択集合を対象一項目へ限定する方針を採用するか。事前に単一選択されていない状態のダブルクリックや invoke による「開く」は takeover となり、承認カードも出ないという制限を含む。
3. §2.2 の approved dispatch 再測定を ticket 残時間内かつ最大 150 ms とするか。
4. §2.2 の Windows 用表示 receipt と macOS の旧形を維持する契約分岐を採用するか。
5. 操作ごとの確認という既決方針の粒度として、§2.3 の選択・通常スクロールも毎回の確認に含めるか。
6. §2.3 の条件を満たす native Document の再分類 approval をカードへ接続する案を採用するか。
7. §2.4 の digest 変更時に初回許可からやり直す方式を採用するか。
8. §2.5 の関連付けの fail-closed 検査後にも残る、無害な型の悪性文書のリスクを受け入れるか。関連付けによる実行の受け入れは求めない。実機測定で型と handler の許可リストが揃うまでは、判断できない handler は takeover となり、E2 / E3 は当面、承認にほとんど到達しない制約も含めて判断を求める。
9. §2.7 の ticket と helper 世代の束縛を停止側の確定契約へ接続する案を採用するか。
10. §2.8 の既存非自動フォーカス経路を Windows に適用するか。
11. §2.8 の追加表示欄を採用するか。
12. §2.3 の二段階の上限決定を採用するか。
13. §3 の PR 分割を採用するか。

### 4.1 承認後に V2 ADR へ反映する箇所

今回は V2 ADR を編集しない。オーナー承認後、以下を別の文書変更で更新する。設計承認を実装済み・有効化済みと記述しない。

| 箇所 | 更新内容 |
| --- | --- |
| §3.2.4 mode の bullet（現行 `:252`） | C / unsigned の一律 observe_only を、本 ADR の gate が開いた新規 session では supervised、閉じていれば observe_only とする設計へ置換する |
| §4 Windows 注記 (1)（`:446`） | 同じ条件付き上限と主イメージ digest の束縛を参照する。(2) browser と (3) Explorer の制限は N11 / N12 まで保持する |
| §10 S5-c-3 判断 C（`:1174`）、Q2 の Windows との関係 | 「承認経路ができるまで」の条件を本 ADR に接続し、実装・有効化の状態は N8 / N7 の証拠に従って記録する |
| §9 C5 / C6（`:841`）、S4-4 補遺 | Windows の gate・表示 receipt・Document・approved-risk の接続と platform 別の人の根拠を追記する。darwin の入力・真偽表と ticket 契約を維持する |
| S4-4 補遺の二枚カードの頻度（`:1054`） | 決定 A は維持し、supervised の plan 対象外では毎回二枚になることを明記する |
| 冒頭の変更概要の判断 C と改訂履歴 | 本 ADR 承認による設計変更と N8 / N7 の実装・公開を区別して記録する |

## 5. 受入と未確認事項

この Draft は #991 の設計成果であり、Windows の承認が動作したという報告ではない。コード変更、build、実 Provider、実機操作はこの ADR 作成では行っていない。独立レビュー、Review BOT、要塞レビュー、PR、オーナーの設計承認は親の工程である。

現状の根拠は各 §2 の file:line に記載した。N1 による移動後はシンボルを追い、Windows の分割先と行を更新する。kill-stop の正式な wire / generation 通知名は別 PR の確定結果と合わせる。#777 / N12 の人の実測結果、Windows の 2-A と C6 の PASS は未確認であり、§2.6 の公開条件として残る。

## 6. 改訂履歴

- 2026-11-02: Windows の承認 gate、単発 ticket、上限規則、digest 束縛、Stop との接点、承認 UI の設計を記載した。照合基準は 1899ca3c である。
- 2026-11-02: 辞書・関連付け、単一選択、Windows facts、Document、V1 の限定緩和、表示契約、二段階の上限、版・hash、実装スライス、既決事項と V2 ADR 更新先を明文化した。
- 2026-11-02: Windows 専用リスク語彙と完全性の拒否、効果別表示、シェル選択の正本、既定 verb と handler 許可リスト、共通 lexicon の更新範囲を定めた。操作粒度と E2 / E3 の制約、start と入力時の検査を区別した。
