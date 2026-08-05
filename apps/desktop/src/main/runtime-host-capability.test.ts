import { afterEach, describe, expect, it, vi } from 'vitest';

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

import { RUNTIME_PROTOCOL_VERSION } from '../runtime-host/protocol';
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

async function pendingRefreshOperationId(client: RuntimeHostClient): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await Promise.resolve();
    const operationId = (client as unknown as { expectedProbeOperationId: string | null })
      .expectedProbeOperationId;
    if (operationId?.startsWith('capability-refresh:')) return operationId;
  }
  throw new Error('refresh probe did not start');
}
