# ADR: Computer Use Windows — 複数セッションの同時実行

- Status: Draft（オーナー承認の前。N15 の実装・公開を承認したものではない）
- Date: 2026-11-02
- Issue: #996（Refs #988, #500, #994）
- 関連: [V2 ADR](adr-computer-use-agent-driven-v2.md)（Main の権限、Task / Turn の所有、D14、§8 の不変条件）
- 関連: [kill-stop ADR](adr-computer-use-windows-kill-stop-20261102.md)（Accepted。§2.2 の台帳・対象隔離、§2.5 と D-5、§3.1 の停止期限）
- 関連: [承認経路 ADR](adr-computer-use-windows-approval-path-20261102.md)（§2.2 の単発 ticket、§2.7 の世代、§2.8 の UI）
- 関連: [背景入力 ADR](adr-computer-use-windows-background-input-20261102.md)（#994。§2.1〜§2.6 の入力経路、interaction epoch、takeover、approval_round_trip、K-1〜K-5）
- 参考: vercel-labs/agent-desktop（Apache-2.0、調査版 `9eb9b29`）。考え方だけを参考にし、コードは使わない。ローカルの `F:/work/ext/agent-desktop/LICENSE` と、`F:/work/scg-988-runs/agent-desktop-study/` の `critic.md`、`compare.md`、`read-concurrency.md`、`read-windows-background.md`、`read-safety-retry.md`、`read-architecture.md` を参照した。原資料は設計の承認ではない。
- 現状の照合基準: `6cfa901c951d33b853849e25fdbbea939dba2a20`。以下の `main/` は `apps/desktop/src/main/`、`native/` は `apps/desktop/computer-use-native/`、`renderer/` は `apps/desktop/src/renderer/` の略記である。行番号はこの版を指す。既存 ADR 内の過去の行番号を転載したものではない。

## 1. 問題と範囲

「同時に動作」には、人が別アプリを使う間に一つの AI が背景操作を続けることと、複数の AI が別々のアプリを同時に操作することの二つがある。前者は N9、後者が本 ADR の対象である。N15 は N9 と N3（K-1〜K-5 を含む）の後に実装する。背景入力と承認経路の Draft を、実装済みまたは承認済みとは扱わない。それぞれの承認と実装が前提であり、前提が変わった場合は本 ADR も再照合する。

成果は、対象を取り違えずに最大 3 セッションを動かし、固まった一つの対象の通常処理が他の背景セッションを待たせない設計である。必要な変更は Windows の helper 所有、入力の調停、対象の予約、停止・台帳の相関、複数セッションの表示である。この段階ではコードを変更しない。macOS の並行化、対象クラスや pattern の拡張、ブラウザ・Explorer の有効化、release は対象外である。共有コードを変更する N15 では macOS の既存の単一セッション、承認、停止のテストを保持する。

正しさは §2 の現コードとの対応、§3 の拒否条件と所有規則、§4 の試験で確かめる。この文書の完成は実機の PASS を意味しない。設計承認、N15 の実装、実機受入、公開は別の段階である。

## 2. 現状の要約

| 項目 | 現在の振る舞い | file:line |
| --- | --- | --- |
| Main の上限 | sessions / startingSessions / startInProgress のどれかがあれば新しい開始を拒否する。resume も sessions.size が 1 であることを要求する | `main/computer-use-controller.ts:2865`、`:2953` |
| Main の状態 | sessions は Map だが、開始中の controller・Task は単一の欄である | `main/computer-use-controller.ts:834`、`:897` |
| helper の所有 | addon 作成時に client を一つ作る。client は child・socket・connecting を一つずつ持ち、pending / starts / discoveries / semantic と数値世代を持つ | `main/computer-use-native-windows.ts:82`、`:254`〜`:269` |
| 起動と署名 | connect で世代を増やし、ランダムな pipe 名で spawn。起動した PID の実行 image を同期 PowerShell で検証する。検証の timeout は 10 秒 | `main/computer-use-native-windows.ts:722`〜`:755`、`:1097`〜`:1129` |
| native の上限 | sessions が空でなければ session_limit。pipe はインスタンス数 1 | `native/computer_use_windows_host.cc:5602`、`:11951`〜`:11954` |
| プロセスの本人性 | 保持した process handle、PID、生存、作成時刻を照合する | `native/computer_use_windows_host.cc:3292`〜`:3298` |
| UIA | connection 500 ms、transaction 300 ms、観測全体 25 秒。bounded automation を作れないと無制限の旧 automation に戻る | `native/computer_use_windows_host.cc:7254`〜`:7270` |
| worker の枠 | UIA read は helper 内で単一枠。semantic dispatch も同じ枠を取り、COM cleanup 後に返す。capture は別枠 | `native/computer_use_windows_host.cc:7293`、`:7299`、`:9605`〜`:9645` |
| claim と Stop | stop_mutex 内で claim と attempt を記録し、mutex を解放して外部 API を呼ぶ | `native/computer_use_windows_host.cc:8644`〜`:8667` |
| 前面依存 | capture と入力前再検証は前面の一致を要求する | `native/computer_use_windows_host.cc:7607`、`:9798`〜`:9817` |
| Host の隔離 | semantic 未確認・activeStopQuarantines・discovery・停止中 start owner を Host 全体の拒否へまとめる。PID の cache は identity digest がキー | `main/computer-use-native-host.ts:195`、`:226`〜`:255` |
| client の隔離 | semantic の uncertain / closeCandidate があれば Stop 以外を拒否。close の証拠は応答 object と世代に束縛する | `main/computer-use-native-windows.ts:272`〜`:314`、`:554` |
| Task の停止 | stopForTask / stopOutsideTask は対象 Task の開始中・実行中・探索を集めて並行に停止する | `main/computer-use-controller.ts:3672`〜`:3705` |
| 全体の無効化 | OFF、Renderer 無効化、dispose は Promise.all で探索・開始中・実行中を停止する | `main/computer-use-controller.ts:4108`〜`:4143` |
| 緊急停止 | shortcut と overlay は onStop を呼ぶが、IPC 側は単一の computerUseEmergencySessionId だけを停止する。overlay の対象矩形も一つである | `main/computer-use-emergency-stop.ts:17`〜`:30`、`:86`〜`:87`、`main/ipc.ts:1935`〜`:1938` |
| UI | hook は単一の session を持ち、その session の status を購読する | `renderer/hooks/useComputerUse.tsx:77`、`:123`〜`:144` |
| 資源 | 応答 cache は 256 件 / 32 MiB、frame queue は 64 件、raw capture の画素上限計算は約 7 MiB 相当 | `native/computer_use_windows_host.cc:158`〜`:159`、`:11667`、`:7659`〜`:7660` |

この base には `computer_use_windows_host_*.inc` は存在しない。該当する処理は上表の `.cc` で確認した。N1 等で分割された後は同じ関数・境界を追跡する。N3 の永続台帳、N9 の背景経路・監視は、この表の既存実装と混同しない。

## 3. 決定（案）

### 3.1 同時実行の単位と上限

**現状**: §2 の Main / native の上限、client の単一 child、pipe の 1 インスタンスが境界である（`main/computer-use-controller.ts:2865`、`main/computer-use-native-windows.ts:254`、`native/computer_use_windows_host.cc:5602`、`:11954`）。

**決めること・推奨案**: 一つのセッションに専用 helper / client / Host lane を一つ割り当てる。native の session_limit と各 pipe のインスタンス数は 1 のままにする。Main に Windows 専用 coordinator を置き、最大 3 lane を管理する。running だけでなく starting、paused、承認待ち、停止確認中も枠を占める。終了未確認の helper を枠から外して補充してはならない。

helper の上限も 3 とする。session のない discovery / picker は空き lane を使い、一つの lane に同時に一つの開始 owner だけを置く。空きが無ければ入力を伴わない容量拒否を返し、無制限に待ち行列を作らない。probe も上限の外に常駐 helper を増やさない。選択した target token は発行 lane と世代に固定し、同じ lane をその session へ昇格する。別 helper へ token をコピーしない。探索終了後の予約は既存 token の期限で退役し、別 session が動く lane に探索・picker を同居させない。

世代の識別は数値だけでは足りない。Main 起動 instance、lane ID、helperGeneration の組を内部の generation key とし、N3 の台帳・receipt・token・承認・exit observer に通す。各 client の generation=1 が重なっても別物である。新しい Main では instance を再利用しない。child object と process handle の所有は終了確認まで保持する。

**代案・理由**: 1 helper の中に 3 セッションを置けば署名・起動・COM 初期化を共有できる。しかし global worker slot や cancellation state の分離が必要で、D-5 により一つの停止が全セッションを失わせる。専用 helper なら kill の影響を一つの lane に限定でき、既存の単一セッション native 境界も保てる。上限 2 は必要最小限だが三者競合を扱えず、無制限は capture・COM・モデル呼出し・停止 UI の負荷が読めない。3 は二つの背景処理と一つの別作業を扱いながら資源と表示を小さく保つ初期上限である。性能実測に基づく最適値とは主張しない。

**N15 で作るもの**: lane factory、容量予約、owner から lane への不変な routing、複合世代、空き lane の discovery と昇格、退役処理を作る。署名確認は非同期化し、Main の停止通知を塞がない。10 秒の検証上限と起動済み PID / image / digest / signer の検査を維持し、検証完了前は handshake 成功扱いにも操作可能にもしない。Stop 後の遅い検証成功は破棄する。成功結果を別 child の検証として cache しない。署名検証用プロセスの終了・cleanup も lane owner が保持し、裏に残して枠を再利用しない。

### 3.2 入力の直列化と待ち

**現状**: 一つの helper 内の claim は短い stop_mutex の後に外部呼出しを行う（`native/computer_use_windows_host.cc:8644`）。別 helper 間の入力調停はこの処理にはない。前面一致は `:9803` で検査するが、それだけでは二つの helper の競合を防げない。

**決めること・推奨案**: 同じユーザー SID の Sprint Coder 全体に一つの coordinator を置く。複数インストール・別 Main による二重調停を防ぐため、Windows addon が SID で名前を分けた machine-wide named mutex を非継承 handle として所有する。名前空間と DACL の owner / SID を検証し、作成・open・照合に失敗したら Computer Use を閉じる。既に所有者がいる別 Main は Computer Use の開始を拒否する。他の AI 製品や人の入力をこの mutex で止められるとは主張しない。

この mutex は coordinator の単一性のためであり、入力一回ごとに OS 呼出しを囲む mutex ではない。所有 thread の異常終了による abandoned は安全な引継ぎの証拠ではない。新 Main は N3 の recovery と旧 helper の扱いを確定するまで gate を開かない。旧版・調停能力なしの helper を 3 lane の中へ混ぜない。別 OS ユーザーとは共有しない。

調停は「背景の共有 admission」と「前面の排他 admission」の二種類とする。前面と背景を混在実行する案は採らない。UIA が内部で対象 UI thread や proxy message を使い、予期せぬ前面変化を起こしうるためである。

| 処理 | 並行できるもの | 直列にするもの・保持する権利 |
| --- | --- | --- |
| background_semantic | 別プロセスの background_semantic、別 lane の観測 | 同一セッション内は 1 要求。共有 admission を一操作の最終再検証から応答の分類まで保持 |
| foreground_input / foreground_semantic | 別 lane の読み取りだけ | SID 全体で排他 1 件。背景の claim も閉じる。前面区間の owner は一つ |
| 前面への引渡し・人の前面再開・承認往復の復帰 | 別 lane の読み取りだけ | 前面入力と同じ排他。SetForegroundWindow だけ別 lock にしない |
| approval_round_trip | 別 lane の読み取りだけ | 前面区間の owner を保持し、全入力 claim を閉じる。カードへの移動で他 session に前面を貸さない |
| capture / UIA 読取り / copy | 別プロセスの観測、他 lane の許可済み処理 | 同一 lane の状態更新と観測は直列。SID の入力権利は取らない。copy は入力ではないが既存の権限・成果物束縛を維持 |
| モデル待ち・背景カードの回答待ち | 他 lane の許可済み処理 | 入力権利も短い state mutex も保持しない |
| Stop | 全 lane の Stop と並行 | 入力権利・観測枠・通常 queue の取得を待たない |

前面区間は N9 の「一操作ごとではなく前面セッションの区間」を維持する。同じ owner の連続入力を許すが、他 session の入力は待機する。人の pause / Stop、通常の focus 喪失、承認往復の拒否・失敗・期限で区間を終える。前面 owner がモデルを待つ間も他の入力を許すために自動的に権利を渡すことはしない。前面区間自体に N9 にない強制交代の期限は足さず、他 session の待ちは以下で有界にする。

ロックと所有権の順序は次のとおりである。

1. SID coordinator の生存を確認し、空き lane と対象プロセスの予約（§3.3）を state の短い更新で確保する。永続予約は排他権の記録であり、対象への OS 呼出し中に mutex を握ることではない。
2. session は未処理の入力要求を 1 件まで持つ。必要な admission が無ければ非同期に待つ。coordinator state mutex の中では owner / queue / epoch の更新だけを行い、UIA、署名確認、DB I/O、モデル、人の回答、他 lock の取得を待たない。native の stop_mutex と Main の mutex を跨いで同時保持しない。
3. 待ちの上限は `min(受付から1秒, 元要求の残り期限, ticket/intent の残り期限)` とする。lane ごとに 1 待機、合計 3 までである。期限切れは未送信の busy とし、その ticket を使って後から自動送信しない。Stop は直ちに待機を取り消す。前面待ちが来たら新規背景 admission を閉じ、既に許可した要求を drain する。FIFO で一つの前面候補を選び、期限が切れた候補は取り除く。
4. admission 取得後に N9 の対象・経路・epoch と N8 の authority を再検証する。待つ前の観測だけで dispatch しない。承認済み操作は復帰・再観測の後、承認交換の前に admission を確保し、exchange 後から dispatch まで observe / preflight / refocus を挟まない。150 ms の承認 dispatch 再測定上限と最大 5 秒の execution ticket の寿命は延長しない。
5. Main が発行する内部 permit を lane / 複合世代 / session / request / inputPath / 対象 / cancel epoch / 調停 epoch / 期限に束縛し、native が claim 前に一度だけ消費する。permit はモデルや Renderer へ渡さない。permit 発行から完了まで admission を保持し、Main が「未 claim」と推測して権利を回収しない。claim と Stop は従来どおり native の短い stop_mutex で順序付ける。
6. 入力を発行していない拒否か検証済み完了で admission を解放する。未知効果・応答消失では新規 claim を閉じ、K-1〜K-5 と Stop へ進む。helper の in-flight が解消した証拠（検証済み receipt または元 helper の exit）を得るまで、その admission は tombstone として保持する。待機期限や IPC 切断だけで解放しない。対象隔離の永続化を終えてから調停を開く。前面化の不明結果も helper 側の発行終了を確認するまでは排他を解放しないが、K-4 のとおり対象隔離は作らない。

**代案・理由**: 全操作の排他は簡単だが別プロセスの背景並行を実現しない。前面と背景を無条件に並行にする案は非活性化の保証を過大評価する。長い OS mutex の中で UIA を呼ぶ案は agent-desktop の最大 20 秒の先頭詰まりを再現する。推奨案は短い状態更新と、停止で解決する admission の所有を分離する。調停権を timeout だけで奪う案は二重入力になる。

**N15 で作るもの**: SID の単一 coordinator、共有 / 排他 admission、単発 permit、期限付き queue、writer の drain と Stop 優先を作る。named mutex の範囲・DACL・abandoned・別 Main の拒否を Windows seam で確認する。制御用の通信が失われた native は新規 claim を閉じ、既発行分は台帳と kill-stop で扱う。

### 3.3 同じ対象プロセスへの重複の防止

**現状**: native は PID + 作成時刻と保持 handle を照合する（`native/computer_use_windows_host.cc:3292`）。Host の `pidsByIdentity`（`main/computer-use-native-host.ts:195`）はアプリ identity ごとの PID cache であり、複数インスタンスの予約台帳ではない。

**決めること・推奨案**: 予約キーは SID + PID + 作成時刻とする。HWND、実行ファイルの名前、profile ID、app grant だけをキーにしない。検証済み対象から Main が予約し、start の native 本人性確認でも同じ値を照合する。予約競合では session を作る前に拒否する。PID 再利用、測定失敗、予約から開始までの target 変更を成功にしない。process handle と作成時刻を確定できない対象は開始不可である。

一つのプロセスの別 top-level window は同じ予約に属し、別 session を作れない。元 session が許可された owned dialog を扱う場合も予約は増やさず、N9 の dialog / takeover 規則に従う。異なる PID の同一アプリは独立プロセスとして許せるが、子プロセスや UIA tree の別 PID を親の許可から自動追加しない。入力先要素の owner PID が対象と違えば拒否する。独立した子の窓を扱うなら新しい対象として資格、grant、作成時刻、背景対応表を検証し、別予約と上限を消費する。共有 UI thread / proxy により非活性化・独立性を実機で示せない組は背景能力を開かない。プロセスの親子関係だけで権限を広げず、全子孫を自動予約することもしない。

paused / 承認待ちでも予約を保持する。正常 Stop の確定後に予約を解放し、K-1 の隔離があれば同じキーの隔離が引き継ぐ。効果不明でも予約だけを外して別窓から開始させてはならない。kill-stop の対象終了の照合（signaled、作成時刻不一致、PID 不在）と承認カードの条件だけで隔離を解く。アクセス拒否は終了証拠ではない。

**代案・理由**: HWND ごとの予約は同じアプリの UI thread に並行入力する。exe ごとの予約は別プロセスを過剰に止める。PID だけでは再利用を取り違える。PID と作成時刻を採り、N3 の隔離キーと一致させる。

**N15 で作るもの**: coordinator の予約 index、原子的な競合拒否、start / resume / discovery / dispatch の照合、別窓・子・再利用の負例を作る。N3 の対象 identity を Main/native の外へ公開しない。

### 3.4 固まったアプリの影響の閉じ込め

**現状**: UIA transaction は 300 ms だが、無制限への fallback がある（`native/computer_use_windows_host.cc:7254`〜`:7270`）。単一 UIA slot と別 capture slot は helper 内の資源である（`:7293`、`:7299`）。一呼出しの設定値は、複数呼出しや COM cleanup を含む総所要時間の保証ではない。

**決めること・推奨案**: 並行実行能力を開く helper は bounded UIA（connection 500 ms / transaction 300 ms）を必須とし、設定できなければ並行能力を閉じる。旧単一セッションの互換経路と混在させない。N8 のより短い 150 ms の承認再測定上限も維持する。N9 の preflight と入力所属の監視は lane ごとに働く。

背景 A の UIA / capture が固まっても B / C の worker 枠は独立である。背景 A の共有 admission が残っている間も、他の背景 admission は許せる。ただし前面排他の要求は drain を待ち、1 秒で busy になりうる。A の未確認 Stop が始まると、既存の host-wide 隔離を弱めず §3.5 の全体 gate を閉じる。終了確認後に B / C を継続可能にする。したがって「一つの固まりが他を止めない」は通常の背景処理の独立性であり、停止未確認時まで入力を継続する保証ではない。

300 ms を過ぎたことだけを API の取消し完了とせず、worker が戻らなければその lane の枠を保つ。通常処理のために新 worker を無制限に足さない。入力の未知効果は K-1 で隔離して Stop、入力前の観測失敗はその session の失敗として Stop へ進める。停止は N3 の C / T を使い、N15 が短縮しない。helper 終了の影響範囲はその lane の全 owner であり、D-5 は維持する。他の helper は殺さない。対象アプリを殺すこともない。

**代案・理由**: 1 helper 内の複数 worker は COM や終了の影響を共有する。固まった thread の強制終了、timeout 時の lock 強制解放は停止証拠にならない。専用 helper と既存 kill-stop を使い、通常時の独立性と停止時の安全側の拒否を分ける。

**N15 で作るもの**: bounded UIA の能力 gate、lane ごとの fault 処理、遅い結果の世代照合、固まり fixture、B / C が進むことと停止隔離の例外の試験を作る。

### 3.5 Stop・台帳・承認・takeover の範囲

**現状**: Host / client の未確認は全体の拒否であり、緊急停止の接続先は 1 session である（`main/computer-use-native-host.ts:247`、`main/computer-use-native-windows.ts:312`、`main/ipc.ts:1935`）。Task 停止は複数 owner を列挙する形が既にある（`main/computer-use-controller.ts:3672`）。

**決めること・推奨案**: 全体 Stop と緊急停止は、開始中・探索中・承認待ち・paused を含む全 lane に同じ入口で並行にかける。まず同期的に coordinator の新規開始・permit 発行・カード消費を閉じ、対象 owner の snapshot を取り、各 lane の Stop を開始してから全結果を集める。一つの await が終わるまで次の lane を止めない。新規 owner と Stop の競合も同じ gate で拒否する。

| 事象 | 効く範囲 | 後始末・再開 |
| --- | --- | --- |
| 全体 Stop / 緊急停止 / OFF / Renderer 無効化 / dispose | 全セッション・全開始 owner・全探索 | 各 lane の cancel / close / kill-stop を並行に実施し、全件の結果を表示 |
| 行の「このセッションを停止」、所有者の computer_stop | 指定 session とその lane の owner | 他 session を kill しない。台帳・隔離を迂回しない |
| Task / Turn の終了、policy 変更、grant / 送信同意の取消し | 該当所有者・権限に属する全 session | Task / Turn を越えた存続やカードの使い回しを認めない |
| helper 終了・crash | 当該複合世代の全 owner | D-5 の completeStop、カード・ticket・artifact・token の失効、各 Task への通知 |
| Stop 未確認・termination_requested | coordinator 全体の新規入力・開始 gate | N3 の receipt / 元 helper exit の証拠があるまで拒否。新 helper を補充しない |
| terminated_target_suspect / K-1 | PID + 作成時刻の対象 | 他 lane の同じ対象も拒否。終了の照合か規定のカードでだけ解除 |
| 対象に属する人の入力 / 背景対象の前面化 | 当該背景 session の interaction epoch と claim gate | 即座に pause・ticket / intent 失効。人の再開と新規観測が必要 |
| 入力所属不明・secure desktop・監視の失明 | 関連性を判別できない全背景 lane。前面 lane も自身の desktop / focus gate で拒否 | fail-closed。検知を一つの lane だけに押し付けない |

N3 の永続台帳は一つの store に集約し、行の helper 世代を §3.1 の複合世代にする。beforeWrite の記録、書けなければ送らないこと、応答待ちを transport timeout / failAll で消さないことを保持する。成功・accepted=false・検証済み receipt の扱いは kill-stop に従い、背景の応答待ち・効果不明には K-3 の例外を適用する。K-1 の即時隔離、K-2 の実行中の dispatch / 承認交換 / 引渡しの拒否、K-4 の inputPath と前面化の記録・対象隔離判定からの除外、K-5 の Stop 後の新 session でのカードをすべて保持する。古い lane の receipt が新しい lane の行を消せないことを store と応答 object の両方で保証する。

通常の停止期限は N3 が確定した値を使う。開始済みは cancel ack の 1 秒 + C + T、native start 待ちは C + T、探索は N3 の探索停止期限 + T であり、3 lane 分を足し合わせない。C は実測による変更までは 10 秒、T は kill-stop の目安 2 秒を参照するに留める。T 内に exit が来なければ停止済みと表示しない。Main 再起動時の台帳 recovery、libuv job の検証条件と例外も N3 / N4 のままである。

承認カードは session / Task / Turn / lane / 複合世代 / approvalGeneration に束縛する。一覧に複数カードがあっても一つのクリックで複数を承認しない。カード出現は focus を奪わず、背景カードの回答待ちは他の背景処理を止めない。前面への引渡し・人の再開・approval_round_trip の復帰は §3.2 の排他を取ってから行う。取得できなければ前面化せず期限内の busy とし、遅れて自動復帰しない。

approval_round_trip は一つの前面 owner のみが持つ。対象と Sprint Coder 以外（別 session の対象を含む）への前面移動は失敗を保持し、pause する。別 session のカードを押したという事実は元の往復の承認にならず、元対象の自動復帰を起こさない。背景 session には往復を設けず、N9 の背景再観測で進める。対象の隔離解除カードは operation の承認や不明な helper の停止証拠を代替しない。

N9 の mouse hook / WinEvent と interaction epoch は各専用 helper が自分の対象について管理する。別 session が前面化した事実を「AI の操作だから」と全体的に無視しない。関係しない通常アプリの入力なら背景処理を続け、対象の任意の top-level window への入力・前面化なら該当 lane を止める。前面 session は N9 どおり interaction epoch を持たず、focus / dialog / Stop の規則を維持する。全体 Stop の調停 epoch と対象ごとの interaction epoch を混同しない。

**代案・理由**: 全台帳を sessionId だけで管理すると複数 client の世代・遅い receipt を取り違える。すべての pause で全 session を殺す案は独立性を失う。反対に termination_requested の隔離を lane 内へ狭める案は kill-stop の確定契約を変えるため採らない。

**N15 で作るもの**: 並行 Stop の集約、全体 gate、複合世代への台帳接続、per-session の承認・監視状態、停止結果一覧を作る。全体隔離を解除しても他 lane の古い permit は復活させず、新規検証から進める。

### 3.6 Main と UI の状態

**現状**: Controller の sessions Map に対し開始中の欄は単一で、resume は全体件数を検査する（`main/computer-use-controller.ts:834`、`:897`、`:2953`）。UI hook と緊急停止の対象も単一である（`renderer/hooks/useComputerUse.tsx:77`、`main/ipc.ts:1936`）。

**決めること・推奨案**: Controller の開始 owner を Map 化し、start / cancel / resume の条件はその owner と容量・対象予約で判断する。Host lane は session の native state、receipt、revision、attempt counter、discovery owner を持ち、coordinator は lane routing、容量、対象予約、入力調停、全体隔離を持つ。client の pending と decoder は接続ごとに分離する。session を「現在の client」に送る入口は作らない。PID cache は予約・認可の代わりに使わない。

UI は AI / Task、検証済み対象ラベル、背景 / 前面、実行中 / 待機 / 承認待ち / 停止確認中 / 隔離を行ごとに示す。一番見つけやすい Stop と緊急 shortcut / overlay は全体 Stop とする。行の停止は「このセッションを停止」と明記する。停止済み行と停止未確認行を分け、未確認が一つでもあれば全停止成功と表示しない。前面 owner のために背景が待つ理由と 3 件上限も表示する。

overlay は一つの全体 Stop として保ち、すべての対象矩形を避けて配置し、visual 入力の衝突判定も全対象で行う。配置不能・shortcut 登録失敗・監視不能なら新規 control を開かず、実行中は全体停止へ進める。一つが終わっただけで overlay を disarm しない。全 owner が終端となるまで停止手段を残す。

Task の選択変更で別 Task の session を止める既存契約（`main/computer-use-controller.ts:3690`）は緩めない。まず同じ現役 Task 内の複数 AI / Turn owner で並行し、Task を離れた際には従来どおり該当 session を停止する。別 Task を無断で背景実行し続ける機能を N15 に含めない。各 `computer_start` が終了まで呼出し元 Turn を保持する V2 の契約も維持する。

**代案・理由**: 上限の if 文だけを削除すると開始取消し、UI、緊急停止が別 session に作用する。単一の「選択中 session」のみを表示する案は停止の見落としを招く。owner と一覧を明示し、既存の Task / Turn の権限を保つ。

**N15 で作るもの**: Controller / Host / client の owner 分離、複数 status の取得・購読と revision、一覧・行停止・全体停止、overlay の集合判定を作る。IPC / contracts は strict schema を正本として Main / Preload / Renderer を揃え、PID・作成時刻・handle・内部 permit を外へ出さない。

### 3.7 観測と資源の上限

**現状**: UIA と capture は別の単一枠であり、UIA 枠は semantic dispatch と共有する（`native/computer_use_windows_host.cc:7293`、`:7299`、`:9605`）。観測は 25 秒の budget、capture の前面条件と既存の frame / cache 制限を持つ（`:7256`、`:7607`、`:158`、`:11667`）。

**決めること・推奨案**: 別プロセスの観測を最大 3 lane で並行に許す。同一 session は一つの観測 / preflight / dispatch の流れを直列にし、観測による revision 更新が承認交換後に割り込まない。UIA は各 helper 1 枠、capture / PNG は各 helper 1 枠とし、合計各 3 枠を上限とする。UIA object、COM apartment、画像 buffer、Session 参照を helper 間で共有しない。

待機要求は lane ごとに 1 件までとし、連続した自動観測要求は最新の未送信要求へまとめる。dispatch / 承認要求はまとめたり置換したりしない。Stop は観測 queue と独立である。既存の観測 25 秒 budget と byte / node / depth 上限を延ばさない。枠が埋まっていれば読み取りの busy を返し、古い画面を新規観測として返さない。capture は N9 の対象 HWND への WGC と鮮度検証だけを使い、画面全体の BitBlt や PrintWindow へ逃げない。

応答 cache の既存上限を lane ごとに維持すると 3 lane 合計で最大 96 MiB、frame queue は最大 192 件となる。raw capture の約 7 MiB 相当は 3 枚で約 21 MiB だが、これは process RSS の上限ではない。COM・PNG・モデル入力・一時 buffer は別に増える。N15 では helper 数と要求数を有限にし、各 lane は最新観測だけを保持し、不要な binary を破棄する。Provider 送信同意と redaction は各 session で検査し、他 session の観測・copy artifact を流用しない。#785 の明示的な参照転記の契約だけを維持する。

**代案・理由**: 全観測を一列にすると一つの UIA が他を止める。無制限の worker / capture は停止とメモリの上限を失う。3 lane の独立枠を選び、RSS・CPU・GPU・遅延は §4 の実測で公開可否を判定する。

**N15 で作るもの**: 有界な観測 scheduling、per-lane の資源解放、上限超過の拒否と測定項目を作る。新しい固定 RSS 合格値を根拠なく作らず、N9 の既存基準を保持したうえで実測結果をレビューする。

### 3.8 試験の方針

**現状**: §2 の単一セッション制限があるため、本 base は複数 helper での誤配の無さを証明していない。UIA の単一枠（`native/computer_use_windows_host.cc:9605`）や単一緊急停止（`main/ipc.ts:1935`）の試験だけでは並行の証明にならない。

**決めること・推奨案**: §4 の単体・境界・Windows 実機を組み合わせる。新しい振る舞いの実装では回帰テストの RED → GREEN を記録し、既存の拒否・単発性・macOS の期待を緩めない。

**代案・理由**: 3 プロセスが起動したこと、モデルの成功文、build 成功、画面の前後比較だけでは誤配・一瞬の前面化・停止漏れを示せない。実操作と入力回数・世代相関の受動証拠を併用する。

**N15 で作るもの**: §4 の fixture と受動 observer、Vitest、Windows native seam、Computer Use チェックリストのケースと artifact を作る。本 ADR 作成では試験を実行していない。

## 4. 正しさの証明と Windows 実機の受入

| ケース | 単体・境界で固定すること | Windows 実機での操作・合格条件 |
| --- | --- | --- |
| CS-1: 2〜3 背景 session | 独立 PID へ同時 admission、同じ request ID 値でも lane / 世代で分離。観測・ticket・応答・artifact の交差を拒否 | 別 PID の合成 fixture を 2 個、次に 3 個操作し、人は第四のアプリへ入力する。異なる合成値と操作回数が各対象だけに届き、前面・カーソルを奪わない。barrier 付き fixture で実際の背景呼出しの重なりも確認 |
| CS-2: 予約と容量 | 同一 PID + 作成時刻の start 競合、同一 PID の別窓、PID 再利用、別 PID の子、本人性取得失敗、4 件目の拒否 | 同じアプリの別窓を二重選択して拒否される。独立 PID の窓は資格検証後に開始できる。3 件を超える helper が残らない |
| CS-3: 前面排他 | shared と exclusive の重なり 0、writer drain、1 秒期限、Stop による待機取消し。前面待ち期限後の遅延発行 0 | 二つが同時に前面引渡しを求めても一つだけ前面区間を得る。前面 owner の連続入力中は背景入力が待ち、観測は可能。人の操作で pause 後、新規検証から継続 |
| CS-4: 固まり | A の UIA / capture / cleanup を止めても B / C の枠を使える。無制限 UIA では gate 閉鎖 | A の provider を意図的に固め、Stop 前に B / C の背景操作が完了する。A の Stop 中は全体 gate の例外を確認し、元 helper exit 後は B / C が新規検証で進む。対象アプリは kill されない |
| CS-5: 全体停止 | 全 lane の latch が最初の await より前。starting / discovery / approval / pending permit を含める。各 lane の C / T を並行計測 | 一つが固まり、一つが承認待ち、一つが実行中の状態で全体 Stop と Ctrl+Shift+F8 をそれぞれ実行する。全 owner に停止が届き、N3 の期限内の結果を個別表示。termination_requested を成功表示しない |
| CS-6: kill-stop と K-1〜K-5 | beforeWrite 保存失敗、応答消失、accepted=true 未確認、receipt の背景例外、K-4 の前面化、起動時 recovery、別世代 receipt 拒否 | helper exit 後の新規入力 0。遅れて対象に反映する既発行操作は別に記録し、対象隔離・警告が残る。承認カードを経た新 session 以外で再開しない |
| CS-7: 承認と takeover | カードの取り違え・replay・二重消費 0。往復中の第三窓、別 session の前面化、hook 失明、所属不明 | 背景 A のカードを開いても背景 B が進む。前面 A の往復中に B へ移ると A は pause し、自動復帰しない。対象への人の pointer 操作で該当背景 lane が止まる |
| CS-8: 起動と復旧 | 署名確認を遅延・失敗・取消し、古い exit / attest 応答、別 Main の SID mutex 競合、abandoned と recovery | 3 lane の起動・終了を反復して Main の Stop UI が応答する。第二 Main は Computer Use を開始できない。Main crash 後は N3 / N4 の条件なしに旧 helper と新 helper が入力を重ねない |
| CS-9: UI と資源 | status revision の session 別順序、行停止と全体停止、overlay 全対象衝突、最後の owner まで停止手段維持 | light / dark、Tab / Shift+Tab、カードの非自動 focus、複数 monitor / DPI、容量・busy・隔離表示を操作確認。3 lane を反復して helper / handle / queue が増え続けない |

実機操作は開発エージェントの Computer Use で行う。shell は fixture 準備、起動、ログとファイルの照合、受動計測に限る。UI 操作を内部 IPC・DOM・スクリプトで置き換えない。実 Provider の課金を伴う試験は本設計の受入に必須とせず、別途明示された場合だけ行う。

受動 observer は foreground WinEvent、cursor 位置の event と補助 sampling、API attempt、fixture の入力回数、claim / Stop / helper exit の単調時刻を相関させる。秘密、メールアドレス、実本文を入れず、合成値と最小 metadata を使う。本文・path・PID をモデル向け表示や監査へ追加しない。計測不足なら BLOCKED であり、一瞬の誤配なしを sampling だけで PASS にしない。

記録には build / SHA、Windows 10 / 11 の対象版、アプリ・provider 版、DPI / monitor / 仮想 desktop、各 helper の相関 ID、目的、操作、期待結果、実測、artifact、PASS / FAIL / SKIP / BLOCKED を含める。1 / 2 / 3 lane で署名・起動時間、UIA / capture 遅延、停止期限、Main event loop 遅延、RSS・CPU・GPU・handle 数を比較する。期限違反、誤配、単調な資源増加は公開不可である。既存の N8 / N9 の数値基準を緩めず、未証明の provider の背景能力は閉じる。

## 5. N15 の実装スライス

全 PR は本 ADR の承認、N9、N3（K-1〜K-5、N4 の終了・job 前提を含む）の後とする。後続実装の実コードで §2 の位置を引き直し、前提の不一致は実装前に相談する。並行 gate は最後まで本番で閉じ、途中 PR は単一 session の既存経路を保持する。各 PR で対象 typecheck と直接関連テスト、共有変更では macOS の既存テストを通す。

| 順序 | PR の単位 | 依存 | 試験 |
| --- | --- | --- | --- |
| N15-1 | 起動境界: 署名確認の非同期化、取消し、終了までの child / attest process 所有。能力は単一のまま | N9、N3、本 ADR 承認 | CS-8 の起動部分。署名不一致・timeout・Stop 後の遅い成功、Main が停止を受け付けること |
| N15-2 | 所有境界: 専用 lane factory、複合世代と台帳、対象予約、探索の同じ lane への昇格、終了影響の分離。試験用だけ 3 lane | N15-1 | CS-2、CS-6、CS-8。旧 receipt、PID 再利用、上限、台帳 recovery、D-5 |
| N15-3 | 入力境界: SID coordinator、共有 / 排他 admission、単発 permit、bounded UIA gate、drain / timeout、Stop 優先 | N15-2 | CS-1、CS-3、CS-4 の native seam。mutex / DACL / abandoned、claim と Stop 競合 |
| N15-4 | Main 接続: Controller の開始 owner 分離、並行 Stop 集約、K-1〜K-5、承認往復・takeover と調停、観測上限 | N15-3 | CS-4〜CS-7。全 Stop 入口、150 ms / 5 秒契約、別カード・別世代、観測割込み |
| N15-5 | 表示境界: 複数 status の IPC / contracts と一覧、行停止・全体停止、overlay の集合判定 | N15-4 | CS-5、CS-7、CS-9。Renderer interaction、keyboard、非自動 focus、旧 darwin 契約 |
| N15-6 | Windows 受入と gate: 実機証拠、資源・遅延計測、対応能力の照合と公開候補の接続 | N15-5 | CS-1〜CS-9 の 2 / 3 lane 実機。不足は BLOCKED、gate は閉鎖を維持 |

N15-6 の PASS は release や別対象クラスの有効化の許可ではない。独立した敵対的レビュー、PR、Review BOT、要塞レビュー、オーナーの設計承認は親の工程である。

## 6. オーナーに判断してもらうこと

次は一問につき一判断であり、推奨はすべて未承認の案である。

1. セッションごとの専用 helper を採用するか。推奨は採用である。起動費用が増える代わりに D-5 の巻き添えを lane 内に限定する（§3.1）。
2. session と helper の同時上限を 3 とするか。推奨は 3 である。開始・停止待ち・探索も枠を使い、4 件目は容量拒否とする（§3.1）。
3. SID ごとの単一 coordinator とし、第二 Main の Computer Use を拒否するか。推奨は拒否である。複数 Main を跨ぐ分散調停を N15 に追加しない（§3.2）。
4. 背景同士だけを共有にし、前面区間は背景入力も含めて排他にするか。推奨はこの規則である。前面中の背景入力は待つが、観測は並行できる（§3.2）。
5. admission の待ちを最大 1 秒とし、期限後の自動送信を禁止するか。推奨は採用である。元の ticket / intent の期限の方が短ければそちらを使う（§3.2）。
6. 同一 PID + 作成時刻への session を一つに限るか。推奨は採用である。同じプロセスの別窓も二重開始しない（§3.3）。
7. 子プロセスの対象を自動追加せず、独立した資格・予約を要求するか。推奨は要求することである（§3.3）。
8. bounded UIA を並行実行の必須条件にするか。推奨は必須である。対応しない環境は並行 gate を閉じる（§3.4）。
9. Stop 未確認時の全体隔離を維持するか。推奨は維持である。通常の固まりは局所化するが、termination_requested 中の他 session の新規入力は許さない（§3.5）。
10. 最上位 Stop と緊急停止を全体停止とし、別に行停止を置くか。推奨はこの表示である（§3.6）。
11. Task を離れた際の停止を維持し、N15 の並行実行を現役 Task の所有範囲に限るか。推奨は維持である（§3.6）。
12. §4 の Windows 実機証拠を並行 gate の公開条件にするか。推奨は必須である。設計・CI だけでは開かない。

### 6.1 残るリスクと前提

helper exit は新しい入力が出ない証拠であり、対象側の遅延 UIA / SendInput の取消しではない。completed の Invoke の後の非同期効果、前面化の遅延、OS event と claim の競合は N9 / kill-stop の残余リスクのままである。排他 admission でも既に対象へ届いた入力や他製品・人の入力を取り消せない。

同じ SID の別 Main の拒否は使い勝手の制約となる。3 helper の署名・COM・画像処理費用、複数 hook の遅延、覆われた窓の capture、named mutex の名前空間と DACL は実機で未確認である。N15 の試験で確認するまで能力を宣言しない。SID coordinator の復旧は kill-stop の Main crash / job の前提に従い、N3 / N4 が前提を変更した場合に独自の緩い復旧を作らない。

承認後の別変更で V2 ADR の単一セッション、kill-stop の世代と D-5 の適用単位、N9 の複数 lane の調停、承認経路の複合世代参照へ本 ADR を接続する。今回は既存 4 ADR を変更しない。本 ADR は deny class、権限・送信同意、未知の拒否、単発承認、K-1〜K-5 を緩めない。

agent-desktop から採るのは入力の調停と取得後の再照合という考え方である。自動前面化、モデルが指定できる `--force`、呼出し後の失敗を `not_delivered` に落として再試行すること、幾何だけの要素一致、権限を読めない場合の許可は採らない。外部リポジトリのコード・スクリプトを実行・転記しない。
