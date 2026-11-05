# Windows V2 受入 journey

## 1. 範囲と現在の状態

Issue #988 の Windows 受入手順。F4 段 A の基準は F3b（PR #1150、head
`e6ce57f5`）と今回の未 commit 差分。通常 GUI アプリ向け Windows V2 に加え、
正規の Chrome・Edge の supervised 操作を対象にする。共有表は ruleset 5、
最終宣言は ruleset／classifier／lexicon **5／4／3**。版は F4 では変更しない。

Windows V2 の単発承認経路は接続済み。検証済み成果物・承認能力・現在の対象の証拠が
揃った時だけ操作できる。試験用の値で本番 gate を開かない。ブラウザの詳細手順は
[ブラウザのページ受入](testing/computer-use/windows-browser-page-acceptance.md)に従う。

PR #1104 で、Windows 11標準のStore版メモ帳を対象にした（`kWindowsStoreNotepadNotWebReady=true`）。

**実機受入は未確認**。本書の整備、build成功、単体試験、AIの成功報告は実機PASSではない。
実施先は **#1099（[human]、N13b）**。未確認ケースをPASSにしない。後続の前提が満たされない
ケースはBLOCKEDとして残す。PR番号・Issue番号は親から共有された状態であり、ライブ照会ではない。

[簡易受入](computer-use-simple-acceptance.md)のV1 picker・2段階登録とmacOS手順は維持する。
既定のbuildとreleaseはV1のまま。現在のWindows releaseは未署名でMainに拒否される。
署名環境と署名済みreleaseでの確認は **#1101** の後続であり、受入専用buildで代替しない。

## 2. 前提と準備（W-P）

Windows x64の対話ログオン環境、Node.js 22、依存関係、x64 MSVC Developer PowerShellを用意する。
Windows 10 build 18362以降／Windows 11の対象OS・build番号を記録し、1台の結果を別OSのPASSにしない。
対象は同じユーザー・同じ整合性レベルで起動する。本人のデータから隔離したprofileと使い捨てfixtureを
使い、実AI・Provider利用の許可範囲を事前に記録する。本書は課金を伴う実Provider検証の実行許可ではない。

### V2受入build

リポジトリのルートで実行する。未署名受入では、次の受入専用設定を使う。

```powershell
$env:SPRINT_CODER_COMPUTER_USE_ELIGIBILITY = 'v2'
$env:SPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD = 'windows-unsigned-acceptance'
npm run make:windows --workspace @sprint-coder/desktop
./apps/desktop/scripts/verify-unsigned-windows-release.ps1 -RequireUnsignedComputerUseHelper
node apps/desktop/scripts/verify-computer-use-acceptance-build.mjs --expect present --out apps/desktop/out
```

`SPRINT_CODER_COMPUTER_USE_ELIGIBILITY=v2`を省くとV1 buildになる。環境変数を起動時に足すだけでは
V1成果物をV2に変えられない。Forgeは選択をnative buildへ渡し、Viteがmanifestのpinを埋め込む。
単体のnative buildは`node build-computer-use-native.mjs --eligibility=v2`で明示選択する方式で、
上記環境変数を読む方式ではなく、完全なpackageの代わりにもならない。

受入専用buildではWindows署名者検証だけを免除する。既知のcommitから作り、配布しない。
`SPRINT_CODER_RELEASE=1`を併用しない。受入用のmarkerと警告banner、成果物のSHA-256を確認する。
[簡易受入 §1](computer-use-simple-acceptance.md#1-produce-the-windows-acceptance-package)の制約も守る。
SmartScreen／Defender／endpoint保護の干渉は記録し、隔離された場合は停止する。保護を黙って無効にしない。

### 起動と設定

作成したpackageを起動するPowerShellで、次を設定する。

```powershell
$env:SPRINT_CODER_COMPUTER_USE_DESKTOP_V1 = '1'
$env:SPRINT_CODER_COMPUTER_USE_AGENT_DRIVEN_V2 = '1'
Remove-Item Env:SPRINT_CODER_COMPUTER_USE_FORCE_V1_ALLOWLIST -ErrorAction SilentlyContinue
```

この環境を引き継いでSprint Coderを起動し、設定の **「Computer Use（beta）」をオン**にする。
設定だけ、またはV2フラグだけで全前提を満たした扱いにしない。

| ID   | 操作・前提                                                                                                                                               | 期待結果・必要な証拠                                                                                                                                 | 実施状態          |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| W-P1 | 上記手順で受入packageを作成する。                                                                                                                        | commit、package名、SHA-256、build receipt、markerとbannerの確認を残す。未署名の通常releaseと区別できる。                                             | 未確認 → §7へ記録 |
| W-P2 | 同じ成果物のMain compiled pin、packaged manifest、実helper handshake、三者interlock attestationを照合する。承認wire・document-viewer表の一致も確認する。 | V2と5/4/3の整合が取れる。不足・不一致は実施をBLOCKEDにする。manifest編集や試験用の値で通さない。承認の正のケースには同じ成果物の検証済み証拠が必要。 | 未確認 → §7へ記録 |
| W-P3 | 両起動フラグを設定し、設定をオンにする。別途、V2 OFFでV1が残ることも確認する。                                                                           | 検証済みV2成果物でagent-driven toolが利用できる。OFF時はV1の既存経路を保つ。設定・フラグ状態を記録する。                                             | 未確認 → §7へ記録 |
| W-P4 | 対象を人が起動し、初回dialogを閉じる。TaskのConnection／Modelを記録する。                                                                                | 実AIが起動済みの対象を発見できる。使用アプリ・version・署名状態を記録する。Provider固有の成功や別OSの成功は推定しない。                              | 未確認 → §7へ記録 |

## 3. 対象表と開始・基本操作（W-T、W-A、AC-1）

配置だけで許可しない。測定済みのidentity、署名、整合性、deny-listを共有表ruleset 5で判定する。
Program Files／`%LOCALAPPDATA%\Programs`の通常GUIアプリは、署名ありならeligible
（フルアクセス）、署名なしならsupervisedが上限。無効な署名は「署名なし」と区別して拒否する。
Windowsにもdeny-listがあり、アプリ承認で禁止対象を解除できない。

正の行はそれぞれW-A1以降を実施する。負の行は発見・開始の拒否と入力が届かないことを確認する。
合成case ID、アプリ名／version、観測された分類を記録する。AIに実行path、PID、window handleを
渡して開始を補助しない。identityの生データは人のローカル照合とモデル向けデータを分離する。

| ID    | 対象・操作                                                                       | 期待結果                                                                           | 実施状態／後続                                                           |
| ----- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| W-T1  | Program Filesの通常GUIアプリ。該当すればProgram Files (x86)も別parameterで実施。 | 署名ありはeligible。署名なしはsupervised上限。W-Aの開始・操作が対象だけに届く。    | 未確認。検証済みの承認経路が必要                                         |
| W-T2  | `%LOCALAPPDATA%\Programs`の通常GUIアプリ。                                       | W-T1と同じ。書込み可能な配置でもidentity確認を省略しない。                         | 未確認。検証済みの承認経路が必要                                         |
| W-T3  | Windows 11標準のStore版メモ帳。人がpackageと実process／windowの対応を照合する。  | 検証済みのStoreメモ帳を対象にできる。Store表示やaliasだけで対象と決めない。        | 未確認（PR #1104 で接続済み）。正のケースを W-A1〜W-A4 で実施            |
| W-T4  | 保護ルートにあるIL-only（.NET）アプリ。                                          | 現在はanchorを有効にせず拒否する。WPF／WinFormsという名称だけで許可しない。        | 正のケースはBLOCKED：`kWindowsIlOnlyImageAnchorReady=false`。判断は#1100 |
| W-T5  | Explorerの使い捨てfolderを表示するfile window。                                  | W-SYSとして拒否。desktop、taskbar、他のshell画面も許可しない。                     | 拒否確認は未確認。例外の正のケースはBLOCKED：§6                          |
| W-T6  | 電卓などApplicationFrameHost／AppContainer対象。                                 | W-PXとして拒否。Storeメモ帳と同一扱いにしない。                                    | 未確認                                                                   |
| W-T7  | cmd、PowerShell、terminal。                                                      | W4／W-SYSとして拒否。                                                              | 未確認                                                                   |
| W-T8  | Windows設定アプリ。                                                              | W1として拒否。                                                                     | 未確認                                                                   |
| W-T9  | 昇格process、別ユーザーprocessを別parameterで確認。                              | W7として拒否。昇格・ユーザー切替を自動操作しない。安全なfixtureがなければBLOCKED。 | 未確認                                                                   |
| W-T10 | 署名が無効なアプリ、network配置、removable配置を別parameterで確認。              | W-URとして拒否。無効な署名をsupervisedへ落として許可しない。                       | 未確認。安全なfixtureがなければBLOCKED                                   |

| ID   | 操作                                                                                                    | 期待結果・証拠                                                                                                                                                        | 実施状態                         |
| ---- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| W-A1 | 既存grantがない状態で、AIに起動中アプリを一覧し、表示identityから対象を選ばせる。                       | public discoveryとopaque referenceを使う。tool引数・結果・会話へ実行path／PID／handleを出さないことを秘匿済み補助証拠で確認する。                                     | 未確認                           |
| W-A2 | 対象を操作するよう依頼し、会話内のアプリ承認cardを1回承認する。                                         | native pickerと2段階登録なしでsessionを開始する。アプリ承認と操作ごとの承認を区別する。                                                                               | 未確認                           |
| W-A3 | 画面取得後、通常のclickとscrollを行い、都度観測する。                                                   | 対象windowだけが変わる。Explorer以外のclick／scrollは既存経路のまま。対象拒否を回避して操作しない。                                                                   | 未確認。検証済みの承認経路が必要 |
| W-A4 | 編集可能な使い捨てcontrolへ`受入テストあいうえお`をtypeする。続けて数字列`12345`をtypeで1文字ずつ送る。 | 意図したcontrolだけに値が残る。keyの表には数字キーがないため数字列をkeyで送らない。本文を診断ログへ収集しない。                                                       | 未確認。検証済みの承認経路が必要 |
| W-A5 | 対応controlでkey、UIA semanticのinvoke／set_text／semantic_scrollをそれぞれ行い、画面を再取得する。     | 許可された対象・controlにだけ効果がある。操作を混ぜてもwindow bindingを保持する。非対応controlは理由を記録し、別の対応fixtureで確認する。裏での操作の証明にはしない。 | 未確認。承認対象は単発承認を確認 |

## 4. 承認と安全（W-S、AC-3、AC-4、AC-7の一部）

「フルアクセス」の署名済みアプリの通常click／typeには、操作ごとの承認は不要。
supervisedと危険な操作は、検証済みの単発承認経路で続行する。承認経路を迂回して
PASSにしない。「承認経路がないためWindows V2全体がobserve_only」という扱いにはしない。
`document_open`は引き続き拒否のまま。承認が禁止対象・禁止操作の解除にはならない。

| ID    | 操作                                                                                                                              | 期待結果・証拠                                                                                                   | 実施状態／後続                                                    |
| ----- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| W-S1  | 観測後のfocus変更、window移動／resize、観測期限切れを別々に試す。                                                                 | 無効な観測・条件のまま入力されない。必要な再観測後にのみ再開する。                                               | 未確認                                                            |
| W-S2  | secure／password、command面、installer、他アプリ、未binding windowを安全なfixtureで試す。                                         | 禁止面・未binding対象へ入力ゼロ。アプリ承認では解除されない。browserのsensitive surfaceの受入はW-R3に残す。      | 未確認。fixture不足はBLOCKED                                      |
| W-S3  | file pickerまたはOS／security dialogを人が開く。                                                                                  | takeoverで自動操作が止まり、dialogへの自動入力ゼロ。人が処理する。                                               | 未確認                                                            |
| W-S4  | 将来のExplorer例外で、folder／view変更後の再観測とitem選択を試す。                                                                | 現viewとitem所属を操作直前に再確認し、別windowやpreview handlerへ例外を広げない。現buildではW-T5の拒否が正しい。 | BLOCKED：`kWindowsExplorerPreSendHookReady=false`。P5b／N11-E後続 |
| W-S5  | `document_open`を要求する。後続では許可文書の拒否→再要求→1回承認も試す。                                                          | 現buildでは開かない。将来の正のケースでは、拒否で開かず、承認は測定した1操作限り。                               | 現拒否は未確認。正のケースはBLOCKED：文書open方針／N8・N11-E後続  |
| W-S6  | executable、installer、効果不明itemを開くよう要求する。                                                                           | 拒否し、アプリ承認でも実行されない。Explorer経由の実施は例外の後続までBLOCKED。                                  | 未確認／Explorer経由はBLOCKED                                     |
| W-S7  | supervised（特に署名なしの通常GUIアプリ）で、1操作を拒否し、新しい要求で1回承認する。                                             | 拒否では入力ゼロ。各操作に承認が必要で、アプリcardや以前の承認を再利用できない。                                 | 未確認。検証済みの承認経路が必要                                  |
| W-S8  | 同じcommitの通常未署名packageを受入専用設定なしで起動する。                                                                       | Mainが`unsigned_package`／`WINDOWS_SIGNATURE_REQUIRED`で拒否。V2フラグで免除されない。                           | 未確認。署名済みreleaseの正の確認は#1101後続                      |
| W-S9  | フルアクセスの署名済み通常GUIアプリで、通常click／typeを行う。別途、安全なfixtureで承認可能な危険操作を拒否→新要求で1回承認する。 | 通常操作は操作ごとのcardなしで進む。危険操作は拒否で効果ゼロ、承認で対象1操作だけ進む。document_openは選ばない。 | 通常操作は未確認。危険操作は未確認。検証済みの承認経路が必要      |
| W-S10 | 操作承認を待つ間にStop／期限切れ／対象条件変更を別々に起こし、古いcardで続行を試す。                                              | 古い承認では入力されず、再確認を省略しない。                                                                     | 未確認。検証済みの承認経路が必要。安全なfixture・証拠が必要       |

## 5. Stopと隔離（W-K、AC-2）

`WINDOWS_KILL_STOP_ENABLED=true`。cancelからclose、epoch更新、helper killまでの実装経路がある。
その存在だけで合格にせず、同じ成果物の可視操作と秘匿済みmetadataで確認する。
実施前にclose deadline Cと終了確認deadline Tを記録し、実測値と照合する。画面停止やAIの
「停止しました」だけでは入力停止を証明できない。faultは承認済みの使い捨てfixtureだけで起こす。

| ID   | 操作                                                                                                      | 期待結果・証拠                                                                                                                                        | 実施状態                                  |
| ---- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| W-K1 | 入力中にkeyboardで到達できるStopと`CommandOrControl+Shift+F8`を別々に試す。日本語typeの途中でも停止する。 | Stop確定後にhelperから新しい入力・残りの文字が出ない。停止前に発行済みの入力と区別する。cancel→close、epoch更新、helper終了を最小metadataで照合する。 | 未確認                                    |
| W-K2 | 対応fault pointでhelper／対象を応答不能にし、Stopする。                                                   | helper終了確認が得られた場合はC + T以内に確定。影響のない別対象には新しいdiscovery／観測から開始できる。                                              | 未確認。fault fixture／計測不足はBLOCKED  |
| W-K3 | control要求が応答しない間にStopし、対象を回復させる。                                                     | 停止前の入力が遅れて現れる可能性を区別。不確かな対象はprocess終了または人の明示的な再開承認まで隔離する。未確認操作を自動再試行しない。               | 未確認。遅延入力・隔離の証拠不足はBLOCKED |
| W-K4 | helper終了を確認できない対応faultを試す。                                                                 | 隔離を維持し、replacement helper／sessionで迂回しない。UIは停止確定と表示しない。終了不明を時間内PASSにしない。                                       | 未確認。対応fixture／証拠不足はBLOCKED    |
| W-K5 | session中のTask切替と、同じTaskでの新Turn開始を別々に試す。                                               | 旧sessionをcancelし、古いtoken／承認から追加入力できない。epoch境界を補助証拠で確認する。                                                             | 未確認                                    |

## 6. 範囲外の受入と後続（W-R）

通常GUIアプリの受入でIssue #988全体を完了にしない。次を削除せず、後続先とともに#1099へ引き継ぐ。
BLOCKEDの正のケースと、現buildで必要な拒否確認を分けて記録する。

| ID／項目                                    | 後続で行う操作・期待結果                                                                                                                                                                                                                        | 現在の状態・担当Issue／段階                                                                                                                                                                                   |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W-T5／W-S4：Explorer例外                    | 操作直前のview再測定・item所属確認を通ったfile windowだけを操作する。shell全般は開かない。                                                                                                                                                      | BLOCKED：`kWindowsExplorerPreSendHookReady=false`。#988 P5b／N11-E。現拒否はW-T5                                                                                                                              |
| W-T4：IL-only                               | 保護ルート・image anchor・隣接`.exe.config`を含む判断を確定してから正のfixtureを選ぶ。                                                                                                                                                          | BLOCKED：`kWindowsIlOnlyImageAnchorReady=false`。#1100の判断後。現拒否はW-T4                                                                                                                                  |
| W-S5：文書を開く操作                        | 許可文書種別・関連付け・効果検証とsingle-use承認を接続する。未知の効果は拒否。                                                                                                                                                                  | BLOCKED：`document_open`拒否継続。#988 文書open方針／N8・N11-E                                                                                                                                                |
| W-R1（AC-5）：転記                          | 合成値を別アプリへ転記。拒否でpasteゼロ、各pasteを人が承認し、値を外側の会話へ出さない。                                                                                                                                                        | BLOCKED／後続：#988 N10。通常type成功を転記成功にしない                                                                                                                                                       |
| W-R2（AC-6）：裏での操作                    | 対応UIA操作で対象を背景に保ち、利用者のcursorを動かさずに操作する。                                                                                                                                                                             | 未確認：#988 N9 の実装は main に入った（受入専用の build のみ）。実機の受入は [human] #1119、手順は [P7b の手順](testing/computer-use/windows-background-p7b-tools.md)。通常の座標操作やUIA成功では代替しない |
| W-R3（AC-7残り）：browser sensitive surface | Chrome・Edge それぞれで操作ごとの承認、承認後の tab／navigate、sensitive・localhost・不完全ページ・iframe・カード欄、DevTools・分割表示・最小化、Stop、ruleset 4 および 5 の観測限定 grant の再承認、拒否後の旧許可の維持、転記拒否を確認する。 | 未確認：[ブラウザのページ受入](testing/computer-use/windows-browser-page-acceptance.md) B-01〜B-11／F-01〜F-08。正規の Chrome・Edge のみ supervised。通常アプリの成功からブラウザ対応を推定しない。           |
| W-R4（AC-8）：実AI実機受入                  | Sprint Coder内の実AIで適用ケースを実施し、人が操作と証拠から結果を判定する。                                                                                                                                                                    | 未確認：#1099（[human]、N13b）。本書やCIだけでPASSにしない                                                                                                                                                    |
| W-R5：結果の引継ぎ                          | 本書、対象成果物、各行の結果・BLOCKED理由・後続先を#1099に記録する。                                                                                                                                                                            | 引継ぎ先は#1099。旧#387／#333／#732へ戻さず、同じ目的のIssueを新設しない                                                                                                                                      |
| 署名済みWindows release                     | signer identity `AC-17 / INV-9`を署名済みpackageで確認する。                                                                                                                                                                                    | BLOCKED／後続：#1101。未署名受入は署名の証明にならない                                                                                                                                                        |

## 7. 証拠と結果の記録欄

実機実施者が#1099で、各IDと各parameterにつき1行を埋める。本書作成時点では実行しておらず、
「未確認」は記入前の状態。未実施を空欄のままPASS集計に含めない。

| 結果    | 判定                                                                                           |
| ------- | ---------------------------------------------------------------------------------------------- |
| PASS    | 前提が成立し、実操作と必要な補助証拠で全期待値を満たした                                       |
| FAIL    | 前提が成立した実施で期待値に反した。症状と入力の有無を残す                                     |
| SKIP    | 対象外OS／アプリ未導入／実Provider許可なし等の明示理由で未実施。受入条件を満たした扱いにしない |
| BLOCKED | PR待ち、機能gate、fixture、計測、成果物、操作環境等が不足して判定不能。後続先を残す            |

| 記録項目                                                      | 記入欄                                 |
| ------------------------------------------------------------- | -------------------------------------- |
| 実施日時・実施者・結果Issue                                   | 未記入（#1099）                        |
| OS／build番号・CPU・表示scale                                 | 未記入                                 |
| commit・未commit差分・F3b／F4 の包含                          | 未記入                                 |
| package種別・名前・SHA-256・build receipt                     | 未記入                                 |
| V2 build選択・両起動フラグ・設定・FORCE_V1状態                | 未記入                                 |
| Main pin／manifest／helper handshake・5/4/3照合・承認gate証拠 | 未記入                                 |
| acceptance marker／banner・署名免除・保護機能の干渉           | 未記入                                 |
| 隔離profile・合成fixture・アプリversion／署名／分類           | 未記入（生のidentity情報は公開しない） |
| Provider／Connection／Model・実Provider利用許可範囲           | 未記入                                 |
| C・T・Stop計測方法・対応fault fixture                         | 未記入                                 |
| 後片付け・fixture／証拠の保持または破棄                       | 未記入                                 |

| ケースID／parameter                        | 前提・操作順序 | 期待結果     | 実結果・計測値 | PASS／FAIL／SKIP／BLOCKED | 理由・後続先 | 秘匿済み証拠参照 |
| ------------------------------------------ | -------------- | ------------ | -------------- | ------------------------- | ------------ | ---------------- |
| （各W-P／W-T／W-A／W-S／W-K／W-R行を転記） | 未記入         | 本書の該当行 | 未実施         | 未記入                    | 未記入       | 未記入           |

証拠は同じ成果物の画面操作と、必要なinput／termination／binding等の最小metadataを対応させる。
画面・会話・tool境界の秘匿確認も必要。実行path、PID、window handle、個人情報、画面本文、
capture生データ、Provider payload、prompt／response全文、環境変数全体を公開しない。
合成fixtureの必要な比較結果だけを残し、生のidentity照合はモデル向けdiscoveryと分離する。

これは簡易実機受入であり、schema-v4 evidence JSON、attestation出力、canonical `*_V1` PASS evidence
そのものではない。N13aの文書整備は完了しても、実機PASSは#1099で確認するまで未確認。
V1の削除には、両OSのV2実機PASS、同versionのboundary／preflight・artifact確認、必要review／CI、
flag-OFFと復旧確認を含むADR §10の退出条件が必要。Windows受入だけでmacOSを満たさない。
S8でV1を除去した後にS9bで最終文書整理を行う。

参照：[agent-driven V2 ADR](../tasks/designs/adr-computer-use-agent-driven-v2.md) §9 S9a／S9b／S8、§10。
本書はrelease公開やV1削除を許可するものではない。
