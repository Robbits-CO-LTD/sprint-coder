# 非Computer Useの4件の修正と統合

元の調査・UI受入snapshotのbase: `d8f27656de9fbf618f046ff35f91d6cc85db37eb`。以下は当時の受入証拠で、最終統合の各PRのCIとは分ける。

- #1157: 送信受付と先行添付読込みを決定論的に交差させて再現。受付epochで再照合し、イベント未購読時はstart応答とsnapshot後の読込みで補う。未送信添付とTask分離を保持。
- Graph診断: workerの例外・check結果・Main・API Providerを通る失敗経路を確認。許可済みコードだけをbounded IPCで渡す。生の図・パス・例外messageは診断に使わない。
- Project識別: APFS永続witnessを登録用途だけに追加（migration106）。実行時dev/ino sealは不変。未証明legacy登録は自動再承認しない。同一パス再リンクの保存とnative確認、既存参照保持も対象。
- #1137: **Root Cause Confirmed（同じparent破棄を起こす試験側の競合）**。fixture内8秒watchdogのapp.exit(2)が、AbortSignal後のsheet完了通知より先に親を破棄する。完了continuationが失敗reportと終了codeを成功で上書きしていた。fixture内watchdogを除去し、既存の親execFile15秒timeoutへ一本化した。


統合: 本人の追加指示によりPRを1件ずつmergeする。画像添付・取消試験・CI停止返答の修正はPR #1158、Project識別はPR #1160、Graph診断はこの変更へ分けた。全変更の元snapshotは `codex/non-cu-complete-snapshot-20261106` (`f6a8b1a1`) に保持。Computer Useの機能開発、実Provider課金、既存profile変更、リリースは対象外。mergeを妨げたStop返答のadministrative leaseだけはPR #1158で最小修正し、Windows native回帰の負例・新規・再送をCIで確認した。

最小証明: 各失敗の回帰試験、APFS native・SQLite reopen/migration・権限拒否、graph実worker/IPC/Provider、型検査・lint・関連CI。UIは`ui-checks.json`へ別記し、unit成功を代用しない。

独立レビュー: 設計6観点（添付、永続識別、Graph、dialog RCA、起動/参照、Graph契約）と実装安全性レビューを実施。検出した未購読添付・同一パス再リンク・参照ID保持・APIの診断消失を修正。#1137はタイマー所有と失敗報告上書きの観点でも独立レビュー済み。

## 現時点の検証

- Node22.23.1/macOS arm64、Electron43.5.0。全workspace型検査、変更TS/TSXのlint/format、prepare:desktopは成功。
- 関連desktop境界試験15ファイル成功（SQLite/Electron bridge内の試験を含む）。contracts/domainも成功。POSIX/Windows専用等の既存skipを成功へ含めない。
- 実vendorの同座標ノード→workerのlayout/constraint、Mainのfailed exit/ACK、API Providerの失敗formatterを検証。
- `ui-checks.json`の通常UIはCUAで確認。制御した添付raceのGUIもPASS。#1137も元watchdogを残した8100ms停止ケースでRED、watchdog除去だけでGREENを確認。
- #1137のparentAlive assertion、外部15秒期限、Vitest20秒期限は保持。hidden/visible/visible-focusable/stalledの4ケース成功。製品のダイアログ実装に推測変更は加えていない。

添付raceの実機証拠: capability応答を4500ms遅延させ、送信のHTTP推論開始がその応答より先になった時刻を照合。後着後もdraft0件・次の送信成功。詳細はui-checks.json。

## #1137の原因と反証

- 同じ8秒watchdogを残し、native fixtureのabort timer設定後に8100msだけUI threadを停止すると、元CIと同じ`aborted=true / pendingBeforeAbort=true / response=0 / parentAlive=false`で失敗（`npm test --workspace @sprint-coder/desktop -- src/main/full-access-confirmation.native.test.ts -t stalled`、exit1）。watchdog除去後は同じ入力でparentAlive=true、exit0。
- 独立した短縮実験でも、期限切れwatchdogの900/1100/1300msで同症状を3条件再現し、同じ1100ms停止でwatchdogを無効にした対照は親が生存。観測順はabort→abort復帰→watchdog→親closed→answer→成功上書き。
- 外部execFileのtimeoutは子のUI threadとは独立し、期限切れは親側でrejectする。子が後からreportを書いても成功にならない。
- 根拠: 元CI [run41909320726/job126852914663](https://github.com/Robbits-CO-LTD/sprint-coder/actions/runs/41909320726/job/126852914663)、現行native回帰試験。過去CIにはwatchdog発火traceがないため、当時も同一原因だったという帰属は推論。別原因を含む全てのmacOSウィンドウ問題の解消は主張しない。

Graphの10変更ファイルは元の受入snapshot `f6a8b1a1` と同一の内容で移植する。元の隔離GUIで正常な図と重複座標エラーのモデル到達を確認し、分割先でも実vendor/worker/IPC/Providerの関連5ファイルと全workspace型検査、scoped lint/formatを通した。
