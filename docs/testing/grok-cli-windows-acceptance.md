# Windows実機: Grok CLI受入テスト

2026-09-22ユーザー指示: 実Grokが使えるかはWindowsの別PCで検証する。
この文書は未実施のテスト計画。mock、Macの単体テスト、CLI単体の応答だけでPASSにしない。

## 実行環境と記録

- 実装PR `codex/grok-cli` の対象commitを取得し、SHA・未コミット差分・アプリversionを記録。
- 実Grok試験では `SPRINT_CODER_E2E_CLI_FIXTURES` を未設定にする。
  `SPRINT_CODER_TEAM_CODEX_ONLY` も未設定にし、mock応答やCodexへの代替でPASSにしない。
- Windows x64、Node 22、公式xAI Grok Build 1.0.40以上の1.x。
  `Get-Command grok -All` と `grok --version` で実体を確認する。
  同名の非公式CLIは対象外。通常の公式インストール先は `%USERPROFILE%\.grok\bin\grok.exe`。
- 公式CLIのログインはWindows利用者が行う (`grok login`)。
  認証情報、環境変数一覧、prompt/responseの全文をIssueへ貼らない。
- 対象checkoutから開発版を起動し、最後に同じSHAから作ったWindows packageでも主要経路を確認。
  配布用署名やrelease公開はこのテストの作業に含めない。
- GUI操作はWindowsの対話セッション上のCodex/Computer Use等で実行。
  実アプリの設定・Composer・承認カード・Timelineを操作し、対象アプリが見える状態で確認する。
- 通常利用のデータとは別の試験profileと、repo外の使い捨てWorkspaceを用意する。
  `C:\Users\<user>\Grok受入 test\` のような日本語・空白入りパスも試す。
- 各行をPASS/FAIL/SKIPで報告し、SKIP理由、Task ID、所要時間、証拠ファイルを記録。

## 操作と合格条件

| ID  | 操作                                                            | 合格条件                                                                                                                                                  |
| --- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G01 | Grok未導入の試験環境で設定を開く                                | Grok CLIが利用不可と表示され、Codexへ誤接続しない。既存Claude/Codexは利用可能。                                                                           |
| G02 | 公式CLI導入後、未ログイン状態で起動                             | ログインが必要と表示。背景probeが勝手にブラウザーを開かない。Windowsで黒いconsoleが出ない。                                                               |
| G03 | `grok login`後にアプリ再起動。設定→Grokを選ぶ                   | 正しい実行パス・versionが表示され、CLI由来モデルを選べる。APIキー入力は要求されない。                                                                     |
| G04 | Grokで短い日本語質問を送信                                      | 実モデルの逐次応答、正常完了、Grok/xAIの選択表示。二重表示や空の成功扱いがない。                                                                          |
| G05 | 同じTaskで直前の回答に関する追加質問                            | 会話履歴を踏まえた回答になる。別Taskの内容が混入しない。                                                                                                  |
| G06 | 隔離Workspaceに下記の小さな実装を自然文で依頼                   | Mainのツール経由で実ファイル作成・既存ファイル変更・read_fileによる読戻しが行われ、Timelineと実ファイルが一致。独立した新規Task/Workspaceでもう一度実施。 |
| G07 | G06の検証コマンドをAskモードで実行                              | 承認カードに対象と引数が表示され、許可後に実プロセスが動きexit 0。60秒以上承認待ちしても誤timeoutしない。                                                 |
| G08 | 別のコマンド要求を拒否                                          | 実行されず、拒否を受けてGrokが継続・説明できる。成功と報告しない。                                                                                        |
| G09 | Read-only Taskで変更依頼、Workspace外への変更依頼               | 権限・path guardが機能し、未許可の実ファイル変更がない。                                                                                                  |
| G10 | 長めの応答中・承認待ち・実行中コマンドでStop                    | Turnが停止し、Grok/bridge/commandの子プロセスが残らない。直後の新しいTurnが正常に動く。                                                                   |
| G11 | Grok/Claude/Codexとモデルを切り替え、アプリ再起動               | Providerごとの保存モデルとTask選択が保持される。GrokにClaude/CodexのEffortが渡らない。既存Taskは開ける。                                                  |
| G12 | GrokをTeam Workerとして明示採用し、小さな読取/編集作業を依頼    | WorkerがGrokで実行し、Mainの権限内で実ファイルを扱い、報告・Team完了まで到達。接続名と実行Providerが一致。                                                |
| G13 | GrokをLeaderにして2 Workerへ独立作業を割当                      | 実MCP経由の採用・割当・待機・報告・統合が完了し、未終端Workerを放置した完了にならない。                                                                   |
| G14 | 通信遮断・失効した試験用認証・CLI起動失敗をそれぞれ試す         | boundedな時間で失敗表示、成功扱いなし、UIは復帰可能。認証エラーに再ログインの案内がある。rate limitは実際に発生した場合に確認し、発生しなければSKIP。     |
| G15 | CLIユーザー/Project設定に無害なcanary hookとダミーMCPを置き試験 | Sprint Coder起動ではcanary hookが動かず、ダミーMCPが実行されない。実WorkspaceのAGENTS/SkillsはSprint Coderの封入経路からのみ届く。                        |
| G16 | Grok完了/失敗/停止後に診断を確認                                | credential/prompt/file本文の漏洩がなく、不要な隔離sessionが残らない。任意の環境変数や他ProviderキーがGrokへ渡らない。                                     |
| G17 | packaged WindowsアプリでG03/G04/G06/G07/G10/G11を再実行         | 配布相当のNode/MCP/native境界でも成功。開発版のPASSで代替しない。                                                                                         |

G06の依頼例（ファイル名を毎回変え、証拠の使い回しを防ぐ）:

> このフォルダーに整数配列の合計を返すJavaScript関数sumをsum.cjsとして作ってください。
> 空配列、負数、日本語ラベルを含むテストをsum.test.cjsに追加してください。
> 既存README.mdに使い方を追記し、作成・変更したファイルを読み返してください。
> Nodeのテストを実行し、失敗したら修正してください。

検証時は実際の `node.exe` の絶対パスと `--test --test-isolation=none` を使用する。
テスト後にPowerShellの `Get-FileHash` とファイルの内容を確認し、AIの完了文だけを根拠にしない。

## 結果提出

G15では、`use_tool` の `tool_input_file` / `file` にWorkspace外の架空canary JSONを指定する
ケースも含める。CLIのRead拒否が働き、未承認ファイルの内容がツールやモデルへ渡らないことを確認する。
通常の `tool_input` によるMCP呼出しとMain側のファイル読取は引き続き利用できること。

Issueコメントに、対象SHA、Windows/CLI/Node/app version、起動方式、各IDの結果表、
伏せ字済みUI画像、編集前後のhash、command exit code、停止後のプロセス確認をまとめる。
失敗は再現操作・期待値・実際の結果・安全な診断metadataを残し、原因が異なる場合のみ別Issue化する。
G01〜G17の必須経路に未確認/FAILがある間は「Grok実機受入完了」としない。
