# Sprint Coder 開発ガイド

このファイルは、このリポジトリで作業するAIエージェント向けのプロジェクト固有ルールです。ユーザーの最新指示、上位階層の `AGENTS.md`、適用中のSkillがこのファイルと矛盾する場合は、優先度の高い指示に従ってください。

## プロジェクト概要

Sprint Coderは、Electron、React、TypeScriptで構成されたlocal-firstのAIコーディング・デスクトップアプリです。Task、Chat、AI Team、Provider、Workspace tool、権限、監査、ローカル永続化を同じアプリで扱います。

主な構成:

- `apps/desktop/`: Electron Main、Preload、React Renderer、Runtime Host
- `packages/contracts/`: IPC、永続化、Provider間で共有するschemaと型
- `packages/domain/`: 権限、Tool、Turnなどのpure domain logic
- `tests/e2e/`: packaged appを対象にしたPlaywright E2E
- `docs/`: プロダクト、設計、セキュリティ、検証資料
- `tasks/`: 複雑な実装の計画、ADR、レビュー記録
- `.github/workflows/`: CI、provider smoke、release workflow

## 基本原則

- 変更前に対象コード、呼び出し元、関連テスト、既存ドキュメントを読む。読んでいないコードを推測で変更しない。
- ユーザーが求めた成果へ最短で到達する。隣接機能、将来向けの抽象化、根拠のない堅牢化を同じ変更へ混ぜない。
- バグ修正では、症状を隠す前にログ、再現手順、失敗テスト、データフローから根本原因を確定する。
- 既存の設計、命名、型、テストパターンを優先し、必要な箇所だけを変更する。
- 曖昧さがあっても、リポジトリから確認できる事実と合理的な仮定で安全に進める。結果を大きく変える判断だけを、選択肢と影響を添えてユーザーへ確認する。
- 作業ツリーにあるユーザーの変更を保持する。無関係な差分を直さず、明示したパスだけをstageする。`git add -A`、force push、履歴書き換え、破壊的な復元は行わない。
- 秘密情報、prompt本文、response本文、環境変数全体をログ、fixture、Issue、PRへ記録しない。

## スコープと計画

小さな変更では、短い作業方針を示してそのまま実装してよい。3ステップ以上の作業、アーキテクチャ判断、高リスク変更では、実装前に次を明確にする。

1. ユーザーに見える成果
2. 必要な変更
3. 明示的な非対象
4. 最小の正しさの証明

CRUD、atomic/staged write、競合検出、journal/recovery、native境界、packaging、複数OS対応、Saga統合、広範なE2Eは、それぞれ独立した関心事として扱う。1つの作業が複数の境界をまたぎ、1つのcheckpointで検証できない場合は小さなsub-sliceへ分割する。

恒久的な設計判断や複数段階の実装だけを `tasks/` に記録する。単純な修正のために計画ファイルや作業ログを増やさない。

## 実装ルール

- TypeScriptの型を情報の境界として使い、安易な `any`、unchecked cast、型エラーの抑制を避ける。
- IPC、永続化、Provider間の契約を変える場合は、`packages/contracts` を正本としてMain、Preload、Renderer、Runtimeの利用先を追跡する。
- RendererからNode.js APIや生の `ipcRenderer` を公開しない。既存のsandbox、context isolation、schema validationを維持する。
- Workspaceのファイル操作とcommand実行は既存のManaged Harness、path guard、権限、監査の境界を通す。便利さのために直接I/Oの迂回路を追加しない。
- local-firstは「クラウドへ送信しない」という意味ではない。選択Providerへ送信するデータと、端末内へ保存するデータの境界を明示する。
- 診断ログは構造化された最小限のmetadataに留め、既存のredactionとrotationを維持する。
- UI変更ではキーボード操作、focus、loading、empty、error、disabled状態、light/dark themeを変更範囲に応じて確認する。
- コメントは「何をしているか」の逐語説明ではなく、境界条件や理由がコードだけでは分からない場合に限る。
- 新しい依存関係は、既存機能で代替できない理由、bundle/native/ライセンス/複数OSへの影響を確認してから追加する。

## 開発環境とコマンド

Node.jsは `22.x` を使用する。依存関係はnpm workspaceで管理する。

```bash
nvm use
npm ci
npm start
```

よく使う検証コマンド:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run e2e
```

対象を絞る場合:

```bash
npm run typecheck --workspace @sprint-coder/desktop
npm run test --workspace @sprint-coder/desktop
npm run test --workspace @sprint-coder/contracts --workspace @sprint-coder/domain
npm run test --workspace @sprint-coder/desktop -- path/to/target.test.ts
```

注意事項:

- 通常はルートの `npx vitest run` ではなく、対象workspaceまたは対象testを指定する。
- Electronのnative依存が必要な作業では `npm run prepare:desktop --workspace @sprint-coder/desktop` を使用する。
- `better-sqlite3` はNode ABIとElectron ABIを混同しない。native artifactの存在と、実際に対象runtimeからloadできることを分けて確認する。
- `npm run e2e` はproduction package作成とnative module検証を含む高コストな検証である。対象境界を変更した場合か、最終gateでのみ実行する。
- 実Provider smokeは課金、credential、networkを伴うopt-in検証である。明示された場合のみ `npm run test:provider-smoke` を使う。
- Windowsで作業する場合はPowerShellを使い、Node.js 22、Python 3、Visual Studio Build Tools、Inno Setupなど対象workflowの前提を確認する。

## 検証方針

変更を証明できる最小十分な検証から始め、影響範囲が広がる根拠がある場合だけ段階を上げる。

1. **Tight loop**: 変更したtest、対象workspaceのtypecheck、必要なlint
2. **Subsystem checkpoint**: 影響するpackageまたは機能のtest
3. **Boundary checkpoint**: IPC、DB、native、Provider、packagingなど変更した境界のintegration testまたはfocused E2E
4. **Final/release gate**: 要求された全suite、複数OS CI、packaged app、実Provider、実機確認

文書、コメント、表示文言だけの変更は、diffと形式・リンク・記載内容の確認を基本とし、buildやE2Eを行わない。実装変更では、少なくとも対象typecheckと直接関連するtestを行う。共有契約、DB schema、認証・権限、ファイル操作、依存関係、build/release設定、複数OSへ影響する変更は、該当境界の検証を省略しない。

失敗後は最小の失敗対象だけを再実行し、greenになってから広いcheckpointへ戻る。同じ入力の高コスト検証を理由なく繰り返さない。各コマンドのexit codeを確認し、出力の一部だけで成功と判断しない。

E2E前には、目的、操作対象、期待結果、合格条件を短く明文化する。E2E結果には各項目の `PASS` / `FAIL` / `SKIP`、使用環境、artifact、未確認事項を残す。build成功やモデルの成功文だけを、ユーザー操作の証明として扱わない。

## Git・Issue・PRワークフロー

変更リスクに応じてGit運用を切り替える。高リスク条件に一つでも該当する場合は、変更量にかかわらず高リスクフローを優先する。

### 通常フロー

次の変更は、ユーザーの指示とbranch protectionが許す場合に `main` へ直接commit・pushしてよい。

- 文言、UI微調整
- 明確な1〜数ファイルの局所的なバグ修正
- テスト追加、型修正
- 通常の小規模機能追加

push前に差分を自己レビューし、lint、typecheck、変更範囲に関連するtestを実行する。フルCIは必須としない。

### 高リスクフロー

次の変更は `codex/` prefixの作業branchで実装し、PRを作成する。

- DB、schema、migrationの変更
- 認証、権限、secret処理の変更
- Workspaceのファイル操作に関わる変更
- updater、release、build、CI設定の変更
- 大規模refactor
- 複数OSに影響する変更
- 依存関係の大型更新またはnative依存の変更

PR作成後は、最新headに対する必須CIとReviewBOTを確認する。指摘を修正し、未解決threadがなく、必要なchecksがgreenになってからmergeする。merge、tag、release公開は、依頼の範囲に含まれない限り勝手に行わない。

Issueを扱う場合は、最初に現行Issueと関連PRを確認する。推測だけでIssueを増やさず、1つの根本問題につき1つのIssueを使う。完了報告やcloseの前に、受入条件、実装、検証、merge/deploy、人間承認の残件を確認する。

## 完了条件と報告

完了前に次を確認する。

- 依頼された成果が実際に反映されている
- 意図しない差分やユーザー変更の混入がない
- 変更リスクに見合う検証がPASSしている
- 未実施、SKIP、外部承認待ちを成功扱いしていない
- ドキュメント、Issue、PRの状態が実装と矛盾していない

最終報告は日本語で、結論を先に書く。変更内容、検証結果、残件または未確認事項を簡潔に示す。ファイルや行を示す場合は、実在するパスと現在の行番号を使う。
