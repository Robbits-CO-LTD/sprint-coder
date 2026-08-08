import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTEXT_SYSTEM_PROMPT } from './context-ledger';
import {
  isTeamContinuationInput,
  isTeamScenarioInput,
  LEADER_MCP_SYSTEM_PROMPT,
  LEADER_PROVIDER_TOOLS,
  TEAM_HIRE_WORKER_TOOL,
} from './team-tools';
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
  it('routes team-related conversation through the builtin Team skill', () => {
    expect(CONTEXT_SYSTEM_PROMPT).toContain('必ず組み込みSkill `sprint-coder-team` を使い');
    expect(CONTEXT_SYSTEM_PROMPT).toContain(
      'subagent機能、外部Skill、別のMCPで代用してはいけません',
    );
    expect(CONTEXT_SYSTEM_PROMPT).toContain('架空のリーダーやメンバーを作らず');
    expect(isTeamScenarioInput('チームで二人雇って挨拶して')).toBe(true);
  });

  it('is the single source of Leader guidance', () => {
    expect(LEADER_MCP_SYSTEM_PROMPT).toBe(BUILTIN_TEAM_SKILL_CONTENT);
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('team_list_models');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('team_send_message');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('team_read_messages');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('team_hire_worker');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('agentKind: "manager"');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('maxDelegationLevels: 1');
    expect(BUILTIN_TEAM_SKILL_CONTENT).not.toContain('maxDelegationDepth');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('team_get_status');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('team_steer_execution');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('liveOutput');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('team_wait_reports');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('未着report');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('全execution ID');
  });

  it('recognizes explicit Team and worker-count intent without activating ordinary turns', () => {
    for (const input of [
      'チームで進めて',
      'チーム内で挨拶して',
      'チーム内の会話を読んで',
      'チームメンバー同士で挨拶して',
      'チームのメンバーに会話させて',
      'チームの会話を読んで',
      'チームのメンバーに挨拶して',
      'Teamでお願い',
      'team 2り雇って挨拶を交わして',
      '2人雇って調査して',
      '数学と実装の観点を2人体制で並行に検討して',
      '5人で作業して',
      '八人でレビューして',
      '10人で監査して',
      '１０人で実装して',
      '合計10名構成で検証して',
      '合計10名（深度0×1・1×3・2×6）を作成して',
      '/team リポジトリを並列調査して',
      '/TEAM\n設計と実装を分担して',
    ])
      expect(isTeamScenarioInput(input), input).toBe(true);
    for (const input of [
      '簡単に説明して',
      '一人称を直して',
      'teamworkについて説明して',
      'チームの意味を説明して',
      '/team',
      '/teamworkについて説明して',
      'READMEに /team 調査して と書いて',
    ])
      expect(isTeamScenarioInput(input), input).toBe(false);
  });

  it('recognizes narrow retry and Team member reassignment instructions as continuation input', () => {
    for (const input of [
      'continue',
      'Resume',
      'retry',
      '続けて',
      '再開してください',
      'リトライ',
      'codex to ollamanisite',
      'CodexとOllamaにして',
      '担当をCodexとOllamaへ変更して',
    ])
      expect(isTeamContinuationInput(input), input).toBe(true);
    for (const input of ['続きを説明して', 'continue implementing this feature', '通常の依頼です'])
      expect(isTeamContinuationInput(input), input).toBe(false);
  });

  it('keeps the built-in and Provider hire schemas on the same discriminated contract', () => {
    const builtInSchema = TEAM_HIRE_WORKER_TOOL.inputSchema as Record<string, unknown>;
    const providerSchema = LEADER_PROVIDER_TOOLS.find(({ name }) => name === 'team_hire_worker')
      ?.inputSchema as unknown as Record<string, unknown>;
    expect(providerSchema['properties']).toEqual(builtInSchema['properties']);
    expect(providerSchema['allOf']).toEqual(builtInSchema['allOf']);
    expect(providerSchema['required']).toEqual(
      expect.arrayContaining(['agentKind', 'role', 'objective']),
    );
  });

  it('injects the authority-bearing fragment only for a Team turn', () => {
    const prepared = {
      fragments: [],
      projectItems: [],
      projectSnapshotDigest: null,
      usageEvents: [],
      compacted: false,
    };
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

  it.skipIf(process.platform === 'win32')(
    'installs a private versioned snapshot in the builtin namespace',
    async () => {
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
    },
  );
});
