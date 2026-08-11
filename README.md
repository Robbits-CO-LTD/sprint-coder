# Sprint Coder

チャットから始め、必要なときだけ複数のAIへ仕事を分担できる、ローカルファーストのデスクトップAIコーディング環境です。

Sprint Coderは、1対1のAIチャット、ワークスペース上のファイル編集・コマンド実行、複数WorkerによるTeam実行をひとつのTaskにまとめます。Codex CLIやClaude Code CLIに加え、クラウドAPIとローカルLLMをTaskごとに選択できます。

> [!WARNING]
> 現在はearly betaです。機能、データ形式、配布方法は今後変更される可能性があります。

## 主な機能

- **ChatからTeamへ** — まず1人のAIと会話し、作業が大きくなったら同じTaskをLeaderと複数WorkerのTeamへ切り替えられます。
- **モデルをTaskごとに選択** — 組み込みCLI、公式API、OpenAI互換API、ローカルLLMを同じモデルピッカーから利用できます。
- **ワークスペースを安全に操作** — ファイル変更、差分、コマンド、承認履歴を画面上で追跡し、`Ask` / `Auto` / `Full` のAccess presetで実行範囲を制御します。
- **ローカルに復元可能な履歴** — Task、メッセージ、Turn、Teamの状態を端末内へ保存し、再起動後も作業を再開できます。
- **実行状況を可視化** — reasoning、進行stage、context使用量、Workerの活動、承認待ちをTask内で確認できます。
- **Skill対応** — ローカルのSkillを読み込み、ChatやTeamへ追加できます。組み込みのSkill Creatorから新しいSkillの下書きも作成できます。Codex実行では、選択時に固定した管理コピーだけを一時的な隔離rootから渡し、Codex CLI側の未選択Skillは利用しません。隔離を確認できないCLIではTurnを開始しません。

## 対応するRuntime / Provider

| 種別          | 対応先                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------ |
| 組み込みCLI   | Codex CLI、Claude Code CLI                                                                 |
| 公式API       | OpenAI、OpenRouter、Anthropic、Google Gemini、xAI                                          |
| OpenAI互換API | Mistral、DeepSeek、Groq、Moonshot AI、MiniMax、Zhipu AI、NVIDIA NIM、Cloudflare Workers AI |
| ローカルLLM   | Ollama、LM Studio、LocalAI                                                                 |
| 開発・確認用  | Mock Runtime                                                                               |

組み込みCLIは、端末にインストール済みのCLIとその認証を使用します。外部APIはアプリの「設定 → モデルと接続」から追加・検証します。利用できるモデルやtool capabilityは接続先によって異なり、外部APIの利用には各Providerの料金が発生する場合があります。

## クイックスタート

### 必要なもの

- macOS、Windows、またはLinux
- [Node.js 22](https://nodejs.org/) とnpm
- Git
- 実AIを使う場合は、認証済みのCodex CLI / Claude Code CLI、または対応ProviderのAPI key

### ソースから起動

```bash
git clone https://github.com/Robbits-CO-LTD/sprint-coder.git
cd sprint-coder
nvm use
npm ci
npm start
```

`nvm`を使わない場合は、`node --version`が`v22.x`であることを確認してください。Providerを設定しなくても、Mock Runtimeで基本操作を試せます。

### 最初のTask

1. 「新しいTask」を作成します。
2. 必要に応じてワークスペースを選択します。
3. Composer下部でモデル、Effort、Access presetを選びます。
4. メッセージを送り、ファイル変更やコマンドの内容を確認します。
5. 並列作業が必要になったら「Team」へ切り替え、Leaderへ目的を伝えます。

## Local-firstとセキュリティ

Local-firstは、Task履歴、設定、実行状態を端末内で管理するという意味です。クラウドProviderを選択したTurnでは、生成に必要なpromptやcontextが選択先へ送信されます。完全にオフラインで使う場合は、Mock RuntimeまたはローカルLLMを選択してください。

- API keyは送信後にRendererから消去し、Main processがElectron `safeStorage`を使って端末内へ保存します。
- Rendererはsandbox / context isolationを有効にし、Node.js APIを直接公開しません。
- ワークスペース操作とProviderへのegressは、Taskの権限設定と監査対象になります。
- CLI Runtimeのsandbox境界はRuntimeとAccess presetによって異なるため、Composerに表示される実行モードを確認してください。

セキュリティ設計と確認項目は[Security Checklist](docs/SECURITY_CHECKLIST.md)を参照してください。

## エラー調査用ログ

Sprint Coderは、起動失敗、Main processの未処理エラー、RendererやElectron子processの異常終了などをローカルのJSON Linesログへ保存します。通常の保存場所は次のとおりです。

| OS      | ログフォルダ                       |
| ------- | ---------------------------------- |
| macOS   | `~/.sprintcoder/logs/`             |
| Windows | `%USERPROFILE%\.sprintcoder\logs\` |
| Linux   | `~/.sprintcoder/logs/`             |

ログは用途別に分かれます。

```text
.sprintcoder/logs/
├── system/system.jsonl
├── chat/<taskId>.jsonl
└── team/<teamId>.jsonl
```

各streamは5MBに達すると`<stream>.previous.jsonl`へ1世代ローテーションします。`SPRINT_CODER_USER_DATA_DIR`を指定したdevelopment/E2E起動では、実ユーザーのログと混ざらないよう`<override>/logs/`へ保存します。

ログにはtimestamp、level、event、status、関連IDなどの診断metadataだけを記録し、prompt、response、Teamメッセージ本文、環境変数全体は保存しません。既知のcredential形式やsecret項目は保存前に秘匿化しますが、第三者へ共有する前には内容を確認してください。

## Sprint Coder製品知識Skill

内蔵の`sprint-coder-product` Skillは、Sprint Coderの用語、ChatとTeamの使い分け、OS別保存場所、設定、安全な不具合調査をAIが説明するための選択可能な製品知識です。Skill本文には対応するデスクトップversionを埋め込み、version更新時にdigestも更新します。ログ保存先などの重要仕様はREADMEと自動テストで同期し、食い違う場合は現在の画面とREADMEを優先します。

短い製品identityだけはSkill選択やユーザー設定に依存せず、通常ChatとTeamのsystem contextへ常に含まれます。詳細な製品仕様は毎Turnへ埋め込まず、必要なときに`sprint-coder-product`を選択して参照します。

## 開発

```bash
npm ci
npm start
```

主なコマンド:

| コマンド                      | 内容                                             |
| ----------------------------- | ------------------------------------------------ |
| `npm start`                   | Electronアプリをdevelopment modeで起動           |
| `npm run typecheck`           | 全workspaceのTypeScriptを検査                    |
| `npm run lint`                | ESLintを実行                                     |
| `npm run format:check`        | Prettierによる形式チェック                       |
| `npm test`                    | Vitestのunit / integration testを実行            |
| `npm run e2e`                 | production packageを作成し、Playwright E2Eを実行 |
| `npm run test:provider-smoke` | opt-inの実Provider smoke testを実行              |

E2Eはpackage作成とnative moduleの検証を含むため、通常の変更確認では対象test、typecheck、lintから先に実行してください。CIではmacOS、Windows、Linuxの各環境で検証します。

### Windowsインストーラーの作成

Node.js 22、Python 3、Visual Studio 2022 Build Tools（「C++によるデスクトップ開発」）、Inno Setup 6を用意し、PowerShellで次を実行します。Chocolateyが利用できる環境では、同梱スクリプトがInno Setup 6.7.1を不足時に導入し、コンパイラのAuthenticode署名・発行元（Pyrsys B.V.）・署名証明書のSHA-256フィンガープリントを検証します。

```powershell
npm ci
node node_modules/electron/install.js
powershell -ExecutionPolicy Bypass -File apps/desktop/scripts/ensure-inno-setup.ps1
npm run make:windows
```

ウィザード付きインストーラーは`apps/desktop/out/make/squirrel.windows/x64/Sprint-Coder-Installer.exe`、展開して起動できるZIP版は`apps/desktop/out/make/zip/win32/x64/`に出力されます。インストーラーは日本語・英語の標準ウィザードで案内し、内部のSquirrel bootstrapperがユーザー領域へセットアップするため、既存の自動更新との互換性を維持します。

手元で作るインストーラーは未署名のため、Windowsから警告が表示されることがあります。正式配布では`SPRINT_CODER_RELEASE=1`を設定し、コード署名証明書（`.pfx`）を使う場合は`SPRINT_CODER_WINDOWS_CERTIFICATE_FILE`と`SPRINT_CODER_WINDOWS_CERTIFICATE_PASSWORD`、CurrentUser証明書ストアを使う場合は`SPRINT_CODER_WINDOWS_CERTIFICATE_SHA1`を設定してください。検証用betaのworkflowのみ、`SPRINT_CODER_ALLOW_UNSIGNED_WINDOWS=1`を明示して未署名artifactを作成します。

## リポジトリ構成

```text
apps/desktop/       Electron Main / Preload / React Renderer / Runtime Host
packages/contracts/ IPC・永続化・Provider間で共有するschemaと型
packages/domain/    権限、Tool、Turnなどのpure domain logic
tests/e2e/          packaged appを対象にしたPlaywright E2E
docs/               プロダクト、設計、セキュリティ、計画
tasks/              実装計画と設計レビュー記録
```

## 現在の配布状態

- desktop packageの正式版versionはSemVerで管理しています。beta版には`-beta.N`を付けます。
- stable版は現時点ではGitHub Actionsで自動公開せず、version更新をPRでレビューした後、
  macOS／Windowsのartifactを検証して既存のDraft Releaseへ手動添付します。タグとReleaseの公開も
  全artifact確認後に手動で行います。
- beta版のGitHub ActionsはmacOSのDMG / 更新用ZIPと、Ubuntuのportable ZIPを作成し、GitHub prereleaseをDraftとして用意します。
- Windowsのウィザード付きインストーラー / portable ZIP / Squirrel更新artifactは、ローカルでコード署名して同じDraft Releaseへ添付します。
- Windowsインストーラー版は起動時と6時間ごとにGitHub Releasesを確認し、更新を取得すると再起動の確認を表示します。portable ZIP版は自動更新の対象外です。
- macOS ARM64版も、配布元と更新先を同じ正式なAppleコード署名IDでビルドした場合に自動更新が有効になります。
- macOSのbeta artifactは現時点ではad-hoc署名でApple notarizationも未対応のため、自動更新は安全側に無効化されます。
- stable 0.1.0のmacOS artifactも未署名・notarizationなしで配布し、起動時の注意事項をReleaseへ明記します。
- 配布物が公開されている場合は[GitHub Releases](https://github.com/Robbits-CO-LTD/sprint-coder/releases)から取得できます。

## 設計資料

- [プロダクト・詳細設計書](docs/PRODUCT_AND_TECHNICAL_DESIGN.md)
- [Team v2・Multi-Provider改訂計画](docs/plan/team-v2/README.md)
- [参照Agentアーキテクチャ分析](docs/REFERENCE_AGENT_ARCHITECTURE.md)
- [実装計画](tasks/IMPLEMENTATION_PLAN.md)
- [アクセシビリティ監査](docs/A11Y_AUDIT.md)
- [Security Checklist](docs/SECURITY_CHECKLIST.md)
