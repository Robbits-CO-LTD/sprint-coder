import { readWindowsHostSource } from '../../../../computer-use-windows-host-source.mjs';
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
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import type * as NodeNet from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  ComputerUseNativeUnavailableError,
  createComputerUseNativeHost,
  type ComputerUseNativeHostOptions,
} from './computer-use-native-host';
import type {
  WindowsLedgerRow,
  WindowsTargetQuarantine,
} from './computer-use-windows-stop-outcome';
import * as stopKernel from './computer-use-windows-stop-outcome';
import {
  COMPUTER_USE_NATIVE_CLOSE_TRANSPORT_TIMEOUT_MS,
  createWindowsComputerUseNativeAddon,
  operationTimeoutMilliseconds,
  windowsHelperEnvironment,
} from './computer-use-native-windows';

/**
 * These tests drive the real `createWindowsComputerUseNativeAddon` transport — its pending map,
 * per-request timeouts, frame binding and teardown — against a fake helper child process, and put
 * the real Main adapter (`createComputerUseNativeHost`) in front of it so the close deadline and
 * the input quarantine are the production ones. Only helper temp I/O, `spawn`, the attestation and the
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
    spawn: vi.fn((_file: string, _args: string[], _options: NodeChildProcess.SpawnOptions) =>
      transport.spawnHelper?.(),
    ),
    execFileSync: () => transport.attestation,
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  let sequence = 0;
  return {
    ...actual,
    mkdtemp: vi.fn(async (prefix: string) => `${prefix}fixture-${++sequence}`),
    rm: vi.fn(async () => undefined),
  };
});

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeNet>();
  return { ...actual, createConnection: () => transport.connectPipe?.() };
});

class FakeHelperSocket extends EventEmitter {
  readonly writes: Buffer[] = [];
  destroyed = false;
  holdWriteCallbacks = false;
  readonly writeCallbacks: Array<(error?: Error | null) => void> = [];
  onWrite: ((frame: Buffer) => void) | null = null;
  write(chunk: Buffer, callback?: (error?: Error | null) => void): boolean {
    const written = Buffer.from(chunk);
    this.writes.push(written);
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
        capabilities: { cancellableWindowDiscovery: true, artifactRead: true },
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
  options: ComputerUseNativeHostOptions = {},
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
    ...options,
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
    vi.mocked(spawn).mockClear();
    vi.mocked(mkdtemp).mockClear();
    vi.mocked(rm).mockClear();
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

  const helperTempVariable = 'SPRINT_CODER_COMPUTER_USE_HELPER_TEMP';
  const identityTargets = [{ pid: 4242, processStartTime: '133000000000000001' }];

  it('checks target identities as the first operation with mixed results in request order and no identities', async () => {
    const results = [
      { result: 'alive' },
      { result: 'terminated', reason: 'signaled' },
      { result: 'terminated', reason: 'start_time_mismatch' },
      { result: 'terminated', reason: 'no_process' },
      { result: 'unverifiable', reason: 'access_denied' },
      { result: 'unverifiable', reason: 'win32_error' },
    ];
    const targets = results.map((_, index) => ({ ...identityTargets[0]!, pid: 4242 + index }));
    const { addon, helper } = createTarget({
      ...responders(),
      check_target_identity: (metadata) => {
        expect(metadata).toEqual({ operation: 'check_target_identity', targets });
        return ['target_identity_result', { results }];
      },
    });
    const output = await addon.checkTargetIdentity(targets);
    // Results carry no identity: each position must correspond to the same request position.
    expect(output).toEqual(results);
    expect(JSON.stringify(output)).not.toMatch(/pid|processStartTime|133000000000000001/u);
    expect(helper().served).toEqual(['handshake', 'check_target_identity']);
  });

  it.each([
    { results: 'x' },
    { results: [1] },
    { results: [{ result: 'terminated', reason: 'access_denied' }] },
    { results: [{ result: 'unverifiable', reason: 'start_time_mismatch' }] },
    { results: [{ result: 'terminated', reason: 'signaled', extra: true }] },
    { results: [{ result: 'unknown' }] },
    { results: [{ result: 'terminated', reason: 'unknown' }] },
    { results: [{ result: 'unverifiable', reason: 'no_process' }] },
    { results: [{ result: 'alive', reason: 'signaled' }] },
    { results: [{ result: 'terminated' }] },
    { results: [{ result: 'alive', pid: 4242 }] },
    { results: [{ result: 'alive', processStartTime: '133000000000000001' }] },
    { results: [{ result: 'alive' }], extra: true },
    { results: [] },
    { results: [{ result: 'alive' }, { result: 'alive' }] },
    null,
  ])(
    'rejects malformed identity responses without disclosing their payload: %j',
    async (payload) => {
      const { addon } = createTarget({
        ...responders(),
        check_target_identity: () => ['target_identity_result', payload],
      });
      await expect(addon.checkTargetIdentity(identityTargets)).rejects.toThrow(
        /^Invalid Windows target identity response$/u,
      );
    },
  );

  it.each(['0', '01', '-1', '1.0', '1e3', ' 1', '18446744073709551616', '9'.repeat(21)])(
    'rejects invalid FILETIME %s before starting a helper',
    async (processStartTime) => {
      const { addon } = createTarget();
      await expect(addon.checkTargetIdentity([{ pid: 4242, processStartTime }])).rejects.toThrow(
        /^Invalid Windows target identity request$/u,
      );
      expect(children).toHaveLength(0);
    },
  );

  it('rejects an oversized identity request before starting a helper', async () => {
    const { addon } = createTarget();
    await expect(addon.checkTargetIdentity(Array(65).fill(identityTargets[0]))).rejects.toThrow(
      /^Invalid Windows target identity request$/u,
    );
    expect(children).toHaveLength(0);
  });

  it.each([0, -1, 1.5, 0x1_0000_0000, '4242', null])(
    'rejects an invalid identity PID %j before starting a helper',
    async (pid) => {
      const { addon } = createTarget();
      await expect(addon.checkTargetIdentity([{ ...identityTargets[0], pid }])).rejects.toThrow(
        /^Invalid Windows target identity request$/u,
      );
      expect(children).toHaveLength(0);
    },
  );

  it.each([0, 64])('accepts %i identities with the maximum FILETIME', async (count) => {
    const results = Array.from({ length: count }, () => ({ result: 'alive' }));
    const { addon } = createTarget({
      ...responders(),
      check_target_identity: () => ['target_identity_result', { results }],
    });
    await expect(
      addon.checkTargetIdentity(
        Array.from({ length: count }, () => ({
          pid: 4242,
          processStartTime: '18446744073709551615',
        })),
      ),
    ).resolves.toEqual(results);
  });

  it('does not expose helper error payloads in identity check errors', async () => {
    const { addon } = createTarget({
      ...responders(),
      check_target_identity: () => ['error', { code: JSON.stringify(identityTargets) }],
    });
    await expect(addon.checkTargetIdentity(identityTargets)).rejects.toThrow(
      /^Windows target identity check failed$/u,
    );
  });
  const cleanupOptions = { recursive: true, force: true, maxRetries: 20, retryDelay: 50 };
  const spawnedTemp = (index: number) =>
    vi.mocked(spawn).mock.calls[index]?.[2]?.env?.[helperTempVariable];

  it('passes a helper-specific temp directory without changing TEMP or TMP and removes it on exit', async () => {
    vi.stubEnv('TEMP', 'C:\\synthetic-temp');
    vi.stubEnv('TMP', 'C:\\synthetic-tmp');
    try {
      const { addon } = createTarget();
      await discoverRows(addon);
      expect(mkdtemp).toHaveBeenCalledWith(join(tmpdir(), 'sc-cu-helper-'));
      expect(spawnedTemp(0)).toEqual(expect.stringContaining('sc-cu-helper-'));
      expect(vi.mocked(spawn).mock.calls[0]?.[2]?.env).toEqual({
        ...windowsHelperEnvironment(process.env),
        SPRINT_CODER_COMPUTER_USE_HELPER_TEMP: spawnedTemp(0),
      });
      expect(rm).not.toHaveBeenCalled();
      children[0]!.emit('exit', 0, null);
      expect(rm).toHaveBeenCalledWith(spawnedTemp(0), cleanupOptions);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('removes an old helper directory on exit without removing the current helper directory', async () => {
    const { addon } = createTarget();
    await discoverRows(addon);
    const oldChild = children[0]!;
    sockets[0]!.destroy();
    await vi.advanceTimersByTimeAsync(0);
    await discoverRows(addon);
    expect(children).toHaveLength(2);
    expect(spawnedTemp(0)).not.toBe(spawnedTemp(1));
    oldChild.emit('exit', 0, null);
    expect(rm).toHaveBeenCalledWith(spawnedTemp(0), cleanupOptions);
    expect(rm).not.toHaveBeenCalledWith(spawnedTemp(1), cleanupOptions);
    children[1]!.emit('exit', 0, null);
    expect(rm).toHaveBeenCalledWith(spawnedTemp(1), cleanupOptions);
  });

  it('removes the helper directory when spawn throws', async () => {
    const original = transport.spawnHelper;
    transport.spawnHelper = () => {
      throw new Error('synthetic spawn failure');
    };
    try {
      const { addon } = createTarget();
      await expect(discoverRows(addon)).rejects.toThrow('synthetic spawn failure');
      expect(spawnedTemp(0)).toEqual(expect.any(String));
      expect(rm).toHaveBeenCalledWith(spawnedTemp(0), cleanupOptions);
    } finally {
      transport.spawnHelper = original;
    }
  });

  it('removes the helper directory after an asynchronous spawn failure without exit', async () => {
    const original = transport.spawnHelper;
    transport.spawnHelper = () => {
      const child = new FakeHelperChild();
      Object.defineProperty(child, 'pid', { value: undefined });
      child.kill = () => false;
      children.push(child);
      queueMicrotask(() => child.emit('error', new Error('synthetic spawn failure')));
      return child;
    };
    try {
      const { addon } = createTarget();
      await expect(discoverRows(addon)).rejects.toThrow('PID is unavailable');
      expect(spawnedTemp(0)).toEqual(expect.any(String));
      expect(rm).toHaveBeenCalledWith(spawnedTemp(0), cleanupOptions);
    } finally {
      transport.spawnHelper = original;
    }
  });

  it('removes the helper directory after attestation failure kills the helper', async () => {
    const { addon } = createTarget();
    transport.attestation = '{}';
    await expect(discoverRows(addon)).rejects.toThrow();
    expect(children[0]!.killed).toBe(true);
    expect(spawnedTemp(0)).toEqual(expect.any(String));
    expect(rm).toHaveBeenCalledWith(spawnedTemp(0), cleanupOptions);
  });

  it('keeps a running helper directory on error until exit', async () => {
    const { addon } = createTarget();
    await discoverRows(addon);
    children[0]!.emit('error', new Error('synthetic helper error'));
    expect(rm).not.toHaveBeenCalled();
    children[0]!.emit('exit', 1, null);
    expect(rm).toHaveBeenCalledWith(spawnedTemp(0), cleanupOptions);
  });

  it.each(['attestation', 'pipe'] as const)(
    'waits for exit after %s failure before removing the helper directory',
    async (failure) => {
      const originalSpawn = transport.spawnHelper;
      const originalConnect = transport.connectPipe;
      const child = new FakeHelperChild();
      child.kill = () => {
        child.killed = true;
        return true;
      };
      transport.spawnHelper = () => {
        children.push(child);
        return child;
      };
      if (failure === 'attestation') transport.attestation = '{}';
      else
        transport.connectPipe = () => {
          throw new Error('synthetic pipe failure');
        };
      try {
        const { addon } = createTarget();
        const rejected = expect(discoverRows(addon)).rejects.toThrow(
          failure === 'pipe' ? 'pipe connection failed' : /attestation/u,
        );
        await vi.advanceTimersByTimeAsync(5_000);
        await rejected;
        expect(child.killed).toBe(true);
        expect(rm).not.toHaveBeenCalled();
        child.emit('exit', 1, null);
        expect(rm).toHaveBeenCalledExactlyOnceWith(spawnedTemp(0), cleanupOptions);
      } finally {
        transport.spawnHelper = originalSpawn;
        transport.connectPipe = originalConnect;
      }
    },
  );

  // Current behavior baseline, to be replaced by kill-stop (N3).
  describe('kill-stop (N3) replacement baseline for current Stop timing', () => {
    // The cancel budget is private; read its declaration without changing production exports.
    const cancelDeclaration = /const COMPUTER_USE_NATIVE_CANCEL_ACK_TIMEOUT_MS = ([\d_]+);/u.exec(
      readFileSync(join(__dirname, 'computer-use-native-host.ts'), 'utf8'),
    );
    if (cancelDeclaration === null) throw new Error('Native cancel deadline declaration missing');
    const COMPUTER_USE_NATIVE_CANCEL_ACK_TIMEOUT_MS = Number(
      cancelDeclaration[1]!.replaceAll('_', ''),
    );
    const stopAt =
      COMPUTER_USE_NATIVE_CANCEL_ACK_TIMEOUT_MS +
      COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS * COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT;
    const killAt =
      COMPUTER_USE_NATIVE_CANCEL_ACK_TIMEOUT_MS +
      COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS * (COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT - 1) +
      COMPUTER_USE_NATIVE_CLOSE_TRANSPORT_TIMEOUT_MS;

    async function startController(controller: ComputerUseController) {
      const [candidate] = await controller.listWindows(profile.id);
      return controller.start({
        taskId: 'task-baseline',
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
      });
    }

    function recordRequests() {
      const sent: Array<{ operation: string; at: number }> = [];
      const socket = sockets[0]!;
      const write = socket.write.bind(socket);
      const origin = Date.now();
      vi.spyOn(socket, 'write').mockImplementation((chunk, callback) => {
        const frame = decodeComputerUseNativeFrame(chunk);
        const metadata = JSON.parse(frame.metadata.toString('utf8')) as Record<string, unknown>;
        sent.push({ operation: String(metadata['operation']), at: Date.now() - origin });
        return write(chunk, callback);
      });
      return sent;
    }

    it('stops at the Host deadline and kills only at the last close transport deadline', async () => {
      const { host, helper } = createTarget();
      const controller = controllerFor(host);
      const session = await startController(controller);
      const statuses: Array<{ state: string; stopReason: string | null }> = [];
      controller.subscribe((status) => statuses.push(status));
      helper().hold('cancel');
      const sent = recordRequests();
      let settled = false;
      const stopping = controller.stopForTask('task-baseline', 'task_changed').then(() => {
        settled = true;
      });
      let elapsed = 0;
      const advanceTo = async (at: number) => {
        if (at <= elapsed) throw new Error(`Expected time ${at} to be after ${elapsed}`);
        await vi.advanceTimersByTimeAsync(at - elapsed);
        elapsed = at;
      };
      await advanceTo(COMPUTER_USE_NATIVE_CANCEL_ACK_TIMEOUT_MS - 1);
      expect(sent).toEqual([{ operation: 'cancel', at: 0 }]);
      for (let attempt = 0; attempt < COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT; attempt += 1) {
        const at =
          COMPUTER_USE_NATIVE_CANCEL_ACK_TIMEOUT_MS +
          attempt * COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS;
        if (attempt > 0) await advanceTo(at - 1);
        expect(sent.filter((request) => request.operation === 'close_session')).toHaveLength(
          attempt,
        );
        await advanceTo(at);
        expect(sent.at(-1)).toEqual({ operation: 'close_session', at });
        if (attempt === 0) {
          // The cancel transport deadline falls between the first and second close attempts.
          await advanceTo(operationTimeoutMilliseconds('cancel') - 1);
          expect(children[0]!.killed).toBe(false);
          await advanceTo(operationTimeoutMilliseconds('cancel'));
          expect(children[0]!.killed).toBe(false);
        }
      }
      await advanceTo(stopAt - 1);
      expect(settled).toBe(false);
      expect(controller.getStatus(session.sessionId)?.state).toBe('stopping');
      await advanceTo(stopAt);
      expect(settled).toBe(true);
      await stopping;
      expect(statuses.at(-1)).toMatchObject({ state: 'stopped', stopReason: 'native_unavailable' });
      expect(host.availability()).toMatchObject({ reasonCode: 'native_stop_unconfirmed' });
      const firstCloseTimeout =
        COMPUTER_USE_NATIVE_CANCEL_ACK_TIMEOUT_MS + COMPUTER_USE_NATIVE_CLOSE_TRANSPORT_TIMEOUT_MS;
      // Host Stop settles before the first close transport deadline, which precedes the last.
      await advanceTo(firstCloseTimeout - 1);
      expect(children[0]!.killed).toBe(false);
      await advanceTo(firstCloseTimeout);
      expect(children[0]!.killed).toBe(false);
      await advanceTo(killAt - 1);
      expect(children[0]!.killed).toBe(false);
      await advanceTo(killAt);
      expect(children[0]!.killed).toBe(true);
      expect(sent).toEqual([
        { operation: 'cancel', at: 0 },
        ...Array.from({ length: COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT }, (_, attempt) => ({
          operation: 'close_session',
          at:
            COMPUTER_USE_NATIVE_CANCEL_ACK_TIMEOUT_MS +
            attempt * COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS,
        })),
      ]);
      await controller.dispose();
    });

    it.each(['semantic', 'discovery'] as const)(
      'retains the helper beyond the kill deadline for unconfirmed %s',
      async (kind) => {
        const { addon, host, helper } = createTarget({
          ...responders(),
          dispatch: () => ['error', { code: 'semantic_input_in_flight', accepted: true }],
        });
        const controller = controllerFor(host);
        const session = await startController(controller);
        let discovery: Promise<unknown> | undefined;
        if (kind === 'semantic') {
          await expect(
            Promise.resolve(
              addon.dispatch!({
                sessionId: session.sessionId,
                requestId: 'baseline-semantic',
                cancelEpoch: 0,
                type: 'invoke',
                targetId: 'owned-control',
              }),
            ),
          ).rejects.toMatchObject({ code: 'semantic_input_in_flight', accepted: true });
        } else {
          helper().holdOnly('list_windows_cancellable');
          discovery = Promise.resolve(
            addon.discoverWindows!({
              ...profile,
              discoveryId: 'baseline-unconfirmed',
            }),
          ).catch((error: Error) => error);
          await vi.advanceTimersByTimeAsync(0);
        }
        helper().hold('cancel');
        const sent = recordRequests();
        const stopping = controller.stopForTask('task-baseline', 'task_changed');
        await vi.advanceTimersByTimeAsync(stopAt);
        await stopping;
        expect(host.availability()).toMatchObject({ reasonCode: 'native_stop_unconfirmed' });
        await vi.advanceTimersByTimeAsync(killAt - stopAt - 1);
        expect(children[0]!.killed).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(children[0]!.killed).toBe(false);
        await vi.advanceTimersByTimeAsync(killAt * 2);
        expect(children[0]!.killed).toBe(false);
        expect(sent.filter((request) => request.operation === 'close_session')).toHaveLength(
          COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT,
        );
        if (discovery !== undefined) expect(await discovery).toBeInstanceOf(Error);
        await controller.dispose();
      },
    );

    it('bounds pending-start Stop by both Host attempts and the final transport deadline', async () => {
      const { host, helper } = createTarget();
      const controller = controllerFor(host);
      await controller.listWindows(profile.id);
      helper().hold('start_session');
      const starting = startController(controller).catch((error: Error) => error);
      await vi.advanceTimersByTimeAsync(0);
      const statuses: Array<{ state: string; stopReason: string | null }> = [];
      controller.subscribe((status) => statuses.push(status));
      const sent = recordRequests();
      let settled = false;
      const stopping = controller.stopForTask('task-baseline', 'task_changed').then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      for (let attempt = 0; attempt < COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT; attempt += 1) {
        expect(sent).toHaveLength(attempt + 1);
        expect(sent.at(-1)).toEqual({
          operation: 'stop_pending_start',
          at: attempt * COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS,
        });
        await vi.advanceTimersByTimeAsync(COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS - 1);
        expect(sent).toHaveLength(attempt + 1);
        expect(settled).toBe(false);
        expect(statuses.at(-1)?.state).toBe('stopping');
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(settled).toBe(true);
      await stopping;
      expect(await starting).toBeInstanceOf(Error);
      expect(statuses.at(-1)).toMatchObject({ state: 'stopped', stopReason: 'native_unavailable' });
      expect(host.availability()).toMatchObject({ reasonCode: 'native_stop_unconfirmed' });
      const pendingStopAt =
        COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS * COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT;
      // The timed-out start waits for the initial Stop, then rechecks with the same bounded
      // Host retry loop. The last recheck's wire Stop owns the transport kill deadline.
      // The start transport deadline is no later than pendingStopAt, so the first recheck is sent now.
      const recheckAt = Math.max(operationTimeoutMilliseconds('start_session'), pendingStopAt);
      const lastRecheckAt =
        recheckAt +
        COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS * (COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT - 1);
      const pendingKillAt = lastRecheckAt + COMPUTER_USE_NATIVE_CLOSE_TRANSPORT_TIMEOUT_MS;
      expect(sent).toEqual(
        Array.from({ length: COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT + 1 }, (_, attempt) => ({
          operation: 'stop_pending_start',
          at:
            attempt === COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT
              ? recheckAt
              : attempt * COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS,
        })),
      );
      let elapsed = pendingStopAt;
      const advanceTo = async (at: number) => {
        if (at <= elapsed) throw new Error(`Expected time ${at} to be after ${elapsed}`);
        await vi.advanceTimersByTimeAsync(at - elapsed);
        elapsed = at;
      };
      for (let attempt = 1; attempt < COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT; attempt += 1) {
        const at = recheckAt + attempt * COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS;
        await advanceTo(at - 1);
        expect(sent).toHaveLength(COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT + attempt);
        expect(children[0]!.killed).toBe(false);
        await advanceTo(at);
        expect(sent).toHaveLength(COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT + attempt + 1);
        expect(sent.at(-1)).toEqual({ operation: 'stop_pending_start', at });
        expect(children[0]!.killed).toBe(false);
      }
      // Earlier wire timeouts cannot reap the helper while the final recheck is pending.
      for (const request of sent.slice(0, -1)) {
        const timeoutAt = request.at + COMPUTER_USE_NATIVE_CLOSE_TRANSPORT_TIMEOUT_MS;
        if (timeoutAt <= elapsed) continue;
        await advanceTo(timeoutAt - 1);
        expect(children[0]!.killed).toBe(false);
        await advanceTo(timeoutAt);
        expect(children[0]!.killed).toBe(false);
      }
      await advanceTo(pendingKillAt - 1);
      expect(children[0]!.killed).toBe(false);
      await advanceTo(pendingKillAt);
      expect(sent).toHaveLength(COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT * 2);
      expect(children[0]!.killed).toBe(true);
      await controller.dispose();
    });
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

    it('recovers capacity after twenty cancellations during handshake preparation', async () => {
      const { host, helper } = createTarget(discoveryResponders(), (helper) =>
        helper.holdOnly('handshake'),
      );
      for (let index = 0; index < 20; index += 1) {
        const discovery = host.beginWindowDiscovery!(profile);
        const result = discovery.result.catch((error: Error) => error.message);
        await vi.advanceTimersByTimeAsync(0);
        expect(children).toHaveLength(index + 1);
        await expect(discovery.stop()).resolves.toEqual({ kind: 'not_submitted' });
        helper().release('handshake');
        await vi.advanceTimersByTimeAsync(0);
        expect(await result).toMatch(/canceled/u);
        expect(helper().served).not.toContain('list_windows_cancellable');
        expect(host.availability().control).toBe(true);
        sockets.at(-1)!.destroy();
      }
      const fresh = host.beginWindowDiscovery!(profile);
      await vi.advanceTimersByTimeAsync(0);
      helper().release('handshake');
      await expect(fresh.result).resolves.toHaveLength(1);
    });

    it('recovers capacity after repeated locally proven handshake capability refusals', async () => {
      let supported = false;
      const { host } = createTarget({
        ...discoveryResponders(),
        handshake: () => [
          'handshake_result',
          {
            protocolVersion: 1,
            apiVersion: 3,
            platform: 'win32',
            napiVersion: 10,
            sourceCommit,
            capabilities: { cancellableWindowDiscovery: supported },
          },
        ],
      });
      for (let index = 0; index < 20; index += 1) {
        await expect(host.listWindows(profile)).rejects.toThrow('handshake capability');
        expect(host.availability().control).toBe(true);
      }
      supported = true;
      sockets.at(-1)!.destroy();
      await expect(host.listWindows(profile)).resolves.toHaveLength(1);
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

    it.each(['completed', 'stopped'] as const)(
      'remembers session teardown while discovery is pending until it is %s',
      async (terminal) => {
        const { addon, helper } = createTarget(discoveryResponders());
        await addon.startSession!({ sessionId: 'closing-with-discovery', profile });
        helper().holdOnly('list_windows_cancellable');
        const query = addon.discoverWindows!(input('close-during-discovery'));
        await vi.advanceTimersByTimeAsync(0);
        await addon.close!({ sessionId: 'closing-with-discovery', cancelEpoch: 1 });
        expect(children[0]!.killed).toBe(false);
        if (terminal === 'stopped') {
          await addon.stopWindowDiscovery!({ discoveryId: 'close-during-discovery' });
          // The original query still owns a pending transport response.
          expect(children[0]!.killed).toBe(false);
        }
        helper().release('list_windows_cancellable');
        await query;
        await vi.advanceTimersByTimeAsync(0);
        expect(children[0]!.killed).toBe(true);
        expect(sockets[0]!.destroyed).toBe(true);
      },
    );

    it('disarms deferred discovery teardown when a newer session starts', async () => {
      const { addon, helper } = createTarget(discoveryResponders());
      await addon.startSession!({ sessionId: 'older-session', profile });
      helper().holdOnly('list_windows_cancellable');
      const query = addon.discoverWindows!(input('overlapping-discovery'));
      await vi.advanceTimersByTimeAsync(0);
      await addon.close!({ sessionId: 'older-session', cancelEpoch: 1 });
      await addon.startSession!({ sessionId: 'newer-session', profile });
      helper().release('list_windows_cancellable');
      await query;
      await vi.advanceTimersByTimeAsync(0);
      expect(children[0]!.killed).toBe(false);
      await addon.close!({ sessionId: 'newer-session', cancelEpoch: 1 });
      await vi.advanceTimersByTimeAsync(0);
      expect(children[0]!.killed).toBe(true);
    });

    it('does not pin a new helper idle lifetime with an unconfirmed old-generation discovery', async () => {
      const { addon, helper } = createTarget(discoveryResponders(), (helper) =>
        helper.holdOnly('list_windows_cancellable'),
      );
      const lost = Promise.resolve(addon.discoverWindows!(input('lost-generation'))).catch(
        () => 'lost',
      );
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]!.destroy();
      await expect(lost).resolves.toBe('lost');
      await expect(addon.stopWindowDiscovery!({ discoveryId: 'lost-generation' })).rejects.toThrow(
        'generation',
      );
      await addon.startSession!({ sessionId: 'fresh-generation', profile });
      expect(children).toHaveLength(2);
      await addon.close!({ sessionId: 'fresh-generation', cancelEpoch: 1 });
      await vi.advanceTimersByTimeAsync(0);
      expect(children[1]!.killed).toBe(true);
      await expect(addon.stopWindowDiscovery!({ discoveryId: 'lost-generation' })).rejects.toThrow(
        'generation',
      );
      expect(helper().served).not.toContain('stop_window_discovery');
    });

    it('retains an unconfirmed launch owner through session Stop timeouts and recovers only on receipts', async () => {
      const { host, helper } = createTarget();
      const session = await startSession(host, 'active-before-discovery', 'turn-1');
      helper().holdOnly('list_windows_cancellable');
      helper().holdOnly('stop_window_discovery');
      helper().holdOnly('close_session');
      const discovery = host.beginWindowDiscovery!(profile);
      const query = discovery.result.catch((error: Error) => error.message);
      await vi.advanceTimersByTimeAsync(0);
      const discoveryStop = discovery.stop().catch((error: Error) => error.message);
      const close = host.close(session).then(
        () => 'closed',
        (error: Error) => error.message,
      );
      await vi.advanceTimersByTimeAsync(90_000);
      expect(await discoveryStop).toMatch(/unconfirmed/u);
      expect(await close).toMatch(/unconfirmed/u);
      expect(await query).toMatch(/unconfirmed/u);
      expect(children[0]!.killed).toBe(false);
      const before = helper().served.length;
      await expect(host.observe(session, { requestId: 'blocked', cancelEpoch: 0 })).rejects.toThrow(
        /unconfirmed/u,
      );
      expect(helper().served).toHaveLength(before);
      helper().release('stop_window_discovery');
      helper().release('close_session');
      await discovery.stop();
      await host.close(session);
      expect(host.availability().control).toBe(true);
      helper().release('list_windows_cancellable');
    });

    it('keeps late Stop proof after Main deadlines even when session close then exits the helper', async () => {
      const { host, helper } = createTarget();
      const session = await startSession(host, 'late-stop-session', 'turn-1');
      helper().holdOnly('list_windows_cancellable');
      helper().holdOnly('stop_window_discovery');
      const discovery = host.beginWindowDiscovery!(profile);
      const query = discovery.result.catch((error: Error) => error.message);
      await vi.advanceTimersByTimeAsync(0);
      const stopping = discovery.stop().catch((error: Error) => error.message);
      helper().refuse('list_windows_cancellable');
      helper().release('list_windows_cancellable');
      await vi.advanceTimersByTimeAsync(20_001);
      expect(await stopping).toMatch(/unconfirmed/u);
      expect(await query).toMatch(/unconfirmed/u);
      expect(host.availability().control).toBe(false);
      expect(children[0]!.killed).toBe(false);
      helper().release('stop_window_discovery');
      await vi.advanceTimersByTimeAsync(0);
      expect(host.availability().control).toBe(true);
      await expect(discovery.terminal).resolves.toMatchObject({ kind: 'stopped' });
      await host.close(session);
      await vi.advanceTimersByTimeAsync(0);
      expect(children[0]!.killed).toBe(true);
      await expect(discovery.stop()).resolves.toMatchObject({ kind: 'stopped' });
      expect(
        helper().served.filter((operation) => operation === 'stop_window_discovery'),
      ).toHaveLength(2);
      expect(children).toHaveLength(1);
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

  it.each([false, undefined, true])(
    'gates node reads on each pipe artifactRead attest: %s',
    async (artifactRead) => {
      let claim: boolean | undefined = true;
      const { addon, helper } = createTarget({
        ...responders(),
        handshake: () => [
          'handshake_result',
          {
            protocolVersion: 1,
            apiVersion: 3,
            platform: 'win32',
            napiVersion: 10,
            sourceCommit,
            capabilities: {
              cancellableWindowDiscovery: true,
              ...(claim === undefined ? {} : { artifactRead: claim }),
            },
          },
        ],
        read_node_value: () => ['probe_result', { ok: true, text: 'Synthetic value' }],
      });
      await expect(
        addon.readNodeValue!({ sessionId: 'artifact-session', requestId: 'first-read' }),
      ).resolves.toEqual({ ok: true, text: 'Synthetic value' });
      sockets.at(-1)!.emit('close');
      claim = artifactRead;
      await expect(
        addon.readNodeValue!({ sessionId: 'artifact-session', requestId: 'artifact-read' }),
      ).resolves.toEqual(
        artifactRead === true ? { ok: true, text: 'Synthetic value' } : { ok: false },
      );
      expect(helper().served).toEqual(
        artifactRead === true ? ['handshake', 'read_node_value'] : ['handshake'],
      );
    },
  );

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

  it.each(['semantic_input_in_flight', 'ticket_invalid', 'session_missing'])(
    'keeps a semantic pre-input rejection usable: %s',
    async (code) => {
      const { addon, host } = createTarget({
        ...responders(),
        dispatch: () => ['error', { result: 'rejected', code, accepted: false }],
      });
      const session = await startSession(host, 'semantic-pre-input', 'turn-1');
      await expect(
        Promise.resolve(
          addon.dispatch!({
            sessionId: session.sessionId,
            requestId: 'semantic-pre-input-dispatch',
            cancelEpoch: 0,
            type: 'invoke',
            targetId: 'owned-control',
          }),
        ),
      ).rejects.toMatchObject({ code, accepted: false });
      expect(addon.hasUnconfirmedSemanticInputs!()).toBe(false);
      expect(host.availability()).toMatchObject({ state: 'ready', control: true });
      expect(children[0]!.killed).toBe(false);
      await expect(host.close(session)).resolves.toBeUndefined();
    },
  );

  it.each(['completion', 'timeout'] as const)(
    'retains a pending semantic input when a queued read times out before its %s',
    async (ending) => {
      const { addon, host, helper } = createTarget({
        ...responders(),
        dispatch: (metadata) => [
          'dispatch_result',
          {
            result: 'completed',
            reasonCode: null,
            sessionId: metadata['sessionId'],
            cancelEpoch: metadata['cancelEpoch'],
            inputAttemptCount: 1,
          },
        ],
        read_node_value: () => ['probe_result', { ok: false }],
        close_session: (metadata) => [
          'probe_result',
          {
            result: 'closed',
            drained: true,
            sessionId: metadata['sessionId'],
            cancelEpoch: metadata['cancelEpoch'],
            inputAttemptCount: 1,
          },
        ],
      });
      const session = await startSession(host, 'semantic-pending-read', 'turn-1');
      helper().hold('dispatch');
      const dispatch = Promise.resolve(
        addon.dispatch!({
          sessionId: session.sessionId,
          requestId: 'pending-semantic',
          cancelEpoch: 0,
          type: 'invoke',
          targetId: 'owned-control',
        }),
      ).then(
        () => 'completed',
        () => 'unconfirmed',
      );
      await vi.advanceTimersByTimeAsync(0);
      const read = Promise.resolve(
        addon.readNodeValue!({
          sessionId: session.sessionId,
          requestId: 'queued-read',
        }),
      ).then(
        () => 'read',
        () => 'timed-out',
      );
      await vi.advanceTimersByTimeAsync(5_001);
      expect(await read).toBe('timed-out');
      expect(children[0]!.killed).toBe(false);
      expect(sockets[0]!.destroyed).toBe(false);
      if (ending === 'timeout') {
        await vi.advanceTimersByTimeAsync(5_000);
        expect(await dispatch).toBe('unconfirmed');
        expect(addon.hasUnconfirmedSemanticInputs!()).toBe(true);
      }
      helper().release('dispatch');
      expect(await dispatch).toBe(ending === 'timeout' ? 'unconfirmed' : 'completed');
      await expect(host.close(session)).resolves.toBeUndefined();
      expect(children).toHaveLength(1);
      expect(children[0]!.killed).toBe(true);
      expect(host.availability()).toMatchObject({ state: 'ready', control: true });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'retains the actual public dispatch error before a separately delivered Stop refusal',
    async () => {
      const native = readWindowsHostSource();
      const start = native.indexOf(
        '} else if (kind == "invoke"',
        native.indexOf('bool DispatchWindowsAction('),
      );
      const end = native.indexOf('\nBackendProbe ProbeBackend()', start);
      const errorStart = native.indexOf('std::string ErrorPayload(');
      const errorEnd = native.indexOf('\nbool Respond(', errorStart);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      expect(errorEnd).toBeGreaterThan(errorStart);
      const root = mkdtempSync(join(tmpdir(), 'semantic-dispatch-wire-'));
      let payload: unknown;
      try {
        const actual = await vi.importActual<typeof NodeChildProcess>('node:child_process');
        const path = join(root, 'dispatch.cc');
        const binary = join(root, 'dispatch');
        writeFileSync(
          path,
          `
#include <atomic>
#include <cstdint>
#include <iostream>
#include <string>
#include <string_view>
struct WindowsSession {};
struct RECT {};
std::atomic<std::uint64_t> cancellation_epoch{0};
bool DispatchWindowsSemanticAction(const WindowsSession&, const RECT&, std::uint64_t,
    const std::string&, const std::string&, bool* accepted, std::string* reason) {
  *accepted = true; *reason = "semantic_input_in_flight"; return false;
}
bool RevalidateWindowsTarget(const WindowsSession&, const RECT&, std::uint64_t) { return true; }
bool PublicDispatch(std::string* result, std::string* reason, bool* accepted) {
  WindowsSession session; RECT bounds; std::uint64_t expected_epoch = 0;
  std::string kind = "invoke", metadata = "{}"; bool dispatched = false;
  ${native.slice(start + '} else '.length, end)}
${native.slice(errorStart, errorEnd)}
int main() {
  std::string result, reason; bool accepted = false;
  if (PublicDispatch(&result, &reason, &accepted)) return 1;
  std::cout << ErrorPayload(reason, accepted);
}
`,
        );
        actual.execFileSync(
          'clang++',
          ['-std=c++20', '-Wall', '-Wextra', '-Werror', path, '-o', binary],
          { timeout: 30_000 },
        );
        payload = JSON.parse(
          actual.execFileSync(binary, [], { encoding: 'utf8', timeout: 5_000 }),
        ) as unknown;
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
      const { addon, host, helper } = createTarget({
        ...responders(),
        dispatch: () => ['error', payload],
        close_session: (metadata) => [
          'probe_result',
          {
            result: 'closed',
            drained: true,
            sessionId: metadata['sessionId'],
            cancelEpoch: metadata['cancelEpoch'],
            inputAttemptCount: 1,
          },
        ],
      });
      const session = await startSession(host, 'public-semantic-wire', 'turn-1');
      await expect(
        Promise.resolve(
          addon.dispatch!({
            sessionId: session.sessionId,
            requestId: 'public-semantic-input',
            cancelEpoch: 0,
            type: 'invoke',
            targetId: 'owned-control',
          }),
        ),
      ).rejects.toMatchObject({ code: 'semantic_input_in_flight', accepted: true });
      // Let call().finally run before a later Stop response is delivered.
      await vi.advanceTimersByTimeAsync(0);
      expect(addon.hasUnconfirmedSemanticInputs!()).toBe(true);
      helper().refuse('close_session');
      await expect(host.close(session)).rejects.toThrow('native_stop_unconfirmed');
      expect(children[0]!.killed).toBe(false);
      helper().allow('close_session');
      await expect(host.close(session)).resolves.toBeUndefined();
      expect(children).toHaveLength(1);
      expect(host.availability()).toMatchObject({ state: 'ready', control: true });
    },
    60_000,
  );

  it.each(['native-error', 'timeout'] as const)(
    'retains an unconfirmed semantic input on the same helper after %s until Host confirms close',
    async (ending) => {
      let inFlight = true;
      const { addon, host, helper } = createTarget({
        ...responders(),
        dispatch: (metadata) =>
          ending === 'native-error'
            ? ['error', { code: 'semantic_input_in_flight', accepted: true }]
            : [
                'dispatch_result',
                {
                  result: 'completed',
                  reasonCode: null,
                  sessionId: metadata['sessionId'],
                  cancelEpoch: metadata['cancelEpoch'],
                  inputAttemptCount: 1,
                },
              ],
        check_target_identity: () => ['target_identity_result', { results: [{ result: 'alive' }] }],
        close_session: (metadata) =>
          inFlight
            ? ['error', { code: 'semantic_input_in_flight', accepted: false }]
            : [
                'probe_result',
                {
                  result: 'closed',
                  drained: true,
                  sessionId: metadata['sessionId'],
                  cancelEpoch: metadata['cancelEpoch'],
                  inputAttemptCount: 1,
                },
              ],
      });
      const session = await startSession(host, 'semantic-owner', 'turn-1');
      if (ending === 'timeout') helper().holdOnly('dispatch');
      const dispatched = Promise.resolve(
        addon.dispatch!({
          sessionId: session.sessionId,
          requestId: 'semantic-request',
          cancelEpoch: 0,
          type: 'invoke',
          targetId: 'owned-control',
        }),
      ).then(
        () => 'completed',
        () => 'unconfirmed',
      );
      await vi.advanceTimersByTimeAsync(ending === 'timeout' ? 10_001 : 0);
      expect(await dispatched).toBe('unconfirmed');
      expect(host.availability()).toMatchObject({ reasonCode: 'native_stop_unconfirmed' });
      await expect(addon.checkTargetIdentity(identityTargets)).resolves.toEqual([
        { result: 'alive' },
      ]);
      expect(helper().served).toContain('check_target_identity');
      expect(host.availability()).toMatchObject({ reasonCode: 'native_stop_unconfirmed' });
      if (ending === 'native-error') {
        const closing = host.close(session).then(
          () => 'closed',
          () => 'unconfirmed',
        );
        await vi.advanceTimersByTimeAsync(COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS);
        expect(await closing).toBe('unconfirmed');
      }
      // An error/timeout is not proof that an already claimed native input has returned.
      expect(children).toHaveLength(1);
      expect(children[0]!.killed).toBe(false);
      expect(sockets[0]!.destroyed).toBe(false);
      if (ending === 'timeout') {
        const closing = host.close(session).then(
          () => 'closed',
          () => 'unconfirmed',
        );
        await vi.advanceTimersByTimeAsync(COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS);
        expect(await closing).toBe('unconfirmed');
      }
      expect(host.availability()).toMatchObject({ reasonCode: 'native_stop_unconfirmed' });
      const closeCalls = helper().served.filter(
        (operation) => operation === 'close_session',
      ).length;
      await vi.advanceTimersByTimeAsync(250);
      expect(helper().served.filter((operation) => operation === 'close_session')).toHaveLength(
        closeCalls,
      );
      inFlight = false;
      if (ending === 'timeout') {
        helper().release('dispatch');
        await vi.advanceTimersByTimeAsync(0);
        // A late dispatch result must not replace the Host's session-bound close proof.
        expect(children[0]!.killed).toBe(false);
        expect(host.availability()).toMatchObject({ reasonCode: 'native_stop_unconfirmed' });
      }
      await expect(host.close(session)).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(0);
      expect(children).toHaveLength(1);
      expect(children[0]!.killed).toBe(true);
      expect(host.availability()).toMatchObject({ state: 'ready', control: true });
    },
  );

  it.each(['json', 'error-shape', 'completion-shape', 'completion-owner', 'frame-type'] as const)(
    'retains semantic uncertainty after a %s response loses the helper',
    async (fault) => {
      const { addon, host } = createTarget();
      const session = await startSession(host, 'semantic-corrupt', 'turn-1');
      const socket = sockets[0]!;
      socket.onWrite = (encoded) => {
        const request = decodeComputerUseNativeFrame(encoded);
        const complete = {
          result: 'completed',
          reasonCode: null,
          sessionId: session.sessionId,
          cancelEpoch: 0,
          inputAttemptCount: 1,
        };
        const body =
          fault === 'json'
            ? '{'
            : JSON.stringify(
                fault === 'error-shape'
                  ? { code: 'semantic_input_in_flight' }
                  : fault === 'completion-shape'
                    ? { result: 'completed' }
                    : fault === 'completion-owner'
                      ? { ...complete, sessionId: 'other-owner' }
                      : complete,
              );
        socket.emit(
          'data',
          encodeComputerUseNativeFrame({
            ...request,
            messageType:
              fault === 'error-shape'
                ? 'error'
                : fault === 'frame-type'
                  ? 'probe_result'
                  : 'dispatch_result',
            metadata: Buffer.from(body),
            binary: Buffer.alloc(0),
          }),
        );
      };
      await expect(
        Promise.resolve(
          addon.dispatch!({
            sessionId: session.sessionId,
            requestId: 'semantic-corrupt-input',
            cancelEpoch: 0,
            type: 'invoke',
            targetId: 'owned-control',
          }),
        ),
      ).rejects.toThrow();
      expect(children[0]!.killed).toBe(true);
      expect(host.availability()).toMatchObject({ reasonCode: 'native_stop_unconfirmed' });
      await expect(host.close(session)).rejects.toThrow('native_stop_unconfirmed');
      await expect(startSession(host, 'next-session', 'turn-2')).rejects.toThrow();
      expect(children).toHaveLength(1);
    },
  );

  it('does not consume a semantic close candidate for forged evidence or different receipt fields', async () => {
    const { addon, host } = createTarget({
      ...responders(),
      dispatch: () => ['error', { code: 'semantic_input_in_flight', accepted: true }],
      close_session: (metadata) => [
        'probe_result',
        {
          result: 'closed',
          drained: true,
          sessionId: metadata['sessionId'],
          cancelEpoch: metadata['cancelEpoch'],
          inputAttemptCount: 1,
        },
      ],
    });
    const session = await startSession(host, 'semantic-proof', 'turn-1');
    await expect(
      Promise.resolve(
        addon.dispatch!({
          sessionId: session.sessionId,
          requestId: 'semantic-proof-input',
          cancelEpoch: 0,
          type: 'invoke',
          targetId: 'owned-control',
        }),
      ),
    ).rejects.toThrow('semantic_input_in_flight');
    const evidence = await addon.close!({ sessionId: session.sessionId, cancelEpoch: 1 });
    const receipt = { sessionId: session.sessionId, cancelEpoch: 1, inputAttemptCount: 1 };
    expect(() =>
      addon.confirmSessionClosed!(receipt, { ...receipt, result: 'closed', drained: true }),
    ).toThrow('native_stop_unconfirmed');
    expect(() =>
      addon.confirmSessionClosed!({ ...receipt, inputAttemptCount: 0 }, evidence),
    ).toThrow('native_stop_unconfirmed');
    addon.confirmSessionClosed!({ ...receipt, sessionId: 'other-owner' }, evidence);
    expect(children[0]!.killed).toBe(false);
    expect(host.availability()).toMatchObject({ reasonCode: 'native_stop_unconfirmed' });
    await expect(host.close(session)).resolves.toBeUndefined();
    expect(host.availability()).toMatchObject({ state: 'ready', control: true });
    expect(children[0]!.killed).toBe(true);
  });

  it('retries a failed Host confirmation with its older received proof after another close reply', async () => {
    const { addon, helper } = createTarget({
      ...responders(),
      dispatch: () => ['error', { code: 'semantic_input_in_flight', accepted: true }],
      stop_pending_start: (metadata) => [
        'probe_result',
        {
          result: 'closed',
          drained: true,
          sessionId: metadata['sessionId'],
          cancelEpoch: 1,
          inputAttemptCount: 1,
        },
      ],
      close_session: (metadata) => [
        'probe_result',
        {
          result: 'closed',
          drained: true,
          sessionId: metadata['sessionId'],
          cancelEpoch: metadata['cancelEpoch'],
          inputAttemptCount: 1,
        },
      ],
    });
    let failConfirmation = true;
    const host = createComputerUseNativeHost(
      binding({
        ...addon,
        confirmSessionClosed(receipt, evidence) {
          if (failConfirmation) {
            failConfirmation = false;
            throw new Error('confirmation fault');
          }
          addon.confirmSessionClosed!(receipt, evidence);
        },
      }),
      'win32',
      { windowsPhysicalBoundsToDip: (value) => value },
    );
    const session = await startSession(host, 'semantic-cached-proof', 'turn-1');
    await expect(
      Promise.resolve(
        addon.dispatch!({
          sessionId: session.sessionId,
          requestId: 'semantic-cached-input',
          cancelEpoch: 0,
          type: 'invoke',
          targetId: 'owned-control',
        }),
      ),
    ).rejects.toThrow('semantic_input_in_flight');
    await expect(host.stopPendingStart!(session.sessionId)).rejects.toBeInstanceOf(
      ComputerUseNativeUnavailableError,
    );
    expect(host.availability()).toMatchObject({ reasonCode: 'native_stop_unconfirmed' });
    await addon.close!({ sessionId: session.sessionId, cancelEpoch: 2 });
    expect(children[0]!.killed).toBe(false);
    await expect(host.stopPendingStart!(session.sessionId)).resolves.toMatchObject({
      kind: 'closed',
      inputReceipt: { cancelEpoch: 1, inputAttemptCount: 1 },
    });
    expect(helper().served.filter((operation) => operation === 'stop_pending_start')).toHaveLength(
      1,
    );
    expect(host.availability()).toMatchObject({ state: 'ready', control: true });
    expect(children[0]!.killed).toBe(true);
  });

  it('waits within the original Stop deadline for a transient in-flight semantic operation', async () => {
    let inFlight = true;
    const { addon, host, helper } = createTarget({
      ...responders(),
      dispatch: () => ['error', { code: 'semantic_input_in_flight', accepted: true }],
      close_session: (metadata) =>
        inFlight
          ? ['error', { code: 'semantic_input_in_flight', accepted: false }]
          : [
              'probe_result',
              {
                result: 'closed',
                drained: true,
                sessionId: metadata['sessionId'],
                cancelEpoch: metadata['cancelEpoch'],
                inputAttemptCount: 1,
              },
            ],
    });
    const session = await startSession(host, 'semantic-transient', 'turn-1');
    await expect(
      Promise.resolve(
        addon.dispatch!({
          sessionId: session.sessionId,
          requestId: 'semantic-transient-input',
          cancelEpoch: 0,
          type: 'invoke',
          targetId: 'owned-control',
        }),
      ),
    ).rejects.toThrow('semantic_input_in_flight');
    const closing = host.close(session);
    await vi.advanceTimersByTimeAsync(125);
    expect(children[0]!.killed).toBe(false);
    inFlight = false;
    await vi.advanceTimersByTimeAsync(50);
    await expect(closing).resolves.toBeUndefined();
    expect(
      helper().served.filter((operation) => operation === 'close_session').length,
    ).toBeGreaterThan(1);
    expect(host.availability()).toMatchObject({ state: 'ready', control: true });
    expect(children[0]!.killed).toBe(true);
  });

  it('keeps a semantic owner reachable when Host rejects a decreasing input counter', async () => {
    let count = 4;
    const { addon, host } = createTarget({
      ...responders(),
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
          inputAttemptCount: 5,
        },
      ],
      dispatch: () => ['error', { code: 'semantic_input_in_flight', accepted: true }],
      close_session: (metadata) => [
        'probe_result',
        {
          result: 'closed',
          drained: true,
          sessionId: metadata['sessionId'],
          cancelEpoch: metadata['cancelEpoch'],
          inputAttemptCount: count,
        },
      ],
    });
    const session = await startSession(host, 'semantic-counter', 'turn-1');
    await expect(
      Promise.resolve(
        addon.dispatch!({
          sessionId: session.sessionId,
          requestId: 'semantic-counter-input',
          cancelEpoch: 0,
          type: 'invoke',
          targetId: 'owned-control',
        }),
      ),
    ).rejects.toThrow('semantic_input_in_flight');
    await expect(host.close(session)).rejects.toThrow();
    expect(children[0]!.killed).toBe(false);
    expect(host.availability()).toMatchObject({ reasonCode: 'native_stop_unconfirmed' });
    count = 6;
    await expect(host.close(session)).resolves.toBeUndefined();
    expect(children).toHaveLength(1);
    expect(children[0]!.killed).toBe(true);
    expect(host.availability()).toMatchObject({ state: 'ready', control: true });
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

  it.each([false, true])(
    'combines late discovery proof after active Close (semantic unknown=%s)',
    async (semanticUnknown) => {
      const { addon, host, helper } = createTarget(
        {
          ...responders(),
          dispatch: () => ['error', { code: 'semantic_input_in_flight', accepted: true }],
          close_session: (metadata) => [
            'probe_result',
            {
              result: 'closed',
              drained: true,
              sessionId: metadata['sessionId'],
              cancelEpoch: metadata['cancelEpoch'],
              inputAttemptCount: semanticUnknown ? 1 : 0,
            },
          ],
        },
        (helper) => helper.holdOnly('start_session'),
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
      if (semanticUnknown) {
        await expect(
          Promise.resolve(
            addon.dispatch!({
              sessionId: active.sessionId,
              requestId: 'coexisting-semantic',
              cancelEpoch: 0,
              type: 'invoke',
              targetId: 'owned-control',
            }),
          ),
        ).rejects.toThrow('semantic_input_in_flight');
        expect(addon.hasUnconfirmedSemanticInputs!()).toBe(true);
      }
      await host.cancel(active, 1);
      await expect(host.close(active)).rejects.toThrow(/unconfirmed/u);
      expect(host.availability().control).toBe(false);
      expect(helper().served).toContain('stop_window_discovery');
      helper().release('list_windows_cancellable');
      await expect(second).resolves.toBe('rejected');
      await vi.advanceTimersByTimeAsync(0);
      expect(host.availability().control).toBe(true);
      expect(helper().served.filter((op) => op === 'start_session')).toHaveLength(1);
    },
  );

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
  it('R18 ledger is persisted before the real transport sends and deleted after success', async () => {
    const rows = new Map<string, WindowsLedgerRow>();
    const order: string[] = [];
    let rowsAtSend = 0;
    const base = responders();
    const target = createTarget(
      {
        ...base,
        start_session: (metadata) => {
          const [type, result] = base['start_session']!(metadata);
          return [
            type,
            { ...(result as Record<string, unknown>), processStartTime: '133000000000000001' },
          ];
        },
        preflight: (metadata) => ['preflight_result', preflightReceipt(metadata)],
        dispatch: (metadata) => {
          order.push('send');
          rowsAtSend = rows.size;
          return [
            'dispatch_result',
            {
              result: 'completed',
              reasonCode: null,
              sessionId: metadata['sessionId'],
              cancelEpoch: 0,
              inputAttemptCount: 1,
            },
          ];
        },
      },
      undefined,
      {
        windowsLedger: {
          write: async (row) => {
            order.push('write');
            rows.set(row.requestId, row);
            return true;
          },
          update: async (row) => {
            rows.set(row.requestId, row);
            return true;
          },
          delete: async (row) => {
            order.push('delete');
            rows.delete(row.requestId);
            return true;
          },
        },
      },
    );
    const session = await startSession(target.host, 'session-1', 'turn-1');
    await expect(
      target.host.dispatch({
        session,
        requestId: 'ledger-1',
        action: { type: 'click', x: 0.5, y: 0.5, button: 'left' },
        observationRevision: 1,
        cancelEpoch: 0,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ result: 'completed' });
    expect(order).toEqual(['write', 'send', 'delete']);
    expect(rowsAtSend).toBe(1);
    expect(rows.size).toBe(0);
  });

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
  const ledgerActions = [
    { name: 'click', action: { type: 'click', x: 0.5, y: 0.5, button: 'left' }, kind: 'SendInput' },
    {
      name: 'scroll',
      action: { type: 'scroll', x: 0.5, y: 0.5, deltaX: 0, deltaY: 1 },
      kind: 'SendInput',
    },
    { name: 'key', action: { type: 'key', key: 'Enter' }, kind: 'SendInput' },
    { name: 'type', action: { type: 'type', text: 'x' }, kind: 'SendInput' },
    {
      name: 'semantic',
      action: { type: 'set_text', targetId: 'node-1', text: 'x' },
      kind: 'semantic',
    },
    { name: 'paste', action: { type: 'type', text: 'x' }, kind: 'paste' },
  ] as const;
  it('default-off dispatch settles without an extra async storage wrapper', async () => {
    const target = createTarget({
      ...responders(),
      dispatch: () => ['dispatch_result', { result: 'completed' }],
    });
    await startSession(target.host, 'session-1', 'turn-1');
    let settled = false;
    const result = Promise.resolve(
      target.addon.dispatch!({
        sessionId: 'session-1',
        requestId: 'direct',
        type: 'click',
        cancelEpoch: 0,
      }),
    ).then(() => {
      settled = true;
    });
    // Connection, fake socket delivery, response, caller: the pre-ledger path's turns.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const settledWithoutWrapper = settled;
    await result;
    expect(settledWithoutWrapper).toBe(true);
  });
  // The storage key is the ledger row key: (helper generation, session, request).
  const ledgerKey = (row: WindowsLedgerRow) =>
    `${row.helperGeneration}/${row.sessionId}/${row.requestId}`;
  function ledgerTarget(withTransfer = false) {
    const rows = new Map<string, WindowsLedgerRow>();
    const quarantines: WindowsTargetQuarantine[] = [];
    const written: WindowsLedgerRow[] = [];
    const deleted: WindowsLedgerRow[] = [];
    const control = {
      failWrite: false,
      failReflect: false,
      creationTime: '133000000000000001' as string | undefined,
      pid: 42,
      response: null as HelperResponse | null,
      wait: null as Promise<void> | null,
      reflectWait: null as Promise<void> | null,
      updateWait: null as Promise<void> | null,
      deleteEffect: () => undefined as void,
      restoreQuarantines: vi.fn(() => true),
      failTransfer: false,
      transferWait: null as Promise<void> | null,
      transfers: 0,
      closeResponse: null as HelperResponse | null,
    };
    const base = responders();
    const target = createTarget(
      {
        ...base,
        close_session: (metadata) =>
          control.closeResponse ?? [
            'probe_result',
            {
              result: 'closed',
              drained: true,
              sessionId: metadata['sessionId'],
              cancelEpoch: metadata['cancelEpoch'],
              inputAttemptCount: 1,
            },
          ],
        stop_pending_start: (metadata) => [
          'probe_result',
          {
            result: 'closed',
            drained: true,
            sessionId: metadata['sessionId'],
            cancelEpoch: 2,
            inputAttemptCount: 1,
          },
        ],
        cancel: (metadata) => [
          'dispatch_result',
          {
            result: 'canceled',
            drained: true,
            sessionId: metadata['sessionId'],
            cancelEpoch: metadata['cancelEpoch'],
            inputAttemptCount: 1,
          },
        ],
        start_session: (metadata) => {
          const [type, result] = base['start_session']!(metadata);
          return [
            type,
            {
              ...(result as Record<string, unknown>),
              pid: control.pid,
              processStartTime: control.creationTime,
            },
          ];
        },
        preflight: (metadata) => [
          'preflight_result',
          preflightReceipt(metadata, { inputAttemptCount: 1 }),
        ],
        dispatch: (metadata) =>
          control.response ?? [
            'dispatch_result',
            {
              result: 'completed',
              reasonCode: null,
              sessionId: metadata['sessionId'],
              cancelEpoch: metadata['cancelEpoch'],
              inputAttemptCount: 1,
            },
          ],
      },
      undefined,
      {
        windowsLedger: {
          write: async (row) => {
            written.push(row);
            if (control.wait !== null) await control.wait;
            if (control.failWrite) return false;
            rows.set(ledgerKey(row), row);
            return true;
          },
          update: async (row) => {
            if (control.updateWait !== null) await control.updateWait;
            if (control.failReflect) return false;
            rows.set(ledgerKey(row), row);
            return true;
          },
          delete: async (row) => {
            if (control.reflectWait !== null) await control.reflectWait;
            if (control.failReflect) return false;
            control.deleteEffect();
            deleted.push(row);
            rows.delete(ledgerKey(row));
            return true;
          },
          restoreQuarantines: () => control.restoreQuarantines(),
          ...(withTransfer
            ? {
                transferReceipt: async (
                  removed: readonly WindowsLedgerRow[],
                  added: readonly WindowsTargetQuarantine[],
                ) => {
                  control.transfers += 1;
                  if (control.transferWait !== null) await control.transferWait;
                  if (control.failTransfer) return false;
                  quarantines.push(...added);
                  for (const row of removed) rows.delete(ledgerKey(row));
                  return true;
                },
              }
            : {}),
        },
      },
    );
    const dispatch = (
      session: Awaited<ReturnType<typeof startSession>>,
      sample = ledgerActions[0] as (typeof ledgerActions)[number],
      id = 'ledger-request',
      signal = new AbortController().signal,
    ) =>
      target.host
        .dispatch({
          session,
          requestId: id,
          action: sample.action,
          observationRevision: 1,
          cancelEpoch: 0,
          signal,
          ...(sample.name === 'paste' ? { inputKind: 'paste' as const } : {}),
        })
        .then(
          (value) => ({ outcome: 'resolved' as const, value }),
          (error: unknown) => ({
            outcome: 'rejected' as const,
            error,
            code: error instanceof Error && 'code' in error ? error.code : undefined,
            accepted: error instanceof Error && 'accepted' in error ? error.accepted : undefined,
          }),
        );
    return { ...target, rows, written, deleted, control, dispatch, quarantines };
  }
  const dispatchWrites = (socket: FakeHelperSocket) =>
    socket.writes.filter((bytes) => decodeComputerUseNativeFrame(bytes).messageType === 'dispatch');
  it.each(ledgerActions)(
    'PR6 receipt clears the retained $name row before idle teardown',
    async (sample) => {
      const target = ledgerTarget();
      target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
      const session = await startSession(target.host, 'session-1', 'turn-1');
      await target.dispatch(session, sample);
      expect(target.rows.size).toBe(1);
      await target.host.close(session);
      expect(target.rows.size).toBe(0);
    },
  );
  it('PR6 closes a session with no ledger rows', async () => {
    const target = ledgerTarget();
    const session = await startSession(target.host, 'session-1', 'turn-1');
    await expect(target.host.close(session)).resolves.toBeUndefined();
    expect(children[0]!.killed).toBe(true);
  });
  it.each(['close', 'stopPendingStart'] as const)(
    'PR6 %s waits for persistence before releasing native blockers or idle teardown',
    async (entry) => {
      const target = ledgerTarget();
      target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
      const session = await startSession(target.host, 'session-1', 'turn-1');
      await target.dispatch(session);
      let release!: () => void;
      target.control.reflectWait = new Promise<void>((resolve) => {
        release = resolve;
      });
      let settled = false;
      const closing = (
        entry === 'close'
          ? target.host.close(session)
          : target.host.stopPendingStart!(session.sessionId)
      ).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      expect(target.rows.size).toBe(1);
      expect(children[0]!.killed).toBe(false);
      expect(target.host.availability()).toMatchObject({ reasonCode: 'native_stop_unconfirmed' });
      release();
      await closing;
      expect(target.rows.size).toBe(0);
      expect(children[0]!.killed).toBe(true);
    },
  );
  it('PR6 storage failure retains rows and blockers until retry succeeds', async () => {
    const target = ledgerTarget();
    target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
    const session = await startSession(target.host, 'session-1', 'turn-1');
    await target.dispatch(session);
    target.control.failReflect = true;
    await expect(target.host.close(session)).resolves.toBeUndefined();
    expect(target.rows.size).toBe(1);
    expect(children[0]!.killed).toBe(false);
    expect(target.host.availability()).toMatchObject({ reasonCode: 'native_stop_unconfirmed' });
    target.control.failReflect = false;
    await target.host.listTargets!().catch(() => undefined);
    expect(target.rows.size).toBe(0);
    expect(children[0]!.killed).toBe(true);
    expect(target.host.availability()).toMatchObject({ state: 'ready' });
  });
  it('PR6 rejects cloned and changed non-semantic receipt evidence before persistence', async () => {
    const target = ledgerTarget();
    target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
    const session = await startSession(target.host, 'session-1', 'turn-1');
    await target.dispatch(session);
    const evidence = await target.addon.close!({ sessionId: session.sessionId, cancelEpoch: 1 });
    const receipt = { sessionId: session.sessionId, cancelEpoch: 1, inputAttemptCount: 1 };
    expect(() =>
      target.addon.confirmSessionClosed!(receipt, { ...receipt, result: 'closed', drained: true }),
    ).toThrow('native_stop_unconfirmed');
    expect(() =>
      target.addon.confirmSessionClosed!({ ...receipt, inputAttemptCount: 2 }, evidence),
    ).toThrow('native_stop_unconfirmed');
    expect(target.rows.size).toBe(1);
    expect(children[0]!.killed).toBe(false);
    await expect(target.addon.confirmSessionClosed!(receipt, evidence)).resolves.toEqual({
      status: 'confirmed',
    });
    expect(target.rows.size).toBe(0);
  });
  it.each(['background_semantic', 'foreground'] as const)(
    'PR6 transfers %s rows atomically and retries without dropping blockers',
    async (path) => {
      const decide = stopKernel.decideWindowsStop;
      // PR5b/N9 create these paths later; inject their rows at the receipt boundary.
      const spy = vi.spyOn(stopKernel, 'decideWindowsStop').mockImplementation((state, event) => {
        if (event.kind === 'receipt' && event.status === 'received')
          state = {
            ...state,
            rows: state.rows.map((row) =>
              path === 'foreground'
                ? { ...row, kind: 'foreground', inputPath: 'foreground' }
                : { ...row, kind: 'semantic', inputPath: 'background_semantic' },
            ),
          };
        return decide(state, event);
      });
      try {
        const target = ledgerTarget(true);
        target.control.response = ['error', { code: 'semantic_input_in_flight', accepted: true }];
        const session = await startSession(target.host, 'session-1', 'turn-1');
        await target.dispatch(
          session,
          path === 'background_semantic' ? ledgerActions[4] : ledgerActions[0],
        );
        target.control.failTransfer = true;
        await expect(target.host.close(session)).resolves.toBeUndefined();
        expect(target.rows.size).toBe(1);
        expect(target.quarantines).toHaveLength(0);
        expect(children[0]!.killed).toBe(false);
        expect(target.host.availability()).toMatchObject({ reasonCode: 'native_stop_unconfirmed' });
        expect(target.addon.hasUnconfirmedSemanticInputs!()).toBe(path === 'background_semantic');
        if (path === 'background_semantic')
          expect(
            spy.mock.results.some(
              (result) =>
                result.type === 'return' &&
                result.value.state.holds.some(
                  (hold: stopKernel.WindowsStorageHold) => hold.operation === 'receipt_transfer',
                ),
            ),
          ).toBe(true);
        target.control.failTransfer = false;
        await target.host.listTargets!().catch(() => undefined);
        expect(target.control.transfers).toBe(2);
        expect(target.rows.size).toBe(0);
        expect(target.quarantines).toHaveLength(path === 'background_semantic' ? 1 : 0);
        expect(children[0]!.killed).toBe(true);
        expect(target.addon.hasUnconfirmedSemanticInputs!()).toBe(false);
      } finally {
        spy.mockRestore();
      }
    },
  );
  it('PR6 emits verified only after storage finishes and keeps in-flight rows', async () => {
    const spy = vi.spyOn(stopKernel, 'decideWindowsStop');
    try {
      const target = ledgerTarget(true);
      target.control.response = ['error', { code: 'semantic_input_in_flight', accepted: true }];
      const session = await startSession(target.host, 'session-1', 'turn-1');
      await target.dispatch(session);
      target.control.closeResponse = [
        'error',
        { code: 'semantic_input_in_flight', accepted: false },
      ];
      let release!: () => void;
      target.control.transferWait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const closing = target.host.close(session);
      await vi.advanceTimersByTimeAsync(50);
      expect(target.rows.size).toBe(1);
      expect(children[0]!.killed).toBe(false);
      expect(target.control.transfers).toBe(0);
      target.control.closeResponse = null;
      await vi.advanceTimersByTimeAsync(50);
      const statuses = () =>
        spy.mock.calls.flatMap(([, event]) => (event.kind === 'receipt' ? [event.status] : []));
      expect(statuses()).toEqual(['received']);
      expect(target.control.transfers).toBe(1);
      expect(children[0]!.killed).toBe(false);
      release();
      await closing;
      expect(statuses()).toEqual(['received', 'verified']);
      expect(target.rows.size).toBe(0);
      expect(children[0]!.killed).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
  it.each(['lifetime', 'generation'] as const)(
    'PR6 rejects evidence from an older %s with the same session id',
    async (boundary) => {
      const target = ledgerTarget();
      const session = await startSession(target.host, 'session-1', 'turn-1');
      await target.addon.startSession!({ sessionId: 'other-session', profile });
      const evidence = await target.addon.close!({ sessionId: session.sessionId, cancelEpoch: 1 });
      const receipt = { sessionId: session.sessionId, cancelEpoch: 1, inputAttemptCount: 1 };
      await target.addon.confirmSessionClosed!(receipt, evidence);
      if (boundary === 'generation') {
        children[0]!.emit('exit', 0, null);
        await vi.advanceTimersByTimeAsync(0);
      }
      await target.addon.startSession!({ sessionId: session.sessionId, profile });
      expect(() => target.addon.confirmSessionClosed!(receipt, evidence)).toThrow(
        'native_stop_unconfirmed',
      );
    },
  );
  it('PR6 duplicate valid receipts cannot reinstall a released blocker', async () => {
    const target = ledgerTarget();
    const session = await startSession(target.host, 'session-1', 'turn-1');
    await target.addon.startSession!({ sessionId: 'other-session', profile });
    const receipt = { sessionId: session.sessionId, cancelEpoch: 1, inputAttemptCount: 1 };
    const first = await target.addon.close!({ sessionId: session.sessionId, cancelEpoch: 1 });
    await target.addon.confirmSessionClosed!(receipt, first);
    const second = await target.addon.close!({ sessionId: session.sessionId, cancelEpoch: 1 });
    await target.addon.confirmSessionClosed!(receipt, second);
    const other = await target.addon.close!({ sessionId: 'other-session', cancelEpoch: 1 });
    await target.addon.confirmSessionClosed!({ ...receipt, sessionId: 'other-session' }, other);
    expect(children[0]!.killed).toBe(true);
  });
  it('PR6 Host rejection keeps the row and never invokes receipt storage', async () => {
    const target = ledgerTarget(true);
    target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
    const session = await startSession(target.host, 'session-1', 'turn-1');
    await target.dispatch(session);
    target.control.closeResponse = [
      'probe_result',
      {
        result: 'closed',
        drained: true,
        sessionId: session.sessionId,
        cancelEpoch: 1,
        inputAttemptCount: 0,
      },
    ];
    await expect(target.host.close(session)).rejects.toThrow('native_input_receipt_unconfirmed');
    expect(target.control.transfers).toBe(0);
    expect(target.rows.size).toBe(1);
    expect(children[0]!.killed).toBe(false);
  });
  it('PR6 a late receipt write completes its pending confirmation without retrying I/O', async () => {
    const target = ledgerTarget(true);
    target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
    const session = await startSession(target.host, 'session-1', 'turn-1');
    await target.dispatch(session);
    let release!: () => void;
    target.control.transferWait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const evidence = await target.addon.close!({ sessionId: session.sessionId, cancelEpoch: 1 });
    const receipt = { sessionId: session.sessionId, cancelEpoch: 1, inputAttemptCount: 1 };
    const confirming = target.addon.confirmSessionClosed!(receipt, evidence);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(confirming).resolves.toEqual({ status: 'pending' });
    expect(target.rows.size).toBe(1);
    expect(children[0]!.killed).toBe(false);
    await target.host.listTargets!().catch(() => undefined);
    expect(target.control.transfers).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(target.rows.size).toBe(0);
    expect(children[0]!.killed).toBe(true);
  });
  it('PR6 a response arriving during receipt storage cannot recreate a deleted row', async () => {
    const target = ledgerTarget(true);
    target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
    const session = await startSession(target.host, 'session-1', 'turn-1');
    target.helper().holdOnly('dispatch');
    const dispatch = target.dispatch(session);
    await vi.advanceTimersByTimeAsync(0);
    let receiptWritten!: () => void;
    let responseWritten!: () => void;
    target.control.transferWait = new Promise<void>((resolve) => {
      receiptWritten = resolve;
    });
    target.control.updateWait = new Promise<void>((resolve) => {
      responseWritten = resolve;
    });
    const closing = target.host.close(session);
    await vi.advanceTimersByTimeAsync(0);
    expect(target.control.transfers).toBe(1);
    target.helper().release('dispatch');
    await vi.advanceTimersByTimeAsync(0);
    receiptWritten();
    await closing;
    responseWritten();
    await dispatch;
    expect(target.rows.size).toBe(0);
  });
  it.each(ledgerActions)('R5/R6 keeps $name rows for each transport loss', async (sample) => {
    const decide = vi.spyOn(stopKernel, 'decideWindowsStop');
    for (const loss of ['timeout', 'failAll', 'abortTransport'] as const) {
      const target = ledgerTarget();
      const session = await startSession(target.host, `session-${loss}`, 'turn-1');
      target.helper().holdOnly('dispatch');
      const result = target.dispatch(session, sample);
      await vi.advanceTimersByTimeAsync(1);
      expect(target.written[0]).toMatchObject({
        kind: sample.kind,
        identity: { pid: 42, creationTime: '133000000000000001' },
      });
      if (loss === 'timeout')
        await vi.advanceTimersByTimeAsync(operationTimeoutMilliseconds('dispatch'));
      else if (loss === 'failAll')
        sockets.at(-1)!.emit('error', new Error('synthetic transport loss'));
      else {
        const socket = sockets.at(-1)!;
        const request = decodeComputerUseNativeFrame(socket.writes.at(-1)!);
        socket.emit(
          'data',
          encodeComputerUseNativeFrame({
            ...request,
            messageType: 'dispatch_result',
            metadata: Buffer.from('{'),
            binary: Buffer.alloc(0),
          }),
        );
      }
      expect(await result).toMatchObject({ outcome: 'rejected' });
      const events = decide.mock.calls
        .map((call) => call[1])
        .filter((event) => event.kind === 'input_unconfirmed');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ cause: loss === 'timeout' ? 'transport_timeout' : loss });
      decide.mockClear();
      expect(target.rows.size).toBe(1);
    }
    decide.mockRestore();
  });
  it.each([false, true])(
    'R18 identity missing or initial write failed (%s) never sends',
    async (missing) => {
      const target = ledgerTarget();
      if (missing) target.control.creationTime = undefined;
      else target.control.failWrite = true;
      const session = await startSession(target.host, 'session-1', 'turn-1');
      expect(await target.dispatch(session)).toMatchObject({
        outcome: 'resolved',
        value: { result: 'rejected', reasonCode: 'native_unavailable' },
      });
      expect(target.helper().served).not.toContain('dispatch');
      expect(dispatchWrites(sockets.at(-1)!)).toHaveLength(0);
      expect(target.rows.size).toBe(0);
    },
  );
  it.each(['success', 'rejected', 'unconfirmed', 'invalid'] as const)(
    'R19a reflects only verified %s responses',
    async (outcome) => {
      const target = ledgerTarget();
      if (outcome !== 'success')
        target.control.response = [
          'error',
          outcome === 'invalid'
            ? { code: 'ticket_invalid', accepted: 'false' }
            : { code: 'ticket_invalid', accepted: outcome === 'unconfirmed' },
        ];
      const session = await startSession(target.host, 'session-1', 'turn-1');
      const result = await target.dispatch(session);
      expect(result).toMatchObject(
        outcome === 'success' || outcome === 'rejected'
          ? {
              outcome: 'resolved',
              value: { result: outcome === 'success' ? 'completed' : 'rejected' },
            }
          : { outcome: 'rejected' },
      );
      expect(target.rows.size).toBe(outcome === 'success' || outcome === 'rejected' ? 0 : 1);
      if (outcome === 'unconfirmed')
        expect([...target.rows.values()][0]?.state).toBe('effect_unconfirmed');
      if (outcome === 'unconfirmed')
        expect(result).toMatchObject({ code: 'ticket_invalid', accepted: true });
      if (outcome === 'invalid')
        expect(result).toMatchObject({ code: undefined, accepted: undefined });
    },
  );
  it.each([false, true])(
    'R19a failed delete/update blocks start and dispatch until retry (%s)',
    async (update) => {
      const target = ledgerTarget();
      target.control.failReflect = true;
      if (update)
        target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
      const session = await startSession(target.host, 'session-1', 'turn-1');
      await target.dispatch(session);
      expect(target.rows.size).toBe(1);
      expect(await target.dispatch(session, ledgerActions[0], 'second-request')).toMatchObject({
        outcome: 'resolved',
        value: { result: 'rejected', reasonCode: 'native_unavailable' },
      });
      await expect(startSession(target.host, 'session-2', 'turn-2')).rejects.toThrow(
        'native_unavailable',
      );
      expect(target.helper().served.filter((op) => op === 'dispatch')).toHaveLength(1);
      target.control.failReflect = false;
      target.control.response = null;
      await expect(startSession(target.host, 'session-2', 'turn-2')).resolves.toMatchObject({
        sessionId: 'session-2',
      });
      expect(target.rows.size).toBe(update ? 1 : 0);
      await target.dispatch(session, ledgerActions[0], 'third-request');
      expect(target.helper().served.filter((op) => op === 'dispatch')).toHaveLength(2);
    },
  );
  it.each(['hold', 'uncertain'] as const)(
    'R19a 128 refused starts do not exhaust start owners (%s)',
    async (kind) => {
      const target = ledgerTarget();
      const session = await startSession(target.host, 'session-1', 'turn-1');
      let resume!: () => void;
      if (kind === 'hold') target.control.failReflect = true;
      else
        target.control.wait = new Promise<void>((resolve) => {
          resume = resolve;
        });
      const dispatch = target.dispatch(session);
      if (kind === 'uncertain') await vi.advanceTimersByTimeAsync(2_001);
      await dispatch;
      for (let i = 0; i < 128; i++) {
        await expect(startSession(target.host, `denied-${i}`, `turn-${i}`)).rejects.toMatchObject({
          reasonCode: 'native_unavailable',
        });
      }
      target.control.failReflect = false;
      if (kind === 'uncertain') {
        resume();
        await vi.advanceTimersByTimeAsync(1);
      }
      await expect(startSession(target.host, 'fresh', 'fresh-turn')).resolves.toMatchObject({
        sessionId: 'fresh',
      });
    },
  );

  it.each(['reflect', 'retry'] as const)(
    'R19a unresolved %s write cannot be overtaken by a retry',
    async (path) => {
      const target = ledgerTarget();
      const session = await startSession(target.host, 'session-1', 'turn-1');
      if (path === 'retry') {
        target.control.failReflect = true;
        await target.dispatch(session);
        target.control.failReflect = false;
      }
      let resume!: () => void;
      target.control.reflectWait = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const pending =
        path === 'reflect' ? target.dispatch(session) : target.host.listWindows(profile);
      await vi.advanceTimersByTimeAsync(2_001);
      await pending;
      target.control.reflectWait = null;
      await expect(startSession(target.host, 'blocked', 'blocked-turn')).rejects.toMatchObject({
        reasonCode: 'native_unavailable',
      });
      expect(target.rows.size).toBe(1);
      expect(await target.dispatch(session)).toMatchObject({
        outcome: 'resolved',
        value: { result: 'rejected', reasonCode: 'native_unavailable' },
      });
      resume();
      await vi.advanceTimersByTimeAsync(1);
      await expect(startSession(target.host, 'fresh', 'fresh-turn')).resolves.toMatchObject({
        sessionId: 'fresh',
      });
      expect(target.rows.size).toBe(0);
    },
  );

  it.each(['written', 'reflect-timeout', 'retry-timeout', 'exception'] as const)(
    'R21 host retains and writes restoration after a superseded release (%s)',
    async (path) => {
      const target = ledgerTarget();
      const session = await startSession(target.host, 'session-1', 'turn-1');
      const quarantine: stopKernel.WindowsTargetQuarantine = {
        identity: { pid: 42, creationTime: '133000000000000001' },
        reason: 'response_lost',
      };
      let storedQuarantine = true;
      const order: string[] = [];
      target.control.deleteEffect = () => {
        storedQuarantine = false;
        order.push('release');
      };
      let failRestore = true;
      target.control.restoreQuarantines.mockImplementation(() => {
        if (failRestore) return false;
        order.push('restore');
        storedQuarantine = true;
        return true;
      });
      const realDecide = stopKernel.decideWindowsStop;
      // PR5a has no public release/receipt entry yet. Supply that future kernel state at
      // the storage seam, while keeping the real host writer, timers and transport.
      const decide = vi
        .spyOn(stopKernel, 'decideWindowsStop')
        .mockImplementation((state, event) => {
          let next = state;
          if (
            event.kind === 'retry_storage' &&
            (event.status === 'written' || (event.status === 'failed' && event.uncertain))
          ) {
            next = {
              ...state,
              quarantines: [quarantine],
              holds: state.holds.map((hold) =>
                hold.operation === 'release' ? { ...hold, releaseSuperseded: true } : hold,
              ),
            };
          }
          const decision = realDecide(next, event);
          if (event.kind !== 'response') return decision;
          return {
            ...decision,
            state: {
              ...decision.state,
              holds: decision.state.holds.map((hold) => ({
                ...hold,
                operation: 'release',
                recovery: 'write_release',
                releaseTarget: quarantine.identity,
              })),
            },
          };
        });
      try {
        if (path === 'retry-timeout') {
          target.control.failReflect = true;
          await target.dispatch(session);
          target.control.failReflect = false;
        }
        let resume!: () => void;
        let reject!: () => void;
        if (path !== 'written')
          target.control.reflectWait = new Promise<void>((resolve, fail) => {
            resume = resolve;
            reject = () => fail(new Error('synthetic storage failure'));
          });
        const pending =
          path === 'retry-timeout' ? target.host.listWindows(profile) : target.dispatch(session);
        if (path !== 'written') {
          await vi.advanceTimersByTimeAsync(2_001);
          await pending;
          target.control.reflectWait = null;
          // Even a new isolation write cannot authorize starting while the old release is live.
          order.push('evidence', 'external-restore');
          storedQuarantine = true;
          await expect(startSession(target.host, 'blocked', 'blocked-turn')).rejects.toMatchObject({
            reasonCode: 'native_unavailable',
          });
          expect(target.control.restoreQuarantines).not.toHaveBeenCalled();
          expect(await target.dispatch(session)).toMatchObject({
            outcome: 'resolved',
            value: { result: 'rejected', reasonCode: 'native_unavailable' },
          });
          if (path === 'exception') reject();
          else resume();
          await vi.advanceTimersByTimeAsync(1);
        } else await pending;
        await target.host.listWindows(profile);
        expect(decide.mock.results.at(-1)?.value.state.holds).toMatchObject([
          { recovery: 'write_quarantine', quarantinesToRestore: [quarantine] },
        ]);
        failRestore = false;
        await target.host.listWindows(profile);
        expect(target.control.restoreQuarantines).toHaveBeenCalled();
        expect(storedQuarantine).toBe(true);
        if (path !== 'exception') expect(order.slice(-2)).toEqual(['release', 'restore']);
        const finalState = decide.mock.results.at(-1)?.value.state;
        expect(finalState.holds).toEqual([]);
        expect(finalState.quarantines).toEqual([quarantine]);
      } finally {
        decide.mockRestore();
      }
    },
  );

  it('R19a Stop latches a start waiting for storage retry', async () => {
    const target = ledgerTarget();
    const session = await startSession(target.host, 'session-1', 'turn-1');
    target.control.failReflect = true;
    await target.dispatch(session);
    target.control.failReflect = false;
    let resume!: () => void;
    target.control.reflectWait = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const starting = startSession(target.host, 'session-2', 'turn-2').catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(1);
    const stopped = await target.host.stopPendingStart!('session-2').catch(
      (error: unknown) => error,
    );
    resume();
    expect(await starting).toMatchObject({ reasonCode: 'native_start_canceled' });
    expect(stopped).toEqual({ kind: 'not_submitted' });
    expect(target.helper().served.filter((op) => op === 'start_session')).toHaveLength(1);
  });

  it.each(['windows', 'targets'] as const)(
    'R19a discovery (%s) retries a pending reflection',
    async (kind) => {
      const target = ledgerTarget();
      const session = await startSession(target.host, 'session-1', 'turn-1');
      target.control.failReflect = true;
      await target.dispatch(session);
      target.control.failReflect = false;
      if (kind === 'windows') await target.host.listWindows(profile);
      else await target.host.listTargets!().catch(() => undefined);
      expect(target.rows.size).toBe(0);
    },
  );

  it('R19a Stop prevents discovery submission during storage retry', async () => {
    const target = ledgerTarget();
    const session = await startSession(target.host, 'session-1', 'turn-1');
    const submitted = target
      .helper()
      .served.filter((op) => op === 'list_windows_cancellable').length;
    target.control.failReflect = true;
    await target.dispatch(session);
    target.control.failReflect = false;
    let resume!: () => void;
    target.control.reflectWait = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const discovery = target.host.beginWindowDiscovery!(profile);
    const result = discovery.result.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1);
    expect(await discovery.stop()).toMatchObject({ kind: 'not_submitted' });
    resume();
    expect(await result).toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(1);
    expect(target.helper().served.filter((op) => op === 'list_windows_cancellable')).toHaveLength(
      submitted,
    );
  });

  it('R19a storage reflection has a bounded wait and keeps its hold', async () => {
    const decide = vi.spyOn(stopKernel, 'decideWindowsStop');
    const target = ledgerTarget();
    const session = await startSession(target.host, 'session-1', 'turn-1');
    target.control.reflectWait = new Promise<void>(() => undefined);
    let settled = false;
    const result = target.dispatch(session).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(2_001);
    expect(settled).toBe(true);
    expect(await result).toMatchObject({ outcome: 'resolved', value: { result: 'completed' } });
    expect(target.rows.size).toBe(1);
    expect(decide.mock.results.at(-1)?.value.state.holds).toMatchObject([
      { operation: 'response', writeUncertain: true },
    ]);
    decide.mockRestore();
  });

  it('R18 a timed out initial write blocks the target until the late unsent row is removed', async () => {
    const target = ledgerTarget();
    const session = await startSession(target.host, 'session-1', 'turn-1');
    let resume!: () => void;
    target.control.wait = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const result = target.dispatch(session);
    await vi.advanceTimersByTimeAsync(2_001);
    expect(await result).toMatchObject({
      outcome: 'resolved',
      value: { result: 'rejected', reasonCode: 'native_unavailable' },
    });
    target.control.wait = null;
    expect(await target.dispatch(session)).toMatchObject({
      outcome: 'resolved',
      value: { result: 'rejected', reasonCode: 'native_unavailable' },
    });
    expect(dispatchWrites(sockets.at(-1)!)).toHaveLength(0);
    resume();
    await vi.advanceTimersByTimeAsync(1);
    expect(target.rows.size).toBe(0);
    expect(await target.dispatch(session)).toMatchObject({
      outcome: 'resolved',
      value: { result: 'completed' },
    });
  });

  it.each([false, true])(
    'R18 signal abort cancels the unsent row and retains a failed deletion (%s)',
    async (failDelete) => {
      const target = ledgerTarget();
      const session = await startSession(target.host, 'session-1', 'turn-1');
      const signal = new AbortController();
      let resume!: () => void;
      target.control.wait = new Promise<void>((resolve) => {
        resume = resolve;
      });
      target.control.failReflect = failDelete;
      const result = target.dispatch(session, ledgerActions[0], 'signal-request', signal.signal);
      await vi.advanceTimersByTimeAsync(1);
      signal.abort();
      resume();
      expect(await result).toMatchObject({
        outcome: 'resolved',
        // The default-off main transport already uses this double-prefixed Stop reason.
        // Keep its classification unchanged while storage is opt-in (PR5a AC-1).
        value: { result: 'rejected', reasonCode: 'native_native_stop_unconfirmed' },
      });
      expect(dispatchWrites(sockets.at(-1)!)).toHaveLength(0);
      expect(target.rows.size).toBe(failDelete ? 1 : 0);
      if (failDelete) {
        expect(await target.dispatch(session)).toMatchObject({
          outcome: 'resolved',
          value: { result: 'rejected', reasonCode: 'native_unavailable' },
        });
        target.control.failReflect = false;
        await target.host.listWindows(profile);
        expect(target.rows.size).toBe(0);
      }
    },
  );

  it.each([false, true])(
    'R19a another session reusing a retained request id reflects only its own row (delete fails: %s)',
    async (failDelete) => {
      const decide = vi.spyOn(stopKernel, 'decideWindowsStop');
      const kernelRows = () => decide.mock.results.at(-1)!.value.state.rows as WindowsLedgerRow[];
      const target = ledgerTarget();
      const sessionA = await startSession(target.host, 'session-a', 'turn-1');
      target.control.creationTime = '133000000000000002';
      const sessionB = await startSession(target.host, 'session-b', 'turn-2');
      // A: an accepted error leaves its row effect-unconfirmed.
      target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
      expect(await target.dispatch(sessionA, ledgerActions[0], 'shared')).toMatchObject({
        outcome: 'rejected',
        accepted: true,
      });
      target.control.response = null;
      const rowA = [...target.rows.values()][0]!;
      expect(rowA).toMatchObject({ sessionId: 'session-a', state: 'effect_unconfirmed' });
      // B: another target's session uses the same request id.
      target.control.failReflect = failDelete;
      expect(await target.dispatch(sessionB, ledgerActions[0], 'shared')).toMatchObject({
        outcome: 'resolved',
        value: { result: 'completed' },
      });
      expect(target.written[1]).toMatchObject({
        sessionId: 'session-b',
        requestId: rowA.requestId,
      });
      expect(kernelRows().map((row) => row.sessionId)).toEqual(
        failDelete ? ['session-a', 'session-b'] : ['session-a'],
      );
      expect(kernelRows()[0]).toEqual(rowA);
      expect(target.deleted.map((row) => row.sessionId)).toEqual(failDelete ? [] : ['session-b']);
      expect([...target.rows.values()].map((row) => row.sessionId)).toEqual(
        failDelete ? ['session-a', 'session-b'] : ['session-a'],
      );
      // The hold, if any, is on B's target: B's next dispatch is refused, A's is not.
      expect(await target.dispatch(sessionB, ledgerActions[0], 'b-next')).toMatchObject(
        failDelete
          ? { outcome: 'resolved', value: { result: 'rejected', reasonCode: 'native_unavailable' } }
          : { outcome: 'resolved', value: { result: 'completed' } },
      );
      expect(await target.dispatch(sessionA, ledgerActions[0], 'a-next')).toMatchObject({
        outcome: 'resolved',
        value: { result: 'completed' },
      });
      expect(target.rows.get(ledgerKey(rowA))).toEqual(rowA);
      expect(
        kernelRows().find(
          (row) => row.sessionId === 'session-a' && row.requestId === rowA.requestId,
        ),
      ).toEqual(rowA);
      // The same key again is refused before storage, so a stored row is never overwritten.
      const writes = target.written.length;
      expect(await target.dispatch(sessionA, ledgerActions[0], 'shared')).toMatchObject({
        outcome: 'resolved',
        value: { result: 'rejected', reasonCode: 'native_unavailable' },
      });
      expect(target.written).toHaveLength(writes);
      expect(target.rows.get(ledgerKey(rowA))).toEqual(rowA);
      decide.mockRestore();
    },
  );

  it('R5/R6 transport loss and cancellation name the session of their own row', async () => {
    const decide = vi.spyOn(stopKernel, 'decideWindowsStop');
    const target = ledgerTarget();
    const sessionA = await startSession(target.host, 'session-a', 'turn-1');
    target.control.creationTime = '133000000000000002';
    const sessionB = await startSession(target.host, 'session-b', 'turn-2');
    target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
    await target.dispatch(sessionA, ledgerActions[0], 'shared');
    target.control.response = null;
    target.helper().holdOnly('dispatch');
    const lost = target.dispatch(sessionB, ledgerActions[0], 'shared');
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(operationTimeoutMilliseconds('dispatch'));
    expect(await lost).toMatchObject({ outcome: 'rejected' });
    expect(target.written.map((row) => row.requestId)).toEqual([
      target.written[0]!.requestId,
      target.written[0]!.requestId,
    ]);
    const events = decide.mock.calls.map((call) => call[1]);
    expect(events.filter((event) => event.kind === 'input_unconfirmed')).toEqual([
      expect.objectContaining({ sessionId: 'session-b', requestId: target.written[0]!.requestId }),
    ]);
    const rowsAfter = decide.mock.results.at(-1)!.value.state.rows as WindowsLedgerRow[];
    expect(rowsAfter.map((row) => [row.sessionId, row.state])).toEqual([
      ['session-a', 'effect_unconfirmed'],
      ['session-b', 'awaiting_response'],
    ]);
    decide.mockRestore();
  });

  it('R19a holds only the affected identity and blocks an unknown target', async () => {
    const target = ledgerTarget();
    const session = await startSession(target.host, 'session-1', 'turn-1');
    target.control.creationTime = '133000000000000002';
    const other = await startSession(target.host, 'session-2', 'turn-2');
    target.control.failReflect = true;
    await target.dispatch(session);
    await expect(startSession(target.host, 'session-2', 'turn-2')).resolves.toMatchObject({
      sessionId: other.sessionId,
    });
    expect(await target.dispatch(other)).toMatchObject({
      outcome: 'resolved',
      value: { result: 'completed' },
    });
    await expect(
      target.host.startSession({
        profile: { ...profile, identityDigest: digest('9') },
        windowId: '100',
        sessionId: 'unknown',
        taskId: 'task-1',
        turnId: 'turn-3',
        cancelEpoch: 0,
      }),
    ).rejects.toThrow('native_unavailable');
    expect(await target.dispatch(session)).toMatchObject({
      outcome: 'resolved',
      value: { result: 'rejected', reasonCode: 'native_unavailable' },
    });
  });

  it.each([false, true])(
    'R18 cancels an unsent stored row after Stop during storage (%s)',
    async (failDelete) => {
      const target = ledgerTarget();
      const session = await startSession(target.host, 'session-1', 'turn-1');
      let resume!: () => void;
      target.control.wait = new Promise<void>((resolve) => {
        resume = resolve;
      });
      target.control.failReflect = failDelete;
      const result = target.dispatch(session);
      await vi.advanceTimersByTimeAsync(1);
      await target.host.cancel(session, 1);
      resume();
      await result;
      expect(target.helper().served).not.toContain('dispatch');
      expect(dispatchWrites(sockets.at(-1)!)).toHaveLength(0);
      expect(target.rows.size).toBe(failDelete ? 1 : 0);
    },
  );

  it.each(['pid', 'creationTime'] as const)(
    'R18 identity mismatch (%s) preserves the original identity and stops',
    async (field) => {
      const target = ledgerTarget();
      const session = await startSession(target.host, 'session-1', 'turn-1');
      if (field === 'pid') target.control.pid = 43;
      else target.control.creationTime = '133000000000000002';
      target.helper().holdOnly('stop_pending_start');
      const starting = startSession(target.host, 'session-1', 'turn-1').catch(
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(1);
      await target.host.cancel(session, 0);
      const canceled = sockets
        .at(-1)!
        .writes.map((bytes) => decodeComputerUseNativeFrame(bytes))
        .find((frame) => frame.messageType === 'cancel');
      expect(JSON.parse(canceled!.metadata.toString('utf8'))).toMatchObject({
        pid: 42,
        processStartTime: '133000000000000001',
      });
      target.helper().release('stop_pending_start');
      expect(await starting).toMatchObject({ reasonCode: 'native_session_identity_mismatch' });
      await target.dispatch(session);
      expect(target.helper().served).not.toContain('dispatch');
      expect(target.helper().served).toContain('stop_pending_start');
    },
  );
  it('R19a an invalid success envelope cannot delete a row', async () => {
    const target = ledgerTarget();
    const session = await startSession(target.host, 'session-1', 'turn-1');
    target.control.response = [
      'dispatch_result',
      {
        result: 'completed',
        reasonCode: null,
        sessionId: 'session-1',
        cancelEpoch: 0,
        inputAttemptCount: 1,
        accepted: false,
      },
    ];
    await target.dispatch(session);
    expect(target.rows.size).toBe(1);
  });
  it('R18 helper kill during storage never writes the dispatch frame', async () => {
    const target = ledgerTarget();
    const session = await startSession(target.host, 'session-1', 'turn-1');
    let resume!: () => void;
    target.control.wait = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const result = target.dispatch(session);
    await vi.advanceTimersByTimeAsync(1);
    children.at(-1)!.kill();
    await vi.advanceTimersByTimeAsync(1);
    resume();
    await result;
    expect(target.helper().served).not.toContain('dispatch');
    expect(dispatchWrites(sockets.at(-1)!)).toHaveLength(0);
    expect(target.rows.size).toBe(0);
  });
  it('R18 a hold arriving during another write refuses and cancels that unsent row', async () => {
    const target = ledgerTarget();
    const session = await startSession(target.host, 'session-1', 'turn-1');
    let resume!: () => void;
    target.control.wait = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const first = target.dispatch(session);
    await vi.advanceTimersByTimeAsync(1);
    target.control.wait = null;
    target.control.failReflect = true;
    await target.dispatch(session, ledgerActions[0], 'other-request');
    target.control.failReflect = false;
    resume();
    await first;
    expect(target.helper().served.filter((op) => op === 'dispatch')).toHaveLength(1);
    expect(dispatchWrites(sockets.at(-1)!)).toHaveLength(1);
    expect(target.rows.size).toBe(1);
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

  it('production Controller reports unconfirmed discovery instead of an empty target list', async () => {
    const { host, helper } = createTarget(responders(), (helper) => {
      helper.refuse('list_windows_cancellable');
      helper.refuse('stop_window_discovery');
    });
    const controller = controllerFor(host, [profile, { ...profile, id: 'profile-2' }]);
    await expect(
      controller.listTargets(
        {},
        {
          taskId: 'task-a',
          turnId: 'turn-a',
          workspaceId: null,
          policyEpoch: 0,
        },
      ),
    ).rejects.toThrow(/native_stop_unconfirmed/u);
    expect(helper().served.filter((op) => op === 'list_windows_cancellable')).toHaveLength(1);
    expect(host.availability().control).toBe(false);
    helper().allow('stop_window_discovery');
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
