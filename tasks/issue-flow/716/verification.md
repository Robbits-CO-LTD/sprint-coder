# Issue 716 検証

base: `02594d0a18b01ca91abf439af84b09aa2d926982`。
code blob: `a16a795087bb8cf334498d25a061f7ea6184c01f`。
Mac arm64 / Node22.23.1 / Electron43.5.0 ABI148 / SQLite3.53.4。
添付: Issue654/716・PR687はいずれも0/0、全collector済み。

## 再現・検証

- baseline: `ELECTRON_RUN_AS_NODE=1 SPRINT_CODER_ELECTRON_DB_TEST=1 ...Electron ...vitest run src/main/graph-mission-persistence.test.ts -t 'finishes participating Workers'` → 4 PASS / 114 filter SKIP。
- 同fixtureでtest-owned agent.created_atだけ逆転 → 2 FAIL / 2 PASS / 114 filter SKIP。role bはwaiting/ready、role aはdone。登録順assertionが原因。
- ID→state Map / cardinality / 両順序 → 8 PASS / 114 filter SKIP。同じ観測点の症状解消。
- workspace Node22で `npm run test --workspace @sprint-coder/desktop -- src/main/graph-mission-persistence.test.ts -t 'retains bounded|classifies missing|keeps a real child'` → 4 PASS / 1 bridge filter SKIP。real child exit7とtimeout killを失敗として維持、raw private出力を拒否。
- `npm run test --workspace @sprint-coder/desktop -- src/main/graph-mission-persistence.test.ts` → outer5 PASS、全Graph Electron child exit0、child91.248秒 / 全体95.37秒。未取得のchild assertion件数をouter5と合算しない。このrunの開始後に変更したのはANSI除去のNode標準関数と合成exit fixture予算だけで、関連4診断テストは最終sourceで再実行PASS。Graph childとdeadlineは不変。
- desktop typecheck PASS、変更ESLint/Prettier/diff check PASS。初回lintのcontrol-regexをNode標準stripVTControlCharactersに修正し、無効化コメントは使っていない。
- existing same-OS Electron/SQLite/NativeSafeFs artifactのコピーと実ロード。local native rebuild/downloadなし。head-native buildとは呼ばない。

## 自己レビュー

- 作成順をsortして状態の誤帰属を隠さず、exact ID/stateと件数を比較する。二つの取得順を実SQLで固定し、fixtureが意図した順を返すこともassert。
- 完了/他execution/他worker/ready participantのTeam状態、再resume、currentActivity、再executeしない既存検証を維持。
- bridgeをasync execFileのまま保ち、RPCをblockしない。180秒/300秒、maxBuffer10MiBを維持。
- failureのstdout/stderr/message/cause/pathを公開せず、numeric counts・enum metadata・case digestのみ。report file2MiB上限とmalformed/missing分類。
- 初回timeoutの直接原因は未確定、診断改善と順序不一致修正をtimeout解消と混同しない。

## 独立レビュー・CI・終端

Claude CLI safe-mode / tools空 / no-session-persistence、設定済みsonnet aliasを用い、限定diffとSQL/Coordinator周辺だけを送信。CLI呼出しは180秒timeout、出力0bytesで失敗。alias sonnetは設定とCLI helpで確認したが実provider/model response未取得のため独立レビュー未成立。実装・コマンド・Git/GitHub操作・再委任は禁止。入力/出力はローカルrun台帳の716-review-input.txt / 716-claude-review.jsonへ保持。このtimeoutをPASSにせず、最新headの適格な既存bot/human reviewを確認するまでmergeを保留する。
最新head必須CI、ReviewBOT、未解決thread、merge/main CIは未確認。#716と#654は未close。

Logs: Mac側 run台帳 `tasks/issue-graph-flow/2026-10-01-mac-handoff/716-*.log`（元checkoutに保全、PRへraw log転記なし）。
