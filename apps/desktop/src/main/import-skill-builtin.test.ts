import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_IMPORT_SKILL_CONTENT,
  BUILTIN_IMPORT_SKILL_DIGEST,
  installBuiltinImportSkill,
} from './import-skill-builtin';
import { SkillStore } from './skill-store';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform === 'win32')('builtin import-skill', () => {
  it('asks for the CLI and source Skill before installing an enabled managed copy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sprint-coder-import-skill-'));
    roots.push(root);
    await installBuiltinImportSkill(root);

    const path = join(root, '.sprintcoder', 'skills', 'builtin', 'import-skill');
    expect(await readFile(join(path, 'SKILL.md'), 'utf8')).toBe(BUILTIN_IMPORT_SKILL_CONTENT);
    expect(BUILTIN_IMPORT_SKILL_CONTENT).toContain('Claude と Codex のどちら');
    expect(BUILTIN_IMPORT_SKILL_CONTENT).toContain('どのSkillをimportしますか');
    expect(BUILTIN_IMPORT_SKILL_CONTENT).toContain('skill_import_read');
    expect(BUILTIN_IMPORT_SKILL_CONTENT).toContain('skill_import_install');
    expect(JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'))).toMatchObject({
      source: 'builtin',
      digest: BUILTIN_IMPORT_SKILL_DIGEST,
      activationMode: 'system',
      replaceable: false,
    });

    const catalog = await (
      await SkillStore.open({ rootPath: join(root, '.sprintcoder', 'skills') })
    ).listSelectable();
    expect(catalog).toContainEqual(
      expect.objectContaining({ source: 'builtin', skillId: 'import-skill', enabled: true }),
    );
  });
});
