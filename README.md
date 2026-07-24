# Sprint Coder

Chatから始まり、必要になった瞬間だけ複数のAI Workerへ広がる、ローカルファーストのElectronデスクトップアプリ。

このディレクトリは新規プロジェクトの設計起点であり、旧製品のコード・構成・設計判断を前提にしない。

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
