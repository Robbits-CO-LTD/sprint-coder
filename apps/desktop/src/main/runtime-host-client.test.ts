import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '@sprint-coder/domain';

class FakeUtilityProcess extends EventEmitter {
  readonly messages: unknown[] = [];
  readonly kill = vi.fn();

  postMessage(message: unknown): void {
    this.messages.push(message);
  }
}

const children: FakeUtilityProcess[] = [];

vi.mock('electron', () => ({
  utilityProcess: {
    fork: vi.fn(() => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    }),
  },
}));

import { RuntimeHostClient } from './runtime-host';

function emptyCatalog() {
  return new ToolRegistry().createSnapshot({ providerId: 'codex', workspaceId: null });
}

describe('RuntimeHostClient start acknowledgement', () => {
  afterEach(() => {
    children.length = 0;
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('fails once, requests cancellation, and kills a host that never acknowledges either', async () => {
    vi.useFakeTimers();
    const failed = vi.fn();
    const client = new RuntimeHostClient(vi.fn(), failed);
    const child = children[0]!;
    child.emit('spawn');

    expect(client.start('task-1', 'turn-1', 'hello', null, 'auto', emptyCatalog())).toBe(true);
    await Promise.resolve();
    expect(child.messages.map(messageType)).toEqual(['hello', 'start']);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(failed).toHaveBeenCalledOnce();
    expect(failed.mock.calls[0]?.[2]).toMatchObject({ code: 'RUNTIME_PROTOCOL_ERROR' });
    expect(failed.mock.calls[0]?.[3]).toMatchObject({
      failureStage: 'protocol_error',
      runtimeKind: 'codex',
      reasonCode: 'runtime_start_timeout',
    });
    expect(child.messages.map(messageType)).toEqual(['hello', 'start', 'cancel']);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(failed).toHaveBeenCalledOnce();
    client.dispose();
  });

  it('seals the current Codex user-config opt-in into each start envelope', async () => {
    let enabled = false;
    const client = new RuntimeHostClient(
      vi.fn(),
      vi.fn(),
      undefined,
      undefined,
      'codex',
      undefined,
      () => ({ inheritUserConfig: enabled }),
    );
    const child = children[0]!;
    child.emit('spawn');

    client.start('task-policy', 'turn-policy', 'hello', null, 'auto', emptyCatalog());
    await Promise.resolve();
    const first = child.messages.find((message) => messageType(message) === 'start') as Record<
      string,
      unknown
    >;
    expect(first['codexConfigPolicy']).toEqual({ inheritUserConfig: false });
    enabled = true;
    client.start('task-policy', 'turn-policy-2', 'hello', null, 'auto', emptyCatalog());
    await Promise.resolve();
    const starts = child.messages.filter((message) => messageType(message) === 'start') as Array<
      Record<string, unknown>
    >;
    expect(starts[1]?.['codexConfigPolicy']).toEqual({ inheritUserConfig: true });
    client.dispose();
  });

  it.each(['codex', 'claude'] as const)(
    'fails a rejected %s start once and ignores late or duplicate terminal responses',
    async (runtimeKind) => {
      vi.useFakeTimers();
      const failed = vi.fn();
      const client = new RuntimeHostClient(vi.fn(), failed, undefined, undefined, runtimeKind);
      const child = children[0]!;
      child.emit('spawn');

      client.start(
        'task-reject',
        'turn-reject',
        'PROMPT_CANARY_182 TOKEN_CANARY_182 ENV_CANARY_182 CREDENTIAL_CANARY_182',
        null,
        'auto',
        emptyCatalog(),
      );
      await Promise.resolve();
      const start = child.messages.find((message) => messageType(message) === 'start') as Record<
        string,
        unknown
      >;
      const rejected = {
        protocolVersion: start['protocolVersion'],
        runtimeInstanceId: start['runtimeInstanceId'],
        taskId: start['taskId'],
        turnId: start['turnId'],
        operationId: start['operationId'],
        seq: 1,
        type: 'error',
        error: {
          code: 'RUNTIME_PROTOCOL_ERROR',
          userMessage: 'Runtime HostがTurn開始入力を拒否しました。',
          retryable: false,
        },
        rejection: {
          reasonCode: 'invalid_project_context_authority',
          itemKind: 'instruction',
          authority: 'none',
        },
      };

      child.emit('message', rejected);
      child.emit('message', rejected);
      child.emit('message', { ...rejected, seq: 2, type: 'exit', code: 1, canceled: false });
      await vi.advanceTimersByTimeAsync(20_000);

      expect(failed).toHaveBeenCalledOnce();
      expect(failed.mock.calls[0]?.[3]).toMatchObject({
        failureStage: 'protocol_error',
        runtimeKind,
        reasonCode: 'invalid_project_context_authority',
      });
      const diagnosticJson = JSON.stringify(failed.mock.calls[0]?.[3]);
      for (const canary of [
        'PROMPT_CANARY_182',
        'TOKEN_CANARY_182',
        'ENV_CANARY_182',
        'CREDENTIAL_CANARY_182',
      ])
        expect(diagnosticJson).not.toContain(canary);
      client.dispose();
    },
  );

  it.each(['codex', 'claude'] as const)(
    'posts assistant and user Memory as valid %s starts without authority upgrades',
    async (runtimeKind) => {
      const failed = vi.fn();
      const client = new RuntimeHostClient(vi.fn(), failed, undefined, undefined, runtimeKind);
      const child = children[0]!;
      child.emit('spawn');
      const projectItems = [
        {
          id: 'assistant-memory',
          kind: 'memory' as const,
          authority: 'none' as const,
          localOnly: false,
          content: 'assistant memory',
          sealedDigest: 'a'.repeat(64),
          sourceTaskId: null,
          sourceTurnId: null,
          sourceReferenceId: null,
          capturedAt: '2026-08-11T00:00:00.000Z',
        },
        {
          id: 'user-memory',
          kind: 'memory' as const,
          authority: 'user' as const,
          localOnly: false,
          content: 'user memory',
          sealedDigest: 'b'.repeat(64),
          sourceTaskId: null,
          sourceTurnId: null,
          sourceReferenceId: null,
          capturedAt: '2026-08-11T00:00:00.000Z',
        },
      ];

      expect(
        client.start('task-memory', 'turn-memory', 'hello', null, 'auto', emptyCatalog(), {
          fragments: [],
          projectItems,
          projectSnapshotDigest: 'c'.repeat(64),
          usageEvents: [],
          compacted: false,
        }),
      ).toBe(true);
      await Promise.resolve();

      const start = child.messages.find((message) => messageType(message) === 'start') as {
        projectItems: typeof projectItems;
      };
      expect(start.projectItems.map(({ kind, authority }) => ({ kind, authority }))).toEqual([
        { kind: 'memory', authority: 'none' },
        { kind: 'memory', authority: 'user' },
      ]);
      expect(failed).not.toHaveBeenCalled();
      client.dispose();
    },
  );

  it('clears the deadline after a matching started acknowledgement', async () => {
    vi.useFakeTimers();
    const failed = vi.fn();
    const client = new RuntimeHostClient(vi.fn(), failed);
    const child = children[0]!;
    child.emit('spawn');

    client.start('task-1', 'turn-1', 'hello', null, 'auto', emptyCatalog());
    await Promise.resolve();
    const start = child.messages.find((message) => messageType(message) === 'start') as Record<
      string,
      unknown
    >;
    child.emit('message', {
      protocolVersion: start['protocolVersion'],
      runtimeInstanceId: start['runtimeInstanceId'],
      taskId: start['taskId'],
      turnId: start['turnId'],
      operationId: start['operationId'],
      seq: 1,
      type: 'started',
      acceptedContextFragmentIds: (start['contextFragments'] as Array<{ id: string }>).map(
        ({ id }) => id,
      ),
      acceptedProjectItemIds: [],
      acceptedProjectSnapshotDigest: null,
      acceptedPayloadDigest: start['payloadDigest'],
    });

    await vi.advanceTimersByTimeAsync(20_000);
    expect(failed).not.toHaveBeenCalled();
    expect(child.messages.map(messageType)).toEqual(['hello', 'start']);
    client.dispose();
  });

  it.each([
    {
      type: 'error' as const,
      error: { code: 'RUNTIME_FAILED' as const, userMessage: 'late error', retryable: true },
    },
    { type: 'exit' as const, code: 1, canceled: false },
  ])('does not report a second failure for a late $type response', async (lateResponse) => {
    vi.useFakeTimers();
    const failed = vi.fn();
    const client = new RuntimeHostClient(vi.fn(), failed);
    const child = children[0]!;
    child.emit('spawn');

    client.start('task-1', 'turn-1', 'hello', null, 'auto', emptyCatalog());
    await Promise.resolve();
    const start = child.messages.find((message) => messageType(message) === 'start') as Record<
      string,
      unknown
    >;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(failed).toHaveBeenCalledOnce();

    child.emit('message', {
      protocolVersion: start['protocolVersion'],
      runtimeInstanceId: start['runtimeInstanceId'],
      taskId: start['taskId'],
      turnId: start['turnId'],
      operationId: start['operationId'],
      seq: 1,
      ...lateResponse,
    });
    expect(failed).toHaveBeenCalledOnce();
    client.dispose();
  });
});

function messageType(message: unknown): unknown {
  return typeof message === 'object' && message !== null
    ? (message as Record<string, unknown>)['type']
    : undefined;
}
