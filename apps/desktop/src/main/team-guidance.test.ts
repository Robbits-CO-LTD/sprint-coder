import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isTeamScenarioInput, LEADER_MCP_SYSTEM_PROMPT } from './team-tools';
import {
  attachBuiltinTeamSkill,
  BUILTIN_TEAM_SKILL_CONTENT,
  BUILTIN_TEAM_SKILL_DIGEST,
  BUILTIN_TEAM_SKILL_FRAGMENT_ID,
  installBuiltinTeamSkill,
  verifyBuiltinTeamSkillAcceptance,
} from './team-skill';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('builtin Team skill', () => {
  it('is the single source of Leader guidance', () => {
    expect(LEADER_MCP_SYSTEM_PROMPT).toBe(BUILTIN_TEAM_SKILL_CONTENT);
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('team_hire_worker');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('team_wait_reports');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('未着report');
  });

  it('recognizes explicit Team and worker-count intent without activating ordinary turns', () => {
    for (const input of ['チームで進めて', 'Teamでお願い', '2人雇って調査して'])
      expect(isTeamScenarioInput(input), input).toBe(true);
    for (const input of ['簡単に説明して', '一人称を直して', 'teamworkについて説明して'])
      expect(isTeamScenarioInput(input), input).toBe(false);
  });

  it('injects the authority-bearing fragment only for a Team turn', () => {
    const prepared = { fragments: [], usageEvents: [], compacted: false };
    expect(attachBuiltinTeamSkill(prepared, 'task-1', false)).toBe(prepared);
    const attached = attachBuiltinTeamSkill(prepared, 'task-1', true);
    expect(attached.fragments).toHaveLength(1);
    expect(attached.fragments[0]).toMatchObject({
      id: BUILTIN_TEAM_SKILL_FRAGMENT_ID,
      source: 'system',
      trust: 'system',
      content: BUILTIN_TEAM_SKILL_CONTENT,
    });
    expect(BUILTIN_TEAM_SKILL_FRAGMENT_ID).toContain(BUILTIN_TEAM_SKILL_DIGEST);
  });

  it('fails acceptance when the expected fragment is absent or unexpectedly present', () => {
    expect(verifyBuiltinTeamSkillAcceptance(true, [BUILTIN_TEAM_SKILL_FRAGMENT_ID])).toBe(true);
    expect(verifyBuiltinTeamSkillAcceptance(true, [])).toBe(false);
    expect(verifyBuiltinTeamSkillAcceptance(false, [BUILTIN_TEAM_SKILL_FRAGMENT_ID])).toBe(false);
    expect(verifyBuiltinTeamSkillAcceptance(false, [])).toBe(true);
  });

  it('installs a private versioned snapshot in the builtin namespace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sprint-coder-team-skill-'));
    roots.push(root);
    await installBuiltinTeamSkill(root);
    const path = join(root, '.sprintcoder', 'skills', 'builtin', 'sprint-coder-team');
    expect(await readFile(join(path, 'SKILL.md'), 'utf8')).toBe(BUILTIN_TEAM_SKILL_CONTENT);
    expect(JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'))).toMatchObject({
      source: 'builtin',
      digest: BUILTIN_TEAM_SKILL_DIGEST,
      activationMode: 'system',
      replaceable: false,
    });
  });
});
