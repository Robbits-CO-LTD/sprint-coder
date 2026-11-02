# ADR: Computer Use Windows — 「止める」を helper の終了で保証する

- Status: Accepted（2026-11-02、オーナー判断 D-1〜D-5 を反映）
- Date: 2026-11-02
- Issue: #988（Refs #500, #484, #820, #940）
- 関連: `tasks/designs/adr-computer-use-agent-driven-v2.md` §8（#484 の隔離は「変更禁止」）、§10 リスク 10、§10「#820: UIA 読取りの停止境界」

## 1. 問題

現行コード（base `14e4d67b`）では、Windows の開始済みセッションの Stop は「helper が close receipt を返し、Host が検証すること」でしか確定しない（`computer-use-native-host.ts` の `confirmSessionClosed` → `activeStopQuarantines.delete`）。helper が応答しないと、次のようになる。

- Controller は cancel の ack（1 秒）と close 2 回（10 秒 × 2）を待つ。すべて期限切れなら native の待機は合計約 21 秒で、Host は `native_stop_unconfirmed`、Controller の停止理由は `native_unavailable` になる。observe / control の隔離は Host の cancel / close 開始時から続く。
- transport は、未確認の semantic 入力や discovery が残る間は helper を**わざと殺さない**。遅れて届く receipt で、再起動なしに復旧できるようにするためである（`computer-use-windows-transport.test.ts` の `killed === false` の試験群）。
- 未確認の入力・discovery が無く、他の owner や要求も teardown を妨げない場合、close を 10 秒後に 1 回再送すると、最初の close の送信から約 40 秒（再送まで 10 秒 + 最後の close の transport 期限 30 秒）で helper を kill する。close 1 要求の transport 期限自体は 30 秒であり、40 秒は一律の kill 期限ではない。kill は確定の証拠にならないので、隔離は残る。
- receipt が来ないまま helper が戻らなければ、隔離はアプリの再起動まで続く。

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
- UIA・COM・ALPC の待ちはユーザーモードの待ちなので、対象が固まっていても終了を妨げない。
- Node の `exit` は libuv が process handle に `RegisterWaitForSingleObject` した結果で、signaled と一致する。

保証できないこと:
- **`TerminateProcess` が返った時点では、まだ保証は始まらない。** 終了は非同期で、別の CPU でユーザーコードを実行中のスレッドは APC が届くまで進む。win32k の中（`NtUserSendInput` など）にいるスレッドはその syscall を終える。保証の起点は signaled であって、`TerminateProcess` の戻り値ではない。
- **送った入力は、処理済みとは限らない。** `SendInput` は入力ストリームに積むだけで、対象の UI スレッドが固まっていれば Stop の後、ユーザーの入力と混ざって処理されうる（今も同じ）。
- **UIA の pattern 呼出しは、client が死んでも server 側で取り消されない。** `Invoke` / `SetValue` などが固まった対象の provider の中で止まっている場合、helper を終了させても呼出しは対象の UI スレッドに残り、起きたときに実行されうる。helper の中で動く UIA の Win32 / MSAA proxy が送った message（`BM_CLICK` など）も、対象のキューに残る。**これは「未確認の入力」より強い。今の helper は、この状態では Stop を確定させない**（`StopWindowsSemanticInput` は `input_in_flight` の間 false を返し、Main は `semantic_input_in_flight` を期限まで再試行して `native_stop_unconfirmed` にする）。

### 2.2 確定の判定

終了による確定の証拠は Main が保持する helper の process handle の signaled（Node の `exit`）だけにする。pipe の切断や `kill()` の戻り値は証拠にしない。健全な helper の検証済み close receipt による確定は維持する。

終了を決めた時点で、Main は helper に送った要求のうち応答が来ていないものを調べる。helper が入力の claim まで進んだかは Main から分からないので、**応答の無い control 要求（dispatch、semantic input、paste）は「claim 済みかもしれない」として扱う**。

| 状態 | 条件 | Main の扱い |
| --- | --- | --- |
| `terminated_clean` | signaled、かつ応答の無い control 要求が無い | Stop を確定する。隔離を解く。新しい helper を起動できる |
| `terminated_target_suspect` | signaled、かつ応答の無い control 要求がある | Stop を確定する（helper からの新しい入力は無い）。**その要求の対象プロセスの identity（pid + 作成時刻）に限って隔離を保つ**。対象プロセスが終了するか、ユーザーが承認カードで再開を明示するまで、その対象には新しいセッションを始めない。他の対象は使える |
| `termination_requested` | 期限 T 内に signaled にならない | 隔離を保つ。新しい helper は起動しない。UI は「停止を要求した。最後の操作が後から反映される可能性がある」と表示し、「入力はもう出ない」とは言わない。`exit` を待ち続け、届いたら上の 2 行のどちらかへ移る（中断できない I/O が後で解けることがある） |

### 2.3 #484（変更禁止の不変条件）との関係

**この ADR は #484 を部分的に緩める。** 今は「helper の close receipt」だけが確定の証拠で、claim 済みの UIA 呼出しが残る間は確定しない。この ADR は、helper の終了でも確定させる。ただし、claim 済みかもしれない呼出しが残る場合（`terminated_target_suspect`）は、その対象に限って隔離を保つので、「未確認の入力が残る対象へ入力を再開しない」という #484 の目的は保つ。親 ADR §8 の変更禁止は、オーナー判断 D-1・D-2・D-4 により、上記の条件つきで置き換えることが承認された（§6）。

### 2.4 入力の不変条件（新しく明文化する）

- down と up は 1 回の `SendInput` に入れる（今の click・key はそうなっている）。helper が途中で終了しても、キーやボタンが押されたままにならない。drag・修飾キー・ホットキーを足すときもこれを守る。

### 2.5 helper の終了は、その helper の上のすべてを止める

Windows addon は 1 つの `WindowsComputerUseHelperClient` を持ち、その client を通るセッション、Task、開始待ち、discovery、picker は helper を共有する。現行 Controller は同時に 1 セッションだけを許可するが、開始待ちや discovery の owner も同じ helper を使う。複数セッションを扱う場合も、セッション A の Stop のために終了させると、B のセッションと入力中の操作、その helper が出した ticket も失われる。

- helper の終了は、その helper の世代（`helperGeneration`）のすべての owner に対する Stop として扱う。影響を受けた各セッションには、通常の `completeStop` の後始末をすべて行う（`cancelPendingApprovals`、#785 の `copiedArtifacts` / `attachedArtifacts` の破棄、stopped の状態）。B の Task には「別の操作の停止のため、Computer Use が止まった」と返す。
- 他に生きた owner がいる場合は、すぐには終了させず、通常の close の期限（今の 10 秒）を 1 回待ってから終了させる（§3.1 の 1）。

## 3. 変更

### 3.1 Main

1. Stop の手順を「cancel → close（期限 C）→ 期限内に receipt が無ければ helper を終了 → signaled を待つ（期限 T）→ §2.2 の判定」にする。**C は、実測するまで今の 10 秒（1 回目の close の期限）のままにする。** 健全だが忙しい helper を誤って終了させると、確定できたはずの入力が「効果不明」になり、他のセッションも止まり（§2.5）、再起動では Electron の main thread で同期の PowerShell の署名確認（`execFileSync`、最大 10 秒）が走る。#820 の記録では、UIA 呼出し 1 回の最悪が 800 ms、素の `ElementFromHandle` が 1028 ms だった。S1 で、負荷とキューのある健全な helper の close の所要時間を測り、その分布から C を決める。T は 2 秒を目安にする。
2. 終了で確定したセッションは、その helper に結び付く token（target / app / session / artifact）と承認 ticket をすべて失効させる。Main の token と session id は `randomUUID` で発行されるが、それだけでは古い token は失効しない。Windows の client には `helperGeneration` があるが、host と controller はそれを token の失効に使っていない。**これを広げて、host・controller の token と ticket を世代に束縛する**（親 ADR §10 は既存の契約のように書いているが、helper 終了に連動した失効の実装は無い）。
3. 新しい helper の最初の操作は `list_targets` か再観測にする。終了の後の最初の観測は、短い待ち（settle）の後に行う（§3.3 の、job で止められない起動の窓が開きうるため）。
4. 未確認の入力は「未確認のまま終わった」と記録し、再送しない。モデルには「最後の操作は後から反映されるかもしれない。画面を見直す」と返す。
5. **終了を確認した世代の隔離の解除は、すべての隔離元に対して行う。** `activeStopQuarantines` だけでなく、client の semantic owner（`ensureConnected` はこれが未確認の間 helper を起動しない）、client の `discoveries`、host の `discoveryManager.quarantined()`、`startOwners`（`attempts` / `terminal === null`）。どれか 1 つでも残ると、終了の後も永久に隔離される。ただし、§2.2 の `terminated_target_suspect` に該当する対象の隔離は保ち、`termination_requested` では解除しない。
6. **終了中の child を世代ごとに保持する。** 今は `abortTransport` が `this.child = null` にするため、exit listener が `this.child !== child` で早く return し、Main は自分の kill の終了を観測できない。また `ensureConnected()` は socket が null で未確認の semantic owner が無く、接続中でもなければ `connect()` で新しい helper を起動するので、古いセッションへの close の再送が新しい helper に届き `session_missing` になりうる。終了中の child が `exit` するまで、`pickApplication` を含むすべての操作を止める。古いセッションの Stop を新しい世代へ送らない。
7. Main を終了するときは helper も終了させる。helper の通常終了経路は、`DrainWindowsSemanticInputForExit` で claim 済みの入力を、`DrainWindowsDiscoveryLaunchesForExit` で claim 済みの launch の検証または失敗した子の実 exit を待つ。一方、再起動した Main は古い helper の隔離の状態を持たない。固まった古い helper が Main の再起動の後も残りうることを §5 に書く。


### 3.2 helper

- Stop の応答性のためだけにある仕組み（作業スレッドの枠、取消しの別名、cleanup 後の候補採用、`CancelSynchronousIo` の試行）は新しく足さない。既存のものは S4 で、入力の安全に要るものだけを残して整理する。
- 残すもの: 入力直前の再検証（identity、foreground、geometry、cancel epoch）、入力 unit の claim と attempt の記録、`semantic_input_in_flight`、§2.4。
- 健全な helper では今どおり receipt で確定する。ただし close は `ServePipe` の単一キューで処理される。reader は `stop_serial` と cancel epoch の更新に加え、開始・discovery の受付や停止 latch も行うが、close の応答は consumer が処理する。close は処理中の frame と、それより先に受け付けた待ち frame の後ろに並ぶ（待ちキュー全体の上限は 64 件）。discovery 待機中には別 owner の `stop_window_discovery` を先に処理する例外がある。
- helper の dispatch 結果の cache（`requestId` ごと、二重入力防止）は終了で失われる。これが安全なのは、その helper の上のセッションをすべて捨てるときだけである（§2.5）。

### 3.3 子プロセスと一時資源

- **検証済みの子は、helper の終了で殺さない**（親 ADR §10 #940 の「検証済みアプリの起動は巻き戻さない」と同じ）。 AI が起動したアプリをユーザーが使っていれば、未保存の作業が失われる。今の `LaunchVerifiedExecutable` も検証済みの子は残し、未検証の子だけを終了させている（`computer_use_windows_host.cc` の `OwnedChild`）。
- 今の `LaunchVerifiedExecutable` は `CreateProcessW` を suspend せずに呼び、その後で image を検証する（`computer_use_windows_host.cc:3982`）。この間に helper が終了すると、未検証の（すり替えられたかもしれない）子が動いたまま残る。起動は `CREATE_SUSPENDED` と `PROC_THREAD_ATTRIBUTE_JOB_LIST` で、起動ごとの `KILL_ON_JOB_CLOSE` の job に作成時点から入れる（作成後に `AssignProcessToJobObject` すると、その間に helper が終了したとき子が逃げる）。image を検証した後で limit を外し（`SetInformationJobObject`）、`ResumeThread` する。helper が検証前に終了したら、一度も実行していない子だけが終わる。rename 追従の probe の子も同じ方式にする（現行の `computer_use_windows_host.cc:1735` は `CREATE_SUSPENDED` だが、job への割当ては作成後の `AssignProcessToJobObject`）。
- Node が helper を入れている libuv の job が `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK` を持つかを、S3 の前に libuv の `src/win/process.c` で確かめる。持つなら、helper の子を job に入れるのは、継承ではなく上の明示の指定でしか成り立たない。
- **job で止められない起動がある。** Windows 11 の notepad / calc は DcomLaunch・ApplicationFrameHost・RuntimeBroker が起動するパッケージアプリに引き継ぐ。Chrome や Electron などの single-instance のアプリは、既に動いているプロセスへ転送する。これらは Stop の確定の後にウィンドウを開き、フォーカスを取りうる。§3.1 の 3 の settle と、次の観測での通常の判定で受ける。残るリスクとして §5 に書く。
- job の終了も非同期なので、子が消えたことは `JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO`（または ActiveProcesses = 0）で確かめる。一時フォルダの削除は、probe の exe がまだ lock されている場合に備えて再試行する。

## 4. スライス（PR の単位）

| #（#988 のノード） | 内容 | 依存 | 試験 |
| --- | --- | --- | --- |
| S1（N2） | 応答しない helper の試験装置。テスト用の build flag で、指定した要求の中で永久に待つ（UIA 呼出し、`CreateFileW`、capture、WinVerifyTrust の各所）。Main の Stop がどこで止まるかを固定する | この ADR 内ではなし | CI の Windows live seam。cancel と close 2 回が期限切れになると Host の `native_stop_unconfirmed` を受け、Controller が約 21 秒の native 待機後に `native_unavailable` とすることを固定する。transport は §1 の条件下で最初の close から約 40 秒で kill し、未確認の semantic 入力や discovery がある場合は kill しないことも固定する。あわせて、健全で忙しい helper の close の所要時間を、負荷とキューのある状態で測る |
| S2（N3） | Main: 終了による確定（§2.2 の 3 状態）、S1 の実測にもとづく close の期限 C の決定（実測までは 10 秒のまま）、すべての隔離元の解除、token の一括失効、再起動後の再観測の強制 | S1（N2）・S3（N4） | S1 の装置の全箇所で、Stop が C + T 以内に確定し、次のセッションが始められること（§2.2 の対象隔離と `termination_requested` の例外を守る） |
| S3（N4） | helper: §3.3 に従い、起動ごとの `KILL_ON_JOB_CLOSE` の job に `CREATE_SUSPENDED` と `PROC_THREAD_ATTRIBUTE_JOB_LIST` で子を作成時点から入れる。検証後に limit を外して resume する。probe も同方式とし、子の終了を確認する。一時フォルダを helper ごとにし、libuv の job の breakaway を確認する | この ADR 内ではなし（S2 より前） | launch の検証前に helper が終了しても未検証の子が残らず、検証済みの子は巻き戻されないこと |
| S4（N5） | helper: Stop のためだけの仕組みの整理（#940 の残り、#820 の残件のコード側を扱う） | S2（N3）・S3（N4） | 既存の native seam の入力安全の試験が全部通ること |

この表は kill-stop 内の依存を示す。S1（N2）・S3（N4）は並行でき、S2（N3）は両方の後、S4（N5）は S2 の後に置く。S2 が helper の終了を通常の Stop にする前に、未検証の子が残らないよう起動を suspend と job で守る必要があるため、S3（N4）を S2（N3）より先に入れる。

## 5. 残るリスク

1. `termination_requested` のまま signaled にならない環境（壊れたドライバ）では、終了を確認できるまで隔離を保ち、新しい helper は起動しない。Main を再起動しても、通常終了の drain で固まった古い helper が残る可能性があり、再起動を安全な復旧の証拠にはしない。頻度は実機で測る。
2. 終了の前に発行された UIA pattern の呼出しと、積まれた `SendInput` は、Stop の確定の後に対象で実行されうる。`terminated_target_suspect` で、その対象への再開を止めることで受ける。対象が固まったままユーザーが自分で操作すると、遅れて実行された入力と混ざりうる（今も同じ）。
3. helper の再起動のたびに、署名検証や context の初期化のコストがかかる（初回の `list_targets` が数秒）。Stop が頻繁なら体感が落ちる。
4. macOS には適用しない。macOS の Stop は今の serial lock の方式のまま。両 OS の Stop の確定の仕組みが異なることを、受入の記録に明記する。
5. job で止められない起動（パッケージアプリへの引継ぎ、single-instance への転送）は、Stop の確定の後にウィンドウを開き、フォーカスを取りうる。

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
