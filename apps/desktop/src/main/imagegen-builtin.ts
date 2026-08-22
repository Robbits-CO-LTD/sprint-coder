import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { TurnSkillSelection } from '@sprint-coder/contracts';
import { SkillStore } from './skill-store';

export const BUILTIN_IMAGEGEN_SKILL_ID = 'imagegen';
export const BUILTIN_IMAGEGEN_SKILL_CONTENT = `---
name: imagegen
description: Codexの組み込み画像生成toolで画像を生成する。メッセージが$imagegenで始まるときだけ使用する。
---

# Sprint Coder Image Generation

現在の依頼が \\$imagegen で始まる場合、組み込みの image_gen toolを使って画像を1つ生成する。
生成結果をコピー、移動、rename、またはworkspaceへ保存しない。Sprint Coderが構造化thread IDから生成物を安全に回収する。
shell、外部API、ユーザーAPI key、ファイルpathの推測へfallbackしない。image_gen toolが利用不能なら、その事実を報告して終了する。
`;
export const BUILTIN_IMAGEGEN_SKILL_DIGEST = createHash('sha256')
  .update(BUILTIN_IMAGEGEN_SKILL_CONTENT)
  .digest('hex');

export function isImageGenerationTurn(text: string): boolean {
  return /^\s*\$imagegen(?:\s|$)/u.test(text);
}

export function bindBuiltinImagegenSkillForTurn(
  text: string,
  runtimeKind: 'codex' | 'claude' | 'mock',
  selections: readonly TurnSkillSelection[],
): TurnSkillSelection[] {
  if (
    runtimeKind !== 'codex' ||
    !isImageGenerationTurn(text) ||
    selections.some(
      ({ ref }) => ref.source === 'builtin' && ref.skillId === BUILTIN_IMAGEGEN_SKILL_ID,
    )
  )
    return [...selections];
  return [
    ...selections,
    {
      kind: 'chat',
      ref: {
        source: 'builtin',
        skillId: BUILTIN_IMAGEGEN_SKILL_ID,
        digest: BUILTIN_IMAGEGEN_SKILL_DIGEST,
      },
    },
  ];
}

export async function installBuiltinImagegenSkill(homePath: string): Promise<void> {
  const store = await SkillStore.open({ rootPath: join(homePath, '.sprintcoder', 'skills') });
  await store.installBuiltin(
    BUILTIN_IMAGEGEN_SKILL_ID,
    BUILTIN_IMAGEGEN_SKILL_CONTENT,
    BUILTIN_IMAGEGEN_SKILL_DIGEST,
  );
}
