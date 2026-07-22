import { parentPort } from 'electron/utility';
import { CodexRuntimeAdapter, probeCodex } from './codex-adapter';
import {
  RUNTIME_PROTOCOL_VERSION,
  isMainToRuntimeEnvelope,
  type RuntimeToMainEnvelope,
} from './protocol';

const runtimeInstanceId = readRuntimeInstanceId();
const adapter = new CodexRuntimeAdapter();
const sequences = new Map<string, number>();

parentPort.on('message', ({ data }: Electron.MessageEvent) => {
  if (!isMainToRuntimeEnvelope(data) || data.runtimeInstanceId !== runtimeInstanceId) return;
  if (data.type === 'start') {
    adapter.start(
      data.turnId,
      data.input,
      data.workspacePath,
      (event) => send(data.taskId, data.turnId, data.operationId, { type: 'event', event }),
      (error) => send(data.taskId, data.turnId, data.operationId, { type: 'error', error }),
      (code, canceled) =>
        send(data.taskId, data.turnId, data.operationId, { type: 'exit', code, canceled }),
    );
  } else if (data.type === 'cancel') {
    adapter.cancel(data.turnId);
  }
});

void probeCodex().then((probe) =>
  send('', '', 'probe', {
    type: 'hello',
    codexAvailable: probe.available,
    ...(probe.version === undefined ? {} : { codexVersion: probe.version }),
  }),
);

process.once('exit', () => adapter.dispose());

function send(
  taskId: string,
  turnId: string,
  operationId: string,
  payload:
    | Pick<
        Extract<RuntimeToMainEnvelope, { type: 'hello' }>,
        'type' | 'codexAvailable' | 'codexVersion'
      >
    | Pick<Extract<RuntimeToMainEnvelope, { type: 'event' }>, 'type' | 'event'>
    | Pick<Extract<RuntimeToMainEnvelope, { type: 'exit' }>, 'type' | 'code' | 'canceled'>
    | Pick<Extract<RuntimeToMainEnvelope, { type: 'error' }>, 'type' | 'error'>,
): void {
  const seq = (sequences.get(turnId) ?? 0) + 1;
  sequences.set(turnId, seq);
  parentPort.postMessage({
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    runtimeInstanceId,
    taskId,
    turnId,
    seq,
    operationId,
    ...payload,
  } satisfies RuntimeToMainEnvelope);
}

function readRuntimeInstanceId(): string {
  const index = process.argv.indexOf('--runtime-instance-id');
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.length === 0) throw new Error('Missing runtime instance id');
  return value;
}
