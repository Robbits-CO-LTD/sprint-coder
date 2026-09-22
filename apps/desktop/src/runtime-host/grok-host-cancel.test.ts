import { afterAll, expect, it, vi } from 'vitest';
import { RUNTIME_PROTOCOL_VERSION } from './protocol';

const host = vi.hoisted(() => {
  let receive: (event: { data: unknown }) => void;
  const messages: Array<Record<string, unknown>> = [];
  return {
    messages,
    cancel: vi.fn(async (turnId: string) => {
      if (turnId === 'unconfirmed') throw new Error('PRIVATE_FAILURE_CANARY');
      return false;
    }),
    receive: (data: unknown) => receive({ data }),
    port: {
      on: (_event: string, handler: typeof receive) => {
        receive = handler;
      },
      postMessage: (message: Record<string, unknown>) => messages.push(message),
    },
  };
});
vi.mock('./parent-port', () => ({ requireParentPort: () => host.port }));
vi.mock('./grok-adapter', () => ({
  probeGrok: async () => ({ available: true, readiness: 'ready', models: [] }),
  GrokRuntimeAdapter: class {
    cancel = host.cancel;
    setCliVersion() {}
    setCliResolution() {}
    dispose() {}
  },
}));
process.argv.push('--runtime-instance-id', 'grok-cancel-host', '--runtime-kind', 'grok');
afterAll(() => {
  process.argv.splice(process.argv.indexOf('--runtime-instance-id'), 4);
});

it('contains rejected cancellation at the actual Host listener and reports correlated stop uncertainty', async () => {
  await import('./index');
  const base = {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    runtimeInstanceId: 'grok-cancel-host',
    taskId: 'task-1',
    turnId: 'unconfirmed',
    operationId: 'cancel-1',
    seq: 1,
  };
  host.receive({ ...base, type: 'cancel' });
  await vi.waitFor(() =>
    expect(host.messages).toContainEqual(
      expect.objectContaining({
        taskId: 'task-1',
        turnId: 'unconfirmed',
        operationId: 'cancel-1',
        type: 'error',
        error: expect.objectContaining({ code: 'RUNTIME_STOP_UNCONFIRMED', retryable: false }),
      }),
    ),
  );
  expect(host.messages.some((m) => m['type'] === 'stopped' && m['turnId'] === 'unconfirmed')).toBe(
    false,
  );
  expect(JSON.stringify(host.messages)).not.toContain('PRIVATE_FAILURE_CANARY');
  host.receive({
    ...base,
    type: 'cancel',
    taskId: 'task-2',
    turnId: 'confirmed',
    operationId: 'cancel-2',
  });
  await vi.waitFor(() =>
    expect(host.messages).toContainEqual(
      expect.objectContaining({ type: 'stopped', turnId: 'confirmed', forced: false }),
    ),
  );
});
