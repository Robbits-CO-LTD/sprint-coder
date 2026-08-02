import { describe, expect, it } from 'vitest';
import type { TurnEvent, TurnStage } from '@sprint-coder/contracts';
import type { IntelligenceStepState, ReasoningEffort, StepSnapshot } from '@sprint-coder/domain';
import type { PersistenceClient } from './persistence';
import { createDefaultToolBroker, startMockTurnCatalog } from './default-tools';
import { MockRuntimeAdapter, mockFileChanges, mockWorkspaceBinding } from './runtime';

class FakePersistence implements Pick<
  PersistenceClient,
  'changeStage' | 'appendDelta' | 'completeTurn'
> {
  readonly events: TurnEvent[] = [];
  state: 'queued' | TurnStage | 'completed' | 'canceled' = 'queued';
  content = '';
  seq = 1;
  readonly steps: StepSnapshot[] = [];
  readonly stepTransitions = new Map<string, IntelligenceStepState[]>();

  getAcceptanceContract(): ReturnType<PersistenceClient['getAcceptanceContract']> {
    return {
      version: 1,
      id: 'contract',
      taskId: 'task',
      turnId: 'turn',
      revision: 3,
      objective: 'test',
      taskKind: 'answer',
      completionMode: 'response',
      profile: 'quick',
      criteria: [],
      nonGoals: [],
      allowedScope: [],
      maxRepairRounds: 0,
      digest: 'a'.repeat(64),
      createdAt: '2026-01-01T00:00:00.000Z',
    };
  }

  changeStage(taskId: string, turnId: string, stage: TurnStage): TurnEvent {
    this.state = stage;
    return this.record({ type: 'stage.changed', taskId, turnId, seq: ++this.seq, stage });
  }

  appendDelta(taskId: string, turnId: string, messageId: string, delta: string): TurnEvent {
    this.content += delta;
    return this.record({
      type: 'message.delta',
      taskId,
      turnId,
      seq: ++this.seq,
      messageId,
      delta,
    });
  }

  completeTurn(
    taskId: string,
    turnId: string,
    state: 'completed' | 'canceled' | 'failed' | 'interrupted',
  ): TurnEvent {
    this.state = state === 'completed' || state === 'canceled' ? state : 'canceled';
    return this.record({
      type: 'turn.completed',
      taskId,
      turnId,
      seq: ++this.seq,
      state,
      diff: [],
    });
  }

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
    const stepId = `step-${this.steps.length + 1}`;
    const snapshot = {
      stepId,
      ordinal: this.steps.length + 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      ...input,
    };
    this.steps.push(snapshot);
    this.stepTransitions.set(stepId, []);
    return snapshot;
  }

  transitionIntelligenceStep(stepId: string, state: IntelligenceStepState): void {
    this.stepTransitions.get(stepId)?.push(state);
  }

  private record<T extends TurnEvent>(event: T): T {
    this.events.push(event);
    return event;
  }
}

describe('MockRuntimeAdapter', () => {
  it('keeps workspace-bound tools reachable for Project roots', () => {
    const binding = mockWorkspaceBinding(null, {
      source: 'project',
      projectId: 'project-1',
      primaryRootId: 'root-a',
      roots: [
        {
          rootId: 'root-a',
          path: '/workspace/a',
          label: 'a',
          role: 'primary',
          status: 'available',
        },
        {
          rootId: 'root-b',
          path: '/workspace/b',
          label: 'b',
          role: 'secondary',
          status: 'available',
        },
      ],
      digest: 'a'.repeat(64),
    });
    expect(binding.workspaceId).not.toBeNull();
    expect(binding.workspaceRevision).toBe(`effective:${'a'.repeat(64)}`);
    const catalog = startMockTurnCatalog(
      createDefaultToolBroker(() => 0),
      {
        taskId: 'task',
        turnId: 'turn',
        workspaceId: binding.workspaceId,
        policyEpoch: 0,
      },
    );
    expect(catalog.entries.map(({ providerName }) => providerName)).toContain('run_command');
    expect(mockFileChanges('example', { rootId: 'root-a', rootLabel: 'a' })[0]).toMatchObject({
      rootId: 'root-a',
      rootLabel: 'a',
    });
  });

  it('streams deterministic Japanese output through every stage', async () => {
    const persistence = new FakePersistence();
    const published: TurnEvent[] = [];
    const prepared: string[] = [];
    const runtime = new MockRuntimeAdapter(
      persistence,
      (event) => published.push(event),
      1,
      undefined,
      undefined,
      (taskId, turnId) => {
        prepared.push(`${taskId}:${turnId}`);
      },
    );
    runtime.start('task', 'turn', '同じ入力');
    await waitFor(() => persistence.state === 'completed');

    expect(
      published
        .filter((event) => event.type === 'stage.changed')
        .map((event) => event.type === 'stage.changed' && event.stage),
    ).toEqual(['understanding', 'planning', 'executing', 'synthesizing']);
    expect(
      published.filter((event) => event.type === 'message.delta').length,
    ).toBeGreaterThanOrEqual(20);
    expect(persistence.content).toContain('同じ入力');
    expect(prepared).toEqual(['task:turn']);
    expect(persistence.steps).toHaveLength(2);
    expect(persistence.steps.map((step) => step.contractRevision)).toEqual([3, 3]);
    expect(persistence.stepTransitions.get('step-1')).toContain('toolsCommitted');
    expect(persistence.stepTransitions.get('step-2')).not.toContain('dispatching');
    expect(published.at(-1)).toMatchObject({ type: 'turn.completed', state: 'completed' });
    expect(published.map((event) => event.seq)).toEqual(
      [...published.map((event) => event.seq)].sort((a, b) => a - b),
    );
  });

  it('stops future deltas and publishes canceled', async () => {
    const persistence = new FakePersistence();
    const published: TurnEvent[] = [];
    const runtime = new MockRuntimeAdapter(persistence, (event) => published.push(event), 1);
    runtime.start('task', 'turn', '中止テスト');
    await waitFor(() => published.some((event) => event.type === 'message.delta'));
    runtime.cancel('turn');
    published.push(persistence.completeTurn('task', 'turn', 'canceled'));
    const deltaCount = published.filter((event) => event.type === 'message.delta').length;
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(published.filter((event) => event.type === 'message.delta')).toHaveLength(deltaCount);
    expect(published.at(-1)).toMatchObject({ type: 'turn.completed', state: 'canceled' });
    expect(persistence.content.length).toBeGreaterThan(0);
  });

  it('appends steering instructions to the remaining stream', async () => {
    const persistence = new FakePersistence();
    const runtime = new MockRuntimeAdapter(
      persistence,
      (event) => persistence.events.push(event),
      1,
    );
    runtime.start('task', 'turn', 'original');
    runtime.steer('turn', '短くまとめて');
    await waitFor(() => persistence.state === 'completed');

    expect(persistence.content).toContain('追加指示を反映しました: 短くまとめて');
  });

  it('acknowledges the exact prepared context before Mock sampling', async () => {
    const persistence = new FakePersistence();
    const accepted: string[][] = [];
    const runtime = new MockRuntimeAdapter(
      persistence,
      (event) => persistence.events.push(event),
      1,
      undefined,
      undefined,
      () => ({
        projectItems: [],
        projectSnapshotDigest: null,
        fragments: [
          {
            id: 'completion-1',
            taskId: 'task',
            source: 'background',
            trust: 'assistant',
            tokenEstimate: 2,
            content: 'done',
            createdAt: '2026-07-23T00:00:00.000Z',
            messageId: null,
          },
        ],
        usageEvents: [],
        compacted: false,
      }),
      undefined,
      (_taskId, _turnId, fragmentIds) => accepted.push([...fragmentIds]),
    );
    runtime.start('task', 'turn', 'continue');
    expect(accepted).toEqual([['completion-1']]);
    await waitFor(() => persistence.state === 'completed');
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
