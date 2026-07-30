import { describe, expect, it } from 'vitest';
import type { ToolTranscriptItem } from './context-compiler';
import {
  createTeamScenarioSampler,
  isTeamScenarioInput,
  TEAM_SCENARIO_TRIGGER,
} from './team-tools';

const INPUT = `${TEAM_SCENARIO_TRIGGER}で対応してください`;

function toolCall(callId: string, toolName: string, args: unknown): ToolTranscriptItem {
  return { type: 'tool-call', callId, toolName, arguments: args };
}

function toolResult(callId: string, value: unknown): ToolTranscriptItem {
  return { type: 'tool-result', callId, content: JSON.stringify(value), isError: false };
}

describe('isTeamScenarioInput', () => {
  it('matches only the fixture trigger phrase', () => {
    expect(isTeamScenarioInput(INPUT)).toBe(true);
    expect(isTeamScenarioInput('通常の依頼です')).toBe(false);
  });
});

describe('createTeamScenarioSampler', () => {
  it('opens with three team_hire_worker calls for 調査/実装/レビュー', async () => {
    const sampler = createTeamScenarioSampler(INPUT);
    const sample = await sampler({
      stepOrdinal: 1,
      compiledContextDigest: 'digest',
      transcript: [],
      toolCatalogSnapshot: {
        revision: 0,
        providerId: 'mock',
        workspaceId: null,
        entries: [],
        digest: 'd',
      },
    });
    if (sample.kind !== 'tool-calls') throw new Error('expected tool-calls');
    expect(sample.calls).toHaveLength(3);
    expect(sample.calls.map((call) => call.toolName)).toEqual([
      'team_hire_worker',
      'team_hire_worker',
      'team_hire_worker',
    ]);
    expect(sample.calls.map((call) => (call.arguments as { role: string }).role)).toEqual([
      '調査',
      '実装',
      'レビュー',
    ]);
    expect(
      sample.calls.every(
        (call) => (call.arguments as { agentKind: string }).agentKind === 'worker',
      ),
    ).toBe(true);
    // Deterministic: identical input always produces identical callIds.
    const again = await sampler({
      stepOrdinal: 1,
      compiledContextDigest: 'digest',
      transcript: [],
      toolCatalogSnapshot: {
        revision: 0,
        providerId: 'mock',
        workspaceId: null,
        entries: [],
        digest: 'd',
      },
    });
    if (again.kind !== 'tool-calls') throw new Error('expected tool-calls');
    expect(again.calls.map((call) => call.callId)).toEqual(sample.calls.map((call) => call.callId));
  });

  it('formally assigns each hired worker once all three hires resolved', async () => {
    const sampler = createTeamScenarioSampler(INPUT);
    const transcript: ToolTranscriptItem[] = [
      toolCall('hire-1', 'team_hire_worker', { role: '調査', objective: 'x' }),
      toolResult('hire-1', { ok: true, workerId: 'w-research', role: '調査', state: 'ready' }),
      toolCall('hire-2', 'team_hire_worker', { role: '実装', objective: 'x' }),
      toolResult('hire-2', { ok: true, workerId: 'w-impl', role: '実装', state: 'ready' }),
      toolCall('hire-3', 'team_hire_worker', { role: 'レビュー', objective: 'x' }),
      toolResult('hire-3', { ok: true, workerId: 'w-review', role: 'レビュー', state: 'ready' }),
    ];
    const sample = await sampler({
      stepOrdinal: 2,
      compiledContextDigest: 'digest',
      transcript,
      toolCatalogSnapshot: {
        revision: 0,
        providerId: 'mock',
        workspaceId: null,
        entries: [],
        digest: 'd',
      },
    });
    if (sample.kind !== 'tool-calls') throw new Error('expected tool-calls');
    expect(sample.calls).toHaveLength(3);
    expect(sample.calls.every((call) => call.toolName === 'team_assign_task')).toBe(true);
    expect(sample.calls.map((call) => (call.arguments as { workerId: string }).workerId)).toEqual([
      'w-research',
      'w-impl',
      'w-review',
    ]);
    for (const call of sample.calls) {
      expect((call.arguments as { objective: string }).objective.length).toBeGreaterThan(0);
      expect((call.arguments as { doneCriteria: string[] }).doneCriteria).toHaveLength(1);
    }
  });

  it('waits for reports once Workers were formally assigned', async () => {
    const sampler = createTeamScenarioSampler(INPUT);
    const transcript: ToolTranscriptItem[] = [
      toolCall('hire-1', 'team_hire_worker', { role: '調査', objective: 'x' }),
      toolResult('hire-1', { ok: true, workerId: 'w1', role: '調査', state: 'ready' }),
      toolCall('assign-1', 'team_assign_task', {
        workerId: 'w1',
        objective: 'go',
        doneCriteria: ['done'],
      }),
      toolResult('assign-1', { ok: true, workerId: 'w1', executionId: 'e1', state: 'queued' }),
    ];
    const sample = await sampler({
      stepOrdinal: 3,
      compiledContextDigest: 'digest',
      transcript,
      toolCatalogSnapshot: {
        revision: 0,
        providerId: 'mock',
        workspaceId: null,
        entries: [],
        digest: 'd',
      },
    });
    if (sample.kind !== 'tool-calls') throw new Error('expected tool-calls');
    expect(sample.calls).toHaveLength(1);
    expect(sample.calls[0]?.toolName).toBe('team_wait_reports');
  });

  it('synthesizes a final answer from the three worker reports', async () => {
    const sampler = createTeamScenarioSampler(INPUT);
    const transcript: ToolTranscriptItem[] = [
      toolCall('hire-1', 'team_hire_worker', { role: '調査', objective: 'x' }),
      toolResult('hire-1', { ok: true, workerId: 'w-research', role: '調査', state: 'ready' }),
      toolCall('hire-2', 'team_hire_worker', { role: '実装', objective: 'x' }),
      toolResult('hire-2', { ok: true, workerId: 'w-impl', role: '実装', state: 'ready' }),
      toolCall('hire-3', 'team_hire_worker', { role: 'レビュー', objective: 'x' }),
      toolResult('hire-3', { ok: true, workerId: 'w-review', role: 'レビュー', state: 'ready' }),
      toolCall('assign-1', 'team_assign_task', {
        workerId: 'w-research',
        objective: 'go',
        doneCriteria: ['done'],
      }),
      toolResult('assign-1', { ok: true }),
      toolCall('assign-2', 'team_assign_task', {
        workerId: 'w-impl',
        objective: 'go',
        doneCriteria: ['done'],
      }),
      toolResult('assign-2', { ok: true }),
      toolCall('assign-3', 'team_assign_task', {
        workerId: 'w-review',
        objective: 'go',
        doneCriteria: ['done'],
      }),
      toolResult('assign-3', { ok: true }),
      toolCall('wait-1', 'team_wait_reports', {}),
      toolResult('wait-1', {
        ok: true,
        reports: [
          {
            workerId: 'w-research',
            seq: 4,
            content: JSON.stringify({ summary: '調査完了しました' }),
          },
          { workerId: 'w-impl', seq: 5, content: JSON.stringify({ summary: '実装完了しました' }) },
          {
            workerId: 'w-review',
            seq: 6,
            content: JSON.stringify({ summary: 'レビュー完了しました' }),
          },
        ],
      }),
    ];
    const sample = await sampler({
      stepOrdinal: 4,
      compiledContextDigest: 'digest',
      transcript,
      toolCatalogSnapshot: {
        revision: 0,
        providerId: 'mock',
        workspaceId: null,
        entries: [],
        digest: 'd',
      },
    });
    if (sample.kind !== 'final') throw new Error('expected a final answer');
    expect(sample.text).toContain('調査完了しました');
    expect(sample.text).toContain('実装完了しました');
    expect(sample.text).toContain('レビュー完了しました');
    expect(sample.text).toContain('調査');
    expect(sample.text).toContain('実装');
    expect(sample.text).toContain('レビュー');
  });
});
