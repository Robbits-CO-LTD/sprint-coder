import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  assertCodexSkillIsolation,
  codexSkillIsolationArgs,
  discoverWorkspaceSkillPaths,
  discoverWorkspaceSkillPathsForRoots,
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

    expect(discoverWorkspaceSkillPaths(nested)).toEqual([await realpath(join(skill, 'SKILL.md'))]);
  });

  it('discovers and validates Skills across every isolated Workspace root', async () => {
    const root = await temporaryRoot();
    const primary = join(root, 'primary');
    const secondary = join(root, 'secondary');
    const primarySkill = join(primary, '.agents', 'skills', 'primary-skill');
    const secondarySkill = join(secondary, '.agents', 'skills', 'secondary-skill');
    for (const [workspaceRoot, skillRoot, name] of [
      [primary, primarySkill, 'primary-skill'],
      [secondary, secondarySkill, 'secondary-skill'],
    ] as const) {
      await mkdir(join(workspaceRoot, '.git'), { recursive: true });
      await mkdir(skillRoot, { recursive: true });
      await writeFile(join(skillRoot, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n`);
    }

    expect(discoverWorkspaceSkillPathsForRoots([primary, secondary])).toEqual([
      await realpath(join(primarySkill, 'SKILL.md')),
      await realpath(join(secondarySkill, 'SKILL.md')),
    ]);
    const response = {
      data: [primary, secondary].map((cwd) => ({ cwd, skills: [], errors: [] })),
    };
    expect(() => assertCodexSkillIsolation(response, [], 2)).not.toThrow();
    expect(() => assertCodexSkillIsolation({ data: response.data.slice(0, 1) }, [], 2)).toThrow(
      'invalid catalog',
    );
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

  it.runIf(process.platform === 'win32')(
    'accepts CLI Skill paths whose drive-letter casing differs',
    async () => {
      const root = await temporaryRoot();
      const skillFile = join(root, 'reviewer', 'SKILL.md');
      await mkdir(join(root, 'reviewer'), { recursive: true });
      await writeFile(skillFile, '---\nname: reviewer\ndescription: review\n---\n');
      const first = skillFile[0]!;
      const variant = `${first === first.toLowerCase() ? first.toUpperCase() : first.toLowerCase()}${skillFile.slice(1)}`;

      expect(() =>
        assertCodexSkillIsolation(
          { data: [{ skills: [{ name: 'reviewer', path: variant, enabled: true }], errors: [] }] },
          [{ name: 'reviewer', path: skillFile }],
        ),
      ).not.toThrow();
    },
  );

  async function temporaryRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'sprint-coder-skill-isolation-'));
    roots.push(root);
    return root;
  }
});
