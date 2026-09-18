import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
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
// The mock factories run before this module's body, so they only reach the fakes through these
// slots, which the body fills in below.
const transport = vi.hoisted(() => ({
  spawnHelper: null as (() => unknown) | null,
  connectPipe: null as (() => unknown) | null,
  attestation: '',
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  return {
    ...actual,
    spawn: () => transport.spawnHelper?.(),
    execFileSync: () => transport.attestation,
  };
});

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeNet>();
  return { ...actual, createConnection: () => transport.connectPipe?.() };
});

class FakeHelperSocket extends EventEmitter {
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

class FakeHelperChild extends EventEmitter {
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

const children: FakeHelperChild[] = [];
const sockets: FakeHelperSocket[] = [];
let onSocket: ((socket: FakeHelperSocket) => void) | null = null;
transport.spawnHelper = () => {
  const child = new FakeHelperChild();
  children.push(child);
  return child;
};
transport.connectPipe = () => {
  const socket = new FakeHelperSocket();
  sockets.push(socket);
  onSocket?.(socket);
  queueMicrotask(() => socket.emit('connect'));
  return socket;
};

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
 *
 * `refuse` answers an operation with the helper's error frame instead of its normal response.
 */
class FakeWindowsHelper {
  private readonly queue: ComputerUseNativeFrame[] = [];
  private readonly held = new Map<string, 'blocking' | 'skipped'>();
  private readonly refused = new Set<string>();
  readonly served: string[] = [];

  constructor(
    private readonly socket: FakeHelperSocket,
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

  refuse(operation: string): void {
    this.refused.add(operation);
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
      const [messageType, payload] = this.refused.has(operation)
        ? (['error', { code: 'SESSION_MISSING', accepted: false }] as const)
        : responder(metadata);
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
    cancel: (metadata) => [
      'dispatch_result',
      {
        result: 'canceled',
        drained: true,
        sessionId: metadata['sessionId'],
        cancelEpoch: metadata['cancelEpoch'],
        inputAttemptCount: 0,
      },
    ],
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
  // Every reconnect gets its own fake helper, the way a fresh child process would.
  onSocket = (socket) => {
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
    children.length = 0;
    sockets.length = 0;
    onSocket = null;
    transport.attestation = JSON.stringify({
      imagePath: helperPath,
      binaryDigest: expectedTrust.binaryDigest,
      signatureStatus: 'Valid',
      signerThumbprint,
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    onSocket = null;
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
    expect(children).toHaveLength(1);
    expect(children[0]!.killed).toBe(false);

    // The helper answers the first close two seconds later, then the re-send behind it.
    await vi.advanceTimersByTimeAsync(2_000);
    helper().release('close_session');
    await vi.advanceTimersByTimeAsync(0);

    await expect(closed).resolves.toBe(true);
    expect(helper().served.filter((operation) => operation === 'close_session')).toHaveLength(2);
    expect(children).toHaveLength(1);
    // The quarantine is released only by the confirmed receipt the re-send brought back.
    expect(host.availability()).toMatchObject({ state: 'ready', observe: true, control: true });
    // Nothing is left pending, so the helper that owned the session is gone.
    expect(children[0]!.killed).toBe(true);
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

    // The per-request timeouts still bound a helper that never answers, so an unanswered close
    // cannot leak a helper process. An earlier close's timeout defers to a re-send that is still
    // on the wire, so the one that reaps the helper is the last attempt's: sent one drain budget
    // in, and given the same transport budget as the first.
    const elapsed =
      COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS * COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT;
    const reapAt =
      COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS * (COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT - 1) +
      COMPUTER_USE_NATIVE_CLOSE_TRANSPORT_TIMEOUT_MS;
    await vi.advanceTimersByTimeAsync(reapAt - elapsed - 1);
    expect(children[0]!.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(children[0]!.killed).toBe(true);
    expect(host.availability()).toMatchObject({ reasonCode: 'native_stop_unconfirmed' });
  });

  it('keeps the stop reachable when an earlier request times out on the same transport', async () => {
    const { addon, host, helper } = createTarget();
    const session = await startSession(host, 'session-1', 'turn-1');

    // The helper is busy with a slow observe, and it serves one request at a time, so everything
    // Stop sends queues behind that observe.
    helper().hold('observe');
    const observed = observeThroughTransport(addon, 'session-1');
    await vi.advanceTimersByTimeAsync(0);

    // Stop cancels first. Main stops waiting for that acknowledgement after
    // COMPUTER_USE_NATIVE_CANCEL_ACK_TIMEOUT_MS, but the request keeps a transport budget of its
    // own that outlives the deadline and would expire in the middle of the close re-send window.
    const canceled = host.cancel(session, 1).then(
      () => 'acknowledged',
      () => 'unconfirmed',
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(canceled).resolves.toBe('unconfirmed');

    const closed = closeWithBoundedResend(host, session);
    // The cancel's transport budget runs out here, while the close is still on the wire. Ending
    // the transport for it would take the helper — and the session's close receipt — with it.
    await vi.advanceTimersByTimeAsync(COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS);
    expect(children[0]!.killed).toBe(false);

    // The helper then works through its queue: the observe it was busy with, and behind it the
    // re-sent close, which is answered by the same helper and confirms the stop.
    helper().release('observe');
    await vi.advanceTimersByTimeAsync(0);
    await expect(closed).resolves.toBe(true);
    await expect(observed).resolves.toBe('resolved');
    expect(host.availability()).toMatchObject({ state: 'ready', observe: true, control: true });
    // One helper throughout: the cancel's expiry never sent Stop to a fresh process that could
    // not know the session.
    expect(children).toHaveLength(1);
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
    expect(children[0]!.killed).toBe(false);

    helper().release('observe');
    await expect(observed).resolves.toBe('resolved');
    await vi.advanceTimersByTimeAsync(0);
    expect(children[0]!.killed).toBe(true);
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
    expect(children[0]!.killed).toBe(false);
    expect(children).toHaveLength(1);
  });

  it('ends the helper when the last outstanding request is refused rather than answered', async () => {
    const { addon, host, helper } = createTarget();
    const session = await startSession(host, 'session-1', 'turn-1');

    helper().holdOnly('observe');
    helper().refuse('observe');
    const observed = observeThroughTransport(addon, 'session-1');
    await vi.advanceTimersByTimeAsync(0);
    await expect(host.close(session)).resolves.toBeUndefined();
    expect(children[0]!.killed).toBe(false);

    // A helper error frame settles the request just as finally as a result does, so it has to run
    // the teardown the close armed.
    helper().release('observe');
    await expect(observed).resolves.toBe('rejected');
    await vi.advanceTimersByTimeAsync(0);
    expect(children[0]!.killed).toBe(true);
  });

  it('does not carry a teardown armed before a transport failure onto the next helper', async () => {
    const { addon, host, helper } = createTarget();
    const session = await startSession(host, 'session-1', 'turn-1');

    helper().holdOnly('observe');
    const observed = observeThroughTransport(addon, 'session-1');
    await vi.advanceTimersByTimeAsync(0);
    await expect(host.close(session)).resolves.toBeUndefined();

    // The pipe breaks while the teardown is armed and the observe is still pending. The armed
    // teardown belongs to that dead transport, not to the helper the next request connects.
    sockets[0]!.emit('close');
    await expect(observed).resolves.toBe('rejected');

    const listWindows = addon.listWindows;
    if (listWindows === undefined) throw new Error('the Windows addon has to expose listWindows');
    await expect(Promise.resolve(listWindows(profile))).resolves.toBeInstanceOf(Array);
    expect(children).toHaveLength(2);
    expect(children[1]!.killed).toBe(false);
  });

  it('budgets the close round trip beyond every close deadline Main can still be waiting on', () => {
    expect(COMPUTER_USE_NATIVE_CLOSE_TRANSPORT_TIMEOUT_MS).toBeGreaterThan(
      COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS * COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT,
    );
  });
});
