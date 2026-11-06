# Computer Use以外の4件

対象base: `d8f27656de9fbf618f046ff35f91d6cc85db37eb`。

- #1157: 送信受付と先行添付読込みを決定論的に交差させて再現。受付epochで再照合し、イベント未購読時はstart応答とsnapshot後の読込みで補う。未送信添付とTask分離を保持。
- Graph診断: workerの例外・check結果・Main・API Providerを通る失敗経路を確認。許可済みコードだけをbounded IPCで渡す。生の図・パス・例外messageは診断に使わない。
- Project識別: APFS永続witnessを登録用途だけに追加（migration106）。実行時dev/ino sealは不変。未証明legacy登録は自動再承認しない。同一パス再リンクの保存とnative確認、既存参照保持も対象。
- #1137: **Hypothesis only**。CI run41909320726 attempt1/job126852914663のparentAlive=falseを確認。手元の元条件・早期取消・表示条件計12試行では再現せず。取消前後の生存とlifecycleを試験へ追加。製品バグ解消は未主張。

非対象: Computer Use本体の変更、実Provider課金、既存profileの変更、merge/release、無関係なローカル変更。

最小証明: 各失敗の回帰試験、APFS native・SQLite reopen/migration・権限拒否、graph実worker/IPC/Provider、型検査・lint・関連CI。UIは`ui-checks.json`へ別記し、unit成功を代用しない。

独立レビュー: 設計6観点（添付、永続識別、Graph、dialog RCA、起動/参照、Graph契約）と実装安全性レビューを実施。検出した未購読添付・同一パス再リンク・参照ID保持・APIの診断消失を修正。#1137は未確定で保持。

## 現時点の検証

- Node22.23.1/macOS arm64、Electron43.5.0。全workspace型検査、変更TS/TSXのlint/format、prepare:desktopは成功。
- 関連desktop境界試験15ファイル成功（SQLite/Electron bridge内の試験を含む）。contracts/domainも成功。POSIX/Windows専用等の既存skipを成功へ含めない。
- 実vendorの同座標ノード→workerのlayout/constraint、Mainのfailed exit/ACK、API Providerの失敗formatterを検証。
- `ui-checks.json`の通常UIはCUAで確認。制御した添付raceのGUIと#1137原因確定はBLOCKED。
- #1137のparentAlive assertionは保持。非表示/表示/表示かつfocus可能の試験に取消前の生存とlifecycleを加えた。製品への推測修正はしていない。
