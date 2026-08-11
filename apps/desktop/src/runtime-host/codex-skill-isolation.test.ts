import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  assertCodexSkillIsolation,
  codexSkillIsolationArgs,
  discoverWorkspaceSkillPaths,
  prepareCodexSkillIsolation,
} from './codex-skill-isolation';

describe('Codex Skill isolation', () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true }))));

  it('stages only selected managed revisions and copies authentication privately', async () => {
    const root = await temporaryRoot();
    const sourceHome = join(root, 'source-home');
    const managed = join(root, 'managed', 'reviewer');
    await mkdir(sourceHome, { recursive: true });
    await mkdir(managed, { recursive: true });
    await writeFile(join(sourceHome, 'auth.json'), '{"token":"fixture"}');
    await writeFile(join(managed, 'SKILL.md'), '---\nname: reviewer\ndescription: review\n---\n');

    const isolation = prepareCodexSkillIsolation({
      temporaryRoot: join(root, 'runtime'),
      cwd: root,
      skills: [{ name: 'reviewer', path: managed }],
      environment: { CODEX_HOME: sourceHome },
    });

    expect(isolation.stagedSkills).toHaveLength(1);
    expect(isolation.stagedSkills[0]).toMatchObject({ name: 'reviewer' });
    expect(await readFile(isolation.stagedSkills[0]!.path, 'utf8')).toContain('name: reviewer');
    expect(await readFile(join(isolation.codexHome, 'auth.json'), 'utf8')).toBe(
      '{"token":"fixture"}',
    );
    expect(codexSkillIsolationArgs(isolation)).toContain('skills.include_instructions=false');
    expect(codexSkillIsolationArgs(isolation).join(' ')).toContain(
      'shell_environment_policy.set={HOME=',
    );
  });

  it('finds repository Skills to disable and stops at the git boundary', async () => {
    const root = await temporaryRoot();
    const nested = join(root, 'packages', 'app');
    const skill = join(root, '.agents', 'skills', 'repo-skill');
    await mkdir(join(root, '.git'));
    await mkdir(nested, { recursive: true });
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, 'SKILL.md'), '---\nname: repo-skill\ndescription: test\n---\n');

    expect(discoverWorkspaceSkillPaths(nested)).toEqual([join(skill, 'SKILL.md')]);
  });

  it('accepts exactly the staged enabled Skills and rejects any extra enabled Skill', () => {
    const expected = [{ name: 'reviewer', path: '/isolated/reviewer/SKILL.md' }];
    const response = {
      data: [
        {
          skills: [
            { ...expected[0], enabled: true },
            { name: 'workspace', path: '/repo/.agents/skills/workspace/SKILL.md', enabled: false },
          ],
          errors: [],
        },
      ],
    };
    expect(() => assertCodexSkillIsolation(response, expected)).not.toThrow();
    expect(() =>
      assertCodexSkillIsolation(
        {
          data: [
            {
              skills: [
                ...response.data[0]!.skills,
                { name: 'leaked', path: '/user/leaked/SKILL.md', enabled: true },
              ],
              errors: [],
            },
          ],
        },
        expected,
      ),
    ).toThrow('unselected Skill');
  });

  async function temporaryRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'sprint-coder-skill-isolation-'));
    roots.push(root);
    return root;
  }
});
