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
const activeTurns = new Map<string, { taskId: string; operationId: string }>();
const parentPort = requireParentPort(process);
const heartbeat = setInterval(() => {
  const at = new Date().toISOString();
  for (const [turnId, active] of activeTurns)
    send(active.taskId, turnId, active.operationId, {
      type: 'event',
      event: { type: 'heartbeat', at },
    });
}, 15_000);
heartbeat.unref();

parentPort.on('message', ({ data }: Electron.MessageEvent) => {
  if (!isMainToRuntimeEnvelope(data) || data.runtimeInstanceId !== runtimeInstanceId) return;
  if (data.type === 'start') {
    activeTurns.set(data.turnId, {
      taskId: data.taskId,
      operationId: data.operationId,
    });
    adapter.start(
      data.turnId,
      data.input,
      data.contextFragments,
      () =>
        send(data.taskId, data.turnId, data.operationId, {
          type: 'started',
          acceptedContextFragmentIds: data.contextFragments.map((fragment) => fragment.id),
          acceptedProjectItemIds: data.projectItems.map((item) => item.id),
          acceptedProjectSnapshotDigest: data.projectSnapshotDigest,
          acceptedPayloadDigest: data.payloadDigest,
        }),
      data.workspace,
      data.model,
      (event) => send(data.taskId, data.turnId, data.operationId, { type: 'event', event }),
      (error, diagnostic) =>
        send(data.taskId, data.turnId, data.operationId, {
          type: 'error',
          error,
          ...(diagnostic === undefined ? {} : { diagnostic }),
        }),
      (code, canceled) => {
        send(data.taskId, data.turnId, data.operationId, { type: 'exit', code, canceled });
        activeTurns.delete(data.turnId);
      },
      data.teamMcp,
      data.effort,
      data.writeScope,
      data.skills ?? [],
      data.projectItems,
      data.payload,
    );
  } else if (data.type === 'cancel') {
    void adapter.cancel(data.turnId).then((forced) => {
      send(data.taskId, data.turnId, data.operationId, { type: 'stopped', forced });
      activeTurns.delete(data.turnId);
    });
  }
});

void (runtimeKind === 'claude' ? probeClaude() : probeCodex()).then((probe) => {
  if (adapter instanceof CodexRuntimeAdapter) adapter.setCliVersion(probe.version ?? null);
  if (adapter instanceof ClaudeRuntimeAdapter) adapter.setCliVersion(probe.version ?? null);
  send('', '', 'probe', {
    type: 'hello',
    ...(runtimeKind === 'claude'
      ? {
          codexAvailable: false,
          codexReadiness: 'unavailable',
          codexModels: [],
          claudeAvailable: probe.available,
          claudeReadiness: probe.readiness,
          claudeModels: probe.models,
          ...(probe.version === undefined ? {} : { claudeVersion: probe.version }),
        }
      : {
          codexAvailable: probe.available,
          codexReadiness: probe.readiness,
          codexModels: probe.models,
          ...(probe.version === undefined ? {} : { codexVersion: probe.version }),
          claudeAvailable: false,
          claudeReadiness: 'unavailable',
          claudeModels: [],
        }),
  });
});

process.once('exit', () => {
  clearInterval(heartbeat);
  adapter.dispose();
});

function send(
  taskId: string,
  turnId: string,
  operationId: string,
  payload:
    | Pick<
        Extract<RuntimeToMainEnvelope, { type: 'hello' }>,
        | 'type'
        | 'codexAvailable'
        | 'codexReadiness'
        | 'codexVersion'
        | 'codexModels'
        | 'claudeAvailable'
        | 'claudeReadiness'
        | 'claudeVersion'
        | 'claudeModels'
      >
    | Pick<Extract<RuntimeToMainEnvelope, { type: 'event' }>, 'type' | 'event'>
    | Pick<Extract<RuntimeToMainEnvelope, { type: 'stopped' }>, 'type' | 'forced'>
    | Pick<
        Extract<RuntimeToMainEnvelope, { type: 'started' }>,
        | 'type'
        | 'acceptedContextFragmentIds'
        | 'acceptedProjectItemIds'
        | 'acceptedProjectSnapshotDigest'
        | 'acceptedPayloadDigest'
      >
    | Pick<Extract<RuntimeToMainEnvelope, { type: 'exit' }>, 'type' | 'code' | 'canceled'>
    | Pick<Extract<RuntimeToMainEnvelope, { type: 'error' }>, 'type' | 'error' | 'diagnostic'>,
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
