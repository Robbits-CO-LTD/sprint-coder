# ADR: Computer Use Windows — 単発承認と supervised の承認経路

- Status: Draft（オーナー承認の前。設計の推奨案であり、有効化の承認ではない）
- Date: 2026-11-02
- Issue: #991（Refs #988, #500）
- 関連: `tasks/designs/adr-computer-use-agent-driven-v2.md`（以下、V2 ADR）§3.2.3〜§3.2.5、§3.6、§4、§9 C5 / C6、S4-4 承認 ticket の契約と補遺、§10 Q1 / Q2
- 接点: `tasks/designs/adr-computer-use-windows-kill-stop-20261102.md`（別 PR で進行中。現 checkout の実装済み契約とは扱わない）
- 現状の照合基準: `1899ca3c187bdf4cc212e2dad1f282bbe1eeb6e5`。以下の `file:line` はこの版を指す。`main/` は `apps/desktop/src/main/`、`native/` は `apps/desktop/computer-use-native/`、`renderer/` は `apps/desktop/src/renderer/` の略記である。

## 1. 問題と範囲

Windows には ordinary ticket の経路があるが、人の承認を native の単発 execution ticket に交換する経路がない。V2 ADR の判断 C は、この間、上限クラス C と未署名アプリを `observe_only` に下げている。#988 D-7 の承認済み方針に従い、N8 で経路を作るための設計を定める。N8 の着手は本 ADR のオーナー承認と N1（host.cc の分割）の後である。

成果は、危険な操作に「今回のみ許可」を出し、同じ対象・同じ操作だけを一度実行できる設計である。E2 / E3 は単発承認、上限クラス C と適格な未署名アプリは操作ごとの確認にする。実行ファイル・インストーラを開く E1 / E4 は、人が承認しても拒否する。承認はアプリの初回許可や Provider への送信同意を代替しない。

本 ADR は設計だけである。ブラウザ・Explorer の有効化は N12 の実測後の N11、背景操作は N9a、Stop の土台は N0〜N5 が担当する。N8 はそれらとの接点を作るが、対象の拡大や停止方式の決定を引き取らない。N7（PR-6）は N8 の経路と検証を前提に Windows V2 を有効化する。release の切替は別工程である。

## 2. 決定（案）

### 2.1 Windows で承認経路を開く条件

**現状**: `main/computer-use-eligibility.ts:143` の `computerUseApprovalPathEnabled` は darwin、承認メソッドの存在、classifier 2、route v2、実効 `v2-denylist` を要求する。`main/computer-use-native-host.ts:561` は session の束縛がなければ `unbound` にし、`:566` で同じ述語を使う。`:571` は preflight / approvalApprove / approvalDiscard / dispatchApproved の全存在を要求する。`main/computer-use-eligibility.ts:114` の attest は gate-open とコンパイル済み classifier 2 に由来する。`main/computer-use-native-windows.ts:131` は preflight を配線するが、承認メソッドはまだ配線しない。

**決めること・推奨案**: Windows も同じ session 単位の述語で開く。ただし `platform === 'win32'` を加えるだけにはしない。次のすべてが成立したときだけ開く。

1. Main の pin、manifest、native handshake の platform 別 eligibility が一致し、パッケージ・署名・provenance の gate が開いている。classifier は正確に 2、`ticketRequired` と Windows V2 の `interlockEnforced` は true である。現在の比較関数が未実装の attest を検査済みだとは扱わない。`interlockEnforced` と版表の本番接続は N7 が担当する。
2. Windows adapter と接続先 helper の双方に承認の全操作があり、wire 契約と版が一致する。TS に関数を置いただけでは能力の証明にならない。helper の承認能力を handshake で検査し、欠落・未知の版では閉じる。
3. 現在の helper 世代に属する生きた session が route v2、実効 `v2-denylist` に束縛されている。route v1、未束縛、失敗した start、close 済み、旧 helper 世代では閉じる。
4. control のある session で、操作 mode が `supervised` または `full_access_app` である。`observe_only` はカードから昇格できない。eligibility の mode と操作 mode は別の値として検査する。

環境変数、Renderer、モデルの指定では開かない。force-v1 は閉じる方向だけに使う。承認経路が利用不能なら、C / 未署名の control は公開せず、拒否または `observe_only` に留める。

**代案・理由**: OS 名だけで開く案、旧 preflight に TS の承認を足す案は、native が単発性を保証しないため採らない。macOS と別の承認仕様にする案も、共有 controller の監査・再検証を分岐させるため採らない。

**N8 で作るもの**: helper の能力宣言と wire 操作、adapter のメソッド、session / helper 世代を含む gate、未実装能力の負例を作る。本番版を上げる N7 より前は、試験用 build / fixture だけで経路を駆動する。共有述語の既存 darwin の真偽表、v1 / unbound の拒否は維持する。

### 2.2 E2・E3 の単発承認と ticket

**現状**: `native/computer_use_windows_host.cc:10947` の ruleset は download_open / file_manager_open を false に固定する。`:11020` の binding 検査後、`:11037` で interlock を評価し、拒否がなければ `:11057` から ordinary ticket を作る。`native/computer_use_effect_classifier.h:993` は面、開く効果、対象、拡張子から E2 / E3 を分類する。拡張子不明は `:1005` で takeover である。macOS の承認測定は `native/computer_use_macos.mm:5821` と `:6729`、portable な測定は `native/computer_use_effect_measurement.h:381` にある。

**決めること・推奨案**: Windows native の preflight、承認交換、承認後 dispatch の各境界で、同じ capture と classifier により対象を測定する。N1 後の分割先は実装時に追跡するが、現在の `HandleWindowsPreflight` と `EvaluateWindowsInterlockOnLane` に相当する境界を正本とする。Main の文言やモデルの「文書である」という申告では判定しない。

- E2 はダウンロード面の祖先と開くコントロール、E3 はファイルブラウザ面の項目と既定アクションに結び付ける。UIA の要素・祖先、面、対象ファイルの拡張子、操作種別を取得する。座標クリックもその位置の対象を解決する。表示名だけの拡張子推測、他の項目の filename の流用は不可である。
- native が対象を一意に結び付けられない、読み切れない、拡張子が不明、origin / 面が不明なら takeover とし、確認カードを安全性の代用にしない。入力経路ごとの実測を通っていないものは閉じたままにする。
- カードには対象アプリ（表示名はアプリ提供値と区別）、操作「ダウンロードを開く」または「ファイルを開く」、対象項目の安全に表示できるラベルと拡張子、外部アプリが開く可能性、残り期限を示す。入力本文やファイル内容は取得しない。対象ラベルが検証できなければ承認しない。内部 path / PID / HWND / token / authority digest は Renderer・モデル・会話・監査へ出さない。必要な表示情報は native の測定結果から専用の表示用データとして Main が検査・無害化し、命令として扱わない。
- native のカードは `allow_once` / `deny` のみで、plan grant、今後も許可、タスク全体の許可を作らない。`full_access_app` も E2 / E3 を省略できない。

**ticket の共通契約**: V2 ADR S4-4 と補遺、および `native/computer_use_native_approval_ticket.h:36`、`native/computer_use_native_approval_flow.h:120` を引き継ぐ。

1. native 内に session ごとの pending / ready slot を置く。intent / execution token は native の CSPRNG で作り、helper の外に出さない。Main は sessionId / approvalGeneration と helperGeneration の組で参照する。ordinary ticket と承認 token を交換しない。
2. intent は session、Task、Turn、元の request ID、action / payload digest、authority digest、cancel epoch、approval generation、元の観測 revision / ticket generation、classifier / ruleset / lexicon 版、効果クラスに束縛する。Windows の authority は検証済みの実行中 identity、PID と作成時刻、window、geometry、対象要素・祖先・面・origin・拡張子と効果を版付きで構成する。helper 世代も参照と検証の束縛に含める。revision 入りの context digest で authority を代用しない。
3. intent の期限は native の単調時計で最大 60 秒、カードは残り時間以下である。approval ID / revision / challenge / decision / Task / Turn に束縛した trusted activation を Main が消費した後だけ、同じ対象へ復帰して再観測する。
4. Main の Stop、policy、grant、Provider 送信同意、session / Turn、gate を再検証する。native は identity、mode、focus、geometry、payload、authority、効果、版、epoch / 世代を測り直す。新しい観測 revision と ticket generation は元より大きく、実行 request ID は元と異なる。変更時は再承認を自動発行せず拒否または takeover とする。
5. `approvalApprove` は入力せず、intent を消費して execution ticket を作る。有効期間は最大 5 秒と intent の残りの短い方である。新しい request ID / revision / ticket generation / context digest に束縛する。交換後から `dispatchApproved` まで observe / preflight / refocus を挟まない。
6. `dispatchApproved` は入力直前に再測定し、単発で ticket を消費する。再分類結果が同じ `kApproval` であること自体は拒否理由にしない。効果が普通の操作へ変わった場合も、承認した効果と異なるので拒否する。ordinary dispatch は承認 ticket を受け付けず、ticket 不備から旧 dispatch へ戻らない。
7. 同じ approval generation の試行は成功・失敗とも使い切る。異なる世代の遅延応答で新しい slot を壊さない。replay / in-flight を消費より先に処理し、timeout 後に入力を再送しない。`approvalApprove` / discard の失敗は入力前の拒否、`dispatchApproved` 後の無応答は `unknown_effect` とする。
8. 元の tool call、提示で拒否確定した native request、承認後の新しい native request を別の相関として監査する。本文・token・authority/context digest を記録しない。`type` は 1 Unicode scalar だけが承認単位であり、複数文字を包括許可しない。既存の先頭での `native_approval_multi_scalar_type`、途中での `partial_type` を維持する。

**代案・理由**: Main の一回限りフラグだけで ordinary ticket を再利用する案は、カード到達によるフォーカス・revision の変更と競合を扱えない。ファイル全体・フォルダ全体に許可する案は Q1 と単発性に反するため採らない。

**N8 で作るもの**: native の private slot、承認測定、3 操作（approve / discard / approved dispatch）、版 2 receipt、Main のカードとの接続を作る。E2 / E3 の分類・ticket の試験は fixture で作るが、本番の効果 gate は §2.6 の C6 の根拠が揃うまで false にする。Explorer の適格化は N11 である。

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

既存 session の `observe_only` を途中で上げない。新しい gate・identity・上限を取得した初回許可と新規 session から適用する。承認カードも mode を引き上げず、Main と native の単調束縛を保持する。

**代案・理由**: スクロールを無確認にする案は、値を変更する wheel 操作を含み、Q1 の各操作確認と一致しない。アプリ単位の包括許可は採らない。V1 のカードと native のカードを一枚に統合する改善も今回は採らない。既存の二枚になり得る経路を維持し、V1 の plan grant は native の承認を省略しない。

**N8 で作るもの**: 上限の分離、契約型の supervised 対応、native / Main の一致試験、操作表と単調束縛の回帰試験を作る。darwin の規則・mode を変更せず、Windows の期待値を変える試験には変更理由を明示する。

### 2.4 未署名アプリの digest 束縛

**現状**: `native/deny-ruleset.json:282` の通常 root の route は valid / unsigned を含むが、署名 invalid を同じものとして認めない。`:898` は unsigned を C とする。`main/computer-use-grant-identity.ts:192` は Windows の signerDigest がない場合を unverified とし、path と executableDigest を grant digest に含める。`:378` の照合は identity / path の変化と未署名 digest の不一致を拒否する。

**決めること・推奨案**: 「未署名」と「検証不能」を混同しない。native が unsigned と確定し、必須 facts、実行中イメージと検証ファイルの対応、root、ユーザー・integrity・session、禁止クラスの検査を通ったものだけを digest 完全一致の supervised にする。signature invalid、facts 欠落、W-UR は拒否のままであり、Main の unverified 表示を許可根拠にしない。

native は file handle に結び付いた executable digest と実行中 identity を start / resume / 入力前、および承認交換・消費時に照合する。path 上の別ファイルを hash して一致したことだけでは通さない。digest、file identity、署名区分が変われば進行中の session・承認を失効させ、保存 grant も再利用しない。新しい digest のアプリとして、再列挙と初回許可カードから確認し直す。カードに「このアプリは署名で本人確認できません」「更新・変更後は再確認が必要」を表示する。

**代案・理由**: path または表示名だけの束縛は、同名ファイルの置換を防げない。未署名をすべて許可する案は W-UR と Q2 を壊す。一律 observe_only を継続する案は安全だが、D-7 の目的を満たさない。

**N8 で作るもの**: §2.3 の上限変更と digest 再検証の接続、カードの説明、digest 変更・署名区分変更・同名置換・旧承認の負例を作る。既存の Windows v2 package identity の例外を未署名へ広げない。実行中イメージ照合の土台は再実装せず、その不一致で入力 0 件になることを境界試験する。

### 2.5 実行ファイル・インストーラを承認で通さない

**現状**: `native/computer_use_effect_classifier.h:959` は E1 / E4 の拡張子を E2 / E3 より先に拒否し、`:979` はインストール語の実行を拒否する。`:950`、`:955`、`:957` は secure / credential / surface を拒否する。`native/deny-ruleset.json:765` 以降に W6 の規則がある。`native/computer_use_native_interlock.h:390` の strict 写像では `kApproval` が `kOrdinary` と同じ「拒否なし」になる。現状の Windows preflight の普通 ticket 発行と合わせると、v2 有効化前に承認を捕捉する必要がある。

**決めること・推奨案**: アプリ適格性と操作効果を二重に検査する。W-SYS、W4、W6、W7、W8、W9、W10、W-PX、W-UR 等の拒否は最優先で、承認を発行しない。W6 の manifest / leaf / class、root の制限、署名の有効性は既存の拒否境界として維持する。署名が有効な installer、Microsoft 署名の実行物であっても E1 / E4 の例外にはしない。

E1 の版管理辞書（`.exe .com .bat .cmd .ps1 .vbs .wsf .reg .lnk .scr .hta .jar` 等）と installer（`.msi .msix` 等）を開く操作は、preflight、approve、approved dispatch のすべてで拒否する。拡張子不明や別名・関連付けの根拠が足りない場合も、承認へ逃がさず takeover とする。無害な拡張子なら任意コード実行が絶対にない、という保証はしない。悪性文書や危険な関連付けは残存リスクであり、人は開く対象と効果を判断する。

`kApproval` を ordinary ticket に落としてはならない。Windows v2 preflight は classifier の元の decision を保持し、`kApproval` は有効な効果に限り offer、それ以外は拒否にする。ordinary dispatch 側も再分類で `kApproval` が出たら入力しない。承認後の専用経路だけが、同じ `kApproval` と execution ticket の一致を消費できる。共有 strict 写像を「承認済み」の証明と解釈しない。Main だけが見た highImpact と surface の拒否も維持する。

**代案・理由**: 署名済みなら実行を認める案、人が許可すれば W クラスも解除する案は Q1 に反する。strict 写像だけを変更して macOS の正当な承認を一律拒否する案も採らない。

**N8 で作るもの**: decision を失わない Windows 分岐と、E1 / E4 優先、偽 ticket、承認後に文書から実行物へ変化、kApproval の ordinary dispatch 拒否の試験を作る。N7 はこの試験の PASS を有効化の前提にする。

### 2.6 C5 の 2-A、C6 と人の根拠

**現状**: V2 ADR `:841` と `:946` は初回有効化を `high_impact_confirmation` / `supervised_action` に限定し、E2 / E3 は C6 の実機根拠まで閉じる。現在の Windows の二つの false は `native/computer_use_windows_host.cc:10947` にある。`native/computer_use_effect_measurement.h:398` は ruleset と attest を使って offer を判断する。pure の測定関数があることは実機で対象が正しく読める証明ではない。

**決めること・推奨案**: Windows も 2-A → C6 の順を守る。macOS の AX の測定を Windows UIA の合格証明に流用せず、platform ごとの根拠を揃える。#777 は実測項目・観測結果の参照先であり、本 ADR は資料に含まれない結果を PASS と推定しない。Windows の不足分は N12 と人の受入で補う。

| 段階 | 人が実機で確かめること | 自動試験で確かめること | 公開条件 |
| --- | --- | --- | --- |
| 2-A | IDE 等の一般操作と高リスク確定を正しい対象として表示すること。通常操作の過剰停止、統合ターミナル等の拒否、非自動フォーカス、承認・拒否・期限切れ・Stop、承認前後の対象復帰。UIA の測定待ちと Stop の体感・期限を対象 build で記録する | 判定表、ticket の寿命と束縛、入力 0 / 1 件、mode、未知 facts、cancel と競合、旧 helper 応答、receipt 検証 | Windows の根拠と N8 の試験が揃ってから N7 が platform 別版・attest を接続する |
| C6 | ダウンロード面と Explorer の invoke、Enter、ダブルクリック、視覚クリック、メニュー、Open with、ドラッグについて、開く・選択・リネーム等の実際の効果、UIA の対象・祖先・拡張子、言語と関連付けを確認する。未対応経路も明記する | 各入力経路の fixture、E1 / E4 の優先、未知拡張子、対象すり替え、承認 replay、効果 gate が false の拒否 | N12 の実測と C6 の人の根拠を確認後、N11 が必要な対象・効果だけを有効化する |

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

**決めること・推奨案**: 同じカードと activation 経路を Windows に使う。カード生成時には許可にも拒否にも自動フォーカスを置かない。Windows でも Electron の showInactive と flashFrame により、前面で入力しているアプリからフォーカスを奪わず通知する。show + focus への fallback は作らない。通知が目立たない場合でも、無操作で許可しない。

人がアプリへ移り、Tab / Shift+Tab またはクリックで明示的にボタンへ到達した後、Enter / Space / クリックで決定する。trusted activation の消費と intent 一致を必須にし、カード出現直前から押されていたキーで許可されないことを確認する。拒否・期限切れ・Stop 後のボタンと古いカードは承認不能にする。polite の読み上げ、対象・効果のラベル、light / dark、フォーカス表示、Stop への到達を保持する。

**代案・理由**: show + focus、許可ボタンを既定にする案は、別アプリでの通常の Enter を承認へ転用し得るため採らない。OS ダイアログへ置換する案は既存 activation と会話内の状態を二重管理するため採らない。

**N8 で作るもの**: §2.2 と §2.4 の表示、Windows の通知接続の確認、Renderer の回帰試験と Windows 実機の Computer Use 受入を作る。自動テストは trusted activation の偽造拒否を証明し、別アプリからフォーカスを奪わない OS の挙動は人の実機証拠で証明する。

## 3. N8 の実装スライス（PR の単位）

N1 とオーナー承認の後、次の順で進める。各 PR は一つの境界をレビューできる大きさにし、本番 Windows V2 の有効化は N7 に残す。振る舞いを変えるスライスは回帰テストの RED → GREEN を記録する。

| # | 境界と成果 | 依存 | 試験・完了の証拠 |
| --- | --- | --- | --- |
| N8-1 | native: Windows capture から approval authority を構成し、portable flow を接続する。preflight の kApproval を ordinary から分離する。通常 build の効果 gate は閉じる | N1、本 ADR 承認 | C++ harness / Windows seam。E1 / E4 優先、未知 facts、authority / payload 変更、ordinary 入力 0、四効果の gate 表 |
| N8-2 | native: helper の approve / discard / approved dispatch と receipt、private slot、Stop claim・世代境界 | N8-1、停止側の世代契約 | Windows seam。60 秒 / 5 秒、境界時刻・逆行・overflow、replay、世代違い、競合、入力は一度以下、無応答の control 所有者 |
| N8-3 | TS: contracts の wire と能力宣言、Windows transport / adapter、厳密な receipt 検査と gate。native と合う schema を同時に揃える | N8-2 | contracts / host / transport の単体・結合。欠落能力、版不一致、v1 / unbound、旧 helper、入力前失敗と unknown_effect の区別 |
| N8-4 | TS: controller の既存 native カードへの接続、helper 世代失効、監査相関 | N8-3 | approval-path / native-host-approval / controller / activation / persistence の関連試験。承認後再観測、拒否、期限、Stop、二枚のカード、plan 不可、複数 scalar、本文・token 非露出 |
| N8-5 | native・TS の共有表境界: C / unsigned と browser の上限分離、supervised 契約、digest 再確認。実際の本番適用は gate 成立時のみ | N8-4 | 同一 golden vector の native / Main 一致、browser observe_only、Explorer 不適格、unsigned digest 変更、invalid 署名拒否、旧 session 非昇格、grant identity |
| N8-6 | UI: 効果・対象・未署名の表示、通知、キーボード。2-A / C6 の受入項目を揃える | N8-4、N8-5 | Renderer interaction / activation と Windows Computer Use。別アプリ入力中の通知、明示 Tab、キー継続、拒否・Stop・期限、light / dark。結果と artifact を残す |

各スライスで対象 typecheck と直接関連テストを実施する。native の Windows 試験と実機受入は、対応した実行環境で行い、未実行を PASS にしない。共有変更では既存 macOS の approval-path、native-host-approval、native-classifier-route、approved-risk、preflight-offer、grant-identity、controller、Renderer interaction と portable harness の関連ケースを維持する。Windows を常に拒否する旧テストだけは、新しい条件付き gate の真偽表として意図を明示して更新する。darwin の期待を緩めて通さない。

N7 は N8-1〜6 と Windows の 2-A の根拠を確認し、platform × mode の版、interlockEnforced、build / CI の公開条件を一つの有効化 checkpoint で検証する。macOS の版を一緒に上げない。N11 は N12 と C6 の根拠の後で browser / Explorer の適格性と E2 / E3 の効果 gate を接続する。N8 の fixture で E3 が通ることを Explorer 公開の証明としない。

## 4. オーナーに判断してもらうこと

1. §2.1 の全条件を満たした Windows session にだけ承認経路を開き、N8 は不活性な準備、N7 は 2-A の有効化とする分担でよいか。
2. §2.2 の native 内の単発 ticket と最大 60 秒 / 5 秒、同一効果の再測定、カードの対象情報でよいか。E2 / E3 の本番公開は C6 / N12 の証拠を待つことを確認する。
3. §2.3 の全入力操作（選択・スクロールを含む）を supervised の確認対象にし、既存の二枚になり得る承認経路を維持するか。browser の observe_only を個別に残す表の分離でよいか。
4. §2.4 の unsigned と invalid / 不明の区別、digest 変更後の再列挙・初回許可からのやり直しでよいか。検証不能を人の承認だけで解除しないことを確認する。
5. §2.5 の Q1 の拒否優先と、悪性文書・関連付け等を完全に防げない残存リスクを、§2.6 の人の根拠と合わせて受け入れるか。
6. §2.7 の helper 世代失効を停止側の確定契約へ接続し、対象隔離の解除と操作承認を別に保つ方針でよいか。停止期限や終了証明自体はこの ADR で決めない。
7. §2.8 の非自動フォーカスと、§3 の PR 分割・実機受入を承認するか。自動試験の成功だけで人の判断を完了扱いしないことを確認する。

## 5. 受入と未確認事項

この Draft は #991 の設計成果であり、Windows の承認が動作したという報告ではない。コード変更、build、実 Provider、実機操作はこの ADR 作成では行っていない。独立レビュー、Review BOT、要塞レビュー、PR、オーナーの設計承認は親の工程である。

現状の根拠は各 §2 の file:line に記載した。N1 による移動後はシンボルを追い、Windows の分割先と行を更新する。kill-stop の正式な wire / generation 通知名は別 PR の確定結果と合わせる。#777 / N12 の人の実測結果、Windows の 2-A と C6 の PASS は未確認であり、§2.6 の公開条件として残る。

## 6. 改訂履歴

- 2026-11-02: #991 N8a 段 A・1 周目の Draft。base 1899ca3c の承認 gate、native ticket、Windows preflight、上限規則、grant identity、controller、Renderer と通知を照合した。実装・有効化・設計承認は行っていない。
