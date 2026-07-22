import { describe, expect, it } from 'vitest';
import type { TurnEvent, TurnStage } from '@vibe/contracts';
import type { PersistenceClient } from './persistence';
import { MockRuntimeAdapter } from './runtime';

class FakePersistence implements Pick<
  PersistenceClient,
  'changeStage' | 'appendDelta' | 'completeTurn'
> {
  readonly events: TurnEvent[] = [];
  state: 'queued' | TurnStage | 'completed' | 'canceled' = 'queued';
  content = '';
  seq = 1;

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
    return this.record({ type: 'turn.completed', taskId, turnId, seq: ++this.seq, state });
  }

  private record<T extends TurnEvent>(event: T): T {
    this.events.push(event);
    return event;
  }
}

describe('MockRuntimeAdapter', () => {
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
      (taskId, turnId) => prepared.push(`${taskId}:${turnId}`),
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
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
