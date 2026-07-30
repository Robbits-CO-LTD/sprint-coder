# Sprint Coder

Chatから始まり、必要になった瞬間だけ複数のAI Workerへ広がる、ローカルファーストのElectronデスクトップアプリ。

このディレクトリは新規プロジェクトの設計起点であり、旧製品のコード・構成・設計判断を前提にしない。

## Windowsで使う

配布された `Sprint-Coder-Setup.exe` を開くと、Windowsへインストールできる。Node.jsやVisual Studioを利用者が別途インストールする必要はない。

ソースコードからWindows用インストーラーを作る場合は、Node.js 22、Python 3、Visual Studio 2022 Build Tools（「C++によるデスクトップ開発」）を用意し、PowerShellで次を実行する。

```powershell
npm ci
node node_modules/electron/install.js
npm run make:windows
```

完成したインストーラーは `apps/desktop/out/make/squirrel.windows/x64/Sprint-Coder-Setup.exe` に出力される。`apps/desktop/out/make/zip/win32/x64/` には、展開してそのまま起動できるZIP版も作られる。

手元で作るインストーラーは未署名のため、Windowsから警告が表示されることがある。正式配布版ではコード署名証明書（`.pfx`）を用意し、`SPRINT_CODER_RELEASE=1`、`SPRINT_CODER_WINDOWS_CERTIFICATE_FILE`、`SPRINT_CODER_WINDOWS_CERTIFICATE_PASSWORD` をビルド環境に設定する。この設定が不足した正式配布ビルドは、安全のためエラーで停止する。検証用betaに限り、workflowは`SPRINT_CODER_ALLOW_UNSIGNED_WINDOWS=1`を明示して未署名artifactを作成する。

## 文書

- [プロダクト・詳細設計書](docs/PRODUCT_AND_TECHNICAL_DESIGN.md)
- [Codex CLI / Grok Build 参照アーキテクチャ分析](docs/REFERENCE_AGENT_ARCHITECTURE.md)
- [Agent Intelligence詳細設計](tasks/designs/design-agent-intelligence-architecture-20260721.md)
- [実装計画](tasks/IMPLEMENTATION_PLAN.md)
- [設計レビュー記録](tasks/designs/design-sprint-coder-foundation-20260720.md)
- [参照agent導入後のhardening review](tasks/designs/design-reference-agent-hardening-20260721.md)

## 現在の状態

3者レビュー済みの設計baseline。実装は `tasks/IMPLEMENTATION_PLAN.md` のPhase 0で、5 workstream・12実測項目の成立証拠と関連ADRを確定してから開始する。Phase 0は3–5日の調査timeboxであり、Gate未通過時はfallback、延長、No-Goのいずれかを記録する。

## Codex runtimeの手動確認

実CLIの確認は、隔離したuser dataで `SPRINT_CODER_USER_DATA_DIR=/tmp/sprint-coder-runtime-smoke SPRINT_CODER_RUNTIME_SMOKE=codex npm start` を実行し、Settings APIでCodexを選択して短いTurnを開始する。stageが順番に進み、応答がstreamして完了すること、実行中のSteerが`STEER_UNSUPPORTED`になること、CancelでCodexの子processが残らないことを確認する（`SPRINT_CODER_RUNTIME_SMOKE`は手動試験の意図を示すmarkerであり、runtime選択自体はSettings APIに保存される）。

## Claude runtimeの手動確認

実CLIの確認は、隔離したuser dataで `SPRINT_CODER_USER_DATA_DIR=/tmp/sprint-coder-claude-runtime-smoke SPRINT_CODER_RUNTIME_SMOKE=claude npm start` を実行し、Settings APIでClaude Codeを選択して短いTurnを開始する。stageが順番に進み、応答がstreamして完了すること、実行中のSteerが`STEER_UNSUPPORTED`になること、CancelでClaudeの子processが残らないことを確認する（`SPRINT_CODER_RUNTIME_SMOKE`は手動試験の意図を示すmarkerであり、runtime選択自体はSettings APIに保存される）。Claudeはローカルの`claude` CLI自身の認証（OAuth/keychain）を使い、アプリはAPIキーを一切扱わない。

## Team Workerの実実行(実AI)

WorkerをローカルのClaude Code CLIで実際に実行するには、opt-inマーカーを付けて起動する:

```
SPRINT_CODER_REAL_WORKERS=1 npm start
```

Mock Runtimeのまま「⬡ Team」で昇格し、Leaderに「チームテスト:〇〇」と依頼すると、Leader(Mockシナリオ)が雇用・指示した各Workerが実Claude(read-only/no-toolsプロファイル、`auto`モデル)で作業し、実際の生成結果を報告として返す。CLI未導入・probe失敗・egress拒否時は決定論シミュレータへ自動フォールバックする。Runtime設定でClaude/Codexを選択している場合、Workerはその選択に従う(Leaderの実tool useによる雇用はMCP経由の実装が次マイルストーン)。
