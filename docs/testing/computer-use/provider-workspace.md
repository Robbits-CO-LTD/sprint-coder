# 承認・Workspace・実Provider

[共通手順](README.md)。対象OS:macOS／Windows／Linux（各native runner/CLIが利用可能な環境）。実Provider項目は課金・credential・networkを伴い明示許可がある時だけ実施、許可なしはSKIP。macOS/Windowsの結果を他OSのPASSへ流用しない。WindowsのWorkspaceはAppData外に置く。モデルはアプリが起動するCLIの現在catalogをUIで選択し、fixtureの固定名を実機へ決め打ちしない。

実Providerの各操作はCUで送信/承認/停止する。shellは隔離fixture準備、ファイル・DB・process・redactedログの照合に使える。実応答だけで書込みやcommand実行を成功扱いにせず、各保存物を照合する。

<a id="approval-flow-01"></a>

## approval-flow-01

旧ケース: `tests/e2e/approval-flow.spec.ts` — denial is persisted and returned to the runtime without failing the Turn

- 前提: Mock approval_probe、Askの新規Task。
- 操作: 「承認テストをしてください」を送りキーボードで拒否。別Taskで今回のみ許可→再依頼を拒否。さらに別TaskでTask中許可→再依頼。最後に承認待ち状態で終了。
- 合格条件: カードはfocusを受けapproval_probe/https://example.testを表示。拒否でもTurnはcompletedで通常応答、カード消失。今回のみ許可は次回再確認。Task中許可は同Task次回にカードなし（1秒後もなし）だが別Taskではカードあり。承認待ちでも8秒以内に終了。
- 証拠・制約: 各決定前後/再要求の画面、終了時刻、保存decision。固定Tab回数を前提にせずボタン名へ到達する。

<a id="command-runner-flow-01"></a>

## command-runner-flow-01

旧ケース: `tests/e2e/command-runner-flow.spec.ts` — denies safely and then executes the exact approved command once

- 前提: 隔離WorkspaceをProjectへ割当、Mock「コマンドテスト」fixture、native runnerを対象OS用にbuild済み。
- 操作: Askでコマンド依頼を拒否、再依頼で今回のみ許可。出力展開→再起動。Autoへ切替し同高リスク依頼を今回のみ許可、再起動。
- 合格条件: 承認cardにrun_commandとWindows cmd.exe/他OS /usr/bin/printf。Tabはカード内で今回のみ→Task中→拒否の順。拒否後completed。許可は1回だけ実行し「変更の整合性を確認」/高リスク/exit0/command ok/数値durationを表示。出力展開でenvironment/PATH。出力pageはEOF、cursor>0、tail cursor一致、≤65536byte、他Taskから拒否。Autoも人へ確認し偽Auto判定を作らず、再起動後exited card計2、Auto group0。
- 証拠・制約: 画面・command件数/出力cursor/byte数・ownership境界テスト。環境の値全体や秘密をログへ残さない。

<a id="file-edits-01"></a>

## file-edits-01

旧ケース: `tests/e2e/file-edits.spec.ts` — writes nothing at the ask preset

- 前提: 隔離Project root、Ask、Mock。
- 操作: readmeを整える依頼を送って完了まで待つ。
- 合格条件: Inspector重複UIなし、Access Ask/unmanaged表示なし。回答は完了するがfile-change card0、rootに無許可変更なし。
- 証拠・制約: 完了画面とroot前後差分。

<a id="file-edits-02"></a>

## file-edits-02

旧ケース: `tests/e2e/file-edits.spec.ts` — records the edits at the auto preset, in the Turn that made them, and replays after restart

- 前提: 隔離root、Auto、Mock。
- 操作: parser修正を依頼し完了後同profile再起動。
- 合格条件: file-change cardにsrc/parser.ts、新規/変更。全pathはWorkspace相対で絶対pathなし。再起動でsrc/parser.tsを保持しcard1件だけ（replay重複なし）、元Turnに帰属。
- 証拠・制約: カードとfile/Turn metadata、再起動画面。

<a id="file-edits-03"></a>

## file-edits-03

旧ケース: `tests/e2e/file-edits.spec.ts` — keeps the manual file editor above the composer

- 前提: 隔離root内「日本語 file #1.txt」にCRLFの2行。
- 操作: OS pickerで開く→日本語複数行を編集→再読み込み→「編集に戻る」→保存。
- 合格条件: dialog/footerがComposerより上で操作可能。再読込警告「未保存の変更を破棄して再読み込みしますか？」で編集を勝手に消さない。戻るでalert消失、保存有効→「保存しました」。dialogはbody直下のportal。
- 証拠・制約: 画面・保存bytes/行末、portal補助確認。

<a id="cli-workspace-egress-01"></a>

## cli-workspace-egress-01

旧ケース: `tests/e2e/cli-workspace-egress.spec.ts` — real Codex dispatch succeeds with a composite Workspace root

- 前提: 実Codex利用の明示許可。複合階層root sprint-coder-patrol-20260905/workspaceをProjectへ割当、実CLI有効。
- 操作: Pickerで実際に利用可能なCodexモデルを選び「Reply exactly SC_EGRESS_OK. Do not use tools.」を送信。
- 合格条件: 90秒以内にcompleted、本文がSC_EGRESS_OKと完全一致。複合rootがegressで拒否されない。旧fixture指定モデルはgpt-5.5。
- 証拠・制約: 実CLI/接続/modelとroot metadata、回答画面。旧caseのvisible=false/focused=false条件はCUでは両立不可で別条件BLOCKED。課金許可なしはSKIP。

<a id="leader-mcp-codex-smoke-01"></a>

## leader-mcp-codex-smoke-01

旧ケース: `tests/e2e/leader-mcp-codex-smoke.spec.ts` — Codex drives two real Worker reports over MCP in the packaged app

- 前提: 実Codex+実Worker利用の明示許可、packaged app、simulated workers無効。
- 操作: Teamを開かず「1+1の答え」を数学/実装の2人体制で検討するよう依頼。活動summaryを展開し再起動。
- 合格条件: 自動でTeamとWorkerが現れ2以上の報告。役割が固定調査/実装/レビューのMock配列でなく報告もMock定型でない。回答は2/1+1を含み非空paragraph≥2。回答前の活動summaryは初期折畳みで展開可能。再起動後同paragraph件数/内容と折畳みsummary、両起動renderer error0。
- 証拠・制約: 実MCP/Worker実行metadata、画面と段落比較。本文/秘密を無制限ログへ出さない。

<a id="leader-mcp-smoke-01"></a>

## leader-mcp-smoke-01

旧ケース: `tests/e2e/leader-mcp-smoke.spec.ts` — team actions run over MCP and the canvas opens by itself

- 前提: 実Claude+実Worker利用の明示許可、simulated workers無効。
- 操作: Teamを開かず1+1を数学/実装の2人体制で検討するよう依頼。
- 合格条件: 5分以内にCanvas自動表示、1〜3role、報告≥2、固定Mock3役/定型報告でない。「読み取り専用プロファイルを逸脱」なし。最後に2/1+1を含む統合回答。
- 証拠・制約: 画面とMCP/実Workerのmetadata。

<a id="leader-mcp-smoke-02"></a>

## leader-mcp-smoke-02

旧ケース: `tests/e2e/leader-mcp-smoke.spec.ts` — a trivial question does not create a team (restraint)

- 前提: 実Claude利用の明示許可、別profile。
- 操作: 「1+1は?数字のみで答えてください」を送る。
- 合格条件: 2を回答し、Canvasなし、永続Teamもnullで不要な雇用なし。
- 証拠・制約: 回答画面と保存Team不存在。

<a id="real-ai-workspace-01"></a>

## real-ai-workspace-01

旧ケース: `tests/e2e/real-ai-workspace.spec.ts` — ${provider.name}: auto writes, edits, runs a command and restores after restart

- 前提: claude/codexを各別profile。実Provider明示許可。隔離git rootにREADME Original line.と小Node project、Auto。
- 操作: モデルへsc-created.txtにSC_CREATE_OK＋改行、READMEの対象行だけEdited by AI.へ変更を依頼。次にAutoとFullでNode commandからcmd-out.txt/cmd-out-full.txtを書かせnode --versionも実行。再起動。
- 合格条件: 両Providerでファイル全文と末尾改行一致、file card2path、SC_WRITE_DONE。command生成内容SC_CMD_OK:vX.Y.Z、回答SC_CMD_DONE vX.Y.Z。Autoは自動許可または承認cardから実行し恒久拒否しない。再起動後全user/answer/file card/command card一致、Full保持、running/queued/streamingなし。
- 証拠・制約: 実施行 provider=claude/codex。画面、disk bytes、command実行/承認audit、保存履歴前後。モデルの成功文だけでPASSにしない。

<a id="real-ai-workspace-02"></a>

## real-ai-workspace-02

旧ケース: `tests/e2e/real-ai-workspace.spec.ts` — ${provider.name}: ask denies writes on the card, then writes after approval

- 前提: claude/codex別profile、Ask、実Provider許可、隔離root。
- 操作: sc-ask.txt書込みとask-cmd.txtを作るcommandの要求をカードで拒否。続いてsc-ask-approved.txtとask-cmd-approved.txtの要求を今回のみ許可。
- 合格条件: 拒否側2file不存在/file card0、Turn completedかつ空でない応答。許可側cardが実際に出て、fileはSC_ASK_APPROVED、commandはSC_ASK_CMD、file cardにsc-ask-approved.txt、回答SC_ASK_APPROVED_DONE。
- 証拠・制約: 実施行 provider=claude/codex。許可/拒否カードとdisk、command metadata。

<a id="real-ai-workspace-03"></a>

## real-ai-workspace-03

旧ケース: `tests/e2e/real-ai-workspace.spec.ts` — ${provider.name}: leader hires two write-capable workers that each write a file

- 前提: claude/codex別profile、Auto、実Leader/Worker許可、git root。
- 操作: LeaderにwriteCapableのWriter A/Bを雇い各workspace-writeでteam-a.txt/team-b.txtを作るよう指示。Leader自身は書かず報告を待つ。再起動。
- 合格条件: Worker≥2/報告≥2、fileのtrim内容SC_TEAM_A_OK/SC_TEAM_B_OK、completed/SC_TEAM_DONE。再起動でWorker数・報告数一致、同回答が残る。
- 証拠・制約: 実施行 provider=claude/codex。file/isolated worktree/実行主体metadata、前後画面。

<a id="real-ai-workspace-more-01"></a>

## real-ai-workspace-more-01

旧ケース: `tests/e2e/real-ai-workspace-more.spec.ts` — ${provider.name}: team in ask surfaces worker writes as approval cards (allow A, deny B)

- 前提: claude/codex別profile、Ask、実Leader/Worker許可、隔離git root。
- 操作: Writer A/Bに上記2file書込み依頼。team-aのcardのみ許可、team-bのcardは拒否し別手段で再試行させない。
- 合格条件: 両書込みが承認cardに現れA許可/B拒否。A=SC_TEAM_A_OK、B不存在。timeoutなくcompleted、SC_TEAM_DONE A=OK B=DENIED。
- 証拠・制約: 実施行 provider=claude/codex。2カード/decisionとdisk、最終画面。

<a id="real-ai-workspace-more-02"></a>

## real-ai-workspace-more-02

旧ケース: `tests/e2e/real-ai-workspace-more.spec.ts` — ${provider.name}: stop while a command runs cancels promptly without orphans

- 前提: claude/codex、実Provider許可、Auto、隔離root。固有marker付きNode120秒待機command。
- 操作: 実command起動をprocessで確認しComposerの停止。次にtool不要でSC_AFTER_CANCEL_OKと返す依頼。
- 合格条件: 15秒未満でcanceled/停止消失。markerのcommandと子processの孤児なし。後続Turn completed/SC_AFTER_CANCEL_OK、after-sleep.txtは作られない。
- 証拠・制約: 実施行 provider=claude/codex。停止時間、PID親子/markerの前後照合、画面。単にRun表示だけ停止でPASSにしない。

<a id="real-ai-workspace-more-03"></a>

## real-ai-workspace-more-03

旧ケース: `tests/e2e/real-ai-workspace-more.spec.ts` — ${provider.name}: closing the app mid-command shows the turn as interrupted after relaunch

- 前提: claude/codex、実Provider許可、隔離root。Nodeでrestart-part1=P1を直ちに作り120秒後part2=P2のcommand。
- 操作: command起動中にアプリ終了、同profileで再起動して10秒観測。後続依頼SC_AFTER_RESTART_OK。
- 合格条件: 終了でcommand/子processが消える。user履歴保持、running/queued/cancelingなし。「中断」通知、command cardはcanceled/interrupted/failed等で実行中/成功ではない。停止UIなし、SC_RESTART_DONEを偽表示せずpart2不存在。後続完了。
- 証拠・制約: 実施行 provider=claude/codex。PIDとdisk、再起動状態/通知、後続回答。

<a id="real-ai-workspace-more-04"></a>

## real-ai-workspace-more-04

旧ケース: `tests/e2e/real-ai-workspace-more.spec.ts` — ${provider.name}: multi-folder project writes into both roots and refuses outside

- 前提: claude/codex、実Provider許可、root A/Bとその外のCを用意。A primary/B secondaryでProject作成、Auto。
- 操作: A/root-a.txt=SC_ROOT_A、B/root-b.txt=SC_ROOT_Bを依頼。続いて外C/outside.txt作成を要求し、cardが出たら拒否。
- 合格条件: 両rootへ書けSC_MULTI_DONE。outsideは不存在でTurn終端、SC_OUTSIDE_WRITTENを主張しない。
- 証拠・制約: 実施行 provider=claude/codex。Project設定、3root disk証拠、audit。

<a id="real-ai-workspace-more-05"></a>

## real-ai-workspace-more-05

旧ケース: `tests/e2e/real-ai-workspace-more.spec.ts` — ${provider.name}: Japanese answer with a code block and a Japanese + emoji file

- 前提: claude/codex、実Provider許可、Auto、隔離root。
- 操作: sc-ja.txtへ「こんにちは、世界 🌏✨」「日本語テスト：完了✅」の2行各改行、日本語メモ.txtへ「メモ🍣」＋改行を依頼。回答は行1〜30とconsole.log('こんにちは 🌏');のJS code block、末尾SC_JA_DONE。再起動。
- 合格条件: completed、UTF-8 BOM/置換文字なし、sc-jaは指定bytes完全一致、memo内容一致。回答に行30・SC_JA_DONE・code block、file cardsに両path。再起動回答完全一致。
- 証拠・制約: 実施行 provider=claude/codex。bytes比較とcode block/復元画面。CRLF正規化結果も記録するが完全byte一致を別に判定。

<a id="real-ai-workspace-more-06"></a>

## real-ai-workspace-more-06

旧ケース: `tests/e2e/real-ai-workspace-more.spec.ts` — ${provider.name}: graph mission with real workers writes files and completes

- 前提: claude/codexの実Worker許可。隔離git root、台本Leader/Graph fixture、client/api/store Workerは実Provider。完了条件は書いたfileのread-back一致と明示。
- 操作: bound Mission提案を承認→計画の参照確認→「この計画で開始」。必要なcardは今回のみ許可、終端まで待つ。
- 合格条件: Mission completed/execution3すべてcompleted。src/client.tsがexport const client = 'SC_CLIENT_OK';＋改行、src/api.tsがexport const api = 'SC_API_OK';＋改行。「すべての工程が完了」。
- 証拠・制約: 実施行 provider=claude/codex。UI・file bytes・各Worker実行metadata。台本Leaderの成功は実Leader証拠にはしない。

<a id="real-ai-workspace-more-07"></a>

## real-ai-workspace-more-07

旧ケース: `tests/e2e/real-ai-workspace-more.spec.ts` — grok: create + edit files when the picker offers a ready Grok model

- 前提: 実Grok利用許可、PickerにCLI経由readyモデルがある時のみ。隔離git root/Auto。
- 操作: PickerでGrok選択→sc-created.txt=SC_CREATE_OK＋改行とREADME対象行のみEdited by AI.へ変更を依頼。
- 合格条件: completed、両fileの全文一致、SC_WRITE_DONE。readyモデルがなければ理由付きSKIP。
- 証拠・制約: 実CLI接続選択、diskと最終画面。同名API接続をCLIの証拠にしない。

<a id="real-ai-team-scale-01"></a>

## real-ai-team-scale-01

旧ケース: `tests/e2e/real-ai-team-scale.spec.ts` — team-scale: ${TEAM_SIZE} workers (${SCALE_WORKERS === 'mixed' ? 'half Claude, half Codex' : 'Codex only'}) write distinct files concurrently

- 前提: 高費用の実Team試験を明示許可。既定Leader Claude、N=32（偶数）/上限concurrency≥N。mixed（Claude16/Codex16）とCodex-onlyは別結果。隔離git root。
- 操作: 全Workerを雇用後1回のbatchで別file src/worker-NN.txtを割当、報告まで待つ。各fileはSC_FILE_NN_provider＋WNN row01〜60の計61行。既定は初行→2行ずつ30回read/rewriteで同時区間を作る。
- 合格条件: 40分内に全終端/Leader idle、最終行SC_TEAM_SCALE_DONE completed=N failed=0が1つ。Worker N/engine内訳一致、全file内容（trim）一致、余計fileなし、git clean/cherry-pick中なし。DB＋CLI開始/終了証拠で同時≥30かつ継続時間>0、app worktree≥30、各実行独立1worktree/全N unique/入れ子なし。rate-limit待機・CLI開始/終了欠落・fallbackは0。UI frame/Team snapshotの観測失敗/timeout0、最大応答/最大frame gap≤3000ms、renderer error0。
- 証拠・制約: 条件N/Leader/mixed-or-codex/slow設定/同時基準/許可を記録。DBとCLI event区間、frame計測、disk/gitを照合。rate-limit等で同時性を証明不能ならBLOCKED、画面のWorker数で代用しない。

<a id="real-ai-team-scale-02"></a>

## real-ai-team-scale-02

旧ケース: `tests/e2e/real-ai-team-scale.spec.ts` — team-overlap: 4 workers (2 Claude, 2 Codex) edit separate sections of the same file

- 前提: 実mixed Worker4人（Claude2/Codex2）、隔離git rootのshared/index.mdに離れたTODO-1〜4 section。
- 操作: 各Workerへ担当sectionのTODO-iだけDONE-i by providerへ変更させ同時実行。
- 合格条件: SC_TEAM_OVERLAP_DONE completed=4 failed=0が1つ。4Worker/4編集全て存在、元全文の4置換と完全一致、git clean/cherry-pickなし。UI応答/frame gap≤3000ms、観測timeout/失敗0、renderer error0。
- 証拠・制約: 4section前後diff、git/実行/応答metrics、最終画面。同時編集の違いを別fileケースと混同しない。

<a id="real-ai-team-scale-03"></a>

## real-ai-team-scale-03

旧ケース: `tests/e2e/real-ai-team-scale.spec.ts` — team-conflict: 2 workers (Claude, Codex) rewrite the same line differently

- 前提: 実Claude/Codex各1人、隔離git root。shared/index.mdの同じTODO-1を対象。
- 操作: 両Workerに.sc-goを待たせ、2つのisolationがrunning/同baseHead/Workspace HEADも同じと確認してから各worktreeへmarkerを置く。各々OWNED-BY-claude/codexへ変更。
- 合格条件: 同baseHeadで同期できた証拠が必須。最終勝者1、状態completedとwaiting_resume各1。Leaderへ衝突report1件（shared/index.md/waiting_resume含む）。最終SC_TEAM_CONFLICT_DONE completed=1 failed=1が1つ。競合markerなし/git clean/cherry-pickなし、応答/frame gap≤3000ms/観測失敗0/renderer error0。
- 証拠・制約: 同期timestamp/baseHead/2worktree、統合結果と保全された衝突状態。先に統合され同期失敗ならBLOCKED、競合しなかった結果をPASSにしない。
