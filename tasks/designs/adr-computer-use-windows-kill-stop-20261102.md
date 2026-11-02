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
- **UIA の pattern 呼出しは、client が死んでも server 側で取り消されない。** `Invoke` / `SetValue` などが固まった対象の provider の中で止まっている場合、helper を終了させても呼出しは対象の UI スレッドに残り、起きたときに実行されうる。helper の中で動く UIA の Win32 / MSAA proxy が送った message（`BM_CLICK` など）も、対象のキューに残る。**これは「未確認の入力」より強い。今の helper は、client 側の呼出しが戻るまでは Stop を確定させない**（`StopWindowsSemanticInput` は `input_in_flight` の間 false を返し、Host の `stopWithDeadline` は `semantic_input_in_flight` を同じ期限の中で 50 ms ごとに再試行し、期限後は `native_stop_unconfirmed` にする）。**ただし、UIA の client timeout の後は、provider 側に呼出しが残っていても receipt で確定する。** V1 lane の UIA は bounded automation（`kWindowsV1UiaTransactionTimeoutMs` = 300 ms、`kWindowsV1UiaConnectionTimeoutMs` = 500 ms。`IUIAutomation2` が無い環境では timeout の無い automation に戻る）で作られ、pattern 呼出しが UIA_E_TIMEOUT で戻ると `input_in_flight` が解け、dispatch は `input_timeout_unconfirmed` を返す。次の close で `StopWindowsSemanticInput` は true を返す。この receipt の経路には対象の隔離が無い（§2.3、§5 の 2）。

### 2.2 確定の判定

終了による確定の証拠は Main が保持する helper の process handle の signaled（Node の `exit`）だけにする。pipe の切断や `kill()` の戻り値は証拠にしない。健全な helper の検証済み close receipt による確定は維持する。

終了を決めた時点で、Main は helper に送った control 要求を調べる。helper が入力の claim まで進んだかは Main から分からないので、**応答が無い、または応答が効果未確認の control 要求は「claim 済みかもしれない」として扱う**。効果未確認とは、次のどれかである。

- accepted=true の `semantic_input_in_flight`。helper の `DispatchWindowsSemanticAction` は、期限・Stop・遅い contact で待ちを打ち切ると、`input_in_flight` が真ならこの code を `accepted = ever_claimed` で返す。
- accepted=true の `input_timeout_unconfirmed`（§2.1 の UIA の client timeout）と `input_not_confirmed`（claim 後に確認できなかった dispatch。`SendInput` の dispatch も含む）。
- client の semantic owner が `uncertain` の状態（`markSemanticUncertain` が立てる）。

効果未確認かどうかは、エラー応答の `accepted` で決める。accepted=true のエラー応答が効果未確認で、上の code はその取りうる値である。`input_not_confirmed` は accepted=false でも返る（`DispatchWindowsAction` は、送れずに reason が空のときもこの code にする）が、accepted=false は効果なしとして台帳から消す。

**判定の情報源は、世代ごとの control 要求の台帳とする**（N3 で新しく作る）。

- 記録する時点は、client の `call()` が `sendConnected` に渡す `beforeWrite`（送信を確定する時点）とする。1 件ごとに helper の世代、session id、request id、種類、対象の identity（pid + 作成時刻）、状態（応答待ち／効果未確認）を持つ。行（helper の世代、session id、request id、種類、対象の identity、状態のすべて。§2.2 の判定にこれらが要る）は、送信の前（`beforeWrite` の時点）に既存の SQLite の永続化に書く。書けなければ送らない（fail-closed）。client（`WindowsComputerUseHelperClient`）は永続化への参照を持たず、addon は binding の読込みの時点で Host より先に作られるので、書込みは Host が行う。`index.ts` が `persistence` に基づく台帳の store を `createComputerUseNativeHost` の options で Host に渡し、Host が addon に台帳の書込み・状態の書換え・消去のコールバックを渡す。client はそれを `beforeWrite` と応答の処理から呼び、書込みが失敗したら `beforeWrite` で例外にして送らない。送信の前に対象の identity（pid + 作成時刻）が確定していない dispatch も送らない。効果を確定した応答で行を消し、効果未確認の応答では状態を書き換える。これにより、応答待ちや効果未確認のまま Main が crash・終了しても、`termination_requested` のまま再起動しても、行が残る（起動時の扱いは 5）。
- 台帳には `dispatch` のすべてを入れる。semantic（`semanticActionTypes` の invoke / set_text / select / toggle / expand_collapse）に限らず、`SendInput` を使う click / scroll / key / type と、paste（#785 の artifact の貼付け。wire では `type` / `set_text` の dispatch）も含める。
- 消すのは、応答 frame を実際に受け取り、その応答が効果を確定したとき（成功、または accepted=false の拒否）だけにする。効果未確認の応答では消さず、効果未確認として残す。transport の timeout、`failAll`、`abortTransport`、binding の不一致や不正な応答でも消さない。
- 検証済みの close receipt でセッションの Stop を確定したら、そのセッションの行は、その時点で「receipt で確定済み」として消す。今と同じ扱いで、対象の隔離にしない（§2.3）。§2.2 の判定は、receipt で確定していない行だけを見る。receipt で確定した後の通常の helper の終了（idle teardown の `shutdown` → `abortTransport`）は、こうして `terminated_clean` になる。順序は次のとおりにする。
  - (a) 行を「receipt で確定済み」にするのは、Host が receipt を検証した後の `addon.confirmSessionClosed` とする（Host の `close` と、`finishStartOwner` の `kind === 'closed'` から呼ばれる）。今の client の `confirmSessionClosed` は semantic owner が無いセッションでは何もせず早く return するので、semantic owner の有無を問わず、すべてのセッションで台帳を処理するように変える。行を消した後は、semantic owner の有無を問わず `shutdownWhenIdle` を呼び直し、(b) で遅らせた idle teardown を進める。receipt をその世代へ結び付ける証拠は、今の `semanticCloseProofs`（受信した応答 object を WeakMap で owner・receipt・世代に結び付け、Host から渡された evidence がその object であることを確かめる）を、semantic でないセッションの close にも広げて使う。
  - (b) 今の client は close の応答を受けると、Host の検証より前に `call()` の finally で `shutdownWhenIdle` を呼び、`shutdownIfIdle` は semantic owner・discovery・`pending`・接続中しか見ずに helper を終了させうる。台帳に receipt で確定していない行を持つ世代では、この idle teardown を (a) の後まで遅らせる（`shutdownIfIdle` の条件に台帳を加える）。この延期は (c) の終了を妨げない。(c) の終了は idle teardown ではなく、Stop の入口が起こすためである。
  - (c) Host が receipt の検証に失敗したときは、§3.1 の 1 のとおり Stop の入口が再送せずすぐに helper を終了させ、終了で確定する経路として §2.2 の判定に通す。
- 今の client の `pending` は、要求の timeout・`failAll`・`abortTransport` で消える。timeout の後に残る記録は semantic owner だけで、これは semantic の dispatch にしか作られず、キーは session で、対象の identity を持たない。semantic でない dispatch と paste には何も残らない。このため `pending` や semantic owner を判定に使ってはならない。

| 状態 | 条件 | Main の扱い |
| --- | --- | --- |
| `terminated_clean` | signaled、かつ台帳にその世代の、receipt で確定していない、応答の無い・効果未確認の control 要求が無い | Stop を確定する。隔離を解く。新しい helper を起動できる |
| `terminated_target_suspect` | signaled、かつ台帳にその世代の、receipt で確定していない、応答が無い、または応答が効果未確認の control 要求がある | Stop を確定する（helper からの新しい入力は無い）。**その要求の対象プロセスの identity（pid + 作成時刻）に限って隔離を保つ**。対象プロセスが終了するか、ユーザーが承認カードで再開を明示するまで、その対象には新しいセッションを始めない。他の対象は使える |
| `termination_requested` | 期限 T 内に signaled にならない | 隔離を保つ。新しい helper は起動しない。UI は「停止を要求した。最後の操作が後から反映される可能性がある」と表示し、「入力はもう出ない」とは言わない。`exit` を待ち続け、届いたら上の 2 行のどちらかへ移る（中断できない I/O が後で解けることがある）。このまま Main を終了・再起動しても、台帳の行が SQLite に残るので、起動時に対象の隔離へ移る（5） |

Main が起こしていない helper の終了（crash、Stop 以外の `abortTransport`）も、台帳がある限り同じ判定と §2.5 の後始末に通す。

`termination_requested` のまま Main を終了・再起動した場合、新しい Main は古い helper の signaled を見ないまま、起動時に台帳の行を対象の隔離へ移し（5）、新しい helper を起動する。根拠は次のとおりである。Main の終了の時点で、古い helper には終了が要求されている（Main の `kill()`、または Main の終了で閉じる libuv の job の KILL_ON_JOB_CLOSE。§3.1 の 7。job による部分は S3（N4）で確かめるまでは推定である。§3.3）が、signaled は確認していない（§2.1 のとおり、保証の起点は signaled である）。要求の後、ユーザーコードを実行中のスレッドが進むのは、終了の APC が届くまでの短い間だけである（§2.1）。この間は signaled が遅れても延びず、再起動の前に終わる。再起動の後に残りうるのは、終了を妨げているカーネルの中の待ち（壊れたドライバ）の完了だけで、完了したスレッドは終了の APC を実行して helper のコードに戻らないので、新しい入力は出ない。win32k の短い syscall（`NtUserSendInput` など）は終了の時点で完了し、その届く先は §5 の 10 のとおり対象に限らず、host 全体の隔離でも防げないので、再起動の後に対象ごとの隔離へ緩めても悪化しない。終了の前に対象へ届いた要求は、signaled を確認した場合と同じく、台帳の行の対象の隔離で受ける。止まった helper が対象の process handle や起動ごとの job の handle を持ち続けても、対象の照合（3）は対象自身の signaled と作成時刻で成り立つ。検証前の子は suspend のまま残り、実行されない（§3.3）。一方、再起動の前の `termination_requested` では host 全体の隔離を保ち、新しい helper を起こさない。§3.1 の 6 のとおり、古い世代の child を保持したまま新しい世代を起こすと、古いセッションの Stop が新しい世代へ届くなど、世代の取り違えが起きうるためである。

対象の隔離は、次のように作る（N3 の範囲）。

1. control 要求を送る時点で、Main はその対象の pid と作成時刻を台帳に持つ。取得元は helper の応答（session の開始や target の受領）とする。今の helper は作成時刻を内部にだけ持ち（`ReadProcessStartIdentity`、`WindowsSession::process_start`。応答の `windowIdentityDigest` にはハッシュとして入るだけ）、`StartWindowsNewSession` の応答は `pid` を返すが作成時刻を返さない。Host が持つのも `pidsByIdentity`（identity digest → pid）だけである。N3 で開始の応答に作成時刻を足す。作成時刻は Main の外（AI・Renderer）には出さない（親 ADR §8 の「パス・PID・ウィンドウハンドルを Main/native の外に出さない」と同じ）。
2. 今ある隔離元（`activeStopQuarantines`、client の semantic owner と `discoveries`、host の `discoveryManager.quarantined()` と `startOwners`）は、どれも host 全体を止める（Host の `inputQuarantined` → `requireMethod`、client の `assertSemanticAvailable` / `ensureConnected`）。`terminated_target_suspect` では、これらを解除し、台帳の行が持つ identity をキーにした新しい「対象の隔離」へ移す。startSession・resume・discovery の入口で、その対象だけを拒否する。対象の隔離に入れるのは台帳の行の identity だけである。identity を持たない隔離元（client の `discoveries`、host の `discoveryManager.quarantined()` と `startOwners`）は、suspect でも対象の隔離へ移さず、helper の終了の確認で解除する。discovery の launch は対象への入力ではなく、launch の子は §3.3 で扱う。
3. 対象の終了の確認は、新しい世代の helper が `OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION)` と `GetProcessTimes` の照合で行う。次の 3 つを対象の終了とみなす: handle が signaled、作成時刻が一致しない（pid が再利用された）、pid が存在しない（`OpenProcess` が `ERROR_INVALID_PARAMETER`）。この照合は §3.1 の 3（新しい helper の最初の操作は `list_targets` か再観測）の例外として許す。それ以外の失敗（アクセス拒否など）では照合できないので、隔離を保つ。
4. 承認カードでの再開は、新しい経路として N3 で作る（今の Controller の `resume` は paused のセッションのためのもので、この用途には使えない）。再開の ticket は新しい世代で新規に発行する。§3.1 の 2 で失効させた古い ticket は使わない。
5. 対象の隔離も、台帳の行と同じく既存の SQLite の永続化に保存し、Main の再起動をまたいで保つ（N3 の範囲）。v2 の grant は永続（installation-wide・無期限）で、再起動の後は承認カード無しで開始できるので、メモリだけに持つと再起動が D-2 に無い解除の経路になるためである。台帳の行は上の全項目（helper の世代、session id、request id、種類、対象の identity、状態）を持つ。対象の隔離の行が持つのは pid、作成時刻、隔離の理由だけで、台帳の行を対象の隔離へ移すときは世代・session id・request id を捨てる。どちらの行にも target の名前・パス・AI に見せる情報は入れない（session id と request id はこの禁止の対象外）。Main の起動時に SQLite に残っている台帳の行は、対象の隔離へ移す。照合（3）は、起動後の最初の helper の起動時に行う（helper は `ensureConnected` まで起動しないので、照合のためだけに先に起動はしない）。照合が済むまでは、永続化された対象への開始を拒否する。解除するのは、この照合か新しい helper の世代の開始時の照合で対象の終了を確かめたとき、または 4 の承認カードで再開したときで、照合できないものは保つ。保存の形（既存のテーブル・設定の流用か、新しいテーブルか）は N3 の着手前に決める。ストア自体の読み書きに失敗したときは fail-closed とし、その対象の開始を拒否する（対象が特定できなければ、その世代では新しい開始を拒否する）。ストアが読めた上で個々の行が不正なとき（読めない行、identity の無い行）は、対象を守れないので破棄し、診断ログに構造化した最小限の metadata（行の種類と破棄の理由。理由は形式の不一致と identity の欠落を区別する値にする。pid・作成時刻・名前・パスは入れない）を残す。host 全体を永久に止める状態にはしない。ローカルの DB の書換えと、行の形式の変更・不整合による破損は対象外として受け入れる（§5 の 9）。行の削除による解除も検出できない（§5 の 9）。

### 2.3 #484（変更禁止の不変条件）との関係

**この ADR は #484 を部分的に緩める。** 今は「helper の close receipt」だけが確定の証拠で、claim 済みの UIA 呼出しが残る間は確定しない。この ADR は、helper の終了でも確定させる。ただし、claim 済みかもしれない呼出しが残る場合（`terminated_target_suspect`）は、その対象に限って隔離を保つので、「未確認の入力が残る対象へ入力を再開しない」という #484 の目的は保つ。親 ADR §8 の変更禁止は、オーナー判断 D-1・D-2・D-4 により、上記の条件つきで置き換えることが承認された（§6）。D-4 の 4 箇所以外にある同じ趣旨の記述（親 ADR §8 の「Stop 後に入力が続かない」、§10「#820」の「Mainは未確認semantic ownerと元helperを保持し…」の段落など）も、この ADR を優先する。

終了と receipt の経路は非対称である。終了で確定する経路では、効果未確認の要求の対象を隔離する。receipt で確定する経路（UIA の client timeout の後、§2.1）では、provider 側に呼出しが残りうるのに対象の隔離が無い。これは今と同じで、この ADR は変えない（§5 の 2）。receipt で確定したセッションの台帳の行もその時点で消すので（§2.2）、その後の通常の helper の終了でも対象は隔離されない。

### 2.4 入力の不変条件（新しく明文化する）

- down と up は 1 回の `SendInput` に入れる（今の click・key はそうなっている）。helper が途中で終了しても、キーやボタンが押されたままにならない。drag・修飾キー・ホットキーを足すときもこれを守る。
- 今の例外: 補助文字（サロゲートペア）の入力は、`SendUnicodeScalar` で上位サロゲートの down/up と下位サロゲートの down/up を 2 回の `SendInputForBoundTarget` に分けている。その間に helper が終了すると、対象には上位サロゲートだけが届き、テキストや IME の状態が壊れうる。S4（N5）で、1 つの scalar の 4 イベントを 1 回の `SendInput` にまとめる。今の `type` は 1 回の dispatch で 1 scalar に限られる（helper は `scalars.size() != 1` を `invalid_text` で拒否する）。複数の文字の入力の途中で終了すると、応答待ちの 1 件が効果未確認になり（§2.2）、それより前に completed で返った文字は入力済みとして残る。複数の scalar を受け付けるよう広げる場合は、途中の終了を一部だけの入力として効果未確認で扱う。

### 2.5 helper の終了は、その helper の上のすべてを止める

Windows addon は 1 つの `WindowsComputerUseHelperClient` を持ち、その client を通るセッション、Task、開始待ち、discovery、picker は helper を共有する。現行 Controller は同時に 1 セッションだけを許可するが、開始待ちや discovery の owner も同じ helper を使う。複数セッションを扱う場合も、セッション A の Stop のために終了させると、B のセッションと入力中の操作、その helper が出した ticket も失われる。

- helper の終了は、その helper の世代（`helperGeneration`）のすべての owner に対する Stop として扱う。原因は問わない（§2.2 の最後）。影響を受けた各セッションには、通常の `completeStop` の後始末をすべて行う（`cancelPendingApprovals`、#785 の `copiedArtifacts` / `attachedArtifacts` の破棄、stopped の状態）。B の Task には「別の操作の停止のため、Computer Use が止まった」と返す。
- 他の owner の有無にかかわらず、終了の前に §3.1 の 1 の close の期限 C を待つ。

## 3. 変更

### 3.1 Main

1. Stop の手順を「cancel（ack の期限 1 秒）→ close（期限 C）→ 期限内に receipt が無ければ helper を終了 → signaled を待つ（期限 T）→ §2.2 の判定」にする。**C は、実測するまで今の 10 秒（1 回目の close の期限）のままにする。** 健全だが忙しい helper を誤って終了させると、確定できたはずの入力が「効果不明」になり、他のセッションも止まり（§2.5）、再起動では Electron の main thread で同期の PowerShell の署名確認（`execFileSync`、最大 10 秒）が走る。#820 の記録では、UIA 呼出し 1 回の最悪が 800 ms、素の `ElementFromHandle` が 1028 ms だった。S1 で、負荷とキューのある健全な helper の close の所要時間を測り、その分布から C を決める。T は 2 秒を目安にする。
   - Stop の入口は 4 つある。開始済みのセッションの close（Controller の `completeStop` → Host の `close`）、native がある開始待ちのセッション（Controller が cancel と close の再送を自分で行う）、native が無い開始待ちのセッション（Controller が `starting.native === null` かつ `nativeStarted` のとき Host の `stopPendingStart` を呼ぶ。Host は `stopStartOwner` → `completePendingStop` → `completeNativePendingStop` と進み、`stopWithDeadline('stopPendingStart')` を `COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT` 回まで再送する）。helper が `start_session` の中で固まった場合（S1 が挙げる WinVerifyTrust や process / exe の open）は 3 つ目の経路で、最初の `stopPendingStart` の期限 C の切れを終了の契機とし、C + T 以内に §2.2 の判定へ進む。4 つ目は、セッションに属さない discovery の Stop である（候補一覧の取消し、Task の切替え・終了、grant の取消しなど。Controller の `beginWindowCandidates` や `stopDiscoveriesWhere` → `ComputerUseDiscoveryScope.stop` → discovery handle の `stop()` → discovery manager の `completeStop`（`attemptLimit` 回まで再送）→ Host の `stopWindowDiscovery`）。この入口の期限切れ・失敗も、同じ世代の終了と §2.2 の判定・§2.5 の後始末へつなぐ。この入口で helper の終了を起こす期限（C と同じ値か別の値か）は未決で、N3 の着手前の状態表で決めて追記する（#988 参照）。
   - Windows では、この 4 つの入口の再送（Controller の close の再送 2 回、`completeNativePendingStop` の再送、Host の `stopStartOwner` が失敗したとき `stopPromise` を null に戻して後の Stop に新しい証拠の取得を許す経路、Host の `startSession` の catch で開始の要求が決着した後に `stopStartOwner` をもう 1 回呼ぶ再確認）を廃止するか、1 回の期限 C の中に収める。C の後は再送せず終了へ進む。同じ定数を共有する discovery manager の `attemptLimit` と transport の close の期限（今は再送を見込んで 10 秒 × 3）も、Windows では 1 回の期限 C に合わせ、C の後の終了と競合しない値に N3 で直す。macOS は今のまま。
   - 終了を起こすのは Host の Stop の入口（`close`、`stopPendingStart`、セッションに属さない discovery の Stop）で、契機は、期限 C の切れと、Stop の入口が期限 C より前に検証済みの receipt を得られずに失敗したとき（helper の error 応答、receipt の parse・sessionId・epoch・count の検証の失敗、discovery の停止の失敗、`confirmSessionClosed` の失敗のどれでも）とする。今のコードでの例は、Host の `close` での receipt の parse か `inputReceipt` の検証の失敗、`discoveryUnconfirmed` か discovery の停止の失敗、`confirmSessionClosed` の proof の不一致、`completeNativePendingStop` での receipt の parse の失敗や epoch・count の後退、`completePendingStop` での discovery の停止の失敗、discovery manager の `completeStop` での receipt の parse か `discoveryId` の不一致である。失敗したときは再送せず、すぐに helper を終了して §2.2 の判定へ進む（§2.2 の (c)）。今は、検証の失敗の多くで終了の契機が無い（parse の失敗などでは close の応答の後の idle teardown が偶然 helper を終了させ、semantic の proof の不一致や discovery の停止の失敗では helper が残る）。§2.2 の (b) はその idle teardown も止める。child の終了と `exit` の観測は addon の client が受け持つ。Controller は終了を起こさず、Stop の結果として §2.2 の状態を受け取る。今の Host の `close` は `Promise<void>` を返すので、`close` と `stopPendingStart` が §2.2 の状態を返すように型を変える。
   - Controller の扱い: `terminated_clean` と `terminated_target_suspect` は Stop の確定として `nativeAcknowledged` を真にし（固まった helper では cancel の ack が先に失敗するが、その失敗は終了による確定で上書きする。開始待ちの経路も同じ）、停止理由は要求された理由のままにする。今のように `native_unavailable` に置き換えない。`terminated_target_suspect` の UI は「停止した。最後の操作が対象に後から反映される可能性がある。そのアプリは、終了するか再開を承認するまで操作しない」とする。`termination_requested` は今と同じ `native_unavailable` とし、UI は §2.2 の文言にする。停止理由の値と文言の細部は、N3 の着手前の状態表で決める。終了で確定した場合の `stop_acknowledged` の capture には、receipt の代わりに終了の種別を記録する。
   - C の上限は 10 秒とする。Host の `stopWithDeadline` と discovery manager は 10 秒を超える期限を拒否するので、S1 の実測で 10 秒を超える C が要るなら、N3 でこの 2 つの上限も変える。
2. 終了で確定したセッションは、その helper に結び付く token（target / app / session / artifact）と承認 ticket をすべて失効させる。Main の token と session id は `randomUUID` で発行されるが、それだけでは古い token は失効しない。Windows の client には `helperGeneration` があるが、host と controller はそれを token の失効に使っていない。**これを広げて、host・controller の token と ticket を世代に束縛する**（親 ADR §10 は既存の契約のように書いているが、helper 終了に連動した失効の実装は無い）。再開の承認カードの ticket は、新しい世代で新規に発行する（§2.2 の 4）。
3. 新しい helper の最初の操作は `list_targets` か再観測にする。例外は、§2.2 の 3 の対象の終了の照合だけである。終了の後の最初の観測は、短い待ち（settle）の後に行う（§3.3 の、job で止められない起動の窓が開きうるため）。
4. 未確認の入力は「未確認のまま終わった」と記録し、再送しない。モデルには「最後の操作は後から反映されるかもしれない。画面を見直す」と返す。
5. **終了を確認した世代の隔離とブロックの解除は、すべての元に対して行う。** どれか 1 つでも残ると、終了の後も永久に隔離されるか、teardown や開始が止まる。
   - Host: `activeStopQuarantines`、`discoveryManager.quarantined()`、`startOwners`（`attempts` / `terminal === null` / `unconfirmed` / `discoveryUnconfirmed`）。
   - Host の session 表（`sessions`、`classifierBindings`、`inputAttemptsBySession`、`stopEpochs`、`revisionsBySession`）は、検証済みの close と同じく終了確定として片付け、`confirmedClosed` に登録する。登録しないと、後の Stop の close が `sessions` にも `confirmedClosed` にも無いとして `native_stop_unconfirmed` を投げる。
   - client: semantic owner（`ensureConnected` はこれが未確認の間 helper を起動しない）、`discoveries`、`starts`。`starts` は今は helper の世代を持たず、close receipt を受けるか未送信のまま止まらない限り残る。残った `everSent && !closed` は `shutdownWhenIdle` で新しい世代の idle teardown を止め、16 件で新しい開始も拒否させる。`starts` に世代を持たせ、終了した世代の分を破棄する。
   - client の semantic owner を単に解除するのは、`terminated_target_suspect` に当たらない世代に限る。suspect の世代では、`activeStopQuarantines` と semantic owner を、台帳の行の identity で §2.2 の対象の隔離へ移してから解除する。identity を持たない元（`discoveries`、`discoveryManager.quarantined()`、`startOwners`）は §2.2 の 2 のとおり終了の確認で解除する。`termination_requested` では何も解除しない。
6. **終了中の child を世代ごとに保持する。** 今は `abortTransport` が `this.child = null` にするため、exit listener が `this.child !== child` で早く return し、Main は自分の kill の終了を観測できない。crash のときも exit listener は `failAll` するだけである。また `ensureConnected()` は socket が null で未確認の semantic owner が無く、接続中でもなければ `connect()` で新しい helper を起動するので、古いセッションへの close の再送が新しい helper に届き `session_missing` になりうる。終了中の child が `exit` するまで、`pickApplication` を含むすべての操作を止める。古いセッションの Stop を新しい世代へ送らない。世代の終了は原因を問わず（Stop、crash、要求の timeout・binding の不一致・不正な応答・write の失敗による `abortTransport`）、§2.2 の判定と §2.5 の後始末を通す。`abortTransport` のすべての経路で、終了中の child を保持する。
7. Main の終了時の helper は、新しい作業を要しない。helper は `detached` なしで spawn されるので（`connect()` の `spawn`）、libuv の global job に入る（§3.3）。この job は KILL_ON_JOB_CLOSE を持つので、Main が終わると、正常終了でも crash でも、helper は `TerminateProcess` と同じ形で強制終了される。helper の通常終了経路（parent watcher が Main の終了を検知した後の `DrainWindowsSemanticInputForExit` / `DrainWindowsDiscoveryLaunchesForExit`）は、この強制終了が先に来るので通らない。Main の終了は、S2 の終了と同じく効果未確認の終了であり、drain ではない。残るのは、カーネルの中で止まって終了できない helper だけである（§5 の 1）。

### 3.2 helper

- Stop の応答性のためだけにある仕組み（作業スレッドの枠、取消しの別名、cleanup 後の候補採用、`CancelSynchronousIo` の試行）は新しく足さない。既存のものは S4 で、入力の安全に要るものだけを残して整理する。
- 残すもの: 入力直前の再検証（identity、foreground、geometry、cancel epoch）、入力 unit の claim と attempt の記録、`semantic_input_in_flight`、§2.4。
- 健全な helper では今どおり receipt で確定する。ただし close は `ServePipe` の単一キューで処理される。reader は `stop_serial` と cancel epoch の更新に加え、開始・discovery の受付や停止 latch も行うが、close の応答は consumer が処理する。close は処理中の frame と、それより先に受け付けた待ち frame の後ろに並ぶ（待ちキュー全体の上限は 64 件）。discovery 待機中には別 owner の `stop_window_discovery` を先に処理する例外がある。
- helper の dispatch 結果の cache（`requestId` ごと、二重入力防止）は終了で失われる。これが安全なのは、その helper の上のセッションをすべて捨てるときだけである（§2.5）。

### 3.3 子プロセスと一時資源

- **検証済みの子は、helper の終了で殺さない**（親 ADR §10 #940 の「検証済みアプリの起動は巻き戻さない」と同じ）。 AI が起動したアプリをユーザーが使っていれば、未保存の作業が失われる。今の `LaunchVerifiedExecutable` も検証済みの子は残し、未検証の子だけを終了させている（`computer_use_windows_host.cc` の `OwnedChild`）。
- 今の `LaunchVerifiedExecutable` は `CreateProcessW` を suspend せずに呼び、その後で image を検証する（`computer_use_windows_host.cc:3982`）。この間に helper が終了すると、未検証の（すり替えられたかもしれない）子が動いたまま残る。起動は `CREATE_SUSPENDED` と `PROC_THREAD_ATTRIBUTE_JOB_LIST` で、起動ごとの job に作成時点から入れる。image を検証した後で KILL_ON_JOB_CLOSE を外し（`SetInformationJobObject`）、`ResumeThread` する。helper が検証前に終了したら、一度も実行していない子だけが終わる。JOB_LIST を使うのは、検証前の子の後始末を作成の時点から確実にするためである。作成後に `AssignProcessToJobObject` すると、その間に helper が終了したとき、子は job に入らず、実行もされない suspend のまま残る。
  - 起動ごとの job は、作成時から `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`・`JOB_OBJECT_LIMIT_BREAKAWAY_OK`・`JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK` で作り、検証後は KILL_ON_JOB_CLOSE だけを外す。BREAKAWAY_OK が要るのは、プロセスは入った job から抜けられず、検証済みのアプリが `CREATE_BREAKAWAY_FROM_JOB` で子を作ると、BREAKAWAY_OK の無い job では `ERROR_ACCESS_DENIED` で失敗するためである。SILENT_BREAKAWAY_OK が要るのは、検証済みのアプリの子孫を helper の job に入れず、今の「job に入れない起動」と同じ挙動にするためである。最初から付けてよいのは、子が suspend 中で孫を作れないためである。
  - job の handle は子に継承させない（`CreateJobObjectW` の security attributes は NULL、`CreateProcessW` の `bInheritHandles` は FALSE）。子が job の handle を持つと、helper が終了しても job の最後の handle が閉じず、KILL_ON_JOB_CLOSE が効かないためである。
  - 終了の窓: KILL_ON_JOB_CLOSE を外した後、`ResumeThread` の前に helper が終了すると、検証済みの子は殺されないが実行もされず、suspend のまま残る（孤児）。逆の順序（resume してから外す）にすると、その間の終了で検証済みの子が殺され、上の「巻き戻さない」に反する。N4 は「外してから resume」の順とし、2 つの呼出しの間に他の処理を挟まない。それでも残る窓は §5 の 6 に書く。
- rename 追従の probe の子は、上と同じく作成時から JOB_LIST で job に入れるが、**resume しない**。probe の子は helper 自身の exe を TEMP にコピーしたもので（`WindowsTargetRenameFollows`）、image 名の追従を確かめるためだけに作る。今は `CREATE_SUSPENDED` の後に `AssignProcessToJobObject` しており、resume せずに `TerminateProcess` してから、handle を閉じてコピーを消している。N4 で JOB_LIST に変え、終了を確かめて handle を閉じてから消す。
- Node が helper を入れている libuv の job は、`JOB_OBJECT_LIMIT_BREAKAWAY_OK`・`JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK`・`JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION`・`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` を持ち、その handle は継承されない（libuv の `src/win/process.c` の `uv__init_global_job_handle`。`uv_spawn` は detached でない子を `CREATE_SUSPENDED` で作り、この job に入れてから resume する）。同梱の Electron 43.5.0 の libuv は 1.52 で、ソースは手元に無く上流の同じ内容による（確度: 強い推定）。SILENT_BREAKAWAY_OK があるので、helper の子は libuv の job を継承しない。helper の子を job に入れるのは、上の明示の指定でしか成り立たない。
- **job で止められない起動がある。** Windows 11 の notepad / calc はパッケージアプリに引き継ぐ。そのプロセスは DcomLaunch サービスによる activation で作られる（UWP の frame は ApplicationFrameHost が持つ）。Chrome や Electron などの single-instance のアプリは、既に動いているプロセスへ転送する。これらは Stop の確定の後にウィンドウを開き、フォーカスを取りうる。§3.1 の 3 の settle と、次の観測での通常の判定で受ける。残るリスクとして §5 に書く。
- job の終了も非同期なので、子が消えたことは `JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO`（または ActiveProcesses = 0）で確かめる。一時フォルダの削除は、probe の exe がまだ lock されている場合に備えて再試行する。
- 一時フォルダは helper ごとにする。今の probe は TEMP の直下に `sc-rename-probe-<helper の pid>-…` を作り、helper の中で消している。helper が終了させられるとこの後始末は走らず、helper の exe のコピーが残る。helper の終了の後は、Main が `exit` を受けた後に、その helper の一時フォルダを再試行つきで消す（probe の子は helper の job の handle が閉じた時点で KILL_ON_JOB_CLOSE により終わるが、その終了も非同期なので再試行する）。

## 4. スライス（PR の単位）

| #（#988 のノード） | 内容 | 依存 | 試験 |
| --- | --- | --- | --- |
| S1（N2） | 応答しない helper の試験装置。テスト用の build flag で、指定した要求の中で永久に待つ（UIA 呼出し、`CreateFileW`、capture、WinVerifyTrust の各所）。Main の Stop がどこで止まるかを固定する | この ADR 内ではなし | CI の Windows live seam。cancel と close 2 回が期限切れになると Host の `native_stop_unconfirmed` を受け、Controller が約 21 秒の native 待機（start owner に処理中の discovery が無い場合）の後に `native_unavailable` とすることを固定する。transport は §1 の条件下で最初の close から約 40 秒で kill し、未確認の semantic 入力や discovery がある場合は kill しないことも固定する。あわせて、健全で忙しい helper の close の所要時間を、負荷とキューのある状態で測る |
| S2（N3） | Main と、それに要る helper（C++）の変更（§2.2 の 1 の開始の応答への作成時刻の追加、§2.2 の 3 の照合）: §2.2・§2.5・§3.1 の全項目。終了による確定（§2.2 の 3 状態）、世代ごとの control 要求の台帳とその SQLite への記録、対象の identity の取得と対象の隔離、承認カードでの再開の経路、対象の隔離の永続化と起動後の最初の helper での照合（§2.2 の 1〜5）、S1 の実測にもとづく close の期限 C の決定（実測までは 10 秒のまま）、4 つの Stop の入口（セッションに属さない discovery の Stop を含む）での終了と再送の廃止、transport の close の期限と discovery manager の見直し、Host の Stop の戻り値の型と Controller の `nativeAcknowledged`・停止理由・UI 文言・capture（§3.1 の 1）、token の一括失効（§3.1 の 2）、再起動後の再観測の強制（§3.1 の 3）、未確認の入力の記録（§3.1 の 4）、すべての隔離元の解除（§3.1 の 5）、終了中の child の世代ごとの保持と全 `abortTransport` 経路での `exit` の観測（§3.1 の 6）、影響を受けた全セッションの `completeStop` の後始末と他の Task への通知（§2.5） | S1（N2）・S3（N4） | S1 の装置の全箇所で、Stop が 1 + C + T 以内（cancel の ack 1 秒 + C + T）に確定し、次のセッションが始められること（§2.2 の対象隔離と `termination_requested` の例外を守る）。Stop 中に dispatch の transport が先に timeout する場合（例: dispatch が helper の中で固まり、Stop の後、C が切れる前にその dispatch の transport 期限が切れる）にも、台帳から `terminated_target_suspect` になること。`start_session` の中で helper が固まった場合の Stop が C + T 以内に確定すること。効果未確認の dispatch を含むセッションを receipt で Stop した後の idle teardown が `terminated_clean` になること。応答待ちのまま Main を終了した後の起動で、その対象が隔離されていること。対象の隔離が、照合での対象の終了（signaled・作成時刻の不一致・pid の不在）と承認カードでの再開でだけ解除され、アクセス拒否では保たれること。台帳を書けないときは要求を送らないこと。receipt を受けた close の応答の後、Host の検証の前に idle teardown が helper を終了させないこと。receipt の検証に失敗した Stop、`close` / `stop_pending_start` に helper が error 応答を返した Stop、セッションに属さない discovery の Stop の期限切れが、それぞれ C + T 以内に §2.2 の状態で確定すること。対象の隔離と台帳のストアの保存・読込みが失敗したとき開始を拒否すること（fail-closed）。identity を持たない隔離元（`discoveries`、`discoveryManager.quarantined()`、`startOwners`）が helper の終了の確認で解除されること。ストアが読めた上で読めない行と identity の無い行は破棄され、それぞれを区別した診断ログが残ること |
| S3（N4） | helper: §3.3 に従い、起動ごとの job（作成時から KILL_ON_JOB_CLOSE・BREAKAWAY_OK・SILENT_BREAKAWAY_OK、handle は継承させない）に `CREATE_SUSPENDED` と `PROC_THREAD_ATTRIBUTE_JOB_LIST` で子を作成時点から入れる。検証後に KILL_ON_JOB_CLOSE だけを外して resume する。probe も作成時から job に入れ、resume せずに終了を確認する。一時フォルダを helper ごとにする。着手時に、§3.3 の libuv の job のフラグ（強い推定）を、同梱の Electron の libuv の実装か実機で確かめ、結果をこの ADR に追記する | この ADR 内ではなし（S2 より前） | launch の検証前に helper が終了しても未検証の子が残らず、検証済みの子は巻き戻されないこと。検証済みの子が `CREATE_BREAKAWAY_FROM_JOB` で子を作れること。helper の子が libuv の job に入らないこと（Main を終了しても、検証済みの子が殺されないこと） |
| S4（N5） | helper: Stop のためだけの仕組みの整理（#940 の残り、#820 の残件のコード側を扱う）。§2.4 のサロゲートペアを 1 回の `SendInput` にまとめる。親 ADR §10 リスク 10 と「#820」の、Stop のためだけの仕組み（worker、slot、alias など）の説明を、整理後の実装に合わせて同じ PR で更新する | S2（N3）・S3（N4） | 既存の native seam の入力安全の試験が全部通ること。停止応答用の worker を除いた後も、応答しない helper の Stop が §3.1 の 1 の経路で終了へ届き、C + T 以内に確定すること |

この表は kill-stop 内の依存を示す。S1（N2）・S3（N4）は並行でき、S2（N3）は両方の後、S4（N5）は S2 の後に置く。S2 が helper の終了を通常の Stop にする前に、未検証の子が残らないよう起動を suspend と job で守る必要があるため、S3（N4）を S2（N3）より先に入れる。

## 5. 残るリスク

1. `termination_requested` のまま signaled にならない環境（壊れたドライバ）では、終了を確認できるまで隔離を保ち、新しい helper は起動しない。Main を終了すると、libuv の job が helper を強制終了しようとするが（§3.1 の 7）、カーネルの中で止まって終了できない helper はそれでも残る。このため再起動は古い helper の終了の証拠にはしないが、対象ごとの隔離へ移す根拠にはする（§2.2）。頻度は実機で測る。
2. 終了の前に発行された UIA pattern の呼出しと、積まれた `SendInput` は、Stop の確定の後に対象で実行されうる。終了で確定する経路で対象の隔離（`terminated_target_suspect`）で受けるのは、応答が無いか効果未確認の要求だけである。completed で返った `SendInput`・`Invoke` が対象のキューに残る分は受けない（今と同じ）。receipt で確定する経路（UIA の client timeout の後、§2.1）では対象の隔離が無く、provider 側に残った呼出しが後で実行されうる（今と同じ）。対象が固まったままユーザーが自分で操作すると、遅れて実行された入力と混ざりうる（今も同じ）。
3. helper の再起動のたびに、署名検証や context の初期化のコストがかかる（初回の `list_targets` が数秒）。Stop が頻繁なら体感が落ちる。
4. macOS には適用しない。macOS の Stop は今の serial lock の方式のまま。両 OS の Stop の確定の仕組みが異なることを、受入の記録に明記する。
5. job で止められない起動（パッケージアプリへの引継ぎ、single-instance への転送）は、Stop の確定の後にウィンドウを開き、フォーカスを取りうる。
6. 検証済みの子の KILL_ON_JOB_CLOSE を外してから `ResumeThread` するまでの間に helper が終了すると、その子は実行されない suspend のまま残る（§3.3）。窓は 2 つの呼出しの間だけで、子は一度も実行していないので入力の安全には関わらないが、ユーザーには起動しなかったように見え、プロセスと exe の lock が残る。
7. v2 の grant は SQLite に永続する（installation-wide・無期限）ので、台帳と対象の隔離を Main のメモリだけに持つと、crash・終了・`termination_requested` のままの再起動の後に承認カード無しで同じ対象に開始できてしまう。このため台帳の行と対象の隔離を永続化し、起動後の最初の helper と新しい世代の開始時の照合か、承認カードでだけ解除する（§2.2 の 5）。残るのは、照合できない対象（アクセス拒否など）の隔離が、承認カードで再開するまで再起動をまたいで続くことと、照合が済むまで永続化された対象へ開始できないことである。
8. control 要求（dispatch）のたびに、送信の前に SQLite へ 1 回書き、応答で 1 回消す（または書き換える）費用がかかる。書けなければ送らないので、DB の不調は Computer Use の入力の停止として現れる。書込みの後、送信の前に Main が crash すると、送っていない要求の行が残って対象を過剰に隔離する（安全側で、照合か承認カードで解除できる）。費用は S2 で測る。
9. 対象の隔離と台帳の行を SQLite から消すと、D-2 に無い解除の経路になる。grant の MAC（T14）の方式は、行が本物であることを示すが、行が消されたことは検出できない。この ADR は、ローカルの DB を書き換えられる攻撃者による削除を対象外とする。T14 が守るのは grant を偽って権限を広げることで、隔離の行を消しても、ユーザーが既に与えた grant の範囲を超える権限は得られず、残るのは遅れて実行される入力が混ざるという事故の側のリスクだけだからである。同じ理由で、行の形式の変更・不整合による破損で読めなくなった行や identity の無い行も、破棄して診断ログに残し（§2.2 の 5）、その対象の隔離は失われるものとして受け入れる。
10. `SendInput` の効果未確認（送った後の再検証の失敗）では、入力がセッションの対象以外のプロセス（その時点の前面やカーソルの下のプロセス）に届いた可能性がある。対象の隔離はセッションの対象だけを守り、そのプロセスは隔離しない（今と同じ）。
11. S3（N4）で libuv の job が helper を終了させないと分かった場合は、Main が `kill()` を呼べない crash の後に古い helper が残りうる。そのときは、`termination_requested` の世代の helper の pid と作成時刻も台帳と同じく SQLite に残し、再起動の後に照合で終了を確かめるまで host 全体の隔離を保つ扱いに切り替える（N3・N4 で決める）。
12. N3 で決める（#988 参照）: §5 の 11 の照合の主体（Main で行うか、照合に限り helper の起動を許すか）と、§2.2 の再起動時の helper の起動条件への §5 の 11 の除外の追記。それまでは §2.2 の「新しい helper を起動する」は §5 の 11 の推定が成り立つ場合に限る。

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
