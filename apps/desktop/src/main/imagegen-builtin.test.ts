import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_IMAGEGEN_SKILL_DIGEST,
  BUILTIN_IMAGEGEN_SKILL_ID,
  bindBuiltinImagegenSkillForTurn,
  installBuiltinImagegenSkill,
  isImageGenerationTurn,
} from './imagegen-builtin';
import { SkillStore } from './skill-store';

describe('builtin imagegen Skill', () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true }))));

  it('binds only an explicit Codex imagegen Turn and never duplicates the binding', () => {
    expect(isImageGenerationTurn('$imagegen draw a square')).toBe(true);
    expect(isImageGenerationTurn('please use $imagegen')).toBe(false);
    expect(bindBuiltinImagegenSkillForTurn('$imagegen draw', 'claude', [])).toEqual([]);
    expect(bindBuiltinImagegenSkillForTurn('draw', 'codex', [])).toEqual([]);
    const bound = bindBuiltinImagegenSkillForTurn('$imagegen draw', 'codex', []);
    expect(bound).toEqual([
      {
        kind: 'chat',
        ref: {
          source: 'builtin',
          skillId: BUILTIN_IMAGEGEN_SKILL_ID,
          digest: BUILTIN_IMAGEGEN_SKILL_DIGEST,
        },
      },
    ]);
    expect(bindBuiltinImagegenSkillForTurn('$imagegen draw', 'codex', bound)).toEqual(bound);
  });

  it('installs a resolvable immutable builtin revision', async () => {
    const home = await mkdtemp(join(tmpdir(), 'sprint-coder-imagegen-skill-'));
    roots.push(home);
    await installBuiltinImagegenSkill(home);
    const store = await SkillStore.open({ rootPath: join(home, '.sprintcoder', 'skills') });
    await expect(
      store.resolveSelectable('builtin', BUILTIN_IMAGEGEN_SKILL_ID, BUILTIN_IMAGEGEN_SKILL_DIGEST),
    ).resolves.toMatchObject({ name: BUILTIN_IMAGEGEN_SKILL_ID, kind: 'chat' });
  });
});
