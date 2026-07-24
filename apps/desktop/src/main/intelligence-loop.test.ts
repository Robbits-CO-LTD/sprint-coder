import { describe, expect, it } from 'vitest';
import type { IntelligenceStepState, ReasoningEffort, StepSnapshot } from '@sprint-coder/domain';
import {
  createDeterministicMockSampler,
  deterministicMockToolExecutor,
  runIntelligenceLoop,
  type IntelligenceStepRecorder,
} from './intelligence-loop';
import { createDefaultToolBroker, startMockTurnCatalog } from './default-tools';

let catalogOrdinal = 0;
function mockCatalog() {
  catalogOrdinal += 1;
  const broker = createDefaultToolBroker(() => 0);
  return startMockTurnCatalog(broker, {
    taskId: 'task',
    turnId: `catalog-turn-${catalogOrdinal}`,
    workspaceId: null,
    policyEpoch: 0,
  });
}

class MemoryRecorder implements IntelligenceStepRecorder {
  readonly snapshots: StepSnapshot[] = [];
  readonly transitions = new Map<string, IntelligenceStepState[]>();

  createIntelligenceStep(input: {
    taskId: string;
    turnId: string;
    model: string;
    effort: ReasoningEffort;
    contextDigest: string;
    toolCatalogDigest: string;
    policyEpoch: number;
    workspaceRevision: string;
    contractRevision: number | null;
  }): StepSnapshot {
    const stepId = `step-${this.snapshots.length + 1}`;
    const snapshot = {
      stepId,
      ordinal: this.snapshots.length + 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      ...input,
    };
    this.snapshots.push(snapshot);
    this.transitions.set(stepId, []);
    return snapshot;
  }

  transitionIntelligenceStep(stepId: string, state: IntelligenceStepState): void {
    this.transitions.get(stepId)?.push(state);
  }
}

describe('runIntelligenceLoop', () => {
  it('re-samples in the same turn after a committed mock tool result', async () => {
    const recorder = new MemoryRecorder();
    const catalog = mockCatalog();
    const sampler = createDeterministicMockSampler('hello', 'done');
    const observedCatalogs: unknown[] = [];
    const result = await runIntelligenceLoop({
      taskId: 'task',
      turnId: 'turn',
      fragments: [],
      model: 'mock-v1',
      effort: 'low',
      policyEpoch: 0,
      workspaceRevision: 'none',
      contractRevision: null,
      toolCatalogSnapshot: catalog,
      sample: (input) => {
        observedCatalogs.push(input.toolCatalogSnapshot);
        return sampler(input);
      },
      executeTool: deterministicMockToolExecutor,
      recorder,
    });

    expect(result).toMatchObject({ text: 'done', stepCount: 2, toolCallCount: 1 });
    expect(observedCatalogs).toEqual([catalog, catalog]);
    expect(result.transcript).toEqual([
      expect.objectContaining({ type: 'tool-call', toolName: 'mock_echo' }),
      expect.objectContaining({ type: 'tool-result', content: 'hello' }),
    ]);
    expect(recorder.snapshots).toHaveLength(2);
    expect(recorder.snapshots.every(({ turnId }) => turnId === 'turn')).toBe(true);
    expect(
      recorder.snapshots.every(({ toolCatalogDigest }) => toolCatalogDigest.length === 64),
    ).toBe(true);
    expect(recorder.transitions.get('step-1')).toEqual([
      'sampling',
      'sampled',
      'dispatching',
      'toolsCommitted',
      'completed',
    ]);
    expect(recorder.transitions.get('step-2')).toEqual(['sampling', 'sampled', 'completed']);
  });

  it('supports answer-only sampling without a tool dispatch', async () => {
    const result = await runIntelligenceLoop({
      taskId: 'task',
      turnId: 'turn',
      fragments: [],
      model: 'mock-v1',
      effort: 'low',
      policyEpoch: 0,
      workspaceRevision: 'none',
      contractRevision: null,
      toolCatalogSnapshot: mockCatalog(),
      sample: createDeterministicMockSampler('hello', 'answer', 'answer-only'),
      executeTool: deterministicMockToolExecutor,
    });
    expect(result).toMatchObject({ text: 'answer', stepCount: 1, toolCallCount: 0 });
  });

  it('publishes an immutable catalog with a stable digest', () => {
    const catalog = mockCatalog();
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.entries)).toBe(true);
    expect(Object.isFrozen(catalog.entries[0])).toBe(true);
    expect(catalog.digest).toHaveLength(64);
  });

  it('rejects a model tool name outside the immutable Turn catalog before execution', async () => {
    let executed = false;
    await expect(
      runIntelligenceLoop({
        taskId: 'task',
        turnId: 'turn',
        fragments: [],
        model: 'mock-v1',
        effort: 'low',
        policyEpoch: 0,
        workspaceRevision: 'none',
        contractRevision: null,
        toolCatalogSnapshot: mockCatalog(),
        sample: () => ({
          kind: 'tool-calls',
          calls: [{ callId: 'call-1', toolName: 'injected_tool', arguments: {} }],
        }),
        executeTool: () => {
          executed = true;
          return 'unsafe';
        },
      }),
    ).rejects.toThrow('not present in the immutable Turn catalog');
    expect(executed).toBe(false);
  });

  it('commits a denied tool result and lets the next sample produce an alternative answer', async () => {
    const recorder = new MemoryRecorder();
    let toolResponseCount = 0;
    const result = await runIntelligenceLoop({
      taskId: 'task',
      turnId: 'turn',
      fragments: [],
      model: 'mock-v1',
      effort: 'low',
      policyEpoch: 0,
      workspaceRevision: 'none',
      contractRevision: null,
      toolCatalogSnapshot: mockCatalog(),
      sample: ({ stepOrdinal, transcript }) => {
        if (stepOrdinal === 1)
          return {
            kind: 'tool-calls',
            calls: [{ callId: 'denied-call', toolName: 'mock_echo', arguments: { text: 'deny' } }],
          };
        expect(transcript).toContainEqual({
          type: 'tool-result',
          callId: 'denied-call',
          content: 'User denied this operation',
          isError: true,
        });
        return { kind: 'final', text: '権限を使わない代替案です。' };
      },
      executeTool: () => {
        toolResponseCount += 1;
        return {
          ok: false,
          code: 'PERMISSION_DENIED',
          content: 'User denied this operation',
        } as never;
      },
      recorder,
    });

    expect(toolResponseCount).toBe(1);
    expect(result).toMatchObject({
      text: '権限を使わない代替案です。',
      stepCount: 2,
      toolCallCount: 1,
    });
    expect(recorder.transitions.get('step-1')).toEqual([
      'sampling',
      'sampled',
      'dispatching',
      'toolsCommitted',
      'completed',
    ]);
    expect(recorder.transitions.get('step-2')).toEqual(['sampling', 'sampled', 'completed']);
    expect([...recorder.transitions.values()].flat()).not.toContain('failed');
  });
});
