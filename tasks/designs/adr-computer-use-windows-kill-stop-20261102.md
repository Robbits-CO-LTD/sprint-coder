# ADR: Computer Use Windows — 「止める」を helper の終了で保証する

- Status: Accepted（2026-11-02、オーナー判断 D-1〜D-5 を反映）
- Date: 2026-11-02
- Issue: #988（Refs #500, #484, #820, #940）
- 関連: `tasks/designs/adr-computer-use-agent-driven-v2.md` §8（#484 の隔離。D-4 により、この ADR の §2.2〜§2.3 の条件つきで置き換え済み）、§10 リスク 10、§10「#820: UIA 読取りの停止境界」

## 1. 問題

現行コード（base `1899ca3c`、origin/main）では、Windows の開始済みセッションの Stop は「helper が close receipt を返し、Host が検証すること」でしか確定しない（`computer-use-native-host.ts` の `confirmSessionClosed` → `activeStopQuarantines.delete`）。helper が応答しないと、次のようになる。

- Controller は cancel の ack（1 秒）と close 2 回（10 秒 × 2）を待つ。start owner に処理中の discovery が無ければ、すべて期限切れのときの native の待機は合計約 21 秒で、Host は `native_stop_unconfirmed`、Controller の停止理由は `native_unavailable` になる。discovery がある場合、Host の close は `stopOwnerDiscoveries` と close の両方を `Promise.allSettled` で待ち、discovery の停止はそれ自体が最大 10 秒 × 2 かかるので、待機はさらに延びる。observe / control の隔離は Host の cancel / close 開始時から続く。
- transport は、未確認の semantic 入力や discovery が残る間は helper を**わざと殺さない**。遅れて届く receipt で、再起動なしに復旧できるようにするためである（`computer-use-windows-transport.test.ts` の `killed === false` の試験群）。
- 未確認の入力・discovery が無く、他の owner や要求も teardown を妨げない場合、close を 10 秒後に 1 回再送すると、最初の close の送信から約 40 秒（再送まで 10 秒 + 最後の close の transport 期限 30 秒）で helper を kill する。close 1 要求の transport 期限自体は 30 秒であり、40 秒は一律の kill 期限ではない。kill は確定の証拠にならないので、隔離は残る。
- receipt が来ないまま helper が戻らなければ、隔離はアプリの再起動まで続く。再起動で解けるのは、Main の終了と同時に libuv の job が helper を強制終了し（§3.3）、新しい Main が隔離の状態を持たないためである。停止を確認した結果ではなく、入力の対象の隔離も伴わない。

そのため、helper の中のあらゆる OS 呼出しが「Stop の応答を待たせない」ことが必要になった。UIA（#820）、同期ファイル I/O（#940）、capture と PNG（#983・#985）、WinVerifyTrust、process / exe の open、window discovery と launch が、それぞれ専用 worker、共有 slot、enqueue 時の stop serial、job ID、取消し alias、cleanup 後の候補採用を持つ。`computer_use_windows_host.cc` には detached な `std::thread` が 11 箇所あり、親 ADR §10 リスク 10 の記述は 20 段落を超える。

それでも、ADR 自身が書くとおり次の 2 点は保証できない。

- `CancelSynchronousIo` で中断できないドライバがある。戻らない worker は slot を握り続ける。
- 「Stop も既存の絶対期限もない場合の noncontact property / cleanup の停止」は残件（親 ADR §10「#820: UIA 読取りの停止境界」の最後）。

止まりうる呼出しを見つけるたびに 1 PR を足す方式は、10/24〜10/30 の 7 日間で 14 PR（#949〜#954、#975、#979〜#985）になり、まだ終わっていない。

## 2. 決定

**Windows の Stop の確定の証拠に「helper プロセスの終了」を加える。Stop は、期限内に close receipt が来なければ helper を終了させ、その終了を確認して確定する。**

この上で、helper の中の「Stop を待たせないための仕組み」は、入力の安全に要るものを除いて、新しく足さない。

### 2.1 終了で保証できること・できないこと

保証できること（2026-11-02 の敵対的レビューで崩れなかった点）:
- process handle が signaled になった後は、helper のコードはどこでも実行されない。終了中のプロセスには新しいスレッドを作れず、他プロセスからも注入できない。
- カーネルの中で止まっているスレッドは、ユーザーモードへ戻る時点で終了の APC を実行し、helper のコードには戻らない。
- UIA・COM の cross-process 呼出しの待ち（ALPC の `NtAlpcSendWaitReceivePort` など）はカーネルの中の待ちだが、wait mode が UserMode なので、終了の APC で解ける。対象が固まっていても終了を妨げない。
- Node の `exit` は libuv が process handle に `RegisterWaitForSingleObject` した結果で、signaled と一致する。

保証できないこと:
- **`TerminateProcess` が返った時点では、まだ保証は始まらない。** 終了は非同期で、別の CPU でユーザーコードを実行中のスレッドは APC が届くまで進む。win32k の中（`NtUserSendInput` など）にいるスレッドはその syscall を終える。保証の起点は signaled であって、`TerminateProcess` の戻り値ではない。
- **送った入力は、処理済みとは限らない。** `SendInput` は入力ストリームに積むだけで、対象の UI スレッドが固まっていれば Stop の後、ユーザーの入力と混ざって処理されうる（今も同じ）。
- **UIA の pattern 呼出しは、client が死んでも server 側で取り消されない。** `Invoke` / `SetValue` などが固まった対象の provider の中で止まっている場合、helper を終了させても呼出しは対象の UI スレッドに残り、起きたときに実行されうる。helper の中で動く UIA の Win32 / MSAA proxy が送った message（`BM_CLICK` など）も、対象のキューに残る。**これは「未確認の入力」より強い。今の helper は、client 側の呼出しが戻るまでは Stop を確定させない**（`StopWindowsSemanticInput` は `input_in_flight` の間 false を返し、Host の `stopWithDeadline` は `semantic_input_in_flight` を同じ期限の中で 50 ms ごとに再試行し、期限後は `native_stop_unconfirmed` にする）。**ただし、UIA の client timeout の後は、provider 側に呼出しが残っていても receipt で確定する。** V1 lane の UIA は bounded automation（`kWindowsV1UiaTransactionTimeoutMs` = 300 ms、`kWindowsV1UiaConnectionTimeoutMs` = 500 ms。`IUIAutomation2` が無い環境では timeout の無い automation に戻る）で作られ、pattern 呼出しが UIA_E_TIMEOUT で戻ると `input_in_flight` が解け、dispatch は `input_timeout_unconfirmed` を返す。次の close で `StopWindowsSemanticInput` は true を返す。前面経路では、この receipt の経路には対象の隔離が無い。背景経路は §2.2 の K-1〜K-5 の例外により対象の隔離を保つ（§2.3、§5 の 2）。

### 2.2 確定の判定

終了による確定の証拠は Main が保持する helper の process handle の signaled（Node の `exit`）だけにする。pipe の切断や `kill()` の戻り値は証拠にしない。健全な helper の検証済み close receipt による確定は維持する。

終了を決めた時点で、Main は helper に送った control 要求を調べ、結果の分類（clean / suspect）は exit の時点の台帳で決める。helper が入力の claim まで進んだかは Main から分からないので、**応答が無い、または応答が効果未確認の control 要求は「claim 済みかもしれない」として扱う**。効果未確認とは、次のどれかである。

- accepted=true の `semantic_input_in_flight`。helper の `DispatchWindowsSemanticAction` は、期限・Stop・遅い contact で待ちを打ち切ると、`input_in_flight` が真ならこの code を `accepted = ever_claimed` で返す。
- accepted=true の `input_timeout_unconfirmed`（§2.1 の UIA の client timeout）と `input_not_confirmed`（claim 後に確認できなかった dispatch。`SendInput` の dispatch も含む）。
- client の semantic owner が `uncertain` の状態（`markSemanticUncertain` が立てる）。

効果未確認かどうかは、エラー応答の `accepted` で決める。accepted=true のエラー応答が効果未確認で、上の code はその取りうる値である。`input_not_confirmed` は accepted=false でも返る（`DispatchWindowsAction` は、送れずに reason が空のときもこの code にする）が、accepted=false は効果なしとして台帳から消す。

**判定の情報源は、世代ごとの control 要求の台帳とする**（N3 で新しく作る）。

- 記録する時点は、client の `call()` が `sendConnected` に渡す `beforeWrite`（送信を確定する時点）とする。1 件ごとに helper の世代、session id、request id、種類、経路（`inputPath`）、対象の identity（pid + 作成時刻）、状態（応答待ち／効果未確認）を持つ。行（helper の世代、session id、request id、種類、経路（`inputPath`）、対象の identity、状態のすべて。§2.2 の判定にこれらが要る）は、送信の前（`beforeWrite` の時点）に §2.2 の 5 の永続ストア（保存先は N15 の Q23 の決定に従う）に書く。書けなければ送らない（fail-closed）。client（`WindowsComputerUseHelperClient`）は永続化への参照を持たず、addon は binding の読込みの時点で Host より先に作られるので、書込みは Host が行う。`index.ts` が N15 の Q23 で決める保存先に基づく台帳の store を `createComputerUseNativeHost` の options で Host に渡し、Host が addon に台帳の書込み・状態の書換え・消去のコールバックを渡す。client はそれを `beforeWrite` と応答の処理から呼び、書込みが失敗したら `beforeWrite` で例外にして送らない。送信の前に対象の identity（pid + 作成時刻）が確定していない dispatch も送らない。効果を確定した応答で行を消し、効果未確認の応答では状態を書き換える。これにより、応答待ちや効果未確認のまま Main が crash・終了しても、`termination_requested` のまま再起動しても、行が残る（起動時の扱いは 5）。
- 台帳には `dispatch` のすべてを入れる。semantic（`semanticActionTypes` の invoke / set_text / select / toggle / expand_collapse）に限らず、`SendInput` を使う click / scroll / key / type と、paste（#785 の artifact の貼付け。wire では `type` / `set_text` の dispatch）も含める。
- 消すのは、応答 frame を実際に受け取り、その応答が効果を確定したとき（成功、または accepted=false の拒否）だけにする。効果未確認の応答では消さず、効果未確認として残す。transport の timeout、`failAll`、`abortTransport`、binding の不一致や不正な応答でも消さない。
- 検証済みの close receipt でセッションの Stop を確定したら、K-3 の背景経路の例外を除き、そのセッションの行は、その時点で「receipt で確定済み」として消す。この通常経路では今と同じ扱いで、対象の隔離にしない（§2.3）。§2.2 の判定は、receipt で確定していない行（K-3 の保持対象のうち、対象の隔離へ移す前の行を含む）だけを見て、K-4 の前面化行を除外する。背景例外の無い receipt で確定した後の通常の helper の終了（idle teardown の `shutdown` → `abortTransport`）は、こうして `terminated_clean` になる。K-3 で移管済みの行は台帳に無いので exit 時の分類には数えないが、既に永続化した対象の隔離は、後の clean な終了でも解除しない。順序は次のとおりにする。
  - (a) 行を「receipt で確定済み」にするのは、Host が receipt を検証した後の `addon.confirmSessionClosed` とする（Host の `close` と、`finishStartOwner` の `kind === 'closed'` から呼ばれる）。今の client の `confirmSessionClosed` は semantic owner が無いセッションでは何もせず早く return するので、semantic owner の有無を問わず、すべてのセッションで台帳を処理するように変える。K-3 の対象隔離への移管と通常行の消去の後は、semantic owner の有無を問わず `shutdownWhenIdle` を呼び直し、(b) で遅らせた idle teardown を進める。receipt をその世代へ結び付ける証拠は、今の `semanticCloseProofs`（受信した応答 object を WeakMap で owner・receipt・世代に結び付け、Host から渡された evidence がその object であることを確かめる）を、semantic でないセッションの close にも広げて使う。
  - (b) 今の client は close の応答を受けると、Host の検証より前に `call()` の finally で `shutdownWhenIdle` を呼び、`shutdownIfIdle` は semantic owner・discovery・`pending`・接続中しか見ずに helper を終了させうる。台帳に receipt で確定していない行を持つ世代では、この idle teardown を (a) の Host 検証後の処理（K-3 の移管を含む）まで遅らせる（`shutdownIfIdle` の条件に台帳を加える）。この延期は (c) の終了を妨げない。(c) の終了は idle teardown ではなく、Stop の入口が起こすためである。
  - (c) receipt の parse、identity / epoch / count / proof の検証、discovery の停止に失敗したときは、§3.1 の 1 のとおり Stop の入口が再送せずすぐに helper を終了させ、終了で確定する経路として §2.2 の判定に通す。
- 今の client の `pending` は、要求の timeout・`failAll`・`abortTransport` で消える。timeout の後に残る記録は semantic owner だけで、これは semantic の dispatch にしか作られず、キーは session で、対象の identity を持たない。semantic でない dispatch と paste には何も残らない。このため `pending` や semantic owner を判定に使ってはならない。

| 状態 | 条件 | Main の扱い |
| --- | --- | --- |
| `terminated_clean` | signaled、かつ台帳にその世代の、receipt で確定していない、応答の無い・効果未確認の control 要求（K-3 で対象の隔離へ移す前の行を含み、K-4 の前面化を除く）が無い | Stop を確定する。その世代の helper の隔離を解く。既存の対象の隔離は消さない。新しい helper を起動できる |
| `terminated_target_suspect` | signaled、かつ台帳にその世代の、receipt で確定していない、応答が無い、または応答が効果未確認の control 要求（K-3 で対象の隔離へ移す前の行を含み、K-4 の前面化を除く）がある | Stop を確定する（helper からの新しい入力は無い）。**その要求の対象プロセスの identity（pid + 作成時刻）に限って隔離を保つ**。対象プロセスが終了するか、ユーザーが承認カードで再開を明示するまで、その対象には新しいセッションを始めない。他の対象は使える |
| `termination_requested` | 期限 T 内に signaled にならない | 隔離を保つ。新しい helper は起動しない。UI は「停止を要求した。最後の操作が後から反映される可能性がある」と表示し、「入力はもう出ない」とは言わない。`exit` を待ち続け、届いたら上の 2 行のどちらかへ移る（中断できない I/O が後で解けることがある）。このまま Main を終了・再起動しても、台帳の行が永続ストアに残るので、起動時に対象の隔離へ移る（5） |

Main が起こしていない helper の終了（crash、Stop 以外の `abortTransport`）も、台帳がある限り同じ判定と §2.5 の後始末に通す。

`termination_requested` のまま Main を終了・再起動した場合、新しい Main は古い helper の signaled を見ないまま、起動時に台帳の行を対象の隔離へ移し（5）、新しい helper を起動する。根拠は次のとおりである。Main の終了の時点で、古い helper には終了が要求されている（Main の `kill()`、または Main の終了で閉じる libuv の job の KILL_ON_JOB_CLOSE。job による部分も 2026-11-02 の N4-0 の実測で確認済み。§3.1 の 7、§3.3）が、signaled は確認していない（§2.1 のとおり、保証の起点は signaled である）。要求の後、ユーザーコードを実行中のスレッドが進むのは、終了の APC が届くまでの短い間だけである（§2.1）。この間は signaled が遅れても延びず、再起動の前に終わる。再起動の後に残りうるのは、終了を妨げているカーネルの中の待ち（壊れたドライバ）の完了だけで、完了したスレッドは終了の APC を実行して helper のコードに戻らないので、新しい入力は出ない。win32k の短い syscall（`NtUserSendInput` など）は終了の時点で完了し、その届く先は §5 の 10 のとおり対象に限らず、host 全体の隔離でも防げないので、再起動の後に対象ごとの隔離へ緩めても悪化しない。終了の前に対象へ届いた要求は、signaled を確認した場合と同じく、台帳の行の対象の隔離で受ける。止まった helper が対象の process handle や起動ごとの job の handle を持ち続けても、対象の照合（3）は対象自身の signaled と作成時刻で成り立つ。検証前の子は suspend のまま残り、実行されない（§3.3）。一方、再起動の前の `termination_requested` では host 全体の隔離を保ち、新しい helper を起こさない。§3.1 の 6 のとおり、古い世代の child を保持したまま新しい世代を起こすと、古いセッションの Stop が新しい世代へ届くなど、世代の取り違えが起きうるためである。

対象の隔離は、次のように作る（N3 の範囲）。

1. control 要求を送る時点で、Main はその対象の pid と作成時刻を台帳に持つ。取得元は helper の応答（session の開始や target の受領）とする。今の helper は作成時刻を内部にだけ持ち（`ReadProcessStartIdentity`、`WindowsSession::process_start`。応答の `windowIdentityDigest` にはハッシュとして入るだけ）、`StartWindowsNewSession` の応答は `pid` を返すが作成時刻を返さない。Host が持つのも `pidsByIdentity`（identity digest → pid）だけである。N3 で開始の応答に作成時刻を足す。作成時刻は Main の外（AI・Renderer）には出さない（親 ADR §8 の「パス・PID・ウィンドウハンドルを Main/native の外に出さない」と同じ）。
2. 今ある隔離元（`activeStopQuarantines`、client の semantic owner と `discoveries`、host の `discoveryManager.quarantined()` と `startOwners`）は、どれも host 全体を止める（Host の `inputQuarantined` → `requireMethod`、client の `assertSemanticAvailable` / `ensureConnected`）。`terminated_target_suspect` では、台帳の行が持つ identity をキーにした新しい「対象の隔離」へ永続的に移してから、これらを解除する。startSession・resume・discovery の入口で、その対象だけを拒否する。対象の隔離に入れるのは台帳の行の identity だけである。identity を持たない隔離元（client の `discoveries`、host の `discoveryManager.quarantined()` と `startOwners`）は、suspect でも対象の隔離へ移さず、helper の終了の確認で解除する。discovery の launch は対象への入力ではなく、launch の子は §3.3 で扱う。
3. 対象の終了の確認は、新しい世代の helper が `OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION)` と `GetProcessTimes` の照合で行う。次の 3 つを対象の終了とみなす: handle が signaled、作成時刻が一致しない（pid が再利用された）、pid が存在しない（`OpenProcess` が `ERROR_INVALID_PARAMETER`）。この照合は §3.1 の 3（新しい helper の最初の操作は `list_targets` か再観測）の例外として許す。それ以外の失敗（アクセス拒否など）では照合できないので、隔離を保つ。
4. 承認カードでの再開は、新しい経路として N3 で作る（今の Controller の `resume` は paused のセッションのためのもので、この用途には使えない）。helper 終了後の再開の ticket は新しい世代で新規に発行する。例外は K-5 の receipt で Stop した後の新しいセッションで、helper の世代は変わらなくてよい。§3.1 の 2 で失効させた古い ticket は使わない。
5. 対象の隔離も、台帳の行と同じ永続ストアに保存し、Main の再起動をまたいで保つ（N3 の範囲）。v2 の grant は永続（installation-wide・無期限）で、再起動の後は承認カード無しで開始できるので、メモリだけに持つと再起動が D-2 に無い解除の経路になるためである。台帳の行は上の全項目（helper の世代、session id、request id、種類、経路（`inputPath`）、対象の identity、状態）を持つ。対象の隔離の行が持つのは pid、作成時刻、隔離の理由だけで、台帳の行を対象の隔離へ移すときは世代・session id・request id を捨てる。どちらの行にも target の名前・パス・AI に見せる情報は入れない（session id と request id はこの禁止の対象外）。Main の起動時に永続ストアに残っている台帳の行は、K-4 の前面化行を除いて対象の隔離へ移す。前面化の行も、他の行と同じく送信前に種類を前面化として永続化する。応答で結果が確定したら（成功・検証済みの失敗）行を消す。結果が未確認ならセッションを pause し、行は「効果未確認」のまま残すが、終了時の clean / suspect の判定と起動時の対象の隔離への移行からは除く。その helper の世代の exit を確認したら、その世代の前面化の行を対象の隔離を作らずに消す。receipt で Stop を確定したときも、当該 Stop の前面化の行を同じく消す。Main の起動時に残った前面化の行は対象の隔離へ移さずに破棄し、最小の診断（行の種類と破棄の理由。理由は前面化行の起動時破棄を示す値）を残す。前面化が遅れて効いた場合の残余リスクは N9a の ADR の Q21 のとおり受け入れる。照合（3）は、起動後の最初の helper の起動時に行う（helper は `ensureConnected` まで起動しないので、照合のためだけに先に起動はしない）。照合が済むまでは、永続化された対象への開始を拒否する。解除するのは、この照合か新しい helper の世代の開始時の照合で対象の終了を確かめたとき、または 4・K-5 の承認カードで新しく開始するときで、照合できないものは保つ。保存先は B を採用（2026-11-03 オーナー決定）。下の表と契約に従う。ストア自体の読み書きに失敗したときは fail-closed とする。応答後の行の消去・書換え（R19a）、K-3 の移管（R19b）、exit 後の隔離への移管（R19c）の失敗にも適用する。保留中の書込み・移管は Host が持ち、開始・再開・discovery の入口ごとと Main の起動時に再試行する。Main の実行中（世代を問わず）、保留が解けるまで、影響する対象への開始・dispatch を拒否し、対象が特定できなければ新しい開始を全体で拒否する。拒否の理由は native_unavailable 相当とし、Stop の結果型は通常どおりで、保存の障害を Stop の結果に混ぜない。R19a の拒否を解除するのは、ストアが回復し、応答の結果どおりに行を反映したとき（効果確定なら消去、効果未確認なら状態の書換え）とする。R19b・R19c は、ストアが回復し、残った行の対象の隔離への移管が済んだときに解除する（前面化行は上の規則で消去する）。再試行が成功してこの条件を満たした時点で解除する。R19c は移管が済むまで、新しい世代でもその対象（特定できなければ全体）への開始を拒否し、helper の世代の隔離の解除より移管を先に行う。既存の対象の隔離の解除には、別途 3・4・K-5 の条件を要する。ストアが読めた上で個々の行が不正なとき（読めない行、identity の無い行）は、対象を守れないので破棄し、診断ログに構造化した最小限の metadata（行の種類と破棄の理由。理由は形式の不一致と identity の欠落を区別する値にする。pid・作成時刻・名前・パスは入れない）を残す。host 全体を永久に止める状態にはしない。ローカルの DB の書換えと、行の形式の変更・不整合による破損は対象外として受け入れる（§5 の 9）。行の削除による解除も検出できない（§5 の 9）。

保存先の両案（**B を採用、2026-11-03 オーナー決定**）:

| 案 | 保存先と影響 | 状態行・PR への影響 |
| --- | --- | --- |
| A（不採用） | userData の SQLite（従来の文面）。その userData 内で台帳と対象の隔離を永続化する。別の userData・プロファイルとの共有は保証しないため、N15 の同時操作の前提との調整が要る | R5・R6・R10・R14〜R22・R24 の保存・移管・復元・解除、PR4 の store と注入先、PR5・PR6・PR8・PR9 の利用先に効く |
| B（採用） | Windows のユーザーの SID で共通の永続ストア。同じユーザーの複数の Sprint Coder のインスタンス・プロファイルの間で対象の隔離を共有する（N15 の同時操作の前提）。保存・復元は以下の契約に従う。解除の接続は PR8・PR9 | A と同じ行・PR に加え、R5・R6・R10 の移管、R15〜R17 の照合・解除、R21 の実行中隔離を他インスタンスへ反映する範囲に効く |

送信前の永続化、原子的な移管、読書き失敗時の fail-closed を維持し、B を次のように具体化する。
- SID ごとの既定 ACL を継承する固定の %LOCALAPPDATA%\Sprint Coder\computer-use\kill-stop.sqlite に保存する。userData に依存しない。better-sqlite3、WAL、busy_timeout 250 ms とし、Host の保存の期限 2 秒以内で競合を失敗として返す。
- 台帳は (instanceId, helperGeneration, sessionId, requestId) で一意。instanceId は正規化した userData の絶対パスのハッシュで、Main の再起動をまたいで同じ。起動時に読む台帳は自分の instanceId のものだけ。対象の隔離（pid・作成時刻・理由）は同じ SID の全インスタンスで共有する。
- transferReceipt は隔離の追加と台帳の削除を一つの transaction で行う。隔離を消さず、transferReceipt と restoreQuarantines はともに最初にコミットされた理由を保持し、再試行は冪等。接続ごとに書込みと完了を直列化する。並走時のコミット順と核の処理順は異なりうるが、理由は判定に使わない。
- 起動復元と入口の共有隔離の再読取りが失敗した間は開始を拒否する。読めた正常行は使い、不正行・null・identity 欠損は R20 に従って破棄し、行の種類と破棄理由だけを診断へ渡す。復元用の状態を実行中の helper から分離し、再読取りで kill や保留中の移管を巻き戻さない。
- PR4 は Host への注入と restoreWindowsLedger の入口まで。index.ts からは有効にせず、有効化は PR10。別インスタンスの隔離による拒否は pid と作成時刻が分かる対象で試験し、作成時刻が不明な新規開始の照合は PR8 に残す。

**背景経路の例外（N9a の K-1〜K-5）**: 正本は `adr-computer-use-windows-background-input-20261102.md` §2.5 である。次を §2.2 の判定・対象の隔離の 1〜5 と §2.3 の例外として N3 で実装する。背景専用の Stop は作らない。N9a の ADR の K-1・K-3 が「SQLite のストア」と書く箇所は、本 ADR §2.2 の 5 の SID 共通 SQLite（B、2026-11-03 オーナー決定）と読み替える。

- **K-1（実行中の隔離の入口）**: `inputPath` が `background_semantic` の台帳の行について、次のどれかが起きたとき、Main は Stop や helper の終了を待たずに、その行の対象（pid + 作成時刻）の隔離を作る。(a) dispatch が accepted=true の効果未確認（`input_timeout_unconfirmed`、`input_not_confirmed`、`semantic_input_in_flight`）で返った。(b) 応答が無いまま、その要求が transport timeout・`failAll`・`abortTransport` で終わった（N9a の ADR §2.4 の表の「応答消失」）。(c) その要求で semantic owner が uncertain になった。(d) takeover と claim が競合して結果未確認になった。隔離の行は §2.2 の 5 と同じストア（保存先は N15 の Q23 の決定に従う）に書き、再起動をまたいで保つ。書けなければセッションを pause し、その対象の開始を拒否する（fail-closed）。隔離の行が持つのは同 §2.2 の 5 と同じく pid、作成時刻、隔離の理由だけである。
- **K-2（隔離の効く範囲）**: 隔離は startSession・resume・discovery の入口に加え、実行中のセッションのその対象への dispatch・承認交換・前面への引渡しを拒否する。K-1 で隔離したセッションは pause し、Controller の通常の resume（paused のための再開）では再開できない。同じセッションをそのまま再開する経路は作らない。セッションを Stop した後、helper の世代が変わった後なら本 ADR §2.2 の 4 の承認カードでの再開、世代が変わらないまま receipt で Stop した後なら K-5 の新しいセッションの開始による。隔離は PID + 作成時刻の対象プロセスに掛け、同じプロセスの別窓・別 session・前面入力からも迂回できない。
- **K-3（receipt で確定した行を消さない例外）**: `inputPath` が `background_semantic` で、receipt で確定していない応答待ち・効果未確認の行は、検証済みの close receipt で Stop を確定しても消さず、同じストアの transaction（保存先は N15 の Q23 の決定に従う）で対象の隔離へ移す。`confirmSessionClosed` が semantic owner の uncertain を戻しても、この行の扱いは変わらない。K-1 の隔離の書込みと応答の処理の間に Main が crash した場合も、残った行が起動時に隔離へ移る（本 ADR §2.2 の 5）。
- **K-4（台帳の列と種類、終了時の判定の例外）**: 台帳の行に `inputPath` の列を足す。前面への引渡し（helper の `SetForegroundWindow`）も control の種類（前面化）として台帳に記録する。前面化は対象の内容への入力ではなく、win32k の短い呼出しで完了するので、その結果未確認は隔離を作らず pause にする。本 ADR §2.2 の終了時の判定は、応答の無い・効果未確認の行が残る世代を `terminated_target_suspect` として対象を隔離するので、これと食い違わないよう、前面化の種類の行をこの判定と起動時の隔離への移行（同 §2.2 の 5）の対象から除く例外を、kill-stop 側の判定の例外として N3 に入れる。前面化の行の保存・消去・起動時破棄は §2.2 の 5 に従う。前面化が遅れて効いた場合の残余リスクは N9a の ADR の Q21 のとおり受け入れる。
- **K-5（Stop の後の新しいセッションの開始での隔離の解除）**: K-1 で隔離した対象について、そのセッションを receipt で Stop した後、同じ対象に新しいセッションを始めるときに、承認カードで対象の隔離を解く経路を足す。同じセッションをそのまま再開はしない。カードは、対象（検証済みのラベル）、隔離の理由（応答消失・効果未確認・takeover との競合の別）、「最後の操作が後から反映される可能性がある」を示し、trusted activation を必須にする。新しいセッションは新しい session id・ticket・cancel epoch で始め、新規観測から始める（背景セッションなら、その時点の interaction epoch を束縛する）。隔離の前の観測・要素参照・ticket・承認 intent は使わない。対象の隔離の行は、このカードの承認で解除する。**K-5 のカードの承認は、client の semantic owner の uncertain / closeCandidate、host の `activeStopQuarantines`、native の in-flight を外す根拠にしない。** これらは receipt・helper の終了による確定でだけ外れる。カードを承認しても、これらが残る間は dispatch は拒否される。実装では、これらのどれか（Host の `inputQuarantined()`）が残る間はカードの承認そのものも拒否する（意図した fail-closed）。

K-3 の移管では台帳の記録を先に失わず、対象の隔離として永続的に引き継ぐ。K-4 の前面化の行は終了時にも起動復元時にも隔離の根拠にしない。画面が変わっていないことや待ち時間の経過は解除の根拠にしない。カード承認でも、発行済みの呼出しを取り消せた保証はない。背景 observation、要素参照、引渡し許可、承認 intent、execution ticket は helper 世代の失効時に一括失効させ、旧要求を新 helper へ再送しない。

**N9 は、N3 に K-1〜K-5 が入り、その試験が通るまで背景入力を公開しない。**

### 2.2.1 前面化を送る前の identity 取得（PR5b、案 C 採用）

K-4 の記録範囲は、N9 の新しい引渡しだけでなく、helper の `SetForegroundWindow` 全体とする。現在の `computer_use_windows_host_v2_targets.inc` の `StartWindowsNewSession` と `StartWindowsExistingSession` は V1 / V2 の共有経路で、開始応答より先に前面化する。PR2 で開始応答に加わった `processStartTime` は、その開始自身の送信前記録には間に合わない。案 C を採用（2026-11-03 オーナー決定）し、有効化は PR10 と同時とする。以下の比較は判断の根拠であり、実装済みを意味しない。

| 案 | 送信前の台帳記録 | identity の取り違え（TOCTOU） | MessageType・protocol の変更 | V1 / V2 の開始への影響 | 試験のしやすさ |
| --- | --- | --- | --- | --- | --- |
| A: 準備要求 → 記録 → identity に束縛した開始 | 前面化せず identity だけ返す準備の後、開始の beforeWrite で保存できる | 準備結果を世代・対象へ束縛し、開始時にも process handle の作成時刻・生存と窓を再照合する | 準備の要求・応答の MessageType と開始の期待 identity を追加。開始の成功・失敗の応答に、前面化の試行・結果の内部項目を追加。準備状態を保持するなら失効・取消しも必要 | 両方の開始前に往復を追加。開始内の前面化と後段検証は維持できるが、準備のための共通測定の切出しが要る | 準備で前面化しないこと、対象交代、取消しを個別に試せる。新しい要求の寿命の試験が増える |
| B: 前面化しない開始 → 記録 → 前面化 dispatch | 開始応答の identity を使い、別の dispatch の beforeWrite で保存できる | dispatch 時にも session の process handle・identity・窓・世代を再照合する | 開始の前面化抑止指定と前面化 operation・結果契約を追加。dispatch の MessageType は再利用可能でも protocol は拡張する | 現在の開始は前面化後の TargetWindowFacts や dialog の検証を含むため、単に前面化を飛ばせない。両方に未前面化 session と開始完了の状態管理が必要 | 台帳と前面化だけの試験は容易だが、未完了 session の observe / control 禁止、再開・取消し・後段失敗の試験が広がる |
| C: discovery / check_target_identity → 記録 → identity に束縛した開始 | discovery の identity（既存 session では保持済みの値）を照合し、開始の beforeWrite で保存できる | check の後にも対象は変わりうる。既存の windowIdentityDigest による束縛と保持している process handle は維持する。追加の期待 identity は、台帳の値と helper が照合する値を一致させるためのものとする。開始要求に期待 identity を渡し、helper が前面化直前にも保持 handle・作成時刻・生存・窓を再照合する | 新しい MessageType は不要。discovery 応答の作成時刻、開始の期待 identity、対応能力の確認は追加する。開始の成功・失敗の応答に、前面化の試行・結果の内部項目を追加。既存 check の意味は変えない | 両方の discovery の内部応答と共有開始を拡張する。既存の前面化と後段検証の順序を維持できる | 既存 discovery・PR3 の identity seam・新規／既存 start seam を再利用できる。保存順序の Host/client 結合試験を加える |

**C を採用（2026-11-03 オーナー決定）、有効化は PR10 と同時。** 前面化後の開始検証を保ち、新しい準備要求や未前面化 session の状態を作らずに送信前記録を実現できるためである。ただし、既存 protocol のままでできるという意味ではない。`computer_use_windows_host_discovery.inc` の `ReadProcessStartIdentity` は作成時刻を読めるが、PR3 の `CheckWindowsTargetIdentity` は要求された pid + 作成時刻への alive / terminated / unverifiable を返す照合であり、未知の作成時刻を返さない。V1 の窓列挙と V2 の `WindowsV2SelectableRow` は作成時刻を window identity の digest に使うが、生の値を返していない。この内部応答を拡張する。V1 に V2 専用の listTargets を呼ばせず、それぞれの既存 discovery 経路を使う。

A / C の応答項目では、成功応答と stop_pending_start の receipt に載る既存の inputAttemptCount を失敗応答にも使う案を比較するが、試行回数だけでは効果の確定・未確認を区別できないため、結果を示す内部項目も必要になる。

採用案 C の順序と境界:

1. 第1段は、前面化・入力・session 開始を行わない discovery から、選んだ候補に束縛された pid + processStartTime を取得する。新規開始では check_target_identity が alive でなければ第2段へ進まない。既存開始では discovery / check の段は不要で、保持済みの session identity と既存の process handle の照合で足り、別の値で上書きしない。作成時刻は整数文字列のまま Main 内に保持し、AI・Renderer への公開情報から除く。
2. 第2段の開始要求に期待 identity を載せる。client が wire の request id と helper 世代を確定した beforeWrite で、Host が前面化行の全項目（§2.2）を保存する。開始前でも session id は開始要求の値を使い、種類は前面化、inputPath は前面経路とする。既に前面にある場合も前面化しうる開始として保守的に記録し、検証済みの結果で消す。保存失敗なら開始を送らない。
3. 保存完了後に世代・開始 owner・取消し・隔離を再判定する。変化したら送信を拒否し、未送信を証明できる行だけ専用の取消し処理で消す。消去失敗なら行と保存保留を残す。応答を受けたことにする偽の拒否通知は使わず、exit 後の分類も巻き戻さない。旧世代の準備結果や開始要求を新世代へ再送しない。
4. helper は新規・既存開始の両方で期待 identity と測定した process handle の pid・作成時刻・非 signaled を照合する。既存の window identity・geometry・eligibility・stop serial・cancel epoch の検証も維持する。複数に分かれる ShowWindow（対象窓と再前面化先の窓）/ SetForegroundWindow の各呼出しの前、begin_focus の単位ごとに再照合し、明示再開の dialog を含め実際の前面化先の HWND が同じ対象プロセスに属することを確認する。identity・handle の照合は stop_mutex の外で行い、Stop と排他する区間では既存の取消し・epoch の確認と試行回数の更新だけを行う。不一致・確認不能なら前面化を呼ばず拒否する。照合と OS 呼出しの完全な原子性は主張せず、前面化後の既存検証も残す。遅延効果の残余リスクは K-4 / Q21 に従う。
5. 前面化後にも開始は失敗しうるため、開始エラーだけを「前面化なし」とみなして行を消さない。開始応答の内部結果契約で前面化の成功・検証済みの拒否・効果未確認を区別する。開始応答が期待 identity と食い違う場合も不正応答として扱う。不正応答・応答消失では行を保持して pause にし、session 採用前なら開始 owner からの後続入力を許可しない。session が作られなかった開始の前面化行も、結果が確定した応答で消し、未確認なら保持する。検証済み receipt が当該 Stop を確定した場合は消し、対応する helper 世代の exit 確認時と Main 起動時にも対象の隔離へ移さず破棄する。その後の寿命と隔離の除外は §2.2 の 5・R23 に従う。

### 2.3 #484（変更禁止の不変条件）との関係

**この ADR は #484 を部分的に緩める。** 今は「helper の close receipt」だけが確定の証拠で、claim 済みの UIA 呼出しが残る間は確定しない。この ADR は、helper の終了でも確定させる。ただし、claim 済みかもしれない呼出しが残る場合（`terminated_target_suspect`）は、その対象に限って隔離を保つので、「未確認の入力が残る対象へ入力を再開しない」という #484 の目的は保つ。親 ADR §8 の変更禁止は、オーナー判断 D-1・D-2・D-4 により、上記の条件つきで置き換えることが承認された（§6）。D-4 の 4 箇所以外にある同じ趣旨の記述（親 ADR §8 の「Stop 後に入力が続かない」、§10「#820」の「Mainは未確認semantic ownerと元helperを保持し…」の段落など）も、この ADR を優先する。

終了と receipt の経路は非対称である。終了で確定する経路では、効果未確認の要求の対象を隔離する。前面経路の receipt で確定する経路（UIA の client timeout の後、§2.1）では、provider 側に呼出しが残りうるのに対象の隔離が無い。これは今と同じである（§5 の 2）。背景経路は §2.2 の K-1〜K-5 を例外とし、正常な close receipt の後も K-3 の応答待ち・効果未確認の行を対象の隔離へ移す。K-4 の前面化行は終了時と起動復元時の隔離の根拠から除く。通常行は receipt の検証時に消すが、背景の未確認行を一括消去しない。

### 2.4 入力の不変条件（新しく明文化する）

- down と up は 1 回の `SendInput` に入れる（今の click・key はそうなっている）。helper が途中で終了しても、キーやボタンが押されたままにならない。drag・修飾キー・ホットキーを足すときもこれを守る。
- 今の例外: 補助文字（サロゲートペア）の入力は、`SendUnicodeScalar` で上位サロゲートの down/up と下位サロゲートの down/up を 2 回の `SendInputForBoundTarget` に分けている。その間に helper が終了すると、対象には上位サロゲートだけが届き、テキストや IME の状態が壊れうる。S4（N5）で、1 つの scalar の 4 イベントを 1 回の `SendInput` にまとめる。今の `type` は 1 回の dispatch で 1 scalar に限られる（helper は `scalars.size() != 1` を `invalid_text` で拒否する）。複数の文字の入力の途中で終了すると、応答待ちの 1 件が効果未確認になり（§2.2）、それより前に completed で返った文字は入力済みとして残る。複数の scalar を受け付けるよう広げる場合は、途中の終了を一部だけの入力として効果未確認で扱う。

### 2.5 helper の終了は、その helper の上のすべてを止める

Windows addon は 1 つの `WindowsComputerUseHelperClient` を持ち、その client を通るセッション、Task、開始待ち、discovery、picker は helper を共有する。現行 Controller は同時に 1 セッションだけを許可するが、開始待ちや discovery の owner も同じ helper を使う。複数セッションを扱う場合も、セッション A の Stop のために終了させると、B のセッションと入力中の操作、その helper が出した ticket も失われる。

- helper の終了は、その helper の世代（`helperGeneration`）のすべての owner に対する Stop として扱う。原因は問わない（§2.2 の最後）。影響を受けた各セッションには、通常の `completeStop` の後始末をすべて行う（`cancelPendingApprovals`、#785 の `copiedArtifacts` / `attachedArtifacts` の破棄、stopped の状態）。B の Task には「別の操作の停止のため、Computer Use が止まった」と返す。
- 他の owner の有無にかかわらず、応答待ちは §3.1 の 1 の期限 C まで待つ。close の `semantic_input_in_flight` だけは C の中で 50 ms ごとに再試行する。それ以外の失敗は C を待ち切らず、同じ終端処理に直ちに入る。

### 2.6 入口と結果の状態表

以下は N3 の実装・試験に用いる設計上の状態表であり、実装済み・有効化済みを示さない。全軸の直積ではなく、結果が変わる組み合わせを示す。入口と結果を組み合わせて受入を確認する。

時刻の起点は、その入口の Stop の開始とする。C = 10 秒（実測で見直すまで維持）、T = 2 秒。E1 / E2 は cancel の ack に最大 1 秒を使い、E3 / E4 は使わない。C 内の `semantic_input_in_flight` の再試行で期限を延長しない。exit が期限内に来ない場合に返すのは、停止確定ではなく `termination_requested` である（§3.1 の 1）。

| 入口 | 通常の確定 | receipt が得られない場合の結果の期限 | 根拠 |
| --- | --- | --- | --- |
| E1 開始済みセッション | 検証済み close receipt | cancel 最大 1 秒 + C + T = 最大 13 秒 | §3.1 の 1、§4 の S2 |
| E2 native がある開始待ち | 検証済み close receipt | cancel 最大 1 秒 + C + T = 最大 13 秒 | §3.1 の 1 |
| E3 native が無い開始待ち（`nativeStarted=true`） | 検証済み pending-stop receipt、または未送信証明 | C + T = 最大 12 秒 | §3.1 の 1、§4 の S2 |
| E4 セッションに属さない discovery | 検証済み停止 receipt、または未送信証明 | E3 と同じ C + T = 最大 12 秒。別の期限を作らない | §3.1 の 1、§6.1 の 1 |

「世代後始末」は、Host の session 表・隔離元、client の semantic / discovery / starts、token / ticket、Controller の承認・artifact を、その世代について片付けることである（§2.5、§3.1 の 2・5・6）。「未確認行」は K-3 の背景の保持対象のうち、対象の隔離へ移す前の行を含み、隔離の判定からは K-4 の前面化行を除く。既存の対象の隔離は clean の終了だけで消さない。kill 開始後の receipt は終了処理を取り消さず、Host の検証後の台帳の扱いと exit 時の分類を §3.1 の 1 に従わせる。

| ID | 意味のある組み合わせ | Stop の確定時刻・helper | 対象隔離／台帳 | Host・client／見える理由／次の開始 | 根拠 |
| --- | --- | --- | --- | --- | --- |
| R0 | E3/E4、確実に未送信、他に未確認 owner なし | 未送信証明時。kill 不要 | 作らない／送信行なし | 当該 owner を終了。E3 の要求理由を維持。session が無い E4 の通知先・理由値は PR11 で決める。開始可 | §3.1 の 1 |
| R1 | kill を始める前、E1–E4、正常 receipt（E4 の通常の停止 receipt を含む）、背景例外なし | Host 検証時。通常 idle teardown 可 | 当該 Stop の行を削除。対象隔離なし | 通常 Stop の後始末。開始可 | §2.2、§2.3 |
| R1a | kill 開始後、exit 確認前に正常 receipt を Host が検証 | 終了は取り消さない。確定の証拠は exit | 検証済み receipt で効果が確定した通常行は消す。K-3 は対象隔離へ移管、前面化行も消す | 分類は exit 時点の台帳で R4 / R5。期限内に exit が無ければ R7。旧 session・ticket を復活させない | §2.2、§3.1 の 1、§6.1 の 7 |
| R2 | kill を始める前、receipt 受信済みだが Host 未検証、台帳あり | **まだ確定しない**。idle teardown を延期 | 行を保持 | 検証成功で R1（背景は R22）、失敗で R4 / R5 / R7 | §2.2 の (a)〜(c) |
| R3 | kill を始める前、close が `semantic_input_in_flight` | C 内で 50 ms ごとに再試行。期限は延長しない | 行を保持 | C 内成功なら R1（背景は R22）、期限なら R4 / R5 / R7。それ以外の失敗は即時に終端処理 | §2.5、§3.1 の 1 |
| R4 | E1–E4、期限切れ・失敗、exit 確認、未確認 control 行なし | exit 時に `terminated_clean` | 新規隔離なし。K-3 で移管済みのものを含む既存の対象隔離は消さない | 世代後始末。E1〜E3 は要求理由維持、session が無い E4 の理由値は PR11 で決める。新 helper 開始可 | §2.2、§3.1 の 1・5 |
| R5 | 同上、台帳の全種類（SendInput・paste を含み、前面化は除く）で応答待ち／accepted=true 効果未確認あり | exit 時に `terminated_target_suspect` | identity の対象隔離へ永続移管。移管前に行を失わない | 世代後始末。E1〜E3 は要求理由維持、session が無い E4 の理由値は PR11 で決める。遅延反映の注意。同対象不可、他対象可 | §2.2、§3.1 の 4・5 |
| R6 | R5 の未確認行が SendInput／paste、または Stop 中に transport timeout | R5 と同じ | `pending` 消失に関係なく台帳から隔離 | 再送しない。他対象可 | §2.2、§4 の S2 |
| R7 | kill 要求後、T 内に exit なし | 停止は未確定。`termination_requested` を返す | 台帳・隔離を維持 | child 保持、全操作・新 helper を拒否。E1〜E3 の理由は `native_unavailable`。E4 は `native_stop_unconfirmed` を伝達し、session が無い通知先・理由値は PR11 で決める | §2.2、§3.1 の 1・6 |
| R8 | R7 の後で exit 到着 | 到着時に R4 / R5 へ遷移 | その世代の台帳で判定 | 該当世代だけ解除・後始末。核は `generation_exit` に終了原因と `late: true` を別々に保持し、Stop 起点なら元の要求理由を示す。E4 は `discovery_result` に `late: true` を保持する。配送は PR7c-2 | §2.2、§6.1 の 8 |
| R9 | 未確認 discovery／start owner のみ残る、exit 確認 | `terminated_clean` | identity のない owner を対象隔離に変えない | discovery／start のブロック解除。その対象に既存の隔離が無ければ開始可（他の対象の隔離は関係しない） | §2.2 の 2、§3.1 の 5 |
| R10 | 未確認 discovery と未確認 control が同居、exit 確認 | `terminated_target_suspect` | control の identity だけ隔離 | discovery も終了。対象不明として host 全体を残さない | §2.2 の 2、§3.1 の 5 |
| R11 | Stop 外の crash／abortTransport、exit 確認 | exit 時に R4 / R5 と同じ判定 | 同じ台帳規則 | 全 owner を後始末。核は `generation_exit` に crash / abortTransport、遅延の有無、clean / suspect、`native_unavailable` を保持する。配送は PR7c-2 | §2.2、§2.5、§6.1 の 8 |
| R12 | A の Stop で共有 helper 終了、B／picker／開始待ちも存在 | 同じ exit に結び付ける | 全 session の未確認行を対象別に判定 | 全 owner と token を失効。B に「別の操作の停止のため…」 | §2.5、§3.1 の 2・5 |
| R13 | 古い世代の exit の確認後に、その古い世代の receipt／応答が遅着 | 新世代の証拠にしない。分類を変えない | 台帳の行を消さず、対象の隔離を変えない | 旧 session・ticket を変えず、新世代の owner・ticket・隔離も誤解除しない。N9a の「遅い成功 receipt だけで旧 ticket や旧世代の session を復活させない」と同じ | §3.1 の 2・6、N9a §2.5 |
| R14 | 応答待ち／効果未確認／R7 のまま Main 再起動 | 再起動を exit 証拠にしない | 残った行（前面化を除く）を対象の隔離へ復元。前面化の行は R23 のとおり破棄 | 最初の helper で照合。同対象は照合・承認まで不可 | §2.2 の 5、§3.3 |
| R15 | 隔離対象の照合：signaled／作成時刻不一致／PID 不在 | 過去 Stop の判定とは別 | 対象隔離を解除。照合は起動後の最初の helper と新世代の開始時に行う | 新しい観測・ticket の規則を満たして開始可 | §2.2 の 3 |
| R16 | 照合：同じ生存対象／アクセス拒否等 | 終了を証明できない | 隔離維持 | 同対象不可。他対象可。承認カードは別の解除手段 | §2.2 の 3・4 |
| R17 | 隔離対象を trusted activation を伴う承認カードで明示再開 | 承認時に解除 | 対象隔離を永続的に解除 | 終了後は新世代・新 ticket、再観測後に開始。receipt で Stop 後の同世代での新しいセッションは K-5（R24） | §2.2 の 4、§3.1 の 2・3 |
| R18 | 送信前に identity 不足／台帳書込み失敗 | dispatch 自体を送らない | 不完全な送信行を正常扱いしない | fail-closed。これだけを理由に kill する仕様ではない | §2.2 の台帳 |
| R19 | 起動・移管時にストア全体の読書き失敗 | 安全な復元・移管を完了できない | 消去して成功扱いしない | 対象が判明なら対象を、特定不能なら新規開始を拒否 | §2.2 の 5 |
| R19a | 応答後の行の消去・書換えに失敗 | 応答と保存の成功を混同しない | 残った行を失わない | fail-closed。Main の実行中（世代を問わず）、保留が解けるまで影響する対象への開始・dispatch を拒否（対象が特定できなければ新しい開始を全体で拒否）。理由は native_unavailable 相当。解除はストアが回復し、応答の結果どおりに行を反映したとき（効果確定なら消去、効果未確認なら状態の書換え） | §2.2 の 5 |
| R19b | K-3 の対象隔離への移管に失敗 | receipt の検証と移管の成功を混同しない | 台帳の行を先に消さない | R19a と同じ拒否範囲・理由。解除はストアが回復し、残った行の対象の隔離への移管が済んだとき | §2.2 の 5、K-3 |
| R19c | exit 後の対象隔離への移管に失敗 | exit の確認と移管の成功を混同しない | 台帳の行を先に消さない | R19a と同じ拒否範囲・理由。解除はストアが回復し、残った行の対象の隔離への移管が済んだとき。それまでは新しい世代でもその対象（特定できなければ全体）への開始を拒否し、helper の世代の隔離の解除より移管を先に行う | §2.2 の 5、§3.1 の 5 |
| R20 | ストアは読めるが行の形式不正／identity 欠損 | その行で対象を守れない | 行を破棄、最小診断 | 永久 host 隔離にはしない。失われた隔離は受容済み | §2.2 の 5、§5 の 9 |
| R21 | 背景経路 K-1、helper 生存・セッション実行中 | Stop の確定とは独立 | 直ちに対象を永続隔離。書けなければ fail-closed | セッションを pause。開始・通常 resume・discovery に加え、同対象への dispatch・承認交換・前面引渡しも拒否。同じプロセスの別窓・別 session・前面入力でも迂回不可 | §2.2 の K-1・K-2 |
| R22 | background_semantic で receipt で確定していない応答待ち・効果未確認の行があり、正常 close receipt（R21 の後に限らない） | Stop は Host の receipt 検証で確定可能。kill 開始後は exit を優先 | 背景の応答待ち・効果未確認の行を一括消去せず、同じ transaction で対象隔離へ移管 | semantic owner の uncertain が戻っても隔離を保つ。他対象はほかの拒否条件がなければ可、同対象は不可 | §2.2 の K-3、§2.3、§3.1 の 1 |
| R23 | 前面化（SetForegroundWindow）だけ結果未確認 | 未確認なら pause。終了時は他の行も判定 | 送信前に種類を前面化として記録。成功・検証済みの失敗で消去。未確認は効果未確認として保持。exit 確認でその世代の行を消し、receipt で Stop 確定でも当該行を消す。起動時の残存行は破棄し、行の種類と破棄の理由だけ診断に残す。いずれも対象隔離を作らない | 前面化は clean / suspect の判定と起動時の隔離移行から除く。遅れて効く残余リスクは N9a の ADR の Q21 のとおり受け入れる | §2.2 の 5・K-4、§5 の 2 |
| R24 | K-1 の対象を receipt で Stop した後、新しいセッションの開始でカード承認 | helper の世代は変わらなくてよい。同じセッションは再開しない | 承認した対象の隔離を解除 | 新しい session id・ticket・cancel epoch、新規観測（背景は現在の interaction epoch に束縛）。カードは uncertain / closeCandidate・activeStopQuarantines・native in-flight を解除しない | §2.2 の K-5、§2.3 |

R19a〜R19c の保留中の書込み・移管は Host が持ち、開始・再開・discovery の入口ごとと Main の起動時に再試行し、各行の解除条件を満たした時点で解除する。Stop の結果型は通常どおりとし、保存の障害を Stop の結果に混ぜない（§2.2 の 5）。

対象隔離の解除の契機（R15〜R17・R24）は、起動後の最初の helper での照合、新しい helper 世代の開始時の照合、helper 終了後の承認カード、receipt で Stop 後の K-5 の承認カードに限る。照合は対象の終了を証明した場合だけ解除し、カードは trusted activation を要する。clean な終了や時間の経過だけでは解除しない。

省いた組み合わせ（設計上不可能なもの）:

| 組み合わせ | 省いた理由・根拠 |
| --- | --- |
| exit 未確認で `terminated_clean` / `terminated_target_suspect` | §2.2 に反する。kill の戻り値・pipe 切断も証拠にしない |
| 正規の新規 dispatch が identity なしで送信成功 | §2.2 の送信前 fail-closed により不可。不正な保存行は R20 |
| 未確認 discovery だけから対象 identity を推測して隔離 | §2.2 の 2 が禁止 |
| 同じ Main で旧 helper の終了待ち中に新 helper を起動 | §3.1 の 6 が禁止。Main 再起動後の R14 とは別 |
| accepted=false の検証済み拒否を効果未確認として隔離 | §2.2 では効果なしとして行を消す。不正・未受信の応答はこの扱いにしない |

R13 の遅着は古い世代の exit の確認の後にしか起きず、新しい世代の起動の前後は問わないため、同じ Main で古い世代の終了待ち中に新しい helper を起動しないという上の規則と両立する。

PR7c-1 で核の通知型を次の union に確定する。製品の配送は有効化しない。

- `unchanged`: 通知なし。古い receipt・応答・二重 exit（R13）はこの値とし、終了分類を変えない。
- `termination_pending`: T 超過時に一度だけ停止未確定を通知する。理由は既存の `native_unavailable`。exit が来なくても返す。
- `generation_exit`: `cause`（stop / crash / abortTransport）、`late`、`result`（terminated_clean / terminated_target_suspect）、`initiatorReason` を保持する。Stop 起点は `requested_reason`、Stop 外は `native_unavailable` とする。核の `entry` は Stop 外で null、E1〜E4 の開始で設定し、終了原因 `cause` と独立に Stop 起点を判断する。遅延と原因を混同せず、公開 StopReason は増やさない。
- `discovery_result`: E4 の Stop 結果と `late` を保持する。R7 の後の遅い exit（R8）は `late: true`、それ以外は false。Stop 中は cause が crash / abortTransport でもこの通知を使う。停止成功と `native_stop_unconfirmed` は既存の結果型を使う。session が無い場合の最終配送先は PR11。

`WindowsStopDecision` は入力イベントでなく結果の種類を判別子にする。`GenerationCleanup` は `ready`（世代必須）/ `deferred`（世代と保存待ち ID 必須）の union とする。R19c は `exit_confirmed` で終了と保存待ちを返し、保存回復時の `storage_recovered` で同じ世代の後始末を許可する。終了通知を再発行せず、解消済み hold の再試行は呼出し側の不具合として例外 `Unknown storage hold` を投げる。終了確認と後始末の配送段階への対応は PR7c-2 で定義する。

R8・R11 の配送・owner 照合は PR7c-2、Controller への接続と表示は PR10。セッションが無い E4 の最終配送先と settle の具体的な時間は、引き続き §6.1 の 8・9 に従って決める。

#### PR7c-2: Main 内部の配送契約（既定で無効）

- Host は `subscribeWindowsStop` で登録・退役・段階通知を配送する。`windowsKillStopTermination` と台帳が両方有効な場合だけ口を公開し、IPC・Renderer・公開の StopReason は変更しない。購読を native 呼出しの前に置き、client は送信前に owner を登録する。登録通知で受信先を owner に結び付けるため、送信中の同期 exit も同じ登録に届く。
- owner は `(helperGeneration, kind, id, lifetimeId)` で照合する。`lifetimeId` は Host が発行する。現在の client では native の開始待ちから session まで同じ session owner を使い、開始前の discovery は独立の discovery owner、picker は呼出しごとの owner とする。後から同じ id が使われても、古い世代・lifetime の通知で新しい登録を更新しない。
- Stop の進行中は世代につき1件ではなく owner の集合で保持する。核に渡す `entry` は残っている停止 owner の先頭から投影し、`initiatorReason` はその世代に停止 owner が残っている場合だけ `requested_reason` になる。B の stopping を A の存在で捨てない。検証済み session receipt は対象 session の owner だけを解く。E4 の正常な completion・receipt・ローカルの `not_submitted` はその discovery の lifetime だけを解く。kill 開始後は receipt で解かず exit を待つ。
- 各 owner の段階は `termination_pending` → `exit_confirmed` → `cleanup_completed` の順とし、それぞれ一度だけ配送する。期限内の exit は pending を経由しない。R19c は exit の確認を先に配送し、保存成功と Host/client の後始末の後に cleanup を配送する。保存再試行で exit を再発行しない。未解決 owner は件数上限で追い出さず、正常終端または cleanup まで保持する。
- R8 は停止を要求した owner の元の理由を受信口に保持する。pending の公開理由は `native_unavailable`、exit 確認以降は保持した理由を使う。R11 は公開理由 `native_unavailable` と内部理由 `crash` / `abortTransport`、R12 の巻き込まれた owner は公開理由 `native_unavailable` と内部理由 `shared_helper_stop` を別々に持つ。B 自身も停止中なら B の元の理由を保持する。遅い exit の `late` と clean / suspect は理由と別に配送する。
- R13 の遅い receipt・応答、二重 exit は通知の根拠にしない。受信口も owner 照合と段階の重複・逆行を拒否する。購読解除で受信記録を解放する。返却済み Promise・session・ticket を復活させない。
- Controller 側は `subscribeComputerUseWindowsStops` という明示的に購読する最小の受信口と試験のみを用意する。製品の Controller はまだこれを呼ばない。§3.1 の token・承認失効、artifact 破棄、表示への接続は §4.1 の PR10、session の無い E4 の最終配送先は PR11 に残す。

## 3. 変更

### 3.1 Main

1. Stop の手順を「cancel（ack の期限 1 秒）→ close（期限 C）→ 期限内に receipt が無ければ helper を終了 → signaled を待つ（期限 T）→ §2.2 の判定」にする。**C は、実測するまで今の 10 秒（1 回目の close の期限）のままにする。** 健全だが忙しい helper を誤って終了させると、確定できたはずの入力が「効果不明」になり、他のセッションも止まり（§2.5）、再起動では Electron の main thread で同期の PowerShell の署名確認（`execFileSync`、最大 10 秒）が走る。#820 の記録では、UIA 呼出し 1 回の最悪が 800 ms、素の `ElementFromHandle` が 1028 ms だった。S1 で、負荷とキューのある健全な helper の close の所要時間を測り、その分布から C を決める。T は 2 秒とする。期限全体の起点はその入口の Stop の開始とし、E1 / E2 は最大 1 秒（cancel）+ C + T、E3 / E4 は最大 C + T で結果を返す。T は終了要求後の exit 待ちに割り当て、期限内に exit が来なければ停止確定ではなく `termination_requested` を返す（§2.6）。
   - Stop の入口は 4 つある。以下の括弧内の再送は現行経路の説明であり、N3 では次項に従って廃止する。開始済みのセッションの close（Controller の `completeStop` → Host の `close`）、native がある開始待ちのセッション（Controller が cancel と close の再送を自分で行う）、native が無い開始待ちのセッション（Controller が `starting.native === null` かつ `nativeStarted` のとき Host の `stopPendingStart` を呼ぶ。Host は `stopStartOwner` → `completePendingStop` → `completeNativePendingStop` と進み、`stopWithDeadline('stopPendingStart')` を `COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT` 回まで再送する）。helper が `start_session` の中で固まった場合（S1 が挙げる WinVerifyTrust や process / exe の open）は 3 つ目の経路で、最初の `stopPendingStart` の期限 C の切れを終了の契機とし、Stop 開始から C + T 以内に §2.2 の判定へ進む。4 つ目は、セッションに属さない discovery の Stop である（候補一覧の取消し、Task の切替え・終了、grant の取消しなど。Controller の `beginWindowCandidates` や `stopDiscoveriesWhere` → `ComputerUseDiscoveryScope.stop` → discovery handle の `stop()` → discovery manager の `completeStop`（`attemptLimit` 回まで再送）→ Host の manager から `invoke('stopWindowDiscovery')` で addon を呼ぶ経路）。この入口の期限切れ・失敗も、同じ世代の終了と §2.2 の判定・§2.5 の後始末へつなぐ。この入口も C = 10 秒を使い、別の期限は作らない。Stop の開始から C + T 以内に結果を返す。
   - Windows では Controller の 2 回目の close、Host の pending-stop の再送（`completeNativePendingStop`、失敗後の `stopPromise` の再取得を含む）、discovery manager の再送、discovery scope の `stop(retry=true)`、`startSession` の catch での再確認を廃止し、同じ終端処理へ寄せる。例外は close の `semantic_input_in_flight` に対する C 内の 50 ms ごとの再試行だけとする。C の後は再送しない。discovery manager の `attemptLimit` と transport の close の期限（今は再送を見込んで 10 秒 × 3）も、Windows では同じ C の期限と終端処理に合わせる。macOS は今のまま。
   - 終了を起こすのは Host の Stop の入口（`close`、`stopPendingStart`、セッションに属さない discovery の Stop）で、契機は、期限 C の切れと、Stop の入口が期限 C より前に検証済みの receipt を得られずに失敗したとき（close の `semantic_input_in_flight` を除く helper の error 応答、receipt の parse・identity（sessionId / discoveryId を含む）・epoch・count の検証の失敗、discovery の停止の失敗、`confirmSessionClosed` の失敗のどれでも）とする。今のコードでの例は、Host の `close` での receipt の parse か `inputReceipt` の検証の失敗、`discoveryUnconfirmed` か discovery の停止の失敗、`confirmSessionClosed` の proof の不一致、`completeNativePendingStop` での receipt の parse の失敗や epoch・count の後退、`completePendingStop` での discovery の停止の失敗、discovery manager の `completeStop` での receipt の parse か `discoveryId` の不一致である。この例外以外で失敗したときは再送せず、すぐに helper を終了して §2.2 の判定へ進む（§2.2 の (c)）。今は、検証の失敗の多くで終了の契機が無い（parse の失敗などでは close の応答の後の idle teardown が偶然 helper を終了させ、semantic の proof の不一致や discovery の停止の失敗では helper が残る）。§2.2 の (b) はその idle teardown も止める。child の終了と `exit` の観測は addon の client が受け持つ。Controller は終了を起こさず、Stop の結果として §2.2 の状態を受け取る。今の Host の `close` は `Promise<void>` を返すので、`close` と `stopPendingStart` が §2.2 の状態を返すように型を変える。
   - Controller の扱い: `terminated_clean` と `terminated_target_suspect` は Stop の確定として `nativeAcknowledged` を真にし（固まった helper では cancel の ack が先に失敗するが、その失敗は終了による確定で上書きする。開始待ちの経路も同じ）、停止理由は要求された理由のままにする。今のように `native_unavailable` に置き換えない。`terminated_target_suspect` の UI は「停止した。最後の操作が対象に後から反映される可能性がある。そのアプリは、終了するか再開を承認するまで操作しない」とする。`termination_requested` は今と同じ `native_unavailable` とし、UI は §2.2 の文言にする。R8・R11 の核の通知型は §2.6 に定義する。配送・owner 照合は PR7c-2、E4 のセッションが無い場合の最終配送先は PR11 で決めて本 ADR に書き戻す。終了で確定した場合の `stop_acknowledged` の capture には、receipt の代わりに終了の種別を記録する。
   - discovery の結果は `ComputerUseDiscoveryStop`、scope の `stop`、Controller の `stopDiscoveriesWhere`、通知まで通す。`terminated_clean` / `terminated_target_suspect` は停止成功、`termination_requested` は `native_stop_unconfirmed` とする。
   - kill を始めた後に正常な receipt が届いても終了処理は取り消さず、結果を確定する証拠は exit の確認を優先する。exit 確認前に Host が receipt を検証したときに限り通常の台帳行を効果確定として消す（K-3 の背景行は隔離へ移管する）。exit 確認後の遅着は R13 に従い、行・分類・対象の隔離・旧 session・ticket を変えない。clean / suspect は exit の時点の台帳で決め、旧 ticket や session を復活させない。
   - C の上限は 10 秒とする。Host の `stopWithDeadline` と discovery manager は 10 秒を超える期限を拒否するので、S1 の実測で 10 秒を超える C が要るなら、N3 でこの 2 つの上限も変える。
2. 終了で確定したセッションは、その helper に結び付く token（target / app / session / artifact）と承認 ticket をすべて失効させる。Main の token と session id は `randomUUID` で発行されるが、それだけでは古い token は失効しない。Windows の client には `helperGeneration` があるが、host と controller はそれを token の失効に使っていない。**これを広げて、host・controller の token と ticket を世代に束縛する**（親 ADR §10 は既存の契約のように書いているが、helper 終了に連動した失効の実装は無い）。helper 終了後の再開の承認カードの ticket は、新しい世代で新規に発行する（§2.2 の 4）。receipt で Stop した後の新しいセッションは K-5 の例外に従う。
3. 新しい helper の最初の操作は `list_targets` か再観測にする。例外は、§2.2 の 3 の対象の終了の照合だけである。終了の後の最初の観測は、短い待ち（settle。具体的な時間は未決で、PR7 で実測して決める）の後に行う（§3.3 の、job で止められない起動の窓が開きうるため）。
4. 未確認の入力は「未確認のまま終わった」と記録し、再送しない。モデルには「最後の操作は後から反映されるかもしれない。画面を見直す」と返す。
5. **終了を確認した世代の隔離とブロックの解除は、すべての元に対して行う。** どれか 1 つでも残ると、終了の後も永久に隔離されるか、teardown や開始が止まる。
   - Host: `activeStopQuarantines`、`discoveryManager.quarantined()`、`startOwners`（`attempts` / `terminal === null` / `unconfirmed` / `discoveryUnconfirmed`）。
   - Host の session 表（`sessions`、`classifierBindings`、`inputAttemptsBySession`、`stopEpochs`、`revisionsBySession`）は、検証済みの close と同じく終了確定として片付け、`confirmedClosed` に登録する。登録しないと、後の Stop の close が `sessions` にも `confirmedClosed` にも無いとして `native_stop_unconfirmed` を投げる。
   - client: semantic owner（`ensureConnected` はこれが未確認の間 helper を起動しない）、`discoveries`、`starts`。`starts` は今は helper の世代を持たず、close receipt を受けるか未送信のまま止まらない限り残る。残った `everSent && !closed` は `shutdownWhenIdle` で新しい世代の idle teardown を止め、16 件で新しい開始も拒否させる。`starts` に世代を持たせ、終了した世代の分を破棄する。
   - client の semantic owner を単に解除するのは、`terminated_target_suspect` に当たらない世代に限る。suspect の世代では、`activeStopQuarantines` と semantic owner を、台帳の行の identity で §2.2 の対象の隔離へ移してから解除する。identity を持たない元（`discoveries`、`discoveryManager.quarantined()`、`startOwners`）は §2.2 の 2 のとおり終了の確認で解除する。`termination_requested` では何も解除しない。
6. **終了中の child を世代ごとに保持する。** 今は `abortTransport` が `this.child = null` にするため、exit listener が `this.child !== child` で早く return し、Main は自分の kill の終了を観測できない。crash のときも exit listener は `failAll` するだけである。また `ensureConnected()` は socket が null で未確認の semantic owner が無く、接続中でもなければ `connect()` で新しい helper を起動するので、古いセッションへの close の再送が新しい helper に届き `session_missing` になりうる。終了中の child が `exit` するまで、`pickApplication` を含むすべての操作を止める。古いセッションの Stop を新しい世代へ送らない。世代の終了は原因を問わず（Stop、crash、要求の timeout・binding の不一致・不正な応答・write の失敗による `abortTransport`）、§2.2 の判定と §2.5 の後始末を通す。`abortTransport` のすべての経路で、終了中の child を保持する。
7. Main の終了時の helper は、新しい作業を要しない。helper は `detached` なしで spawn されるので（`connect()` の `spawn`）、libuv の global job に入る（§3.3。2026-11-02 の N4-0 実測で、Electron 43.5.0 の spawn の子の所属・LimitFlags 0x3C00・親の強制終了後の子の終了を確認済み）。この job は KILL_ON_JOB_CLOSE を持つので、Main が終わると、正常終了でも crash でも、helper は `TerminateProcess` と同じ形で強制終了される。helper の通常終了経路（parent watcher が Main の終了を検知した後の `DrainWindowsSemanticInputForExit` / `DrainWindowsDiscoveryLaunchesForExit`）は、この強制終了が先に来るので通らない。Main の終了は、S2 の終了と同じく効果未確認の終了であり、drain ではない。残るのは、カーネルの中で止まって終了できない helper だけである（§5 の 1）。

### 3.2 helper

- Stop の応答性のためだけにある仕組み（作業スレッドの枠、取消しの別名、cleanup 後の候補採用、`CancelSynchronousIo` の試行）は新しく足さない。既存のものは S4 で、入力の安全に要るものだけを残して整理する。
- 残すもの: 入力直前の再検証（identity、foreground、geometry、cancel epoch）、入力 unit の claim と attempt の記録、`semantic_input_in_flight`、§2.4。
- 健全な helper では今どおり receipt で確定する。ただし close は `ServePipe` の単一キューで処理される。reader は `stop_serial` と cancel epoch の更新に加え、開始・discovery の受付や停止 latch も行うが、close の応答は consumer が処理する。close は処理中の frame と、それより先に受け付けた待ち frame の後ろに並ぶ（待ちキュー全体の上限は 64 件）。discovery 待機中には別 owner の `stop_window_discovery` を先に処理する例外がある。
- helper の dispatch 結果の cache（`requestId` ごと、二重入力防止）は終了で失われる。これが安全なのは、その helper の上のセッションをすべて捨てるときだけである（§2.5）。

### 3.3 子プロセスと一時資源

- **検証済みの子は、helper の終了で殺さない**（親 ADR §10 #940 の「検証済みアプリの起動は巻き戻さない」と同じ）。 AI が起動したアプリをユーザーが使っていれば、未保存の作業が失われる。今の `LaunchVerifiedExecutable` も検証済みの子は残し、未検証の子だけを終了させている（`computer_use_windows_host.cc` の `OwnedChild`）。
- N4-1 より前の `LaunchVerifiedExecutable` は `CreateProcessW` を suspend せずに呼び、その後で image を検証していた（`computer_use_windows_host_discovery.inc` の `LaunchVerifiedExecutable`）。この間に helper が終了すると、未検証の（すり替えられたかもしれない）子が動いたまま残っていた。起動は `CREATE_SUSPENDED` と `PROC_THREAD_ATTRIBUTE_JOB_LIST` で、起動ごとの job に作成時点から入れる。image を検証した後で KILL_ON_JOB_CLOSE を外し（`SetInformationJobObject`）、`ResumeThread` する。helper が検証前に終了したら、一度も実行していない子だけが終わる。JOB_LIST を使うのは、検証前の子の後始末を作成の時点から確実にするためである。作成後に `AssignProcessToJobObject` すると、その間に helper が終了したとき、子は job に入らず、実行もされない suspend のまま残る。
  - 起動ごとの job は、作成時から `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`・`JOB_OBJECT_LIMIT_BREAKAWAY_OK`・`JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK` で作り、検証後は KILL_ON_JOB_CLOSE だけを外す。BREAKAWAY_OK が要るのは、プロセスは入った job から抜けられず、検証済みのアプリが `CREATE_BREAKAWAY_FROM_JOB` で子を作ると、BREAKAWAY_OK の無い job では `ERROR_ACCESS_DENIED` で失敗するためである。SILENT_BREAKAWAY_OK が要るのは、検証済みのアプリの子孫を helper の job に入れず、今の「job に入れない起動」と同じ挙動にするためである。最初から付けてよいのは、子が suspend 中で孫を作れないためである。
  - job の handle は子に継承させない（`CreateJobObjectW` の security attributes は NULL、`CreateProcessW` の `bInheritHandles` は FALSE）。子が job の handle を持つと、helper が終了しても job の最後の handle が閉じず、KILL_ON_JOB_CLOSE が効かないためである。
  - 終了の窓: KILL_ON_JOB_CLOSE を外した後、`ResumeThread` の前に helper が終了すると、検証済みの子は殺されないが実行もされず、suspend のまま残る（孤児）。逆の順序（resume してから外す）にすると、その間の終了で検証済みの子が殺され、上の「巻き戻さない」に反する。N4 は「外してから resume」の順とし、2 つの呼出しの間に他の処理を挟まない。それでも残る窓は §5 の 6 に書く。
- rename 追従の probe の子は、上と同じく作成時から JOB_LIST で job に入れるが、**resume しない**。probe の子は helper 自身の exe を TEMP にコピーしたもので（`WindowsTargetRenameFollows`）、image 名の追従を確かめるためだけに作る。N4-2 より前は `CREATE_SUSPENDED` の後に `AssignProcessToJobObject` し、resume せずに `TerminateProcess` してから、handle を閉じてコピーを消していた。N4-2 で JOB_LIST に変え、終了を確かめて handle を閉じてから消す。
- Node が helper を入れている libuv の job は、`JOB_OBJECT_LIMIT_BREAKAWAY_OK`・`JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK`・`JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION`・`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` を持ち、その handle は継承されない（libuv の `src/win/process.c` の `uv__init_global_job_handle`。`uv_spawn` は detached でない子を `CREATE_SUSPENDED` で作り、この job に入れてから resume する）。2026-11-02、Windows 11 10.0.26200 上で同梱の Electron 43.5.0（Node 24.19.0、ELECTRON_RUN_AS_NODE=1）の child_process.spawn から起動した子を実測した。IsProcessInJob(GetCurrentProcess(), NULL) は TRUE、QueryInformationJobObject(NULL, JobObjectExtendedLimitInformation) の LimitFlags は 0x3C00（KILL_ON_JOB_CLOSE 0x2000 | SILENT_BREAKAWAY_OK 0x1000 | BREAKAWAY_OK 0x0800 | DIE_ON_UNHANDLED_EXCEPTION 0x0400）だった。同じ shell から直接起動した比較対象の外側の job は 0x0 だった。親の Electron を taskkill /F で終了すると、1.5 秒後に子が存在しないことを確認した（N4-0 実測）。job のフラグと親終了時の子の終了は推定どおりであり、§5 の 11 への切替えは不要である。2026-11-02 の N4-1 の live 検証では、`LaunchVerifiedExecutable` と同じ起動方法の launcher を Electron 43.5.0（ELECTRON_RUN_AS_NODE=1）の child_process.spawn から起動した。Electron を taskkill /F で終了すると、1.5 秒後に helper 役の launcher は終了し、JOB_LIST で起動した検証済みの子は生き残った。S3 の試験欄 (3)（Main の終了後も検証済みの子が殺されないこと）は、この手動の実測で担保しており、自動の試験は無い。
- **job で止められない起動がある。** Windows 11 の notepad / calc はパッケージアプリに引き継ぐ。そのプロセスは DcomLaunch サービスによる activation で作られる（UWP の frame は ApplicationFrameHost が持つ）。Chrome や Electron などの single-instance のアプリは、既に動いているプロセスへ転送する。これらは Stop の確定の後にウィンドウを開き、フォーカスを取りうる。§3.1 の 3 の settle と、次の観測での通常の判定で受ける。残るリスクとして §5 に書く。
- job の終了も非同期なので、子が消えたことは `JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO`（または ActiveProcesses = 0）で確かめる。一時フォルダの削除は、probe の exe がまだ lock されている場合に備えて再試行する。
- 一時フォルダは helper ごとにする。N4-2 より前の probe は TEMP の直下に `sc-rename-probe-<helper の pid>-…` を作り、helper の中で消していた。helper が終了させられるとこの後始末は走らず、helper の exe のコピーが残っていた。helper の終了の後は、Main が `exit` を受けた後に、その helper の一時フォルダを再試行つきで消す（probe の子は helper の job の handle が閉じた時点で KILL_ON_JOB_CLOSE により終わるが、その終了も非同期なので再試行する）。

N4-2 の実装（2026-11-02）: `WindowsTargetRenameFollows` は、継承しない job に KILL_ON_JOB_CLOSE・BREAKAWAY_OK・SILENT_BREAKAWAY_OK を設定し、STARTUPINFOEXW と PROC_THREAD_ATTRIBUTE_JOB_LIST、CREATE_SUSPENDED・EXTENDED_STARTUPINFO_PRESENT・CREATE_NO_WINDOW で作成時から子を入れる。resume は行わない。`TerminateJobObject` の後、`QueryInformationJobObject(JobObjectBasicAccountingInformation)` の ActiveProcesses == 0 を最大 2 秒待ち、確認後に process/thread/job の handle を閉じ、ファイルを最大 20 回・50 ms 間隔で削除する。期限内に終了を確認できなければ probe の結果は未測定とする。Main が渡した有効な一時フォルダなら削除を Main の helper 終了後の処理に委ねる。環境変数が無いか無効で GetTempPathW に戻った場合は Main の削除対象外なので、handle を閉じた後、期限切れでも同じ再試行でファイル削除を試みる。未測定の probe を含む context も cache されるため、一度の終了確認の遅延で running image の一致判定は helper が再起動するまで劣化したままになる。cache の変更は複数の保存経路にまたがるため、N4-2 ではこの制限を残す。

一時フォルダは、環境変数 `SPRINT_CODER_COMPUTER_USE_HELPER_TEMP` が絶対パスかつ存在するディレクトリならその場所を使い、それ以外は従来の `GetTempPathW` に戻る。Main は spawn 前に `os.tmpdir()` の下へ `mkdtemp`（接頭辞 `sc-cu-helper-`）で helper ごとのフォルダを作り、`windowsHelperEnvironment(process.env)` にこの変数だけを追加する。TEMP / TMP と `CurrentWindowsTargetRoots` の temp root は変えない。Main は `exit` の世代 guard より前で `fs.rm`（recursive・force、maxRetries: 20、retryDelay: 50）を非同期に呼ぶため、古い helper の終了でも削除する。spawn の同期例外と、PID を持たず exit を出さない非同期の spawn error でも同じ削除を行う。PID の無い spawn の失敗は exit を出さないため `child.once('error')` を追加し、PID がある error では削除せず exit を待つ（この listener は error を外へ再送出しない）。attestation 失敗と pipe 接続失敗では kill 後の exit を受けてから削除する。

## 4. スライス（PR の単位）

| #（#988 のノード） | 内容 | 依存 | 試験 |
| --- | --- | --- | --- |
| S1（N2） | 応答しない helper の試験装置。テスト用の build flag で、指定した要求の中で永久に待つ（UIA 呼出し、`CreateFileW`、capture、WinVerifyTrust の各所）。Main の Stop がどこで止まるかを固定する | この ADR 内ではなし | CI の Windows live seam。cancel と close 2 回が期限切れになると Host の `native_stop_unconfirmed` を受け、Controller が約 21 秒の native 待機（start owner に処理中の discovery が無い場合）の後に `native_unavailable` とすることを固定する。transport は §1 の条件下で最初の close から約 40 秒で kill し、未確認の semantic 入力や discovery がある場合は kill しないことも固定する。あわせて、健全で忙しい helper の close の所要時間を、負荷とキューのある状態で測る。（注記: live で固定した範囲は sessionless の Stop の 4 件と close の所要時間の proxy（参考値）。session の場面と close_session の実測は N13b へ持ち越し。詳しくは `tasks/evidence/issue-1002-n2-stop-baseline.md`） |
| S2（N3） | §2.2〜§2.6・§3.1 の kill-stop、台帳・対象隔離、世代後始末と K-1〜K-5。保存先は B を採用。詳細は §4.1 の PR1〜PR11 | S1（N2）・S3（N4）。PR4 は N15 の Q23 の決定後 | E1〜E4 と R0〜R24（R1a・R19a〜R19c を含む）。E1 / E2 は Stop 開始から最大 1 + C + T、E3 / E4 は最大 C + T で結果を返す。exit 未確認は停止確定でなく termination_requested。全停止点、送信前保存の失敗、保存費用、復元・移管失敗、不正行診断、Main 再起動、receipt の検証順序、背景例外、承認カード・再観測を §4.1 の各 PR で検証する |
| S3（N4） | helper: §3.3 に従い、起動ごとの job（作成時から KILL_ON_JOB_CLOSE・BREAKAWAY_OK・SILENT_BREAKAWAY_OK、handle は継承させない）に `CREATE_SUSPENDED` と `PROC_THREAD_ATTRIBUTE_JOB_LIST` で子を作成時点から入れる。検証後に KILL_ON_JOB_CLOSE だけを外して resume する。probe も作成時から job に入れ、resume せずに終了を確認する。一時フォルダを helper ごとにする。着手時に、§3.3 の libuv の job のフラグ（強い推定）を、同梱の Electron の libuv の実装か実機で確かめ、結果をこの ADR に追記する | この ADR 内ではなし（S2 より前） | launch の検証前に helper が終了しても未検証の子が残らず、検証済みの子は巻き戻されないこと。検証済みの子が `CREATE_BREAKAWAY_FROM_JOB` で子を作れること。helper の子が libuv の job に入らないこと（Main を終了しても、検証済みの子が殺されないこと） |
| S4（N5） | helper: Stop のためだけの仕組みの整理（#940 の残り、#820 の残件のコード側を扱う）。§2.4 のサロゲートペアを 1 回の `SendInput` にまとめる。親 ADR §10 リスク 10 と「#820」の、Stop のためだけの仕組み（worker、slot、alias など）の説明を、整理後の実装に合わせて同じ PR で更新する | S2（N3）・S3（N4） | 既存の native seam の入力安全の試験が全部通ること。停止応答用の worker を除いた後も、応答しない helper の Stop が §3.1 の 1 の経路で終了へ届き、E1 / E2 は Stop 開始から 1 + C + T、E3 / E4 は C + T 以内に結果を返すこと（exit 未確認は `termination_requested`） |

この表は kill-stop 内の依存を示す。S1（N2）・S3（N4）は並行でき、S2（N3）は両方の後、S4（N5）は S2 の後に置く。S2 が helper の終了を通常の Stop にする前に、未検証の子が残らないよう起動を suspend と job で守る必要があるため、S3（N4）を S2（N3）より先に入れる。

### 4.1 S2（N3）の PR 分割

各 PR の追加＋削除は 1,499 行以下とし、目安は 700〜1,200 行とする。規模は設計上の予算であり、実測値ではない。N3-0 は本 ADR の文書整備であり、次の実装 PR の完了を意味しない。

| 順序 | PR の内容 | 主な試験・受入 |
|---|---|---|
| PR1 | N3-0 の状態表・決定を前提とする結果型と世代イベントの契約 | 型チェック、結果型の網羅。E1–E4 と R0〜R24（R1a・R19a〜R19c を含む）の対応を確定 |
| PR2 | C++ 開始応答への作成時刻追加。新規開始・既存開始の両経路、Main での保持 | native start seam、応答の型検証、AI・Renderer へ漏れないこと |
| PR3 | C++ 対象 identity 照合命令 | signaled、PID 再利用、PID 不在、アクセス拒否。同一 PID だけで解除しない |
| PR4 | N15 の Q23 のオーナー決定を前提とする、決定した保存先の台帳・隔離ストア、起動復元 | 永続往復、読書き失敗、不正行、identity 欠損、Main 再起動相当 |
| PR5 | 全 dispatch の beforeWrite 台帳と応答処理、台帳の inputPath 列と前面化の種類・寿命 | 保存失敗なら未送信、timeout／failAll 後も残存、accepted=false は削除、SendInput／paste、R19a |
| PR5b | 採用（2026-11-03 オーナー決定）、有効化は PR10 と同時（§6.1 の 16）。K-4 の開始の2段化（§2.2.1 の C）。native は `computer_use_windows_host_discovery.inc` の V1 窓列挙、`computer_use_windows_host_v2_targets.inc` の WindowsV2SelectableRow・WindowsStartInput・新規／既存開始、`computer_use_windows_host_session.inc` の ParseWindowsStartParameters・StartWindowsSession を変更。TS は `computer-use-native-host.ts` の discovery の内部保持・start、`computer-use-native-windows.ts` の call・beforeWrite・応答処理、`computer-use-native-types.ts` と関連する内部応答 parser を接続する。共有 schema の変更は packages/contracts を正本に利用先を追跡する。MessageType は追加せず、handshake の capabilities を出す `computer_use_windows_host_preflight.inc` の ProbeJson と、それを読む `computer-use-native-windows.ts` の parser の対応能力の契約を整合させる。Host options の内部 policy を正本に client へ渡し、既定は無効（Renderer 設定・環境変数に公開しない）。有効時に保存関数・対応 helper が無ければ拒否し、旧経路へ fallback しない。規模は試験込み追加＋削除 900〜1,200 行を目安とし、内訳は native 契約・試験 500〜650 行、TS 接続・試験 400〜550 行と見積もる。上限は 1,499 行とし、超える見込みなら native 契約と TS 接続を分割し、接続完了まで無効を維持 | PR5b-AC1: V1 / V2 × 新規／既存開始で、取得・照合 → 保存完了 → start 送信 → 前面化の順を証明。PR5b-AC2: identity 欠損、PID 再利用、窓交代、アクセス拒否、保存失敗、保存中の Stop／世代交代で前面化ゼロ。未送信取消し・消去失敗の保留も試験。PR5b-AC3: 前面化後の開始失敗、期待 identity と食い違う応答、応答消失を未実行扱いにせず、session が作られなかった場合も含め、R23 の保持・pause・receipt／exit／起動時の消去と隔離除外を確認。PR5b-AC4: 既定無効の V1 / V2 の既存期待を維持し、有効時の未対応 helper 拒否、identity の AI／Renderer 非露出を確認。新規／既存 start component・native seam、target identity component、Host・transport の fake store 結合試験、対象 typecheck と関連 Vitest を実施。Windows の実前面化は Computer Use で別途確認し、未実施は NOT_RUN / BLOCKED。実ストアの結合と PR6 の寿命処理に加え、Host からの `requireStartIdentity`・`includeStartIdentity` の配線と送信前の記録（PR5b-3）、新規開始の隔離の照合（PR8）が揃うまで製品経路で有効化しない |
| PR6 | receipt proof の全 session 化、idle teardown の順序 | R1–R3、偽 object、別世代、検証前終了防止、K-3 の背景行の原子的な隔離への移管、K-4 の除外、R19b |
| PR7 | child の世代別保持、exit 分類、Host/client の全 owner 後始末 | kill 戻り値・pipe 切断は確定にしない、T 超過、遅い exit、crash、二重通知、R19c と R1a（有効化は PR10・PR11）。R8・R11 の通知先・理由値と settle の時間を決めて ADR に書き戻す |
| PR8 | 対象隔離による start/resume/discovery 拒否、世代 token 失効 | 同対象拒否・他対象許可、古い ticket 不可、最初の照合と再観測 |
| PR9 | 承認カード再開、K-1〜K-5、N9 が呼ぶ K-1 の隔離の入口 | 終了後の新世代／receipt で Stop 後の同世代での新しいセッション（K-5）、背景 receipt 例外、前面化除外、承認後再観測 |
| PR10 | E1 / E2 と、その Stop による共有 helper の終了（R12）、Stop の外の終了（R11）、遅着（R13）の kill-stop 有効化、transport の close 期限と stopWithDeadline の上限の調整（§3.1 の 1）、Controller 結果・UI・capture・全セッション後始末 | fake timer で最大1＋C＋T、cancel 失敗の上書き、B の通知、artifact 破棄 |
| PR11 | E3 / E4 と、それらが起点の共有 helper の終了（R12）の有効化、全再送経路の廃止、transport と stopWithDeadline・discovery manager の上限の調整を含む期限統一（§3.1 の 1） | 最大C＋T、開始 catch の再確認なし、Scope/manager 再送なし、discovery 結果伝達。E4 で session が無い通知先・理由値を決めて ADR に書き戻す |

表の順序で安全の前提を積み上げる。**中間の PR で、helper の隔離は消したが対象の隔離はまだ無い、という状態を作らない。新しい kill-stop の有効化は最後の PR10・PR11 とする。PR7 の共通の終了処理は PR8・PR9 が揃うまで内部でも有効化しない。** PR4 は保存先のオーナー判断（N15 の Q23）が前提である。PR5b は §6.1 の 16 の採用決定に従い、PR10 と同時に有効化する。

PR7〜PR9 の新しい処理は既定で無効（内部の切り替え）とする。E1 / E2 と、その Stop による共有 helper の終了（R12）、Stop の外の終了（R11）、遅着（R13）の有効化は PR10 とする。E3 / E4 と、それらが起点の R12 は PR11 で有効化する。PR10 の後 PR11 の前の E3 / E4 は今の挙動のままにする。Controller 側の後始末（承認の失効・artifact の破棄・B への通知）は PR10 で一緒に有効化し、PR7 だけで有効にしない。PR8 の対象の隔離による拒否と PR9 の承認カードでの再開は、PR10 で E1 / E2 と一緒に有効化する。対象の隔離は kill-stop の結果と K-1 からしか生まれないためである。K-1〜K-5 の実行中の隔離の入口は PR9 で作り、有効になるのは N9 が背景入力を公開するときとする。N9 は N3 の後であり、それまでは background_semantic の行は生まれない。PR5b の有効化は PR10 と同時とする（2026-11-03 オーナー決定）。N9 の公開条件への明記は別途整理する。前面化の行は終了時の clean / suspect の判定と起動時の対象の隔離への移行から外れるため、PR5b が無効でも kill-stop の隔離の判定は変わらず、失われるのは開始の前面化の結果が未確認のときの pause だけである。

各実装 PR は対象 typecheck と関連 Vitest、C++ 変更では native seam を行う。最終受入は N2 の装置の全停止点、保存費用、Main 再起動、承認カードを含む。UI 操作は Computer Use で確認し、未実施の session 必須 live は NOT_RUN / BLOCKED のまま扱う。S4（N5）の worker 整理・サロゲートペア変更、一時フォルダの起動時掃除（§5 の 13）は N3 に混ぜない。

## 5. 残るリスク

1. `termination_requested` のまま signaled にならない環境（壊れたドライバ）では、終了を確認できるまで隔離を保ち、新しい helper は起動しない。Main を終了すると、libuv の job が helper を強制終了しようとするが（§3.1 の 7）、カーネルの中で止まって終了できない helper はそれでも残る。このため再起動は古い helper の終了の証拠にはしないが、対象ごとの隔離へ移す根拠にはする（§2.2）。頻度は実機で測る。
2. 終了の前に発行された UIA pattern の呼出しと、積まれた `SendInput` は、Stop の確定の後に対象で実行されうる。終了で確定する経路で対象の隔離（`terminated_target_suspect`）で受けるのは、応答が無いか効果未確認の要求だけである。completed で返った `SendInput`・`Invoke` が対象のキューに残る分は受けない（今と同じ）。前面経路の receipt で確定する経路（UIA の client timeout の後、§2.1）では対象の隔離が無く、provider 側に残った呼出しが後で実行されうる（今と同じ）。背景経路は K-1〜K-3 の対象隔離を保つが、completed の Invoke 後の非同期の効果は隔離されない。K-4 の前面化の未確認行は対象隔離を作らず、遅れて前面化が効くと人のキー入力が対象へ届きうる。対象が固まったままユーザーが自分で操作すると、遅れて実行された入力と混ざりうる（今も同じ）。
3. helper の再起動のたびに、署名検証や context の初期化のコストがかかる（初回の `list_targets` が数秒）。Stop が頻繁なら体感が落ちる。
4. macOS には適用しない。macOS の Stop は今の serial lock の方式のまま。両 OS の Stop の確定の仕組みが異なることを、受入の記録に明記する。
5. job で止められない起動（パッケージアプリへの引継ぎ、single-instance への転送）は、Stop の確定の後にウィンドウを開き、フォーカスを取りうる。
6. 検証済みの子の KILL_ON_JOB_CLOSE を外してから `ResumeThread` するまでの間に helper が終了すると、その子は実行されない suspend のまま残る（§3.3）。窓は 2 つの呼出しの間だけで、子は一度も実行していないので入力の安全には関わらないが、ユーザーには起動しなかったように見え、プロセスと exe の lock が残る。
7. v2 の grant は SQLite に永続する（installation-wide・無期限）ので、台帳と対象の隔離を Main のメモリだけに持つと、crash・終了・`termination_requested` のままの再起動の後に承認カード無しで同じ対象に開始できてしまう。このため台帳の行と対象の隔離を永続化し、起動後の最初の helper と新しい世代の開始時の照合か、承認カードでだけ解除する（§2.2 の 5）。残るのは、照合できない対象（アクセス拒否など）の隔離が、承認カードで再開するまで再起動をまたいで続くことと、照合が済むまで永続化された対象へ開始できないことである。
8. control 要求（dispatch）のたびに、送信の前に永続ストア（N15 の Q23 待ち）へ 1 回書き、応答で 1 回消す（または書き換える）費用がかかる。書けなければ送らないので、DB の不調は Computer Use の入力の停止として現れる。書込みの後、送信の前に Main が crash すると、送っていない要求の行が残って対象を過剰に隔離する（安全側で、照合か承認カードで解除できる）。費用は S2 で測る。
9. 対象の隔離と台帳の行を永続ストアから消すと、D-2 に無い解除の経路になる。grant の MAC（T14）の方式は、行が本物であることを示すが、行が消されたことは検出できない。この ADR は、ローカルの DB を書き換えられる攻撃者による削除を対象外とする。T14 が守るのは grant を偽って権限を広げることで、隔離の行を消しても、ユーザーが既に与えた grant の範囲を超える権限は得られず、残るのは遅れて実行される入力が混ざるという事故の側のリスクだけだからである。同じ理由で、行の形式の変更・不整合による破損で読めなくなった行や identity の無い行も、破棄して診断ログに残し（§2.2 の 5）、その対象の隔離は失われるものとして受け入れる。
10. `SendInput` の効果未確認（送った後の再検証の失敗）では、入力がセッションの対象以外のプロセス（その時点の前面やカーソルの下のプロセス）に届いた可能性がある。対象の隔離はセッションの対象だけを守り、そのプロセスは隔離しない（今と同じ）。
11. 2026-11-02 の N4-0 実測では、Electron 43.5.0 の libuv の job は KILL_ON_JOB_CLOSE を持ち、親の終了後に子が終了した（§3.3）。現在の採用経路では、kill の前の crash の記録漏れ（N-W1）のための代替策を追加しない。将来 job の前提を外すなら再設計する。`termination_requested` の世代だけを記録する案では、kill の前に Main が crash する世代を守れず、そのまま採用できない。
12. 将来の再設計では、kill の前に Main が終了しうる生きた世代の記録範囲、helper の終了の照合主体、host 全体の隔離中の起動条件を併せて決める。§2.2 の再起動時の新しい helper の起動は §3.3 の libuv の job の前提に依存する。現在の N3 では新しい照合経路・起動例外を追加せず、将来この前提を外すときに本 ADR も改訂する。

13. N4-2: Main が helper の exit を受けずに終わる場合（crash に限らず、helper が生きたままの通常の終了を含む。§3.1 の 7 のとおり helper は job で終わる）、そのたびに `sc-cu-helper-*` のフォルダが残る。probe の削除が済んでいれば中身は空で、途中なら exe のコピーも残りうる。削除の再試行を使い切った場合も残りうる。起動時に残存フォルダを掃除する処理は N4 の範囲外とし、N3 の必須受入から外し、後のスライスで扱う。環境変数が無いか無効で GetTempPathW を使う呼出しは Main の削除対象外なので、終了確認の期限切れでも helper がファイル削除を試みるが、削除の成功は保証しない。終了確認の遅延で未測定になった probe も context に cache されるため、running image の一致判定は helper が再起動するまで劣化したままになる。

14. 共有ストアの隔離の確認と start_session の送信は原子的ではなく、最後の await の後・socket.write の直前の同期ゲートで競合の窓を狭めるだけである。

## 6. オーナーの判断（2026-11-02）

#988 のオーナー判断 D-1〜D-5 は、推奨どおりに確定した。

1. **D-1: 認める。** Main が保持する helper の process handle の signaled（Node の `exit`）を、Stop の確定の証拠として認める（§2.2）。
2. **D-2: この扱いで確定。** 応答の無い control 要求が残った対象は、その対象（pid + 作成時刻）だけ隔離を保つ。対象の終了か、ユーザーが承認カードで明示した再開で解除する（§2.2 の `terminated_target_suspect`）。
3. **D-3: 進める。** Stop だけのための仕組みの整理 S4（N5）まで進め、入力の安全に要る仕組みを残す（§3.2・§4）。
4. **D-4: 条件つきで置き換える。** 親 ADR の次の 4 箇所を、§2.2〜§2.3 の条件（helper の終了を確認して Stop を確定し、応答の無い control 要求の対象だけ隔離を保つ）で置き換える。thread 単体の強制終了、別 helper の応答や偽の object を停止の証拠にすることは認めない。
   - §10 リスク 10（#940）: 「thread の強制終了と helper の自動再起動は行わない」
   - §10 リスク 10（#940）: 「別helperへの再接続で元操作の停止を証明しない」（別 helper や偽の object の応答による隔離解除も認めない）
   - §10「#820: UIA 読取りの停止境界」: 「強制終了は停止の証明にしない」
   - §8「維持する不変条件と、触ってはいけない箇所」: 未確認 stop の fail-closed 隔離（#484）の「変更禁止」
5. **D-5: 受け入れる。** helper が固まったときは、同じ helper の上の他のセッションも止まる（§2.5）。

補足: D-2 の「応答の無い control 要求」を、§2.2 では「応答が無い、または応答が効果未確認の control 要求」に広げた。D-2 の目的（claim 済みかもしれない入力の対象を再開させない）を実装するには、helper が in-flight や未確認を明示して返した要求も含める必要があるためである。D-4 の 2 つ目の項目（「別helperへの再接続で元操作の停止を証明しない」）が置き換えるのは、その段落の「元操作の停止を証明できない間は隔離を解かない」部分で、親 ADR の注に引用した 2 つの文（「未確認ならHost-wide隔離を維持する」「query/Stopの期限切れで元helperを捨てず、同じ世代へ後の有界Stopを許す」）に当たる。元の helper の終了を確認した後は、効果未確認の要求が無ければ解除し、残るなら対象の隔離へ移す（§2.2、§3.1 の 5）。別の helper への再接続や、別の helper・偽の object の応答で停止を証明しない点は維持する。


### 6.1 親の決定（2026-11-02、N3 着手前）

以下は D-1〜D-5 の範囲で確定した実装条件であり、実装済みを示さない。16 の開始の 2 段化は案 C を採用（2026-11-03 オーナー決定）、有効化は PR10 と同時とする。

1. E4 の Stop の期限も C = 10 秒とし、結果が得られなければ C + T で結果を返す。別の期限を作らない（§2.6、§3.1 の 1）。
2. T = 2 秒。全体の期限の起点はその入口の Stop の開始。E1 / E2 は最大 1 秒（cancel）+ C + T、E3 / E4 は最大 C + T。exit が来なければ停止確定でなく `termination_requested`（§2.6）。
3. discovery の `terminated_clean` / `terminated_target_suspect` は停止成功、`termination_requested` は `native_stop_unconfirmed` とし、型・scope・Controller・通知まで通す（§3.1 の 1）。
4. Controller の 2 回目の close、Host の pending-stop、discovery manager、discovery scope、start の catch の再確認を廃止し、同じ終端処理へ寄せる（§3.1 の 1）。
5. receipt の parse の失敗、identity / epoch / count / proof の不一致、discovery の失敗を同じ終端処理へ入れる（§2.2 の (c)、§3.1 の 1）。
6. close が `semantic_input_in_flight` を返した場合だけ C 内で 50 ms ごとに再試行し、期限を延長しない。それ以外の失敗は即時に終端処理へ入る。「C を待つ」は応答待ちとこの例外に適用する（§2.5、§3.1 の 1）。
7. kill 開始後の正常 receipt で終了処理を取り消さず、結果の確定は exit を優先する。exit 確認前に Host が検証した receipt でのみ通常行を効果確定として消す。exit 確認後の遅着は R13 に従う。K-3 の背景行は隔離へ移管する。clean / suspect は exit 時点の台帳で決める（§3.1 の 1）。
8. R8・R11 の核の通知型と理由の扱いは PR7c-1 で §2.6 に確定。配送・owner 照合は PR7c-2、E4 の session が無い場合の最終配送先は PR11 で決め、本 ADR に書き戻す（§4.1）。
9. settle の具体的な時間は未決。PR7 で実測して決めるまでは「短い待ち」とする（§3.1 の 3）。
10. N-W1 は、現在の libuv の job の採用経路では代替策を足さない。将来その前提を外すときに再設計する（§5 の 11・12）。
11. 一時フォルダの起動時掃除は N3 の必須受入から外し、後のスライスへ回す（§5 の 13）。
12. K-1〜K-5 は Accepted の N9a の ADR §2.5 を正本とし、§2.2・§2.3 の例外に統合する。K-2 は欠番ではない。K-5 は receipt で Stop した後の新しいセッションの開始であり、同じセッションの再開ではない。N9 は N3 でこれらの実装・試験が揃うまで背景入力を公開しない。
13. 保存先は B を採用（2026-11-03 オーナー決定）。§2.2 の 5 の契約に従う。
14. K-4 の前面化の行の寿命は §2.2 の 5・R23 に従う。前面化の行も、他の行と同じく送信前に種類を前面化として永続化する。応答で結果が確定したら（成功・検証済みの失敗）行を消す。結果が未確認ならセッションを pause し、行は「効果未確認」のまま残すが、終了時の clean / suspect の判定と起動時の対象の隔離への移行からは除く。その helper の世代の exit を確認したら、その世代の前面化の行を対象の隔離を作らずに消す。receipt で Stop を確定したときも、当該 Stop の前面化の行を同じく消す。Main の起動時に残った前面化の行は対象の隔離へ移さずに破棄し、最小の診断（行の種類と破棄の理由。理由は前面化行の起動時破棄を示す値）を残す。前面化が遅れて効いた場合の残余リスクは N9a の ADR の Q21 のとおり受け入れる。
15. 保存先の決定に伴う読み替えと残件: N9a の ADR の K-1・K-3 が「SQLite のストア」と書く箇所は、本 ADR §2.2 の 5 の SID 共通 SQLite（B、2026-11-03 オーナー決定）と読み替える。保存の形は §2.2 の 5 に具体化した。PR1〜PR3 は保存に依存しない。N15 の ADR の該当の引用は N15 の Q23 の決定の後に追随して直す。

16. **採用: 前面化の記録の範囲と開始の 2 段化（案 C）**（2026-11-03 オーナー決定）。K-4 は開始内を含む helper の SetForegroundWindow を対象とし、N9 の新しい引渡しだけには限らない。方式は §2.2.1 の C（discovery / check_target_identity → 送信前記録 → identity に束縛した開始）を採用し、実装範囲・受入は §4.1 の PR5b とする。MessageType は増やさず、要求・応答の項目（開始の成功・失敗の応答に加える前面化の試行・結果を含む）と対応能力の契約を拡張する。有効化は PR10 と同時とし、それまでは Host options の内部 policy で既定無効を維持する。採用決定は実装完了を意味しない。保存先は採用済みの B を維持する。
