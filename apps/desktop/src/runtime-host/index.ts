import { CodexRuntimeAdapter, probeCodex } from './codex-adapter';
import { ClaudeRuntimeAdapter, probeClaude } from './claude-adapter';
import {
  RUNTIME_PROTOCOL_VERSION,
  correlatedRuntimeStartRejection,
  isMainToRuntimeEnvelope,
  type MainToRuntimeEnvelope,
  type RuntimeToMainEnvelope,
} from './protocol';
import { requireParentPort } from './parent-port';
import {
  prepareRuntimeImages,
  releasePreparedRuntimeImages,
  reverifyPreparedRuntimeImages,
  type PreparedRuntimeImages,
} from './image-attachment-preparer';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// A single Runtime Host UtilityProcess hosts exactly one adapter kind, selected at spawn time by
// Main (see RuntimeHostClient) via --runtime-kind. Defaults to 'codex' so any pre-existing spawn
// call site that omits the flag keeps its original behavior.
const runtimeKind = readRuntimeKind();
const runtimeInstanceId = readRuntimeInstanceId();
const adapter =
  runtimeKind === 'claude'
    ? new ClaudeRuntimeAdapter()
    : new CodexRuntimeAdapter(undefined, undefined, undefined, readCodexIsolationRoot());
const sequences = new Map<string, number>();
const activeTurns = new Map<string, { taskId: string; operationId: string }>();
const preparedTurns = new Map<
  string,
  {
    taskId: string;
    turnId: string;
    selectionIdentity: string;
    prepared: PreparedRuntimeImages;
    timer: NodeJS.Timeout;
  }
>();
const preparingOperations = new Map<string, { turnId: string; controller: AbortController }>();
const canceledPreparingOperations = new Set<string>();
const terminalImageOperations = new Set<string>();
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
  const rejected = correlatedRuntimeStartRejection(data, runtimeInstanceId);
  if (rejected !== null) {
    send(rejected.taskId, rejected.turnId, rejected.operationId, {
      type: 'error',
      error: {
        code: 'RUNTIME_PROTOCOL_ERROR',
        userMessage: 'Runtime HostがTurn開始入力を拒否しました。',
        retryable: false,
      },
      rejection: rejected.rejection,
    });
    if (!activeTurns.has(rejected.turnId)) sequences.delete(rejected.turnId);
    return;
  }
  if (!isMainToRuntimeEnvelope(data) || data.runtimeInstanceId !== runtimeInstanceId) {
    return;
  }
  if (data.type === 'hello') {
    void probeAndSendCapability(data.operationId);
  } else if (data.type === 'prepare_images') {
    void prepareImages(data);
  } else if (data.type === 'commit_images') {
    void commitImages(data);
  } else if (data.type === 'start') {
    if (hasImagePreparationForTurn(data.turnId)) {
      terminateImagePreparationForTurn(data.turnId);
      send(data.taskId, data.turnId, data.operationId, {
        type: 'error',
        error: runtimeImageError('画像添付の準備中は通常のstartへ切り替えられません。'),
      });
      return;
    }
    startAdapter(data);
  } else if (data.type === 'cancel') {
    const preparing = preparingOperations.get(data.operationId);
    if (preparing?.turnId === data.turnId) {
      preparing.controller.abort();
      canceledPreparingOperations.add(data.operationId);
      markImageOperationTerminal(data.operationId);
      send(data.taskId, data.turnId, data.operationId, { type: 'stopped', forced: false });
      return;
    }
    const preparedEntry = [...preparedTurns.entries()].find(
      ([operationId, prepared]) =>
        operationId === data.operationId && prepared.turnId === data.turnId,
    );
    if (preparedEntry !== undefined) {
      const [operationId, prepared] = preparedEntry;
      clearTimeout(prepared.timer);
      preparedTurns.delete(operationId);
      markImageOperationTerminal(operationId);
      void releasePreparedRuntimeImages(prepared.prepared).then(() =>
        send(data.taskId, data.turnId, data.operationId, { type: 'stopped', forced: false }),
      );
      return;
    }
    void adapter.cancel(data.turnId).then((forced) => {
      send(data.taskId, data.turnId, data.operationId, { type: 'stopped', forced });
      activeTurns.delete(data.turnId);
    });
  }
});

async function prepareImages(
  data: Extract<MainToRuntimeEnvelope, { type: 'prepare_images' }>,
): Promise<void> {
  if (
    runtimeKind !== 'codex' ||
    terminalImageOperations.has(data.operationId) ||
    activeTurns.has(data.turnId)
  ) {
    sendPrepareFailure(data, '画像添付のRuntime準備状態が一致しません。');
    return;
  }
  const conflictingPreparing = [...preparingOperations.entries()].filter(
    ([operationId, preparing]) =>
      operationId === data.operationId || preparing.turnId === data.turnId,
  );
  const conflictingPrepared = [...preparedTurns.entries()].filter(
    ([operationId, prepared]) =>
      operationId === data.operationId || prepared.turnId === data.turnId,
  );
  if (conflictingPreparing.length > 0 || conflictingPrepared.length > 0) {
    for (const [operationId, preparing] of conflictingPreparing) {
      preparing.controller.abort();
      canceledPreparingOperations.add(operationId);
      markImageOperationTerminal(operationId);
    }
    for (const [operationId, prepared] of conflictingPrepared) {
      clearTimeout(prepared.timer);
      preparedTurns.delete(operationId);
      markImageOperationTerminal(operationId);
      void releasePreparedRuntimeImages(prepared.prepared);
    }
    markImageOperationTerminal(data.operationId);
    sendPrepareFailure(data, '画像添付のRuntime準備状態が一致しません。');
    return;
  }
  const controller = new AbortController();
  preparingOperations.set(data.operationId, { turnId: data.turnId, controller });
  let stored = false;
  const timer = setTimeout(() => {
    const preparing = preparingOperations.get(data.operationId);
    if (preparing?.turnId === data.turnId) {
      preparing.controller.abort();
      preparingOperations.delete(data.operationId);
      canceledPreparingOperations.add(data.operationId);
      markImageOperationTerminal(data.operationId);
      sendPrepareFailure(data, '画像添付のRuntime準備がタイムアウトしました。');
      return;
    }
    const owned = preparedTurns.get(data.operationId);
    if (owned === undefined) return;
    preparedTurns.delete(data.operationId);
    markImageOperationTerminal(data.operationId);
    void releasePreparedRuntimeImages(owned.prepared);
    sendPrepareFailure(data, '画像添付のRuntime準備がタイムアウトしました。');
  }, 15_000);
  timer.unref();
  try {
    const prepared = await prepareRuntimeImages(
      data.manifest,
      data.paths,
      data.manifestDigest,
      controller.signal,
    );
    if (
      canceledPreparingOperations.has(data.operationId) ||
      terminalImageOperations.has(data.operationId)
    ) {
      await releasePreparedRuntimeImages(prepared);
      return;
    }
    preparedTurns.set(data.operationId, {
      taskId: data.taskId,
      turnId: data.turnId,
      selectionIdentity: data.selectionIdentity,
      prepared,
      timer,
    });
    stored = true;
    send(data.taskId, data.turnId, data.operationId, {
      type: 'images_prepared',
      selectionIdentity: data.selectionIdentity,
      manifestDigest: prepared.manifestDigest,
      decodedByteLength: prepared.decodedByteLength,
    });
  } catch {
    if (canceledPreparingOperations.has(data.operationId)) return;
    markImageOperationTerminal(data.operationId);
    sendPrepareFailure(data, '画像添付をRuntimeで検証できませんでした。');
  } finally {
    if (!stored) clearTimeout(timer);
    preparingOperations.delete(data.operationId);
    canceledPreparingOperations.delete(data.operationId);
  }
}

async function commitImages(
  data: Extract<MainToRuntimeEnvelope, { type: 'commit_images' }>,
): Promise<void> {
  const owned = preparedTurns.get(data.operationId);
  if (
    runtimeKind !== 'codex' ||
    owned === undefined ||
    activeTurns.has(data.turnId) ||
    owned.taskId !== data.taskId ||
    owned.turnId !== data.turnId ||
    owned.selectionIdentity !== data.selectionIdentity ||
    owned.prepared.manifestDigest !== data.manifestDigest
  ) {
    const preparing = preparingOperations.get(data.operationId);
    if (preparing?.turnId === data.turnId) {
      preparing.controller.abort();
      canceledPreparingOperations.add(data.operationId);
      markImageOperationTerminal(data.operationId);
    }
    if (owned !== undefined) {
      clearTimeout(owned.timer);
      preparedTurns.delete(data.operationId);
      await releasePreparedRuntimeImages(owned.prepared);
    }
    markImageOperationTerminal(data.operationId);
    send(data.taskId, data.turnId, data.operationId, {
      type: 'error',
      error: runtimeImageError('画像添付のcommit情報が一致しません。'),
    });
    return;
  }
  clearTimeout(owned.timer);
  preparedTurns.delete(data.operationId);
  markImageOperationTerminal(data.operationId);
  startAdapter(data, {
    paths: owned.prepared.paths,
    beforeTurnStart: () => reverifyPreparedRuntimeImages(owned.prepared),
    release: () => releasePreparedRuntimeImages(owned.prepared),
  });
}

function startAdapter(
  data: Extract<MainToRuntimeEnvelope, { type: 'start' | 'commit_images' }>,
  localImages?: {
    paths: readonly string[];
    beforeTurnStart: () => Promise<void>;
    release: () => Promise<void>;
  },
): void {
  if (activeTurns.has(data.turnId)) {
    void localImages?.release();
    send(data.taskId, data.turnId, data.operationId, {
      type: 'error',
      error: runtimeImageError('このTurnはすでに実行中です。'),
    });
    return;
  }
  activeTurns.set(data.turnId, { taskId: data.taskId, operationId: data.operationId });
  try {
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
      localImages,
    );
  } catch {
    activeTurns.delete(data.turnId);
    void localImages?.release();
    send(data.taskId, data.turnId, data.operationId, {
      type: 'error',
      error: runtimeImageError('Runtime Hostを開始できませんでした。'),
    });
  }
}

function sendPrepareFailure(
  data: Pick<
    Extract<MainToRuntimeEnvelope, { type: 'prepare_images' }>,
    'taskId' | 'turnId' | 'operationId'
  >,
  userMessage: string,
): void {
  send(data.taskId, data.turnId, data.operationId, {
    type: 'images_prepare_failed',
    error: runtimeImageError(userMessage),
  });
}

function runtimeImageError(userMessage: string) {
  return { code: 'RUNTIME_PROTOCOL_ERROR' as const, userMessage, retryable: true };
}

function markImageOperationTerminal(operationId: string): void {
  terminalImageOperations.add(operationId);
  if (terminalImageOperations.size <= 1_024) return;
  const oldest = terminalImageOperations.values().next().value as string | undefined;
  if (oldest !== undefined) terminalImageOperations.delete(oldest);
}

function hasImagePreparationForTurn(turnId: string): boolean {
  return (
    [...preparingOperations.values()].some((preparing) => preparing.turnId === turnId) ||
    [...preparedTurns.values()].some((prepared) => prepared.turnId === turnId)
  );
}

function terminateImagePreparationForTurn(turnId: string): void {
  for (const [operationId, preparing] of preparingOperations) {
    if (preparing.turnId !== turnId) continue;
    preparing.controller.abort();
    canceledPreparingOperations.add(operationId);
    markImageOperationTerminal(operationId);
  }
  for (const [operationId, prepared] of preparedTurns) {
    if (prepared.turnId !== turnId) continue;
    clearTimeout(prepared.timer);
    preparedTurns.delete(operationId);
    markImageOperationTerminal(operationId);
    void releasePreparedRuntimeImages(prepared.prepared);
  }
}

async function probeAndSendCapability(operationId: string): Promise<void> {
  const probe = await (runtimeKind === 'claude' ? probeClaude() : probeCodex());
  if (adapter instanceof CodexRuntimeAdapter) adapter.setCliVersion(probe.version ?? null);
  if (adapter instanceof ClaudeRuntimeAdapter) adapter.setCliVersion(probe.version ?? null);
  send('', '', operationId, {
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
}

process.once('exit', () => {
  clearInterval(heartbeat);
  adapter.dispose();
  for (const owned of preparedTurns.values()) {
    clearTimeout(owned.timer);
    void releasePreparedRuntimeImages(owned.prepared);
  }
  preparedTurns.clear();
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
    | Pick<
        Extract<RuntimeToMainEnvelope, { type: 'images_prepared' }>,
        'type' | 'selectionIdentity' | 'manifestDigest' | 'decodedByteLength'
      >
    | Pick<Extract<RuntimeToMainEnvelope, { type: 'images_prepare_failed' }>, 'type' | 'error'>
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
    | Pick<
        Extract<RuntimeToMainEnvelope, { type: 'error' }>,
        'type' | 'error' | 'diagnostic' | 'rejection'
      >,
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

function readCodexIsolationRoot(): string {
  const index = process.argv.indexOf('--codex-isolation-root');
  const value = index < 0 ? undefined : process.argv[index + 1];
  return value === undefined || value.length === 0
    ? join(tmpdir(), 'sprint-coder-codex-isolated-tests')
    : value;
}
