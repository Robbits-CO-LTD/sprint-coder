# #1002（#988 N2）今の Stop の挙動と、close の所要時間の目安（kill-stop ADR §4 S1 の記録）

記録日: 2026-11-02。記録者: 親（Claude）。N3（S2）が close の期限 C を決めるときの根拠にする。

## live seam の結果（この PC: Windows 11 10.0.26200、20 スレッド、`computer-use-windows-hung-helper-live-seam.test.ts`、`SPRINT_CODER_HUNG_HELPER_SEAM=1`）

| 場面 | 結果 |
|---|---|
| 自作の fixture の start が WinVerifyTrust で固まる（transport から直接 stop_pending_start） | 約 33 ms で `closed`。helper は約 38 ms で終了 |
| 自作の fixture の start が CreateFileW で固まる | 約 32 ms で `closed`。helper は約 37 ms で終了 |
| discovery の CreateFileW で固まる | 約 1 ms で `stopped`。未確認の discovery があるので kill しない |
| Controller を通す session の無い discovery の CreateFileW で固まる | 約 31 ms で `stopped`。kill しない |
| session が要る 7 件（Controller の開始待ち 2、UiaCall、Capture、claim 済みの semantic 入力、close の後の discovery の保持、忙しい close） | NOT_RUN（`classic_notepad_not_eligible`。この PC でも CI の windows-2022 でも System32 のメモ帳が full_access_app にならない）。fake timer の基準（`computer-use-windows-transport.test.ts` の「kill-stop (N3) replacement baseline」、#1005）で固定済み。実機での固定は N13b か、署名済みの受入 fixture が使える環境に持ち越す |

「close の期限切れで最初の close から約 40 秒後に kill される」経路は、今の hook 点からは live で届かない。N2-1 の fake timer の基準で固定済み。

## close の所要時間の目安（proxy）

session が要るので close_session そのものは測れない。代わりに、healthy な helper に session の要らない discovery 8 件と fixture の start を流し（queue 10 frame、64 未満）、その start への stop_pending_start の往復を 30 回測った。

```
HUNG_HELPER_STOP_LATENCY_PROXY {"proxy_for":"close_session","operation":"stop_pending_start","n":30,"p50_ms":10.78,"p95_ms":13.41,"max_ms":13.54,"load_frames":8,"queued_frames":10,"min_unanswered_at_send":7}
```

送った時点で、答えの返っていない負荷の要求が毎回 7 件以上あった。close_session の実測は、session が使える環境（N13b など）で取り直す。N3 は、今の C（10 秒）が、この目安（最大約 14 ms）に対して 3 桁の余裕を持つことを前提にしてよいが、実際の close の分布での確認は残る。
