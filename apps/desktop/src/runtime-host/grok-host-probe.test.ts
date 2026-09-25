import { afterAll, expect, it, vi } from 'vitest';
import { RUNTIME_PROTOCOL_VERSION, isRuntimeToMainEnvelope } from './protocol';

const host = vi.hoisted(() => {
  let receive: (event: { data: unknown }) => void;
  const messages: Array<Record<string, unknown>> = [];
  return {
    messages,
    probeGrok: vi.fn(),
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
  probeGrok: host.probeGrok,
  GrokRuntimeAdapter: class {
    setCliVersion() {}
    setCliResolution() {}
    dispose() {}
  },
}));
process.argv.push('--runtime-instance-id', 'grok-probe-host', '--runtime-kind', 'grok');
afterAll(() => {
  process.argv.splice(process.argv.indexOf('--runtime-instance-id'), 4);
});

it('reports the answered readiness with the stop uncertainty, and detects again on a later hello (issue #581)', async () => {
  await import('./index');
  const models = [{ id: 'auto', displayName: 'Auto', description: 'Grok CLI default' }];
  host.probeGrok
    .mockResolvedValueOnce({ available: true, readiness: 'ready', models, stopUnconfirmed: true })
    .mockResolvedValueOnce({ available: true, readiness: 'ready', models });
  const hello = (operationId: string) =>
    host.receive({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId: 'grok-probe-host',
      taskId: '',
      turnId: '',
      seq: 1,
      operationId,
      type: 'hello',
    });

  hello('hello');
  await vi.waitFor(() => expect(host.messages).toHaveLength(1));
  expect(host.messages[0]).toMatchObject({
    operationId: 'hello',
    type: 'hello',
    grokAvailable: true,
    grokReadiness: 'ready',
    grokProbeStopUnconfirmed: true,
  });
  expect(isRuntimeToMainEnvelope(host.messages[0])).toBe(true);

  hello('capability-refresh:1');
  await vi.waitFor(() => expect(host.messages).toHaveLength(2));
  expect(host.probeGrok).toHaveBeenCalledTimes(2);
  expect(host.messages[1]).toMatchObject({
    operationId: 'capability-refresh:1',
    grokReadiness: 'ready',
  });
  expect(host.messages[1]).not.toHaveProperty('grokProbeStopUnconfirmed');
});
