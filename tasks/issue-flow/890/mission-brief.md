# Issue #890: 権限変更後の停止確認

- 対象: #890。base: eb2d131557306a10b6bdaa2bc4ae836732056af2。
- 成果: 権限変更を保存後、コマンド停止の確認まで配送済みにせず、未確認は未配送で保持して画面へ失敗を返す。
- 変更: Task停止の既存/新規terminationUnconfirmed確認、IPC coordinatorのPromise伝播、初回/同一operation再送のdrainと公開エラー、Task/current epoch別の配送と初回に固定した停止対象の再確認。
- 非対象: DB/schema、Computer Use動作、OS停止アルゴリズム、権限ポリシーの緩和、release。
- 受入: deferred cleanup中はoutbox pending。既存/停止中の未確認は拒否。保存済み制限・新規tool epoch拒否・再配送・画面の権限再取得を維持。通常停止と別Taskは維持。A停止失敗がB配送を妨げない。古い通知をcurrent epochへ集約し、同epoch再送は新しい活動を取り消さない。新epochの通知は旧cleanup待機に遅延させない。停止不能のフラグは既存どおり保持し、supervisor closeだけで解除しない。
- 検証: 対象session/broker/IPC/Renderer tests、desktop typecheck、対象lint/format、複数OS CI、独立レビュー、ReviewBOT。
- RCA: Root Cause Confirmed。session2ケースとIPC初回/operation replay2ケースで修正前FAIL。実OS停止不能はfault injectionで代替し、既存実プロセス正常停止testも実行する。
- attachments_viewed: 0/0 (NO_ATTACHMENTS)。
- リスク: cleanupはpolicy commit後のため失敗しても保存済み制限を戻さない。同一operation再送はcommitせずcleanupを再試行する。同一epochのinFlightのみ共有し、成功Taskだけ配送済みにする。CommandRunnerは変更せず、停止未確認を推測で解除しない。
- rollback: 対象commitのrevert。永続化形式変更なし。
- 許可: ユーザーのComputer Use以外のIssue消化依頼。PRは既存#905のmerge後に作成し、CI/reviewを確認してmerge/close。
