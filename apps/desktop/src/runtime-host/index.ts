import { CodexRuntimeAdapter, probeCodex } from './codex-adapter';
import { ClaudeRuntimeAdapter, probeClaude } from './claude-adapter';
import {
  RUNTIME_PROTOCOL_VERSION,
  isMainToRuntimeEnvelope,
  type RuntimeToMainEnvelope,
} from './protocol';
import { requireParentPort } from './parent-port';

// A single Runtime Host UtilityProcess hosts exactly one adapter kind, selected at spawn time by
// Main (see RuntimeHostClient) via --runtime-kind. Defaults to 'codex' so any pre-existing spawn
// call site that omits the flag keeps its original behavior.
const runtimeKind = readRuntimeKind();
const runtimeInstanceId = readRuntimeInstanceId();
const adapter = runtimeKind === 'claude' ? new ClaudeRuntimeAdapter() : new CodexRuntimeAdapter();
const sequences = new Map<string, number>();
const parentPort = requireParentPort(process);

parentPort.on('message', ({ data }: Electron.MessageEvent) => {
  if (!isMainToRuntimeEnvelope(data) || data.runtimeInstanceId !== runtimeInstanceId) return;
  if (data.type === 'start') {
    adapter.start(
      data.turnId,
      data.input,
      data.contextFragments,
      () =>
        send(data.taskId, data.turnId, data.operationId, {
          type: 'started',
          acceptedContextFragmentIds: data.contextFragments.map((fragment) => fragment.id),
        }),
      data.workspacePath,
      data.model,
      (event) => send(data.taskId, data.turnId, data.operationId, { type: 'event', event }),
      (error) => send(data.taskId, data.turnId, data.operationId, { type: 'error', error }),
      (code, canceled) =>
        send(data.taskId, data.turnId, data.operationId, { type: 'exit', code, canceled }),
      data.teamMcp,
      data.effort,
      data.writeScope,
    );
  } else if (data.type === 'cancel') {
    adapter.cancel(data.turnId);
  }
});

void (runtimeKind === 'claude' ? probeClaude() : probeCodex()).then((probe) =>
  send('', '', 'probe', {
    type: 'hello',
    ...(runtimeKind === 'claude'
      ? {
          codexAvailable: false,
          codexModels: [],
          claudeAvailable: probe.available,
          claudeModels: probe.models,
          ...(probe.version === undefined ? {} : { claudeVersion: probe.version }),
        }
      : {
          codexAvailable: probe.available,
          codexModels: probe.models,
          ...(probe.version === undefined ? {} : { codexVersion: probe.version }),
          claudeAvailable: false,
          claudeModels: [],
        }),
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
        | 'type'
        | 'codexAvailable'
        | 'codexVersion'
        | 'codexModels'
        | 'claudeAvailable'
        | 'claudeVersion'
        | 'claudeModels'
      >
    | Pick<Extract<RuntimeToMainEnvelope, { type: 'event' }>, 'type' | 'event'>
    | Pick<
        Extract<RuntimeToMainEnvelope, { type: 'started' }>,
        'type' | 'acceptedContextFragmentIds'
      >
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

function readRuntimeKind(): 'codex' | 'claude' {
  const index = process.argv.indexOf('--runtime-kind');
  const value = index < 0 ? undefined : process.argv[index + 1];
  return value === 'claude' ? 'claude' : 'codex';
}
