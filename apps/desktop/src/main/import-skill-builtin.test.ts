import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_IMPORT_SKILL_CONTENT,
  BUILTIN_IMPORT_SKILL_DIGEST,
  BUILTIN_IMPORT_SKILL_ID,
  bindBuiltinImportSkillForTurn,
  installBuiltinImportSkill,
  parseSkillImportConfirmation,
} from './import-skill-builtin';
import { SkillStore } from './skill-store';
import { SkillSettingsService } from './skill-settings-service';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform === 'win32')('builtin import-skill', () => {
  it('binds the builtin only for an exact one-line confirmation', () => {
    expect(parseSkillImportConfirmation('IMPORT_SKILL codex issue-planner')).toEqual({
      cli: 'codex',
      skillId: 'issue-planner',
    });
    expect(parseSkillImportConfirmation('import_skill CLAUDE writer')).toEqual({
      cli: 'claude',
      skillId: 'writer',
    });
    for (const input of [
      'IMPORT_SKILL  codex issue-planner',
      'IMPORT_SKILL\tcodex\tissue-planner',
      'IMPORT_SKILL codex issue-planner ',
      'IMPORT_SKILL codex issue-planner\n',
      'IMPORT_SKILL codex issue-planner now',
      'IMPORT_SKILL other issue-planner',
      'IMPORT_SKILL codex ../issue-planner',
    ])
      expect(parseSkillImportConfirmation(input), input).toBeNull();

    const [selection] = bindBuiltinImportSkillForTurn('IMPORT_SKILL codex issue-planner', []);
    expect(selection).toEqual({
      kind: 'chat',
      ref: {
        source: 'builtin',
        skillId: BUILTIN_IMPORT_SKILL_ID,
        digest: BUILTIN_IMPORT_SKILL_DIGEST,
      },
    });
    expect(bindBuiltinImportSkillForTurn('IMPORT_SKILL codex issue-planner', [selection!])).toEqual(
      [selection],
    );
    expect(bindBuiltinImportSkillForTurn('import skill please', [])).toEqual([]);
  });

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

    const service = new SkillSettingsService({ homePath: root });
    const resolved = await service.resolveSelections(
      bindBuiltinImportSkillForTurn('IMPORT_SKILL codex issue-planner', []),
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      selection: {
        kind: 'chat',
        ref: { source: 'builtin', skillId: BUILTIN_IMPORT_SKILL_ID },
      },
      content: BUILTIN_IMPORT_SKILL_CONTENT,
    });
  });
});
