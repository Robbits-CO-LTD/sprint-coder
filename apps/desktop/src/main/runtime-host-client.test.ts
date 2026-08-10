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
    expect(child.messages.map(messageType)).toEqual(['hello', 'start', 'cancel']);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(failed).toHaveBeenCalledOnce();
    client.dispose();
  });

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
      acceptedContextFragmentIds: [],
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
