import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { SkillStore } from './skill-store';

export const BUILTIN_SKILL_CREATOR_ID = 'skill-creator';
export const BUILTIN_SKILL_CREATOR_CONTENT = `---
name: skill-creator
description: Sprint Coderで確認付きのChat SkillまたはTeam Skillを設計・作成する。ユーザーが新しいSkillの作成、既存Skillの改善、Team組織テンプレートの作成を依頼したときに使用する。
---

# Skill Creator

Skillを直接インストールせず、Sprint Coderの管理されたDraftツールだけを使用する。

1. ユーザーの具体的な利用例と、Skillが起動すべき依頼を確認する。
2. 通常の作業手順ならChat Skill、組織・役職・委譲ルールを固定するならTeam Skillを選ぶ。
3. 既定はPortable Skillとし、SKILL.mdを簡潔にしてfrontmatterへnameとdescriptionを書く。必要な場合だけOpen Agent Skills標準のlicense、compatibility、metadata、allowed-toolsを追加する。
4. 詳細資料はreferences/、再利用する決定的処理はscripts/、出力素材はassets/へ分ける。
5. Team Skillではteam/blueprint.jsonを作り、役職、親子関係、責任、scope、nonGoals、doneCriteria、委譲可否、必要能力を明示する。
6. skill_draft_createへkind、skillId、filesの3項目を渡す。kindはchatまたはteam、filesはpathとcontentを持つ1件以上の配列にする。
7. Team Skillではfilesへteam/blueprint.jsonを必ず含める。Blueprintはversion、kind、policy、leaderInstructions、1件以上のrolesを持つ有効なJSONにする。
8. 全ファイルを揃えてskill_draft_createを一度呼ぶ。このツールはschema、path、secret、サイズを検証し、インストールせずDraftだけを保存する。
9. 成功時は応答のDraft ID、Skill ID、種類、ファイル一覧を確認する。Draft IDがなければ作成済みと報告しない。
10. 検証エラーが返った場合だけ、示されたfieldまたはJSON pathを直して一度再送する。再送も失敗した場合はDraft未作成として報告する。
11. 作成されたDraft名と種類をユーザーへ伝えて終了する。インストール操作を代行してはいけない。

Codex Nativeのagents/openai.yamlやClaude Code固有fieldは、ユーザーが対象Runtimeを明示した場合だけ追加する。Claude固有の!command、権限昇格、Sprint CoderのManaged Harnessを迂回する手順は作成しない。Runtimeで意味を保持できない機能が必要なら、Portableなmanaged Tool手順へ変換する。

ユーザーが画面上の「インストール」を明示的に押すまで、作成済みSkillとして扱わない。
実APIキー、Authorization Header、Cookie、token、実ユーザーの会話やプロジェクト情報をSkillへ含めない。
scripts/の実行許可、Provider設定、Access preset、TeamCoordinator、DB migrationを推測で変更しない。
`;
export const BUILTIN_SKILL_CREATOR_DIGEST = createHash('sha256')
  .update(BUILTIN_SKILL_CREATOR_CONTENT)
  .digest('hex');

export async function installBuiltinSkillCreator(homePath: string): Promise<void> {
  const store = await SkillStore.open({ rootPath: join(homePath, '.sprintcoder', 'skills') });
  await store.installBuiltin(
    BUILTIN_SKILL_CREATOR_ID,
    BUILTIN_SKILL_CREATOR_CONTENT,
    BUILTIN_SKILL_CREATOR_DIGEST,
  );
}
