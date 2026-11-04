# Windows 背景入力 P7b: 合成 fixture・受動 observer の使い方

この文書は Issue #988 / N9 P7a の道具の引渡しであり、実機受入の結果ではない。
BG-1〜BG-8 はすべて **未確認**。背景公開 gate と製品の既定動作は変更しない。
正本は [背景入力 ADR](../../../tasks/designs/adr-computer-use-windows-background-input-20261102.md)
§2.7、BG-1〜BG-8、N9-7、§5.1。操作・証拠の扱いは [共通手順](README.md) に従う。

## 構成と範囲

- `apps/desktop/computer-use-native/fixtures/background-input/fixture.cc`: 6 個の UIA provider を持つ Win32 アプリ。
  index は Invoke=0、Value=1、SelectionItem=2、Toggle=3、ExpandCollapse=4、Scroll=5。
  各子 HWND は `control` 行に出る。画面の項目名は合成文字列だけ。
- `observer.cc`: 別プロセスで WinEvent と foreground / focus / capture / cursor を記録する。
  入力・前面化 API を呼ばない。既存窓の名前や文字列、キー内容、画像は取得しない。
- `api_probe.h`: 受入専用の API 試行カウンター。fixture の明示的な前面化刺激でも利用する。
  製品には組み込んでいない。公開 gate を開く機能はない。
- `scripts/build-background-input-tools.ts`: 既存 component / live seam と同じ `findBuild()`
  （PATH の cl.exe、なければ vswhere → vcvars64）で探索し、Promise の execFile でビルドする。
  インストール済みの MSVC と Windows SDK を使い、ネットワークに接続しない。
- `src/main/computer-use-windows-background-tools.test.ts`: portable 契約試験と、明示 opt-in の native 自己試験。

**合成 provider は実 provider の対応表の根拠にならない。** とくにこの fixture は意図的に
slot の HWND を使い続け、内容が変わっても UIA の runtime id を変えない。BG-4 の負例に利用し、公開対象の許可表に登録しない。
BG-1 の executor 正例には親工程で用意する受入専用の合成対象経路が必要。
製品がこの対象を拒否する場合、通常の製品 gate を変更して先へ進めず BLOCKED を記録する。

### P4a-attr 段 A の照合と残余リスク

claim 内と成功した Finish 後の **150ms 未満**だけ、検証済みの子 HWND と pattern ごとの
WinEvent 種類が一致する通知を免除する。合計 **16 件**と下表の種類別上限は claim と猶予で共有する。
期限ちょうど・最初の上限超過は pause。猶予中の次 claim は 0 で拒否し、期限以降に取得できる。
Stop、helper 終了、監視失敗・再登録では許可を破棄し、新しい monitor にも引き継がない。

| pattern        | 許可する WinEvent と種類別上限（同じ子 HWND に限る）                                            |
| -------------- | ----------------------------------------------------------------------------------------------- |
| Invoke         | OBJECT_INVOKED: 1、OBJECT_STATECHANGE: 2                                                        |
| Value          | OBJECT_VALUECHANGE: 2、OBJECT_NAMECHANGE: 2                                                     |
| Toggle         | OBJECT_STATECHANGE: 2                                                                           |
| SelectionItem  | OBJECT_STATECHANGE: 2、OBJECT_SELECTION / SELECTIONADD / SELECTIONREMOVE / SELECTIONWITHIN: 各1 |
| ExpandCollapse | OBJECT_STATECHANGE: 2                                                                           |
| Scroll         | OBJECT_VALUECHANGE: 2                                                                           |

claim の鍵の中で GetTickCount を記録し、通知の dwmsEventTime との差を符号付き32ビットで比較する。
差が正の場合だけ免除候補にする。claim 前に生成され後で届いた通知、同じ tick の通知は pause。
同じ tick（約16ms）の順序は決められないため、自分の呼出しの通知でも拒否する。

HWND が無い、無効、別 PID、top-level 自身、対象 top-level の子孫でない場合は Prepare で
前面への引渡し待ちにする。Claim 前の再確認で無効になった場合も同じ理由で拒否する。
fixture.cc の6 control は WS_CHILD と main_window を指定して作成され、この条件に適合する。
現在の UIA 経路は MSAA の object/child を確定できず HWND までの照合となる。
前面化、capture、MOVESIZE、CREATE / DESTROY、SHOW / HIDE、SYSTEM_SCROLLINGSTART / END、
別 HWND は免除しない。SCROLLING hook は監視に残し、登録失敗でも pause する。
免除は効果の確認ではなく、executor の読戻し・窓検証を維持する。

**別 UIA client が同じ要素へ同じ種類の操作を同じ許可区間内の時刻に行う場合は識別できない。**
claim と同じ tick 自体は拒否するが、claim より後の許可された tick で自分と他 client の通知が
重なる場合は見分けられない。同じ HWND 内の子識別不能も残る。ADR §2.5 の表示・隔離で扱う。
免除区間は provider 呼出しの前後だけでなく claim 全体＋猶予のまま。許可表・種類別上限・150ms は
実測前の暫定値である。P7b で各 pattern の実通知と読戻し、BG-3 の別 client、BG-6/8 の停止を測る。
特に BG-1 の正例が同一 tick 拒否により通らない場合は、条件を緩めず親へ相談する。
段 A の合成 native 試験は OS 入力を送らない。native 実行と実機 BG-1 は親工程で確認し、未実施を PASS としない。

## ビルドと道具の自己試験（親工程）

Windows x64、Node.js 22、MSVC C++ Build Tools、Windows SDK が必要。
PowerShell でリポジトリのルートから実行する。

```powershell
node --experimental-strip-types apps/desktop/scripts/build-background-input-tools.ts .artifacts/p7a-tools
```

`fixture.exe` と `observer.exe` が指定先にできる。製品 packaging には含めない。
native 自己試験は次の明示 opt-in で実行する。自分で生成した窓の前面化、capture、popup を使うため、
別アプリで入力中には実行しない。SendInput や cursor 移動は行わない。

```powershell
cd F:/scg-988-n1/apps/desktop
$env:SPRINT_CODER_P7A_NATIVE_SELF_TEST = '1'
node --require "C:/Users/yusei/.claude/skills/issue-graph-flow-codex/scripts/sandbox-vite-shim.cjs" ../../node_modules/vitest/vitest.mjs run src/main/computer-use-windows-background-tools.test.ts --pool=threads
Remove-Item Env:SPRINT_CODER_P7A_NATIVE_SELF_TEST
```

通常実行では native の 2 件は SKIP。cl.exe 未実施を PASS と扱わず **NOT_RUN** と報告する。
native opt-in 時は MSVC 不在、UIA の公開失敗、foreground lock での刺激失敗を試験失敗にする。
fixture の子プロセス以外を終了しない。自己試験は `quit` / `stop` で終了し、
応答しなければ自分で spawn したプロセスだけを終了する。

自己試験名:

1. `parses evidence and rejects non-record input`
2. `keeps the observer passive and records health as well as OS events`
3. `keeps fixtures outside product builds and supports each delay and replacement mode`
4. `exposes six real UIA patterns, counts effects, and reuses stable identities`（native）
5. `observes foreground, capture and popup stimuli from owned fixture windows`（native）

自己試験の成功は BG 受入の成功ではない。UIA 公開、差替え、待機・解放、観測装置の健全性だけを確かめる。

## 起動・区間・終了

PowerShell の窓を二つ用意し、一方で fixture、もう一方で observer を起動する。
stdout は **JSON Lines**（1 行に JSON オブジェクト 1 個）。標準入力はコマンド用に残す。
窓タイトル・prompt・response 等をログへ追加しない。

```powershell
# 窓 A（リポジトリのルート）
& ./.artifacts/p7a-tools/fixture.exe > ./.artifacts/p7a-tools/fixture.jsonl
# 窓 B（リポジトリのルート）
& ./.artifacts/p7a-tools/observer.exe > ./.artifacts/p7a-tools/observer.jsonl
```

両ログの `ready` を確認する。fixture は非活性表示する。人が合成入力用の別アプリを前面に置く。
開始前に fixture へ `snapshot`、observer へ `mark` を入力する。その後に試験の前面状態を作り、
安定した `sample` を開始点とする。終了後も observer を止める前に安定区間を記録する。
コマンド入力のための端末切替は試験区間外に置く。遅延解除等を区間中に行う場合は、
親の runner が標準入力へ送信し、端末への前面移動を混ぜない。

observer に `stop`、fixture に `quit` を入力すると自分自身だけが終了する。
EOF でも終了する。provider 待機中の `quit` は先に待機を解放するので、
**遅延効果があり得る試験では先に Stop・隔離の証拠を確保**してから終了する。
`finished` が無い、JSON が途中で途切れた、`error` がある場合は証拠不完全とする。

### fixture コマンド

| コマンド                      | 意味・記録                                                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `snapshot`                    | 各 index の `attempts`（provider メソッド到達数）、`effects`（状態反映数）、`reads`、`generation`、HWND を `control` に記録 |
| `delay-before`                | 次の provider 読取りで停止（phase=1）。観測・preflight のどの読取りで止まったかを製品側の記録と照合                         |
| `delay-inside`                | 次の pattern メソッド入口で `attempt` を記録し、効果の前で停止（phase=2）                                                   |
| `delay-after`                 | 次の効果の後の最初の provider 読取りを停止（phase=3）。method の返却自体は止めない                                          |
| `release`                     | stdin スレッドから待機を解放。GUI / provider が待機していても利用できる                                                     |
| `replace`                     | index、HWND、runtime id を変えず、合成内容 `item-N` の世代を変更                                                            |
| `reuse`                       | 同じコンテナを別項目に再利用。以後 Scroll / SetScrollPercent の効果ごとに項目世代も変更                                     |
| `patterns`                    | pattern 公開の有無を反転し、BG-5 の能力不在を作る                                                                           |
| `foreground`                  | fixture 自身の主窓だけを前面化。`apiAttempt` と `stimulus.foregroundAccepted` を記録                                        |
| `capture` / `release-capture` | 自分の主窓だけが capture を取得・解放                                                                                       |
| `popup`                       | 自分が所有する非活性 topmost / popup を生成。主窓の終了時に一緒に終了                                                       |
| `quit`                        | 自分の主窓と所有 popup を閉じる。他のアプリは閉じない                                                                       |

遅延は一度だけ有効。各ケースで新しい fixture を起動し、余分な UIA inspector を停止する。
`armed` → `blocked` → `released` と `attempt` / `effect` の順序を確認する。
provider の読取りをどの client が行ったかは識別しないため、複数 client を混ぜた証拠は使わない。
既発行の UIA 呼出しが Stop 後に完了することはあり得る。`effects` の増分を二重発行と混同しない。

道具単体の UIA client もある（製品の受入を代替しない）。`control.hwnd` と index を指定する。

```powershell
& ./.artifacts/p7a-tools/fixture.exe --probe <子HWNDの10進数> <index> read
& ./.artifacts/p7a-tools/fixture.exe --probe <子HWNDの10進数> <index> apply
```

同じ実行ファイル・fixture class の窓だけを許可する。`probe.runtimeId`、`name`、`hresult` を出す。
`apply` は合成 UIA 呼出しを一度行う。実際の OS のキー・マウス入力は送らない。

### observer の値と限界

- `winEvent`: `event`、HWND、PID、TID、object / child、`eventTime32` と受信 `tickMs`。
  foreground=3、capture 開始=8 / 終了=9、focus=32773。配送時差は
  `((tickMs % 4294967296) - eventTime32 + 4294967296) % 4294967296` ms として扱う。
- `sample`: foreground、focus、capture、cursorX/Y、cursorOk、guiOk、maxGapMs。
  nominal 10 ms、変化時と約 10 sample ごとに出力。`maxGapMs` は実際の最大間隔であり保証値ではない。
- `baselineWindow` は起動時からある popup / topmost、`newWindow` は観測中に初めて検出したもの。
  既存 HWND に popup / topmost の style が加わった場合も `changedStyle=1` で記録する。
  HWND と PID で fixture 由来・製品由来・無関係な窓を区別する。
- `mark`、`ready`、`finished.events/samples/maxGapMs` で区間と終了を照合する。
  いずれも同一 Windows 起動中の GetTickCount64 を使う。別の起動のログを時間だけで接続しない。

cursor はサンプリングなので、間隔内の往復移動は見逃し得る。WinEvent の欠落や配送遅延、
短命 popup、sample 間で往復した style 変更、secure desktop の不可視状態にも限界がある。
`cursorOk=0` / `guiOk=0`、長い gap、observer の異常終了を無変化の PASS にしない。
GetGUIThreadInfo(0) の focus / capture は前面 thread の補助観測で、他 thread は WinEvent と照合する。
製品の hook / Raw Input の健全性は、この observer の生存だけでは証明できない。

### API 試行の記録

`api_probe.h` は API を呼ぶ**前**に加算する。失敗した API も数える。
番号は foreground=0、focus=1、cursor=2、SendInput=3、active=4、BringWindowToTop=5、AllowSetForegroundWindow=6。
fixture の `apiAttempt` は fixture のみの記録であり、製品のゼロ回を意味しない。
provider の `attempts=0` も、製品が途中で失敗した API 呼出しのゼロ回を意味しない。

P7b の親工程では、受入専用 native harness の Windows 宣言の後、対象 dispatch の前に
この header を組み込み、`p7a_api_probe::sink` を別の証拠ファイルへ接続する。
UIA interface の `SetFocus` メソッド宣言より前に macro を挿入しない。
製品 wire の stdout へ JSONL を混ぜない。観測区間の前後で `attempts` の差分を取る。
この段階で製品への配線は行っていないため、実製品の API 試行証拠は **未確認**。
既存の `computer-use-windows-input-seam.test.ts` の attempt / guard refusal、
`computer-use-windows-background-executor.test.ts` の禁止 API 検査も合わせる。
別名・関数ポインター・別モジュール経由の API は macro では捕捉できない。
計測対象の全 call site を確認できなければ「製品 API 0 回」は BLOCKED にする。

## BG ごとの実機受入

各ケースは ADR の行全体を受入条件とする。この表は利用する道具と残りの証拠の対応表。
人の操作は専用の合成入力用アプリと fixture を対象にし、通常作業中の窓を流用しない。

| ケース | 道具の値・刺激                                                                                                 | 併せて確認すること                                                                                                                                                      | 結果   |
| ------ | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| BG-1   | 六 pattern の attempts/effects 差分=1、observer foreground/focus/cursor、新規 popup/topmost/capture、API probe | 背後・非最小化、普通/承認経路、効果の読戻し、製品 API 0 回。UIA Invoke は後続の非同期効果まで保証しない                                                                 | 未確認 |
| BG-2   | observer focus/foreground/cursor と窓の発生                                                                    | 別アプリだけに合成文字が届く、カード非活性。人の cursor 移動区間は分離                                                                                                  | 未確認 |
| BG-3   | foreground/capture/popup 刺激、blocked phase=2、WinEvent の時刻、attempts/effects                              | owner 無しの窓は第2 fixture プロセスを使う。人の wheel/click/resize、別 UIA client、次 claim 拒否、epoch、通知欠落/逆順、隔離と再開                                     | 未確認 |
| BG-4   | replace/reuse、probe.runtimeId/name、generation、attempts/effects                                              | 同 index・同 runtime id の内容差替えと Scroll による再利用を拒否。PID/HWND 再利用、ancestor、同名、DPI、最小化、cloak、desktop 等は別の境界 fixture・人の OS 操作が必要 | 未確認 |
| BG-5   | patterns、observer foreground/focus、apiAttempt、attempts/effects                                              | カード・引渡し・往復 id、期限、第三窓、foreground lock、Stop、旧 ticket、V1 60 秒。操作は実 UI から行う                                                                 | 未確認 |
| BG-6   | delay-before/inside/after、armed/blocked/released、attempt/effect、世代                                        | Stop なし timeout、応答消失、K-1〜K-5、receipt、再起動、隔離、二重入力なし。台帳/transport の証拠は製品側で取得                                                         | 未確認 |
| BG-7   | observer focus/foreground/cursor、製品 API probe                                                               | 背景/前面表示、二枚カード、trusted activation、Tab/click、キー継続、light/dark、loading/error/disabled の実画面                                                         | 未確認 |
| BG-8   | observer WinEvent と maxGapMs、fixture attempts、製品 monitor の heartbeat/hook/Raw Input 時刻                 | 前面回帰、E1/E4、旧 helper/未知能力、hook 除去後の mouse、keyboard のみの正例、新規開始拒否、人の再開、macOS の既存境界試験                                             | 未確認 |

監視の測定では製品の hook / Raw Input 到着と心拍の時刻も保存し、observer の event/sample と突き合わせる。
ADR の暫定 100 / 20 / 250 ms を実測済みの閾値と扱わない。hook 除去や通知欠落は既存の
試験用注入境界を使い、通常製品に操作スイッチを追加しない。装置がない項目は BLOCKED とする。

## 記録の形・引渡し

各 BG と pattern / phase / 負例の組ごとに、次を証拠索引へ記入する。現時点では全項目未記入。

```json
{
  "case": "BG-6 / inside / Stop",
  "result": "NOT_RUN",
  "osBuild": null,
  "productCommit": null,
  "fixtureHash": null,
  "providerControlPattern": null,
  "intervalTickMs": null,
  "fixtureJsonl": null,
  "observerJsonl": null,
  "productApiEvidence": null,
  "ledgerAndEpochEvidence": null,
  "screenshots": [],
  "remaining": "P7b の実機受入は未実施"
}
```

親工程へ渡すもの: native ビルドと自己試験の結果、各 BG の専用前提・操作・期待値、
interval と JSONL、製品 API/監視/隔離の証拠、画面の証拠、未確認/失敗の一覧。
公開の判断や実 provider の版付き対応表は P7b/P8 の工程に残す。P7a だけで gate を開かない。

source pin について: 新規 native ソースは既存 scan が除外している `fixtures/` 配下で、
製品ソースの切出し位置や試験用 define は変更しない。`*-component.test.ts`、`*-seam.test.ts`
の source slice/replace と `computer-use-native.test.ts` の define scan を確認対象に含める。
