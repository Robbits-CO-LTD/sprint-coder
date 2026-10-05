# Issue 716: Graph Electron bridgeの失敗を分類できるようにする

base: main `02594d0a18b01ca91abf439af84b09aa2d926982`。
実装者: Main Codexのみ。branch: `codex/issue-716-graph-bridge-diagnostics`。
2026-10-01、初回全37件グラフへのユーザー「続けてやりなさい」で再開承認。
#654 / PR687をCI待ちの保留にし、既存#716を1件だけ進める。

## 受入条件と範囲

- 同じWorkerのIDに結び付いた状態を検証する。登録順とsnapshot順を混同しない。
- complete / other-execution / other-worker / ready-participantを、作成時刻による両取得順で検証する。
- child assertion失敗、timeout、RPC失敗を区別できるbounded metadataを残し、元の失敗を成功にしない。
- 既存child coverage、native/SQLite/Git実行、180秒（Windows300秒）と各case deadlineを維持する。
- raw stdout/stderr、エラーcause、private fixture content、実パスを診断へ転記しない。
- 全必須CI / 最新独立レビュー / merge先main CIを確認。実配布物の受入は別Issueの条件。

許可ファイル: graph-mission-persistence.test.tsと本Issueの記録のみ。製品Coordinator、DB契約、transport、CI設定、native artifact sourceは変更しない。
初回180秒timeoutを負荷や今回の順序不一致と同一原因に断定しない。timeout診断改善をtimeout解消と呼ばない。
attachments_viewed: 0/0 (NO_ATTACHMENTS)、Issue716/654とPR687の全コメント・レビュー添付collector実行済み。

## RCA

順序不一致: Root Cause Confirmed（A/B/C/D YES）。
製品getTeamSnapshotはpersistence.ts:9322でdepth, created_at, id順。登録は同ファイル9544付近で現在時刻とUUIDを使う。テスト3255行は登録順の状態配列と比較していた。
CI attempt2はready,done vs done,ready。実Electron43.5.0 / SQLiteで同じ4casesのbaseline PASS後、test-owned DBの作成時刻だけ逆転させるとother-executionとready-participantがFAIL。役割bはwaiting/ready、役割aはdoneで正しかった。
代替原因: Coordinatorが誤ったWorkerを完了する説は、role/stateの実観測とID所有の製品ループから除外。raw transport変更はGraph sourceに含まれず、baseと同一source。
修正: expected ID→state Mapと全Worker件数を比較する。sortも製品取得順変更も不要。

初回timeout: Hypothesis only。CI36859600946 attempt1 child180125ms、同source main152642ms。原因の段階別計測は不足。終了code/signal/killed、verbose完了caseの集約metadataとbounded JSON countsを安全に残し、次の失敗で故障境界を分類する。

## 設計確認・検証・rollback

design-review-checklistの関連観点を適用: 登録→SQL snapshot→CoordinatorのID所有ループ→testの位置比較を読解。型/API/DBは不変。case4種と取得順2種、成功/失敗/timeout/診断redactionを検証する。UI/CSS/Provider/RESTは非対象。
最小検証: reverse-order REDの同条件で全8cases GREEN、診断のprivacy/failure/timeoutテスト、実Electron Graph child全suite、desktop typecheck、変更lint/format/diff。適格な外部read-onlyレビューとhosted全OS CI。
同一Macの既存Electron43.5.0 / SQLite / NativeSafeFs artifactをコピーしロード確認。npm ci --ignore-scripts --offline。local native rebuild/headers取得はしない。既存artifact使用はhead native build証明ではない。
rollback: 本test-only commitをrevert。製品/DB migrationへの復旧操作は不要。

## Macでの診断追補（2026-10-05）

- base: main b6ea96c7、branch: codex/issue-716-mac-bridge。今回はMacで修正できる作業の再開指示。merge/closeは依頼範囲に含めない。
- CI37187024010 attempt1は123 PASS後にkillされ、既存2case markerの対象外。局所診断が欠ける原因は確認済み、aggregate timeoutは引き続きHypothesis only。
- 修正範囲にtest-only graph-bridge-progress.tsと直接テストを追加。全caseの開始・cleanup・終了、digest、件数、real clock時間だけを記録する。既存markerと期限は維持。
- 未計測caseの診断欠落をREDで再現。変更後の直接テストとdesktop typecheckはPASS。実Electronの全caseとsnapshotの件数照合、独立review、latest-head CIを確認する。
- このworktreeはNode22でnpm ciとprepare:desktopを実施。過去検証のartifactコピーとは別の今回のbuild。
- attachments_viewed: 0/0 (NO_ATTACHMENTS)。
