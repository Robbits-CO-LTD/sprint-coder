import { describe, expect, it } from 'vitest';
import type { ChatMessage, TaskSummary, TurnEvent, TurnStage } from '@vibe/contracts';
import type { PersistenceClient } from './persistence';
import { MockRuntimeAdapter } from './runtime';

class FakePersistence implements PersistenceClient {
  readonly events: TurnEvent[] = [];
  state: 'queued' | TurnStage | 'completed' | 'canceled' = 'queued';
  content = '';
  seq = 1;

  listTasks(): TaskSummary[] { return []; }
  createTask(): TaskSummary { throw new Error('unused'); }
  renameTask(): TaskSummary { throw new Error('unused'); }
  listMessages(): ChatMessage[] { return []; }
  startTurn(): { turnId: string; event: TurnEvent } { throw new Error('unused'); }
  interruptActiveTurns(): number { return 0; }
  close(): void {}

  changeStage(taskId: string, turnId: string, stage: TurnStage): TurnEvent {
    this.state = stage;
    return this.record({ type: 'stage.changed', taskId, turnId, seq: ++this.seq, stage });
  }

  appendDelta(taskId: string, turnId: string, messageId: string, delta: string): TurnEvent {
    this.content += delta;
    return this.record({ type: 'message.delta', taskId, turnId, seq: ++this.seq, messageId, delta });
  }

  completeTurn(taskId: string, turnId: string, state: 'completed' | 'canceled' | 'failed' | 'interrupted'): TurnEvent {
    this.state = state === 'completed' || state === 'canceled' ? state : 'canceled';
    return this.record({ type: 'turn.completed', taskId, turnId, seq: ++this.seq, state });
  }

  cancelTurn(taskId: string, turnId: string): TurnEvent | null {
    return this.completeTurn(taskId, turnId, 'canceled');
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
    const runtime = new MockRuntimeAdapter(persistence, (event) => published.push(event), 1);
    runtime.start('task', 'turn', '同じ入力');
    await waitFor(() => persistence.state === 'completed');

    expect(published.filter((event) => event.type === 'stage.changed').map((event) => event.type === 'stage.changed' && event.stage))
      .toEqual(['understanding', 'planning', 'executing', 'synthesizing']);
    expect(published.filter((event) => event.type === 'message.delta').length).toBeGreaterThanOrEqual(20);
    expect(persistence.content).toContain('同じ入力');
    expect(published.at(-1)).toMatchObject({ type: 'turn.completed', state: 'completed' });
    expect(published.map((event) => event.seq)).toEqual([...published.map((event) => event.seq)].sort((a, b) => a - b));
  });

  it('stops future deltas and publishes canceled', async () => {
    const persistence = new FakePersistence();
    const published: TurnEvent[] = [];
    const runtime = new MockRuntimeAdapter(persistence, (event) => published.push(event), 1);
    runtime.start('task', 'turn', '中止テスト');
    await waitFor(() => published.some((event) => event.type === 'message.delta'));
    runtime.cancel('task', 'turn');
    const deltaCount = published.filter((event) => event.type === 'message.delta').length;
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(published.filter((event) => event.type === 'message.delta')).toHaveLength(deltaCount);
    expect(published.at(-1)).toMatchObject({ type: 'turn.completed', state: 'canceled' });
    expect(persistence.content.length).toBeGreaterThan(0);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
