import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NodeChildProcess from 'node:child_process';
import type * as NodeNet from 'node:net';
import {
  decodeComputerUseNativeFrame,
  encodeComputerUseNativeFrame,
  type ComputerUseNativeFrame,
  type ComputerUseNativeMessageType,
} from './computer-use-native-protocol';
import type { ComputerUseNativeAddon, ComputerUseNativeBinding } from './computer-use-native-types';
import {
  COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT,
  COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS,
  createComputerUseNativeHost,
} from './computer-use-native-host';
import {
  COMPUTER_USE_NATIVE_CLOSE_TRANSPORT_TIMEOUT_MS,
  createWindowsComputerUseNativeAddon,
} from './computer-use-native-windows';

/**
 * These tests drive the real `createWindowsComputerUseNativeAddon` transport — its pending map,
 * per-request timeouts, frame binding and teardown — against a fake helper child process, and put
 * the real Main adapter (`createComputerUseNativeHost`) in front of it so the close deadline and
 * the input quarantine are the production ones. Only `spawn`, the PowerShell attestation and the
 * named pipe are faked; nothing in the transport is stubbed.
 */
const transport = vi.hoisted(() => {
  type Listener = (...args: never[]) => void;
  class FakeEmitter {
    private readonly listeners = new Map<string, Listener[]>();
    on(event: string, listener: Listener): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
      return this;
    }
    once(event: string, listener: Listener): this {
      const wrapper = ((...args: never[]) => {
        this.off(event, wrapper);
        listener(...args);
      }) as Listener;
      return this.on(event, wrapper);
    }
    off(event: string, listener: Listener): this {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener),
      );
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])])
        (listener as (...values: unknown[]) => void)(...args);
    }
  }
  class FakeHelperSocket extends FakeEmitter {
    destroyed = false;
    onWrite: ((frame: Buffer) => void) | null = null;
    write(chunk: Buffer, callback?: (error?: Error | null) => void): boolean {
      const written = Buffer.from(chunk);
      // A real socket never calls back or delivers a response inside `write`.
      queueMicrotask(() => {
        callback?.(null);
        if (!this.destroyed) this.onWrite?.(written);
      });
      return true;
    }
    destroy(): void {
      if (this.destroyed) return;
      this.destroyed = true;
      queueMicrotask(() => this.emit('close'));
    }
  }
  class FakeHelperChild extends FakeEmitter {
    readonly pid = 4_242;
    killed = false;
    kill(): boolean {
      if (this.killed) return true;
      this.killed = true;
      queueMicrotask(() => this.emit('exit', 0, null));
      return true;
    }
    unref(): void {}
  }
  const state = {
    children: [] as FakeHelperChild[],
    sockets: [] as FakeHelperSocket[],
    attestation: '',
    onSocket: null as ((socket: FakeHelperSocket) => void) | null,
  };
  return { state, FakeHelperSocket, FakeHelperChild };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  return {
    ...actual,
    spawn: () => {
      const child = new transport.FakeHelperChild();
      transport.state.children.push(child);
      return child;
    },
    execFileSync: () => transport.state.attestation,
  };
});

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeNet>();
  return {
    ...actual,
    createConnection: () => {
      const socket = new transport.FakeHelperSocket();
      transport.state.sockets.push(socket);
      transport.state.onSocket?.(socket);
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    },
  };
});

type FakeSocket = InstanceType<typeof transport.FakeHelperSocket>;
type HelperResponse = readonly [ComputerUseNativeMessageType, unknown];
type Responder = (metadata: Readonly<Record<string, unknown>>) => HelperResponse;

const digest = (digit: string): string => digit.repeat(64);
const helperPath = 'C:\\Resources\\sprint-coder-computer-use-host.exe';
const sourceCommit = 'f'.repeat(40);
const signerThumbprint = 'AB'.repeat(20);
const expectedTrust = Object.freeze({
  binaryDigest: digest('2'),
  signerDigest: createHash('sha256').update(signerThumbprint, 'utf8').digest('hex'),
  sourceCommit,
});
const appIdentityDigest = digest('a');
const executableDigest = digest('b');
const windowIdentityDigest = digest('c');
const bounds = Object.freeze({ x: 0, y: 0, width: 800, height: 600 });

/**
 * The Windows helper reads frames on one thread and serves them from a single loop
 * (`ServePipe` in computer-use-native/computer_use_windows_host.cc), so a request that is still
 * being served blocks every request queued behind it. `hold` models exactly that: the held
 * operation and everything queued after it waits until `release`.
 *
 * `holdOnly` instead withholds one operation while later ones are still answered. Today's serve
 * loop never does that, so it models a helper that answers out of order — which is the only thing
 * the transport's teardown must not depend on, since `shutdownWhenIdle` has a single call site and
 * the request that settles last is not always the close.
 */
class FakeWindowsHelper {
  private readonly queue: ComputerUseNativeFrame[] = [];
  private readonly held = new Map<string, 'blocking' | 'skipped'>();
  readonly served: string[] = [];

  constructor(
    private readonly socket: FakeSocket,
    private readonly responders: Readonly<Record<string, Responder>>,
  ) {
    socket.onWrite = (frame) => {
      this.queue.push(decodeComputerUseNativeFrame(frame));
      this.pump();
    };
  }

  hold(operation: string): void {
    this.held.set(operation, 'blocking');
  }

  holdOnly(operation: string): void {
    this.held.set(operation, 'skipped');
  }

  release(operation: string): void {
    this.held.delete(operation);
    this.pump();
  }

  private pump(): void {
    for (let index = 0; index < this.queue.length && !this.socket.destroyed;) {
      const frame = this.queue[index]!;
      const metadata = JSON.parse(frame.metadata.toString('utf8')) as Record<string, unknown>;
      const operation = String(metadata['operation']);
      const holdMode = this.held.get(operation);
      if (holdMode === 'blocking') return;
      if (holdMode === 'skipped') {
        index += 1;
        continue;
      }
      this.queue.splice(index, 1);
      this.served.push(operation);
      const responder = this.responders[operation];
      if (responder === undefined) throw new Error(`unexpected helper operation ${operation}`);
      const [messageType, payload] = responder(metadata);
      this.socket.emit(
        'data',
        encodeComputerUseNativeFrame({
          messageType,
          flags: 0,
          requestId: frame.requestId,
          sessionId: frame.sessionId,
          cancelId: null,
          metadata: Buffer.from(JSON.stringify(payload), 'utf8'),
          binary: Buffer.alloc(0),
        }),
      );
      index = 0;
    }
  }
}

function responders(): Readonly<Record<string, Responder>> {
  return {
    handshake: () => [
      'handshake_result',
      { protocolVersion: 1, apiVersion: 2, platform: 'win32', sourceCommit },
    ],
    list_windows: () => [
      'probe_result',
      [
        {
          pid: 42,
          windowHandle: '100',
          boundsUnit: 'physical_px',
          windowId: '100',
          appIdentityDigest,
          executableDigest,
          windowIdentityDigest,
          title: 'Target',
          bounds,
          screenBounds: bounds,
          focused: true,
          eligible: true,
          ownerKind: 'application',
          modal: false,
          revision: 1,
          policyLanguage: 'en',
          maximumMode: 'full_access_app',
        },
      ],
    ],
    start_session: (metadata) => [
      'probe_result',
      {
        sessionId: metadata['sessionId'],
        windowId: '100',
        appIdentityDigest,
        windowIdentityDigest,
        profileRevision: 1,
        cancelEpoch: 0,
        policyLanguage: 'en',
        maximumMode: 'full_access_app',
        screenBounds: bounds,
        inputAttemptCount: 0,
      },
    ],
    observe: () => ['observe_result', { observed: true }],
    // Native answers a repeat close for a session it has already drained from its bounded
    // closed-session registry, which is the receipt Main needs to release the quarantine.
    close_session: (metadata) => [
      'probe_result',
      {
        result: 'closed',
        drained: true,
        sessionId: metadata['sessionId'],
        cancelEpoch: metadata['cancelEpoch'],
        inputAttemptCount: 0,
      },
    ],
  };
}

function binding(addon: NonNullable<ComputerUseNativeBinding['addon']>): ComputerUseNativeBinding {
  return {
    manifest: {
      version: 1,
      sourceCommit,
      platform: 'win32',
      architecture: 'x64',
      protocolVersion: 1,
      apiVersion: 2,
      nativeVersion: 'test-native',
      moduleDigest: digest('1'),
      binaryDigest: digest('2'),
      signerDigest: digest('3'),
      capabilities: ['observe', 'capture', 'accessibility', 'input'],
    },
    probe: {
      available: true,
      protocolVersion: 1,
      apiVersion: 2,
      backend: 'test-native',
      reason: '',
      artifactPath: helperPath,
      artifactDigest: digest('1'),
      capabilities: { observe: true, control: true },
    },
    artifactPath: helperPath,
    addon,
  };
}

const profile = Object.freeze({
  id: 'profile-1',
  platform: 'win32' as const,
  kind: 'win32-executable' as const,
  label: 'Target',
  canonicalPath: helperPath,
  appUrl: null,
  identity: {
    platform: 'win32' as const,
    identityDigest: appIdentityDigest,
    executablePath: helperPath,
    executableDigest,
    signerDigest: digest('d'),
    packageFamilyName: null,
    appUserModelId: null,
    displayName: 'Target',
    maximumMode: 'full_access_app' as const,
  },
  identityDigest: appIdentityDigest,
  version: null,
  executableDigest,
  mode: 'full_access_app' as const,
  connectionId: 'connection-1',
  modelId: 'model-1',
  providerEgressConsent: true,
  remember: false,
  revision: 1,
  createdAt: '2026-09-18T00:00:00.000Z',
  updatedAt: '2026-09-18T00:00:00.000Z',
});

function createTarget(): {
  addon: ReturnType<typeof createWindowsComputerUseNativeAddon>;
  host: ReturnType<typeof createComputerUseNativeHost>;
  helper: () => FakeWindowsHelper;
} {
  let helper: FakeWindowsHelper | null = null;
  const table = responders();
  transport.state.onSocket = (socket) => {
    helper = new FakeWindowsHelper(socket, table);
  };
  const addon = createWindowsComputerUseNativeAddon(
    helperPath,
    {
      available: true,
      protocolVersion: 1,
      apiVersion: 2,
      backend: 'test-native',
      reason: '',
      capabilities: { observe: true, control: true },
    },
    expectedTrust,
  );
  const host = createComputerUseNativeHost(binding(addon), 'win32', {
    windowsPhysicalBoundsToDip: (value) => value,
  });
  return {
    addon,
    host,
    helper: () => {
      if (helper === null) throw new Error('the helper has not been connected yet');
      return helper;
    },
  };
}

async function startSession(
  host: ReturnType<typeof createComputerUseNativeHost>,
  sessionId: string,
  turnId: string,
): ReturnType<ReturnType<typeof createComputerUseNativeHost>['startSession']> {
  return await host.startSession({
    profile,
    windowId: '100',
    sessionId,
    taskId: 'task-1',
    turnId,
    cancelEpoch: 0,
  });
}

/**
 * An observe that was issued before Stop. The controller's AbortSignal never reaches the
 * transport (computer-use-controller.ts executeObserve), so this request stays on the wire.
 */
function observeThroughTransport(
  addon: ComputerUseNativeAddon,
  sessionId: string,
): Promise<'resolved' | 'rejected'> {
  const observe = addon.observe;
  if (observe === undefined) throw new Error('the Windows addon has to expose observe');
  return Promise.resolve(
    observe({ sessionId, requestId: `${sessionId}:observe:1`, cancelEpoch: 0 }),
  ).then(
    () => 'resolved' as const,
    () => 'rejected' as const,
  );
}

/** The bounded close re-send ComputerUseController.completeStop performs. */
async function closeWithBoundedResend(
  host: ReturnType<typeof createComputerUseNativeHost>,
  session: Awaited<ReturnType<ReturnType<typeof createComputerUseNativeHost>['startSession']>>,
): Promise<boolean> {
  let closed = false;
  for (let attempt = 0; attempt < COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT && !closed; attempt += 1)
    closed = await host.close(session).then(
      () => true,
      () => false,
    );
  return closed;
}

describe('Computer Use Windows helper transport', () => {
  beforeEach(() => {
    transport.state.children.length = 0;
    transport.state.sockets.length = 0;
    transport.state.onSocket = null;
    transport.state.attestation = JSON.stringify({
      imagePath: helperPath,
      binaryDigest: expectedTrust.binaryDigest,
      signatureStatus: 'Valid',
      signerThumbprint,
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    transport.state.onSocket = null;
  });

  it('keeps the helper reachable so a close re-sent after the Main deadline is confirmed', async () => {
    const { host, helper } = createTarget();
    const session = await startSession(host, 'session-1', 'turn-1');
    expect(host.availability()).toMatchObject({ observe: true, control: true });

    // The helper takes longer over the drain than Main's close deadline allows.
    helper().hold('close_session');
    const closed = closeWithBoundedResend(host, session);

    // Main gives up on the first close and re-sends it with a higher epoch. The re-send queues
    // behind the first close inside the helper, exactly as the single-threaded serve loop does.
    await vi.advanceTimersByTimeAsync(COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS);
    expect(transport.state.children).toHaveLength(1);
    expect(transport.state.children[0]!.killed).toBe(false);

    // The helper answers the first close two seconds later, then the re-send behind it.
    await vi.advanceTimersByTimeAsync(2_000);
    helper().release('close_session');
    await vi.advanceTimersByTimeAsync(0);

    await expect(closed).resolves.toBe(true);
    expect(helper().served.filter((operation) => operation === 'close_session')).toHaveLength(2);
    expect(transport.state.children).toHaveLength(1);
    // The quarantine is released only by the confirmed receipt the re-send brought back.
    expect(host.availability()).toMatchObject({ state: 'ready', observe: true, control: true });
    // Nothing is left pending, so the helper that owned the session is gone.
    expect(transport.state.children[0]!.killed).toBe(true);
  });

  it('stays fail-closed and reaps the helper when the close is never answered', async () => {
    const { host, helper } = createTarget();
    const session = await startSession(host, 'session-1', 'turn-1');

    helper().hold('close_session');
    const closed = closeWithBoundedResend(host, session);

    // Both Main deadlines expire without a receipt.
    await vi.advanceTimersByTimeAsync(
      COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS * COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT,
    );
    await expect(closed).resolves.toBe(false);
    expect(host.availability()).toMatchObject({
      observe: false,
      control: false,
      reasonCode: 'native_stop_unconfirmed',
    });

    // The per-request timeout still bounds a helper that never answers: it aborts the transport
    // and kills the child, so an unanswered close cannot leak a helper process.
    await vi.advanceTimersByTimeAsync(COMPUTER_USE_NATIVE_CLOSE_TRANSPORT_TIMEOUT_MS);
    expect(transport.state.children[0]!.killed).toBe(true);
    expect(host.availability()).toMatchObject({ reasonCode: 'native_stop_unconfirmed' });
  });

  it('ends the helper once the last request that outlived the close settles', async () => {
    const { addon, host, helper } = createTarget();
    const session = await startSession(host, 'session-1', 'turn-1');

    // Stop aborts the controller's AbortSignal but never reaches the transport, so an observe
    // issued before the stop is still pending while the close settles.
    helper().holdOnly('observe');
    const observed = observeThroughTransport(addon, 'session-1');
    await vi.advanceTimersByTimeAsync(0);

    await expect(host.close(session)).resolves.toBeUndefined();
    expect(transport.state.children[0]!.killed).toBe(false);

    helper().release('observe');
    await expect(observed).resolves.toBe('resolved');
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.state.children[0]!.killed).toBe(true);
  });

  it('keeps the helper of a session started after the close from being torn down', async () => {
    const { addon, host, helper } = createTarget();
    const session = await startSession(host, 'session-1', 'turn-1');

    helper().holdOnly('observe');
    const observed = observeThroughTransport(addon, 'session-1');
    await vi.advanceTimersByTimeAsync(0);
    await expect(host.close(session)).resolves.toBeUndefined();

    // A new session claims the same helper before the stale observe settles.
    const next = await startSession(host, 'session-2', 'turn-2');
    expect(next.sessionId).toBe('session-2');

    helper().release('observe');
    await expect(observed).resolves.toBe('resolved');
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.state.children[0]!.killed).toBe(false);
    expect(transport.state.children).toHaveLength(1);
  });

  it('budgets the close round trip beyond every close deadline Main can still be waiting on', () => {
    expect(COMPUTER_USE_NATIVE_CLOSE_TRANSPORT_TIMEOUT_MS).toBeGreaterThan(
      COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS * COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT,
    );
  });
});
