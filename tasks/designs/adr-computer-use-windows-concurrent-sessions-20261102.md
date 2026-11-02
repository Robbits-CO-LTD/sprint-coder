# ADR: Computer Use Windows — 複数セッションの同時実行

- Status: Draft（オーナー承認の前。N15 の実装・公開を承認したものではない）
- Date: 2026-11-02
- Issue: #996（Refs #988, #500, #994）
- 関連: [V2 ADR](adr-computer-use-agent-driven-v2.md)（Main の権限、Task / Turn の所有、§5.2〜§5.4 のツール面と token、§6.1 の初回許可カード、D14、§8 の不変条件）
- 関連: [kill-stop ADR](adr-computer-use-windows-kill-stop-20261102.md)（Accepted。§2.2 の台帳・確定の 3 状態・対象隔離、§2.5 と D-5、§3.1 の停止期限、§3.3 の起動したアプリの遅れた focus）
- 関連: [承認経路 ADR](adr-computer-use-windows-approval-path-20261102.md)（2026-11-02 オーナー承認済み・未実装。§2.2 の単発 ticket、§2.7 の世代、§2.8 の UI）
- 関連: [背景入力 ADR](adr-computer-use-windows-background-input-20261102.md)（#994。2026-11-02 オーナー承認済み・未実装。§2.1〜§2.6 の入力経路、interaction epoch、takeover、approval_round_trip、§2.5 の K-1〜K-5）
- 参考: vercel-labs/agent-desktop（Apache-2.0、調査版 `9eb9b29`）。考え方だけを参考にし、コードは使わない。ローカルの `F:/work/ext/agent-desktop/LICENSE` と、`F:/work/scg-988-runs/agent-desktop-study/` の `critic.md`、`compare.md`、`read-concurrency.md`、`read-windows-background.md`、`read-safety-retry.md`、`read-architecture.md` を参照した。原資料は設計の承認ではない。
- 現状の照合基準: 本文中のコードの行番号は、すべて base `6cfa901c951d33b853849e25fdbbea939dba2a20` のものである。以下の `main/` は `apps/desktop/src/main/`、`native/` は `apps/desktop/computer-use-native/`、`renderer/` は `apps/desktop/src/renderer/` の略記である。`native/computer_use_windows_host.cc`（以下 host.cc）は N1 で `.inc` へ分割中なので、host.cc の参照には関数名を添える。既存 ADR 内の過去の行番号を転載したものではない。他の ADR の節番号は main の版による。

## 1. 問題と範囲

「同時に動作」には、人が別アプリを使う間に一つの AI が背景操作を続けることと、複数の AI のセッションが別々のアプリを同時に操作することの二つがある。前者は N9（背景入力 ADR）、後者が本 ADR の対象である。N15 は N8、N9 と N3（K-1〜K-5 を含む）の後に実装する。承認経路 ADR と背景入力 ADR は 2026-11-02 にオーナーが承認済みで、まだ実装されていない（両ファイルの Status 欄は Draft のまま更新されていない）。本 ADR はそれらの承認済みの設計を前提とし、実装済みとは扱わない。実装の段階で前提が変わった場合は本 ADR を再照合する。

成果は、対象を取り違えずに最大 3 セッションを動かし、固まった一つの対象の通常処理が他の背景セッションを待たせない設計である。必要な変更は、並行の供給源（§3.6）、Windows の helper 所有、入力の調停、対象の予約、停止・台帳の相関、複数セッションの表示である。この段階ではコードを変更しない。macOS の並行化、対象クラスや pattern の拡張、ブラウザ・Explorer の有効化、release は対象外である。共有コードを変更する N15 では macOS の既存の単一セッション、承認、停止のテストを保持する。

正しさは §2 の現コードとの対応、§3 の拒否条件と所有規則、§4 の試験で確かめる。この文書の完成は実機の PASS を意味しない。設計承認、N15 の実装、実機受入、公開は別の段階である。

## 2. 現状の要約

| 項目 | 現在の振る舞い | file:line |
| --- | --- | --- |
| Main の上限 | sessions / startingSessions / startInProgress のどれかがあれば新しい開始を拒否する。resume も sessions.size が 1 であることを要求する | `main/computer-use-controller.ts:2865`、`:2953` |
| Main の状態 | sessions は Map だが、開始中の controller・Task は単一の欄である | `main/computer-use-controller.ts:834`、`:897`〜`:900` |
| ツールの claim | computer_list_targets・computer_request_access・computer_start・computer_stop の 4 つが `computer-use:${taskId}` の write claim を取る。ToolBroker は同じキーの claim を write に合成し、claim の gate は Turn ごとに一つ作る。computer_start はセッションの終了まで返らず、その間 claim を持ち続ける | `main/computer-use-target-tools.ts:177`、`:191`、`:205`、`:214`、`main/tool-broker.ts:186`〜`:191`、`:411`、`:581` |
| 開始の可否 | session gate は Task が archive されていないこと、`getActiveTurnId(taskId) === ownerTurnId`、`!hasBusyWorkers(taskId)` を要求する。Controller の canStartSession に接続されている | `main/computer-use-session-gate.ts:32`、`main/ipc.ts:1961`〜`:1967` |
| Turn の単位 | 現役の Turn は Task ごとに一つである。別々の Task は同時に現役の Turn を持てる（更新時の確認は全 Task の現役 Turn を列挙する） | `main/persistence.ts:20338`〜`:20346`、`main/ipc.ts:5186`〜`:5197` |
| Turn 開始時の停止 | 新しい Turn・queued Turn・Team の hire / resume / send は stopForTask(taskId, 'turn_started') を呼び、その Task の探索・開始中・実行中を止める。Turn ではなく taskId で絞る | `main/ipc.ts:4212`、`:4221`、`:4230`、`:4290`、`:6457`、`:6480`、`main/computer-use-controller.ts:3672`〜`:3687` |
| Task 選択の停止 | Task の messages の読込み（Renderer の Task 選択）が stopOutsideTask を呼び、選択外の Task の探索・開始中・実行中を止め、選択外の app-grant カードを引く | `main/ipc.ts:3715`、`:4894`〜`:4897`、`main/computer-use-controller.ts:3689`〜`:3706` |
| target token | listTargets は冒頭で revokeTargetTokens(taskId) を呼ぶ。失効は binding の taskId が一致するもの（と期限切れ）だけで、他の Task の token は消さない。start で token を消費する。TTL は 5 分 | `main/computer-use-controller.ts:1658`、`:1954`〜`:1961`、`:2612`、`main/computer-use-target-model.ts:23` |
| app-grant カード | 未解決のカードは全体で 1 枚の欄。2 枚目は access_request_pending。T8 の per-Turn 上限は 2 で、カードを出した時に数える | `main/computer-use-controller.ts:849`、`:2046`、`:2047`〜`:2052`、`:2068`、`:2249`〜`:2252`、`main/computer-use-access-request.ts:36` |
| copy artifact | 保持できる数は Task ごとに 3 件 | `packages/contracts/src/index.ts:6482`、`main/computer-use-artifact.ts:362`〜`:368` |
| Task ごとの表示 | IPC は Task ごとに session ID を一つ持つ | `main/ipc.ts:1099`、`:5096`〜`:5103` |
| helper の所有 | Windows の addon は helper exe を起動する TS の client を一つ作る object である。client は child・socket・connecting を一つずつ持ち、pending / starts / discoveries / semantic と数値世代を持つ | `main/computer-use-native-windows.ts:76`〜`:82`、`:254`〜`:269` |
| Main の native module | binding.gyp の唯一の target は macOS の `computer_use_macos.mm` で、mac 以外では type none になる。Main に Win32 の mutex・DACL を呼ぶ module は無い | `native/binding.gyp:5`、`:8`〜`:12` |
| 単一インスタンス | Electron の requestSingleInstanceLock だけがある | `main/index.ts:143` |
| 起動と署名 | connect で世代を増やし、ランダムな pipe 名で spawn。起動した PID の実行 image を同期 PowerShell で検証する。検証の timeout は 10 秒 | `main/computer-use-native-windows.ts:722`〜`:755`、`:1097`〜`:1129` |
| native の上限 | sessions が空でなければ session_limit。pipe はインスタンス数 1 | host.cc `StartWindowsNewSession`（`:5602`）、`ServeMain`（`:11951`〜`:11954`） |
| プロセスの本人性 | 保持した process handle、PID、生存、作成時刻を照合する | host.cc `WindowsSessionProcessMatches`（`:3292`〜`:3298`） |
| 探索の候補 | 候補の JSON は pid・windowHandle・digest などを持ち、作成時刻は windowIdentityDigest の入力に使うだけで値としては出さない | host.cc `CollectTopLevelWindow`（`:3808`〜`:3826`。作成時刻は `:3810`） |
| 探索による起動 | 対象窓が無ければ検証済みの exe を起動する。起動の claim が見るのは helper 内の semantic 入力の in-flight だけである | host.cc `MeasureWindowsDiscovery`（`:6273`〜`:6278`）、`RunWindowsDiscovery` の `claim_launch`（`:6404`〜`:6411`） |
| picker | ファイル選択ダイアログを表示する | host.cc `PickWindowsExecutable`（`:3193`、`:3213`） |
| 前面の検査と送信 | 入力の直前に前面の一致を検査し、その後に SendInput を呼ぶ。二つの呼出しの間は原子的ではない | host.cc `RevalidateWindowsTarget`（`:9798`〜`:9817`）、`SendInputForBoundTarget`（`:9820`〜`:9826`） |
| UIA | connection 500 ms、transaction 300 ms、観測全体 25 秒。bounded automation を作れないと無制限の旧 automation に戻る | host.cc `CreateWindowsV1Automation` とその定数（`:7254`〜`:7270`） |
| worker の枠 | UIA read は helper 内で単一枠。semantic dispatch も同じ枠を取り、COM cleanup 後に返す。capture は別枠 | host.cc `WindowsUiaReadWorkerRunning`（`:7293`）、`WindowsCaptureWorkerRunning`（`:7299`）、`DispatchWindowsSemanticAction`（`:9605`〜`:9645`） |
| claim と Stop | stop_mutex 内で claim と attempt を記録し、mutex を解放して外部 API を呼ぶ | host.cc `InvokeWindowsSemanticInput`（`:8644`〜`:8667`） |
| 前面依存 | capture と入力前再検証は前面の一致を要求する | host.cc `CaptureWindowWithGraphicsCaptureOnWorker`（`:7607`）、`RevalidateWindowsTarget`（`:9798`〜`:9817`） |
| Host の隔離 | semantic 未確認・activeStopQuarantines・discovery・停止中 start owner を Host 全体の拒否へまとめる。PID の cache は identity digest がキー | `main/computer-use-native-host.ts:195`、`:226`〜`:255` |
| client の隔離 | semantic の uncertain / closeCandidate があれば Stop 以外を拒否。close の証拠は応答 object と世代に束縛する | `main/computer-use-native-windows.ts:272`〜`:314`、`:554` |
| Task の停止 | stopForTask / stopOutsideTask は対象 Task の開始中・実行中・探索を集めて並行に停止する | `main/computer-use-controller.ts:3672`〜`:3706` |
| 全体の無効化 | OFF、Renderer 無効化、dispose は Promise.all で探索・開始中・実行中を停止する | `main/computer-use-controller.ts:4108`〜`:4143` |
| 緊急停止 | shortcut と overlay は onStop を呼ぶが、IPC 側は単一の computerUseEmergencySessionId だけを停止する。arm は ID を上書きし、disarm は一致した一件で overlay 全体を外す。visual 入力の衝突判定もその一件だけに効く | `main/computer-use-emergency-stop.ts:29`〜`:31`、`:86`〜`:87`、`main/ipc.ts:1101`、`:1934`〜`:1938`、`:2069`〜`:2083` |
| overlay の配置 | arm は既に armed なら新しい矩形を見ずに true を返す。配置は対象と重ならず work area に収まる候補を全 display で探し、無ければ失敗する。reposition の失敗は overlay を disarm する。衝突判定は click / scroll の座標と一つの対象矩形だけを見る | `main/computer-use-emergency-stop.ts:23`〜`:24`、`:44`〜`:53`、`:107`〜`:122`、`:132`〜`:143`、`:176`〜`:203` |
| overlay の失敗の扱い | Controller は arm の失敗で開始を拒否し、開始時の reposition の失敗で例外にする。観測・承認・resume の reposition の失敗ではそのセッションを emergency_stop で止める | `main/computer-use-controller.ts:3233`〜`:3237`、`:3260`〜`:3261`、`:3039`〜`:3041`、`:3859`〜`:3863`、`:5706`〜`:5708` |
| UI | hook は単一の session を持ち、その session の status を購読する | `renderer/hooks/useComputerUse.tsx:77`、`:123`〜`:144` |
| 資源 | 応答 cache は 256 件 / 32 MiB、frame queue は 64 件、raw capture の画素上限計算は約 7 MiB 相当 | host.cc の定数（`:158`〜`:159`）、`ServePipe`（`:11667`）、`CaptureWindowWithGraphicsCaptureOnWorker`（`:7659`〜`:7660`） |

この base には `computer_use_windows_host_*.inc` は存在しない。該当する処理は上表の host.cc で確認した。N1 等で分割された後は同じ関数・境界を追跡する。N3 の永続台帳、N9 の背景経路・監視は、この表の既存実装と混同しない。

上表の claim・session gate・Turn 開始時の停止から、今の契約のままでは「同じ現役 Task の中の複数 AI / Turn owner」の並行は起きない。一つの Turn の中で computer_start を並列に呼んでも、同じキーの write claim で直列になり、computer_start は終了まで返らない。Team の worker が busy なら session gate が開始を拒否する。新しい Turn の開始はその Task の全セッションを止める。一方、別々の Task はそれぞれ現役の Turn を持て、claim の gate も token の失効も Task（claim は Turn）ごとに分かれている。Task をまたぐ並行を止めているのは、Controller の単一の上限と開始中の欄、IPC の単一の緊急停止 ID、Task 選択時の stopOutsideTask、全体で 1 枚の app-grant カードである（確度: 確認済み。Turn の実行そのものに全体の同時数の上限が無いことは、上記の列挙と更新時の確認の文言からの強い推定である）。

## 3. 決定（案）

### 3.1 同時実行の単位と上限

**現状**: §2 の Main / native の上限、client の単一 child、pipe の 1 インスタンスが境界である（`main/computer-use-controller.ts:2865`、`main/computer-use-native-windows.ts:254`、host.cc `StartWindowsNewSession`（`:5602`）、`ServeMain`（`:11954`））。

**決めること・推奨案**: 一つのセッションに専用 helper / client / Host lane を一つ割り当てる。native の session_limit と各 pipe のインスタンス数は 1 のままにする。Main に Windows 専用 coordinator を置き、最大 3 lane を管理する。running だけでなく starting、paused、承認待ち、停止確認中も枠を占める。終了未確認の helper を枠から外して補充してはならない。

helper の上限も 3 とする。session のない discovery / picker は空き lane を使い、一つの lane に同時に一つの開始 owner だけを置く。空きが無ければ入力を伴わない容量拒否を返し、無制限に待ち行列を作らない。probe も上限の外に常駐 helper を増やさない。選択した target token は発行 lane と世代に固定し、同じ lane をその session へ昇格する。別 helper へ token をコピーしない。listing の lane の退役と、昇格時の同じ listing の token の失効は §3.6 で決める。別 session が動く lane に探索・picker を同居させない。探索のうちアプリの起動と picker の表示は前面に副作用を持つ操作として §3.2 の前面 slot の対象にする。

世代の識別は数値だけでは足りない。Main 起動 instance、lane ID、helperGeneration の組を内部の generation key とし、N3 の台帳・receipt・token・承認・exit observer に通す。各 client の generation=1 が重なっても別物である。新しい Main では instance を再利用しない。child object と process handle の所有は終了確認まで保持する。

**代案・理由**: 1 helper の中に 3 セッションを置けば署名・起動・COM 初期化を共有できる。しかし global worker slot や cancellation state の分離が必要で、D-5 により一つの停止が全セッションを失わせる。専用 helper なら kill の影響を一つの lane に限定でき、既存の単一セッション native 境界も保てる。上限 2 は必要最小限だが三者競合を扱えず、無制限は capture・COM・モデル呼出し・停止 UI の負荷が読めない。3 は二つの背景処理と一つの別作業を扱いながら資源と表示を小さく保つ初期上限である。性能実測に基づく最適値とは主張しない。

**N15 で作るもの**: lane factory、容量予約、owner から lane への不変な routing、複合世代、空き lane の discovery と昇格、退役処理を作る。署名確認は非同期化し、Main の停止通知を塞がない。10 秒の検証上限と起動済み PID / image / digest / signer の検査を維持し、検証完了前は handshake 成功扱いにも操作可能にもしない。Stop 後の遅い検証成功は破棄する。成功結果を別 child の検証として cache しない。署名検証用プロセスの終了・cleanup も lane owner が保持し、裏に残して枠を再利用しない。

### 3.2 入力の直列化と待ち

**現状**: 一つの helper 内の claim は短い stop_mutex の後に外部呼出しを行う（host.cc `InvokeWindowsSemanticInput`（`:8644`））。別 helper 間の入力調停はこの処理にはない。前面一致は `RevalidateWindowsTarget`（`:9803`）で検査し、その後に `SendInputForBoundTarget` が SendInput を呼ぶ（`:9823`〜`:9825`）が、それだけでは二つの helper の競合を防げない。探索の起動は helper 内の semantic 入力しか見ず（`RunWindowsDiscovery` の `claim_launch`、`:6405`〜`:6406`）、picker はダイアログを表示する（`PickWindowsExecutable`、`:3213`）。

**決めること・推奨案（coordinator の単一性）**: 同じユーザー SID の Sprint Coder 全体に一つの coordinator を置く。coordinator 自体は Main の中の TS の部品であり、その単一性を machine-wide の mutex で保証する。既に所有者がいる別 Main は Computer Use の開始を拒否する。他の AI 製品や人の入力をこの mutex で止められるとは主張しない。

mutex を所有するのは、Main に読み込む Windows 用の新しい署名済み N-API module とする（推奨）。今の Windows の addon は helper exe を起動する TS の object で、Main に Win32 の mutex・DACL を呼ぶ module は無い（`main/computer-use-native-windows.ts:76`〜`:80`、`native/binding.gyp:5`、`:8`〜`:12`）。lane の helper は kill-stop D-5 で殺されるので所有者にできない。候補の比較は次のとおりである。

| 候補 | 署名・packaging・attestation | 起動のコスト | 所有者が死んだ時 | N15-1 の署名確認との関係 |
| --- | --- | --- | --- | --- |
| A: Main に読み込む署名済み N-API module（推奨） | binding.gyp に Windows の target を足し、`.node` を Authenticode 署名して asar の外へ置く。macOS の `.node` の build・packaging の経路は既にある。module の機能は namespace・mutex の作成・照合・解放だけにする | Main の起動時に一度読む。追加のプロセスは無い | 所有者は Main 自身なので、Main が生きている間に所有者だけが死ぬ場合は無い。Main の crash では OS が mutex を abandoned にする | Main と同じプロセスに読み込むので、helper 用の子プロセス検証（N15-1）の対象ではない。完全性はアプリの署名と packaging に依る。読込みの失敗・export の不一致は Computer Use を閉じる |
| B: lane の外の常駐の小さなプロセス（helper exe の別モード） | helper exe の署名と attestation を流用できる | 一つ多いプロセスを起動し、N15-1 と同じ非同期の署名確認を経る | Main が生きたまま所有者が死ぬと mutex が解放され、第二 Main が取れる。この時は全体 gate を直ちに閉じ、再取得まで開かない必要がある。Main の crash 後に残ると旧所有者が残る | N15-1 の検証を同じく通す。ただし D-5 の対象外の常駐プロセスという新しい種類を作る |
| C: Node の named pipe server の名前の排他 | 新しい native は不要 | 小さい | Main とともに消える | 関係しない。ただし pipe の名前は誰でも先に作れ、DACL も private namespace も指定できないので採らない |

A を推奨する理由は、所有者の寿命が coordinator（Main）の寿命と一致し、B の「所有者だけが死ぬ」分裂を設計から消せるためである。費用は Windows の native build と `.node` の署名の追加で、既存のリリースが Windows の `.node` を署名する手順を持つかは未確認である（N15-3 の着手前に確かめる）。

名前の先取り（別のローカルユーザーが `Global\` の名前を先に作り、照合の失敗で Computer Use を閉じさせる DoS）は、ユーザー SID を boundary descriptor に入れた private namespace（`CreateBoundaryDescriptor`・`AddSIDToBoundaryDescriptor`・`CreatePrivateNamespace`、既存なら `OpenPrivateNamespace`）の中に mutex を作って防ぐ。namespace の DACL はそのユーザー SID だけに与え、mutex は非継承 handle とする。作成・open・owner の照合に失敗したら Computer Use を閉じる。boundary descriptor の SID を持たない他ユーザーの token では同じ namespace を作れないこと、同じユーザーの別ログオンセッションから同じ namespace に届くことは、強い推定であり N15-3 の Windows seam と実機で確かめる（§6.1）。

既存の単一インスタンス lock（`main/index.ts:143` の requestSingleInstanceLock）では足りない。この lock は Electron のアプリ名・userData ごとのもので、別のインストール、別の userData（開発版や `--user-data-dir`）の Main はそれぞれ lock を取れ、N3 の台帳も別の SQLite になるので、同じ対象への調停と隔離が二重になるためである。

mutex は coordinator の単一性のためであり、入力一回ごとに OS 呼出しを囲む mutex ではない。abandoned は安全な引継ぎの証拠ではない。新 Main は N3 の recovery と旧 helper の扱いを確定するまで全体 gate を開かない（§3.5）。旧版・調停能力なしの helper を 3 lane の中へ混ぜない。別 OS ユーザーとは共有しない。

**決めること・推奨案（admission の種類）**: 調停は「背景の共有 admission」と、SID 全体で一つの「前面 slot」の二種類とする。前面 slot の所有者は、前面区間の owner（前面入力・前面への引渡し・承認往復）か、探索のアプリ起動・picker の表示（前面副作用）のどちらか一つである。

前面区間の入力と背景入力を混在実行する案は採らない。理由は pattern の呼出しに限られる。背景の pattern 呼出しは、Win32 の UIA proxy で `BM_CLICK` や `WM_SETTEXT` などの message に置き換わり、対象のハンドラが窓を生成・活性化しうる（背景入力 ADR §2.1 の Invoke の行と、同 ADR が provider に非活性化の強制力が無いとすること）。これが前面区間の入力先を変えうる。一方、前面区間の間も別 lane の UIA の読取り（property・tree の取得と、その下の `WM_GETOBJECT`）と WGC の capture は許す。読取りは対象のハンドラに操作を実行させる呼出しではなく、窓の生成・活性化を要求しないためである（確度: 強い推定。§4 の CS-3 で、読取りの最中の前面の変化が 0 であることを実機で確かめる。確かめられない provider の読取りは前面区間の間は busy にする）。

| 処理 | 並行できるもの | 直列にするもの・保持する権利 |
| --- | --- | --- |
| background_semantic | 別プロセスの background_semantic、別 lane の観測、別 lane の探索の起動・picker | 同一セッション内は 1 要求。共有 admission を一操作の最終再検証から応答の分類まで保持。前面区間の owner が前面 slot を持つ間は新しく取れない |
| foreground_input / foreground_semantic | 別 lane の読み取りだけ | 前面 slot を前面区間の owner として保持する。背景の claim も閉じる。前面区間の owner は一つ |
| 前面への引渡し・人の前面再開・承認往復の復帰 | 別 lane の読み取りだけ | 前面入力と同じ前面 slot。SetForegroundWindow だけ別 lock にしない |
| approval_round_trip | 別 lane の読み取りだけ | 前面区間の owner として前面 slot を保持し、全入力 claim を閉じる。カードへの移動で他 session に前面を貸さない |
| 探索のアプリ起動・picker の表示（前面副作用） | 別 lane の background_semantic と読み取り | 前面 slot を前面副作用の owner として保持する。前面区間の owner がいれば待たずに busy を返す。背景の claim は閉じない |
| capture / UIA 読取り / copy / 起動を伴わない探索の列挙 | 別プロセスの観測、他 lane の許可済み処理 | 同一 lane の状態更新と観測は直列。SID の入力権利は取らない。copy は入力ではないが既存の権限・成果物束縛を維持 |
| 背景 session のモデル待ち・背景カードの回答待ち | 他 lane の許可済み処理 | 入力権利も短い state mutex も保持しない。前面区間の owner のモデル待ちはこの行に入らない（下記） |
| Stop | 全 lane の Stop と並行 | 入力権利・観測枠・通常 queue の取得を待たない |

前面区間は N9 の「一操作ごとではなく前面セッションの区間」（背景入力 ADR §2.4）を維持する。前面区間の owner は、区間の間（モデル待ち・承認往復を含む）前面 slot を排他として持ち続ける。同じ owner の連続入力を許し、他 session の入力と前面副作用は待つか busy になる。人の pause / Stop、通常の focus 喪失、承認往復の拒否・失敗・期限、セッションの終了で区間を終える。前面 owner がモデルを待つ間に他の入力を許すために自動的に権利を渡すことはしない。

前面区間に時間・操作数の上限は新しく置かない（推奨）。途中で強制交代すると、人が引き渡した前面の権限を取り上げ、次の前面入力に再び人の引渡しが要る。操作数はセッションの既存の maxRounds（`main/computer-use-controller.ts:2860`〜`:2861`）で有界であり、背景 session の入力は待ち行列に積まずに 1 秒で busy になる（下記 3）ので、待たされた入力が後から出ることは無い。背景 session が前面区間を待っていることは UI に表示し（§3.6）、人はいつでも前面 session を pause / Stop できる。

探索の起動と picker の前面副作用は次のように扱う。

- **取得**: 探索の要求で Main が前面 slot を前面副作用として取れた場合に限り、単発の起動 permit（lane / 複合世代 / discovery owner / 期限に束縛）を付けて helper へ送る。helper の `claim_launch` と picker の表示は、この permit を消費できた時だけ進む。permit の無い探索は起動せずに列挙だけを行い、候補が無ければ未起動の busy を返す。前面区間の owner がいる間は待たずに busy とし、遅れて自動起動しない。
- **保持**: picker は表示から応答（選択・取消し）まで保持する。起動は permit の消費から、helper の `retire_launch` と、起動後の settle 時間までを保持する。settle 時間の初期値は探索の `WaitForInputIdle` の上限と同じ 5 秒（host.cc `MeasureWindowsDiscovery` の `:6278`）とし、N15-6 の実測で見直す。
- **解放**: 上の終点か、Stop・helper の exit の確認で解放する。応答が失われた場合は、§3.2 の 6 と同じく helper の exit を確認するまで保持する。
- **遅れた focus**: kill-stop ADR §3.3 のとおり、パッケージアプリや single-instance のアプリは settle 時間の後にも窓を開き focus を取りうる。これは前面 slot の保持では防げない。各前面入力の直前の前面検査（host.cc `SendInputForBoundTarget` が呼ぶ `RevalidateWindowsTarget`）を入力ごとにやり直すことと、前面区間の owner の focus 喪失による pause で受ける。前面検査と SendInput の間（`:9823`〜`:9825`）に入力先が変わる窓は残る（§6.1）。背景対象が起動の巻き添えで前面化した場合は、N9 の takeover の規則でその背景 lane を pause する。

ロックと所有権の順序は次のとおりである。

1. SID coordinator の生存を確認し、空き lane と対象プロセスの予約（§3.3）を state の短い更新で確保する。永続予約は排他権の記録であり、対象への OS 呼出し中に mutex を握ることではない。
2. session は未処理の入力要求を 1 件まで持つ。必要な admission が無ければ非同期に待つ。coordinator state mutex の中では owner / queue / epoch の更新だけを行い、UIA、署名確認、DB I/O、モデル、人の回答、他 lock の取得を待たない。native の stop_mutex と Main の mutex を跨いで同時保持しない。
3. 待ちの上限は `min(受付から1秒, 元要求の残り期限, ticket/intent の残り期限)` とする。lane ごとに 1 待機、合計 3 までである。期限切れは未送信の busy とし、その ticket を使って後から自動送信しない。Stop は直ちに待機を取り消す。前面区間の待ちが来たら新規背景 admission を閉じ、既に許可した要求を drain する。FIFO で一つの前面候補を選び、期限が切れた候補は取り除く。前面副作用は待たない（上記）。
4. admission 取得後に N9 の対象・経路・epoch と N8 の authority を再検証する。待つ前の観測だけで dispatch しない。承認済み操作は復帰・再観測の後、承認交換の前に admission を確保し、exchange 後から dispatch まで observe / preflight / refocus を挟まない。150 ms の承認 dispatch 再測定上限と最大 5 秒の execution ticket の寿命は延長しない。
5. Main が発行する内部 permit を lane / 複合世代 / session / request / inputPath / 対象 / cancel epoch / 調停 epoch / 期限に束縛し、native が claim 前に一度だけ消費する。permit はモデルや Renderer へ渡さない。permit 発行から完了まで admission を保持し、Main が「未 claim」と推測して権利を回収しない。claim と Stop は従来どおり native の短い stop_mutex で順序付ける。
6. 入力を発行していない拒否か検証済み完了で admission を解放する。未知効果・応答消失では新規 claim を閉じ、K-1〜K-5 と Stop へ進む。helper の in-flight が解消した証拠（検証済み receipt または元 helper の exit）を得るまで、その admission は tombstone として保持する。待機期限や IPC 切断だけで解放しない。対象隔離の永続化を終えてから調停を開く。前面化の不明結果も helper 側の発行終了を確認するまでは排他を解放しないが、K-4 のとおり対象隔離は作らない。

**代案・理由**: 全操作の排他は簡単だが別プロセスの背景並行を実現しない。前面と背景を無条件に並行にする案は非活性化の保証を過大評価する。長い OS mutex の中で UIA を呼ぶ案は agent-desktop の最大 20 秒の先頭詰まりを再現する。推奨案は短い状態更新と、停止で解決する admission の所有を分離する。調停権を timeout だけで奪う案は二重入力になる。探索の起動・picker を読取りと同じに扱う案は、前面区間の入力先を他 lane が変える経路を残す。前面副作用にも前面区間と同じく背景の claim を閉じさせる案は、人の操作を待つ picker の間、全背景入力を止めるので採らない。

**N15 で作るもの**: SID の単一 coordinator と mutex を持つ N-API module、共有 admission と前面 slot、単発 permit と探索の起動 permit、期限付き queue、writer の drain と Stop 優先を作る。private namespace・DACL・abandoned・別 Main の拒否を Windows seam で確認する。制御用の通信が失われた native は新規 claim を閉じ、既発行分は台帳と kill-stop で扱う。

### 3.3 同じ対象プロセスへの重複の防止

**現状**: native は PID + 作成時刻と保持 handle を照合する（host.cc `WindowsSessionProcessMatches`（`:3292`））。探索の候補は作成時刻を値として持たない（`CollectTopLevelWindow`、`:3808`〜`:3826`）。Host の `pidsByIdentity`（`main/computer-use-native-host.ts:195`）はアプリ identity ごとの PID cache であり、複数インスタンスの予約台帳ではない。

**決めること・推奨案**: 予約キーは SID + PID + 作成時刻とする。HWND、実行ファイルの名前、profile ID、app grant だけをキーにしない。予約競合では session を作る前に拒否する。PID 再利用、測定失敗、予約から開始までの target 変更を成功にしない。process handle と作成時刻を確定できない対象は開始不可である。

開始前の Main が作成時刻を得る経路は、探索の候補に内部専用の作成時刻を足す方式とする（推奨）。helper は候補を作る時点で作成時刻を既に読んでいる（`CollectTopLevelWindow` が windowIdentityDigest の入力に使う `:3810`）。この値を Main 内部の token の束縛にだけ持ち、モデル・Renderer・監査へ出さない（V2 §5.3 の PID を出さない不変条件と同じ扱い）。Main は computer_start の時に token の (PID, 作成時刻) で予約を確定してから native の start を送り、start の応答の作成時刻（kill-stop §2.2 の 1 で N3 が足す）と一致しなければ開始を失敗にして予約を外す。代案の「PID で仮予約し、start の応答の作成時刻で確定する」方式は、仮予約の間に同じ PID の別プロセス（再利用）を誤って止める・通す判断が要り、二つの lane が同じ PID へ同時に start を送る競合を作成時刻で判定できないので採らない。

一つのプロセスの別 top-level window は同じ予約に属し、別 session を作れない。元 session が許可された owned dialog を扱う場合も予約は増やさず、N9 の dialog / takeover 規則に従う。異なる PID の同一アプリは独立プロセスとして許せるが、子プロセスや UIA tree の別 PID を親の許可から自動追加しない。入力先要素の owner PID が対象と違えば拒否する。独立した子の窓を扱うなら新しい対象として資格、grant、作成時刻、背景対応表を検証し、別予約と上限を消費する。共有 UI thread / proxy により非活性化・独立性を実機で示せない組は背景能力を開かない。プロセスの親子関係だけで権限を広げず、全子孫を自動予約することもしない。

paused / 承認待ちでも予約を保持する。正常 Stop の確定後に予約を解放し、K-1 の隔離があれば同じキーの隔離が引き継ぐ。効果不明でも予約だけを外して別窓から開始させてはならない。kill-stop の対象終了の照合（signaled、作成時刻不一致、PID 不在）と承認カードの条件だけで隔離を解く。アクセス拒否は終了証拠ではない。

**代案・理由**: HWND ごとの予約は同じアプリの UI thread に並行入力する。exe ごとの予約は別プロセスを過剰に止める。PID だけでは再利用を取り違える。PID と作成時刻を採り、N3 の隔離キーと一致させる。

**N15 で作るもの**: 探索の候補への内部専用の作成時刻、coordinator の予約 index、原子的な競合拒否、start / resume / discovery / dispatch の照合、別窓・子・再利用の負例を作る。N3 の対象 identity を Main/native の外へ公開しない。

### 3.4 固まったアプリの影響の閉じ込め

**現状**: UIA transaction は 300 ms だが、無制限への fallback がある（host.cc `CreateWindowsV1Automation`（`:7254`〜`:7270`））。単一 UIA slot と別 capture slot は helper 内の資源である（`WindowsUiaReadWorkerRunning`（`:7293`）、`WindowsCaptureWorkerRunning`（`:7299`））。一呼出しの設定値は、複数呼出しや COM cleanup を含む総所要時間の保証ではない。

**決めること・推奨案**: 並行実行能力を開く helper は bounded UIA（connection 500 ms / transaction 300 ms）を必須とし、設定できなければ並行能力を閉じる。旧単一セッションの互換経路と混在させない。N8 のより短い 150 ms の承認再測定上限も維持する。N9 の preflight と入力所属の監視は lane ごとに働く。

背景 A の UIA / capture が固まっても B / C の worker 枠は独立である。背景 A の共有 admission が残っている間も、他の背景 admission は許せる。ただし前面区間の要求は drain を待ち、1 秒で busy になりうる。A の Stop を始めても、その lane の Host / client / native の隔離（§3.5 の表の lane 単位の行）は A の lane に留まり、B / C は新規検証から進める。A が kill-stop §2.2 の termination_requested に入った時点で §3.5 の全体 gate を閉じ、A の exit を観測して §2.2 の判定を終えた時点で開く。したがって「一つの固まりが他を止めない」は、通常の背景処理と通常の Stop（cancel / close の期限 C の待ち）の間の独立性であり、termination_requested の間まで入力を継続する保証ではない。

300 ms を過ぎたことだけを API の取消し完了とせず、worker が戻らなければその lane の枠を保つ。通常処理のために新 worker を無制限に足さない。入力の未知効果は K-1 で隔離して Stop、入力前の観測失敗はその session の失敗として Stop へ進める。停止は N3 の C / T を使い、N15 が短縮しない。helper 終了の影響範囲はその lane の全 owner であり、D-5 は維持する。他の helper は殺さない。対象アプリを殺すこともない。

**代案・理由**: 1 helper 内の複数 worker は COM や終了の影響を共有する。固まった thread の強制終了、timeout 時の lock 強制解放は停止証拠にならない。専用 helper と既存 kill-stop を使い、通常時の独立性と停止時の安全側の拒否を分ける。

**N15 で作るもの**: bounded UIA の能力 gate、lane ごとの fault 処理、遅い結果の世代照合、固まり fixture、B / C が進むことと全体 gate の開閉の試験を作る。

### 3.5 Stop・台帳・承認・takeover の範囲

**現状**: 今の Host / client の未確認は（helper が一つなので）全体の拒否であり、緊急停止の接続先は 1 session である（`main/computer-use-native-host.ts:247`、`main/computer-use-native-windows.ts:312`、`main/ipc.ts:1935`）。Task 停止は複数 owner を列挙する形が既にある（`main/computer-use-controller.ts:3672`）。

**決めること・推奨案**: 全体 Stop と緊急停止は、開始中・探索中・承認待ち・paused を含む全 lane に同じ入口で並行にかける。まず同期的に「全体 Stop の latch」を閉じて coordinator の新規開始・permit 発行・カード消費を止め、対象 owner の snapshot を取り、各 lane の Stop を開始してから全結果を集める。一つの await が終わるまで次の lane を止めない。新規 owner と Stop の競合も同じ latch で拒否する。

**全体 gate**: coordinator 全体の新規入力・新規開始・新しい helper の起動を拒否する gate を一つ置く。gate は次の閉鎖要因の集合が空でない間だけ閉じる。要因ごとに閉じる時点と開く時点を一つずつ定める。

| 閉鎖要因 | 閉じる時点 | 開く時点 |
| --- | --- | --- |
| lane の世代の `termination_requested`（kill-stop §2.2） | その世代について、期限 T 内に signaled にならないと判定した時点 | その世代の exit を観測し、kill-stop §2.2 の判定（`terminated_clean`、または `terminated_target_suspect` の対象隔離の永続化）を終えた時点 |
| Main の起動時の recovery | Main の起動時（gate は閉じた状態で始まる） | N3 の台帳 recovery（kill-stop §2.2 の 5）と N4 の旧 helper の扱いを終え、§3.2 の mutex を照合付きで取得した時点 |
| 全体 Stop の latch | 全体 Stop・緊急停止・OFF・Renderer 無効化・dispose の入口の同期部分 | snapshot の全 owner が終端（停止の確定、`terminated_*`）になるか、`termination_requested` として上の行へ移った時点 |

通常の Stop（行停止・Task 停止・helper の cancel / close の期限 C の待ち）の開始は全体 gate を閉じない。

**隔離元の範囲**: lane ごとに Host / client を分けた後の各状態の範囲は次のとおりである。lane 単位とは、その lane の Host / client / helper が Stop 以外を拒否し、他の lane は影響を受けないことをいう。

| 状態 | 範囲 | 解除 |
| --- | --- | --- |
| client の semantic owner の `uncertain` | lane 単位 | kill-stop の receipt か元 helper の exit による確定だけ（今と同じ） |
| client の closeCandidate | lane 単位 | 同上 |
| Host の activeStopQuarantines | lane 単位 | 同上 |
| Host の discovery の隔離・停止中の start owner | lane 単位 | helper の exit の確認（kill-stop §2.2 の 2） |
| native の in-flight | lane 単位（helper の中） | 同上 |
| 前面 slot の tombstone（前面入力の未知効果・応答消失、前面副作用の応答消失） | 前面 slot（SID 全体の前面入力・前面副作用と、前面区間の間の背景 claim） | 元 helper の in-flight の解消の証拠（§3.2 の 6） |
| `terminated_target_suspect`・K-1 の対象隔離 | PID + 作成時刻の対象（全 lane） | 対象終了の照合か規定のカード（kill-stop §2.2 の 3・4、K-5） |
| `termination_requested` | 全体 gate | 上の全体 gate の表 |

kill-stop ADR §2.2 の 2 は、今の隔離元がどれも「host 全体を止める」とする。今は helper が一つなので host 全体と helper は同じである。これらの隔離の目的は、claim 済みかもしれない呼出しを持つ helper から次の入力を出させないことであり、その呼出しは別の helper のプロセスには無い。対象への遅れた効果は全 lane に効く対象隔離で、前面入力の行き先の不明は前面 slot の tombstone で受ける。したがって lane 単位にしても kill-stop の保証は弱まらない。この読み替えは承認後に kill-stop ADR へ接続する（§6.1）。

| 事象 | 効く範囲 | 後始末・再開 |
| --- | --- | --- |
| 全体 Stop / 緊急停止 / OFF / Renderer 無効化 / dispose | 全セッション・全開始 owner・全探索 | 全体 Stop の latch を閉じ、各 lane の cancel / close / kill-stop を並行に実施し、全件の結果を表示 |
| 行の「このセッションを停止」、所有者の computer_stop | 指定 session とその lane の owner | 他 session を kill しない。台帳・隔離を迂回しない。全体 gate は閉じない |
| Task / Turn の終了、policy 変更、grant / 送信同意の取消し | 該当所有者・権限に属する全 session | Task / Turn を越えた存続やカードの使い回しを認めない |
| helper 終了・crash | 当該複合世代の全 owner | D-5 の completeStop、カード・ticket・artifact・token の失効、各 Task への通知 |
| `termination_requested` | 全体 gate | 全体 gate の表のとおり。新 helper を補充しない |
| `terminated_target_suspect` / K-1 | PID + 作成時刻の対象 | 他 lane の同じ対象も拒否。終了の照合か規定のカードでだけ解除 |
| 対象に属する人の入力 / 背景対象の前面化 | 当該背景 session の interaction epoch と claim gate | 即座に pause・ticket / intent 失効。人の再開と新規観測が必要 |
| 入力所属不明・secure desktop・監視の失明 | 関連性を判別できない全背景 lane。前面 lane も自身の desktop / focus gate で拒否 | fail-closed。検知を一つの lane だけに押し付けない |

N3 の永続台帳は一つの store に集約し、行の helper 世代を §3.1 の複合世代にする。beforeWrite の記録、書けなければ送らないこと、応答待ちを transport timeout / failAll で消さないことを保持する。成功・accepted=false・検証済み receipt の扱いは kill-stop に従い、背景の応答待ち・効果不明には K-3 の例外を適用する。K-1 の即時隔離、K-2 の実行中の dispatch / 承認交換 / 引渡しの拒否、K-4 の inputPath と前面化の記録・対象隔離判定からの除外、K-5 の Stop 後の新 session でのカードをすべて保持する。古い lane の receipt が新しい lane の行を消せないことを store と応答 object の両方で保証する。

通常の停止期限は N3 が確定した値を使う。開始済みは cancel ack の 1 秒 + C + T、native start 待ちは C + T、探索は N3 の探索停止期限 + T であり、3 lane 分を足し合わせない。C は実測による変更までは 10 秒、T は kill-stop の目安 2 秒を参照するに留める。T 内に exit が来なければ停止済みと表示しない。Main 再起動時の台帳 recovery、libuv job の検証条件と例外も N3 / N4 のままである。

承認カードは session / Task / Turn / lane / 複合世代 / approvalGeneration に束縛する。一覧に複数カードがあっても一つのクリックで複数を承認しない。カード出現は focus を奪わず、背景カードの回答待ちは他の背景処理を止めない。前面への引渡し・人の再開・approval_round_trip の復帰は §3.2 の前面 slot を取ってから行う。取得できなければ前面化せず期限内の busy とし、遅れて自動復帰しない。

approval_round_trip は一つの前面 owner のみが持つ。対象と Sprint Coder 以外（別 session の対象を含む）への前面移動は失敗を保持し、pause する。別 session のカードを押したという事実は元の往復の承認にならず、元対象の自動復帰を起こさない。背景 session には往復を設けず、N9 の背景再観測で進める。対象の隔離解除カードは operation の承認や不明な helper の停止証拠を代替しない。

N9 の mouse hook / WinEvent と interaction epoch は各専用 helper が自分の対象について管理する。別 session が前面化した事実を「AI の操作だから」と全体的に無視しない。関係しない通常アプリの入力なら背景処理を続け、対象の任意の top-level window への入力・前面化なら該当 lane を止める。前面 session は N9 どおり interaction epoch を持たず、focus / dialog / Stop の規則を維持する。全体 Stop の調停 epoch と対象ごとの interaction epoch を混同しない。

**代案・理由**: 全台帳を sessionId だけで管理すると複数 client の世代・遅い receipt を取り違える。すべての pause や通常の Stop で全 session を止める案は独立性を失う。反対に termination_requested の隔離を lane 内へ狭める案は kill-stop の確定契約（新しい helper を起こさない）を変えるため採らない。

**N15 で作るもの**: 全体 gate と全体 Stop の latch の状態機械、並行 Stop の集約、複合世代への台帳接続、per-session の承認・監視状態、停止結果一覧を作る。全体 gate を開いても他 lane の古い permit は復活させず、新規検証から進める。

### 3.6 並行の供給源と Main・UI の状態

**現状**: Controller の sessions Map に対し開始中の欄は単一で、resume は全体件数を検査する（`main/computer-use-controller.ts:834`、`:897`、`:2953`）。UI hook と緊急停止の対象も単一である（`renderer/hooks/useComputerUse.tsx:77`、`main/ipc.ts:1101`、`:1936`）。§2 のとおり、同じ Task の中の並行は claim・session gate・Turn 開始時の停止のために起きず、Task をまたぐ並行は Task 選択時の stopOutsideTask と Controller・IPC の単一の欄で止まっている。

**決めること・推奨案（並行の供給源）**: 並行の第一の供給源は「別々の Task がそれぞれ 1 セッションを持つ」Task をまたぐ並行とする。Task ごとの claim（`computer-use:${taskId}`）・現役 Turn の所有・ToolBroker の契約・computer_start が終了まで Turn を保持する V2 の契約（§5.4）を変えずに済むためである。Task をまたぐ並行を成り立たせるために、次を変える。

- Controller の単一の上限と開始中の欄を owner の Map にする（下記）。
- Task の選択変更（`main/ipc.ts:3715` の stopOutsideTask）で、選択外の Task の実行中・開始中・paused・承認待ちのセッションを止めない。選択外の Task の app-grant カードを引くこと（カードは Task の会話の中にあり、見えないカードで呼出しを待たせない。`main/computer-use-controller.ts:3690`〜`:3692`）と、選択外の Task の picker を止めることは今のまま保つ。起動を伴わない探索の列挙は止めない。選択外の Task のセッションは、全体の一覧・全体 Stop・緊急停止の対象であり続ける（下記の UI）。操作の承認カードは全体の一覧の行から開けるようにし、開けない間は既存の期限で失効させる。
- 緊急停止を複数 owner にする（下記）。
- Turn 開始時の stopForTask(taskId, 'turn_started') は Task 単位のまま保つ。Task をまたぐ並行では Task ごとのセッションは一つなので、新しい Turn が止めるのは自分の Task のセッションだけである。

Task の選択変更での停止を外すことは、「別 Task を背景で動かし続ける」機能を N15 に含めることを意味する。今の stopOutsideTask の根拠は「見えないものを動かさない」であり、それを全体の一覧・全体 Stop・overlay による可視性で置き換える。これは本 ADR の決定として Q13 で問う。

同じ Task の中の並行は、代わりの案として次の二つを挙げ、それぞれ Q14・Q15 で採るかどうかを問う。推奨はどちらも N15 に含めないことである。

- (a) 一つの Turn で computer_start を並列に呼ぶ。claim を Task 単位から session または対象予約の単位に分け（list_targets と request_access の直列化は残す）、token の回転を listing 単位にし、IPC の Task ごとの session ID（`main/ipc.ts:1099`）を session ごとにし、Task ごとの artifact の 3 件を同じ Task の複数セッションで共有する扱いを決める必要がある。V2 ADR §5.2〜§5.4（ツール面、token の性質、1 セッション 1 ウィンドウと切替の手順）の変更を伴う。
- (b) Team の Leader と worker に並行させる。session gate の `!hasBusyWorkers` を外し、Turn 開始時の停止を Turn 単位にし、worker の Turn にセッションの所有を認める必要がある。V2 ADR の Turn 束縛（§5.2〜§5.4 と §7.2 の流れ）の変更を伴う。

どちらも Task をまたぐ並行で得られない利点（一つの会話の中の分担）があるが、V2 の確定済みの契約と ToolBroker の直列化の前提を変えるので、N15 の後に別の ADR で扱う。

**決めること・推奨案（token と 2 つ目のセッションの手順）**: token の回転の範囲は Task 全体のまま保つ（今の revokeTargetTokens、`main/computer-use-controller.ts:1954`〜`:1961`）。Task をまたぐ並行では、一つの Task の list と start は同じ Turn の claim で直列になり、他の Task の list はこの Task の token を消さないので、Task 単位の回転で足りる。

computer_list_targets は空き lane を一つ探索用に確保し、その listing の全 token をその lane と複合世代に束縛する。空きが無ければ入力を伴わない容量拒否を返す。computer_start がある token で lane を session へ昇格した時は、同じ state の更新で同じ listing の他の token をすべて失効させる（同じ lane は使用中になり、それらの token で始められる session は無い）。昇格しなかった listing の lane は、同じ Task の次の list（回転）、Turn の終了、token の期限（5 分、`main/computer-use-target-model.ts:23`）、Task の停止の経路のうち最初のもので退役させる。

2 つ目のセッションを始めるモデル側の手順は、別の Task の Turn で computer_list_targets を呼んで空き lane の新しい listing を取り、必要なら computer_request_access、続いて computer_start を呼ぶことである。同じ Task の中では、V2 §5.4 のとおり 1 つ目の computer_start が返るまで 2 つ目は始まらない。

**決めること・推奨案（app-grant カード）**: app-grant カードは今のまま全体で 1 枚とする（推奨。V2 §6.1、`main/computer-use-controller.ts:849`）。2 つ目の要求は今のコードどおり access_request_pending で直ちに拒否し、待ち行列には積まない。モデルはカードが解決した後にやり直す。全体の一覧には「許可カードを表示中（どの Task か）」を一行出し、2 つ目の AI が拒否された理由を人が分かるようにする。拒否された要求はカードを出していないので T8 の per-Turn の上限（2 枚）を消費しない（`main/computer-use-controller.ts:2046` の拒否は、`:2249`〜`:2252` の計数より前にある）。V2 §6.1 と T8 は変えない。

**決めること・推奨案（Main の状態）**: Controller の開始 owner を Map 化し、start / cancel / resume の条件はその owner と容量・対象予約で判断する。Host lane は session の native state、receipt、revision、attempt counter、discovery owner を持ち、coordinator は lane routing、容量、対象予約、入力調停、全体 gate を持つ。client の pending と decoder は接続ごとに分離する。session を「現在の client」に送る入口は作らない。PID cache は予約・認可の代わりに使わない。

**決めること・推奨案（緊急停止と overlay）**: 今の緊急停止は単一の ID に結ばれている（`main/ipc.ts:1101` の computerUseEmergencySessionId、`:1934`〜`:1938` の onStop、`:2069`〜`:2071` の arm での上書き、`:2073`〜`:2077` の一致した一件での disarm）。これを次のように変える。onStop を全体 Stop の入口（§3.5）へ向ける。arm / disarm を owner ごとの参照数にし、最後の owner が終端になるまで shortcut と overlay を外さない。overlay の配置と visual 入力の衝突判定は、前面（visual）の入力を行う lane の対象矩形の集合に対して行う。この変更は、Controller が複数セッションを許す試験用 gate を初めて開くスライス（§5 の N15-3a）に入れる。

overlay の回避と visual 入力の衝突判定の対象は、座標入力を行う前面の lane の対象に限る。背景の lane の対象は遮蔽・最大化されていてよく（背景入力 ADR §2.1）、pattern の入力は座標を使わないので overlay に影響されず、観測も窓単位の capture なので overlay を写さない。前面の lane が無い間は、overlay を対象の制約無しの既定位置（`positionComputerUseStopOverlay` の対象無しの分岐、`main/computer-use-emergency-stop.ts:187`）に置く。前面の lane の矩形に対して配置できない時は、その前面 lane の開始を拒否するか（開始時）、その前面 lane を pause する（観測・承認・resume の reposition の時。今の emergency_stop による停止をこの lane の pause に置き換える）。今の reposition は失敗すると overlay 全体を disarm する（`main/computer-use-emergency-stop.ts:119`〜`:121`）が、複数 owner では overlay を残し、shortcut も外さない。背景の lane の形の変化は overlay の配置の失敗とせず、全体の停止の契機にしない。shortcut の登録の失敗は全 lane の停止手段の喪失なので、新規の開始を拒否し、実行中は全体 Stop へ進める。

**決めること・推奨案（UI）**: UI は AI / Task、検証済み対象ラベル、背景 / 前面、実行中 / 待機 / 承認待ち / 停止確認中 / 隔離を行ごとに示す。一番見つけやすい Stop と緊急 shortcut / overlay は全体 Stop とする。行の停止は「このセッションを停止」と明記する。停止済み行と停止未確認行を分け、未確認が一つでもあれば全停止成功と表示しない。前面 owner のために背景が待つ理由、3 件上限、許可カードの表示中も表示する。選択外の Task のセッションも同じ一覧に出す。

**代案・理由**: 上限の if 文だけを削除すると開始取消し、UI、緊急停止が別 session に作用し、Task 選択時の停止で実際の並行数は 1 のままになる。同じ Task の中の並行を第一の供給源にする案は V2 の Turn 束縛と ToolBroker の直列化を変える。単一の「選択中 session」のみを表示する案は停止の見落としを招く。owner と一覧を明示し、Task / Turn の権限は Task 単位のまま保つ。

**N15 で作るもの**: Controller / Host / client の owner 分離、Task 選択時の停止の範囲の変更、緊急停止の複数 owner 化、listing の lane と token の規則、複数 status の取得・購読と revision、一覧・行停止・全体停止、overlay の集合判定を作る。IPC / contracts は strict schema を正本として Main / Preload / Renderer を揃え、PID・作成時刻・handle・内部 permit を外へ出さない。

### 3.7 観測と資源の上限

**現状**: UIA と capture は別の単一枠であり、UIA 枠は semantic dispatch と共有する（host.cc `WindowsUiaReadWorkerRunning`（`:7293`）、`WindowsCaptureWorkerRunning`（`:7299`）、`DispatchWindowsSemanticAction`（`:9605`））。観測は 25 秒の budget、capture の前面条件と既存の frame / cache 制限を持つ（`:7256`、`CaptureWindowWithGraphicsCaptureOnWorker`（`:7607`）、`:158`、`ServePipe`（`:11667`））。

**決めること・推奨案**: 別プロセスの観測を最大 3 lane で並行に許す。同一 session は一つの観測 / preflight / dispatch の流れを直列にし、観測による revision 更新が承認交換後に割り込まない。UIA は各 helper 1 枠、capture / PNG は各 helper 1 枠とし、合計各 3 枠を上限とする。UIA object、COM apartment、画像 buffer、Session 参照を helper 間で共有しない。

待機要求は lane ごとに 1 件までとし、連続した自動観測要求は最新の未送信要求へまとめる。dispatch / 承認要求はまとめたり置換したりしない。Stop は観測 queue と独立である。既存の観測 25 秒 budget と byte / node / depth 上限を延ばさない。枠が埋まっていれば読み取りの busy を返し、古い画面を新規観測として返さない。capture は N9 の対象 HWND への WGC と鮮度検証だけを使い、画面全体の BitBlt や PrintWindow へ逃げない。

応答 cache の既存上限を lane ごとに維持すると 3 lane 合計で最大 96 MiB、frame queue は最大 192 件となる。raw capture の約 7 MiB 相当は 3 枚で約 21 MiB だが、これは process RSS の上限ではない。COM・PNG・モデル入力・一時 buffer は別に増える。N15 では helper 数と要求数を有限にし、各 lane は最新観測だけを保持し、不要な binary を破棄する。Provider 送信同意と redaction は各 session で検査し、他 session の観測・copy artifact を流用しない。#785 の明示的な参照転記の契約だけを維持する。

Main の copy artifact の上限は Task ごとの 3 件（`packages/contracts/src/index.ts:6482`、`main/computer-use-artifact.ts:362`〜`:368`）のまま共有で保ち、セッション単位に分けない。Task をまたぐ並行では各 Task のセッションは一つなので、実質はセッションごとの 3 件になる。同じ Task の中の並行（§3.6 の (a)・(b)）を採る場合も Task の 3 件を共有とし、超えた copy は今どおり保存しない。

**代案・理由**: 全観測を一列にすると一つの UIA が他を止める。無制限の worker / capture は停止とメモリの上限を失う。3 lane の独立枠を選び、RSS・CPU・GPU・遅延は §4 の実測で公開可否を判定する。

**N15 で作るもの**: 有界な観測 scheduling、per-lane の資源解放、上限超過の拒否と測定項目を作る。新しい固定 RSS 合格値を根拠なく作らず、N9 の既存基準を保持したうえで実測結果をレビューする。

### 3.8 試験の方針

**現状**: §2 の単一セッション制限があるため、本 base は複数 helper での誤配の無さを証明していない。UIA の単一枠（host.cc `DispatchWindowsSemanticAction`（`:9605`））や単一緊急停止（`main/ipc.ts:1935`）の試験だけでは並行の証明にならない。

**決めること・推奨案**: §4 の単体・境界・Windows 実機を組み合わせる。新しい振る舞いの実装では回帰テストの RED → GREEN を記録し、既存の拒否・単発性・macOS の期待を緩めない。

**代案・理由**: 3 プロセスが起動したこと、モデルの成功文、build 成功、画面の前後比較だけでは誤配・一瞬の前面化・停止漏れを示せない。実操作と入力回数・世代相関の受動証拠を併用する。

**N15 で作るもの**: §4 の fixture と受動 observer、Vitest、Windows native seam、Computer Use チェックリストのケースと artifact を作る。本 ADR 作成では試験を実行していない。

## 4. 正しさの証明と Windows 実機の受入

| ケース | 単体・境界で固定すること | Windows 実機での操作・合格条件 |
| --- | --- | --- |
| CS-1: 2〜3 背景 session | 別々の Task の Turn から独立 PID へ同時 admission、同じ request ID 値でも lane / 世代で分離。観測・ticket・応答・artifact の交差を拒否。Task の選択変更で選択外の Task のセッションが止まらない | 別々の Task から別 PID の合成 fixture を 2 個、次に 3 個操作し、人は第四のアプリへ入力し、Task の表示も切り替える。異なる合成値と操作回数が各対象だけに届き、前面・カーソルを奪わない。barrier 付き fixture で実際の背景呼出しの重なりも確認 |
| CS-2: 予約と容量 | 同一 PID + 作成時刻の start 競合、同一 PID の別窓、PID 再利用、別 PID の子、本人性取得失敗、候補の作成時刻と start 応答の不一致、4 件目の拒否、listing の lane の退役、昇格時の同じ listing の token の失効 | 同じアプリの別窓を二重選択して拒否される。独立 PID の窓は資格検証後に開始できる。3 件を超える helper が残らない |
| CS-3: 前面排他 | 共有 admission と前面 slot の重なり 0、writer drain、1 秒期限、Stop による待機取消し。前面待ち期限後の遅延発行 0。前面区間の owner のモデル待ち中も前面 slot を保持。別 lane の探索の起動／picker と前面入力の競合（前面区間の owner がいる間の起動 permit 0、起動・picker の保持中の前面入力 0、settle 時間の後の前面検査のやり直し） | 二つが同時に前面引渡しを求めても一つだけ前面区間を得る。前面 owner の連続入力中は背景入力が待ち、観測は可能で、別 lane の UIA 読取りの最中の前面の変化が 0。前面 owner の入力中に別 lane の探索が対象の無いアプリを求めても起動・picker は busy になる。人の操作で pause 後、新規検証から継続 |
| CS-4: 固まりと全体 gate | A の UIA / capture / cleanup を止めても B / C の枠を使える。A の通常 Stop（C の待ち）の間は全体 gate が開いたまま、A の `termination_requested` で閉じ、A の exit と kill-stop §2.2 の判定の後に開く。uncertain / closeCandidate / activeStopQuarantines / native in-flight は A の lane だけを拒否する。無制限 UIA では並行 gate 閉鎖 | A の provider を意図的に固め、A の Stop の C の待ちの間に B / C の背景操作が完了する。A が termination_requested になると B / C の新規入力と新規開始が拒否され、元 helper exit の後は B / C が新規検証で進む。対象アプリは kill されない |
| CS-5: 全体停止 | 全 lane の latch が最初の await より前。starting / discovery / approval / pending permit を含める。各 lane の C / T を並行計測。緊急停止の onStop が全体 Stop の入口に届く。termination_requested の lane があれば全体 gate が閉じたまま | 一つが固まり、一つが承認待ち、一つが実行中の状態で全体 Stop と Ctrl+Shift+F8 をそれぞれ実行する。全 owner に停止が届き、N3 の期限内の結果を個別表示。termination_requested を成功表示しない |
| CS-6: kill-stop と K-1〜K-5 | beforeWrite 保存失敗、応答消失、accepted=true 未確認、receipt の背景例外、K-4 の前面化、起動時 recovery、別世代 receipt 拒否 | helper exit 後の新規入力 0。遅れて対象に反映する既発行操作は別に記録し、対象隔離・警告が残る。承認カードを経た新 session 以外で再開しない |
| CS-7: 承認と takeover | カードの取り違え・replay・二重消費 0。往復中の第三窓、別 session の前面化、hook 失明、所属不明。app-grant カードの 2 枚目が access_request_pending で拒否され T8 を消費しない | 背景 A のカードを開いても背景 B が進む。前面 A の往復中に B へ移ると A は pause し、自動復帰しない。対象への人の pointer 操作で該当背景 lane が止まる。2 つの Task が同時に許可を求めると、一方のカードだけが出て一覧に表示中と示される |
| CS-8: 起動と復旧 | 署名確認を遅延・失敗・取消し、古い exit / attest 応答、別 Main・別インストール・別 userData の mutex 競合、他ユーザーによる名前の先取りの不成立、N-API module の読込み失敗、abandoned と recovery | 3 lane の起動・終了を反復して Main の Stop UI が応答する。第二 Main は Computer Use を開始できない。Main の crash の後は、N3 / N4 の recovery が完了するまで全体 gate が閉じ、旧 helper と新 helper が入力を重ねない |
| CS-9: UI と資源 | status revision の session 別順序、行停止と全体停止、overlay の前面対象の集合での衝突判定、背景対象の最大化で停止しないこと、最後の owner まで停止手段維持 | light / dark、Tab / Shift+Tab、カードの非自動 focus、複数 monitor / DPI、容量・busy・隔離・許可カード表示中の表示を操作確認。背景対象を最大化しても他 lane が止まらない。3 lane を反復して helper / handle / queue が増え続けない |

実機操作は開発エージェントの Computer Use で行う。shell は fixture 準備、起動、ログとファイルの照合、受動計測に限る。UI 操作を内部 IPC・DOM・スクリプトで置き換えない。実 Provider の課金を伴う試験は本設計の受入に必須とせず、別途明示された場合だけ行う。

受動 observer は foreground WinEvent、cursor 位置の event と補助 sampling、API attempt、fixture の入力回数、claim / Stop / helper exit の単調時刻を相関させる。秘密、メールアドレス、実本文を入れず、合成値と最小 metadata を使う。本文・path・PID をモデル向け表示や監査へ追加しない。計測不足なら BLOCKED であり、一瞬の誤配なしを sampling だけで PASS にしない。

記録には build / SHA、Windows 10 / 11 の対象版、アプリ・provider 版、DPI / monitor / 仮想 desktop、各 helper の相関 ID、目的、操作、期待結果、実測、artifact、PASS / FAIL / SKIP / BLOCKED を含める。1 / 2 / 3 lane で署名・起動時間、UIA / capture 遅延、停止期限、Main event loop 遅延、RSS・CPU・GPU・handle 数を比較する。期限違反、誤配、単調な資源増加は公開不可である。既存の N8 / N9 の数値基準を緩めず、未証明の provider の背景能力は閉じる。

## 5. N15 の実装スライス

全 PR は本 ADR の承認、N8、N9、N3（K-1〜K-5、N4 の終了・job 前提を含む）の後とする。後続実装の実コードで §2 の位置を引き直し、前提の不一致は実装前に相談する。並行 gate は最後まで本番で閉じ、途中 PR は単一 session の既存経路を保持する。各 PR で対象 typecheck と直接関連テスト、共有変更では macOS の既存テストを通す。coordinator は N15-2 で lane routing・容量・対象予約だけを持って作り、N15-3 で入力調停・mutex・全体 gate を足す。Controller が複数セッションを許す試験用 gate は N15-3a で初めて開き、緊急停止の複数 owner 化を同じ PR に入れる。

| 順序 | PR の単位 | 依存 | 試験 |
| --- | --- | --- | --- |
| N15-1 | 起動境界: 署名確認の非同期化、取消し、終了までの child / attest process 所有。能力は単一のまま | N8、N9、N3、本 ADR 承認 | CS-8 の起動部分。署名不一致・timeout・Stop 後の遅い成功、Main が停止を受け付けること |
| N15-2 | 所有境界: 専用 lane factory、複合世代と台帳、coordinator の lane routing・容量・対象予約 index、探索の候補への内部専用の作成時刻（§3.3）、探索の同じ lane への昇格と同じ listing の token の失効・listing の lane の退役（§3.6）、終了影響の分離。試験用だけ 3 lane（Host / native の範囲。Controller は単一のまま） | N15-1 | CS-2、CS-6、CS-8。旧 receipt、PID 再利用、上限、台帳 recovery、D-5 |
| N15-3 | 入力境界: SID coordinator の mutex（Windows 用の署名済み N-API module と private namespace、§3.2）、共有 admission と前面 slot、単発 permit、探索の起動・picker の起動 permit、bounded UIA gate、drain / timeout、Stop 優先、全体 gate と全体 Stop の latch の状態機械（§3.5。lane の状態は fake で駆動） | N15-2 | CS-1、CS-3 の native seam と coordinator 単体。CS-4 の native seam と coordinator 単体（worker 枠の独立、全体 gate の開閉、lane 単位の隔離）。CS-8 の mutex・private namespace・abandoned。claim と Stop の競合 |
| N15-3a | 並行の供給源と停止入口: Controller の開始 owner の Map 化と容量・予約による start / cancel / resume、Task の選択変更での停止の範囲の変更（§3.6、Q13 の承認が前提）、緊急停止の複数 owner 化（onStop を全体 Stop の入口へ、owner ごとの arm の参照数、前面対象の矩形の集合、最後の owner まで disarm しない、前面 lane だけの配置失敗の扱い）、全体 Stop の集約と latch の接続。Controller の複数セッションの試験用 gate をここで開く | N15-3 | CS-1 の Task 切替、CS-5、CS-9 の overlay と停止手段の維持。選択外の Task の app-grant カードと picker が今どおり引かれること |
| N15-4 | Main 接続: N3 の K-1〜K-5 への接続、複合世代の台帳の Controller 側、承認往復・takeover と調停、全体 gate と Host の kill-stop の状態（termination_requested 等）の接続、観測上限 | N15-3a | CS-4（Controller 経由）、CS-6、CS-7。150 ms / 5 秒契約、別カード・別世代、観測割込み |
| N15-5 | 表示境界（UI だけ）: 複数 status の IPC / contracts と一覧、行停止・全体停止の表示、待機・容量・隔離・許可カード表示中の表示 | N15-4 | CS-7、CS-9 の Renderer。keyboard、非自動 focus、旧 darwin 契約 |
| N15-6 | Windows 受入と gate: 実機証拠、資源・遅延計測、settle 時間の見直し、対応能力の照合と公開候補の接続 | N15-5 | CS-1〜CS-9 の 2 / 3 lane 実機。不足は BLOCKED、gate は閉鎖を維持 |

同じ Task の中の並行（§3.6 の (a)・(b)）を Q14・Q15 で採る場合は、N15-3a より前に claim・token・session gate・Turn 開始時の停止の変更を行う別のスライスと、V2 ADR の変更が要る。本表はそれを含まない。

N15-6 の PASS は release や別対象クラスの有効化の許可ではない。独立した敵対的レビュー、PR、Review BOT、要塞レビュー、オーナーの設計承認は親の工程である。

## 6. オーナーに判断してもらうこと

次は一問につき一判断であり、推奨はすべて未承認の案である。

1. セッションごとの専用 helper を採用するか。推奨は採用である。起動費用が増える代わりに D-5 の巻き添えを lane 内に限定する（§3.1）。
2. session と helper の同時上限を 3 とするか。推奨は 3 である。開始・停止待ち・探索も枠を使い、4 件目は容量拒否とする（§3.1）。
3. SID ごとの単一 coordinator とし、第二 Main の Computer Use を拒否するか。推奨は拒否である。複数 Main を跨ぐ分散調停を N15 に追加しない（§3.2）。
4. coordinator の mutex の所有者を、Main に読み込む Windows 用の署名済み N-API module とするか。推奨は採用である。所有者の寿命が Main と一致し、常駐プロセス案の「所有者だけが死ぬ」分裂が無い。費用は Windows の native build と `.node` の署名である（§3.2）。
5. 背景同士だけを共有にし、前面区間は背景入力も含めて排他にするか。推奨はこの規則である。前面中の背景入力は待つが、観測は並行できる（§3.2）。
6. 探索のアプリ起動と picker の表示を前面 slot の対象にし、前面区間の owner がいる間は待たずに busy とするか。推奨は採用である。前面入力の入力先を他 lane が変える経路を閉じ、人の操作を待つ picker の間も背景入力は止めない（§3.2）。
7. admission の待ちを最大 1 秒とし、期限後の自動送信を禁止するか。推奨は採用である。元の ticket / intent の期限の方が短ければそちらを使う（§3.2）。
8. 同一 PID + 作成時刻への session を一つに限るか。推奨は採用である。同じプロセスの別窓も二重開始しない（§3.3）。
9. 子プロセスの対象を自動追加せず、独立した資格・予約を要求するか。推奨は要求することである（§3.3）。
10. bounded UIA を並行実行の必須条件にするか。推奨は必須である。対応しない環境は並行 gate を閉じる（§3.4）。
11. 全体 gate を閉じる要因を termination_requested・起動時の recovery・全体 Stop の latch に限り、uncertain・closeCandidate・activeStopQuarantines・native の in-flight は lane 単位とするか。推奨は採用である。通常の固まりと通常の Stop は局所化し、termination_requested 中の他 session の新規入力と新しい helper の起動は許さない（§3.5）。
12. 最上位 Stop と緊急停止を全体停止とし、別に行停止を置くか。推奨はこの表示である（§3.6）。
13. 並行の第一の供給源を Task をまたぐ並行とし、そのために Task の選択変更で選択外の Task の実行中のセッションを止めないようにするか。推奨は採用である。Task ごとの claim・Turn 所有・ToolBroker の契約を変えずに済み、見えないセッションは全体の一覧・全体 Stop・overlay で扱う。app-grant カードと picker は今どおり選択外で引く（§3.6）。
14. 同じ Task の中の並行のうち、一つの Turn で computer_start を並列に呼ぶ案（§3.6 の (a)）を N15 に含めるか。推奨は含めないことである。claim・token の回転・V2 §5.2〜§5.4 の変更を伴い、Task をまたぐ並行で目的を満たせる。
15. 同じ Task の中の並行のうち、Team の Leader と worker に並行させる案（§3.6 の (b)）を N15 に含めるか。推奨は含めないことである。session gate・Turn 開始時の停止・V2 の Turn 束縛の変更を伴う。
16. §4 の Windows 実機証拠を並行 gate の公開条件にするか。推奨は必須である。設計・CI だけでは開かない（§4）。

### 6.1 残るリスクと前提

helper exit は新しい入力が出ない証拠であり、対象側の遅延 UIA / SendInput の取消しではない。completed の Invoke の後の非同期効果、前面化の遅延、OS event と claim の競合は N9 / kill-stop の残余リスクのままである。排他 admission でも既に対象へ届いた入力や他製品・人の入力を取り消せない。前面検査と SendInput の間（host.cc `SendInputForBoundTarget` の `:9823`〜`:9825`）に入力先が変わる窓は単一セッションの今と同じく残り、探索の起動の settle 時間の後に遅れて focus を取るアプリ（kill-stop §3.3）はこの窓に入りうる。

同じ SID の別 Main の拒否は使い勝手の制約となる。3 helper の署名・COM・画像処理費用、複数 hook の遅延、覆われた窓の capture、private namespace の境界（他ユーザーが同じ namespace を作れないこと、同じユーザーの別ログオンセッションから届くこと）、Windows の `.node` の署名の手順、前面区間の間の別 lane の UIA 読取りが前面を変えないこと、settle 時間の 5 秒の妥当性は実機で未確認である。N15 の試験で確認するまで能力を宣言しない。SID coordinator の復旧は kill-stop の Main crash / job の前提に従い、N3 / N4 が前提を変更した場合に独自の緩い復旧を作らない。

Task の選択変更での停止を外すと（Q13）、人が見ていない Task のセッションが動き続ける。全体の一覧・全体 Stop・overlay・緊急 shortcut で見つけて止められることを CS-1・CS-9 で確かめる。

承認後の別変更で V2 ADR の単一セッション、kill-stop の世代と D-5 の適用単位（§3.5 の隔離元の lane 単位の読み替えを含む）、N9 の複数 lane の調停、承認経路の複合世代参照へ本 ADR を接続する。今回は既存 4 ADR を変更しない。本 ADR は V2 ADR の T5（誤配の防止）、kill-stop D-5、deny class、権限・送信同意、未知の拒否、単発承認、K-1〜K-5、V2 §6.1 の app-grant カード 1 枚と T8 を緩めない。

agent-desktop から採るのは入力の調停と取得後の再照合という考え方である。自動前面化、モデルが指定できる `--force`、呼出し後の失敗を `not_delivered` に落として再試行すること、幾何だけの要素一致、権限を読めない場合の許可は採らない。外部リポジトリのコード・スクリプトを実行・転記しない。
