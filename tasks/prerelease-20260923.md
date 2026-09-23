# 0.7.0-beta.7

2026-09-23ユーザー依頼「インストーラー公開版して。次のbeta版」に基づき、beta.6公開後にmainへ入った
Grok修正を評価用ベータとして公開する。base 0.7.0は維持し、未使用番号beta.7を一度だけ採用する。

v0.7.0-beta.6以降の配布変更:

- #510: Grok Buildの応答中断とWorkspaceツール拒否を修正。(1) MCP利用中に混在する文字列JSON-RPC
  応答IDでACPストリームを中断していた不具合、(2) 裸の`Read` denyがpathlessの`search_tool`まで
  拒否していた隔離設定、(3) 並行ツールの先行承認で`waiting_approval`になると後続の承認要求を
  拒否していた永続層、の3点。

version更新はこのPRのみ（`apps/desktop/package.json`とlockfile）。配布・検証の方針は
`tasks/prerelease-20260922.md` のbeta.5の記載を引き継ぐ。

## 既知の未確認事項

#506の実機受入は継続中。実アプリでのテスト実行command承認の再試験と、G01〜G17受入表全体の
再実施は未完了。Grokの画像添付・固有Effort選択は未対応。#506とComputer Useの実機gateはcloseしない。

# 0.7.0-beta.8

2026-09-23ユーザー依頼「Grok関連issueをすべて消化してマージして次のバージョンのプレリリースして」に基づき、
beta.7公開後にmainへ入ったGrok関連の修正を評価用ベータとして公開する。base 0.7.0は維持し、未使用番号beta.8を一度だけ採用する。

v0.7.0-beta.7以降の配布変更:

- #518 (#515): Grokで選んだモデルが実行に反映されず常に既定のgrok-4.7で推論されていた。session/new後に
  ACPのsession/set_modelで束縛し、要求と実行モデルの不一致を成功扱いしない。
- #519 (#517): 見つかっているCLIの状態を確認できないとき、設定とComposerが「CLIが見つかりません」と誤案内していた。
- #520 (#512 / #513): Grok Buildの残高切れ(HTTP 402)を「接続を確認できませんでした」と誤表示していた。
  公開エラーRUNTIME_BILLING_REQUIRED、Grok専用の診断段階billing_error / rate_limitとhttpStatusを追加し、
  DB migration v95で保存できるようにした。
- #521 (#516): Grok Workerの成果が統合済みでもLeaderのTurnが「変更後のファイルを検証できなかった」で失敗していた。
- #523 (#514): Windowsサンドボックス内でWorkspace内のrequire/importがEPERMで失敗していた。
  サンドボックス経由の起動だけNodeへ`--preserve-symlinks`を与え、サンドボックス外のモジュール解決は変えない。

version更新はこのPRのみ（`apps/desktop/package.json`とlockfile）。配布・検証の方針は
`tasks/prerelease-20260922.md` のbeta.5の記載を引き継ぐ。

## 既知の未確認事項

- 各修正のpackaged実機確認はこのプレリリースの公開物で行う（#506の受入継続）。
- #512 / #513 の残高切れ402は、残高を故意に消費しないと実機で再現できないため、実機では未確認。
- 既定の`node --test`がWindowsサンドボックス内で終わらない件は別原因で#522（未修正）。
- #506とComputer Useの実機gateはcloseしない。

# 0.7.0-beta.9

2026-09-23ユーザー依頼「Grok関連のissueをすべて消化して」（合意した終了地点「マージ後にbeta.9を公開」）に基づき、
beta.8公開後にmainへ入ったGrok関連の修正を評価用ベータとして公開する。base 0.7.0は維持し、未使用番号beta.9を一度だけ採用する。

v0.7.0-beta.8以降の配布変更:

- #532 (#522): Windowsサンドボックス内で既定の`node --test`が`running`のまま終わらなかった。libuvが子プロセスの
  標準入出力用パイプ（`\\?\pipe\uv\`）をAppContainerで作れず無限再試行するため。終わらない形を承認前に
  `NODE_TEST_ISOLATION_REQUIRED`で理由付きで拒否し、`--experimental-test-isolation=none`（Node 22.8〜23.5）/
  `--test-isolation=none`（23.6以降）の置き場所を案内する。
- #534 (#516): 統合済みのWorker隔離で、読み返しの無い編集や削除・名前変更だけの編集があるとLeaderのTurnが
  「変更後のファイルを検証できなかった」で失敗していた。統合の直前に、MainがWorkerのEdit Sagaを
  隔離worktreeで検証して証拠を残す（動いているTurnのSagaだけ）。
- #535 (#528): Team Workerの実行時失敗で、エラーコード・失敗段階・HTTP状態が失われていた。試行ごとに
  v95と同じ規則で記録し（DB migration v96）、最新の失敗診断のコピーにも出す。課金不足
  （RUNTIME_BILLING_REQUIRED）では読み取り専用Workerを自動再試行しない。
- #536 (#527): ファイルを1件も書けなかったTeam Workerの実行が完了扱いになっていた。編集依頼が読み取り専用で
  動いた場合と、書き込みがすべてポリシーで拒否された場合を失敗として報告し、指示文は実際の書き込み範囲を書く。
  失敗した報告は完了の証拠にしない。
- #537 (#529): 失敗・中止で終わったTeam Workerの隔離worktreeが、変更がなくても残っていた。実行が終わり、
  Mainがruntimeの停止を確かめ、HEADがbaseのままでstatusが空のときだけ片付ける（DB migration v97）。
- #538 (#530): 再起動やTask切替のあと、モデルボタンに表示名ではなくモデルIDが出たままになっていた。
- #539 (#531): Projectメモリへの記憶を承認するカードが「external.open / requested resource」と表示されていた
  （表示だけの修正。capability・resource・判定は変えない）。

version更新はこのPRのみ（`apps/desktop/package.json`とlockfile）。配布・検証の方針は
`tasks/prerelease-20260922.md` のbeta.5の記載を引き継ぐ。

## 既知の未確認事項

- 各修正のpackaged実機確認はこのプレリリースの公開物で行う（#506の受入継続）。
- #528の残高切れ402はWorkerでは実機で再現しにくいため、模擬の402で確認する。
- 仕様判断の#525（確認するでWorkerが読み取り専用）・#526（安全時は自動の編集拒否）は起票のみで未変更。
- #506とComputer Useの実機gateはcloseしない。
