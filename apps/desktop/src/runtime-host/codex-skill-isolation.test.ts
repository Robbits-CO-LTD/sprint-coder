import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  assertCodexSkillIsolation,
  codexSkillIsolationArgs,
  discoverWorkspaceSkillPaths,
  discoverWorkspaceSkillPathsForRoots,
  enforceCodexSkillIsolation,
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

  it('keeps user config disabled by default and snapshots it only for an opted-in Turn', async () => {
    const root = await temporaryRoot();
    const sourceHome = join(root, 'source-home');
    await mkdir(sourceHome, { recursive: true });
    await writeFile(
      join(sourceHome, 'config.toml'),
      '[mcp_servers.example]\ncommand = "example"\n',
    );

    const disabled = prepareCodexSkillIsolation({
      temporaryRoot: join(root, 'disabled'),
      cwd: root,
      skills: [],
      environment: { CODEX_HOME: sourceHome },
    });
    expect(disabled.userConfigSnapshot).toBe('disabled');
    await expect(readFile(join(disabled.codexHome, 'config.toml'), 'utf8')).rejects.toThrow();

    const enabled = prepareCodexSkillIsolation({
      temporaryRoot: join(root, 'enabled'),
      cwd: root,
      skills: [],
      configPolicy: { inheritUserConfig: true },
      environment: { CODEX_HOME: sourceHome },
    });
    expect(enabled.userConfigSnapshot).toBe('copied');
    expect(await readFile(join(enabled.codexHome, 'config.toml'), 'utf8')).toContain(
      '[mcp_servers.example]',
    );
  });

  it('rejects an opted-in config symlink instead of silently following it', async () => {
    const root = await temporaryRoot();
    const sourceHome = join(root, 'source-home');
    const target = join(root, 'config-target.toml');
    await mkdir(sourceHome, { recursive: true });
    await writeFile(target, 'model = "test"\n');
    await symlink(target, join(sourceHome, 'config.toml'));

    expect(() =>
      prepareCodexSkillIsolation({
        temporaryRoot: join(root, 'runtime'),
        cwd: root,
        skills: [],
        configPolicy: { inheritUserConfig: true },
        environment: { CODEX_HOME: sourceHome },
      }),
    ).toThrow('Codex user config snapshot failed');
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

  it('disables leaked nested Skills by path, reloads, and verifies the selected set', async () => {
    const root = await temporaryRoot();
    const selected = join(root, 'selected', 'SKILL.md');
    const leaked = join(root, 'agents', 'nested', 'repo', 'skills', 'leaked', 'SKILL.md');
    await mkdir(join(root, 'selected'), { recursive: true });
    await mkdir(join(root, 'agents', 'nested', 'repo', 'skills', 'leaked'), { recursive: true });
    await writeFile(selected, '---\nname: selected\ndescription: selected\n---\n');
    await writeFile(leaked, '---\nname: leaked\ndescription: leaked\n---\n');
    const responses = [
      {
        data: [
          {
            skills: [
              { name: 'selected', path: selected, enabled: true },
              { name: 'leaked', path: leaked, enabled: true },
            ],
            errors: [],
          },
        ],
      },
      {
        data: [
          {
            skills: [
              { name: 'selected', path: selected, enabled: true },
              { name: 'leaked', path: leaked, enabled: false },
            ],
            errors: [],
          },
        ],
      },
    ];
    const calls: Array<{ method: string; params: unknown }> = [];
    const disabled = await enforceCodexSkillIsolation(
      async (method, params) => {
        calls.push({ method, params });
        return method === 'skills/list' ? responses.shift() : { effectiveEnabled: false };
      },
      {
        codexHome: join(root, 'home', '.codex'),
        isolatedUserHome: join(root, 'home'),
        shellUserHome: root,
        selectedSkillsRoot: join(root, 'selected-skills'),
        stagedSkills: [{ name: 'selected', path: selected }],
        disabledWorkspaceSkillPaths: [],
        validationCwds: [root],
        userConfigSnapshot: 'disabled',
      },
    );

    expect(disabled).toEqual([await realpath(leaked)]);
    expect(calls).toEqual([
      { method: 'skills/list', params: { cwds: [root], forceReload: true } },
      { method: 'skills/config/write', params: { path: await realpath(leaked), enabled: false } },
      { method: 'skills/list', params: { cwds: [root], forceReload: true } },
    ]);
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
