import { describe, expect, it } from 'vitest';
import type { IntelligenceStepState, ReasoningEffort, StepSnapshot } from '@vibe/domain';
import {
  createDeterministicMockSampler,
  deterministicMockToolExecutor,
  MOCK_TOOL_CATALOG,
  MOCK_TOOL_CATALOG_DIGEST,
  runIntelligenceLoop,
  type IntelligenceStepRecorder,
} from './intelligence-loop';

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
    const result = await runIntelligenceLoop({
      taskId: 'task',
      turnId: 'turn',
      fragments: [],
      model: 'mock-v1',
      effort: 'low',
      policyEpoch: 0,
      workspaceRevision: 'none',
      contractRevision: null,
      sample: createDeterministicMockSampler('hello', 'done'),
      executeTool: deterministicMockToolExecutor,
      recorder,
    });

    expect(result).toMatchObject({ text: 'done', stepCount: 2, toolCallCount: 1 });
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
      sample: createDeterministicMockSampler('hello', 'answer', 'answer-only'),
      executeTool: deterministicMockToolExecutor,
    });
    expect(result).toMatchObject({ text: 'answer', stepCount: 1, toolCallCount: 0 });
  });

  it('publishes an immutable catalog with a stable digest', () => {
    expect(Object.isFrozen(MOCK_TOOL_CATALOG)).toBe(true);
    expect(Object.isFrozen(MOCK_TOOL_CATALOG[0])).toBe(true);
    expect(MOCK_TOOL_CATALOG_DIGEST).toHaveLength(64);
  });
});
