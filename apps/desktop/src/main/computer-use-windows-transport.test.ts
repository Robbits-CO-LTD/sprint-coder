import type { ComputerAppProfileRecord } from './persistence';
import {
  ComputerUseController,
  type ComputerUseControllerPersistence,
} from './computer-use-controller';
import { createComputerAppGrantFixtureStore } from './computer-use-grant-fixture';
import { computerUseNativeDiscoveryResultSchema } from '@sprint-coder/contracts';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NodeChildProcess from 'node:child_process';
import type * as NodeNet from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  computerUseNativeMessageTypeNames,
  computerUseNativeMessageTypeValue,
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
  holdWriteCallbacks = false;
  readonly writeCallbacks: Array<(error?: Error | null) => void> = [];
  onWrite: ((frame: Buffer) => void) | null = null;
  write(chunk: Buffer, callback?: (error?: Error | null) => void): boolean {
    const written = Buffer.from(chunk);
    if (callback !== undefined) this.writeCallbacks.push(callback);
    // A real socket never calls back or delivers a response inside `write`.
    queueMicrotask(() => {
      if (!this.holdWriteCallbacks) callback?.(null);
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

  allow(operation: string): void {
    this.refused.delete(operation);
  }

  release(operation: string): void {
    this.held.delete(operation);
    this.pump();
  }

  releaseLast(operation: string): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const frame = this.queue[index]!;
      const metadata = JSON.parse(frame.metadata.toString('utf8')) as Record<string, unknown>;
      if (metadata['operation'] === operation) {
        this.queue.splice(index, 1);
        this.answer(frame);
        return;
      }
    }
    throw new Error('No held request');
  }

  private answer(frame: ComputerUseNativeFrame): void {
    const metadata = JSON.parse(frame.metadata.toString('utf8')) as Record<string, unknown>;
    const operation = String(metadata['operation']);
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
      this.answer(frame);
      index = 0;
    }
  }
}

function responders(): Readonly<Record<string, Responder>> {
  return {
    handshake: () => [
      'handshake_result',
      {
        protocolVersion: 1,
        apiVersion: 3,
        platform: 'win32',
        napiVersion: 10,
        sourceCommit,
        capabilities: { cancellableWindowDiscovery: true },
      },
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
      apiVersion: 3,
      nativeVersion: 'test-native',
      moduleDigest: digest('1'),
      binaryDigest: digest('2'),
      signerDigest: digest('3'),
      capabilities: ['observe', 'capture', 'accessibility', 'input'],
    },
    probe: {
      available: true,
      protocolVersion: 1,
      apiVersion: 3,
      backend: 'test-native',
      reason: '',
      artifactPath: helperPath,
      artifactDigest: digest('1'),
      capabilities: { observe: true, control: true, cancellableWindowDiscovery: true },
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

let discoverySequence = 0;
async function discoverRows(addon: ComputerUseNativeAddon) {
  const value = await addon.discoverWindows!({
    ...profile,
    discoveryId: 'transport-test:' + ++discoverySequence,
  });
  const result = computerUseNativeDiscoveryResultSchema.parse(value);
  if (result.result !== 'completed') throw new Error('Discovery not admitted');
  return result.windows;
}

function discoveryResponders(): Readonly<Record<string, Responder>> {
  const base = responders();
  return {
    ...base,
    handshake: () => [
      'handshake_result',
      {
        protocolVersion: 1,
        apiVersion: 3,
        platform: 'win32',
        napiVersion: 10,
        sourceCommit,
        capabilities: { cancellableWindowDiscovery: true },
      },
    ],
    list_windows_cancellable: (metadata) => [
      'probe_result',
      {
        discoveryId: metadata['discoveryId'],
        result: 'completed',
        drained: true,
        launchAttemptCount: 0,
        windows: base['list_windows']!({})[1],
      },
    ],
    stop_window_discovery: (metadata) => [
      'probe_result',
      {
        discoveryId: metadata['discoveryId'],
        result: 'stopped',
        drained: true,
        launchAttemptCount: 0,
      },
    ],
  };
}

function createTarget(
  customResponders: Readonly<Record<string, Responder>> = responders(),
  configure?: (helper: FakeWindowsHelper) => void,
): {
  addon: ReturnType<typeof createWindowsComputerUseNativeAddon>;
  host: ReturnType<typeof createComputerUseNativeHost>;
  helper: () => FakeWindowsHelper;
} {
  let helper: FakeWindowsHelper | null = null;
  // Legacy-named data fixtures supply rows; the wire itself uses only the new operation.
  const table: Readonly<Record<string, Responder>> = {
    ...discoveryResponders(),
    ...customResponders,
    list_windows_cancellable:
      customResponders['list_windows_cancellable'] ??
      ((metadata) => {
        const [type, value] = customResponders['list_windows']!(metadata);
        if (type !== 'probe_result') return [type, value];
        return [
          'probe_result',
          {
            discoveryId: metadata['discoveryId'],
            result: 'completed',
            drained: true,
            launchAttemptCount: 0,
            windows: value,
          },
        ];
      }),
  };
  // Every reconnect gets its own fake helper, the way a fresh child process would.
  onSocket = (socket) => {
    helper = new FakeWindowsHelper(socket, table);
    configure?.(helper);
  };
  const addon = createWindowsComputerUseNativeAddon(
    helperPath,
    {
      available: true,
      protocolVersion: 1,
      apiVersion: 3,
      backend: 'test-native',
      reason: '',
      capabilities: { observe: true, control: true, cancellableWindowDiscovery: true },
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

function controllerFor(
  host: ReturnType<typeof createComputerUseNativeHost>,
  profiles: ComputerAppProfileRecord[] = [profile],
) {
  const unused = (): never => {
    throw new Error('Unexpected persistence call');
  };
  const persistence: ComputerUseControllerPersistence = {
    ...createComputerAppGrantFixtureStore().api,
    listComputerAppProfiles: () => profiles,
    getComputerAppProfile: (id) => profiles.find((row) => row.id === id) ?? unused(),
    createComputerAppProfile: unused,
    updateComputerAppProfile: unused,
    removeComputerAppProfile: unused,
    recordComputerActionAudit: unused,
    completeComputerActionAudit: unused,
    recordComputerActionApprovalOutcome: unused,
    listComputerActionAudits: () => [],
    getActiveTurnId: () => null,
    getPermissionPolicy: () => ({ policyEpoch: 0 }),
  };
  return new ComputerUseController({
    persistence,
    native: host,
    featureEnabled: () => true,
    agentDrivenEnabled: () => true,
    repositionEmergencyStop: () => true,
  });
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

/** The message types the helper's own protocol header defines, by the TypeScript name. */
function headerEnumTypes(): Record<string, number> {
  const header = readFileSync(
    join(__dirname, '../../computer-use-native/computer_use_protocol.h'),
    'utf8',
  );
  const body = /enum class MessageType : std::uint16_t \{([\s\S]*?)\};/u.exec(header)?.[1] ?? '';
  const types: Record<string, number> = {};
  for (const match of body.matchAll(/\bk([A-Za-z]+) = (\d+),/gu))
    types[match[1]!.replace(/([a-z])([A-Z])/gu, '$1_$2').toLowerCase()] = Number(match[2]);
  return types;
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

  describe('cancellable discovery transport', () => {
    const input = (id: string) => ({ ...profile, discoveryId: id });

    it('sends a normalized, bound query and does not close a live session with discovery Stop', async () => {
      const table = discoveryResponders();
      const { addon, helper } = createTarget({
        ...table,
        list_windows_cancellable: (metadata) => {
          expect(metadata).toEqual({
            operation: 'list_windows_cancellable',
            discoveryId: 'scope:1',
            canonicalPath: profile.canonicalPath,
            identityDigest: appIdentityDigest,
            executableDigest,
            signerDigest: profile.identity.signerDigest,
          });
          return table['list_windows_cancellable']!(metadata);
        },
      });
      await addon.startSession!({ profile, sessionId: 'alive', windowId: '100', cancelEpoch: 0 });
      await expect(addon.discoverWindows!(input('scope:1'))).resolves.toMatchObject({
        result: 'completed',
        discoveryId: 'scope:1',
      });
      await expect(addon.stopWindowDiscovery!({ discoveryId: 'scope:1' })).resolves.toMatchObject({
        result: 'stopped',
      });
      expect(children[0]!.killed).toBe(false);
      expect(helper().served).not.toContain('list_windows');
      await addon.close!({ sessionId: 'alive', cancelEpoch: 1 });
      expect(children[0]!.killed).toBe(true);
    });

    it('keeps a pending discovery reachable after another session closes', async () => {
      const { addon, helper } = createTarget(discoveryResponders(), (h) =>
        h.holdOnly('list_windows_cancellable'),
      );
      await addon.startSession!({ profile, sessionId: 'alive', windowId: '100', cancelEpoch: 0 });
      const query = Promise.resolve(addon.discoverWindows!(input('scope:pending')));
      await vi.advanceTimersByTimeAsync(0);
      await addon.close!({ sessionId: 'alive', cancelEpoch: 1 });
      expect(children[0]!.killed).toBe(false);
      await expect(
        addon.stopWindowDiscovery!({ discoveryId: 'scope:pending' }),
      ).resolves.toMatchObject({ result: 'stopped' });
      expect(children[0]!.killed).toBe(false);
      await expect(addon.discoverWindows!(input('scope:pending'))).rejects.toThrow('already used');
      helper().release('list_windows_cancellable');
      await expect(query).resolves.toMatchObject({ result: 'completed' });
      expect(helper().served.filter((x) => x === 'list_windows_cancellable')).toHaveLength(1);
    });

    it('does not submit when either the initial or pipe capability is absent', async () => {
      const addon = createWindowsComputerUseNativeAddon(helperPath, {}, expectedTrust);
      await expect(addon.discoverWindows!(input('no-initial-cap'))).rejects.toThrow('capability');
      expect(children).toHaveLength(0);
      const table = discoveryResponders();
      const target = createTarget({
        ...table,
        handshake: () => [
          'handshake_result',
          {
            protocolVersion: 1,
            apiVersion: 3,
            platform: 'win32',
            napiVersion: 10,
            sourceCommit,
            capabilities: { cancellableWindowDiscovery: false },
          },
        ],
      });
      await expect(target.addon.discoverWindows!(input('no-pipe-cap'))).rejects.toThrow(
        'capability',
      );
      expect(target.helper().served).toEqual(['handshake']);
      expect(target.addon.cancelUnsubmittedDiscovery!('no-pipe-cap')).toBe('never_sent');
    });

    it('reclaims consumed unsent failures and recovers beyond the 16-owner capacity', async () => {
      const { addon } = createTarget(discoveryResponders());
      const spawn = transport.spawnHelper;
      transport.spawnHelper = () => {
        throw new Error('spawn unavailable');
      };
      try {
        for (let index = 0; index < 20; index++) {
          const id = 'unsent:' + index;
          await expect(addon.discoverWindows!(input(id))).rejects.toThrow('spawn unavailable');
          expect(addon.cancelUnsubmittedDiscovery!(id)).toBe('never_sent');
        }
      } finally {
        transport.spawnHelper = spawn;
      }
      await expect(addon.discoverWindows!(input('recovered'))).resolves.toMatchObject({
        result: 'completed',
      });
    });

    it('rejects wrong-owner evidence and never reconnects to prove an old discovery stopped', async () => {
      const { addon, helper } = createTarget(
        {
          ...discoveryResponders(),
          stop_window_discovery: () => [
            'probe_result',
            {
              discoveryId: 'wrong',
              result: 'stopped',
              drained: true,
              launchAttemptCount: 0,
            },
          ],
        },
        (h) => h.holdOnly('list_windows_cancellable'),
      );
      const query = Promise.resolve(addon.discoverWindows!(input('old'))).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      await expect(addon.stopWindowDiscovery!({ discoveryId: 'old' })).rejects.toThrow('binding');
      sockets[0]!.destroy();
      await vi.advanceTimersByTimeAsync(0);
      await query;
      await expect(addon.stopWindowDiscovery!({ discoveryId: 'old' })).rejects.toThrow(
        'generation',
      );
      expect(children).toHaveLength(1);
      expect(helper().served.filter((x) => x === 'stop_window_discovery')).toHaveLength(1);
    });

    it('refuses a launch counter change after a terminal Stop', async () => {
      const { addon, helper } = createTarget(
        {
          ...discoveryResponders(),
          list_windows_cancellable: (metadata) => [
            'probe_result',
            {
              discoveryId: metadata['discoveryId'],
              result: 'completed',
              drained: true,
              launchAttemptCount: 1,
              windows: [],
            },
          ],
        },
        (helper) => helper.holdOnly('list_windows_cancellable'),
      );
      const query = Promise.resolve(addon.discoverWindows!(input('counter'))).catch(
        (error: Error) => error.message,
      );
      await vi.advanceTimersByTimeAsync(0);
      await expect(addon.stopWindowDiscovery!({ discoveryId: 'counter' })).resolves.toMatchObject({
        launchAttemptCount: 0,
      });
      helper().release('list_windows_cancellable');
      expect(await query).toMatch(/binding/u);
    });

    it('keeps the discovery Stop lane alive when an older query reaches its deadline', async () => {
      const { addon, helper } = createTarget(discoveryResponders(), (h) => {
        h.holdOnly('list_windows_cancellable');
        h.holdOnly('stop_window_discovery');
      });
      const query = Promise.resolve(addon.discoverWindows!(input('deadline'))).catch(
        () => 'query timed out',
      );
      await vi.advanceTimersByTimeAsync(29990);
      const stop = Promise.resolve(addon.stopWindowDiscovery!({ discoveryId: 'deadline' }));
      await vi.advanceTimersByTimeAsync(20);
      await expect(query).resolves.toBe('query timed out');
      expect(children[0]!.killed).toBe(false);
      helper().release('stop_window_discovery');
      await expect(stop).resolves.toMatchObject({ result: 'stopped' });
    });
  });

  it('requests list_targets through the authenticated pipe without caller-supplied metadata', async () => {
    const value = { generation: 123_456_789, rulesetVersion: 2, truncated: false, targets: [] };
    const { addon, helper } = createTarget({
      ...responders(),
      list_targets: (metadata) => {
        expect(metadata).toEqual({ operation: 'list_targets' });
        return ['probe_result', value];
      },
    });
    await expect(Promise.resolve(addon.listTargets!({ pid: 999 }))).resolves.toEqual(value);
    expect(helper().served).toEqual(['handshake', 'list_targets']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('discards a discovery result when Stop quarantines input while the request is pending', async () => {
    const value = { generation: 123, rulesetVersion: 2, truncated: false, targets: [] };
    const target = createTarget({ ...responders(), list_targets: () => ['probe_result', value] });
    const trusted = binding(target.addon);
    // Inject only the inactive discovery binding; existing session/Stop receipts use the real host.
    const host = createComputerUseNativeHost(
      {
        ...trusted,
        manifest: {
          ...trusted.manifest,
          eligibility: {
            mode: 'v2-denylist',
            rulesetVersion: 2,
            classifierVersion: 1,
            lexiconVersion: 1,
            ticketRequired: true,
          },
        },
      },
      'win32',
      {
        effectiveEligibilityMode: () => 'v2-denylist',
        windowsPhysicalBoundsToDip: (bounds) => bounds,
      },
    );
    const session = await startSession(host, 'discovery-stop', 'turn-1');
    target.helper().holdOnly('list_targets');
    const pending = host.listTargets!().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    await host.cancel(session, 1);
    await expect(host.listTargets!()).rejects.toThrow('native_stop_unconfirmed');
    target.helper().release('list_targets');
    expect(await pending).toMatchObject({ reasonCode: 'native_stop_unconfirmed' });
    await host.close(session);
    await expect(host.listTargets!()).resolves.toEqual(value);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['binding', 'binary', 'error', 'disconnect'] as const)(
    'rejects list_targets on %s without returning evidence',
    async (failure) => {
      const { addon } = createTarget();
      await discoverRows(addon);
      const socket = sockets[0]!;
      socket.onWrite = (encoded) => {
        const request = decodeComputerUseNativeFrame(encoded);
        if (failure === 'disconnect') {
          socket.destroy();
          return;
        }
        socket.emit(
          'data',
          encodeComputerUseNativeFrame({
            ...request,
            messageType: failure === 'error' ? 'error' : 'probe_result',
            sessionId: failure === 'binding' ? { hex: 'e'.repeat(32) } : request.sessionId,
            metadata: Buffer.from(
              JSON.stringify(
                failure === 'error'
                  ? { code: 'target_measurement_unavailable' }
                  : { generation: 1, rulesetVersion: 2, truncated: false, targets: [] },
              ),
            ),
            binary: failure === 'binary' ? Buffer.from([1]) : Buffer.alloc(0),
          }),
        );
      };
      await expect(Promise.resolve(addon.listTargets!({}))).rejects.toThrow();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('does not accept another request response and times out an unanswered list', async () => {
    const { addon } = createTarget();
    await discoverRows(addon);
    const socket = sockets[0]!;
    socket.onWrite = (encoded) => {
      const request = decodeComputerUseNativeFrame(encoded);
      socket.emit(
        'data',
        encodeComputerUseNativeFrame({
          ...request,
          messageType: 'probe_result',
          requestId: { hex: 'e'.repeat(32) },
          metadata: Buffer.from('{}'),
          binary: Buffer.alloc(0),
        }),
      );
    };
    let settled = false;
    const outcome = Promise.resolve(addon.listTargets!({})).then(
      () => {
        settled = true;
        return 'resolved';
      },
      () => {
        settled = true;
        return 'rejected';
      },
    );
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe('rejected');
  });

  it('waits for a valid handshake before parallel calls, including reconnect', async () => {
    const target = createTarget();
    const invoke = () => Promise.resolve(discoverRows(target.addon));
    for (let connection = 0; connection < 2; connection += 1) {
      onSocket = (socket) => {
        const helper = new FakeWindowsHelper(socket, discoveryResponders());
        helper.holdOnly('handshake');
        heldHelper = helper;
      };
      let heldHelper: FakeWindowsHelper | undefined;
      const first = invoke();
      await vi.advanceTimersByTimeAsync(0);
      const second = invoke();
      await vi.advanceTimersByTimeAsync(0);
      expect(heldHelper!.served).toEqual([]);
      heldHelper!.release('handshake');
      await Promise.all([first, second]);
      expect(heldHelper!.served).toEqual([
        'handshake',
        'list_windows_cancellable',
        'list_windows_cancellable',
      ]);
      sockets.at(-1)!.emit('close');
    }
  });

  it.each(['buildMode', 'rulesetVersion', 'classifierVersion', 'lexiconVersion'])(
    'rejects unsupported %s before parallel operations on every connection',
    async (claim) => {
      const table: Readonly<Record<string, Responder>> = {
        ...responders(),
        handshake: (): HelperResponse => [
          'handshake_result',
          {
            protocolVersion: 1,
            apiVersion: 3,
            platform: 'win32',
            napiVersion: 10,
            sourceCommit,
            [claim]: 'v2',
          },
        ],
      };
      const target = createTarget(table);
      const served: string[] = [];
      onSocket = (socket) => {
        const tracked = Object.fromEntries(
          Object.entries(table).map(([key, respond]) => [
            key,
            (metadata: Readonly<Record<string, unknown>>) => {
              served.push(key);
              return respond(metadata);
            },
          ]),
        );
        new FakeWindowsHelper(socket, tracked);
      };
      for (let connection = 0; connection < 2; connection += 1) {
        const calls = Promise.allSettled([
          Promise.resolve(discoverRows(target.addon)),
          Promise.resolve(discoverRows(target.addon)),
        ]);
        await vi.advanceTimersByTimeAsync(5_100);
        expect((await calls).map((result) => result.status)).toEqual(['rejected', 'rejected']);
      }
      expect(served.length).toBeGreaterThan(0);
      expect(served.every((operation) => operation === 'handshake')).toBe(true);
    },
  );
  it.each([1, 64, 68, 70])(
    'reconnects the same addon after a frame is cut at byte %i',
    async (prefixBytes) => {
      const { addon } = createTarget();
      const list = () => Promise.resolve(discoverRows(addon));
      await expect(list()).resolves.toBeInstanceOf(Array);
      const oldSocket = sockets[0]!;
      const oldChild = children[0]!;
      oldSocket.onWrite = (encoded) => {
        const request = decodeComputerUseNativeFrame(encoded);
        const response = encodeComputerUseNativeFrame({
          ...request,
          messageType: 'probe_result',
          metadata: Buffer.from(
            JSON.stringify(
              discoveryResponders()['list_windows_cancellable']!(
                JSON.parse(request.metadata.toString('utf8')),
              )[1],
            ),
          ),
          binary: Buffer.alloc(0),
        });
        oldSocket.emit('data', response.subarray(0, prefixBytes));
        oldSocket.destroy();
      };
      const failed = list().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(await failed).toEqual(
        expect.objectContaining({ message: expect.stringContaining('pipe closed') }),
      );
      const reconnected = list();
      // Also bounds the pre-fix retry loop, so failure is a product rejection rather than a test timeout.
      const outcome = reconnected.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(510_000);
      expect(await outcome).toBeInstanceOf(Array);
      const newSocket = sockets.at(-1)!;
      let remaining: Buffer = Buffer.alloc(0);
      newSocket.onWrite = (encoded) => {
        const request = decodeComputerUseNativeFrame(encoded);
        const response = encodeComputerUseNativeFrame({
          ...request,
          messageType: 'probe_result',
          metadata: Buffer.from(
            JSON.stringify(
              discoveryResponders()['list_windows_cancellable']!(
                JSON.parse(request.metadata.toString('utf8')),
              )[1],
            ),
          ),
          binary: Buffer.alloc(0),
        });
        newSocket.emit('data', response.subarray(0, 64));
        remaining = response.subarray(64);
      };
      const pending = list();
      await vi.advanceTimersByTimeAsync(0);
      oldSocket.emit('data', Buffer.alloc(100));
      oldSocket.emit('error', new Error('late old socket error'));
      oldSocket.emit('close');
      oldChild.emit('exit', 1, null);
      newSocket.emit('data', remaining);
      await expect(pending).resolves.toBeInstanceOf(Array);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['header', 'length', 'body', 'binding'] as const)(
    'rejects an invalid %s on its pipe and recovers on a fresh connection',
    async (invalid) => {
      const { addon } = createTarget();
      const list = () => Promise.resolve(discoverRows(addon));
      await expect(list()).resolves.toBeInstanceOf(Array);
      sockets[0]!.onWrite = (encoded) => {
        const request = decodeComputerUseNativeFrame(encoded);
        const response = encodeComputerUseNativeFrame({
          ...request,
          messageType: 'probe_result',
          sessionId: invalid === 'binding' ? { hex: 'e'.repeat(32) } : request.sessionId,
          metadata: Buffer.from(invalid === 'body' ? '!' : '[]'),
          binary: Buffer.alloc(0),
        });
        if (invalid === 'header') response.writeUInt32LE(0, 0);
        if (invalid === 'length') response.writeUInt32LE(0xffffffff, 60);
        sockets[0]!.emit('data', response);
      };
      await expect(list()).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(0);
      await expect(list()).resolves.toBeInstanceOf(Array);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('ignores a delayed write failure from an old socket even when the request id is reused', async () => {
    const { addon } = createTarget();
    await expect(Promise.resolve(discoverRows(addon))).resolves.toBeInstanceOf(Array);
    const oldSocket = sockets[0]!;
    oldSocket.holdWriteCallbacks = true;
    oldSocket.onWrite = () => oldSocket.destroy();
    const observe = () =>
      Promise.resolve(addon.observe!({ sessionId: 'session', requestId: 'same-id' }));
    const rejected = expect(observe()).rejects.toThrow('pipe closed');
    await vi.advanceTimersByTimeAsync(0);
    await rejected;
    const oldCallback = oldSocket.writeCallbacks.at(-1)!;
    await expect(Promise.resolve(discoverRows(addon))).resolves.toBeInstanceOf(Array);
    const newSocket = sockets.at(-1)!;
    let remainder: Buffer = Buffer.alloc(0);
    newSocket.onWrite = (encoded) => {
      const request = decodeComputerUseNativeFrame(encoded);
      const response = encodeComputerUseNativeFrame({
        ...request,
        messageType: 'observe_result',
        metadata: Buffer.from('{"observed":true}'),
        binary: Buffer.alloc(0),
      });
      newSocket.emit('data', response.subarray(0, 64));
      remainder = response.subarray(64);
    };
    const current = observe().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    oldCallback(new Error('late write failure'));
    newSocket.emit('data', remainder);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(current).resolves.toEqual({ observed: true });
    expect(newSocket.destroyed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts every handshake retry with an empty decoder on the same helper', async () => {
    const { addon } = createTarget();
    const normalOnSocket = onSocket!;
    let attempt = 0;
    onSocket = (socket) => {
      normalOnSocket(socket);
      if (attempt++ !== 0) return;
      socket.onWrite = (encoded) => {
        const request = decodeComputerUseNativeFrame(encoded);
        const response = encodeComputerUseNativeFrame({
          ...request,
          messageType: 'handshake_result',
          metadata: Buffer.from(JSON.stringify(responders()['handshake']!({})[1])),
          binary: Buffer.alloc(0),
        });
        socket.emit('data', response.subarray(0, 64));
        socket.destroy();
      };
    };
    const listed = Promise.resolve(discoverRows(addon));
    await vi.advanceTimersByTimeAsync(200);
    await expect(listed).resolves.toBeInstanceOf(Array);
    expect(sockets).toHaveLength(2);
    expect(children).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves chunk splitting and coalesced frames for parallel requests', async () => {
    const { addon } = createTarget();
    await expect(Promise.resolve(discoverRows(addon))).resolves.toBeInstanceOf(Array);
    const socket = sockets[0]!;
    const responses: Buffer[] = [];
    socket.onWrite = (encoded) => {
      const request = decodeComputerUseNativeFrame(encoded);
      responses.push(
        encodeComputerUseNativeFrame({
          ...request,
          messageType: 'observe_result',
          metadata: Buffer.from('{"observed":true}'),
          binary: Buffer.alloc(0),
        }),
      );
      if (responses.length === 2) {
        const joined = Buffer.concat(responses);
        socket.emit('data', joined.subarray(0, 64));
        socket.emit('data', joined.subarray(64));
      }
    };
    await expect(
      Promise.all(
        [1, 2].map((id) =>
          Promise.resolve(
            addon.observe!({
              sessionId: 'session',
              requestId: `observe-${id}`,
            }),
          ),
        ),
      ),
    ).resolves.toEqual([{ observed: true }, { observed: true }]);
    expect(vi.getTimerCount()).toBe(0);
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

  it.each(['reply', 'timeout'] as const)(
    'keeps a new lifetime alive after an older stop %s',
    async (ending) => {
      const { addon, host, helper } = createTarget();
      await startSession(host, 'old-stop', 'old-turn');
      helper().holdOnly('close_session');
      const first = Promise.resolve(addon.close!({ sessionId: 'old-stop', cancelEpoch: 1 })).then(
        () => 'reply',
        () => 'timeout',
      );
      await vi.advanceTimersByTimeAsync(0);
      const second = Promise.resolve(addon.close!({ sessionId: 'old-stop', cancelEpoch: 2 }));
      await vi.advanceTimersByTimeAsync(0);
      helper().releaseLast('close_session');
      await second;
      await startSession(host, 'new-after-stop', 'new-turn');
      if (ending === 'reply') helper().release('close_session');
      else await vi.advanceTimersByTimeAsync(COMPUTER_USE_NATIVE_CLOSE_TRANSPORT_TIMEOUT_MS);
      await expect(first).resolves.toBe(ending);
      await vi.advanceTimersByTimeAsync(0);
      expect(children[0]!.killed).toBe(false);
    },
  );

  it.each(['success', 'native-error', 'timeout'] as const)(
    'requires bound discovery terminal evidence after late %s',
    async (ending) => {
      const { host, helper } = createTarget(responders(), (helper) => {
        helper.holdOnly('list_windows_cancellable');
        helper.refuse('stop_window_discovery');
      });
      const starting = startSession(host, 'pending-discovery', 'turn-1').then(
        () => 'adopted',
        () => 'rejected',
      );
      await vi.advanceTimersByTimeAsync(0);
      await expect(host.stopPendingStart!('pending-discovery')).rejects.toThrow(/unconfirmed/u);
      expect(host.availability().control).toBe(false);
      if (ending === 'timeout') await vi.advanceTimersByTimeAsync(60_000);
      else {
        if (ending === 'native-error') helper().refuse('list_windows_cancellable');
        helper().release('list_windows_cancellable');
      }
      await expect(starting).resolves.toBe('rejected');
      await vi.advanceTimersByTimeAsync(0);
      expect(helper().served).not.toContain('start_session');
      expect(helper().served).not.toContain('stop_pending_start');
      expect(host.availability().control).toBe(ending === 'success');
      if (ending !== 'success') {
        await expect(startSession(host, 'new-id', 'turn-2')).rejects.toThrow(/unconfirmed/u);
        helper().allow('stop_window_discovery');
      }
      await expect(host.stopPendingStart!('pending-discovery')).resolves.toMatchObject({
        kind: 'not_submitted',
      });
      expect(host.availability().control).toBe(true);
    },
  );

  it.each(['native-error', 'timeout'] as const)(
    'confirms failed discovery only through its own Stop receipt: %s',
    async (ending) => {
      const { host, helper } = createTarget(responders(), (helper) =>
        helper.holdOnly('list_windows_cancellable'),
      );
      const starting = startSession(host, 'failed-discovery', 'turn-1').then(
        () => 'adopted',
        () => 'rejected',
      );
      await vi.advanceTimersByTimeAsync(0);
      if (ending === 'native-error') {
        helper().refuse('list_windows_cancellable');
        helper().release('list_windows_cancellable');
      } else await vi.advanceTimersByTimeAsync(60_000);
      await expect(starting).resolves.toBe('rejected');
      expect(host.availability().control).toBe(true);
      expect(helper().served).toContain('stop_window_discovery');
      expect(helper().served).not.toContain('start_session');
    },
  );

  it('remembers the session proof while an independent discovery remains unconfirmed', async () => {
    const { host, helper } = createTarget(
      {
        ...responders(),
        stop_pending_start: (metadata) => [
          'probe_result',
          {
            result: 'closed',
            drained: true,
            sessionId: metadata['sessionId'],
            cancelEpoch: 1,
            inputAttemptCount: 0,
          },
        ],
      },
      (helper) => helper.holdOnly('start_session'),
    );
    const first = startSession(host, 'mixed-discovery', 'turn-1').then(
      () => 'adopted',
      () => 'rejected',
    );
    await vi.advanceTimersByTimeAsync(0);
    helper().holdOnly('list_windows_cancellable');
    helper().refuse('stop_window_discovery');
    const second = startSession(host, 'mixed-discovery', 'turn-1').then(
      () => 'adopted',
      () => 'rejected',
    );
    await vi.advanceTimersByTimeAsync(0);
    await expect(host.stopPendingStart!('mixed-discovery')).rejects.toThrow(/unconfirmed/u);
    expect(host.availability().control).toBe(false);
    expect(helper().served.filter((op) => op === 'stop_pending_start')).toHaveLength(1);
    helper().release('start_session');
    helper().release('list_windows_cancellable');
    await expect(Promise.all([first, second])).resolves.toEqual(['rejected', 'rejected']);
    await vi.advanceTimersByTimeAsync(0);
    expect(host.availability().control).toBe(true);
    await expect(host.stopPendingStart!('mixed-discovery')).resolves.toMatchObject({
      kind: 'closed',
    });
    expect(helper().served.filter((op) => op === 'stop_pending_start')).toHaveLength(1);
  });

  it('does not let active Close hide discovery, then combines a late discovery proof', async () => {
    const { host, helper } = createTarget(responders(), (helper) =>
      helper.holdOnly('start_session'),
    );
    const first = startSession(host, 'shared-discovery', 'turn-1');
    await vi.advanceTimersByTimeAsync(0);
    helper().holdOnly('list_windows_cancellable');
    helper().refuse('stop_window_discovery');
    const second = startSession(host, 'shared-discovery', 'turn-1').then(
      () => 'adopted',
      () => 'rejected',
    );
    await vi.advanceTimersByTimeAsync(0);
    helper().release('start_session');
    const active = await first;
    await host.cancel(active, 1);
    await expect(host.close(active)).rejects.toThrow(/unconfirmed/u);
    expect(host.availability().control).toBe(false);
    helper().release('list_windows_cancellable');
    await expect(second).resolves.toBe('rejected');
    await vi.advanceTimersByTimeAsync(0);
    expect(host.availability().control).toBe(true);
    expect(helper().served.filter((op) => op === 'start_session')).toHaveLength(1);
  });

  it('closes through the real Host before a delayed native start reply and never adopts it', async () => {
    const { addon, host, helper } = createTarget(
      {
        ...responders(),
        stop_pending_start: (metadata) => [
          'probe_result',
          {
            result: 'closed',
            drained: true,
            sessionId: metadata['sessionId'],
            cancelEpoch: 1,
            inputAttemptCount: 0,
          },
        ],
      },
      (helper) => helper.holdOnly('start_session'),
    );
    const starting = startSession(host, 'late-native', 'turn-1').then(
      () => 'adopted',
      () => 'rejected',
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(addon.cancelUnsubmittedStart?.('late-native')).toBe('may_have_been_sent');
    await expect(host.stopPendingStart!('late-native')).resolves.toMatchObject({ kind: 'closed' });
    expect(host.availability().control).toBe(false);
    expect(children[0]!.killed).toBe(false);
    helper().release('start_session');
    await expect(starting).resolves.toBe('rejected');
    expect(host.availability().control).toBe(true);
    await expect(startSession(host, 'late-native', 'turn-1')).rejects.toThrow(/closed/u);
  });

  it('recovers after more than sixteen preparation failures without losing the never-sent proof', async () => {
    const { addon } = createTarget();
    const windows = responders()['list_windows']!({})[1];
    const host = createComputerUseNativeHost(
      binding({
        ...addon,
        discoverWindows: (input) => ({
          discoveryId: (input as { discoveryId: string }).discoveryId,
          result: 'completed',
          drained: true,
          launchAttemptCount: 0,
          windows,
        }),
      }),
      'win32',
      {
        windowsPhysicalBoundsToDip: (value) => value,
      },
    );
    const spawn = transport.spawnHelper;
    try {
      transport.spawnHelper = () => {
        throw new Error('synthetic spawn failure');
      };
      for (let index = 0; index < 20; index += 1) {
        await expect(
          startSession(host, `unsent-failure-${index}`, `turn-${index}`),
        ).rejects.toThrow('synthetic spawn failure');
        expect(host.availability().control).toBe(true);
      }
    } finally {
      transport.spawnHelper = spawn;
    }
    const recovered = await startSession(host, 'recovered-after-failures', 'turn-recovered');
    expect(recovered.sessionId).toBe('recovered-after-failures');
    await host.close(recovered);
  });

  it('cancels every unsubmitted attempt of one lifetime before the pipe handshake returns', async () => {
    const { addon, helper } = createTarget(responders(), (helper) => helper.hold('handshake'));
    const attempts = [1, 2].map(() =>
      Promise.resolve(addon.startSession!({ sessionId: 'unsent', profile })).then(
        () => 'sent',
        () => 'canceled',
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(addon.cancelUnsubmittedStart?.('unknown')).toBe('unknown');
    expect(addon.cancelUnsubmittedStart?.('unsent')).toBe('never_sent');
    helper().release('handshake');
    await expect(Promise.all(attempts)).resolves.toEqual(['canceled', 'canceled']);
    expect(helper().served).not.toContain('start_session');
  });

  it('does not prove never-sent after a synchronous write failure', async () => {
    const { addon, host } = createTarget();
    await startSession(host, 'existing', 'turn-1');
    const write = sockets[0]!.write.bind(sockets[0]);
    vi.spyOn(sockets[0]!, 'write').mockImplementation((chunk, callback) => {
      const metadata = JSON.parse(
        decodeComputerUseNativeFrame(chunk).metadata.toString('utf8'),
      ) as Record<string, unknown>;
      if (metadata['operation'] === 'start_session') throw new Error('partial write failure');
      return write(chunk, callback);
    });
    await expect(addon.startSession!({ sessionId: 'write-failed', profile })).rejects.toThrow(
      /partial write/u,
    );
    expect(addon.cancelUnsubmittedStart?.('write-failed')).toBe('may_have_been_sent');
    expect(addon.cancelUnsubmittedStart?.('existing')).toBe('may_have_been_sent');
  });

  it('gives logical pending-stop retries distinct wire IDs on the stop lane', async () => {
    let epoch = 1;
    const { addon, host, helper } = createTarget({
      ...responders(),
      stop_pending_start: (metadata) => [
        'probe_result',
        {
          result: 'closed',
          drained: true,
          sessionId: metadata['sessionId'],
          cancelEpoch: epoch++,
          inputAttemptCount: 0,
        },
      ],
    });
    await startSession(host, 'pending-stop-wire', 'turn-1');
    const ids: string[] = [];
    const write = sockets[0]!.write.bind(sockets[0]);
    vi.spyOn(sockets[0]!, 'write').mockImplementation((chunk, callback) => {
      const frame = decodeComputerUseNativeFrame(chunk);
      if (JSON.parse(frame.metadata.toString('utf8')).operation === 'stop_pending_start')
        ids.push(frame.requestId.hex);
      return write(chunk, callback);
    });
    helper().holdOnly('stop_pending_start');
    const first = Promise.resolve(addon.stopPendingStart!({ sessionId: 'pending-stop-wire' }));
    const second = Promise.resolve(addon.stopPendingStart!({ sessionId: 'pending-stop-wire' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    helper().release('stop_pending_start');
    await expect(first).resolves.toMatchObject({ result: 'closed', cancelEpoch: 1 });
    await expect(second).resolves.toMatchObject({ result: 'closed', cancelEpoch: 2 });
  });

  it('does not tear down another preparing owner when canceling an unsent start', async () => {
    const { addon, helper } = createTarget(responders(), (helper) => helper.hold('handshake'));
    const first = Promise.resolve(addon.startSession!({ sessionId: 'keep-preparing', profile }));
    const second = Promise.resolve(
      addon.startSession!({ sessionId: 'cancel-preparing', profile }),
    ).then(
      () => 'sent',
      () => 'canceled',
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(addon.cancelUnsubmittedStart?.('cancel-preparing')).toBe('never_sent');
    helper().release('handshake');
    await expect(second).resolves.toBe('canceled');
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(helper().served.filter((operation) => operation === 'start_session')).toHaveLength(1);
    expect(children[0]!.killed).toBe(false);
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

    await expect(discoverRows(addon)).resolves.toBeInstanceOf(Array);
    expect(children).toHaveLength(2);
    expect(children[1]!.killed).toBe(false);
  });

  // ---- the preflight round trip (S5-a) -------------------------------------------------------
  const preflightReceipt = (
    metadata: Readonly<Record<string, unknown>>,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    decision: 'ordinary',
    reasonCode: null,
    deniedResult: null,
    ticket: 'ab'.repeat(32),
    classifierVersion: 1,
    inputAttemptCount: 0,
    requestId: metadata['requestId'],
    sessionId: metadata['sessionId'],
    cancelEpoch: metadata['cancelEpoch'],
    observationRevision: metadata['observationRevision'],
    ...overrides,
  });
  const ticketedTable = (
    seen: Array<Readonly<Record<string, unknown>>>,
    receipt: (metadata: Readonly<Record<string, unknown>>) => Record<string, unknown> = (
      metadata,
    ) => preflightReceipt(metadata),
    dispatchAnswer: HelperResponse | null = null,
  ): Readonly<Record<string, Responder>> => ({
    ...responders(),
    preflight: (metadata): HelperResponse => {
      seen.push({ operation: 'preflight', ...metadata });
      return ['preflight_result', receipt(metadata)];
    },
    dispatch: (metadata): HelperResponse => {
      seen.push({ operation: 'dispatch', ...metadata });
      return (
        dispatchAnswer ?? [
          'dispatch_result',
          {
            result: 'completed',
            reasonCode: null,
            sessionId: metadata['sessionId'],
            cancelEpoch: metadata['cancelEpoch'],
            inputAttemptCount: 1,
          },
        ]
      );
    },
  });
  const click = { type: 'click', x: 0.5, y: 0.5, button: 'left' } as const;
  async function dispatchThrough(
    target: ReturnType<typeof createTarget>,
    session: Awaited<ReturnType<typeof startSession>>,
    requestId = 'request-1',
  ) {
    const pending = target.host.dispatch({
      session,
      requestId,
      action: click,
      observationRevision: 1,
      cancelEpoch: 0,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(10);
    return await pending;
  }

  it('carries a preflight and its ticket through the transport to a ticketed dispatch', async () => {
    const seen: Array<Readonly<Record<string, unknown>>> = [];
    const target = createTarget(ticketedTable(seen));
    const session = await startSession(target.host, 'session-1', 'turn-1');
    // The helper answers the preflight with a type-12 frame; the receiver must accept it.
    await expect(dispatchThrough(target, session)).resolves.toMatchObject({ result: 'completed' });
    expect(seen.map((entry) => entry['operation'])).toEqual(['preflight', 'dispatch']);
    expect(seen[0]).toMatchObject({ requestId: 'request-1', sessionId: 'session-1' });
    expect(seen[0]).not.toHaveProperty('ticket');
    expect(seen[1]).toMatchObject({ requestId: 'request-1', ticket: 'ab'.repeat(32) });
    // The transport stayed healthy: one helper, one connection, nothing torn down.
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.destroyed).toBe(false);
  });

  it('maps the helper ticket refusal and a denied preflight to typed rejections', async () => {
    const refusedSeen: Array<Readonly<Record<string, unknown>>> = [];
    const refused = createTarget(
      ticketedTable(refusedSeen, undefined, ['error', { code: 'ticket_invalid', accepted: false }]),
    );
    const refusedSession = await startSession(refused.host, 'session-1', 'turn-1');
    await expect(dispatchThrough(refused, refusedSession)).resolves.toEqual({
      result: 'rejected',
      reasonCode: 'native_ticket_invalid',
    });
    const deniedSeen: Array<Readonly<Record<string, unknown>>> = [];
    const denied = createTarget(
      ticketedTable(deniedSeen, (metadata) =>
        preflightReceipt(metadata, {
          decision: 'denied',
          reasonCode: 'native_stale_target',
          deniedResult: 'rejected',
          ticket: null,
        }),
      ),
    );
    const deniedSession = await startSession(denied.host, 'session-2', 'turn-2');
    await expect(dispatchThrough(denied, deniedSession)).resolves.toMatchObject({
      result: 'rejected',
      reasonCode: 'native_stale_target',
    });
    // A denial never reaches the dispatch.
    expect(deniedSeen.map((entry) => entry['operation'])).toEqual(['preflight']);
  });

  it('sends a replay dispatch without a ticket', async () => {
    const seen: Array<Readonly<Record<string, unknown>>> = [];
    const target = createTarget(
      ticketedTable(seen, (metadata) =>
        preflightReceipt(metadata, { decision: 'replay', ticket: null }),
      ),
    );
    const session = await startSession(target.host, 'session-1', 'turn-1');
    await expect(dispatchThrough(target, session)).resolves.toMatchObject({ result: 'completed' });
    expect(seen.map((entry) => entry['operation'])).toEqual(['preflight', 'dispatch']);
    expect(seen[1]).not.toHaveProperty('ticket');
  });

  it('accepts every message type the protocol defines and refuses one it does not', async () => {
    const target = createTarget();
    await expect(Promise.resolve(discoverRows(target.addon))).resolves.toBeDefined();
    const socket = sockets.at(-1)!;
    const typeNames = computerUseNativeMessageTypeNames();
    // The table, the C++ enum and the receiver have to name the same set of types.
    expect(typeNames.sort()).toEqual(Object.keys(headerEnumTypes()).sort());
    for (const messageType of typeNames) {
      expect(computerUseNativeMessageTypeValue(messageType), messageType).toBe(
        headerEnumTypes()[messageType],
      );
      // A response for a request nobody is waiting on is dropped, but only a valid header gets that far.
      socket.emit(
        'data',
        encodeComputerUseNativeFrame({
          messageType,
          flags: 0,
          requestId: { hex: 'a'.repeat(32) },
          sessionId: { hex: 'b'.repeat(32) },
          cancelId: messageType === 'cancel' ? { hex: 'c'.repeat(32) } : null,
          metadata: Buffer.from('{}', 'utf8'),
          binary: Buffer.alloc(0),
        }),
      );
      expect(socket.destroyed, `${messageType} must not break the transport`).toBe(false);
    }
    // One past the highest known number is refused and the transport is dropped.
    const unknown = encodeComputerUseNativeFrame({
      messageType: 'error',
      flags: 0,
      requestId: { hex: 'a'.repeat(32) },
      sessionId: { hex: 'b'.repeat(32) },
      cancelId: null,
      metadata: Buffer.from('{}', 'utf8'),
      binary: Buffer.alloc(0),
    });
    unknown.writeUInt16LE(Math.max(...Object.values(headerEnumTypes())) + 1, 6);
    socket.emit('data', unknown);
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.destroyed).toBe(true);
  });

  it('production Controller stops pre-session discovery before its delayed result', async () => {
    const { host, helper } = createTarget();
    const controller = controllerFor(host);
    const [candidate] = await controller.listWindows(profile.id);
    helper().holdOnly('list_windows_cancellable');
    const starting = controller
      .start({
        taskId: 'task-a',
        profileId: profile.id,
        windowId: candidate!.windowId,
        mode: profile.mode,
        connectionId: profile.connectionId,
        modelId: profile.modelId,
        providerEgressConsent: true,
        providerEgressConsentBinding: {
          connectionId: profile.connectionId,
          modelId: profile.modelId,
        },
        remember: false,
        expectedPolicyEpoch: 0,
        expectedWindowRevision: 1,
        expectedProfileRevision: 1,
      })
      .then(
        () => 'adopted',
        (error: Error) => error.message,
      );
    await vi.advanceTimersByTimeAsync(0);
    await controller.stopForTask('task-a', 'task_changed');
    expect(await starting).toMatch(/canceled|stopped/u);
    expect(helper().served).toContain('stop_window_discovery');
    expect(helper().served).not.toContain('start_session');
    helper().release('list_windows_cancellable');
    await vi.advanceTimersByTimeAsync(0);
    expect(helper().served).not.toContain('start_session');
    expect(host.availability().control).toBe(true);
    await controller.dispose();
  });

  it('production Controller stops only the selected Task discovery on a shared profile', async () => {
    const { host, helper } = createTarget(responders(), (helper) =>
      helper.holdOnly('list_windows_cancellable'),
    );
    const controller = controllerFor(host);
    const a = controller.beginWindowCandidates(profile.id, 'task-a', 'frame-a');
    const b = controller.beginWindowCandidates(profile.id, 'task-b', 'frame-b');
    const aResult = a.result.catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(0);
    await controller.stopOutsideTask('task-b');
    expect(await aResult).toMatch(/canceled/u);
    expect(helper().served.filter((op) => op === 'stop_window_discovery')).toHaveLength(1);
    helper().release('list_windows_cancellable');
    await b.result;
    expect(b.commit((rows) => rows)).toHaveLength(1);
    expect(() => a.commit(() => 'stale')).toThrow(/canceled/u);
    await controller.dispose();
  });

  it('production Controller blocks commit in the native-result to IPC-result gap', async () => {
    const { host } = createTarget();
    const controller = controllerFor(host);
    const intent = controller.beginWindowCandidates(profile.id, 'task-a', 'frame-a');
    await intent.result;
    await controller.rendererInvalidated();
    const publish = vi.fn();
    expect(() => intent.commit(publish)).toThrow(/canceled/u);
    expect(publish).not.toHaveBeenCalled();
    await intent.cancel();
    await controller.dispose();
  });

  it('production Controller isolates Turn cancellation within the same Task', async () => {
    const { host, helper } = createTarget(responders(), (helper) =>
      helper.holdOnly('list_windows_cancellable'),
    );
    const controller = controllerFor(host);
    const one = controller
      .listTargets({}, { taskId: 'task-a', turnId: 'turn-1', workspaceId: null, policyEpoch: 0 })
      .then(
        () => 'published',
        (error: Error) => error.message,
      );
    const two = controller.listTargets(
      {},
      { taskId: 'task-a', turnId: 'turn-2', workspaceId: null, policyEpoch: 0 },
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.turnEnded('task-a', 'turn-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(await one).toMatch(/canceled/u);
    expect(helper().served.filter((op) => op === 'stop_window_discovery')).toHaveLength(1);
    helper().release('list_windows_cancellable');
    await expect(two).resolves.toHaveProperty('targets');
    await controller.dispose();
  });

  it('production Controller never starts the next profile after tool cancellation', async () => {
    const { host, helper } = createTarget(responders(), (helper) =>
      helper.holdOnly('list_windows_cancellable'),
    );
    const controller = controllerFor(host, [profile, { ...profile, id: 'profile-2' }]);
    const abort = new AbortController();
    const listing = controller
      .listTargets(
        {},
        {
          taskId: 'task-a',
          turnId: 'turn-a',
          workspaceId: null,
          policyEpoch: 0,
        },
        abort.signal,
      )
      .then(
        () => 'published',
        (error: Error) => error.message,
      );
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(await listing).toMatch(/canceled/u);
    helper().release('list_windows_cancellable');
    await vi.advanceTimersByTimeAsync(0);
    expect(helper().served.filter((op) => op === 'list_windows_cancellable')).toHaveLength(1);
    expect(helper().served.filter((op) => op === 'stop_window_discovery')).toHaveLength(1);
    await controller.dispose();
  });

  it('production Controller retains failed Stop, then consumes late bound proof without candidates', async () => {
    const { host, helper } = createTarget(responders(), (helper) => {
      helper.holdOnly('list_windows_cancellable');
      helper.refuse('stop_window_discovery');
    });
    const controller = controllerFor(host);
    const intent = controller.beginWindowCandidates(profile.id, 'task-a', 'frame-a');
    const listing = intent.result.catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(0);
    await expect(controller.stopForTask('task-a', 'task_changed')).rejects.toThrow(/unconfirmed/u);
    expect(await listing).toMatch(/unconfirmed/u);
    expect(helper().served.filter((op) => op === 'stop_window_discovery')).toHaveLength(2);
    expect(host.availability().control).toBe(false);
    helper().release('list_windows_cancellable');
    await vi.advanceTimersByTimeAsync(0);
    expect(host.availability().control).toBe(true);
    expect(() => intent.commit(() => 'stale')).toThrow(/canceled/u);
    await controller.stopForTask('task-a', 'task_changed');
    const fresh = controller.beginWindowCandidates(profile.id, 'task-a', 'frame-a');
    await fresh.result;
    expect(fresh.commit((rows) => rows)).toHaveLength(1);
    await controller.dispose();
  });

  it('production Controller supersedes an old frame intent without old cleanup clearing the new one', async () => {
    const { host, helper } = createTarget();
    const controller = controllerFor(host);
    const first = controller.beginWindowCandidates(profile.id, 'task-a', 'frame-a');
    await first.result;
    const next = controller.beginWindowCandidates(profile.id, 'task-a', 'frame-a');
    await next.result;
    await first.cancel();
    expect(next.commit((rows) => rows)).toHaveLength(1);
    expect(helper().served).not.toContain('start_session');
    await controller.dispose();
  });

  it('budgets the close round trip beyond every close deadline Main can still be waiting on', () => {
    expect(COMPUTER_USE_NATIVE_CLOSE_TRANSPORT_TIMEOUT_MS).toBeGreaterThan(
      COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS * COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT,
    );
  });
});
