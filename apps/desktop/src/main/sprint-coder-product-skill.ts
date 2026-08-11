import { createHash } from 'node:crypto';
import { join } from 'node:path';
import desktopPackage from '../../package.json';
import { SkillStore } from './skill-store';

export const BUILTIN_SPRINT_CODER_PRODUCT_SKILL_ID = 'sprint-coder-product';
export const SPRINT_CODER_PRODUCT_SPEC_VERSION = desktopPackage.version;
export const BUILTIN_SPRINT_CODER_PRODUCT_SKILL_CONTENT = `---
name: sprint-coder-product
description: Sprint Coder自身の機能、用語、保存場所、設定、ChatとTeamの違い、不具合調査について回答するときに使用する。
---

# Sprint Coder Product Knowledge

対応するSprint Coder仕様: ${SPRINT_CODER_PRODUCT_SPEC_VERSION}

このSkillはSprint Coder自身についての質問と、安全な不具合調査にだけ使用する。未実装機能や将来予定を現在利用可能と断定しない。実行環境のOSが分かる場合はそのOSの情報を先に示し、分からない場合はOS別候補を示す。

## 製品と主要概念

Sprint CoderはローカルファーストのAIコーディング・デスクトップアプリ。AIはSprint Coder上で利用者の開発作業を支援する。

- Task: 会話、Workspace、設定、実行履歴を束ねる作業単位。
- Turn: Task内の1回の依頼と、その実行状態・回答。
- Chat: 選択Runtimeが1つのTurnを直接処理する通常経路。
- Team: LeaderがSprint Coder Team MCPで実在するWorkerを採用し、TaskまたはMissionへ分担する経路。架空のWorkerやCLI自身のsubagentで代用しない。
- Worker: Teamに属し、割り当てられた作業を実行してreportを返す実行主体。
- Runtime: Codex CLI、Claude CLI、Mockなどの実行方式。
- Provider: OpenAI互換APIなど、接続設定を通じてモデルを提供する外部サービス。
- Skill: 選択時のdigestで固定され、ChatまたはTeamへ明示的に渡される手順パッケージ。

代表的なTurn状態はqueued、understanding、planning、executing、synthesizing、completed、failed、canceled。TeamではWorker、execution、Missionにもそれぞれ状態があるため、Turn完了だけでWorker作業の成功を推測しない。

## 保存場所

通常のアプリデータ（Task履歴、設定DB、編集artifact等）はElectronのuserData配下:

- macOS: \`~/Library/Application Support/Sprint Coder/\`
- Windows: \`%APPDATA%\\Sprint Coder\\\`
- Linux: \`$XDG_CONFIG_HOME/Sprint Coder/\`。XDG_CONFIG_HOME未設定時は\`~/.config/Sprint Coder/\`

主DBはuserData配下の\`sprint-coder.sqlite3\`。development起動では既定でリポジトリ直下の\`.vite-user-data/\`を使う。\`SPRINT_CODER_USER_DATA_DIR\`が指定されている場合はその絶対化した場所を使う。DBやartifactを手作業で変更せず、調査ではまずコピーまたは読み取り専用で扱う。

診断ログは通常、全OSでユーザーホーム直下の\`.sprintcoder/logs/\`:

- macOS/Linux: \`~/.sprintcoder/logs/\`
- Windows: \`%USERPROFILE%\\.sprintcoder\\logs\\\`
- \`SPRINT_CODER_USER_DATA_DIR\`指定時: \`<override>/logs/\`

ログstream:

- \`system/system.jsonl\`: 起動、終了、Main/Renderer/子process異常など。
- \`chat/<taskId>.jsonl\`: 通常ChatのTurn lifecycle。
- \`team/<teamId>.jsonl\`: Team、Worker、Mission、execution lifecycle。

各streamはJSON Lines。5MBで\`<stream>.previous.jsonl\`へ1世代ローテーションし、Chat/Teamは各100 streamを上限に古いstreamから削除する。ファイルは所有者だけが読める権限を基本とする。prompt、response、Teamメッセージ本文、環境変数全体は診断ログへ保存しない。既知のcredential形式とsecret keyは保存前に秘匿化するが、共有前には必ず目視確認し、token、Cookie、Authorization header、個人情報、顧客情報、非公開コードや絶対パスを除く。

## 設定と使い分け

設定画面ではRuntime、model、reasoning effort、Access preset、Workspace、Skill、Sprint Coder事前プロンプト、Teamの既定policy・モデル制限・モデル調査設定などを確認する。利用可能項目はRuntimeとversionで異なるため、画面とruntime probe結果を正本にする。

- Chatを選ぶ: 質問、相談、単一の実装、1つの検証可能な完了点。
- Teamを選ぶ: 複数の独立作業、明確な役割分担、長時間Mission、複数Workerのreportが必要。
- Teamの成功判定: executionが終端状態で、必要reportが届き、done criteriaの証拠があること。queued/running/blockedをcompletedと読み替えない。

## 安全な不具合調査

1. Sprint Coder version、OS/architecture、developmentかpackagedか、選択Runtime/provider/model、Task/Turn/Team ID、発生時刻を記録する。
2. UIのTurn状態と公開エラーを確認する。credentialや会話本文は収集しない。
3. 該当時刻のsystem streamと、対象のchatまたはteam streamをJSONLとして確認する。各行がJSONとして読めるか、event/status/result、関連ID、durationを見る。
4. 再現手順を最小化し、可能ならMockまたは機密情報を含まないfixtureで再現する。
5. 共有前にログとスクリーンショットを目視し、secret、個人情報、顧客情報、非公開コード、不要な絶対パスを削除する。auth.json、API key、Cookie、DB本体をそのまま共有しない。

## 根拠と更新方針

ユーザー向け正本はリポジトリの\`README.md\`。実装詳細は\`apps/desktop/src/main/index.ts\`、\`persistent-log.ts\`、\`context-ledger.ts\`、\`team-coordinator.ts\`、\`skill-store.ts\`を確認する。公開README: https://github.com/Robbits-CO-LTD/sprint-coder/blob/main/README.md

回答時は「仕様 ${SPRINT_CODER_PRODUCT_SPEC_VERSION}時点」と明示できる。現在のアプリversionとこの対応仕様が異なる、または画面・実装と食い違う場合は、断定せず現在の画面とREADMEを優先し、Skillの更新が必要と伝える。
`;
export const BUILTIN_SPRINT_CODER_PRODUCT_SKILL_DIGEST = createHash('sha256')
  .update(BUILTIN_SPRINT_CODER_PRODUCT_SKILL_CONTENT)
  .digest('hex');

export async function installBuiltinSprintCoderProductSkill(homePath: string): Promise<void> {
  const store = await SkillStore.open({ rootPath: join(homePath, '.sprintcoder', 'skills') });
  await store.installBuiltin(
    BUILTIN_SPRINT_CODER_PRODUCT_SKILL_ID,
    BUILTIN_SPRINT_CODER_PRODUCT_SKILL_CONTENT,
    BUILTIN_SPRINT_CODER_PRODUCT_SKILL_DIGEST,
  );
}
