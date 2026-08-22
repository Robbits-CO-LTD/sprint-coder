import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '@sprint-coder/domain';

const electronMock = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  class FakeUtilityProcess {
    readonly handlers = new Map<string, Handler[]>();
    readonly onceHandlers = new Map<string, Handler[]>();
    readonly messages: unknown[] = [];
    killed = false;

    once(event: string, handler: Handler): this {
      this.onceHandlers.set(event, [...(this.onceHandlers.get(event) ?? []), handler]);
      return this;
    }

    on(event: string, handler: Handler): this {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.onceHandlers.get(event) ?? []) handler(...args);
      this.onceHandlers.delete(event);
      for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }

    postMessage(message: unknown): void {
      this.messages.push(message);
    }

    kill(): boolean {
      this.killed = true;
      return true;
    }
  }

  const children: FakeUtilityProcess[] = [];
  const instances: string[] = [];
  return {
    children,
    instances,
    fork: vi.fn((_path: string, args: string[]) => {
      const child = new FakeUtilityProcess();
      children.push(child);
      instances.push(args[1]!);
      return child;
    }),
  };
});

vi.mock('electron', () => ({ utilityProcess: { fork: electronMock.fork } }));

import {
  RUNTIME_PROTOCOL_VERSION,
  runtimeImageManifestDigest,
  type RuntimeImageAttachmentManifestEntry,
} from '../runtime-host/protocol';
import { RuntimeHostClient } from './runtime-host';

function emitReadyHello(index: number, emitSpawn = true, operationId = 'hello'): void {
  const instanceId = electronMock.instances[index]!;
  if (emitSpawn) electronMock.children[index]!.emit('spawn');
  electronMock.children[index]!.emit('message', {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    runtimeInstanceId: instanceId,
    taskId: '',
    turnId: '',
    seq: 1,
    operationId,
    type: 'hello',
    codexAvailable: true,
    codexReadiness: 'ready',
    codexModels: [{ id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', description: 'test model' }],
    claudeAvailable: false,
    claudeReadiness: 'unavailable',
    claudeModels: [],
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  electronMock.children.splice(0);
  electronMock.instances.splice(0);
  electronMock.fork.mockClear();
});

describe('RuntimeHostClient image attachment capability state', () => {
  it('accepts one exact prepared receipt and emits a bound commit envelope', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const failures: unknown[] = [];
    const client = new RuntimeHostClient(
      () => undefined,
      (_taskId, _turnId, error) => failures.push(error),
    );
    emitReadyHello(0);
    const manifest: RuntimeImageAttachmentManifestEntry[] = [
      {
        id: 'attachment-1',
        mimeType: 'image/png',
        byteLength: 128,
        sha256: 'a'.repeat(64),
      },
    ];
    const manifestDigest = runtimeImageManifestDigest(manifest);
    const receiptPromise = client.prepareImageAttachments({
      taskId: 'task-1',
      turnId: 'turn-1',
      selectionIdentity: 'b'.repeat(64),
      manifest,
      paths: ['/custody/turn/001.png'],
      manifestDigest,
    });
    await Promise.resolve();
    const prepare = electronMock.children[0]!.messages.find(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'prepare_images',
    ) as { operationId: string } | undefined;
    expect(prepare).toBeDefined();
    electronMock.children[0]!.emit('message', {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId: electronMock.instances[0],
      taskId: 'task-1',
      turnId: 'turn-1',
      seq: 1,
      operationId: prepare!.operationId,
      type: 'images_prepared',
      selectionIdentity: 'b'.repeat(64),
      manifestDigest,
      decodedByteLength: 128,
    });
    const receipt = await receiptPromise;
    client.start(
      'task-1',
      'turn-1',
      'inspect',
      null,
      'gpt-5.6-sol',
      new ToolRegistry().createSnapshot({ providerId: 'codex', workspaceId: null }),
      undefined,
      undefined,
      undefined,
      'read-only',
      [],
      undefined,
      receipt,
    );
    await Promise.resolve();
    expect(
      electronMock.children[0]!.messages.some(
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          message.type === 'commit_images' &&
          'operationId' in message &&
          message.operationId === prepare!.operationId &&
          'selectionIdentity' in message &&
          message.selectionIdentity === 'b'.repeat(64) &&
          'manifestDigest' in message &&
          message.manifestDigest === manifestDigest,
      ),
    ).toBe(true);
    client.start(
      'task-1',
      'turn-1',
      'duplicate',
      null,
      'gpt-5.6-sol',
      new ToolRegistry().createSnapshot({ providerId: 'codex', workspaceId: null }),
      undefined,
      undefined,
      undefined,
      'read-only',
      [],
      undefined,
      receipt,
    );
    expect(failures).toHaveLength(1);
    client.dispose();
  });

  it('cancels a prepared pre-commit phase and invalidates its receipt', async () => {
    const failures: unknown[] = [];
    const client = new RuntimeHostClient(
      () => undefined,
      (_taskId, _turnId, error) => failures.push(error),
    );
    emitReadyHello(0);
    const manifest: RuntimeImageAttachmentManifestEntry[] = [
      {
        id: 'attachment-1',
        mimeType: 'image/png',
        byteLength: 128,
        sha256: 'a'.repeat(64),
      },
    ];
    const manifestDigest = runtimeImageManifestDigest(manifest);
    const receiptPromise = client.prepareImageAttachments({
      taskId: 'task-cancel',
      turnId: 'turn-cancel',
      selectionIdentity: 'b'.repeat(64),
      manifest,
      paths: ['/custody/turn/001.png'],
      manifestDigest,
    });
    await Promise.resolve();
    const prepare = electronMock.children[0]!.messages.find(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'prepare_images',
    ) as { operationId: string } | undefined;
    electronMock.children[0]!.emit('message', {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId: electronMock.instances[0],
      taskId: 'task-cancel',
      turnId: 'turn-cancel',
      seq: 1,
      operationId: prepare!.operationId,
      type: 'images_prepared',
      selectionIdentity: 'b'.repeat(64),
      manifestDigest,
      decodedByteLength: 128,
    });
    const receipt = await receiptPromise;
    client.start(
      'task-cancel',
      'turn-cancel',
      'plain start must fail',
      null,
      'gpt-5.6-sol',
      new ToolRegistry().createSnapshot({ providerId: 'codex', workspaceId: null }),
    );
    expect(failures).toHaveLength(1);
    let settledCancels = 0;
    const firstCancel = client.cancel('task-cancel', 'turn-cancel').then((receipt) => {
      settledCancels += 1;
      return receipt;
    });
    const secondCancel = client.cancel('task-cancel', 'turn-cancel').then((receipt) => {
      settledCancels += 1;
      return receipt;
    });
    await Promise.resolve();
    expect(settledCancels).toBe(0);
    electronMock.children[0]!.emit('message', {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId: electronMock.instances[0],
      taskId: 'task-cancel',
      turnId: 'turn-cancel',
      seq: 2,
      operationId: prepare!.operationId,
      type: 'stopped',
      forced: false,
    });
    await expect(Promise.all([firstCancel, secondCancel])).resolves.toEqual([
      expect.objectContaining({ turnId: 'turn-cancel', forced: false }),
      expect.objectContaining({ turnId: 'turn-cancel', forced: false }),
    ]);
    client.start(
      'task-cancel',
      'turn-cancel',
      'inspect',
      null,
      'gpt-5.6-sol',
      new ToolRegistry().createSnapshot({ providerId: 'codex', workspaceId: null }),
      undefined,
      undefined,
      undefined,
      'read-only',
      [],
      undefined,
      receipt,
    );
    expect(failures).toHaveLength(2);
    client.dispose();
  });

  it('ignores duplicate hello and asynchronously refreshes an expired observation', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const client = new RuntimeHostClient(
      () => undefined,
      () => undefined,
    );
    emitReadyHello(0);
    const first = await client.captureImageAttachmentCapability();
    expect(first).toMatchObject({
      available: true,
      readiness: 'ready',
      runtimeInstanceId: electronMock.instances[0],
      capturedAtMs: 1_000,
    });

    emitReadyHello(0, false);
    expect(client.currentImageAttachmentCapability().readinessRevision).toBe(
      first.readinessRevision,
    );
    vi.mocked(Date.now).mockReturnValue(20_000);
    const refreshedCapture = client.captureImageAttachmentCapability();
    const refreshOperationId = await pendingRefreshOperationId(client);
    emitReadyHello(0, false, refreshOperationId);
    const second = await refreshedCapture;
    expect(second).toMatchObject({ capturedAtMs: 20_000, runtimeKind: 'codex' });
    expect(second.readinessRevision).toBeGreaterThan(first.readinessRevision);
    client.dispose();
  });

  it('settles a pending probe unavailable on dispose and ignores a late hello', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const client = new RuntimeHostClient(
      () => undefined,
      () => undefined,
    );
    const capture = client.captureImageAttachmentCapability();
    client.dispose();
    const disposed = await capture;
    expect(disposed).toMatchObject({ available: false, readiness: 'unavailable' });
    const revision = client.currentImageAttachmentCapability().readinessRevision;
    emitReadyHello(0);
    expect(client.currentImageAttachmentCapability().readinessRevision).toBe(revision);
  });

  it('settles an expired refresh when an unconfirmed stop restarts the host', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const client = new RuntimeHostClient(
      () => undefined,
      () => undefined,
    );
    emitReadyHello(0);
    await client.captureImageAttachmentCapability();
    vi.mocked(Date.now).mockReturnValue(20_000);
    const capture = client.captureImageAttachmentCapability();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    (
      client as unknown as {
        restartHostAfterUnconfirmedStop(error: Error): void;
      }
    ).restartHostAfterUnconfirmedStop(new Error('injected restart'));
    await expect(capture).resolves.toMatchObject({
      available: false,
      readiness: 'unavailable',
      runtimeInstanceId: electronMock.instances[1],
    });
    client.dispose();
  });

  it('invalidates on dispose and publishes one coherent replacement instance after exit', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const client = new RuntimeHostClient(
      () => undefined,
      () => undefined,
    );
    emitReadyHello(0);
    const first = await client.captureImageAttachmentCapability();

    electronMock.children[0]!.emit('exit', 1);
    const replacementCapture = client.captureImageAttachmentCapability();
    expect(electronMock.children).toHaveLength(2);
    vi.mocked(Date.now).mockReturnValue(2_000);
    emitReadyHello(1);
    const replacement = await replacementCapture;
    expect(replacement).toMatchObject({
      available: true,
      runtimeInstanceId: electronMock.instances[1],
      capturedAtMs: 2_000,
    });
    expect(replacement.runtimeInstanceId).not.toBe(first.runtimeInstanceId);
    expect(replacement.readinessRevision).toBeGreaterThan(first.readinessRevision);

    client.dispose();
    const invalidated = client.currentImageAttachmentCapability();
    expect(invalidated.runtimeInstanceId).toBe(replacement.runtimeInstanceId);
    expect(invalidated.readinessRevision).toBeGreaterThan(replacement.readinessRevision);
    expect(electronMock.children[1]!.killed).toBe(true);
  });

  it('ignores a late response from a timed-out refresh generation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const client = new RuntimeHostClient(
      () => undefined,
      () => undefined,
    );
    emitReadyHello(0);
    await client.captureImageAttachmentCapability();

    vi.setSystemTime(20_000);
    const firstCapture = client.captureImageAttachmentCapability();
    const firstOperation = await pendingRefreshOperationId(client);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(firstCapture).resolves.toMatchObject({ available: false });

    vi.setSystemTime(40_000);
    let secondSettled = false;
    const secondCapture = client.captureImageAttachmentCapability().then((value) => {
      secondSettled = true;
      return value;
    });
    const secondOperation = await pendingRefreshOperationId(client);
    expect(secondOperation).not.toBe(firstOperation);
    emitReadyHello(0, false, firstOperation);
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    emitReadyHello(0, false, secondOperation);
    await expect(secondCapture).resolves.toMatchObject({
      available: true,
      capturedAtMs: 40_000,
    });
    client.dispose();
  });
});

describe('RuntimeHostClient Team process binding', () => {
  async function startTeamTurn(client: RuntimeHostClient): Promise<Record<string, unknown>> {
    const accepted = client.start(
      'task-team',
      'turn-team',
      'coordinate',
      null,
      'gpt-5.6-sol',
      new ToolRegistry().createSnapshot({ providerId: 'codex', workspaceId: null }),
      undefined,
      {
        socketPath: '/tmp/team.sock',
        token: 'a'.repeat(64),
        guidance: 'team',
        toolNames: ['team_get_status'],
      },
    );
    expect(accepted).toBe(true);
    await Promise.resolve();
    const start = electronMock.children[0]!.messages.find(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'turnId' in message &&
        message.turnId === 'turn-team',
    ) as Record<string, unknown> | undefined;
    expect(start).toBeDefined();
    return start!;
  }

  it('binds the reported CLI identity before accepting a Team runtime start', async () => {
    const failures: unknown[] = [];
    const bindings: unknown[] = [];
    const client = new RuntimeHostClient(
      () => undefined,
      (_taskId, _turnId, error) => failures.push(error),
      undefined,
      undefined,
      'codex',
      undefined,
      (taskId, turnId, identity) => {
        bindings.push({ taskId, turnId, identity });
        return true;
      },
    );
    emitReadyHello(0);
    const start = await startTeamTurn(client);
    const common = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId: electronMock.instances[0],
      taskId: 'task-team',
      turnId: 'turn-team',
      operationId: start['operationId'],
    };
    electronMock.children[0]!.emit('message', {
      ...common,
      seq: 1,
      type: 'runtime_process',
      processIdentity: { pid: 123, parentPid: 12, startIdentity: 'start-123' },
    });
    electronMock.children[0]!.emit('message', {
      ...common,
      seq: 2,
      type: 'started',
      acceptedContextFragmentIds: (start['contextFragments'] as Array<{ id: string }>).map(
        ({ id }) => id,
      ),
      acceptedProjectItemIds: (start['projectItems'] as Array<{ id: string }>).map(({ id }) => id),
      acceptedProjectSnapshotDigest: start['projectSnapshotDigest'],
      acceptedPayloadDigest: start['payloadDigest'],
    });

    expect(bindings).toEqual([
      {
        taskId: 'task-team',
        turnId: 'turn-team',
        identity: { pid: 123, parentPid: 12, startIdentity: 'start-123' },
      },
    ]);
    expect(failures).toEqual([]);
    client.dispose();
  });

  it('fails closed when started arrives before a peer-bound runtime identity', async () => {
    const failures: Array<{ code?: string }> = [];
    const client = new RuntimeHostClient(
      () => undefined,
      (_taskId, _turnId, error) => failures.push(error),
      undefined,
      undefined,
      'codex',
      undefined,
      () => true,
    );
    emitReadyHello(0);
    const start = await startTeamTurn(client);
    electronMock.children[0]!.emit('message', {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId: electronMock.instances[0],
      taskId: 'task-team',
      turnId: 'turn-team',
      operationId: start['operationId'],
      seq: 1,
      type: 'started',
      acceptedContextFragmentIds: [],
      acceptedProjectItemIds: [],
      acceptedProjectSnapshotDigest: null,
      acceptedPayloadDigest: start['payloadDigest'],
    });

    expect(failures).toEqual([expect.objectContaining({ code: 'RUNTIME_PROTOCOL_ERROR' })]);
    await Promise.resolve();
    expect(
      electronMock.children[0]!.messages.some(
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          message.type === 'cancel' &&
          'turnId' in message &&
          message.turnId === 'turn-team',
      ),
    ).toBe(true);
    client.dispose();
  });
});

async function pendingRefreshOperationId(client: RuntimeHostClient): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await Promise.resolve();
    const operationId = (client as unknown as { expectedProbeOperationId: string | null })
      .expectedProbeOperationId;
    if (operationId?.startsWith('capability-refresh:')) return operationId;
  }
  throw new Error('refresh probe did not start');
}
