import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTEXT_SYSTEM_PROMPT } from './context-ledger';
import {
  isExistingTeamFollowupInput,
  isTeamContinuationInput,
  isTeamScenarioInput,
  requiresTeamWorkersInput,
  LEADER_MCP_SYSTEM_PROMPT,
  LEADER_PROVIDER_TOOLS,
  TEAM_HIRE_WORKER_TOOL,
} from './team-tools';
import { teamGuidance } from './ipc';
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
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('writeCapable: true');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('agentKind: "manager"');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('maxDelegationLevels: 1');
    expect(BUILTIN_TEAM_SKILL_CONTENT).not.toContain('maxDelegationDepth');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('team_get_status');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('team_steer_execution');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('liveOutput');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('team_wait_reports');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('未着report');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('全execution ID');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('終端済みの旧Workerは再利用できない');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain(
      'Team状態がfailedなどcompleted以外なら再形成できると判断せず',
    );
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain(
      '新しいWorkerの採用によって完了済みTeamは安全に再形成される',
    );
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain(
      '採用失敗だけを理由に「新しいTeamが必要」と判断してはならない',
    );
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('builtin:claude-cli');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('OpenRouter上のClaudeよりClaude CLIを優先');
  });

  it('adds the saved model-selection policy to Team guidance', () => {
    const guidance = teamGuidance(
      'base',
      false,
      'APIを使う前にユーザーへ確認する。ClaudeはClaude CLIを選ぶ。',
    );
    expect(guidance).toContain('<team-model-selection-guidance>');
    expect(guidance).toContain('APIを使う前にユーザーへ確認する');
    expect(guidance).toContain('必ず従ってください');
  });

  it('recognizes explicit Team and worker-count intent without activating ordinary turns', () => {
    for (const input of [
      'チームで進めて',
      'Codexでチーム編成して',
      'チーム作成してください',
      'チーム編成をお願いします',
      'チーム内で挨拶して',
      'チーム内の会話を読んで',
      'チームメンバー同士で挨拶して',
      'チームのメンバーに会話させて',
      'チームの会話を読んで',
      'チームのメンバーに挨拶して',
      'Teamでお願い',
      'Team作成は完了できませんでした。利用上限なら別のAIへfallbackしてください。',
      'Teamがfailed状態です。利用可能なWorkerだけ追加してください。',
      'Team実行ツールは現在のTurnで利用できません。',
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
      'チーム編成について説明して',
      'チーム作成とは何か説明して',
      '/team',
      '/teamworkについて説明して',
      'READMEに /team 調査して と書いて',
    ])
      expect(isTeamScenarioInput(input), input).toBe(false);
  });

  it('recognizes explicit leader/worker role assignments without activating explanations', () => {
    const executions = [
      'Sprint Coderで現在選択しているモデルをリーダーにしてOllamaのローカルLLMをワーカーにした実装skillを構築して',
      'Use Codex as the leader and Ollama as the worker to implement this feature',
      'リーダーをCodex、ワーカーをOllamaへ変更して作業を進めて',
      'Codexをリーダー、Ollamaをワーカーにして実装して',
      'Make Codex the leader and Ollama the worker and implement this feature',
      'Use Codex as the leader and Ollama as the worker to implement this without adding dependencies',
      'Use Codex as the leader and Ollama as the worker to implement this and never modify tests',
      'Set Codex as the leader and Ollama as the worker, then implement this feature',
      'Make Codex the leader and Ollama the worker, then implement this feature',
    ];
    const consultations = [
      'リーダーとワーカーの違いを説明して',
      'リーダーにする方法とワーカーにする方法を説明して',
      'リーダーモデルとワーカーモデルを比較して',
      'リーダーとワーカーの設定について相談したい',
      'リーダーとワーカーを割り当てずに説明して',
      'リーダーをCodexにしてワーカーをOllamaにしないで実装して',
      'リーダーについて説明し、ワーカーをOllamaへ変更して実装して',
      'リーダー候補を比較し、ワーカーをOllamaにして実装して',
      "Don't use Codex as the leader or Ollama as the worker; review this plan",
      'Never use Codex as the leader and Ollama as the worker; implement it yourself',
      "Codex shouldn't be used as the leader and Ollama as the worker; review this plan",
      'Review the sentence “Use Codex as the leader and Ollama as the worker to implement this feature” for grammar',
      '次の文「CodexをリーダーにしてOllamaをワーカーにした機能を実装して」を添削して',
      'Codexをリーダーにしてはいけない、Ollamaをワーカーにして実装して',
      'リーダーをCodexと比較し、ワーカーをOllamaと比較し、実装して',
      'リーダーをCodexと比較し、ワーカーをOllamaにして実装して',
      'リーダーをCodexと対比し、ワーカーをOllamaにして実装して',
      'リーダーをCodexと評価し、ワーカーをOllamaにして実装して',
      "Use the sentence 'Codex as the leader and Ollama as the worker' and review its grammar",
      'Use the sentence Codex as the leader and Ollama as the worker and review its grammar',
      'Use this sentence as an example: Codex as the leader and Ollama as the worker and review its grammar',
      'Use the following text: Codex as the leader and Ollama as the worker and review it',
      'Use Codex as the leader but do not use Ollama as the worker and implement this feature',
      'Use Codex not as the leader and Ollama not as the worker and implement this feature',
      'Codexをリーダーにしたくない、Ollamaをワーカーにして実装して',
      'Codexをリーダーにしてほしくない、Ollamaをワーカーにして実装して',
      'Codexをリーダーにして欲しくない、Ollamaをワーカーにして実装して',
      'Codexをリーダーへ変更して欲しくない、Ollamaをワーカーにして実装して',
      'Use Codex as the leader and Ollama as the worker to implement this, or would another setup be better?',
      'Use Codex as the leader and Ollama as the worker to implement this—actually, don’t.',
    ];
    for (const input of executions) {
      expect(isTeamScenarioInput(input), input).toBe(true);
      expect(requiresTeamWorkersInput(input), input).toBe(true);
    }
    for (const input of consultations) {
      expect(isTeamScenarioInput(input), input).toBe(false);
      expect(requiresTeamWorkersInput(input), input).toBe(false);
    }
  });

  it('separates Team consultation from requests that must create Workers', () => {
    expect(isTeamScenarioInput('teamで並列編集できますか？')).toBe(true);
    expect(requiresTeamWorkersInput('teamで並列編集できますか？')).toBe(false);
    expect(requiresTeamWorkersInput('Workerを3名雇って編集して')).toBe(true);
    expect(requiresTeamWorkersInput('チームでコードを書いて')).toBe(true);
    expect(requiresTeamWorkersInput('チームで編集してください')).toBe(true);
    expect(requiresTeamWorkersInput('Workerを3名雇ってください')).toBe(true);
    expect(requiresTeamWorkersInput('Teamで実行してほしい')).toBe(true);
    expect(requiresTeamWorkersInput('チームでの編集をお願いします')).toBe(true);
    expect(
      requiresTeamWorkersInput('Workerを3名雇って実装してください。完了後に結果を教えて'),
    ).toBe(true);
    expect(requiresTeamWorkersInput('/team リポジトリを並列調査して')).toBe(true);
    expect(requiresTeamWorkersInput('チームで何ができますか？')).toBe(false);
    expect(requiresTeamWorkersInput('チームの使い方を説明して')).toBe(false);
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
      'Ollama担当にして',
    ])
      expect(isTeamContinuationInput(input), input).toBe(true);
    for (const input of [
      '続きを説明して',
      'continue implementing this feature',
      '通常の依頼です',
      'モデルを変更して',
      '使用モデルをClaudeにして',
      'Codexに変更して',
      'ワーカーをOllamaにした理由を説明して',
      'workerのtechnisiteを説明して',
    ])
      expect(isTeamContinuationInput(input), input).toBe(false);
  });

  it('recognizes follow-up actions that target an existing Team without the Team keyword', () => {
    for (const input of [
      'worker同士で挨拶して',
      'メンバーからの報告を確認して',
      'リーダーにもう一度連絡して',
      'もう一回挨拶して',
      '再度会話させて',
      'workerに実装させて',
      'メンバーへ調査を依頼して',
    ])
      expect(isExistingTeamFollowupInput(input), input).toBe(true);
    for (const input of [
      '続きを説明して',
      'もう一回ビルドして',
      'もう一回実装して',
      'worker.tsを編集して',
      'メンバー変数を実装して',
      'agentの実装をレビューして',
      'workerの実装を確認して',
      '通常の依頼です',
    ])
      expect(isExistingTeamFollowupInput(input), input).toBe(false);
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
