import { describe, expect, it } from 'vitest';
import {
  createSkepticRunner,
  type SkepticClientEvents,
  type SkepticRuntimeClient,
  type SkepticRuntimeDeps,
} from './skeptic-runtime';
import type { PreparedContext } from './context-ledger';

const context: PreparedContext = { fragments: [], usageEvents: [], compacted: false };

type StartCall = {
  taskId: string;
  turnId: string;
  prompt: string;
  workspacePath: string | null;
  model: string;
  writeScope: string;
};

function harness(overrides: Partial<SkepticRuntimeDeps> = {}) {
  const starts: StartCall[] = [];
  const cancels: { taskId: string; turnId: string }[] = [];
  const egress: { kind: string; taskId: string; turnId: string; prompt: string }[] = [];
  const workspaceLookups: string[] = [];
  const contextLookups: string[] = [];
  let events: SkepticClientEvents | null = null;
  let turn = 0;

  const client: SkepticRuntimeClient = {
    probe: async () => ({ available: true }),
    start: (taskId, turnId, prompt, workspacePath, model, _catalog, _ctx, _mcp, _e, writeScope) => {
      starts.push({ taskId, turnId, prompt, workspacePath, model, writeScope });
    },
    cancel: (taskId, turnId) => {
      cancels.push({ taskId, turnId });
    },
  };

  const deps: SkepticRuntimeDeps = {
    clientFor: (_kind, given) => {
      events = given;
      return client;
    },
    selectRuntime: () => ({ kind: 'claude', model: 'sonnet' }),
    workspaceFor: (taskId) => {
      workspaceLookups.push(taskId);
      return `/ws/${taskId}`;
    },
    catalogFor: () => ({}),
    contextFor: (taskId) => {
      contextLookups.push(taskId);
      return context;
    },
    authorizeEgress: (kind, taskId, turnId, prompt) => {
      egress.push({ kind, taskId, turnId, prompt });
      return true;
    },
    newTurnId: () => `turn-${(turn += 1)}`,
    ...overrides,
  };

  const runner = createSkepticRunner(deps);
  return {
    run: (
      input: Omit<Parameters<typeof runner>[0], 'taskId'> & {
        taskId?: string;
      },
    ) => {
      const { taskId = 'source-task', ...rest } = input;
      return runner({ taskId, ...rest });
    },
    starts,
    cancels,
    egress,
    workspaceLookups,
    contextLookups,
    complete: (turnId: string, text: string) => {
      events?.onEvent('t', turnId, { type: 'delta', delta: text });
      events?.onEvent('t', turnId, { type: 'completed' });
    },
    fail: (turnId: string, message: string) =>
      events?.onFailure('t', turnId, { userMessage: message }),
  };
}

const never = new AbortController().signal;

describe('running a skeptic on a real runtime', () => {
  it('returns the text the runtime streamed back', async () => {
    const h = harness();
    const pending = h.run({ skepticIndex: 0, prompt: 'judge this', signal: never });
    await Promise.resolve();
    h.complete('turn-1', '{"refuted": false}');
    await expect(pending).resolves.toBe('{"refuted": false}');
  });

  it('joins the stream in order rather than keeping only the last chunk', async () => {
    const h = harness();
    const pending = h.run({ skepticIndex: 0, prompt: 'p', signal: never });
    await Promise.resolve();
    h.complete('turn-1', '');
    await expect(pending).resolves.toBe('');
  });

  it('starts the turn read-only, so a judge cannot edit what it is judging', async () => {
    const h = harness();
    const pending = h.run({ skepticIndex: 0, prompt: 'p', signal: never });
    await Promise.resolve();
    expect(h.starts[0]?.writeScope).toBe('read-only');
    h.complete('turn-1', '{}');
    await pending;
  });

  it('gives each skeptic its own turn and its own task', async () => {
    const h = harness();
    const first = h.run({ skepticIndex: 0, prompt: 'p', signal: never });
    await Promise.resolve();
    h.complete('turn-1', 'a');
    await first;
    const second = h.run({ skepticIndex: 1, prompt: 'p', signal: never });
    await Promise.resolve();
    h.complete('turn-2', 'b');
    await second;
    expect(h.starts.map((call) => call.turnId)).toEqual(['turn-1', 'turn-2']);
    expect(new Set(h.starts.map((call) => call.taskId)).size).toBe(2);
  });

  it('keeps equal skeptic seats isolated across source Tasks', async () => {
    const h = harness();
    const first = h.run({ taskId: 'task-a', skepticIndex: 0, prompt: 'p', signal: never });
    await Promise.resolve();
    h.complete('turn-1', 'a');
    await first;
    const second = h.run({ taskId: 'task-b', skepticIndex: 0, prompt: 'p', signal: never });
    await Promise.resolve();
    h.complete('turn-2', 'b');
    await second;
    expect(h.starts.map((call) => call.taskId)).toEqual([
      'verification:task-a:skeptic-0',
      'verification:task-b:skeptic-0',
    ]);
  });

  it('keeps verification out of the Task whose work it judges', async () => {
    const h = harness();
    const pending = h.run({ skepticIndex: 0, prompt: 'p', signal: never });
    await Promise.resolve();
    expect(h.starts[0]?.taskId).toContain('verification');
    h.complete('turn-1', '{}');
    await pending;
  });

  it('ignores events belonging to another turn', async () => {
    const h = harness();
    const pending = h.run({ skepticIndex: 0, prompt: 'p', signal: never });
    await Promise.resolve();
    h.complete('turn-99', 'not mine');
    h.complete('turn-1', 'mine');
    await expect(pending).resolves.toBe('mine');
  });
});

describe('refusing to verify rather than pretending to', () => {
  it('fails when no runtime is configured', async () => {
    const h = harness({ selectRuntime: () => null });
    await expect(h.run({ skepticIndex: 0, prompt: 'p', signal: never })).rejects.toThrow(
      'No runtime is configured',
    );
    expect(h.starts).toEqual([]);
  });

  it('fails when the runtime reports itself unavailable', async () => {
    const h = harness({
      clientFor: () => ({
        probe: async () => ({ available: false }),
        start: () => undefined,
        cancel: () => undefined,
      }),
    });
    await expect(h.run({ skepticIndex: 0, prompt: 'p', signal: never })).rejects.toThrow(
      'unavailable for verification',
    );
  });

  it('does not send anything when egress policy denies it', async () => {
    const h = harness({ authorizeEgress: () => false });
    await expect(h.run({ skepticIndex: 0, prompt: 'p', signal: never })).rejects.toThrow(
      'egress was denied',
    );
    expect(h.starts).toEqual([]);
  });

  it('asks the egress gate about the prompt it is actually going to send', async () => {
    const h = harness();
    const pending = h.run({ skepticIndex: 0, prompt: 'the exact prompt', signal: never });
    await Promise.resolve();
    expect(h.egress[0]).toMatchObject({
      kind: 'claude',
      taskId: 'source-task',
      prompt: 'the exact prompt',
    });
    expect(h.workspaceLookups).toEqual(['source-task']);
    expect(h.contextLookups).toEqual(['source-task']);
    expect(h.starts[0]?.workspacePath).toBe('/ws/source-task');
    h.complete('turn-1', '{}');
    await pending;
  });

  it('surfaces a provider failure rather than returning an empty verdict', async () => {
    const h = harness();
    const pending = h.run({ skepticIndex: 0, prompt: 'p', signal: never });
    await Promise.resolve();
    h.fail('turn-1', 'the model is overloaded');
    await expect(pending).rejects.toThrow('the model is overloaded');
  });
});

describe('cancellation', () => {
  it('tells the provider to stop when the deadline passes', async () => {
    const controller = new AbortController();
    const h = harness();
    const pending = h.run({ skepticIndex: 0, prompt: 'p', signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toThrow('exceeded its deadline');
    expect(h.cancels).toEqual([{ taskId: h.starts[0]?.taskId, turnId: 'turn-1' }]);
  });

  it('does not start a turn that was already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness();
    await expect(
      h.run({ skepticIndex: 0, prompt: 'p', signal: controller.signal }),
    ).rejects.toThrow('cancelled before it started');
    expect(h.starts).toEqual([]);
  });
});
