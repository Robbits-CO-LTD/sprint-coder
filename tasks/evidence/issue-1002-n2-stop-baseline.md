# #1002（#988 N2）今の Stop の挙動と、close の所要時間の目安（kill-stop ADR §4 S1 の記録）

記録日: 2026-11-02。記録者: 親（Claude）。live で固定できた範囲と、N13b へ持ち越した範囲の記録。close の期限 C は、close_session の実測（N13b）まで今の 10 秒のまま。

## live seam の結果

この PC（Windows 11 Home 10.0.26200、20 スレッド、Node 22.23.3、MSVC 2022 Build Tools）で 2026-11-02 に 2 回続けて回した（`computer-use-windows-hung-helper-live-seam.test.ts`、`SPRINT_CODER_HUNG_HELPER_SEAM=1`。2 回目は `CI=true`）。数値は 2 回の範囲。

| 場面                                                                                                                                      | 固定の仕方                                                                                                                                                                                                                                                                     | 結果                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| 自作の fixture の start が WinVerifyTrust で固まる（transport から直接 stop_pending_start）                                               | live（session 不要）                                                                                                                                                                                                                                                           | 約 17〜33 ms で `closed`。helper は約 22〜37 ms で終了                                                    |
| 自作の fixture の start が CreateFileW で固まる                                                                                           | live（session 不要）                                                                                                                                                                                                                                                           | 約 32 ms で `closed`。helper は約 36 ms で終了                                                            |
| discovery の CreateFileW で固まる                                                                                                         | live（session 不要）                                                                                                                                                                                                                                                           | 約 1.3〜1.4 ms で `stopped`。未確認の discovery があるので kill しない                                    |
| Controller を通す session の無い discovery の CreateFileW で固まる                                                                        | live（session 不要）                                                                                                                                                                                                                                                           | 約 32 ms で `stopped`。kill しない                                                                        |
| session が要る 7 件（Controller の開始待ち 2、UiaCall、Capture、claim 済みの semantic 入力、close の後の discovery の保持、忙しい close） | NOT_RUN（`classic_notepad_not_eligible`。この PC でも CI の windows-2022 でも System32 のメモ帳が full_access_app にならない。CI ではこれ以外の理由の NOT_RUN も、NOT_RUN のケース名がこの 7 件の一覧と食い違うことも FAIL。CI でない環境では食い違いを 1 行のログに出すだけ） | 下の「session の場面の内訳」を参照。実機での固定は N13b か、署名済みの受入 fixture が使える環境に持ち越す |
| 忙しい close（close_session）の所要時間                                                                                                   | proxy（下の節）。close_session そのものは N13b へ持ち越し                                                                                                                                                                                                                      | 参考値のみ                                                                                                |

### session の場面の内訳

- transport 側の期限の経路（cancel と close の期限切れ、kill、未確認の semantic 入力や discovery があるときの保持、開始待ちの Stop）は、fake timer の基準（`computer-use-windows-transport.test.ts` の「kill-stop (N3) replacement baseline」、#1005）で固定済み。
- receipt を受けた close の後の idle teardown で未確認の discovery を保持する経路は、同じファイルの fake の transport の case（discovery の保持と遅延 teardown の case）で固定済み。
- 本物の helper の即答（UiaCall や Capture の worker が止まっている間の cancel と close、Controller の開始待ちの Stop がすぐ確定すること）と、忙しい close の分布は、どこにも固定されていない。N13b へ持ち越す。

「close の期限切れで最初の close から約 40 秒後に kill される」経路は、今の hook 点からは live で届かない。N2-1 の fake timer の基準で固定済み。

## close の所要時間の目安（proxy、close_session の実測までの参考値）

session が要るので close_session そのものは測れない。代わりに、healthy な helper に session の要らない discovery 8 件と fixture の start を流し（queue 10 frame、64 未満）、どの返事も読む前にその start への stop_pending_start を送って、往復を 30 回測った。負荷の 8 件は Main で発行して未応答のまま Stop より先に書く（`min_unanswered_at_send` は Main の側の見え方で、8 であることを assert する）。`load_answered_before_stop` は、Stop の返事と同じ pipe の読み取りまでに届いた負荷の返事の数。それだけでは helper の処理順の証明にはならず、同じ chunk の中の返事の順番は helper の直列の処理（consumer が discovery を待ってから次の frame に進む）に依る。数えるのは、Stop を送った時に負荷が 8 件とも未応答で（`no_load_at_send` でない）、その読み取りまでに 8 件とも返事が来ていて（`stop_before_load` でない）、start が helper に届いた（`start_not_sent` でない）回だけ。数えない回はやり直し、件数を `uncounted` に出す。数える回では、負荷の結果がどれも helper の返事（解決した結果か helper の error frame。Main で作った切断などの Error ではない）であることも確かめ、その内訳を `load_replies` に出す。cancel の段階と session の後始末は含まない。

2026-11-02 に数え方を上の条件に変えた後、この PC で 2 回回した値:

```
HUNG_HELPER_STOP_LATENCY_PROXY {"proxy_for":"close_session","reference_until":"close_session measured in N13b","operation":"stop_pending_start","n":30,"p50_ms":13.24,"p95_ms":14.63,"max_ms":15.87,"load_frames":8,"queued_frames":10,"load_answered_before_stop":8,"min_unanswered_at_send":8,"attempts":30,"uncounted":{"no_load_at_send":0,"stop_before_load":0,"start_not_sent":0},"load_replies":{"error:app_identity_changed":240}}
HUNG_HELPER_STOP_LATENCY_PROXY {"proxy_for":"close_session","reference_until":"close_session measured in N13b","operation":"stop_pending_start","n":30,"p50_ms":12.91,"p95_ms":13.65,"max_ms":14.34,"load_frames":8,"queued_frames":10,"load_answered_before_stop":8,"min_unanswered_at_send":8,"attempts":30,"uncounted":{"no_load_at_send":0,"stop_before_load":0,"start_not_sent":0},"load_replies":{"error:app_identity_changed":240}}
```

この値は close_session の実測（N13b）までの参考値であり、N3 の期限 C を決める根拠にはしない。C は実測まで今の 10 秒のまま。

## CI だけで起きた attestation の期限切れの診断（`HUNG_HELPER_ATTEST_DIAG`）

CI（head a832a1c3）では、暖機（`HUNG_HELPER_ATTEST_WARMUP`）は速いのに、helper を起動する 5 件すべてで製品の attestation（PowerShell、期限 10 秒）が ETIMEDOUT になった。attestation の間は Main の event loop が止まるので、seam は helper を起動する case ごとに別プロセスの見張り役（fixture の `--watch-attest`）を先に起こし、case の後に 1 行の `HUNG_HELPER_ATTEST_DIAG` を出す。中身は、helper ごとの現れた時刻と作成時刻（seam の spawn からの ms）、スレッドの状態と待ちの理由（Suspended かどうか）、セッション、job への所属、MainModule と同じ native の問い合わせの各段の ms、製品と同じ順の段（Import-Module、Get-Process、MainModule、File.Open＋SHA256、Get-AuthenticodeSignature）を製品と同じ環境の PowerShell で測った各段の ms（全体 60 秒）、見えた製品の attestation の PowerShell の PID と生存時間。見張り役は観察だけで、製品の attestation と期限は変えない（静的な case で確認）。この PC では、製品の attestation の生存時間は約 350〜430 ms、見張り役の段は Import-Module 約 28 ms、Get-Process 約 40 ms、MainModule 約 1 ms、SHA256 約 6〜15 ms、Authenticode 約 14〜24 ms。CI の値は次の CI の実行で取る。
