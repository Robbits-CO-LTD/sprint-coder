import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { SkillStore } from './skill-store';

export const BUILTIN_IMPORT_SKILL_ID = 'import-skill';
export const BUILTIN_IMPORT_SKILL_CONTENT = `---
name: import-skill
description: Claude CLIまたはCodex CLIにある既存Skillを、AIがSprint Coder互換へ修正してインストール・有効化する。ユーザーがSkillのimport、移行、取り込み、互換化を依頼したときに使用する。
---

# Import Skill

元Skillを変更せず、Sprint Coderの管理領域へ互換コピーを作成して有効化する。

1. 対象AI CLIがまだ明示されていなければ、「import元のAI CLIは Claude と Codex のどちらですか？」と質問して終了する。
2. importするSkillがまだ一意に決まっていなければ、「どのSkillをimportしますか？Skill名またはフォルダパスを教えてください」と質問して終了する。
3. ユーザー回答からSkill IDを確定し、skill_import_readを一度呼ぶ。Claudeは ~/.claude/skills、Codexは ~/.codex/skills と ~/.agents/skills の順でMain側が安全に探索する。絶対パスが指定された場合もbasenameをSkill IDとして渡し、選択されたCLIのskills配下以外を直接読み取らない。
4. skill_import_readが返した全ファイルと警告を確認する。シンボリックリンク、秘密情報、256ファイル超、UTF-8テキスト合計700 KiB超はツールが拒否するため、回避せず理由を報告する。
5. 元の意図と手順を維持しつつSprint Coder互換へ仕上げる。必ずSKILL.mdを含め、frontmatterはnameとdescriptionだけにする。Skill IDは英数字で始まる英数字・ピリオド・アンダースコア・ハイフンだけにする。Claude/Codex固有の存在しないツール名やパスは、Sprint Coderで実行可能な手順へ置き換える。不要なメタデータやキャッシュは除外する。
6. 全ファイルをUTF-8テキストとして揃え、skill_import_installを一度呼ぶ。このツールの成功は、検証済みSkillがSprint Coderへインストールされ、有効になったことを意味する。
7. 検証エラー時だけ修正して再実行する。元Skillの削除・変更、Provider設定、Access preset、DB、他のSkillは変更しない。
8. 最終報告に、import元CLI、元Skill、作成されたSkill名、互換化した点、有効化済みであることを含める。

ユーザーがCLIとSkillを答える前にインストールしてはいけない。実APIキー、Authorization Header、Cookie、token、実ユーザーの会話やプロジェクト固有情報をSkillへ含めない。
`;
export const BUILTIN_IMPORT_SKILL_DIGEST = createHash('sha256')
  .update(BUILTIN_IMPORT_SKILL_CONTENT)
  .digest('hex');

export async function installBuiltinImportSkill(homePath: string): Promise<void> {
  const store = await SkillStore.open({ rootPath: join(homePath, '.sprintcoder', 'skills') });
  await store.installBuiltin(
    BUILTIN_IMPORT_SKILL_ID,
    BUILTIN_IMPORT_SKILL_CONTENT,
    BUILTIN_IMPORT_SKILL_DIGEST,
  );
}
