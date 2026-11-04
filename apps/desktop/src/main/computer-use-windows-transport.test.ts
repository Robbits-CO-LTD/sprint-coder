import type { ComputerUseDiscoveryResult } from './computer-use-discovery-scope';
import { readWindowsMainIdentity } from './computer-use-windows-main';
import * as windowsMain from './computer-use-windows-main';
import type * as FsPromises from 'node:fs/promises';
import { readWindowsHostSource } from '../../../../computer-use-windows-host-source.mjs';
import type {
  WindowsStopDeliveryEvent,
  WindowsOwnerStopNotification,
} from './computer-use-windows-stop-delivery';
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
  COMPUTER_USE_NATIVE_FRAME_HEADER_BYTES,
  computerUseNativeMessageTypeNames,
  computerUseNativeMessageTypeValue,
  decodeComputerUseNativeFrame,
  encodeComputerUseNativeFrame,
  type ComputerUseNativeFrame,
  type ComputerUseNativeMessageType,
} from './computer-use-native-protocol';
import type {
  ComputerUseNativeAddon,
  ComputerUseNativeBinding,
  WindowsCloseCallbacks,
  WindowsTerminationCallbacks,
  WindowsStartCallbacks,
} from './computer-use-native-types';
import {
  COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT,
  COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS,
  ComputerUseNativeUnavailableError,
  createComputerUseNativeHost,
  type ComputerUseNativeHostOptions,
  type WindowsDispatchLedgerStorage,
} from './computer-use-native-host';
import type {
  WindowsLedgerRow,
  WindowsStorageHold,
  WindowsTargetQuarantine,
} from './computer-use-windows-stop-outcome';
import * as stopKernel from './computer-use-windows-stop-outcome';
import { openWindowsLedgerStore } from './computer-use-windows-ledger-store';
import Database from 'better-sqlite3';
import {
  COMPUTER_USE_NATIVE_CLOSE_TRANSPORT_TIMEOUT_MS,
  createWindowsComputerUseNativeAddon,
  operationTimeoutMilliseconds,
  windowsHelperEnvironment,
} from './computer-use-native-windows';
import { DENY_RULESET } from './computer-use-deny-ruleset.generated';
import {
  computerUseNativeHostEligibilityOptions,
  createComputerUseEligibilityWiring,
} from './computer-use-eligibility-wiring';

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
  const actual = await importOriginal<typeof FsPromises>();
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

class ControlledHelperChild extends FakeHelperChild {
  killResult: boolean | 'throw' = true;
  killCalls = 0;
  override kill(): boolean {
    this.killCalls += 1;
    this.killed = true;
    if (this.killResult === 'throw') throw new Error('synthetic kill failure');
    return this.killResult;
  }
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
// Error message, stack and cause are not enumerable, so JSON.stringify alone misses them.
const exposedText = (value: unknown, depth = 0): string => {
  if (!(value instanceof Error) || depth > 3) return JSON.stringify(value) ?? String(value);
  return [
    JSON.stringify(value),
    String(value),
    value.message,
    value.stack ?? '',
    value.cause === undefined ? '' : exposedText(value.cause, depth + 1),
  ].join('\n');
};
const expectNoProcessIdentity = (value: unknown): void => {
  expect(exposedText(value)).not.toMatch(/\bpid\b|processStartTime|133000000000000001/u);
};
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
  readonly residual = new Set<string>();

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

  retire(operation: string, change: Partial<ComputerUseNativeFrame> = {}): void {
    const request = this.socket.writes
      .map(decodeComputerUseNativeFrame)
      .reverse()
      .find((frame) => JSON.parse(frame.metadata.toString('utf8')).operation === operation);
    if (request === undefined) throw new Error('No request to retire');
    this.socket.emit(
      'data',
      encodeComputerUseNativeFrame({
        ...request,
        messageType: 'operation_retired',
        flags: 0,
        cancelId: null,
        metadata: Buffer.from(JSON.stringify({ helperGeneration: 1 })),
        binary: Buffer.alloc(0),
        ...change,
      }),
    );
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
        flags: this.residual.has(operation) ? 1 : 0,
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
    check_target_identity: (metadata) => [
      'target_identity_result',
      {
        results: (metadata['targets'] as unknown[]).map(() => ({ result: 'alive' })),
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
  adaptAddon: (addon: ComputerUseNativeAddon) => ComputerUseNativeAddon = (addon) => addon,
  identityBoundStart?: boolean,
  eligibility?: ComputerUseNativeBinding['manifest']['eligibility'],
  approvalEvidence?: ComputerUseNativeBinding['manifest']['windowsDocumentViewers'],
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
    {
      ...expectedTrust,
      ...(eligibility === undefined ? {} : { eligibility }),
      ...(approvalEvidence === undefined ? {} : { windowsDocumentViewers: approvalEvidence }),
    },
  );
  const hostBinding = binding(adaptAddon(addon));
  const host = createComputerUseNativeHost(
    {
      ...hostBinding,
      windowsApprovalVerified: approvalEvidence !== undefined,
      manifest: { ...hostBinding.manifest, ...(eligibility === undefined ? {} : { eligibility }) },
      probe: {
        ...hostBinding.probe,
        capabilities: {
          ...hostBinding.probe.capabilities,
          ...(identityBoundStart === undefined ? {} : { identityBoundStart }),
        },
      },
    },
    'win32',
    {
      windowsPhysicalBoundsToDip: (value) => value,
      ...options,
    },
  );
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
  publishDiscoveryResult?: (result: ComputerUseDiscoveryResult) => void,
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
    ...(publishDiscoveryResult === undefined ? {} : { publishDiscoveryResult }),
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
  it.each(['unsupported_operation', 'explorer_view_unreadable'])(
    'propagates Explorer measurement refusal (%s) with session and epoch intact',
    async (code) => {
      const measure = vi.fn<Responder>(() => ['error', { code }]);
      const { addon } = createTarget({ ...responders(), measure_explorer_view: measure });
      for (const [sessionId, cancelEpoch] of [
        ['missing', 0],
        ['bound', 1],
      ] as const) {
        await expect(
          addon.measureExplorerView!({
            sessionId,
            cancelEpoch,
            windowId: '100',
            requestId: `${sessionId}-measure`,
            x: 20,
            y: 30,
          }),
        ).rejects.toThrow(code);
        expect(measure).toHaveBeenLastCalledWith(
          expect.objectContaining({ sessionId, cancelEpoch, x: 20, y: 30 }),
        );
      }
    },
  );
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

  it('P2a retains the native foreground session shape', async () => {
    const base = responders();
    const inputSession = { kind: 'foreground', backgroundCapabilityVersion: null };
    const { host } = createTarget({
      ...base,
      start_session: (metadata) => {
        const [type, value] = base['start_session']!(metadata);
        return [type, { ...(value as object), inputSession }];
      },
    });
    const session = await startSession(host, 'p2a-foreground', 'turn-1');
    expect(session.inputSession).toEqual(inputSession);
    await host.close(session);
  });

  it('BG03_lost_event_cannot_bypass_epoch: delivers unsolicited events and revokes tickets before cancel', async () => {
    const { host, addon, helper } = createTarget();
    const received = vi.fn();
    host.subscribeWindowsInteraction?.(received);
    const session = await startSession(host, 'background-event', 'turn-1');
    const socket = sockets[0]!;
    const startFrame = socket.writes
      .map(decodeComputerUseNativeFrame)
      .find((frame) => JSON.parse(frame.metadata.toString())['operation'] === 'start_session')!;
    const base = {
      version: 1,
      kind: 'background_event',
      sessionId: session.sessionId,
      taskId: 'task-1',
      turnId: 'turn-1',
      helperGeneration: 1,
      cancelEpoch: 0,
      interactionEpoch: 2,
      sequence: 2,
      state: 'takeover',
    };
    const send = (value: unknown, header = startFrame.sessionId) =>
      socket.emit(
        'data',
        encodeComputerUseNativeFrame({
          ...startFrame,
          messageType: 'background_interaction_event',
          sessionId: header,
          metadata: Buffer.from(JSON.stringify(value)),
          binary: Buffer.alloc(0),
        }),
      );
    for (const patch of [
      { taskId: 'other' },
      { turnId: 'other' },
      { helperGeneration: 2 },
      { cancelEpoch: 1 },
      { interactionEpoch: 0 },
      { extra: true },
    ])
      send({ ...base, ...patch });
    send(base, { hex: 'a'.repeat(32) });
    expect(received).not.toHaveBeenCalled();
    send(base);
    send(base);
    send({ ...base, sequence: 1, interactionEpoch: 1 });
    expect(received).toHaveBeenCalledTimes(1);
    await expect(
      Promise.resolve(
        addon.dispatch!({
          sessionId: session.sessionId,
          requestId: 'stale-ticket',
          cancelEpoch: 0,
          type: 'click',
          ticket: digest('d'),
        }),
      ),
    ).rejects.toThrow('native_interaction_revoked');
    await expect(startSession(host, session.sessionId, 'turn-1')).rejects.toThrow(
      'native_interaction_revoked',
    );
    expect(helper().served).not.toContain('dispatch');
    expect(helper().served).not.toContain('close_session');
    await host.cancel(session, 1);
    expect(helper().served.at(-1)).toBe('cancel');
    await host.close(session);
  });

  it('RT_begin_ack_precedes_focus_exception: event uses the bound trip and never resumes on end', async () => {
    const { host, addon } = createTarget({
      ...responders(),
      approval_round_trip_begin: (metadata) => {
        const {
          operation: _operation,
          durationMs: _duration,
          mainPid: _pid,
          mainProcessStartTime: _start,
          mainImageIdentity: _image,
          ...binding
        } = metadata;
        return [
          'approval_round_trip_begin_result',
          {
            ...binding,
            kind: 'begin_result',
            accepted: true,
            failureReason: 'none',
            failureLatched: false,
          },
        ];
      },
    });
    const received = vi.fn();
    host.subscribeWindowsInteraction?.(received);
    const session = await startSession(host, 'trip-event', 'turn-1');
    const bound = {
      version: 1,
      roundTripId: 'trip-1',
      sessionId: session.sessionId,
      taskId: 'task-1',
      turnId: 'turn-1',
      helperGeneration: 1,
      cancelEpoch: 0,
    };
    await addon.approvalRoundTrip!({
      ...bound,
      kind: 'begin',
      durationMs: 60_000,
      mainPid: 100,
      mainProcessStartTime: '100',
      mainImageIdentity: digest('a'),
    });
    const socket = sockets[0]!;
    const request = decodeComputerUseNativeFrame(socket.writes.at(-1)!);
    const send = (patch: object) =>
      socket.emit(
        'data',
        encodeComputerUseNativeFrame({
          ...request,
          messageType: 'approval_round_trip_event',
          metadata: Buffer.from(
            JSON.stringify({
              ...bound,
              kind: 'event',
              sequence: 2,
              state: 'active',
              foreground: 'target',
              failureReason: 'none',
              failureLatched: false,
              ...patch,
            }),
          ),
        }),
      );
    send({ roundTripId: 'stale' });
    send({});
    send({ sequence: 1 });
    send({});
    // Ordering faults reach Main's round-trip owner rather than being silently discarded.
    expect(received).toHaveBeenCalledTimes(3);
    send({ sequence: 3, state: 'failed', failureReason: 'expired', failureLatched: true });
    send({ sequence: 4, state: 'ended' });
    expect(received).toHaveBeenCalledTimes(4);
    expect(received.mock.calls[3]![0].failureReason).toBe('expired');
    await expect(startSession(host, session.sessionId, 'turn-1')).rejects.toThrow(
      'native_interaction_revoked',
    );
    await host.cancel(session, 1);
    await host.close(session);
  });

  describe('P3d acknowledgement ordering', () => {
    const tripBinding = (sessionId: string) => ({
      version: 1,
      sessionId,
      taskId: 'task-1',
      turnId: 'turn-1',
      helperGeneration: 1,
      cancelEpoch: 0,
    });
    const tripEvent = (sessionId: string, roundTripId: string, patch: object = {}) => ({
      ...tripBinding(sessionId),
      roundTripId,
      kind: 'event',
      sequence: 2,
      state: 'active',
      foreground: 'target',
      failureReason: 'none',
      failureLatched: false,
      ...patch,
    });
    const emitEvent = (
      messageType: 'background_interaction_event' | 'approval_round_trip_event',
      sessionId: string,
      value: unknown,
    ) => {
      const socket = sockets[0]!;
      const request = socket.writes
        .map(decodeComputerUseNativeFrame)
        .find((frame) => JSON.parse(frame.metadata.toString())['sessionId'] === sessionId)!;
      socket.emit(
        'data',
        encodeComputerUseNativeFrame({
          ...request,
          messageType,
          metadata: Buffer.from(JSON.stringify(value)),
          binary: Buffer.alloc(0),
        }),
      );
    };
    const beginInput = (sessionId: string, roundTripId: string) => ({
      ...tripBinding(sessionId),
      roundTripId,
      kind: 'begin',
      durationMs: 60_000,
      mainPid: 100,
      mainProcessStartTime: '100',
      mainImageIdentity: digest('a'),
    });
    const beginResponder =
      (accepted: () => boolean, after?: (metadata: Record<string, unknown>) => void): Responder =>
      (metadata) => {
        const {
          operation: _operation,
          durationMs: _duration,
          mainPid: _pid,
          mainProcessStartTime: _start,
          mainImageIdentity: _image,
          ...binding
        } = metadata;
        // Queued before the response is written: it is read before the call's continuation runs.
        if (after !== undefined) queueMicrotask(() => after(metadata));
        const ok = accepted();
        return [
          'approval_round_trip_begin_result',
          {
            ...binding,
            kind: 'begin_result',
            accepted: ok,
            failureReason: ok ? 'none' : 'invalid_state',
            failureLatched: false,
          },
        ];
      };

    it('BG03_lost_event_cannot_bypass_epoch: an event read with the start response is held until bind', async () => {
      const base = responders();
      const { host, addon, helper } = createTarget({
        ...base,
        start_session: (metadata) => {
          queueMicrotask(() =>
            emitEvent('background_interaction_event', String(metadata['sessionId']), {
              version: 1,
              kind: 'background_event',
              sessionId: metadata['sessionId'],
              taskId: 'task-1',
              turnId: 'turn-1',
              helperGeneration: 1,
              cancelEpoch: 0,
              interactionEpoch: 1,
              sequence: 1,
              state: 'takeover',
            }),
          );
          return base['start_session']!(metadata);
        },
      });
      const received = vi.fn();
      host.subscribeWindowsInteraction?.(received);
      const session = await startSession(host, 'coalesced-start', 'turn-1');
      expect(received).toHaveBeenCalledTimes(1);
      await expect(
        Promise.resolve(
          addon.dispatch!({
            sessionId: session.sessionId,
            requestId: 'after-coalesced',
            cancelEpoch: 0,
            type: 'click',
            ticket: digest('d'),
          }),
        ),
      ).rejects.toThrow('native_interaction_revoked');
      expect(helper().served).not.toContain('dispatch');
      await host.cancel(session, 1);
      await host.close(session);
    });

    it('RT_begin_ack_precedes_focus_exception: a refused or failed begin rolls the trip id back', async () => {
      let accept = false;
      const { host, addon, helper } = createTarget({
        ...responders(),
        approval_round_trip_begin: beginResponder(
          () => accept,
          (metadata) =>
            accept &&
            emitEvent(
              'approval_round_trip_event',
              String(metadata['sessionId']),
              tripEvent(String(metadata['sessionId']), String(metadata['roundTripId'])),
            ),
        ),
      });
      const received = vi.fn();
      host.subscribeWindowsInteraction?.(received);
      const session = await startSession(host, 'trip-rollback', 'turn-1');
      await expect(
        addon.approvalRoundTrip!(beginInput(session.sessionId, 'trip-1')),
      ).rejects.toThrow('Round trip begin refused');
      emitEvent(
        'approval_round_trip_event',
        session.sessionId,
        tripEvent(session.sessionId, 'trip-1'),
      );
      helper().refuse('approval_round_trip_begin');
      await expect(
        addon.approvalRoundTrip!(beginInput(session.sessionId, 'trip-2')),
      ).rejects.toThrow();
      helper().allow('approval_round_trip_begin');
      expect(received).not.toHaveBeenCalled();
      accept = true;
      // The event coalesced with this begin_result is delivered once the id is committed.
      await expect(
        addon.approvalRoundTrip!(beginInput(session.sessionId, 'trip-3')),
      ).resolves.toMatchObject({ accepted: true, roundTripId: 'trip-3' });
      expect(received).toHaveBeenCalledTimes(1);
      expect(received.mock.calls[0]![0]).toMatchObject({ roundTripId: 'trip-3', state: 'active' });
      await host.cancel(session, 1);
      await host.close(session);
    });

    it('BG03_lost_event_cannot_bypass_epoch: a throwing listener fails its session closed, not the transport', async () => {
      const { host, addon } = createTarget({
        ...responders(),
        approval_round_trip_begin: beginResponder(() => true),
      });
      const session = await startSession(host, 'listener-throws', 'turn-1');
      const other = await startSession(host, 'listener-other', 'turn-1');
      await addon.approvalRoundTrip!(beginInput(session.sessionId, 'trip-1'));
      host.subscribeWindowsInteraction?.(() => {
        throw new Error('renderer is gone');
      });
      emitEvent(
        'approval_round_trip_event',
        session.sessionId,
        tripEvent(session.sessionId, 'trip-1'),
      );
      expect(sockets[0]!.destroyed).toBe(false);
      await expect(observeThroughTransport(addon, session.sessionId)).resolves.toBe('rejected');
      await expect(observeThroughTransport(addon, other.sessionId)).resolves.toBe('resolved');
      await host.cancel(session, 1);
      await host.close(session);
      await host.close(other);
    });
  });

  it.each([
    null,
    { kind: 'unknown', backgroundCapabilityVersion: null },
    { kind: 'foreground', backgroundCapabilityVersion: 1 },
    { kind: 'background', backgroundCapabilityVersion: 2 },
    { kind: 'background', backgroundCapabilityVersion: 1 },
  ])('P2a refuses malformed or gated background session shape %j', async (inputSession) => {
    const base = responders();
    const { host } = createTarget({
      ...base,
      stop_pending_start: (metadata) => base['close_session']!({ ...metadata, cancelEpoch: 1 }),
      start_session: (metadata) => {
        const [type, value] = base['start_session']!(metadata);
        return [type, { ...(value as object), inputSession }];
      },
    });
    await expect(startSession(host, 'p2a-rejected', 'turn-1')).rejects.toThrow(
      'native_session_invalid',
    );
  });

  it.each(['read-failure', 'retry-exception'] as const)(
    'PR10 sends existing-helper Stop despite %s and refuses new work',
    async (failure) => {
      let failed = false;
      const read = vi.fn(() => {
        if (failed) throw new Error('synthetic read failure');
        return { rows: [], quarantines: [] };
      });
      const base = responders();
      const target = createTarget(
        {
          ...base,
          stop_pending_start: (metadata) => base['close_session']!({ ...metadata, cancelEpoch: 1 }),
        },
        undefined,
        {
          windowsKillStopTermination: { enabled: true },
          windowsLedger: {
            read,
            write: () => true,
            update: () => true,
            delete: () => true,
            restoreQuarantines: () => true,
          },
        },
      );
      await target.addon.startSession!({ profile, sessionId: 'keeper' });
      failed = true;
      const original = stopKernel.decideWindowsStop;
      const decide = vi.spyOn(stopKernel, 'decideWindowsStop');
      if (failure === 'retry-exception') {
        decide.mockImplementation((state, event) => {
          if (event.kind === 'store_unreadable') throw new Error('synthetic retry failure');
          return original(state, event);
        });
      }
      try {
        await expect(
          target.addon.startSession!({ profile, sessionId: 'blocked-first' }),
        ).rejects.toThrow();
        await expect(
          target.addon.startSession!({ profile, sessionId: 'keeper' }),
        ).rejects.toThrow();
        await expect(
          target.addon.discoverWindows!({ ...profile, discoveryId: 'blocked' }),
        ).rejects.toThrow();
        const readsBeforeStop = read.mock.calls.length;
        await expect(
          target.addon.cancel!({ sessionId: 'keeper', cancelEpoch: 1 }),
        ).resolves.toBeDefined();
        await expect(
          target.addon.stopPendingStart!({ sessionId: 'keeper' }),
        ).resolves.toBeDefined();
        await expect(
          target.addon.close!({ sessionId: 'keeper', cancelEpoch: 1 }),
        ).resolves.toBeDefined();
        expect(target.helper().served).toEqual(
          expect.arrayContaining(['cancel', 'stop_pending_start', 'close_session']),
        );
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(read).toHaveBeenCalledTimes(readsBeforeStop);
        await expect(target.addon.startSession!({ profile, sessionId: 'new' })).rejects.toThrow();
        expect(
          target.helper().served.filter((operation) => operation === 'start_session'),
        ).toHaveLength(1);
        expect(target.helper().served).not.toContain('list_windows_cancellable');
      } finally {
        decide.mockRestore();
      }
    },
  );

  it('PR10 does not launch a helper for Stop when the store is unreadable', async () => {
    const target = createTarget(responders(), undefined, {
      windowsKillStopTermination: { enabled: true },
      windowsLedger: {
        read: () => {
          throw new Error('synthetic read failure');
        },
        write: () => true,
        update: () => true,
        delete: () => true,
        restoreQuarantines: () => true,
      },
    });
    await expect(
      target.addon.cancel!({ sessionId: 'old-session', cancelEpoch: 1 }),
    ).rejects.toThrow('native_stop_unconfirmed');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('PR10 refuses Stop without reconnecting when the helper exits during prepare', async () => {
    const target = createTarget(responders());
    const prepare = vi.fn(async (operation?: 'work' | 'stop_existing_helper') => {
      if (operation === 'stop_existing_helper') {
        children[0]!.emit('exit', 0, null);
        await Promise.resolve();
      }
    });
    target.addon.configureWindowsTermination!({
      prepare,
      started: () => undefined,
      event: () => undefined,
      exited: () => undefined,
    });
    await target.addon.startSession!({ profile, sessionId: 'keeper' });
    await expect(target.addon.cancel!({ sessionId: 'keeper', cancelEpoch: 1 })).rejects.toThrow(
      'native_stop_unconfirmed',
    );
    expect(prepare).toHaveBeenLastCalledWith('stop_existing_helper');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(1);
  });

  it('PR10 keeps termination disabled by default even with a ledger', () => {
    const configure = vi.fn();
    createTarget(
      responders(),
      undefined,
      {
        windowsLedger: {
          write: () => true,
          update: () => true,
          delete: () => true,
          restoreQuarantines: () => true,
        },
      },
      (addon) => ({ ...addon, configureWindowsTermination: configure }),
    );
    expect(configure).not.toHaveBeenCalled();
  });

  it.each(['timeout', 'write-callback', 'write-throw'] as const)(
    'PR10 picker %s reports kill_requested before finally completed',
    async (failure) => {
      const child = new ControlledHelperChild();
      vi.mocked(spawn).mockImplementationOnce(
        () => child as unknown as NodeChildProcess.ChildProcess,
      );
      const target = createTarget({
        ...responders(),
        pick_application: () => ['probe_result', null],
      });
      const order: string[] = [];
      const completed = vi.fn(() => {
        order.push('completed');
      });
      target.addon.configureWindowsTermination!({
        prepare: async () => undefined,
        started: () => undefined,
        owned: (_generation, kind) => (kind === 'picker' ? 'picker-lifetime' : undefined),
        completed,
        event: (_generation, kind) => {
          order.push(kind);
        },
        exited: () => undefined,
      });
      await target.addon.startSession!({ profile, sessionId: 'keeper' });
      target.helper().holdOnly('pick_application');
      const socket = sockets[0]!;
      if (failure === 'write-callback') socket.holdWriteCallbacks = true;
      const write =
        failure === 'write-throw'
          ? vi.spyOn(socket, 'write').mockImplementation(() => {
              throw new Error('synthetic write failure');
            })
          : undefined;
      try {
        const picking = expect(
          target.addon.pickApplication!({
            activationToken: 'synthetic',
            pickerKind: 'application',
          }),
        ).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(0);
        if (failure === 'timeout') await vi.advanceTimersByTimeAsync(5 * 60_000);
        if (failure === 'write-callback')
          socket.writeCallbacks.at(-1)!(new Error('synthetic write failure'));
        await picking;
        expect(order.indexOf('kill_requested')).toBeGreaterThanOrEqual(0);
        expect(order.indexOf('completed')).toBeGreaterThan(order.indexOf('kill_requested'));
        expect(completed).toHaveBeenCalledExactlyOnceWith(
          1,
          'picker',
          expect.any(String),
          'picker-lifetime',
        );
        expect(child.killCalls).toBe(1);
      } finally {
        write?.mockRestore();
        child.emit('exit', 0, null);
      }
    },
  );

  const startIdentity = { pid: 42, processStartTime: '133000000000000001' };
  function identityStartTarget(
    control: {
      v2?: boolean;
      identity?: Record<string, unknown>;
      check?: Record<string, unknown>;
      write?: (row: WindowsLedgerRow) => boolean | Promise<boolean>;
      response?: Responder;
      capability?: boolean;
      enabled?: boolean;
      holdStart?: boolean;
      remove?: () => boolean;
      termination?: boolean;
      adapt?: (addon: ComputerUseNativeAddon) => ComputerUseNativeAddon;
    } = {},
  ) {
    const eligibility = control.v2
      ? {
          mode: 'v2-denylist' as const,
          rulesetVersion: DENY_RULESET.platforms.win32.rulesetVersion,
          classifierVersion: 1,
          lexiconVersion: 1,
          ticketRequired: true,
        }
      : undefined;
    const order: string[] = [];
    const rows: WindowsLedgerRow[] = [];
    const quarantines: WindowsTargetQuarantine[] = [];
    const requests: Record<string, unknown>[] = [];
    const base = responders();
    const target = createTarget(
      {
        ...base,
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
        handshake: () => [
          'handshake_result',
          {
            protocolVersion: 1,
            apiVersion: 3,
            platform: 'win32',
            napiVersion: 10,
            sourceCommit,
            ...(eligibility === undefined ? {} : { eligibility }),
            capabilities: {
              cancellableWindowDiscovery: true,
              identityBoundStart: control.capability ?? true,
            },
          },
        ],
        list_windows: (metadata) => {
          order.push('discovery');
          requests.push(metadata);
          const [, candidates] = base['list_windows']!({});
          return [
            'probe_result',
            (candidates as Record<string, unknown>[]).map((row) => ({
              ...row,
              ...(control.identity ?? startIdentity),
            })),
          ];
        },
        check_target_identity: (metadata) => {
          order.push('check');
          requests.push(metadata);
          return ['target_identity_result', { results: [control.check ?? { result: 'alive' }] }];
        },
        start_session: (metadata) => {
          order.push('start');
          requests.push(metadata);
          if (control.response) return control.response(metadata);
          const [, result] = base['start_session']!(metadata);
          order.push('foreground');
          return [
            'probe_result',
            {
              ...(result as object),
              ...startIdentity,
              startResult: { ...startIdentity, attemptCount: 1, foregroundResult: 'confirmed' },
            },
          ];
        },
      },
      (helper) => {
        if (control.holdStart) helper.holdOnly('start_session');
      },
      {
        windowsStartIdentity: { enabled: control.enabled !== false },
        effectiveEligibilityMode: () => (control.v2 ? 'v2-denylist' : 'v1-allowlist'),
        ...(control.termination ? { windowsKillStopTermination: { enabled: true as const } } : {}),
        windowsLedger: {
          write: async (row) => {
            order.push('write');
            const ok = await (control.write?.(row) ?? true);
            if (ok) rows.push(row);
            order.push('stored');
            return ok;
          },
          update: (row) => {
            const i = rows.findIndex((r) => r.requestId === row.requestId);
            if (i >= 0) rows[i] = row;
            return true;
          },
          delete: (row) => {
            order.push('delete');
            if (control.remove?.() === false) return false;
            const i = rows.findIndex((r) => r.requestId === row.requestId);
            if (i >= 0) rows.splice(i, 1);
            return true;
          },
          restoreQuarantines: () => true,
          transferReceipt: (removed, isolated) => {
            for (const row of removed) {
              const i = rows.findIndex((r) => r.requestId === row.requestId);
              if (i >= 0) rows.splice(i, 1);
            }
            quarantines.push(...isolated);
            return true;
          },
        },
      },
      control.adapt ?? ((addon) => addon),
      control.capability ?? true,
      eligibility,
    );
    return { ...target, rows, order, requests, quarantines };
  }

  it.each(['v1', 'v2'] as const)(
    'PR5b Host %s binds new and existing starts before foreground',
    async (classifierRoute) => {
      const target = identityStartTarget({ v2: classifierRoute === 'v2' });
      const input = {
        profile,
        windowId: '100',
        sessionId: 'identity-start',
        taskId: 'task-1',
        turnId: 'turn-a',
        cancelEpoch: 0,
        classifierRoute,
      };
      const first = await target.host.startSession(input);
      expect(target.order).toEqual([
        'discovery',
        'discovery',
        'check',
        'write',
        'stored',
        'start',
        'foreground',
        'delete',
      ]);
      expect(JSON.stringify(first)).not.toMatch(/processStartTime|133000000000000001|startResult/);
      target.order.length = 0;
      const second = await target.host.startSession({ ...input, resume: true });
      expect(target.order).toEqual(['write', 'stored', 'start', 'foreground', 'delete']);
      expect(JSON.stringify(second)).not.toMatch(/processStartTime|133000000000000001|startResult/);
      expect(target.rows).toEqual([]);
      expect(
        target.requests
          .filter((r) => r['operation'] === 'list_windows_cancellable')
          .every((r) => r['includeStartIdentity'] === true),
      ).toBe(true);
      expect(
        target.requests.find((r) => r['operation'] === 'check_target_identity')?.['targets'],
      ).toEqual([startIdentity]);
      // The first start's evidence is never stored and re-sent by the existing-session start.
      expect(
        target.requests.filter((r) => r['operation'] === 'start_session' && 'startResult' in r),
      ).toEqual([]);
      expect(target.requests.filter((r) => r['operation'] === 'start_session')).toEqual([
        expect.objectContaining({
          pid: 42,
          requireStartIdentity: true,
          expectedProcessStartTime: startIdentity.processStartTime,
        }),
        expect.objectContaining({
          pid: 42,
          requireStartIdentity: true,
          expectedProcessStartTime: startIdentity.processStartTime,
        }),
      ]);
    },
  );
  it.each([
    { identity: { pid: 42 } },
    { identity: { pid: 42, processStartTime: '0' } },
    { identity: { pid: 42, processStartTime: 123 } },
    { identity: { pid: undefined, processStartTime: '133000000000000001' } },
    { identity: { pid: -1, processStartTime: '133000000000000001' } },
    { check: { result: 'terminated', reason: 'start_time_mismatch' } },
    { check: { result: 'unverifiable', reason: 'access_denied' } },
    { capability: false },
    { write: () => false },
  ])('PR5b Host refuses unsafe new starts %j', async (control) => {
    const target = identityStartTarget(control);
    await expect(startSession(target.host, 'identity-denied', 'turn-a')).rejects.toThrow(
      'native_unavailable',
    );
    expect(target.order).not.toContain('start');
    expect(target.order).not.toContain('foreground');
  });

  it.each(
    ['failure', 'identity', 'window', 'missing', 'counter', 'evidence'].flatMap((mode) =>
      [false, true].map((existing) => ({ mode, existing })),
    ),
  )('PR5b Host R23 retains and pauses on $mode existing=$existing', async ({ mode, existing }) => {
    let fail = !existing;
    const base = responders();
    const target = identityStartTarget({
      response: (metadata) => {
        const [, raw] = base['start_session']!(metadata);
        if (!fail)
          return [
            'probe_result',
            {
              ...(raw as object),
              ...startIdentity,
              startResult: { ...startIdentity, attemptCount: 1, foregroundResult: 'confirmed' },
            },
          ];
        if (mode === 'failure')
          return [
            'error',
            {
              code: 'STALE_WINDOW',
              accepted: false,
              startResult: { ...startIdentity, attemptCount: 1, foregroundResult: 'unconfirmed' },
            },
          ];
        return [
          'probe_result',
          {
            ...(raw as object),
            ...startIdentity,
            ...(mode === 'identity' ? { processStartTime: '133000000000000002' } : {}),
            ...(mode === 'window' ? { windowIdentityDigest: digest('d') } : {}),
            ...(mode === 'counter' ? { inputAttemptCount: -1 } : {}),
            ...(mode === 'missing'
              ? {}
              : {
                  startResult: {
                    ...startIdentity,
                    ...(mode === 'evidence' ? { pid: 43 } : {}),
                    attemptCount: 1,
                    foregroundResult: 'confirmed',
                  },
                }),
          },
        ];
      },
    });
    if (existing) await startSession(target.host, 'r23-start', 'turn-a');
    fail = true;
    const pending = startSession(target.host, 'r23-start', 'turn-a');
    const rejected = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    {
      await rejected;
      expect(target.rows).toEqual([
        expect.objectContaining({
          kind: 'foreground',
          inputPath: 'foreground',
          state: 'effect_unconfirmed',
          identity: { pid: 42, creationTime: startIdentity.processStartTime },
        }),
      ]);
      expect(target.host.availability().state).toBe('native_unavailable');
      await expect(startSession(target.host, 'r23-next', 'turn-a')).rejects.toThrow();
      expect(target.order.filter((item) => item === 'start')).toHaveLength(existing ? 2 : 1);
      await target.host.stopPendingStart!('r23-start');
      expect(target.rows).toEqual([]);
      expect(target.quarantines).toEqual([]);
    }
  });

  it('PR5b Host deletes a verified zero-attempt refusal without isolation', async () => {
    const target = identityStartTarget({
      response: () => [
        'error',
        {
          code: 'STALE_WINDOW',
          accepted: false,
          startResult: { ...startIdentity, attemptCount: 0, foregroundResult: 'not_attempted' },
        },
      ],
    });
    await expect(startSession(target.host, 'refused-start', 'turn-a')).rejects.toThrow();
    expect(target.order).toContain('delete');
    expect(target.rows).toEqual([]);
    expect(target.quarantines).toEqual([]);
  });

  it.each(['stop', 'generation', 'delete-failed'] as const)(
    'PR5b Host cancels a saved unsent foreground row after %s',
    async (mode) => {
      let release!: (written: boolean) => void;
      const target = identityStartTarget({
        write: () =>
          new Promise<boolean>((resolve) => {
            release = resolve;
          }),
        remove: () => mode !== 'delete-failed',
      });
      const pending = startSession(target.host, 'stored-start', 'turn-a');
      const rejected = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(0);
      expect(target.order).toContain('write');
      expect(target.order).not.toContain('start');
      if (mode !== 'stop') sockets[0]!.destroy();
      else await target.host.stopPendingStart!('stored-start');
      release(true);
      await rejected;
      expect(target.order).not.toContain('start');
      expect(target.rows).toHaveLength(mode === 'delete-failed' ? 1 : 0);
      expect(target.quarantines).toEqual([]);
    },
  );

  it('PR5b Host keeps the default path free of identity checks and foreground writes', async () => {
    const target = identityStartTarget({ enabled: false, capability: false });
    await startSession(target.host, 'legacy-start', 'turn-a');
    expect(target.order).not.toContain('check');
    expect(target.order).not.toContain('write');
    expect(
      target.requests.every(
        (r) => !('requireStartIdentity' in r) && !('includeStartIdentity' in r),
      ),
    ).toBe(true);
  });

  it('PR5b Host rejects a new helper after identity verification', async () => {
    const target = identityStartTarget({
      adapt: (addon) => ({
        ...addon,
        checkTargetIdentity: async (...args) => {
          const result = await addon.checkTargetIdentity!(...args);
          sockets[0]!.destroy();
          return result;
        },
      }),
    });
    await expect(startSession(target.host, 'checked-old-generation', 'turn-a')).rejects.toThrow();
    expect(target.order).not.toContain('start');
    expect(target.rows).toEqual([]);
  });

  it.each(['storage', 'capability', 'checker', 'callbacks'] as const)(
    'PR5b Host refuses missing %s without fallback',
    async (missing) => {
      const write = vi.fn(() => true);
      const target = createTarget(
        responders(),
        undefined,
        {
          windowsStartIdentity: { enabled: true },
          ...(missing === 'storage'
            ? {}
            : {
                windowsLedger: {
                  write,
                  update: () => true,
                  delete: () => true,
                  restoreQuarantines: () => true,
                },
              }),
        },
        (addon) => {
          if (missing === 'checker') {
            const { checkTargetIdentity, ...remaining } = addon;
            void checkTargetIdentity;
            return remaining;
          }
          if (missing === 'callbacks') {
            const { dispatchLedgerSupported, ...remaining } = addon;
            void dispatchLedgerSupported;
            return remaining;
          }
          return addon;
        },
        missing === 'capability' ? undefined : true,
      );
      await expect(startSession(target.host, 'missing-contract', 'turn-a')).rejects.toThrow(
        'native_unavailable',
      );
      expect(write).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it('PR5b Host refuses storage completion after the helper exits', async () => {
    let release!: (written: boolean) => void;
    const target = identityStartTarget({
      termination: true,
      write: () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    });
    const pending = startSession(target.host, 'exit-during-write', 'turn-a');
    const rejected = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(target.order).toContain('write');
    children[0]!.emit('exit', 1, null);
    release(true);
    await rejected;
    expect(target.order).not.toContain('start');
    expect(target.rows).toEqual([]);
    expect(target.quarantines).toEqual([]);
  });

  it.each([false, true])(
    'PR5b Host retains a lost start until exit cleanup enabled=%s',
    async (termination) => {
      const target = identityStartTarget({ holdStart: true, termination });
      const pending = startSession(target.host, 'lost-start', 'turn-a');
      const rejected = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(0);
      expect(target.rows).toHaveLength(1);
      vi.spyOn(children[0]!, 'kill').mockReturnValue(true);
      sockets[0]!.emit('error', new Error('synthetic transport failure'));
      await rejected;
      expect(target.rows).toHaveLength(1);
      expect(target.rows[0]?.state).toBe('effect_unconfirmed');
      expect(target.host.availability().state).toBe('native_unavailable');
      if (termination) {
        children[0]!.emit('exit', 1, null);
        await vi.advanceTimersByTimeAsync(0);
        expect(target.rows).toEqual([]);
      }
      expect(target.quarantines).toEqual([]);
    },
  );

  // R23 foreground rows create no core hold (K-4); the Host must settle them without a
  // retry_storage for a hold the core never created, and release its own write bookkeeping.
  function observeForegroundSettlement() {
    const errors: unknown[] = [];
    const retries: unknown[] = [];
    let latest: stopKernel.WindowsStopState | undefined;
    const inputs: [stopKernel.WindowsStopEvent['kind'], stopKernel.WindowsStopState][] = [];
    const original = stopKernel.decideWindowsStop;
    const decide = vi.spyOn(stopKernel, 'decideWindowsStop').mockImplementation((state, event) => {
      if (event.kind === 'retry_storage') retries.push(event);
      inputs.push([event.kind, state]);
      try {
        const decision = original(state, event);
        latest = decision.state;
        return decision;
      } catch (error) {
        errors.push(error);
        throw error;
      }
    });
    let closeLedger: WindowsCloseCallbacks | undefined;
    const idle = vi.fn();
    const adapt = (addon: ComputerUseNativeAddon): ComputerUseNativeAddon => ({
      ...addon,
      configureCloseLedger: (callbacks) => {
        closeLedger = callbacks;
        addon.configureCloseLedger!(callbacks);
      },
      reevaluateIdle: () => {
        idle();
        addon.reevaluateIdle!();
      },
    });
    return {
      adapt,
      errors,
      retries,
      idle,
      // The Host reflects foreground writes outside the reducer; a later event shows its state.
      inputTo: (kind: stopKernel.WindowsStopEvent['kind']) =>
        inputs.filter(([seen]) => seen === kind).at(-1)?.[1],
      holds: () => latest?.holds ?? [],
      blocked: (generation: number) => closeLedger!.blocked(generation),
      restore: () => decide.mockRestore(),
    };
  }

  it.each(['success', 'zero-attempt', 'cancel', 'lost'] as const)(
    'PR5b Host settles the foreground row and releases idle teardown after %s',
    async (mode) => {
      const seen = observeForegroundSettlement();
      try {
        let generation = 0;
        let release: ((written: boolean) => void) | undefined;
        const target = identityStartTarget({
          adapt: seen.adapt,
          holdStart: mode === 'lost',
          termination: mode === 'lost',
          write: (row) => {
            generation = row.helperGeneration;
            if (mode !== 'cancel') return true;
            return new Promise<boolean>((resolve) => {
              release = resolve;
            });
          },
          ...(mode === 'zero-attempt'
            ? {
                response: () => [
                  'error',
                  {
                    code: 'STALE_WINDOW',
                    accepted: false,
                    startResult: {
                      ...startIdentity,
                      attemptCount: 0,
                      foregroundResult: 'not_attempted',
                    },
                  },
                ],
              }
            : {}),
        });
        const pending = startSession(target.host, 'settled-start', 'turn-a');
        if (mode === 'success') await pending;
        else {
          const rejected = expect(pending).rejects.toThrow();
          await vi.advanceTimersByTimeAsync(0);
          if (mode === 'cancel') {
            await target.host.stopPendingStart!('settled-start');
            release!(true);
          }
          if (mode === 'lost') {
            vi.spyOn(children[0]!, 'kill').mockReturnValue(true);
            sockets[0]!.emit('error', new Error('synthetic transport failure'));
          }
          await rejected;
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(generation).toBeGreaterThan(0);
        expect(seen.errors).toEqual([]);
        expect(seen.retries).toEqual([]);
        expect(seen.holds()).toEqual([]);
        if (mode === 'lost') {
          // R23 keeps the unconfirmed row in memory and storage until receipt or exit.
          expect(target.rows).toEqual([
            expect.objectContaining({ kind: 'foreground', state: 'effect_unconfirmed' }),
          ]);
          expect(seen.blocked(generation)).toBe(true);
          children[0]!.emit('exit', 1, null);
          await vi.advanceTimersByTimeAsync(0);
          expect(seen.inputTo('exit_confirmed')?.rows).toEqual([
            expect.objectContaining({ kind: 'foreground', state: 'effect_unconfirmed' }),
          ]);
          expect(seen.errors).toEqual([]);
          expect(seen.retries).toEqual([]);
        }
        // blocked() reads the Host's in-memory rows, holds, blockers and pending writes.
        expect(target.rows).toEqual([]);
        expect(seen.blocked(generation)).toBe(false);
        expect(seen.idle).toHaveBeenCalled();
      } finally {
        seen.restore();
      }
    },
  );

  it('PR5b Host keeps a failed foreground delete blocked until its retry succeeds', async () => {
    const seen = observeForegroundSettlement();
    try {
      let generation = 0;
      let removable = false;
      const target = identityStartTarget({
        adapt: seen.adapt,
        write: (row) => {
          generation = row.helperGeneration;
          return true;
        },
        remove: () => removable,
      });
      await startSession(target.host, 'retry-start', 'turn-a');
      await vi.advanceTimersByTimeAsync(0);
      expect(seen.errors).toEqual([]);
      expect(target.rows).toHaveLength(1);
      expect(seen.blocked(generation)).toBe(true);
      // A failed retry stays blocked; it never asks the core for a hold it did not create.
      await target.host.listTargets!().catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(seen.blocked(generation)).toBe(true);
      removable = true;
      await target.host.listTargets!().catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(seen.errors).toEqual([]);
      expect(seen.retries).toEqual([]);
      expect(target.rows).toEqual([]);
      expect(seen.blocked(generation)).toBe(false);
    } finally {
      seen.restore();
    }
  });

  const helperTempVariable = 'SPRINT_CODER_COMPUTER_USE_HELPER_TEMP';
  const startCallbacks = (): WindowsStartCallbacks => ({
    beforeWrite: vi.fn(async () => undefined),
    assertSend: vi.fn(),
    canceled: vi.fn(async () => undefined),
    unconfirmed: vi.fn(),
    startResponse: vi.fn(async () => undefined),
  });

  it('PR5b waits for start storage before sending and delivers the bound result', async () => {
    const target = createTarget();
    const callbacks = startCallbacks();
    let stored!: () => void;
    vi.mocked(callbacks.beforeWrite).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          stored = resolve;
        }),
    );
    const result = Promise.resolve(
      target.addon.startSession!({ sessionId: 'start-storage', profile }, undefined, callbacks),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.beforeWrite).toHaveBeenCalledWith(1, expect.stringMatching(/^[a-f0-9]{32}$/u));
    expect(target.helper().served).not.toContain('start_session');
    stored();
    const response = await result;
    expect(callbacks.assertSend).toHaveBeenCalledOnce();
    expect(callbacks.startResponse).toHaveBeenCalledWith(response, true);
    expect(callbacks.canceled).not.toHaveBeenCalled();
  });

  it.each(['storage', 'gate', 'stop', 'generation'] as const)(
    'PR5b cancels an unsent start after %s failure',
    async (failure) => {
      const target = createTarget();
      const callbacks = startCallbacks();
      let stored!: () => void;
      vi.mocked(callbacks.beforeWrite).mockImplementation(
        () =>
          new Promise<void>((resolve, reject) => {
            stored = () =>
              failure === 'storage' ? reject(new Error('storage failed')) : resolve();
          }),
      );
      if (failure === 'gate')
        vi.mocked(callbacks.assertSend).mockImplementation(() => {
          throw new Error('owner changed');
        });
      const result = Promise.resolve(
        target.addon.startSession!({ sessionId: 'unsent-start', profile }, undefined, callbacks),
      ).then(
        () => 'sent',
        () => 'refused',
      );
      await vi.advanceTimersByTimeAsync(0);
      if (failure === 'stop') target.addon.cancelUnsubmittedStart?.('unsent-start');
      if (failure === 'generation') sockets[0]!.emit('close');
      stored();
      expect(await result).toBe('refused');
      expect(target.helper().served).not.toContain('start_session');
      expect(callbacks.canceled).toHaveBeenCalledOnce();
      expect(callbacks.startResponse).not.toHaveBeenCalled();
    },
  );

  it('PR5b delivers foreground evidence on start errors only to the Main callback', async () => {
    const evidence = {
      pid: 42,
      processStartTime: '133000000000000001',
      attemptCount: 1,
      foregroundResult: 'unconfirmed',
    };
    const target = createTarget({
      ...responders(),
      start_session: () => [
        'error',
        {
          code: 'START_FAILED',
          accepted: false,
          startResult: evidence,
        },
      ],
    });
    const callbacks = startCallbacks();
    const error = await Promise.resolve(
      target.addon.startSession!({ sessionId: 'failed-start', profile }, undefined, callbacks),
    ).catch((value: unknown) => value);
    expect(callbacks.startResponse).toHaveBeenCalledWith(
      {
        code: 'START_FAILED',
        accepted: false,
        startResult: evidence,
      },
      false,
    );
    expect(error).toMatchObject({ code: 'START_FAILED', accepted: false });
    expect(error).not.toHaveProperty('startResult');
    expect(JSON.stringify(error)).not.toContain(evidence.processStartTime);
    expect(callbacks.canceled).not.toHaveBeenCalled();
  });

  it('PR5b refuses a start when its result cannot be recorded', async () => {
    const target = createTarget();
    const callbacks = startCallbacks();
    vi.mocked(callbacks.startResponse).mockRejectedValue(new Error('result write failed'));
    await expect(
      target.addon.startSession!({ sessionId: 'result-write', profile }, undefined, callbacks),
    ).rejects.toThrow('result write failed');
    expect(callbacks.unconfirmed).toHaveBeenCalledWith('abortTransport');
    expect(callbacks.canceled).not.toHaveBeenCalled();
  });

  it('PR5b reports a lost start response as unconfirmed, never canceled', async () => {
    const target = createTarget(responders(), (helper) => helper.holdOnly('start_session'));
    const callbacks = startCallbacks();
    const result = Promise.resolve(
      target.addon.startSession!({ sessionId: 'lost-start', profile }, undefined, callbacks),
    ).catch(() => 'lost');
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.emit('close');
    expect(await result).toBe('lost');
    expect(callbacks.unconfirmed).toHaveBeenCalled();
    expect(callbacks.canceled).not.toHaveBeenCalled();
    expect(callbacks.startResponse).not.toHaveBeenCalled();
  });

  it.each([true, false])('PR5b waits for result storage on start success=%s', async (succeeded) => {
    const base = responders();
    const target = createTarget({
      ...base,
      start_session: (metadata) =>
        succeeded
          ? base['start_session']!(metadata)
          : ['error', { code: 'START_FAILED', accepted: false }],
    });
    const callbacks = startCallbacks();
    let recorded!: () => void;
    vi.mocked(callbacks.startResponse).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          recorded = resolve;
        }),
    );
    let settled = false;
    const result = Promise.resolve(
      target.addon.startSession!({ sessionId: 'pending-result', profile }, undefined, callbacks),
    ).then(
      () => {
        settled = true;
        return true;
      },
      () => {
        settled = true;
        return false;
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.startResponse).toHaveBeenCalledWith(expect.any(Object), succeeded);
    expect(settled).toBe(false);
    recorded();
    expect(await result).toBe(succeeded);
  });

  it('PR5b waits for unsent cancellation storage without synthesizing a response', async () => {
    const target = createTarget();
    const callbacks = startCallbacks();
    vi.mocked(callbacks.assertSend).mockImplementation(() => {
      throw new Error('stopped');
    });
    let canceled!: () => void;
    vi.mocked(callbacks.canceled).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          canceled = resolve;
        }),
    );
    let settled = false;
    const result = Promise.resolve(
      target.addon.startSession!({ sessionId: 'pending-cancel', profile }, undefined, callbacks),
    ).catch(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(callbacks.canceled).toHaveBeenCalledOnce();
    expect(target.helper().served).not.toContain('start_session');
    canceled();
    await result;
    expect(settled).toBe(true);
    expect(callbacks.startResponse).not.toHaveBeenCalled();
    expect(callbacks.unconfirmed).not.toHaveBeenCalled();
  });

  it('PR5b refuses an identity-bound start when the connected helper has no capability', async () => {
    const target = createTarget();
    await expect(
      target.addon.startSession!({
        profile,
        sessionId: 'identity-start',
        requireStartIdentity: true,
        pid: 42,
        expectedProcessStartTime: '133000000000000001',
      }),
    ).rejects.toThrow('native_unavailable');
    expect(
      sockets
        .flatMap((socket) => socket.writes)
        .some(
          (bytes) =>
            JSON.parse(decodeComputerUseNativeFrame(bytes).metadata.toString())['operation'] ===
            'start_session',
        ),
    ).toBe(false);
  });

  it('PR5b transmits the explicit discovery identity opt-in', async () => {
    const requested = vi.fn(responders()['list_windows']!);
    const target = createTarget({ ...responders(), list_windows: requested });
    await target.addon.discoverWindows!({
      ...profile,
      discoveryId: 'identity-discovery',
      includeStartIdentity: true,
    });
    expect(requested).toHaveBeenCalledWith(expect.objectContaining({ includeStartIdentity: true }));
  });
  it.each([false, true])('PR5b requires a true connected capability (%s)', async (enabled) => {
    const base = responders();
    const requested = vi.fn(base['start_session']!);
    const target = createTarget({
      ...base,
      handshake: () => [
        'handshake_result',
        {
          protocolVersion: 1,
          apiVersion: 3,
          platform: 'win32',
          napiVersion: 10,
          sourceCommit,
          capabilities: { cancellableWindowDiscovery: true, identityBoundStart: enabled },
        },
      ],
      start_session: requested,
    });
    const input = {
      profile,
      sessionId: 'identity-start',
      requireStartIdentity: true,
      pid: 42,
      expectedProcessStartTime: '18446744073709551615',
    };
    if (enabled) {
      await expect(target.addon.startSession!(input)).resolves.toMatchObject({
        sessionId: input.sessionId,
      });
      expect(requested).toHaveBeenCalledWith(
        expect.objectContaining({
          requireStartIdentity: true,
          pid: 42,
          expectedProcessStartTime: '18446744073709551615',
        }),
      );
    } else {
      await expect(target.addon.startSession!(input)).rejects.toThrow('native_unavailable');
      expect(requested).not.toHaveBeenCalled();
      await expect(
        target.addon.startSession!({ profile, sessionId: 'legacy-start' }),
      ).resolves.toMatchObject({ sessionId: 'legacy-start' });
      expect(requested).toHaveBeenCalledTimes(1);
      expect(requested.mock.calls[0]?.[0]).not.toHaveProperty('requireStartIdentity');
    }
  });

  it.each([undefined, false])('PR5b preserves discovery without opt-in (%s)', async (enabled) => {
    const requested = vi.fn(responders()['list_windows']!);
    const target = createTarget({ ...responders(), list_windows: requested });
    await target.addon.discoverWindows!({
      ...profile,
      discoveryId: 'legacy-discovery',
      ...(enabled === undefined ? {} : { includeStartIdentity: enabled }),
    });
    if (enabled === undefined)
      expect(requested.mock.calls[0]?.[0]).not.toHaveProperty('includeStartIdentity');
    else expect(requested.mock.calls[0]?.[0]).toHaveProperty('includeStartIdentity', false);
  });

  it.each([null, 1, 'true'])(
    'PR5b rejects malformed discovery opt-in %j before connecting',
    async (enabled) => {
      const target = createTarget();
      await expect(
        Promise.resolve().then(() =>
          target.addon.discoverWindows!({
            ...profile,
            discoveryId: 'invalid-discovery',
            includeStartIdentity: enabled,
          }),
        ),
      ).rejects.toThrow('Invalid Windows discovery input');
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it('PR5b retains integer-string discovery identity only at the Main boundary', async () => {
    const base = responders();
    const target = createTarget({
      ...base,
      list_windows: (metadata) => {
        const [type, rows] = base['list_windows']!(metadata);
        if (!Array.isArray(rows)) throw new Error('Expected fixture rows');
        return [
          type,
          rows.map((row: Record<string, unknown>) => ({
            ...row,
            processStartTime: '18446744073709551615',
          })),
        ];
      },
    });
    const result = await target.addon.discoverWindows!({
      ...profile,
      discoveryId: 'identity-discovery',
      includeStartIdentity: true,
    });
    expect(result).toMatchObject({ windows: [{ processStartTime: '18446744073709551615' }] });
    const windows = await target.host.listWindows(profile);
    expect(windows).toHaveLength(1);
    expect(JSON.stringify(windows)).not.toMatch(/processStartTime|18446744073709551615/);
  });
  it('PR4 startup discards corrupt rows, retains valid isolation and persists restoration', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ledger-restore-'));
    const path = join(directory, 'shared.sqlite');
    const store = openWindowsLedgerStore({ path, userData: 'C:\\synthetic\\restore' });
    const db = new Database(path);
    const row: WindowsLedgerRow = {
      helperGeneration: 1,
      sessionId: 'old-session',
      requestId: 'old-request',
      kind: 'semantic',
      inputPath: 'normal',
      state: 'awaiting_response',
      identity: { pid: 4242, creationTime: 'synthetic-time' },
    };
    const diagnostics: stopKernel.WindowsStopDiagnostic[] = [];
    try {
      store.write(row);
      store.write({ ...row, requestId: 'foreground', kind: 'foreground', inputPath: 'foreground' });
      const invalid = [null, {}, { ...row, state: 12 }];
      invalid.forEach((value, index) =>
        db
          .prepare('INSERT INTO ledger VALUES (?, ?, ?, ?, ?)')
          .run(store.instanceId, 1, 'corrupt-session', String(index), JSON.stringify(value)),
      );
      db.prepare('INSERT INTO quarantines (pid, creation_time, payload) VALUES (?, ?, ?)').run(
        99,
        'corrupt',
        'null',
      );
      const target = createTarget(responders(), undefined, {
        windowsLedger: store,
        windowsLedgerDiagnostic: (value) => diagnostics.push(value),
      });
      await expect(target.host.restoreWindowsLedger()).resolves.toBe(true);
      expect(diagnostics).toEqual(
        expect.arrayContaining([
          { kind: 'unknown', reason: 'invalid_format' },
          { kind: 'unknown', reason: 'missing_identity' },
          { kind: 'semantic', reason: 'invalid_format' },
          { kind: 'quarantine', reason: 'invalid_format' },
        ]),
      );
      expect(store.read()).toEqual({
        rows: [],
        quarantines: [null, { identity: row.identity, reason: 'restored' }],
      });
      expect(JSON.stringify(diagnostics)).not.toMatch(/4242|synthetic-time/);
      // R20 does not permanently isolate the host for an invalid row.
      await expect(startSession(target.host, 'unrelated-start', 'turn-a')).resolves.toMatchObject({
        sessionId: 'unrelated-start',
      });
    } finally {
      db.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('PR4 failed startup transfer holds the target until a successful retry', async () => {
    let healthy = false;
    const row: WindowsLedgerRow = {
      helperGeneration: 1,
      sessionId: 'old-session',
      requestId: 'old-request',
      kind: 'semantic',
      inputPath: 'normal',
      state: 'awaiting_response',
      identity: { pid: 4242, creationTime: 'synthetic-time' },
    };
    const transfer = vi.fn(() => healthy);
    const diagnostic = vi.fn();
    const foreground: WindowsLedgerRow = {
      ...row,
      requestId: 'foreground',
      kind: 'foreground',
      inputPath: 'foreground',
    };
    const target = createTarget(responders(), undefined, {
      windowsLedgerDiagnostic: diagnostic,
      windowsLedger: {
        write: () => true,
        update: () => true,
        delete: () => true,
        restoreQuarantines: () => true,
        transferReceipt: transfer,
        read: () => ({ rows: [row, foreground], quarantines: [] }),
      },
    });
    await expect(startSession(target.host, 'blocked-transfer', 'turn-a')).rejects.toThrow(
      'native_unavailable',
    );
    expect(spawn).not.toHaveBeenCalled();
    healthy = true;
    await expect(
      startSession(target.host, 'unrelated-after-retry', 'turn-a'),
    ).resolves.toMatchObject({ sessionId: 'unrelated-after-retry' });
    expect(transfer).toHaveBeenCalledWith(
      [row, foreground],
      [{ identity: row.identity, reason: 'restored' }],
    );
    expect(diagnostic).toHaveBeenCalledWith({
      kind: 'foreground',
      reason: 'foreground_restart_discard',
    });
  });
  it('PR4 restores another instance quarantine and denies a known-identity resume', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ledger-host-'));
    const path = join(directory, 'shared.sqlite');
    const a = openWindowsLedgerStore({ path, userData: 'C:\\synthetic\\a' });
    const b = openWindowsLedgerStore({ path, userData: 'C:\\synthetic\\b' });
    try {
      const original = responders();
      const target = createTarget(
        {
          ...original,
          start_session: (metadata) => {
            const [type, result] = original['start_session']!(metadata);
            return [
              type,
              {
                ...(result as Record<string, unknown>),
                pid: 4242,
                processStartTime: '133000000000000001',
              },
            ];
          },
        },
        undefined,
        { windowsLedger: b },
      );
      await expect(target.host.restoreWindowsLedger()).resolves.toBe(true);
      const session = await startSession(target.host, 'shared-session', 'turn-a');
      a.restoreQuarantines([
        { identity: { pid: 4242, creationTime: '133000000000000001' }, reason: 'exit_suspect' },
      ]);
      await expect(startSession(target.host, session.sessionId, 'turn-a')).rejects.toThrow(
        'native_unavailable',
      );
      expect(target.helper().served.filter((name) => name === 'start_session')).toHaveLength(1);
    } finally {
      a.close();
      b.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('PR10 refresh retains isolation committed after the shared read started', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ledger-read-race-'));
    const store = openWindowsLedgerStore({
      path: join(directory, 'shared.sqlite'),
      userData: 'C:/synthetic/read-race',
    });
    const spy = backgroundReceiptSpy();
    let finishRead: ((rows: readonly unknown[]) => void) | undefined;
    let delayRead = false;
    try {
      const target = ledgerTarget(true, undefined, true, {
        ...store,
        readQuarantines: () =>
          delayRead
            ? new Promise<readonly unknown[]>((resolve) => {
                finishRead = resolve;
              })
            : store.readQuarantines(),
      });
      const session = await startSession(target.host, 'read-race', 'turn-race');
      await startSession(target.host, 'keeper', 'turn-keeper');
      target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
      await target.dispatch(session, ledgerActions[4]);
      // Exit persistence can finish while a different entry is refreshing shared isolation.
      delayRead = true;
      const reading = target.host.restoreWindowsLedger();
      await vi.advanceTimersByTimeAsync(0);
      expect(finishRead).toBeDefined();
      children[0]!.emit('exit', 1, null);
      await vi.advanceTimersByTimeAsync(0);
      expect(store.readQuarantines()).toHaveLength(1);
      delayRead = false;
      finishRead!([]);
      await reading;
      await expect(startSession(target.host, 'after-read', 'turn-after')).rejects.toThrow(
        'native_unavailable',
      );
      expect(store.readQuarantines()).toHaveLength(1);
    } finally {
      spy.mockRestore();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('PR10 a quarantine replaced during refresh is retained until the next read', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ledger-clone-race-'));
    const store = openWindowsLedgerStore({
      path: join(directory, 'shared.sqlite'),
      userData: 'C:/synthetic/clone',
    });
    const child = new ControlledHelperChild();
    vi.mocked(spawn).mockImplementationOnce(
      () => child as unknown as NodeChildProcess.ChildProcess,
    );
    let finishRead: ((rows: readonly unknown[]) => void) | undefined;
    let delayRead = false;
    const decide = stopKernel.decideWindowsStop;
    const spy = vi.spyOn(stopKernel, 'decideWindowsStop').mockImplementation((state, event) => {
      if (event.kind === 'receipt' && event.status === 'received')
        state = {
          ...state,
          rows: state.rows.map((row) => ({
            ...row,
            kind: 'semantic',
            inputPath: 'background_semantic',
          })),
        };
      const decision = decide(state, event);
      return decision.kind === 'kill_requested'
        ? {
            ...decision,
            state: {
              ...decision.state,
              quarantines: decision.state.quarantines.map((q) => ({ ...q })),
            },
          }
        : decision;
    });
    let callbacks!: WindowsTerminationCallbacks;
    try {
      const target = ledgerTarget(
        true,
        (addon) => ({
          ...addon,
          configureWindowsTermination: (value) => {
            callbacks = value;
            addon.configureWindowsTermination!(value);
          },
        }),
        true,
        {
          ...store,
          readQuarantines: () =>
            delayRead
              ? new Promise<readonly unknown[]>((resolve) => {
                  finishRead = resolve;
                })
              : store.readQuarantines(),
        },
      );
      const session = await startSession(target.host, 'clone-race', 'turn-race');
      await startSession(target.host, 'keeper', 'turn-keeper');
      target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
      await target.dispatch(session, ledgerActions[4]);
      await target.host.close(session);
      const quarantine = store.readQuarantines()[0];
      expect(quarantine).toBeDefined();
      delayRead = true;
      const reading = target.host.restoreWindowsLedger();
      await vi.advanceTimersByTimeAsync(0);
      target.addon.requestWindowsTermination!();
      delayRead = false;
      finishRead!([]);
      await reading;
      callbacks.event(1, 'exit_wait_exceeded');
      expect(spy.mock.calls.at(-1)![0].quarantines).toContainEqual(quarantine);
      const identity = { pid: 42, creationTime: '133000000000000001' };
      store.releaseQuarantine(identity);
      await target.host.restoreWindowsLedger();
      callbacks.event(1, 'exit_wait_exceeded');
      expect(spy.mock.calls.at(-1)![0].quarantines).toEqual([]);
      child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      spy.mockRestore();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('PR9 refresh drops a shared quarantine another Host released', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ledger-shared-release-'));
    const path = join(directory, 'shared.sqlite');
    const a = openWindowsLedgerStore({ path, userData: 'C:\\synthetic\\a' });
    const b = openWindowsLedgerStore({ path, userData: 'C:\\synthetic\\b' });
    const identity = { pid: 4242, creationTime: '133000000000000001' };
    try {
      const original = responders();
      const host = (store: typeof a) =>
        createTarget(
          {
            ...original,
            check_target_identity: (metadata) => [
              'target_identity_result',
              { results: (metadata['targets'] as unknown[]).map(() => ({ result: 'alive' })) },
            ],
            list_windows: (metadata) => {
              const [type, result] = original['list_windows']!(metadata);
              return [
                type,
                (result as Record<string, unknown>[]).map((row) => ({
                  ...row,
                  pid: identity.pid,
                  ...(metadata['includeStartIdentity'] === true
                    ? { processStartTime: identity.creationTime }
                    : {}),
                })),
              ];
            },
            start_session: (metadata) => {
              const [type, result] = original['start_session']!(metadata);
              return [
                type,
                {
                  ...(result as Record<string, unknown>),
                  pid: identity.pid,
                  processStartTime: identity.creationTime,
                },
              ];
            },
          },
          undefined,
          { windowsLedger: store },
        );
      const hostA = host(a);
      const hostB = host(b);
      a.restoreQuarantines([{ identity, reason: 'effect_unconfirmed' }]);
      await expect(hostA.host.restoreWindowsLedger()).resolves.toBe(true);
      await expect(hostB.host.restoreWindowsLedger()).resolves.toBe(true);
      await expect(startSession(hostB.host, 'b-before', 'turn-a')).rejects.toThrow(
        'native_unavailable',
      );
      // Host A's approval-card release is this single shared delete (ADR §2.2 の 5).
      expect(a.releaseQuarantine(identity)).toBe(true);
      await expect(startSession(hostB.host, 'b-after', 'turn-b')).resolves.toMatchObject({
        sessionId: 'b-after',
      });
      a.restoreQuarantines([{ identity, reason: 'takeover_conflict' }]);
      await expect(startSession(hostB.host, 'b-again', 'turn-c')).rejects.toThrow(
        'native_unavailable',
      );
      // A failed refresh never admits by an empty view (fail-closed).
      expect(a.releaseQuarantine(identity)).toBe(true);
      const read = b.readQuarantines;
      Object.assign(b, {
        readQuarantines: () => {
          throw new Error('synthetic read failure');
        },
      });
      await expect(startSession(hostB.host, 'b-unreadable', 'turn-d')).rejects.toThrow(
        'native_unavailable',
      );
      Object.assign(b, { readQuarantines: read });
      await expect(startSession(hostB.host, 'b-readable', 'turn-e')).resolves.toMatchObject({
        sessionId: 'b-readable',
      });
    } finally {
      a.close();
      b.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['start', 'resume', 'other-target'] as const)(
    'PR5b gates same-target start holds / resume quarantine, allows other targets (%s)',
    async (entry) => {
      const directory = mkdtempSync(join(tmpdir(), 'ledger-start-gate-'));
      const path = join(directory, 'shared.sqlite');
      const a = openWindowsLedgerStore({ path, userData: 'C:/synthetic/a' });
      const b = openWindowsLedgerStore({ path, userData: 'C:/synthetic/b' });
      let commit = false;
      const holds: WindowsStorageHold[] = [];
      const decide = stopKernel.decideWindowsStop;
      // Supply a storage hold at the kernel seam; new-start quarantine matching belongs to PR8.
      const kernel = vi
        .spyOn(stopKernel, 'decideWindowsStop')
        .mockImplementation((state, event) => {
          const decision = decide(state, event);
          if (event.kind !== 'restore_read' || decision.kind !== 'restored') return decision;
          return {
            ...decision,
            state: { ...decision.state, holds: [...decision.state.holds, ...holds] },
          };
        });
      try {
        const original = responders();
        const identity = { pid: 4242, processStartTime: '133000000000000001' };
        const target = createTarget(
          {
            ...original,
            list_windows: (metadata) => {
              const [type, result] = original['list_windows']!(metadata);
              return [
                type,
                (result as Record<string, unknown>[]).map((row) => ({
                  ...row,
                  pid: identity.pid,
                  ...(metadata['includeStartIdentity'] === true ? identity : {}),
                })),
              ];
            },
            start_session: (metadata) => {
              const [type, result] = original['start_session']!(metadata);
              return [type, { ...(result as Record<string, unknown>), ...identity }];
            },
          },
          undefined,
          { windowsLedger: b, windowsKillStopTermination: { enabled: true } },
          (addon) => ({
            ...addon,
            startSession: async (...args) => {
              if (commit) {
                if (entry !== 'resume')
                  holds.push({
                    id: 'synthetic-start-hold',
                    operation: 'response',
                    targets: [
                      {
                        pid: entry === 'other-target' ? 4343 : identity.pid,
                        creationTime: '133000000000000002',
                      },
                    ],
                    changes: [],
                    recovery: 'reflect_response',
                  });
                expect(
                  a.restoreQuarantines([
                    {
                      identity: {
                        pid: entry === 'other-target' ? 4343 : identity.pid,
                        creationTime:
                          entry === 'other-target'
                            ? '133000000000000002'
                            : identity.processStartTime,
                      },
                      reason: 'exit_suspect',
                    },
                  ]),
                ).toBe(true);
                await target.host.restoreWindowsLedger();
              }
              return addon.startSession!(...args);
            },
          }),
        );
        await expect(target.host.restoreWindowsLedger()).resolves.toBe(true);
        if (entry === 'resume') await startSession(target.host, 'shared-session', 'turn-a');
        commit = true;
        const attempt = target.host.startSession({
          profile,
          windowId: '100',
          sessionId: 'shared-session',
          taskId: 'task-1',
          turnId: 'turn-a',
          cancelEpoch: 0,
          resume: entry === 'resume',
        });
        if (entry === 'other-target')
          await expect(attempt).resolves.toMatchObject({ sessionId: 'shared-session' });
        else await expect(attempt).rejects.toMatchObject({ reasonCode: 'native_unavailable' });
        expect(target.helper().served.filter((name) => name === 'start_session')).toHaveLength(
          entry === 'start' ? 0 : 1,
        );
      } finally {
        kernel.mockRestore();
        a.close();
        b.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
  it.each([
    '0',
    '01',
    '-1',
    '1.5',
    '1e3',
    '',
    '18446744073709551616',
    '123456789012345678901',
    1,
    null,
  ])(
    'PR5b rejects malformed discovery identity %j before sending start',
    async (processStartTime) => {
      const original = responders();
      // Deliberately malformed helper output tests the Host boundary, not opt-in wiring.
      const target = createTarget(
        {
          ...original,
          list_windows: (metadata) => {
            const [type, rows] = original['list_windows']!(metadata);
            return [
              type,
              (rows as Record<string, unknown>[]).map((row) => ({ ...row, processStartTime })),
            ];
          },
        },
        undefined,
        {
          windowsLedger: {
            write: () => true,
            update: () => true,
            delete: () => true,
            read: () => ({ rows: [], quarantines: [] }),
            restoreQuarantines: () => true,
          },
        },
      );
      await expect(startSession(target.host, 'invalid-identity', 'turn-a')).rejects.toMatchObject({
        reasonCode: 'native_unavailable',
      });
      expect(target.helper().served).not.toContain('start_session');
    },
  );
  it.each(['1', '18446744073709551615'])(
    'PR5b accepts discovery identity boundary %s',
    async (processStartTime) => {
      const original = responders();
      // Inject a valid identity at the discovery boundary ahead of PR5b-3 opt-in wiring.
      const target = createTarget(
        {
          ...original,
          list_windows: (metadata) => {
            const [type, rows] = original['list_windows']!(metadata);
            return [
              type,
              (rows as Record<string, unknown>[]).map((row) => ({ ...row, processStartTime })),
            ];
          },
        },
        undefined,
        {
          windowsLedger: {
            write: () => true,
            update: () => true,
            delete: () => true,
            read: () => ({ rows: [], quarantines: [] }),
            restoreQuarantines: () => true,
          },
        },
      );
      await expect(startSession(target.host, 'valid-identity', 'turn-a')).resolves.toMatchObject({
        sessionId: 'valid-identity',
      });
      expect(target.helper().served.filter((name) => name === 'start_session')).toHaveLength(1);
    },
  );
  it.each(['throw', 'timeout'] as const)(
    'PR4 unreadable startup blocks before helper launch and recovers (%s)',
    async (failure) => {
      let healthy = false;
      const target = createTarget(responders(), undefined, {
        windowsLedger: {
          write: () => true,
          update: () => true,
          delete: () => true,
          restoreQuarantines: () => true,
          transferReceipt: () => true,
          read: () => {
            if (healthy) return { rows: [], quarantines: [] };
            if (failure === 'throw') throw new Error('synthetic read failure');
            return new Promise(() => {});
          },
        },
      });
      const attempt = startSession(target.host, 'blocked-start', 'turn-a').catch(
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(2001);
      expect(await attempt).toMatchObject({ message: 'native_unavailable' });
      expect(spawn).not.toHaveBeenCalled();
      if (failure === 'throw') {
        healthy = true;
        await expect(startSession(target.host, 'recovered-start', 'turn-b')).resolves.toMatchObject(
          { sessionId: 'recovered-start' },
        );
      }
    },
  );
  const identityTargets = [{ pid: 4242, processStartTime: '133000000000000001' }];

  it('PR8 retains the original discovery refusal as the non-submission cause', async () => {
    const target = ledgerTarget(true, (addon) => ({
      ...addon,
      hasUnconfirmedSemanticInputs: () => true,
    }));
    await expect(target.host.listWindows(profile)).rejects.toMatchObject({
      cause: { reasonCode: 'native_stop_unconfirmed' },
    });
  });

  it('PR8 forgets an unsent lifetime before a later close receipt', async () => {
    const { addon, helper } = createTarget(responders(), (helper) => helper.hold('handshake'));
    const received = vi.fn();
    addon.configureCloseLedger!({
      received,
      blocked: () => false,
      verified: async () => ({ status: 'confirmed' }),
    });
    const starting = Promise.resolve(
      addon.startSession!({ sessionId: 'never-sent', profile }),
    ).catch(() => undefined);
    const kept = addon.startSession!({ sessionId: 'kept', profile });
    await vi.advanceTimersByTimeAsync(0);
    expect(addon.cancelUnsubmittedStart!('never-sent')).toBe('never_sent');
    helper().release('handshake');
    await starting;
    await kept;
    await addon.close!({ sessionId: 'never-sent', cancelEpoch: 0 });
    expect(received).not.toHaveBeenCalled();
  });

  it('PR8 sends metadata byte-for-byte equal to the native identity parser fixture', async () => {
    const { addon } = createTarget();
    await addon.checkTargetIdentity(identityTargets);
    const frame = sockets[0]!.writes
      .map((bytes) => decodeComputerUseNativeFrame(bytes))
      .find((item) => item.messageType === 'check_target_identity')!;
    const native = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_windows_target_identity_test.cc'),
      'utf8',
    );
    const literal = native.match(/kClientMetadata = R"\(([^\n]+)\)";/u)?.[1];
    expect(literal).toBeDefined();
    expect(frame.metadata.toString('utf8')).toBe(literal);
  });

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
    const value = {
      generation: 123_456_789,
      rulesetVersion: DENY_RULESET.platforms.win32.rulesetVersion,
      truncated: false,
      targets: [],
    };
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
    const value = { generation: 123, rulesetVersion: 3, truncated: false, targets: [] };
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
            rulesetVersion: 3,
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
                  : { generation: 1, rulesetVersion: 3, truncated: false, targets: [] },
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
// An ordinary dispatch: no approved effect is handed to the semantic owner (#991 N8-2c).
enum class ApprovedEffect { kInvalid };
std::atomic<std::uint64_t> cancellation_epoch{0};
bool DispatchWindowsSemanticAction(const WindowsSession&, const RECT&, std::uint64_t,
    const std::string&, const std::string&, bool* accepted, std::string* reason,
    ApprovedEffect effect) {
  if (effect != ApprovedEffect::kInvalid) return false;
  *accepted = true; *reason = "semantic_input_in_flight"; return false;
}
bool RevalidateWindowsTarget(const WindowsSession&, const RECT&, std::uint64_t) { return true; }
bool PublicDispatch(std::string* result, std::string* reason, bool* accepted) {
  WindowsSession session; RECT bounds; std::uint64_t expected_epoch = 0;
  const ApprovedEffect approved_effect = ApprovedEffect::kInvalid;
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

  it('PR6 retains a late discovery verification rejection for a subsequent Stop retry', async () => {
    const { host, helper } = createTarget(
      responders(),
      (helper) => helper.holdOnly('start_session'),
      {},
      (addon) => ({
        ...addon,
        confirmSessionClosed: vi
          .fn()
          .mockRejectedValueOnce(new Error('synthetic verification failure'))
          .mockResolvedValue({ status: 'confirmed' }),
      }),
    );
    const first = startSession(host, 'shared-discovery', 'turn-1');
    await vi.advanceTimersByTimeAsync(0);
    helper().holdOnly('list_windows_cancellable');
    helper().refuse('stop_window_discovery');
    const second = startSession(host, 'shared-discovery', 'turn-1').catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    helper().release('start_session');
    const active = await first;
    await host.cancel(active, 1);
    await expect(host.close(active)).rejects.toThrow(/unconfirmed/u);
    helper().release('list_windows_cancellable');
    await second;
    await vi.advanceTimersByTimeAsync(0);
    expect(host.availability()).toMatchObject({ reasonCode: 'native_stop_unconfirmed' });
    await expect(host.stopPendingStart!(active.sessionId)).resolves.toMatchObject({
      kind: 'closed',
    });
    expect(host.availability().control).toBe(true);
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
          restoreQuarantines: () => true,
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
    expect(target.host.subscribeWindowsStop).toBeUndefined();
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
  function ledgerTarget(
    withTransfer = false,
    adaptAddon?: (addon: ComputerUseNativeAddon) => ComputerUseNativeAddon,
    termination = false,
    store?: WindowsDispatchLedgerStorage,
    background = false,
    backgroundGate = background,
    foregroundHandoff = false,
  ) {
    const rows = new Map<string, WindowsLedgerRow>();
    const quarantines: WindowsTargetQuarantine[] = [];
    const written: WindowsLedgerRow[] = [];
    const deleted: WindowsLedgerRow[] = [];
    const control = {
      failWrite: false,
      failReflect: false,
      failedDeletes: new Set<string>(),
      deleteCalls: [] as string[],
      creationTime: '133000000000000001' as string | undefined,
      pid: 42,
      discoveryPid: undefined as number | undefined,
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
      failRelease: false,
      throwRelease: false,
      revision: 'stored' as 'stored' | 'null' | 'throw',
      releases: 0,
      releaseRevisions: [] as (number | undefined)[],
      releaseWait: null as Promise<void> | null,
      identityResult: { result: 'alive' } as
        | { result: 'alive' }
        | { result: 'terminated'; reason: 'start_time_mismatch' }
        | { result: 'unverifiable'; reason: 'access_denied' },
      /** A process start time reported as terminated (no_process) regardless of identityResult. */
      exitedCreationTime: undefined as string | undefined,
      onIdentityCheck: undefined as (() => void) | undefined,
    };
    const base = responders();
    const target = createTarget(
      {
        ...base,
        check_target_identity: (metadata) => {
          control.onIdentityCheck?.();
          return [
            'target_identity_result',
            {
              results: (metadata['targets'] as Record<string, unknown>[]).map((item) =>
                item['processStartTime'] === control.exitedCreationTime
                  ? { result: 'terminated', reason: 'no_process' }
                  : control.identityResult,
              ),
            },
          ];
        },
        list_targets: () => ['probe_result', []],
        pick_application: () => ['probe_result', null],
        list_windows: (metadata) => {
          const [type, value] = base['list_windows']!(metadata);
          return [
            type,
            (value as Record<string, unknown>[]).map((row) => ({
              ...row,
              pid: control.discoveryPid ?? control.pid,
              ...(metadata['includeStartIdentity'] === true
                ? { processStartTime: control.creationTime }
                : {}),
            })),
          ];
        },
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
              ...(background
                ? { inputSession: { kind: 'background', backgroundCapabilityVersion: 1 } }
                : {}),
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
        ...(termination ? { windowsKillStopTermination: { enabled: true as const } } : {}),
        windowsBackgroundInputForTesting: backgroundGate,
        windowsForegroundHandoffForTesting: foregroundHandoff,
        windowsLedger: store ?? {
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
          updateWithQuarantines: async (row, added) => {
            if (control.updateWait !== null) await control.updateWait;
            if (control.failReflect) return false;
            rows.set(ledgerKey(row), row);
            quarantines.push(...added);
            return true;
          },
          delete: async (row) => {
            control.deleteCalls.push(row.sessionId);
            if (control.reflectWait !== null) await control.reflectWait;
            if (control.failReflect || control.failedDeletes.has(row.sessionId)) return false;
            control.deleteEffect();
            deleted.push(row);
            rows.delete(ledgerKey(row));
            return true;
          },
          restoreQuarantines: () => control.restoreQuarantines(),
          quarantineRevision: () => {
            if (control.revision === 'throw') throw new Error('synthetic revision failure');
            return control.revision === 'null' || quarantines.length === 0 ? null : 1;
          },
          releaseQuarantine: async (_identity, revision) => {
            control.releases += 1;
            control.releaseRevisions.push(revision);
            if (control.releaseWait !== null) await control.releaseWait;
            if (control.throwRelease) throw new Error('synthetic release failure');
            if (control.failRelease) return false;
            quarantines.length = 0;
            return true;
          },
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
      adaptAddon,
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
  const backgroundSamples = [
    ledgerActions[4],
    {
      name: 'semantic scroll',
      action: {
        type: 'semantic_scroll',
        targetId: 'node-1',
        operation: 'scroll',
        axis: 'vertical',
        amount: 'small_increment',
      },
    },
  ] as const;
  const backgroundDispatch = (
    target: ReturnType<typeof ledgerTarget>,
    session: Awaited<ReturnType<typeof startSession>>,
    action = backgroundSamples[0].action as (typeof backgroundSamples)[number]['action'],
    signal = new AbortController().signal,
  ) =>
    target.host.dispatch({
      session,
      requestId: 'background-request',
      action,
      observationRevision: 1,
      cancelEpoch: 0,
      signal,
    });

  it('P4c production gate rejects a background session without test injection', async () => {
    const target = ledgerTarget(true, undefined, false, undefined, true, false);
    await expect(startSession(target.host, 'session-1', 'turn-1')).rejects.toThrow(
      'native_session_invalid',
    );
    expect(dispatchWrites(sockets.at(-1)!)).toHaveLength(0);
  });
  it.each(backgroundSamples)(
    'P4c $name dispatch records background and K-1 blocks duplicate input before and after receipt',
    async ({ action }) => {
      const target = ledgerTarget(true, undefined, true, undefined, true);
      const session = await startSession(target.host, 'session-1', 'turn-1');
      const other = await startSession(target.host, 'other-session', 'turn-2');
      target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
      await expect(backgroundDispatch(target, session, action)).rejects.toMatchObject({
        accepted: true,
        code: 'input_not_confirmed',
      });
      expect(target.written).toMatchObject([
        { kind: 'semantic', inputPath: 'background_semantic' },
      ]);
      expect([...target.rows.values()]).toMatchObject([
        { state: 'effect_unconfirmed', inputPath: 'background_semantic' },
      ]);
      expect(target.quarantines).toMatchObject([
        { identity: { pid: 42 }, reason: 'effect_unconfirmed' },
      ]);
      await expect(backgroundDispatch(target, session, action)).resolves.toMatchObject({
        result: 'rejected',
      });
      await target.host.close(session);
      expect(target.deleted).toEqual([]);
      expect(target.quarantines.length).toBeGreaterThan(0);
      await expect(backgroundDispatch(target, other, action)).resolves.toMatchObject({
        result: 'rejected',
      });
      expect(dispatchWrites(sockets[0]!)).toHaveLength(1);
      await expect(
        target.host.approveWindowsQuarantineResume!({
          previousSessionId: session.sessionId,
          newSessionId: session.sessionId,
          trustedActivation: true,
        }),
      ).resolves.toBe(false);
      await expect(
        target.host.approveWindowsQuarantineResume!({
          previousSessionId: session.sessionId,
          newSessionId: 'fresh-session',
          trustedActivation: true,
        }),
      ).resolves.toBe(true);
      expect(target.quarantines).toEqual([]);
      await expect(startSession(target.host, 'fresh-session', 'turn-3')).resolves.toMatchObject({
        sessionId: 'fresh-session',
      });
    },
  );
  it.each(['write', 'stop', 'receipt'] as const)(
    'P4c storage/Stop boundary: %s',
    async (boundary) => {
      const target = ledgerTarget(true, undefined, false, undefined, true);
      const session = await startSession(target.host, 'session-1', 'turn-1');
      const signal = new AbortController();
      if (boundary === 'write') target.control.failWrite = true;
      if (boundary === 'receipt') {
        target.control.response = ['error', { code: 'input_timeout_unconfirmed', accepted: true }];
        await expect(backgroundDispatch(target, session)).rejects.toMatchObject({ accepted: true });
        target.control.failTransfer = true;
        await target.host.close(session);
        expect([...target.rows.values()]).toMatchObject([
          { inputPath: 'background_semantic', state: 'effect_unconfirmed' },
        ]);
        expect(target.deleted).toEqual([]);
        expect(target.quarantines.length).toBeGreaterThan(0);
        return;
      }
      let release!: () => void;
      if (boundary === 'stop')
        target.control.wait = new Promise<void>((resolve) => {
          release = resolve;
        });
      const result = backgroundDispatch(target, session, undefined, signal.signal);
      await vi.advanceTimersByTimeAsync(1);
      if (boundary === 'stop') {
        signal.abort();
        release();
      }
      await expect(result).resolves.toMatchObject({ result: 'rejected' });
      expect(dispatchWrites(sockets[0]!)).toHaveLength(0);
    },
  );

  it.each(['awaiting_response', 'effect_unconfirmed', 'receipt'] as const)(
    'P4c SQLite restart preserves background isolation after %s',
    async (phase) => {
      const folder = mkdtempSync(join(tmpdir(), 'p4c-ledger-'));
      const options = { path: join(folder, 'ledger.sqlite'), userData: 'C:/synthetic/p4c' };
      let store = openWindowsLedgerStore(options);
      try {
        const target = ledgerTarget(true, undefined, false, store, true);
        const session = await startSession(target.host, 'session-1', 'turn-1');
        if (phase === 'awaiting_response') target.helper().holdOnly('dispatch');
        else target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
        const result = backgroundDispatch(target, session).catch(() => undefined);
        await vi.advanceTimersByTimeAsync(0);
        expect(store.read().rows).toMatchObject([
          {
            inputPath: 'background_semantic',
            state: phase === 'awaiting_response' ? phase : 'effect_unconfirmed',
          },
        ]);
        if (phase !== 'awaiting_response') await result;
        if (phase === 'receipt') await target.host.close(session);
        store.close();
        store = openWindowsLedgerStore(options);
        const restarted = ledgerTarget(true, undefined, false, store, true);
        await expect(restarted.host.restoreWindowsLedger()).resolves.toBe(true);
        expect(store.read().quarantines).toMatchObject([
          { identity: { pid: 42, creationTime: '133000000000000001' } },
        ]);
        await expect(startSession(restarted.host, 'new-session', 'new-turn')).rejects.toThrow(
          'native_unavailable',
        );
        expect(sockets.flatMap((socket) => dispatchWrites(socket))).toHaveLength(1);
        if (phase === 'awaiting_response') {
          target.helper().release('dispatch');
          await result;
          expect(store.read().quarantines).toHaveLength(1);
        }
      } finally {
        store.close();
        rmSync(folder, { recursive: true, force: true });
      }
    },
  );
  it.each(['timeout', 'failAll', 'abortTransport'] as const)(
    'P4c background response loss %s never reissues input',
    async (loss) => {
      const target = ledgerTarget(true, undefined, false, undefined, true);
      const session = await startSession(target.host, 'session-1', 'turn-1');
      target.helper().holdOnly('dispatch');
      const result = backgroundDispatch(target, session).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(1);
      expect([...target.rows.values()]).toMatchObject([
        { inputPath: 'background_semantic', state: 'awaiting_response' },
      ]);
      if (loss === 'timeout')
        await vi.advanceTimersByTimeAsync(operationTimeoutMilliseconds('dispatch'));
      else if (loss === 'failAll') sockets[0]!.emit('error', new Error('synthetic loss'));
      else sockets[0]!.emit('data', Buffer.alloc(COMPUTER_USE_NATIVE_FRAME_HEADER_BYTES, 255));
      await result;
      expect(target.control.restoreQuarantines).toHaveBeenCalled();
      expect(target.rows.size).toBe(1);
      await expect(backgroundDispatch(target, session)).resolves.toMatchObject({
        result: 'rejected',
      });
      expect(sockets.flatMap((socket) => dispatchWrites(socket))).toHaveLength(1);
    },
  );

  it('P4c awaiting background receipt transfers before late success and never dispatches after Stop', async () => {
    const target = ledgerTarget(true, undefined, false, undefined, true);
    const session = await startSession(target.host, 'session-1', 'turn-1');
    await startSession(target.host, 'keeper', 'turn-2');
    target.helper().holdOnly('dispatch');
    const first = backgroundDispatch(target, session).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(target.written).toHaveLength(1);
    const duplicate = backgroundDispatch(target, session).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatchWrites(sockets[0]!)).toHaveLength(1);
    await target.host.close(session);
    expect(target.quarantines).toMatchObject([{ reason: 'response_lost' }]);
    expect(target.deleted).toEqual([]);
    await expect(backgroundDispatch(target, session)).rejects.toThrow();
    target.helper().release('dispatch');
    await Promise.all([first, duplicate]);
    expect(dispatchWrites(sockets[0]!)).toHaveLength(1);
    expect(target.quarantines).toMatchObject([{ reason: 'response_lost' }]);
  });
  it('P4c caller session cannot relabel a foreground dispatch as background', async () => {
    const target = ledgerTarget();
    const session = await startSession(target.host, 'session-1', 'turn-1');
    await backgroundDispatch(target, {
      ...session,
      inputSession: { kind: 'background', backgroundCapabilityVersion: 1 },
    });
    expect(target.written).toMatchObject([{ inputPath: 'normal' }]);
  });

  it('P4c failed K-1 persistence retains the awaiting row and closes admission', async () => {
    const target = ledgerTarget(true, undefined, false, undefined, true);
    const session = await startSession(target.host, 'session-1', 'turn-1');
    target.control.failReflect = true;
    target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
    await expect(backgroundDispatch(target, session)).rejects.toMatchObject({ accepted: true });
    expect([...target.rows.values()]).toMatchObject([
      { inputPath: 'background_semantic', state: 'awaiting_response' },
    ]);
    await expect(backgroundDispatch(target, session)).resolves.toMatchObject({
      result: 'rejected',
    });
    await expect(startSession(target.host, 'new-session', 'turn-2')).rejects.toThrow(
      'native_unavailable',
    );
    expect(dispatchWrites(sockets[0]!)).toHaveLength(1);
    expect(target.deleted).toEqual([]);
  });
  it('P4c background session refuses visual input before recording or sending', async () => {
    const target = ledgerTarget(true, undefined, false, undefined, true);
    const session = await startSession(target.host, 'session-1', 'turn-1');
    expect(await target.dispatch(session, ledgerActions[0])).toMatchObject({
      outcome: 'rejected',
      accepted: false,
    });
    expect(target.written).toEqual([]);
    expect(dispatchWrites(sockets[0]!)).toHaveLength(0);
  });

  it.each([false, true])(
    'PR9 approval reobserves after receipt and persists release (failure: %s)',
    async (failRelease) => {
      const decide = stopKernel.decideWindowsStop;
      const spy = vi.spyOn(stopKernel, 'decideWindowsStop').mockImplementation((state, event) => {
        if (event.kind === 'receipt' && event.status === 'received')
          state = {
            ...state,
            rows: state.rows.map((row) => ({
              ...row,
              kind: 'semantic',
              inputPath: 'background_semantic',
            })),
          };
        return decide(state, event);
      });
      try {
        const target = ledgerTarget(true, undefined, true);
        const session = await startSession(target.host, 'session-1', 'turn-1');
        // Keep the helper alive to exercise K-5 in the same generation.
        const other = await startSession(target.host, 'other-session', 'turn-2');
        target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
        await target.dispatch(session, ledgerActions[4]);
        const request = {
          previousSessionId: session.sessionId,
          newSessionId: 'fresh-session',
          trustedActivation: true,
        };
        await expect(target.host.approveWindowsQuarantineResume!(request)).resolves.toBe(false);
        await target.host.close(session);
        expect(target.quarantines).toHaveLength(1);
        await expect(
          target.host.approvalApprove!({
            session: other,
            requestId: 'quarantined-approval',
            action: ledgerActions[0].action,
            observationRevision: 1,
            cancelEpoch: 0,
            approvalGeneration: 1,
          }),
        ).resolves.toMatchObject({ kind: 'refused', reasonCode: 'native_unavailable' });
        await expect(startSession(target.host, 'other-session', 'turn-2')).rejects.toThrow(
          'native_unavailable',
        );
        expect(await target.dispatch(other)).toMatchObject({
          outcome: 'resolved',
          value: { result: 'rejected' },
        });
        await expect(
          target.host.approveWindowsQuarantineResume!({ ...request, trustedActivation: false }),
        ).resolves.toBe(false);
        await expect(
          target.host.approveWindowsQuarantineResume!({
            ...request,
            newSessionId: session.sessionId,
          }),
        ).resolves.toBe(false);
        expect(target.control.releases).toBe(0);
        target.control.failRelease = failRelease;
        const checks = target.helper().served.filter((op) => op === 'check_target_identity').length;
        await expect(target.host.approveWindowsQuarantineResume!(request)).resolves.toBe(
          !failRelease,
        );
        expect(
          target.helper().served.filter((op) => op === 'check_target_identity').length,
        ).toBeGreaterThan(checks);
        expect(target.control.releases).toBe(1);
        expect(target.quarantines).toHaveLength(failRelease ? 1 : 0);
        if (failRelease)
          await expect(startSession(target.host, 'fresh-session', 'turn-3')).rejects.toThrow(
            'native_unavailable',
          );
        else
          await expect(startSession(target.host, 'fresh-session', 'turn-3')).resolves.toMatchObject(
            { sessionId: 'fresh-session', cancelEpoch: 0 },
          );
        await expect(startSession(target.host, session.sessionId, 'turn-4')).rejects.toThrow(
          'native_session_closed',
        );
      } finally {
        spy.mockRestore();
      }
    },
  );

  it('PR9 K-5 after receipt releases only a K-1 quarantine reason', async () => {
    const decide = stopKernel.decideWindowsStop;
    const identity = { pid: 42, creationTime: '133000000000000001' };
    const spy = vi.spyOn(stopKernel, 'decideWindowsStop').mockImplementation((state, event) => {
      const decision = decide(state, event);
      // A non-K-1 quarantine (startup restoration) on the same target lands at receipt time.
      return event.kind === 'receipt' && event.status === 'received'
        ? ({
            ...decision,
            state: {
              ...decision.state,
              quarantines: [...decision.state.quarantines, { identity, reason: 'restored' }],
            },
          } as stopKernel.WindowsStopDecision)
        : decision;
    });
    try {
      const target = ledgerTarget(true, undefined, true);
      const session = await startSession(target.host, 'session-1', 'turn-1');
      await startSession(target.host, 'other-session', 'turn-2');
      await target.dispatch(session);
      await target.host.close(session);
      await expect(
        target.host.approveWindowsQuarantineResume!({
          previousSessionId: session.sessionId,
          newSessionId: 'fresh-session',
          trustedActivation: true,
        }),
      ).resolves.toBe(false);
      expect(target.control.releases).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('PR9 a superseded approval release without restoration settles without a missing hold', async () => {
    const decide = stopKernel.decideWindowsStop;
    const spy = vi.spyOn(stopKernel, 'decideWindowsStop').mockImplementation((state, event) => {
      if (event.kind === 'receipt' && event.status === 'received')
        state = {
          ...state,
          rows: state.rows.map((row) => ({
            ...row,
            kind: 'semantic',
            inputPath: 'background_semantic',
          })),
        };
      if (
        event.kind === 'retry_storage' &&
        event.status === 'before_write' &&
        event.holdId.startsWith('approval-release-')
      )
        // The release lost its target to newer evidence and has no quarantine left to restore.
        return {
          ...decide(state, event),
          kind: 'refused',
          refusal: 'release_superseded',
          state: { ...state, holds: state.holds.filter((hold) => hold.id !== event.holdId) },
          awaitingHoldId: null,
        } as stopKernel.WindowsStopDecision;
      return decide(state, event);
    });
    try {
      const target = ledgerTarget(true, undefined, true);
      const session = await startSession(target.host, 'session-1', 'turn-1');
      await startSession(target.host, 'other-session', 'turn-2');
      target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
      await target.dispatch(session, ledgerActions[4]);
      await target.host.close(session);
      expect(target.quarantines).toHaveLength(1);
      await expect(
        target.host.approveWindowsQuarantineResume!({
          previousSessionId: session.sessionId,
          newSessionId: 'fresh-session',
          trustedActivation: true,
        }),
      ).resolves.toBe(false);
      expect(target.control.releases).toBe(0);
      expect(spy.mock.results.filter((result) => result.type === 'throw')).toEqual([]);
      await target.host.listTargets!().catch(() => undefined);
      expect(spy.mock.results.filter((result) => result.type === 'throw')).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  const backgroundReceiptSpy = () => {
    const decide = stopKernel.decideWindowsStop;
    return vi.spyOn(stopKernel, 'decideWindowsStop').mockImplementation((state, event) => {
      if (event.kind === 'receipt' && event.status === 'received')
        state = {
          ...state,
          rows: state.rows.map((row) => ({
            ...row,
            kind: 'semantic',
            inputPath: 'background_semantic',
          })),
        };
      return decide(state, event);
    });
  };

  it('PR9 approval release refuses when another Host added newer evidence before the delete', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ledger-approval-revision-'));
    const path = join(directory, 'shared.sqlite');
    const a = openWindowsLedgerStore({ path, userData: 'C:/synthetic/a' });
    const b = openWindowsLedgerStore({ path, userData: 'C:/synthetic/b' });
    const identity = { pid: 42, creationTime: '133000000000000001' };
    const spy = backgroundReceiptSpy();
    try {
      const hostA = ledgerTarget(true, undefined, true, a);
      const session = await startSession(hostA.host, 'session-1', 'turn-1');
      await startSession(hostA.host, 'other-session', 'turn-2');
      hostA.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
      await hostA.dispatch(session, ledgerActions[4]);
      await hostA.host.close(session);
      expect(a.readQuarantines()).toEqual([{ identity, reason: 'effect_unconfirmed' }]);
      // Created after A's helper connected: a fake helper serves the latest target's table.
      const original = responders();
      const hostB = createTarget(
        {
          ...original,
          list_windows: (metadata) => {
            const [type, result] = original['list_windows']!(metadata);
            return [
              type,
              (result as Record<string, unknown>[]).map((row) => ({ ...row, pid: identity.pid })),
            ];
          },
          start_session: (metadata) => {
            const [type, result] = original['start_session']!(metadata);
            return [
              type,
              {
                ...(result as Record<string, unknown>),
                pid: identity.pid,
                processStartTime: identity.creationTime,
              },
            ];
          },
        },
        undefined,
        { windowsLedger: b },
      );
      await expect(hostB.host.restoreWindowsLedger()).resolves.toBe(true);
      // After A's approval starts, B's helper exits and transfers newer evidence for the target.
      hostA.control.onIdentityCheck = () => {
        hostA.control.onIdentityCheck = undefined;
        expect(b.transferReceipt([], [{ identity, reason: 'exit_suspect' }])).toBe(true);
      };
      await expect(
        hostA.host.approveWindowsQuarantineResume!({
          previousSessionId: session.sessionId,
          newSessionId: 'fresh-session',
          trustedActivation: true,
        }),
      ).resolves.toBe(false);
      expect(hostA.control.onIdentityCheck).toBeUndefined();
      // The first committed reason stays; the approval did not cover B's newer evidence.
      expect(b.readQuarantines()).toEqual([{ identity, reason: 'effect_unconfirmed' }]);
      await expect(startSession(hostA.host, 'fresh-session', 'turn-3')).rejects.toThrow(
        'native_unavailable',
      );
      await expect(startSession(hostB.host, 'b-session', 'turn-4')).rejects.toThrow(
        'native_unavailable',
      );
      expect(b.readQuarantines()).toHaveLength(1);
    } finally {
      spy.mockRestore();
      a.close();
      b.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['null', 'throw'] as const)(
    'PR9 approval release refuses without a release call when the revision is unreadable (%s)',
    async (revision) => {
      const spy = backgroundReceiptSpy();
      try {
        const target = ledgerTarget(true, undefined, true);
        const session = await startSession(target.host, 'session-1', 'turn-1');
        await startSession(target.host, 'other-session', 'turn-2');
        target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
        await target.dispatch(session, ledgerActions[4]);
        await target.host.close(session);
        target.control.revision = revision;
        await expect(
          target.host.approveWindowsQuarantineResume!({
            previousSessionId: session.sessionId,
            newSessionId: 'fresh-session',
            trustedActivation: true,
          }),
        ).resolves.toBe(false);
        // Never an unconditional delete: without a revision the approval cannot release.
        expect(target.control.releases).toBe(0);
        expect(target.quarantines).toHaveLength(1);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it('PR9 an R15 handover whose own save fails settles once the store recovers', async () => {
    const spy = backgroundReceiptSpy();
    try {
      const target = ledgerTarget(true, undefined, true);
      const session = await startSession(target.host, 'session-1', 'turn-1');
      await startSession(target.host, 'other-session', 'turn-2');
      target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
      await target.dispatch(session, ledgerActions[4]);
      await target.host.close(session);
      target.control.throwRelease = true;
      await expect(
        target.host.approveWindowsQuarantineResume!({
          previousSessionId: session.sessionId,
          newSessionId: 'fresh-session',
          trustedActivation: true,
        }),
      ).resolves.toBe(false);
      // The exit is proven but the R15 release save keeps failing: the reused PID stays refused.
      target.control.exitedCreationTime = '133000000000000001';
      target.control.creationTime = '133000000000000002';
      const before = target.control.releases;
      await expect(startSession(target.host, 'reused-1', 'turn-3')).rejects.toThrow(
        'native_unavailable',
      );
      expect(target.control.releases).toBeGreaterThan(before);
      expect(target.quarantines).toHaveLength(1);
      // The store recovers: a later write retries the R15 release and the hold settles.
      target.control.throwRelease = false;
      await expect(startSession(target.host, 'reused-2', 'turn-4')).resolves.toMatchObject({
        sessionId: 'reused-2',
      });
      expect(target.quarantines).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it.each(['exception', 'unknown', 'empty', 'multiple', 'alive'] as const)(
    'PR10 approval never uses R15 for an unproven observation (%s)',
    async (mode) => {
      const spy = backgroundReceiptSpy();
      let uncertain = false;
      try {
        const target = ledgerTarget(
          true,
          (addon) => ({
            ...addon,
            checkTargetIdentity: async (...args) => {
              if (!uncertain) return addon.checkTargetIdentity!(...args);
              if (mode === 'exception') throw new Error('synthetic observation failure');
              if (mode === 'empty') return [];
              if (mode === 'multiple') return [{ result: 'alive' }, { result: 'alive' }];
              return mode === 'alive'
                ? [{ result: 'alive' }]
                : [{ result: 'unverifiable', reason: 'access_denied' }];
            },
          }),
          true,
        );
        const session = await startSession(target.host, 'session-1', 'turn-1');
        await startSession(target.host, 'keeper', 'turn-2');
        target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
        await target.dispatch(session, ledgerActions[4]);
        await target.host.close(session);
        target.control.throwRelease = true;
        await expect(
          target.host.approveWindowsQuarantineResume!({
            previousSessionId: session.sessionId,
            newSessionId: 'new-session',
            trustedActivation: true,
          }),
        ).resolves.toBe(false);
        const releases = target.control.releases;
        uncertain = true;
        await target.host.listTargets!().catch(() => undefined);
        expect(target.quarantines).toHaveLength(1);
        expect(target.control.releases).toBe(mode === 'alive' ? releases + 1 : releases);
        expect(target.control.releaseRevisions.every((revision) => revision !== undefined)).toBe(
          true,
        );
      } finally {
        spy.mockRestore();
      }
    },
  );

  it('PR9 a failed approval release hands over to R15 once the target exits', async () => {
    const spy = backgroundReceiptSpy();
    try {
      const target = ledgerTarget(true, undefined, true);
      const session = await startSession(target.host, 'session-1', 'turn-1');
      await startSession(target.host, 'other-session', 'turn-2');
      target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
      await target.dispatch(session, ledgerActions[4]);
      await target.host.close(session);
      expect(target.quarantines).toHaveLength(1);
      target.control.throwRelease = true;
      await expect(
        target.host.approveWindowsQuarantineResume!({
          previousSessionId: session.sessionId,
          newSessionId: 'fresh-session',
          trustedActivation: true,
        }),
      ).resolves.toBe(false);
      expect(target.control.releases).toBe(1);
      expect(target.quarantines).toHaveLength(1);
      // While the target is still alive the save keeps failing: every retry stays refused and
      // the quarantine is kept (no R15 handover without a proven exit).
      for (const turn of ['turn-a', 'turn-b'])
        await expect(startSession(target.host, `retry-${turn}`, turn)).rejects.toThrow(
          'native_unavailable',
        );
      expect(target.control.releases).toBeGreaterThan(1);
      expect(target.quarantines).toHaveLength(1);
      // The target exits, the store recovers and the PID is reused by a new process.
      target.control.exitedCreationTime = '133000000000000001';
      target.control.creationTime = '133000000000000002';
      target.control.throwRelease = false;
      await expect(startSession(target.host, 'reused-session', 'turn-3')).resolves.toMatchObject({
        sessionId: 'reused-session',
      });
      expect(target.quarantines).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([false, true])(
    'PR9 K-1 (a) persists a background effect_unconfirmed row with its quarantine (failure: %s)',
    async (failReflect) => {
      const decide = stopKernel.decideWindowsStop;
      // N9 creates background rows later; inject the path at dispatch time (before_dispatch).
      const spy = vi.spyOn(stopKernel, 'decideWindowsStop').mockImplementation((state, event) => {
        const decision = decide(state, event);
        return event.kind === 'before_dispatch'
          ? ({
              ...decision,
              state: {
                ...decision.state,
                rows: decision.state.rows.map((row) => ({
                  ...row,
                  kind: 'semantic' as const,
                  inputPath: 'background_semantic' as const,
                })),
              },
            } as stopKernel.WindowsStopDecision)
          : decision;
      });
      try {
        const target = ledgerTarget(true, undefined, true);
        const session = await startSession(target.host, 'session-1', 'turn-1');
        target.control.failReflect = failReflect;
        target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
        await target.dispatch(session, ledgerActions[4]);
        const identity = { pid: 42, creationTime: '133000000000000001' };
        // R21: the K-1 quarantine lands in the shared store with the row, or the target stays held.
        expect(target.quarantines).toEqual(
          failReflect ? [] : [{ identity, reason: 'effect_unconfirmed' }],
        );
        expect([...target.rows.values()].map((row) => row.state)).toEqual([
          failReflect ? 'awaiting_response' : 'effect_unconfirmed',
        ]);
        await expect(startSession(target.host, 'same-target', 'turn-2')).rejects.toThrow(
          'native_unavailable',
        );
        if (failReflect) {
          target.control.failReflect = false;
          await target.host.listTargets!().catch(() => undefined);
          expect(target.quarantines).toEqual([{ identity, reason: 'effect_unconfirmed' }]);
          await expect(startSession(target.host, 'same-target-2', 'turn-3')).rejects.toThrow(
            'native_unavailable',
          );
        }
      } finally {
        spy.mockRestore();
      }
    },
  );

  it.each(['unchanged', 'newer-evidence', 'unverifiable'] as const)(
    'PR10 restores approval without old session memory and checks the selected window identity (%s)',
    async (mode) => {
      const directory = mkdtempSync(join(tmpdir(), 'ledger-restored-approval-'));
      const path = join(directory, 'shared.sqlite');
      const identity = { pid: 42, creationTime: '133000000000000001' };
      const original = openWindowsLedgerStore({ path, userData: 'C:/synthetic/restart' });
      original.restoreQuarantines([{ identity, reason: 'exit_suspect' }]);
      original.close();
      const store = openWindowsLedgerStore({ path, userData: 'C:/synthetic/restart' });
      try {
        const target = ledgerTarget(true, undefined, true, store);
        await expect(target.host.restoreWindowsLedger()).resolves.toBe(true);
        const request = {
          restoredTarget: {
            identity,
            approvedWindow: { windowId: '100', windowIdentityDigest, identity },
          },
          newSessionId: 'restored-session',
          trustedActivation: true,
        };
        await expect(target.host.approveWindowsQuarantineResume!(request)).resolves.toBe(false);
        const windows = await target.host.listWindows(profile);
        expect(windows[0]).toMatchObject({ windowId: '100', quarantineResume: true });
        await expect(
          target.host.approveWindowsQuarantineResume!({ ...request, trustedActivation: false }),
        ).resolves.toBe(false);
        await expect(
          target.host.approveWindowsQuarantineResume!({
            ...request,
            restoredTarget: {
              ...request.restoredTarget,
              approvedWindow: {
                ...request.restoredTarget.approvedWindow,
                identity: { ...identity, creationTime: '133000000000000002' },
              },
            },
          }),
        ).resolves.toBe(false);
        expect(store.readQuarantines()).toHaveLength(1);
        if (mode === 'newer-evidence')
          target.control.onIdentityCheck = () => {
            target.control.onIdentityCheck = undefined;
            store.restoreQuarantines([{ identity, reason: 'exit_suspect' }]);
          };
        if (mode === 'unverifiable')
          target.control.identityResult = { result: 'unverifiable', reason: 'access_denied' };
        await expect(target.host.approveWindowsQuarantineResume!(request)).resolves.toBe(
          mode === 'unchanged',
        );
        if (mode !== 'unchanged') {
          expect(store.readQuarantines()).toHaveLength(1);
          await expect(
            startSession(target.host, request.newSessionId, 'restored-turn'),
          ).rejects.toThrow('native_unavailable');
          return;
        }
        expect(store.readQuarantines()).toEqual([]);
        await expect(
          startSession(target.host, request.newSessionId, 'restored-turn'),
        ).resolves.toMatchObject({
          sessionId: request.newSessionId,
        });
      } finally {
        store.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it('PR9 approval entry is absent by default', () => {
    expect(ledgerTarget(true).host.approveWindowsQuarantineResume).toBeUndefined();
  });

  it.each(['alive', 'mismatch', 'unverifiable', 'timeout'] as const)(
    'PR9 exit approval uses a new generation and fails closed (%s)',
    async (mode) => {
      const target = ledgerTarget(true, undefined, true);
      const session = await startSession(target.host, 'session-1', 'turn-1');
      target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
      await target.dispatch(session);
      children[0]!.emit('exit', 1, null);
      await vi.advanceTimersByTimeAsync(0);
      expect(target.quarantines).toHaveLength(1);
      if (mode === 'mismatch')
        target.control.identityResult = { result: 'terminated', reason: 'start_time_mismatch' };
      if (mode === 'unverifiable')
        target.control.identityResult = { result: 'unverifiable', reason: 'access_denied' };
      let finish!: () => void;
      if (mode === 'timeout')
        target.control.releaseWait = new Promise<void>((resolve) => {
          finish = resolve;
        });
      const approval = target.host.approveWindowsQuarantineResume!({
        previousSessionId: session.sessionId,
        newSessionId: 'new-session',
        trustedActivation: true,
      });
      await vi.advanceTimersByTimeAsync(mode === 'timeout' ? 2_000 : 0);
      await expect(approval).resolves.toBe(mode === 'alive');
      expect(children).toHaveLength(2);
      if (mode === 'alive') {
        expect(target.quarantines).toEqual([]);
        await expect(startSession(target.host, 'new-session', 'turn-2')).resolves.toMatchObject({
          sessionId: 'new-session',
        });
      } else {
        expect(target.quarantines).toHaveLength(1);
        if (mode !== 'timeout') expect(target.control.releases).toBe(0);
        else {
          const start = startSession(target.host, 'blocked-session', 'turn-2').catch(
            () => 'blocked',
          );
          await vi.advanceTimersByTimeAsync(0);
          expect(await start).toBe('blocked');
          finish();
          await vi.advanceTimersByTimeAsync(0);
          expect(target.quarantines).toEqual([]);
        }
      }
    },
  );

  const dispatchWrites = (socket: FakeHelperSocket) =>
    socket.writes.filter((bytes) => decodeComputerUseNativeFrame(bytes).messageType === 'dispatch');
  it('PR11 terminates E3 start-receipt cleanup at C', async () => {
    const child = new ControlledHelperChild();
    vi.mocked(spawn).mockImplementationOnce(
      () => child as unknown as NodeChildProcess.ChildProcess,
    );
    const target = ledgerTarget(
      true,
      (addon) => ({
        ...addon,
        startSession: async (input) => {
          const result = await addon.startSession!(input);
          if (typeof result !== 'object' || result === null)
            throw new Error('synthetic invalid response');
          return { ...result, inputAttemptCount: -1 };
        },
      }),
      true,
    );
    await target.host.listWindows(profile);
    target.helper().holdOnly('close_session');
    const starting = startSession(target.host, 'pending', 'turn-pending').catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.killCalls).toBe(1);
    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(0);
    await starting;
  });

  it.each([false, true])(
    'PR11 settles close after its owner is trimmed during kill wait (exit=%s)',
    async (exit) => {
      const child = new ControlledHelperChild();
      vi.mocked(spawn).mockImplementationOnce(
        () => child as unknown as NodeChildProcess.ChildProcess,
      );
      let release!: () => void;
      const confirmation = new Promise<void>((resolve) => {
        release = resolve;
      });
      const target = ledgerTarget(
        true,
        (addon) => ({
          ...addon,
          confirmSessionClosed: async (receipt, evidence) => {
            const result = await addon.confirmSessionClosed!(receipt, evidence);
            if (result === undefined) throw new Error('Expected ledger confirmation');
            await confirmation;
            return result;
          },
        }),
        true,
      );
      const first = await startSession(target.host, 'trim-first', 'turn-first');
      await startSession(target.host, 'trim-keeper', 'turn-keeper');
      let retireOwner: (() => boolean) | undefined;
      const originalGet = Map.prototype.get;
      const lookup = vi.spyOn(Map.prototype, 'get').mockImplementation(function (
        this: Map<unknown, unknown>,
        key: unknown,
      ) {
        const value: unknown = originalGet.call(this, key);
        if (
          key === first.sessionId &&
          typeof value === 'object' &&
          value !== null &&
          'attempts' in value &&
          'helperGeneration' in value
        )
          retireOwner = () => this.delete(first.sessionId);
        return value;
      });
      const closing = target.host.close(first);
      lookup.mockRestore();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(child.killCalls).toBe(1);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(retireOwner?.()).toBe(true);
      if (exit) child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(closing).resolves.toMatchObject(
        exit ? { kind: 'terminated', helperGeneration: 1 } : { kind: 'termination_requested' },
      );
      if (!exit) child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(0);
    },
  );

  it.each([
    ['E3', false, false],
    ['E3', true, false],
    ['E4', false, false],
    ['E4', true, false],
    ['E3', true, true],
    ['E4', true, true],
  ] as const)(
    'PR11 bounds %s by C + T without resending (exit=%s, suspect=%s)',
    async (entry, exit, suspect) => {
      const child = new ControlledHelperChild();
      vi.mocked(spawn).mockImplementationOnce(
        () => child as unknown as NodeChildProcess.ChildProcess,
      );
      const target = ledgerTarget(true, undefined, true);
      const events: WindowsStopDeliveryEvent[] = [];
      target.host.subscribeWindowsStop!((event) => events.push(event));
      const keeper = await startSession(target.host, 'keeper', 'turn-keeper');
      if (suspect) {
        target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
        await target.dispatch(keeper);
      }
      const operation = entry === 'E3' ? 'stop_pending_start' : 'stop_window_discovery';
      target.helper().holdOnly(operation);
      let stop: () => Promise<unknown>;
      if (entry === 'E3') {
        target.helper().holdOnly('start_session');
        void startSession(target.host, 'pending', 'turn-pending').catch(() => undefined);
        await vi.advanceTimersByTimeAsync(0);
        stop = () => target.host.stopPendingStart!('pending');
      } else {
        target.helper().holdOnly('list_windows_cancellable');
        const discovery = target.host.beginWindowDiscovery!(profile);
        await vi.advanceTimersByTimeAsync(0);
        stop = () => discovery.stop();
      }
      let settled = false;
      const stopping = stop().then(
        (value) => {
          settled = true;
          return value;
        },
        (error) => {
          settled = true;
          return error;
        },
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(child.killCalls).toBe(1);
      expect(settled).toBe(false);
      if (exit) child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(settled).toBe(true);
      const outcome = await stopping;
      if (exit) {
        expect(outcome).toMatchObject({
          kind: 'terminated',
          result: suspect ? 'terminated_target_suspect' : 'terminated_clean',
        });
        expect(events).toContainEqual(
          expect.objectContaining({
            kind: 'notification',
            notification: expect.objectContaining({
              owner: expect.objectContaining({ id: 'keeper' }),
              internalReason: 'shared_helper_stop',
              phase: 'exit_confirmed',
            }),
          }),
        );
      } else if (entry === 'E3') expect(outcome).toEqual({ kind: 'termination_requested' });
      else expect(outcome).toBeInstanceOf(Error);
      const count = sockets[0]!.writes.length;
      await stop().catch(() => undefined);
      expect(sockets[0]!.writes).toHaveLength(count);
      child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(0);
    },
  );

  it('PR11 Controller delivers sessionless E4 to its Task without resending', async () => {
    const child = new ControlledHelperChild();
    vi.mocked(spawn).mockImplementationOnce(
      () => child as unknown as NodeChildProcess.ChildProcess,
    );
    const target = ledgerTarget(true, undefined, true);
    await startSession(target.host, 'keeper', 'turn-keeper');
    target.helper().holdOnly('list_windows_cancellable');
    target.helper().refuse('stop_window_discovery');
    const publish = vi.fn();
    const controller = controllerFor(target.host, [profile], publish);
    const intent = controller.beginWindowCandidates(profile.id, 'task-a', 'frame-a');
    const reading = intent.result.catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    const stopping = controller.stopForTask('task-a', 'task_changed');
    await vi.advanceTimersByTimeAsync(0);
    expect(child.killCalls).toBe(1);
    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(0);
    await stopping;
    expect(publish).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        kind: 'discovery_result',
        taskId: 'task-a',
        reason: 'task_changed',
        results: [expect.objectContaining({ kind: 'terminated', result: 'terminated_clean' })],
      }),
    );
    expect(await reading).toHaveProperty('discoveryResult.reason', 'task_changed');
    expect(() => intent.commit(() => 'stale')).toThrow();
    await controller.dispose();
  });

  it.each([true, false])('PR10 bounds cancel + close by 1 + C + T (exit=%s)', async (exit) => {
    const child = new ControlledHelperChild();
    const kill = vi.spyOn(child, 'kill');
    vi.mocked(spawn).mockImplementationOnce(
      () => child as unknown as NodeChildProcess.ChildProcess,
    );
    const target = ledgerTarget(true, undefined, true);
    const session = await startSession(target.host, 'session-a', 'turn-a');
    target.helper().holdOnly('close_session');
    let settled = false;
    target.helper().holdOnly('cancel');
    const closing = target.host
      .cancel(session, 1)
      .catch(() => undefined)
      .then(() => target.host.close(session))
      .then(
        (result) => {
          settled = true;
          return result;
        },
        () => {
          settled = true;
          return null;
        },
      );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(kill).toHaveBeenCalledTimes(1);
    if (exit) child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(settled).toBe(true);
    expect(await closing).toMatchObject(
      exit ? { kind: 'terminated', result: 'terminated_clean' } : { kind: 'termination_requested' },
    );
  });

  it('PR7b confirms a crash-raced close while blocking the target until exit transfer succeeds', async () => {
    const decide = vi.spyOn(stopKernel, 'decideWindowsStop');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const target = ledgerTarget(true, undefined, true);
    const session = await startSession(target.host, 'session-a', 'turn-a');
    target.control.failReflect = true;
    await target.dispatch(session);
    target.control.reflectWait = gate;
    target.control.deleteCalls.length = 0;
    const close = target.host.close(session);
    await vi.advanceTimersByTimeAsync(0);
    expect(target.control.deleteCalls).toEqual(['session-a']);
    target.control.failTransfer = true;
    children[0]!.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(0);
    release();
    expect(await close).toEqual({
      kind: 'terminated',
      result: 'terminated_target_suspect',
      helperGeneration: 1,
    });
    expect(target.rows.size).toBe(1);
    const exit = decide.mock.results.find(
      (_, index) => decide.mock.calls[index]![1].kind === 'exit_confirmed',
    )!.value;
    expect(exit.state.nativeBlockers.length).toBeGreaterThan(0);
    await expect(startSession(target.host, 'blocked-session', 'blocked-turn')).rejects.toThrow(
      'native_stop_unconfirmed',
    );
    expect(decide.mock.results.at(-1)!.value.state.nativeBlockers.length).toBeGreaterThan(0);
    target.control.failTransfer = false;
    target.control.failReflect = false;
    await target.host.listTargets!().catch(() => undefined);
    await expect(target.host.close(session)).resolves.toEqual({
      kind: 'terminated',
      result: 'terminated_target_suspect',
      helperGeneration: 1,
    });
    expect(decide.mock.results.at(-1)!.value.state.nativeBlockers).toHaveLength(0);
    decide.mockRestore();
  });
  it('PR7b refuses new discovery stops after kill without writing to the old pipe', async () => {
    const child = new ControlledHelperChild();
    vi.mocked(spawn).mockImplementationOnce(
      () => child as unknown as NodeChildProcess.ChildProcess,
    );
    const target = ledgerTarget(true, undefined, true);
    await startSession(target.host, 'keeper', 'turn-keeper');
    target.helper().holdOnly('list_windows_cancellable');
    const discovery = target.host.beginWindowDiscovery!(profile);
    await vi.advanceTimersByTimeAsync(0);
    target.addon.requestWindowsTermination!();
    const writes = sockets[0]!.writes.length;
    await expect(target.addon.stopWindowDiscovery!({ discoveryId: discovery.id })).rejects.toThrow(
      'native_stop_unconfirmed',
    );
    expect(sockets[0]!.writes).toHaveLength(writes);
    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(0);
    await expect(discovery.terminal).resolves.toEqual({ kind: 'terminated', helperGeneration: 1 });
  });
  it('PR7b forgets a session generation after its close is persisted', async () => {
    const target = ledgerTarget(true, undefined, true);
    await startSession(target.host, 'keeper', 'turn-keeper');
    const session = await startSession(target.host, 'closed', 'turn-closed');
    await target.host.close(session);
    const writes = sockets[0]!.writes.length;
    await expect(
      target.addon.close!({ sessionId: session.sessionId, cancelEpoch: 2 }),
    ).rejects.toThrow('native_stop_unconfirmed');
    expect(sockets[0]!.writes).toHaveLength(writes);
  });
  it('PR7b evicts session generation history at 128 and fails closed without a write', async () => {
    const target = ledgerTarget(true, undefined, true);
    for (let index = 0; index < 129; index += 1) {
      const sessionId = `bounded-${index}`;
      await target.addon.startSession!({ sessionId, profile });
      await target.addon.close!({ sessionId, cancelEpoch: 1 });
    }
    const writes = sockets[0]!.writes.length;
    await expect(target.addon.close!({ sessionId: 'bounded-0', cancelEpoch: 2 })).rejects.toThrow(
      'native_stop_unconfirmed',
    );
    expect(sockets[0]!.writes).toHaveLength(writes);
    await expect(
      target.addon.close!({ sessionId: 'bounded-128', cancelEpoch: 2 }),
    ).resolves.toMatchObject({ result: 'closed' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it('PR7b never evicts a live session generation, so Stop still reaches it', async () => {
    const target = ledgerTarget(true, undefined, true);
    await target.addon.startSession!({ sessionId: 'keeper', profile });
    for (let index = 0; index < 130; index += 1) {
      const sessionId = `finished-${index}`;
      await target.addon.startSession!({ sessionId, profile });
      await target.addon.close!({ sessionId, cancelEpoch: 1 });
    }
    await expect(
      target.addon.close!({ sessionId: 'keeper', cancelEpoch: 1 }),
    ).resolves.toMatchObject({ result: 'closed' });
    await expect(target.addon.close!({ sessionId: 'finished-0', cancelEpoch: 2 })).rejects.toThrow(
      'native_stop_unconfirmed',
    );
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it('PR7b holds Host close through exit transfer and absorbs late verification without writes', async () => {
    let release!: () => void;
    let closeLedger!: WindowsCloseCallbacks;
    const target = ledgerTarget(
      true,
      (addon) => ({
        ...addon,
        configureCloseLedger: (callbacks) => {
          closeLedger = callbacks;
          addon.configureCloseLedger!(callbacks);
        },
      }),
      true,
    );
    const session = await startSession(target.host, 'session-a', 'turn-a');
    target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
    await target.dispatch(session);
    target.control.transferWait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled = false;
    const close = target.host.close(session).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(target.control.transfers).toBe(1);
    children[0]!.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(target.rows.size).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(target.rows.size).toBe(0);
    await close;
    const transfers = target.control.transfers;
    const writes = sockets[0]!.writes.length;
    await expect(closeLedger.verified(1, session.sessionId, vi.fn())).resolves.toEqual({
      status: 'confirmed',
    });
    await expect(target.host.close(session)).resolves.toEqual({
      kind: 'terminated',
      result: 'terminated_target_suspect',
      helperGeneration: 1,
    });
    expect(target.control.transfers).toBe(transfers);
    expect(sockets[0]!.writes).toHaveLength(writes);
  });
  it('PR7b does not return a late pending-stop receipt as generation cleanup evidence', async () => {
    let release!: () => void;
    let verifying = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const target = ledgerTarget(
      true,
      (addon) => ({
        ...addon,
        confirmSessionClosed: async (receipt, evidence) => {
          const result = await addon.confirmSessionClosed!(receipt, evidence);
          if (result === undefined) throw new Error('Expected ledger confirmation');
          verifying = true;
          await gate;
          return result;
        },
      }),
      true,
    );
    await startSession(target.host, 'keeper', 'turn-keeper');
    await startSession(target.host, 'pending', 'turn-pending');
    const stop = target.host.stopPendingStart!('pending').catch(() => 'rejected');
    await vi.advanceTimersByTimeAsync(0);
    expect(verifying).toBe(true);
    children[0]!.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(0);
    release();
    expect(await stop).toEqual({
      kind: 'terminated',
      result: 'terminated_clean',
      helperGeneration: 1,
    });
    await expect(target.host.stopPendingStart!('pending')).resolves.toEqual({
      kind: 'terminated',
      result: 'terminated_clean',
      helperGeneration: 1,
    });
  });
  it('PR7b R12 removes both sessions after the shared generation exits', async () => {
    const child = new ControlledHelperChild();
    vi.mocked(spawn).mockImplementationOnce(
      () => child as unknown as NodeChildProcess.ChildProcess,
    );
    const target = ledgerTarget(true, undefined, true);
    const first = await startSession(target.host, 'session-a', 'turn-a');
    const second = await startSession(target.host, 'session-b', 'turn-b');
    target.addon.requestWindowsTermination!();
    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(0);
    await expect(target.host.close(first)).resolves.toEqual({
      kind: 'terminated',
      result: 'terminated_clean',
      helperGeneration: 1,
    });
    await expect(target.host.close(second)).resolves.toEqual({
      kind: 'terminated',
      result: 'terminated_clean',
      helperGeneration: 1,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(target.quarantines).toEqual([]);
    await expect(startSession(target.host, 'session-c', 'turn-c')).resolves.toMatchObject({
      sessionId: 'session-c',
    });
    const count = sockets[1]!.writes.length;
    await expect(target.addon.close!({ sessionId: 'session-a', cancelEpoch: 2 })).rejects.toThrow();
    expect(sockets[1]!.writes).toHaveLength(count);
  });
  it('PR7b binds a start created while the helper pipe is connecting', async () => {
    const connect = transport.connectPipe;
    const target = ledgerTarget(true, undefined, true);
    let starting: Promise<string> | undefined;
    try {
      transport.connectPipe = () => {
        const socket = connect!();
        starting = Promise.resolve(
          target.addon.startSession!({ sessionId: 'during-connect', profile }),
        ).then(
          () => 'resolved',
          () => 'rejected',
        );
        return socket;
      };
      await target.addon.listTargets!({});
      expect(await starting).toBe('resolved');
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      transport.connectPipe = connect;
    }
  });
  it('PR7b semantic quarantine clears only after the exit transfer succeeds', async () => {
    const child = new ControlledHelperChild();
    vi.mocked(spawn).mockImplementationOnce(
      () => child as unknown as NodeChildProcess.ChildProcess,
    );
    const target = ledgerTarget(true, undefined, true);
    const session = await startSession(target.host, 'session-a', 'turn-a');
    target.control.response = ['error', { code: 'semantic_input_in_flight', accepted: true }];
    await target.dispatch(session, ledgerActions[4]);
    target.control.failTransfer = true;
    target.addon.requestWindowsTermination!();
    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(target.addon.hasUnconfirmedSemanticInputs!()).toBe(true);
    expect(target.host.availability().observe).toBe(false);
    target.control.failTransfer = false;
    await target.host.listTargets!().catch(() => undefined);
    expect(target.addon.hasUnconfirmedSemanticInputs!()).toBe(false);
    await expect(target.host.close(session)).resolves.toEqual({
      kind: 'terminated',
      result: 'terminated_target_suspect',
      helperGeneration: 1,
    });
    expect(target.quarantines).toHaveLength(1);
  });
  it.each(['close', 'stopPendingStart'] as const)(
    'PR7b R1a verifies a %s receipt after kill and before exit without closing the session early',
    async (entry) => {
      const child = new ControlledHelperChild();
      vi.mocked(spawn).mockImplementationOnce(
        () => child as unknown as NodeChildProcess.ChildProcess,
      );
      const decide = vi.spyOn(stopKernel, 'decideWindowsStop');
      try {
        const target = ledgerTarget(true, undefined, true);
        const session = await startSession(target.host, 'session-a', 'turn-a');
        target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
        await target.dispatch(session);
        const operation = entry === 'close' ? 'close_session' : 'stop_pending_start';
        target.helper().holdOnly(operation);
        const close = (
          entry === 'close'
            ? target.host.close(session)
            : target.host.stopPendingStart!(session.sessionId)
        ).then(
          () => 'resolved',
          () => 'rejected',
        );
        await vi.advanceTimersByTimeAsync(0);
        target.addon.requestWindowsTermination!();
        target.helper().releaseLast(operation);
        await vi.advanceTimersByTimeAsync(0);
        expect(target.rows.size).toBe(0);
        expect(target.host.availability().control).toBe(false);
        expect(child.killCalls).toBe(1);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(await close).toBe('resolved');
        child.emit('exit', 0, null);
        await vi.advanceTimersByTimeAsync(0);
        expect(decide.mock.results.at(-1)!.value.state.result).toBe('terminated_clean');
        expect(target.quarantines).toEqual([]);
        await expect(target.host.close(session)).resolves.toEqual({
          kind: 'terminated',
          result: 'terminated_clean',
          helperGeneration: 1,
        });
      } finally {
        decide.mockRestore();
      }
    },
  );
  it('PR7b R13 does not write a receipt verified after exit while transfer is pending', async () => {
    const target = ledgerTarget(true, undefined, true);
    const events: WindowsStopDeliveryEvent[] = [];
    target.host.subscribeWindowsStop!((event) => events.push(event));
    const session = await startSession(target.host, 'session-a', 'turn-a');
    target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
    await target.dispatch(session);
    const receipt = { sessionId: session.sessionId, cancelEpoch: 1, inputAttemptCount: 1 };
    const evidence = await target.addon.close!(receipt);
    target.control.failTransfer = true;
    children[0]!.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(0);
    const transfers = target.control.transfers;
    const beforeReceipt = [...events];
    expect(
      events.filter((event) => event.kind === 'registered' && event.owner.kind === 'session'),
    ).toHaveLength(1);
    expect(events.filter((event) => event.kind === 'notification')).toMatchObject([
      { notification: { owner: { id: 'session-a' }, phase: 'exit_confirmed' } },
    ]);
    await expect(target.addon.confirmSessionClosed!(receipt, evidence)).resolves.toEqual({
      status: 'pending',
    });
    expect(target.control.transfers).toBe(transfers);
    expect(target.rows.size).toBe(1);
    expect(target.quarantines).toEqual([]);
    expect(events).toEqual(beforeReceipt);
    expect(
      events.filter((event) => event.kind === 'retired' && event.owner.kind === 'session'),
    ).toEqual([]);
  });
  it('PR7b R13 ignores a valid late dispatch response and duplicate exit in a new generation', async () => {
    const target = ledgerTarget(true, undefined, true);
    const events: WindowsStopDeliveryEvent[] = [];
    target.host.subscribeWindowsStop!((event) => events.push(event));
    const old = await startSession(target.host, 'old-session', 'old-turn');
    const oldHelper = target.helper();
    oldHelper.holdOnly('dispatch');
    const pending = target.dispatch(old);
    await vi.advanceTimersByTimeAsync(0);
    const oldChild = children[0]!;
    oldChild.emit('exit', 1, null);
    expect((await pending).outcome).toBe('rejected');
    await vi.advanceTimersByTimeAsync(0);
    const quarantines = [...target.quarantines];
    target.control.pid = 43;
    const fresh = await startSession(target.host, 'fresh-session', 'fresh-turn');
    const beforeLate = [...events];
    const sessionEvents = events.filter(
      (event) =>
        (event.kind === 'notification' ? event.notification.owner : event.owner).kind === 'session',
    );
    expect(sessionEvents.map(({ kind }) => kind)).toEqual([
      'registered',
      'notification',
      'notification',
      'retired',
      'registered',
    ]);
    oldHelper.releaseLast('dispatch');
    oldChild.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(beforeLate);
    expect(target.quarantines).toEqual(quarantines);
    expect(target.rows.size).toBe(0);
    const writes = sockets[1]!.writes.length;
    await expect(
      target.host.observe(old, { requestId: 'old-observe', cancelEpoch: 0 }),
    ).rejects.toThrow('native_session_missing');
    expect(sockets[1]!.writes).toHaveLength(writes);
    expect((await target.dispatch(fresh)).outcome).toBe('resolved');
    expect(children[1]!.killed).toBe(false);
  });
  it('PR7b duplicate receipts do not reinstall a blocker during R19b', async () => {
    const decide = vi.spyOn(stopKernel, 'decideWindowsStop');
    try {
      const target = ledgerTarget(true);
      const session = await startSession(target.host, 'session-a', 'turn-a');
      target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
      await target.dispatch(session);
      target.control.failTransfer = true;
      const receipt = { sessionId: session.sessionId, cancelEpoch: 1, inputAttemptCount: 1 };
      const evidence = await target.addon.close!(receipt);
      await target.addon.confirmSessionClosed!(receipt, evidence);
      const receivedCount = () =>
        decide.mock.calls.filter(
          ([, event]) => event.kind === 'receipt' && event.status === 'received',
        ).length;
      expect(receivedCount()).toBe(1);
      await target.addon.close!(receipt);
      expect(receivedCount()).toBe(1);
    } finally {
      decide.mockRestore();
    }
  });
  it('PR7b bounds each entry to two storage retries and retains the remaining hold', async () => {
    const target = ledgerTarget();
    const sessions = [];
    for (let index = 0; index < 3; index += 1) {
      target.control.pid = 42 + index;
      sessions.push(await startSession(target.host, `session-${index}`, `turn-${index}`));
    }
    target.control.failReflect = true;
    for (const session of sessions) await target.dispatch(session);
    expect(target.rows.size).toBe(3);
    let finish!: () => void;
    target.control.reflectWait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let settled = false;
    const entry = target.host.listTargets!()
      .catch(() => undefined)
      .then(() => {
        settled = true;
      });
    try {
      await vi.advanceTimersByTimeAsync(4_000);
      expect(settled).toBe(true);
      expect(target.rows.size).toBe(3);
    } finally {
      finish();
      await entry;
    }
  });
  it('PR7b rotates two retries per entry without starving a third held target', async () => {
    const target = ledgerTarget();
    const sessions = [];
    for (let index = 0; index < 3; index += 1) {
      target.control.pid = 42 + index;
      sessions.push(await startSession(target.host, `session-${index}`, `turn-${index}`));
    }
    target.control.failReflect = true;
    for (const session of sessions) await target.dispatch(session);
    expect(target.rows.size).toBe(3);
    target.control.deleteCalls.length = 0;
    await target.host.listTargets!().catch(() => undefined);
    expect(target.control.deleteCalls).toEqual(['session-0', 'session-1']);
    target.control.deleteCalls.length = 0;
    await target.host.listTargets!().catch(() => undefined);
    expect(target.control.deleteCalls).toEqual(['session-2', 'session-0']);
    const writes = dispatchWrites(sockets[0]!).length;
    expect(await target.dispatch(sessions[2]!)).toMatchObject({
      outcome: 'resolved',
      value: { result: 'rejected', reasonCode: 'native_unavailable' },
    });
    expect(dispatchWrites(sockets[0]!)).toHaveLength(writes);
    target.control.failReflect = false;
    target.control.failedDeletes.add('session-0').add('session-1');
    for (let index = 0; index < 2; index += 1)
      await target.host.listTargets!().catch(() => undefined);
    expect([...target.rows.values()].map((row) => row.sessionId).sort()).toEqual([
      'session-0',
      'session-1',
    ]);
  });
  it('PR7b old transfer cleanup preserves a new session and pending discovery', async () => {
    const cleanup = vi.fn();
    const target = ledgerTarget(
      true,
      (addon) => ({
        ...addon,
        cleanupWindowsGeneration: (generation) => {
          cleanup(generation);
          addon.cleanupWindowsGeneration!(generation);
        },
      }),
      true,
    );
    const notifications: WindowsOwnerStopNotification[] = [];
    const unsubscribe = target.host.subscribeWindowsStop!((event) => {
      if (event.kind === 'notification') notifications.push(event.notification);
    });
    const old = await startSession(target.host, 'old', 'turn-old');
    target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
    await target.dispatch(old);
    target.control.failTransfer = true;
    children[0]!.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(cleanup).not.toHaveBeenCalled();
    expect(
      notifications.map(({ phase, reason, internalReason }) => [phase, reason, internalReason]),
    ).toEqual([['exit_confirmed', 'native_unavailable', 'crash']]);
    target.control.pid = 43;
    target.control.response = null;
    await target.host.listWindows(profile);
    const fresh = await startSession(target.host, 'fresh', 'turn-fresh');
    await startSession(target.host, 'fresh-keeper', 'turn-fresh-keeper');
    target.helper().holdOnly('list_windows_cancellable');
    const discovery = target.host.beginWindowDiscovery!(profile);
    await vi.advanceTimersByTimeAsync(0);
    let terminal = false;
    void discovery.terminal.then(() => {
      terminal = true;
    });
    target.control.failTransfer = false;
    await target.host.listTargets!().catch(() => undefined);
    expect(cleanup.mock.calls).toEqual([[1]]);
    expect(
      notifications.map(({ owner, phase }) => [owner.id, owner.helperGeneration, phase]),
    ).toEqual([
      ['old', 1, 'exit_confirmed'],
      ['old', 1, 'cleanup_completed'],
    ]);
    unsubscribe();
    expect(terminal).toBe(false);
    expect(children[1]!.killed).toBe(false);
    expect((await target.dispatch(fresh)).outcome).toBe('resolved');
    await expect(target.host.close(old)).resolves.toEqual({
      kind: 'terminated',
      result: 'terminated_target_suspect',
      helperGeneration: 1,
    });
    await expect(target.host.close(fresh)).resolves.toBeUndefined();
    expect(children[1]!.killed).toBe(false);
    target.helper().releaseLast('list_windows_cancellable');
    await expect(discovery.result).resolves.toHaveLength(1);
    await expect(discovery.terminal).resolves.toMatchObject({ kind: 'completed' });
    expect(children[1]!.killed).toBe(false);
  });
  it.each(['stop', 'pipe-error'] as const)(
    'PR7b retains only close evidence on %s',
    async (cause) => {
      const child = new ControlledHelperChild();
      vi.mocked(spawn).mockImplementationOnce(
        () => child as unknown as NodeChildProcess.ChildProcess,
      );
      const target = ledgerTarget(true, undefined, true);
      await startSession(target.host, 'session-a', 'turn-a');
      target.helper().holdOnly('stop_pending_start');
      const stop = Promise.resolve(target.addon.stopPendingStart!({ sessionId: 'session-a' })).then(
        () => 'resolved',
        () => 'rejected',
      );
      await vi.advanceTimersByTimeAsync(0);
      if (cause === 'stop') target.addon.requestWindowsTermination!();
      else sockets[0]!.emit('error', new Error('synthetic pipe error'));
      const writes = sockets[0]!.writes.length;
      await expect(target.addon.listTargets!({})).rejects.toThrow('native_stop_unconfirmed');
      expect(sockets[0]!.writes).toHaveLength(writes);
      expect(sockets[0]!.destroyed).toBe(cause === 'pipe-error');
      target.helper().releaseLast('stop_pending_start');
      expect(await stop).toBe(cause === 'stop' ? 'resolved' : 'rejected');
      child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(0);
    },
  );
  it.each(['start_session', 'list_windows_cancellable', 'pick_application'] as const)(
    'PR7b R9/R10 ends pending %s without manufacturing target identity',
    async (operation) => {
      const child = new ControlledHelperChild();
      vi.mocked(spawn).mockImplementationOnce(
        () => child as unknown as NodeChildProcess.ChildProcess,
      );
      const target = ledgerTarget(true, undefined, true);
      await startSession(target.host, 'keeper', 'turn-keeper');
      target.helper().holdOnly(operation);
      const work =
        operation === 'pick_application'
          ? target.host.pickApplication({
              activationToken: 'synthetic-activation',
              pickerKind: 'application',
            })
          : operation === 'list_windows_cancellable'
            ? target.host.listWindows(profile)
            : startSession(target.host, 'pending', 'turn-pending');
      const result = work.then(
        () => 'resolved',
        () => 'rejected',
      );
      await vi.advanceTimersByTimeAsync(0);
      target.addon.requestWindowsTermination!();
      child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(0);
      expect(await result).toBe('rejected');
      expect(target.host.availability().control).toBe(true);
      expect(target.quarantines).toEqual([]);
      await expect(startSession(target.host, 'new-session', 'new-turn')).resolves.toMatchObject({
        sessionId: 'new-session',
      });
      const writes = sockets[1]!.writes.length;
      await target.host.stopPendingStart!('pending').catch(() => undefined);
      expect(sockets[1]!.writes).toHaveLength(writes);
    },
  );
  it('PR7b does not carry discovery PID evidence into the next generation', async () => {
    const target = ledgerTarget(true, undefined, true);
    await target.host.listWindows(profile);
    children[0]!.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(0);
    await target.host.listWindows(profile);
    const requests = sockets[1]!.writes.map(
      (bytes) =>
        JSON.parse(decodeComputerUseNativeFrame(bytes).metadata.toString('utf8')) as Record<
          string,
          unknown
        >,
    );
    expect(
      requests.find((value) => value['operation'] === 'list_windows_cancellable'),
    ).not.toHaveProperty('pid');
  });
  it('PR7b cleans a StartOwner waiting for discovery without sending close', async () => {
    const target = ledgerTarget(true, undefined, true);
    await startSession(target.host, 'keeper', 'turn-keeper');
    target.helper().holdOnly('list_windows_cancellable');
    const starting = startSession(target.host, 'pending', 'turn-pending').catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    const closeCount = () =>
      sockets[0]!.writes.filter((bytes) => {
        const metadata = JSON.parse(
          decodeComputerUseNativeFrame(bytes).metadata.toString('utf8'),
        ) as Record<string, unknown>;
        return (
          metadata['operation'] === 'close_session' ||
          metadata['operation'] === 'stop_pending_start'
        );
      }).length;
    const count = closeCount();
    children[0]!.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(0);
    await starting;
    expect(closeCount()).toBe(count);
    expect(target.host.availability().control).toBe(true);
    await expect(startSession(target.host, 'new-session', 'new-turn')).resolves.toMatchObject({
      sessionId: 'new-session',
    });
  });
  it('PR7b leaves kill-gap starts and discoveries unsubmitted after cleanup', async () => {
    const child = new ControlledHelperChild();
    vi.mocked(spawn).mockImplementationOnce(
      () => child as unknown as NodeChildProcess.ChildProcess,
    );
    const target = ledgerTarget(true, undefined, true);
    await startSession(target.host, 'keeper', 'turn-keeper');
    target.addon.requestWindowsTermination!();
    const writes = sockets[0]!.writes.length;
    const discovery = target.host.beginWindowDiscovery!(profile);
    await expect(startSession(target.host, 'gap', 'turn-gap')).rejects.toThrow();
    await expect(discovery.result).rejects.toThrow();
    expect(sockets[0]!.writes).toHaveLength(writes);
    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(0);
    await expect(discovery.terminal).resolves.toEqual({ kind: 'not_submitted' });
    await expect(target.host.stopPendingStart!('gap')).resolves.toEqual({ kind: 'not_submitted' });
    expect(target.host.availability().control).toBe(true);
    await expect(startSession(target.host, 'fresh', 'turn-fresh')).resolves.toMatchObject({
      sessionId: 'fresh',
    });
  });
  it.each(['R1a', 'R12'] as const)(
    'PR7b keeps the legacy %s path with termination disabled',
    async (scenario) => {
      const target = ledgerTarget(true);
      const first = await startSession(target.host, 'first', 'turn-first');
      const second = await startSession(target.host, 'second', 'turn-second');
      target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
      await target.dispatch(first);
      let closing: Promise<string> | undefined;
      if (scenario === 'R1a') {
        target.helper().holdOnly('close_session');
        closing = target.host.close(first).then(
          () => 'resolved',
          () => 'rejected',
        );
        await vi.advanceTimersByTimeAsync(0);
        sockets[0]!.emit('error', new Error('synthetic pipe error'));
        target.helper().releaseLast('close_session');
      } else children[0]!.emit('exit', 1, null);
      await vi.advanceTimersByTimeAsync(0);
      if (closing !== undefined) expect(await closing).toBe('rejected');
      expect(target.rows.size).toBe(1);
      expect(target.quarantines).toEqual([]);
      await expect(
        target.host.observe(second, { requestId: 'observe-old', cancelEpoch: 0 }),
      ).rejects.not.toThrow('native_session_missing');
    },
  );
  it.each([
    'start_session',
    'list_windows_cancellable',
    'pick_application',
    'close_session',
  ] as const)('PR7b hides identity in %s errors', async (operation) => {
    const base = responders();
    let fail = false;
    const target = createTarget({
      ...base,
      stop_pending_start: (metadata) => [
        'probe_result',
        {
          result: 'closed',
          drained: true,
          sessionId: metadata['sessionId'],
          cancelEpoch: 2,
          inputAttemptCount: 0,
        },
      ],
      [operation]: (metadata) =>
        fail
          ? [
              'error',
              { code: 'native_unavailable', pid: 42, processStartTime: '133000000000000001' },
            ]
          : (base[operation] ?? discoveryResponders()[operation])!(metadata),
    });
    const session = await startSession(target.host, 'keeper', 'turn-keeper');
    fail = true;
    const work =
      operation === 'start_session'
        ? startSession(target.host, 'failing', 'turn-failing')
        : operation === 'list_windows_cancellable'
          ? target.host.listWindows(profile)
          : operation === 'pick_application'
            ? target.host.pickApplication({
                activationToken: 'synthetic-activation',
                pickerKind: 'application',
              })
            : target.host.close(session);
    const error: unknown = await work.then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expectNoProcessIdentity(error);
  });
  it.each(['client', 'manager'] as const)(
    'PR7b does not adopt a discovery response in the exit-to-transfer gap (%s)',
    async (boundary) => {
      let exitOnDiscovery = false;
      const child = new ControlledHelperChild();
      vi.mocked(spawn).mockImplementationOnce(
        () => child as unknown as NodeChildProcess.ChildProcess,
      );
      const target = ledgerTarget(
        true,
        (addon) => ({
          ...addon,
          discoverWindows: async (input) => {
            const value = await addon.discoverWindows!(input);
            if (exitOnDiscovery && boundary === 'client') {
              exitOnDiscovery = false;
              child.emit('exit', 1, null);
            }
            return value;
          },
        }),
        true,
      );
      const session = await startSession(target.host, 'keeper', 'turn-keeper');
      target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
      await target.dispatch(session);
      target.control.failTransfer = true;
      exitOnDiscovery = true;
      const discovery = target.host.beginWindowDiscovery!(profile);
      if (boundary === 'manager') void discovery.terminal.then(() => child.emit('exit', 1, null));
      const result = discovery.result.then(
        () => 'resolved',
        () => 'rejected',
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(await result).toBe('rejected');
      expect(target.rows.size).toBe(1);
      if (boundary === 'client') expect(target.host.availability().control).toBe(false);
      target.control.failTransfer = false;
      await target.host.listTargets!().catch(() => undefined);
      await expect(discovery.terminal).resolves.toMatchObject(
        boundary === 'client' ? { kind: 'terminated', helperGeneration: 1 } : { kind: 'completed' },
      );
    },
  );
  it.each([true, false])(
    'PR7b hides process identity in dispatch failure (accepted=%s)',
    async (accepted) => {
      const target = ledgerTarget();
      const session = await startSession(target.host, 'session-a', 'turn-a');
      target.control.response = [
        'error',
        {
          code: 'input_not_confirmed',
          accepted,
          pid: 42,
          processStartTime: '133000000000000001',
        },
      ];
      const result = await target.dispatch(session);
      expect(result.outcome).toBe(accepted ? 'rejected' : 'resolved');
      expectNoProcessIdentity(result);
      if (result.outcome === 'rejected') expectNoProcessIdentity(result.error);
      if (result.outcome === 'rejected' && result.error instanceof Error)
        expect(result.error.message).toBe('input_not_confirmed');
    },
  );
  it.each([true, false])(
    'PR7a retries PID-less spawn without kill (termination=%s)',
    async (termination) => {
      const started = vi.fn();
      const event = vi.fn();
      const child = new ControlledHelperChild();
      Object.defineProperty(child, 'pid', { value: undefined });
      vi.mocked(spawn).mockImplementationOnce(() => {
        queueMicrotask(() => child.emit('error', new Error('synthetic spawn failure')));
        return child as unknown as NodeChildProcess.ChildProcess;
      });
      const target = ledgerTarget(
        true,
        (addon) => ({
          ...addon,
          configureWindowsTermination: (callbacks) =>
            addon.configureWindowsTermination!({
              ...callbacks,
              started: (id) => {
                started(id);
                callbacks.started(id);
              },
              event: (id, kind) => {
                event(id, kind);
                callbacks.event(id, kind);
              },
            }),
        }),
        termination,
      );
      await expect(target.addon.listTargets!({})).rejects.toThrow('PID is unavailable');
      expect(started).not.toHaveBeenCalled();
      expect(event).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(target.addon.listTargets!({})).resolves.toEqual([]);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(child.killCalls).toBe(0);
      expect(started).toHaveBeenCalledTimes(termination ? 1 : 0);
      expect(event.mock.calls.filter(([, kind]) => kind === 'kill_requested')).toEqual([]);
    },
  );
  it('PR7a receipt storage failure followed by exit recovers and completes the receipt', async () => {
    let closeLedger!: WindowsCloseCallbacks;
    const cleanup = vi.fn();
    const persisted = vi.fn();
    const target = ledgerTarget(
      true,
      (addon) => ({
        ...addon,
        configureCloseLedger: (callbacks) => {
          closeLedger = callbacks;
          addon.configureCloseLedger!({
            ...callbacks,
            verified: (generation, sessionId, complete) =>
              callbacks.verified(generation, sessionId, () => {
                persisted();
                complete();
              }),
          });
        },
        cleanupWindowsGeneration: (id) => {
          cleanup(id);
          addon.cleanupWindowsGeneration!(id);
        },
      }),
      true,
    );
    const session = await startSession(target.host, 'session-1', 'turn-1');
    target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
    await target.dispatch(session);
    target.control.failTransfer = true;
    const evidence = await target.addon.close!({ sessionId: session.sessionId, cancelEpoch: 1 });
    const receipt = { sessionId: session.sessionId, cancelEpoch: 1, inputAttemptCount: 1 };
    await expect(target.addon.confirmSessionClosed!(receipt, evidence)).resolves.toEqual({
      status: 'pending',
    });
    children[0]!.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(target.rows.size).toBe(1);
    expect(persisted).not.toHaveBeenCalled();
    target.control.failTransfer = false;
    await target.addon.listTargets!({});
    expect(target.rows.size).toBe(0);
    expect(target.quarantines).toEqual([
      { identity: { pid: 42, creationTime: '133000000000000001' }, reason: 'exit_suspect' },
    ]);
    expect(cleanup.mock.calls).toEqual([[1]]);
    expect(persisted).toHaveBeenCalledTimes(1);
    expect(closeLedger.blocked(1)).toBe(false);
    await target.addon.listTargets!({});
    expect(persisted).toHaveBeenCalledTimes(1);
  });
  it.each(['late-true', 'late-false', 'exit-first'] as const)(
    'PR7a receipt absorption %s completes once without late state changes',
    async (order) => {
      const decide = vi.spyOn(stopKernel, 'decideWindowsStop');
      let retryStorage!: () => Promise<void>;
      let finishTransfer!: () => void;
      let closeLedger!: WindowsCloseCallbacks;
      const cleanup = vi.fn();
      const persisted = vi.fn();
      const target = ledgerTarget(
        true,
        (addon) => ({
          ...addon,
          configureWindowsTermination: (callbacks) => {
            retryStorage = callbacks.prepare;
            addon.configureWindowsTermination!(callbacks);
          },
          configureCloseLedger: (callbacks) => {
            closeLedger = callbacks;
            addon.configureCloseLedger!({
              ...callbacks,
              verified: (generation, sessionId, complete) =>
                callbacks.verified(generation, sessionId, () => {
                  persisted();
                  complete();
                }),
            });
          },
          cleanupWindowsGeneration: (id) => {
            cleanup(id);
            addon.cleanupWindowsGeneration!(id);
          },
        }),
        true,
      );
      const session = await startSession(target.host, 'session-1', 'turn-1');
      target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
      await target.dispatch(session);
      const evidence = await target.addon.close!({ sessionId: session.sessionId, cancelEpoch: 1 });
      const receipt = { sessionId: session.sessionId, cancelEpoch: 1, inputAttemptCount: 1 };
      if (order === 'exit-first') {
        target.control.failTransfer = true;
        children[0]!.emit('exit', 1, null);
        await vi.advanceTimersByTimeAsync(0);
      } else {
        target.control.transferWait = new Promise<void>((resolve) => {
          finishTransfer = resolve;
        });
      }
      const confirmation = target.addon.confirmSessionClosed!(receipt, evidence);
      await vi.advanceTimersByTimeAsync(order === 'exit-first' ? 0 : 2_000);
      await expect(confirmation).resolves.toEqual({ status: 'pending' });
      expect(persisted).not.toHaveBeenCalled();
      expect(target.rows.size).toBe(1);
      expect(closeLedger.blocked(1)).toBe(true);
      if (order === 'exit-first') {
        await retryStorage();
        expect(persisted).not.toHaveBeenCalled();
        expect(target.rows.size).toBe(1);
        expect(closeLedger.blocked(1)).toBe(true);
        target.control.failTransfer = false;
        await retryStorage();
      } else {
        expect(target.control.transfers).toBe(1);
        target.control.transferWait = null;
        children[0]!.emit('exit', 1, null);
        await vi.advanceTimersByTimeAsync(0);
        expect(target.control.transfers).toBe(2);
      }
      expect(target.rows.size).toBe(0);
      expect(target.quarantines).toEqual([
        { identity: { pid: 42, creationTime: '133000000000000001' }, reason: 'exit_suspect' },
      ]);
      expect(cleanup.mock.calls).toEqual([[1]]);
      expect(persisted).toHaveBeenCalledTimes(1);
      expect(closeLedger.blocked(1)).toBe(false);
      const settledState = decide.mock.results.at(-1)!.value.state;
      if (order !== 'exit-first') {
        target.control.failTransfer = order === 'late-false';
        finishTransfer();
        await vi.advanceTimersByTimeAsync(0);
        expect(decide.mock.results.at(-1)!.value.state).toEqual(settledState);
      }
      expect(closeLedger.blocked(1)).toBe(false);
      expect(target.rows.size).toBe(0);
      expect(cleanup.mock.calls).toEqual([[1]]);
      await expect(closeLedger.verified(1, session.sessionId, vi.fn())).resolves.toEqual({
        status: 'confirmed',
      });
      expect(persisted).toHaveBeenCalledTimes(1);
      decide.mockRestore();
    },
  );
  it('PR7a foreground-only exit discards rows for R23 and cleans up once', async () => {
    const cleanup = vi.fn();
    const original = stopKernel.decideWindowsStop;
    const decide = vi.spyOn(stopKernel, 'decideWindowsStop').mockImplementation((state, event) => {
      const result = original(state, event);
      if (event.kind !== 'start_generation') return result;
      if (result.kind !== 'generation_started') throw new Error('Expected generation start');
      // Seed a foreground row at the kernel boundary to isolate exit cleanup.
      return {
        ...result,
        state: {
          ...result.state,
          rows: [
            {
              helperGeneration: event.nextHelperGeneration,
              sessionId: 'foreground-session',
              requestId: 'foreground-request',
              kind: 'foreground',
              inputPath: 'foreground',
              state: 'effect_unconfirmed',
              identity: { pid: 42, creationTime: '133000000000000001' },
            },
          ],
        },
      };
    });
    try {
      const target = ledgerTarget(
        true,
        (addon) => ({
          ...addon,
          cleanupWindowsGeneration: (id) => {
            cleanup(id);
            addon.cleanupWindowsGeneration!(id);
          },
        }),
        true,
      );
      await target.addon.listTargets!({});
      children[0]!.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(0);
      expect(cleanup.mock.calls).toEqual([[1]]);
      expect(target.control.transfers).toBe(1);
      expect(target.quarantines).toEqual([]);
      expect(target.deleted).toEqual([]);
      expect(decide.mock.calls.filter(([, event]) => event.kind === 'retry_storage')).toEqual([]);
      await expect(target.addon.listTargets!({})).resolves.toEqual([]);
    } finally {
      decide.mockRestore();
    }
  });
  it.each(ledgerActions)('PR7a exit transfers an unconfirmed $name row', async (sample) => {
    const target = ledgerTarget(true, undefined, true);
    const session = await startSession(target.host, 'session-1', 'turn-1');
    target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
    await target.dispatch(session, sample);
    expect([...target.rows.values()]).toMatchObject([{ kind: sample.kind }]);
    children[0]!.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(target.rows.size).toBe(0);
    expect(target.quarantines).toEqual([
      { identity: { pid: 42, creationTime: '133000000000000001' }, reason: 'exit_suspect' },
    ]);
  });
  it('PR7a retains a killed child through T and classifies its late exit once', async () => {
    const decide = vi.spyOn(stopKernel, 'decideWindowsStop');
    const child = new ControlledHelperChild();
    vi.mocked(spawn).mockImplementationOnce(
      () => child as unknown as NodeChildProcess.ChildProcess,
    );
    try {
      const target = ledgerTarget(true, undefined, true);
      const session = await startSession(target.host, 'session-1', 'turn-1');
      target.helper().holdOnly('dispatch');
      const dispatch = target.dispatch(session);
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]!.emit('data', Buffer.alloc(COMPUTER_USE_NATIVE_FRAME_HEADER_BYTES, 255));
      await dispatch;
      expect(child.killed).toBe(true);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(decide.mock.results.at(-1)?.value.state.result).toBe('termination_requested');
      expect(target.rows.size).toBe(1);
      await expect(target.addon.listTargets!({})).rejects.toThrow();
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(child.killCalls).toBe(1);
      const exitListener = child.listeners('exit')[0]!;
      child.emit('exit', 0, null);
      exitListener(0, null);
      child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(0);
      expect(target.rows.size).toBe(0);
      expect(target.quarantines).toEqual([
        { identity: { pid: 42, creationTime: '133000000000000001' }, reason: 'exit_suspect' },
      ]);
      expect(decide.mock.calls.filter(([, event]) => event.kind === 'exit_confirmed')).toHaveLength(
        1,
      );
      expect(
        decide.mock.results.filter((result) => result.value.notification.kind !== 'unchanged'),
      ).toHaveLength(2);
      expect(
        decide.mock.calls.filter(([, event]) => event.kind === 'exit_wait_exceeded'),
      ).toHaveLength(1);
      expect(child.killCalls).toBe(1);
    } finally {
      decide.mockRestore();
    }
  });
  it.each(['cancel', 'close_session', 'stop_pending_start'] as const)(
    'PR7c records Stop before %s races with transport failure',
    async (operation) => {
      const decide = vi.spyOn(stopKernel, 'decideWindowsStop');
      try {
        const target = ledgerTarget(true, undefined, true);
        await startSession(target.host, 'session-1', 'turn-1');
        target.helper().holdOnly(operation);
        const stopping =
          operation === 'cancel'
            ? target.addon.cancel!({ sessionId: 'session-1', cancelEpoch: 1 })
            : operation === 'close_session'
              ? target.addon.close!({ sessionId: 'session-1', cancelEpoch: 1 })
              : target.addon.stopPendingStart!({ sessionId: 'session-1' });
        const settled = Promise.resolve(stopping).catch(() => undefined);
        await vi.advanceTimersByTimeAsync(0);
        sockets[0]!.emit('error', new Error('synthetic transport failure'));
        await vi.advanceTimersByTimeAsync(0);
        expect(decide.mock.results.map((result) => result.value.notification)).toContainEqual({
          kind: 'generation_exit',
          cause: 'abortTransport',
          late: false,
          result: 'terminated_clean',
          initiatorReason: 'requested_reason',
        });
        await settled;
      } finally {
        decide.mockRestore();
      }
    },
  );
  it.each(['timeout', 'write-failure'] as const)(
    'PR10 picker delivery retains its owner until exit cleanup (%s)',
    async (failure) => {
      const child = new ControlledHelperChild();
      vi.mocked(spawn).mockImplementationOnce(
        () => child as unknown as NodeChildProcess.ChildProcess,
      );
      const target = ledgerTarget(true, undefined, true);
      const events: WindowsStopDeliveryEvent[] = [];
      target.host.subscribeWindowsStop!((event) => events.push(event));
      await startSession(target.host, 'keeper', 'turn-keeper');
      target.helper().holdOnly('pick_application');
      if (failure === 'write-failure') sockets[0]!.holdWriteCallbacks = true;
      const picking = expect(
        target.addon.pickApplication!({ activationToken: 'synthetic', pickerKind: 'application' }),
      ).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(0);
      if (failure === 'timeout') await vi.advanceTimersByTimeAsync(5 * 60_000);
      else sockets[0]!.writeCallbacks.at(-1)!(new Error('synthetic write failure'));
      await picking;
      const pickerEvents = () =>
        events.filter(
          (event) =>
            (event.kind === 'notification' ? event.notification.owner : event.owner).kind ===
            'picker',
        );
      expect(pickerEvents().some((event) => event.kind === 'retired')).toBe(false);
      child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(0);
      expect(
        pickerEvents().flatMap((event) =>
          event.kind === 'notification' ? [event.notification.phase] : [],
        ),
      ).toEqual(['exit_confirmed', 'cleanup_completed']);
      expect(pickerEvents().at(-1)?.kind).toBe('retired');
    },
  );

  it.each(['success', 'error'] as const)(
    'PR7c-2 retires a settled picker after %s',
    async (outcome) => {
      const target = ledgerTarget(true, undefined, true);
      const events: WindowsStopDeliveryEvent[] = [];
      target.host.subscribeWindowsStop!((event) => events.push(event));
      await startSession(target.host, 'keeper', 'turn-keeper');
      if (outcome === 'error') target.helper().refuse('pick_application');
      const picking = Promise.resolve(
        target.addon.pickApplication!({ activationToken: 'synthetic', pickerKind: 'application' }),
      );
      if (outcome === 'error') await expect(picking).rejects.toThrow('SESSION_MISSING');
      else await expect(picking).resolves.toBeNull();
      const pickerEvents = () =>
        events.filter(
          (event) =>
            (event.kind === 'notification' ? event.notification.owner : event.owner).kind ===
            'picker',
        );
      expect(pickerEvents().map(({ kind }) => kind)).toEqual(['registered', 'retired']);
      const registered = pickerEvents()[0];
      expect(registered?.kind).toBe('registered');
      if (registered?.kind !== 'registered') throw new Error('Missing picker registration');
      expect(pickerEvents()[1]).toEqual({ kind: 'retired', owner: registered.owner });
      children[0]!.emit('exit', 1, null);
      await vi.advanceTimersByTimeAsync(0);
      expect(pickerEvents().map(({ kind }) => kind)).toEqual(['registered', 'retired']);
    },
  );

  it('PR7c-2 classifies stop without a stopping owner as shared helper stop', async () => {
    const target = ledgerTarget(true, undefined, true);
    const events: WindowsStopDeliveryEvent[] = [];
    target.host.subscribeWindowsStop!((event) => events.push(event));
    await startSession(target.host, 'keeper', 'turn-keeper');
    target.addon.requestWindowsTermination!();
    await vi.advanceTimersByTimeAsync(0);
    const notifications = events.flatMap((event) =>
      event.kind === 'notification' ? [event.notification] : [],
    );
    expect(notifications.map(({ phase }) => phase)).toEqual([
      'exit_confirmed',
      'cleanup_completed',
    ]);
    expect(
      notifications.every(
        ({ internalReason, reason }) =>
          internalReason === 'shared_helper_stop' && reason === 'native_unavailable',
      ),
    ).toBe(true);
  });

  it.each(['timeout', 'reject', 'replacement', 'success'] as const)(
    'PR11 fixes the Stop generation before work and throughout kill wait (%s)',
    async (mode) => {
      let callbacks!: WindowsTerminationCallbacks;
      let owners: { map: Map<unknown, unknown> } | undefined;
      let originalOwner: object | undefined;
      const originalSet = Map.prototype.set;
      // Capture the private owner map at its normal insertion boundary, without exposing a
      // production test API. Only this session's StartOwner insertion matches.
      const insertion = vi.spyOn(Map.prototype, 'set').mockImplementation(function (
        this: Map<unknown, unknown>,
        key: unknown,
        value: unknown,
      ) {
        if (
          key === 'generation-race' &&
          typeof value === 'object' &&
          value !== null &&
          'nativeInvoked' in value
        ) {
          owners = { map: this };
          originalOwner = value;
        }
        return originalSet.call(this, key, value);
      });
      const kill = vi.fn();
      const target = ledgerTarget(
        true,
        (addon) => ({
          ...addon,
          configureWindowsTermination: (value) => {
            callbacks = value;
            addon.configureWindowsTermination!(value);
          },
          requestWindowsTermination: kill,
          close: (input) => {
            closeWork();
            // A verified close before the deadline returns normally even without an initial owner.
            if (mode === 'success') return addon.close!(input);
            return mode === 'reject'
              ? Promise.reject(new Error('original close failure'))
              : new Promise(() => {});
          },
        }),
        true,
      );
      let session: Awaited<ReturnType<typeof startSession>>;
      try {
        session = await startSession(target.host, 'generation-race', 'turn-race');
      } finally {
        insertion.mockRestore();
      }
      if (owners === undefined || originalOwner === undefined)
        throw new Error('Missing StartOwner');
      const ownerMap = owners.map;
      const replacement = { ...originalOwner, helperGeneration: 2 };
      if (mode !== 'replacement') ownerMap.delete(session.sessionId);
      const closeWork = () => {
        if (mode !== 'replacement') ownerMap.set(session.sessionId, replacement);
      };
      let settled = false;
      const stopping = target.host.close(session);
      void stopping.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      if (mode === 'success') {
        await expect(stopping).resolves.toBeUndefined();
        expect(kill).not.toHaveBeenCalled();
        return;
      }
      const rejected =
        mode === 'replacement'
          ? undefined
          : expect(stopping).rejects.toMatchObject({
              reasonCode: 'native_stop_unconfirmed',
              // The replaced work() / deadline error is kept for diagnostics.
              cause: expect.any(Error),
            });
      await vi.advanceTimersByTimeAsync(COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS);
      if (mode !== 'replacement') {
        await rejected;
        expect(kill).not.toHaveBeenCalled();
        expect(ownerMap.get(session.sessionId)).toBe(replacement);
        return;
      }
      expect(kill).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      ownerMap.set(session.sessionId, replacement);
      callbacks.started(2);
      callbacks.owned!(2, 'session', session.sessionId);
      callbacks.exited(2, 'stop');
      await vi.advanceTimersByTimeAsync(0);
      // Another generation's exit settles nothing, and its owner never gets a kill of its own.
      expect(settled).toBe(false);
      expect(kill).toHaveBeenCalledTimes(1);
      callbacks.exited(1, 'stop');
      await expect(stopping).resolves.toEqual({
        kind: 'terminated',
        helperGeneration: 1,
        result: 'terminated_clean',
      });
      expect(kill).toHaveBeenCalledTimes(1);
    },
  );

  it('PR7c-2 rejects discovery completion after kill begins until exit cleanup', async () => {
    const child = new ControlledHelperChild();
    vi.mocked(spawn).mockImplementationOnce(
      () => child as unknown as NodeChildProcess.ChildProcess,
    );
    let callbacks: WindowsTerminationCallbacks | undefined;
    const target = ledgerTarget(
      true,
      (addon) => ({
        ...addon,
        configureWindowsTermination: (configured) => {
          callbacks = configured;
          addon.configureWindowsTermination!(configured);
        },
      }),
      true,
    );
    const events: WindowsStopDeliveryEvent[] = [];
    target.host.subscribeWindowsStop!((event) => events.push(event));
    await startSession(target.host, 'keeper', 'turn-keeper');
    target.helper().holdOnly('list_windows_cancellable');
    const discovery = target.host.beginWindowDiscovery!(profile);
    const result = discovery.result.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    const registered = events.find(
      (event) => event.kind === 'registered' && event.owner.id === discovery.id,
    );
    if (registered?.kind !== 'registered' || callbacks === undefined)
      throw new Error('Missing discovery registration');
    const owner = registered.owner;
    target.addon.requestWindowsTermination!();
    expect(child.killCalls).toBe(1);
    const beforeComplete = [...events];
    expect(owner.kind).toBe('discovery');
    callbacks.completed!(owner.helperGeneration, 'discovery', owner.id, owner.lifetimeId);
    expect(events).toEqual(beforeComplete);
    await vi.advanceTimersByTimeAsync(2_000);
    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(0);
    await result;
    const owned = events.filter(
      (event) =>
        (event.kind === 'notification' ? event.notification.owner : event.owner).lifetimeId ===
        owner.lifetimeId,
    );
    expect(owned.map(({ kind }) => kind)).toEqual([
      'registered',
      'notification',
      'notification',
      'notification',
      'retired',
    ]);
    expect(
      owned.flatMap((event) => (event.kind === 'notification' ? [event.notification.phase] : [])),
    ).toEqual(['termination_pending', 'exit_confirmed', 'cleanup_completed']);
  });

  it('PR7c-2 delivers R8/R12 once per phase and only to the exiting generation', async () => {
    const child = new ControlledHelperChild();
    vi.mocked(spawn).mockImplementationOnce(
      () => child as unknown as NodeChildProcess.ChildProcess,
    );
    const target = ledgerTarget(true, undefined, true);
    const events: WindowsStopDeliveryEvent[] = [];
    const unsubscribe = target.host.subscribeWindowsStop!((event) => events.push(event));
    await startSession(target.host, 'A', 'turn-a');
    await startSession(target.host, 'B', 'turn-b');
    expect(
      events.flatMap((event) =>
        event.kind === 'registered' && event.owner.kind === 'session' ? [event.owner.id] : [],
      ),
    ).toEqual(['A', 'B']);
    target.helper().holdOnly('pick_application');
    const picking = Promise.resolve(
      target.addon.pickApplication!({ activationToken: 'synthetic', pickerKind: 'application' }),
    ).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(
      events.filter((event) => event.kind === 'registered' && event.owner.kind === 'picker'),
    ).toHaveLength(1);
    target.helper().holdOnly('close_session');
    const closing = Promise.resolve(target.addon.close!({ sessionId: 'A', cancelEpoch: 1 })).catch(
      () => undefined,
    );
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.emit('error', new Error('synthetic transport failure'));
    await vi.advanceTimersByTimeAsync(2_000);
    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(0);
    await closing;
    await picking;
    child.emit('exit', 0, null);
    const notifications = events.flatMap((event) =>
      event.kind === 'notification' ? [event.notification] : [],
    );
    for (const id of ['A', 'B']) {
      const owned = notifications.filter(({ owner }) => owner.id === id);
      expect(owned.map(({ phase }) => phase)).toEqual([
        'termination_pending',
        'exit_confirmed',
        'cleanup_completed',
      ]);
      expect(owned.every(({ owner }) => owner.helperGeneration === 1)).toBe(true);
      expect(owned.at(-1)).toMatchObject({
        reason: id === 'A' ? 'requested_reason' : 'native_unavailable',
        internalReason: id === 'A' ? 'requested_stop' : 'shared_helper_stop',
        late: true,
      });
    }
    await startSession(target.host, 'C', 'turn-c');
    child.emit('exit', 0, null);
    expect(events.filter((event) => event.kind === 'notification')).toHaveLength(9);
    unsubscribe();
  });

  it('PR7c-2 preserves the initiating session while its start waits for discovery', async () => {
    const target = ledgerTarget(true, undefined, true);
    const notifications: WindowsOwnerStopNotification[] = [];
    target.host.subscribeWindowsStop!((event) => {
      if (event.kind === 'notification') notifications.push(event.notification);
    });
    await startSession(target.host, 'keeper', 'turn-keeper');
    target.helper().holdOnly('list_windows_cancellable');
    const starting = startSession(target.host, 'pending', 'turn-pending').catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    target.helper().holdOnly('stop_window_discovery');
    const stopping = target.host.stopPendingStart!('pending').catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.emit('error', new Error('synthetic transport failure'));
    await vi.advanceTimersByTimeAsync(0);
    await starting;
    await stopping;
    expect(notifications.filter(({ owner }) => owner.id === 'pending')).toMatchObject([
      { phase: 'exit_confirmed', reason: 'requested_reason', internalReason: 'requested_stop' },
      { phase: 'cleanup_completed', reason: 'requested_reason', internalReason: 'requested_stop' },
    ]);
  });

  it('PR7c-2 clears E4 not_submitted before a later session Stop fails', async () => {
    let release = () => undefined as void;
    const prepared = new Promise<void>((resolve) => {
      release = resolve;
    });
    let hold = false;
    const target = ledgerTarget(
      true,
      (addon) => ({
        ...addon,
        configureWindowsTermination: (callbacks) =>
          addon.configureWindowsTermination!({
            ...callbacks,
            prepare: async () => {
              if (hold) await prepared;
              await callbacks.prepare();
            },
          }),
      }),
      true,
    );
    const decide = vi.spyOn(stopKernel, 'decideWindowsStop');
    try {
      await startSession(target.host, 'keeper', 'turn-keeper');
      hold = true;
      const discovery = target.host.beginWindowDiscovery!(profile);
      const result = discovery.result.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      await expect(discovery.stop()).resolves.toMatchObject({ kind: 'not_submitted' });
      hold = false;
      release();
      await result;
      target.helper().holdOnly('close_session');
      const closing = Promise.resolve(
        target.addon.close!({ sessionId: 'keeper', cancelEpoch: 1 }),
      ).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]!.emit('error', new Error('synthetic transport failure'));
      await vi.advanceTimersByTimeAsync(0);
      expect(decide.mock.results.map(({ value }) => value.notification)).toContainEqual({
        kind: 'generation_exit',
        cause: 'abortTransport',
        late: false,
        result: 'terminated_clean',
        initiatorReason: 'requested_reason',
      });
      await closing;
    } finally {
      release();
      decide.mockRestore();
    }
  });

  it('PR7c-2 clears a normal E4 receipt before a later session Stop fails', async () => {
    const decide = vi.spyOn(stopKernel, 'decideWindowsStop');
    try {
      const target = ledgerTarget(true, undefined, true);
      await startSession(target.host, 'keeper', 'turn-keeper');
      target.helper().holdOnly('list_windows_cancellable');
      const discovery = target.host.beginWindowDiscovery!(profile);
      await vi.advanceTimersByTimeAsync(0);
      await discovery.stop();
      target.helper().holdOnly('close_session');
      const closing = Promise.resolve(
        target.addon.close!({ sessionId: 'keeper', cancelEpoch: 1 }),
      ).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]!.emit('error', new Error('synthetic transport failure'));
      await vi.advanceTimersByTimeAsync(0);
      expect(decide.mock.results.map(({ value }) => value.notification)).toContainEqual({
        kind: 'generation_exit',
        cause: 'abortTransport',
        late: false,
        result: 'terminated_clean',
        initiatorReason: 'requested_reason',
      });
      await closing;
    } finally {
      decide.mockRestore();
    }
  });

  it.each(['A', 'B'] as const)(
    'PR7c-2 receipt for %s preserves the other stopping owner',
    async (closed) => {
      const decide = vi.spyOn(stopKernel, 'decideWindowsStop');
      try {
        const target = ledgerTarget(true, undefined, true);
        const a = await startSession(target.host, 'A', 'turn-a');
        const b = await startSession(target.host, 'B', 'turn-b');
        await target.addon.cancel!({ sessionId: 'A', cancelEpoch: 1 });
        await target.addon.cancel!({ sessionId: 'B', cancelEpoch: 1 });
        await target.host.close(closed === 'A' ? a : b);
        sockets[0]!.emit('error', new Error('synthetic transport failure'));
        await vi.advanceTimersByTimeAsync(0);
        expect(decide.mock.results.map(({ value }) => value.notification)).toContainEqual({
          kind: 'generation_exit',
          cause: 'abortTransport',
          late: false,
          result: 'terminated_clean',
          initiatorReason: 'requested_reason',
        });
      } finally {
        decide.mockRestore();
      }
    },
  );

  it('PR7c records sessionless E4 before a transport failure and preserves late exit', async () => {
    const decide = vi.spyOn(stopKernel, 'decideWindowsStop');
    const child = new ControlledHelperChild();
    vi.mocked(spawn).mockImplementationOnce(
      () => child as unknown as NodeChildProcess.ChildProcess,
    );
    try {
      const target = ledgerTarget(true, undefined, true);
      await startSession(target.host, 'keeper', 'turn-keeper');
      target.helper().holdOnly('list_windows_cancellable');
      const discovery = target.host.beginWindowDiscovery!(profile);
      await vi.advanceTimersByTimeAsync(0);
      target.helper().holdOnly('stop_window_discovery');
      const stopping = discovery.stop().catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]!.emit('error', new Error('synthetic transport failure'));
      await vi.advanceTimersByTimeAsync(2_000);
      child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(0);
      expect(decide.mock.results.map((result) => result.value.notification)).toContainEqual({
        kind: 'discovery_result',
        late: true,
        result: { stopped: true, result: 'terminated_clean' },
      });
      await stopping;
    } finally {
      decide.mockRestore();
    }
  });
  it.each(['semantic', 'discovery'] as const)(
    'normal_deadline_terminates_original_generation_without_stop (%s)',
    async (operation) => {
      const child = new ControlledHelperChild();
      vi.mocked(spawn).mockImplementationOnce(
        () => child as unknown as NodeChildProcess.ChildProcess,
      );
      const target = ledgerTarget(true, undefined, true);
      const notifications: WindowsOwnerStopNotification[] = [];
      target.host.subscribeWindowsStop!((event) => {
        if (event.kind === 'notification') notifications.push(event.notification);
      });
      const session = await startSession(target.host, 'normal-deadline', 'turn-1');
      target.helper().holdOnly(operation === 'semantic' ? 'dispatch' : 'list_windows_cancellable');
      const result =
        operation === 'semantic'
          ? target.dispatch(session, ledgerActions[4])
          : target.host.beginWindowDiscovery!(profile).result.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      const deadline = operation === 'semantic' ? 10_000 : 30_000;
      await vi.advanceTimersByTimeAsync(deadline - 1);
      expect(child.killCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(child.killCalls).toBe(1);
      child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(0);
      await result;
      expect(notifications.find((event) => event.phase === 'exit_confirmed')).toMatchObject({
        result: operation === 'semantic' ? 'terminated_target_suspect' : 'terminated_clean',
        reason: 'native_unavailable',
      });
      if (operation === 'discovery') {
        expect(
          notifications.filter(
            (event) => event.phase === 'exit_confirmed' && event.owner.kind === 'discovery',
          ),
        ).toMatchObject([{ reason: 'requested_reason', result: 'terminated_clean' }]);
      }
      expect(target.quarantines).toHaveLength(operation === 'semantic' ? 1 : 0);
    },
  );

  it.each(['probe_result', 'error'] as const)(
    'partial_response_does_not_disarm_worker_deadline (%s)',
    async (responseType) => {
      const child = new ControlledHelperChild();
      vi.mocked(spawn).mockImplementationOnce(
        () => child as unknown as NodeChildProcess.ChildProcess,
      );
      const target = ledgerTarget(true, undefined, true);
      await startSession(target.host, 'residual-deadline', 'turn-1');
      target.helper().residual.add('list_targets');
      if (responseType === 'error') target.helper().refuse('list_targets');
      const result = Promise.resolve(target.addon.listTargets!({})).catch(() => 'rejected');
      await vi.advanceTimersByTimeAsync(0);
      await result;
      await vi.advanceTimersByTimeAsync(9_999);
      expect(child.killCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(child.killCalls).toBe(1);
      child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(0);
    },
  );

  it.each(['valid', 'generation', 'session', 'request', 'binary', 'flags', 'early'] as const)(
    'residual_retirement_requires_original_generation_and_request (%s)',
    async (kind) => {
      const child = new ControlledHelperChild();
      vi.mocked(spawn).mockImplementationOnce(
        () => child as unknown as NodeChildProcess.ChildProcess,
      );
      const target = ledgerTarget(true, undefined, true);
      await startSession(target.host, 'residual-binding', 'turn-1');
      target.helper().residual.add('list_targets');
      target.helper().holdOnly('list_targets');
      const result = Promise.resolve(target.addon.listTargets!({}));
      await vi.advanceTimersByTimeAsync(2_000);
      if (kind === 'early') target.helper().retire('list_targets');
      target.helper().release('list_targets');
      await result;
      if (kind !== 'early')
        target
          .helper()
          .retire(
            'list_targets',
            kind === 'generation'
              ? { metadata: Buffer.from('{"helperGeneration":2}') }
              : kind === 'session'
                ? { sessionId: { hex: 'd'.repeat(32) } }
                : kind === 'request'
                  ? { requestId: { hex: 'e'.repeat(32) } }
                  : kind === 'binary'
                    ? { binary: Buffer.from([1]) }
                    : kind === 'flags'
                      ? { flags: 1 }
                      : {},
          );
      await vi.advanceTimersByTimeAsync(7_999);
      expect(child.killCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(child.killCalls).toBe(kind === 'valid' ? 0 : 1);
      child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(0);
    },
  );

  it('late_retirement_cannot_disarm_elapsed_worker_deadline', async () => {
    const child = new ControlledHelperChild();
    vi.mocked(spawn).mockImplementationOnce(
      () => child as unknown as NodeChildProcess.ChildProcess,
    );
    const target = ledgerTarget(true, undefined, true);
    await startSession(target.host, 'late-retirement', 'turn-1');
    target.helper().residual.add('list_targets');
    await target.addon.listTargets!({});
    vi.setSystemTime(Date.now() + 10_001);
    target.helper().retire('list_targets');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.killCalls).toBe(1);
    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(0);
  });

  it('queued_request_deadline_defers_to_head', async () => {
    const child = new ControlledHelperChild();
    vi.mocked(spawn).mockImplementationOnce(
      () => child as unknown as NodeChildProcess.ChildProcess,
    );
    const target = ledgerTarget(true, undefined, true);
    const session = await startSession(target.host, 'queued-deadline', 'turn-1');
    target.helper().hold('list_windows_cancellable');
    const discovery = target.host.beginWindowDiscovery!(profile);
    const discoveryResult = discovery.result.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1_000);
    const dispatch = Promise.resolve(
      target.addon.dispatch!({
        sessionId: session.sessionId,
        requestId: 'queued-request',
        cancelEpoch: 0,
        type: 'click',
      }),
    ).then(
      () => 'resolved',
      () => 'rejected',
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await dispatch).toBe('rejected');
    expect(child.killCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(18_999);
    expect(child.killCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.killCalls).toBe(1);
    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(2_000);
    await discoveryResult;
    expect(child.killCalls).toBe(1);
  });

  it.each(['complete', 'reject'] as const)(
    'deferred_request_rearms_after_head_completes (%s)',
    async (outcome) => {
      const child = new ControlledHelperChild();
      vi.mocked(spawn).mockImplementationOnce(
        () => child as unknown as NodeChildProcess.ChildProcess,
      );
      const target = ledgerTarget(true, undefined, true);
      const session = await startSession(target.host, 'deferred-deadline', 'turn-1');
      target.helper().hold('observe');
      target.helper().hold('list_targets');
      if (outcome === 'reject') target.helper().refuse('observe');
      const observe = observeThroughTransport(target.addon, session.sessionId);
      await vi.advanceTimersByTimeAsync(1_000);
      const queued = Promise.resolve(target.addon.listTargets!({})).catch(() => 'rejected');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await queued).toBe('rejected');
      expect(child.killCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(1_000);
      target.helper().release('observe');
      await vi.advanceTimersByTimeAsync(0);
      expect(await observe).toBe(outcome === 'complete' ? 'resolved' : 'rejected');
      await vi.advanceTimersByTimeAsync(9_999);
      expect(child.killCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(child.killCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(child.killCalls).toBe(1);
      child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(0);
    },
  );

  it('late_answer_to_a_deferred_request_does_not_terminate', async () => {
    const child = new ControlledHelperChild();
    vi.mocked(spawn).mockImplementationOnce(
      () => child as unknown as NodeChildProcess.ChildProcess,
    );
    const target = ledgerTarget(true, undefined, true);
    const session = await startSession(target.host, 'deferred-late', 'turn-1');
    target.helper().hold('observe');
    target.helper().hold('list_targets');
    const observe = observeThroughTransport(target.addon, session.sessionId);
    await vi.advanceTimersByTimeAsync(1_000);
    const queued = Promise.resolve(target.addon.listTargets!({})).catch(() => 'rejected');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await queued).toBe('rejected');
    target.helper().release('observe');
    await vi.advanceTimersByTimeAsync(0);
    expect(await observe).toBe('resolved');
    // The helper answers the deferred request late: it is alive, so nothing is terminated.
    target.helper().release('list_targets');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(child.killCalls).toBe(0);
  });

  it.each(['stalled', 'retired', 'wrong_session'] as const)(
    'flagged_late_answer_to_a_deferred_request_stays_bounded (%s)',
    async (kind) => {
      const child = new ControlledHelperChild();
      vi.mocked(spawn).mockImplementationOnce(
        () => child as unknown as NodeChildProcess.ChildProcess,
      );
      const target = ledgerTarget(true, undefined, true);
      const session = await startSession(target.host, 'deferred-residual', 'turn-1');
      const helper = target.helper();
      helper.hold('observe');
      helper.hold('list_targets');
      helper.residual.add('list_targets');
      const observe = observeThroughTransport(target.addon, session.sessionId);
      await vi.advanceTimersByTimeAsync(1_000);
      const queued = Promise.resolve(target.addon.listTargets!({})).catch(() => 'rejected');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await queued).toBe('rejected');
      helper.release('observe');
      await vi.advanceTimersByTimeAsync(0);
      expect(await observe).toBe('resolved');
      // The late answer still has worker cleanup running: it does not drop the deferred watch.
      helper.release('list_targets');
      await vi.advanceTimersByTimeAsync(5_000);
      if (kind === 'retired') helper.retire('list_targets');
      if (kind === 'wrong_session')
        helper.retire('list_targets', { sessionId: { hex: 'd'.repeat(32) } });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(child.killCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(child.killCalls).toBe(kind === 'retired' ? 0 : 1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(child.killCalls).toBe(kind === 'retired' ? 0 : 1);
      child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(0);
    },
  );

  it.each(['stalled', 'retired'] as const)(
    'duplicate_flagged_deferred_answer_preserves_deadline_and_single_retirement (%s)',
    async (kind) => {
      const child = new ControlledHelperChild();
      vi.mocked(spawn).mockImplementationOnce(
        () => child as unknown as NodeChildProcess.ChildProcess,
      );
      const target = ledgerTarget(true, undefined, true);
      const session = await startSession(target.host, 'deferred-duplicate', 'turn-1');
      const helper = target.helper();
      helper.hold('observe');
      helper.hold('list_targets');
      helper.residual.add('list_targets');
      const observe = observeThroughTransport(target.addon, session.sessionId);
      await vi.advanceTimersByTimeAsync(1_000);
      const queued = Promise.resolve(target.addon.listTargets!({})).catch(() => 'rejected');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await queued).toBe('rejected');
      helper.release('observe');
      await vi.advanceTimersByTimeAsync(0);
      expect(await observe).toBe('resolved');
      const socket = sockets.at(-1)!;
      const responses: Buffer[] = [];
      const capture = (data: Buffer) => {
        if (decodeComputerUseNativeFrame(data).flags === 1) responses.push(data);
      };
      socket.on('data', capture);
      helper.release('list_targets');
      socket.removeListener('data', capture);
      expect(responses).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5_000);
      socket.emit('data', responses[0]!);
      if (kind === 'retired') helper.retire('list_targets');
      await vi.advanceTimersByTimeAsync(4_999);
      expect(child.killCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(child.killCalls).toBe(kind === 'retired' ? 0 : 1);
      // One retirement must remove all ownership; a duplicate would arm another deadline.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(child.killCalls).toBe(kind === 'retired' ? 0 : 1);
      child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(0);
    },
  );

  it('deferred_watch_cleared_on_exit', async () => {
    const child = new ControlledHelperChild();
    vi.mocked(spawn).mockImplementationOnce(
      () => child as unknown as NodeChildProcess.ChildProcess,
    );
    const target = ledgerTarget(true, undefined, true);
    const session = await startSession(target.host, 'deferred-old', 'turn-1');
    const helper = target.helper();
    helper.hold('observe');
    helper.hold('list_targets');
    const observe = observeThroughTransport(target.addon, session.sessionId);
    await vi.advanceTimersByTimeAsync(1_000);
    const queued = Promise.resolve(target.addon.listTargets!({})).catch(() => 'rejected');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await queued).toBe('rejected');
    helper.release('observe');
    await vi.advanceTimersByTimeAsync(0);
    expect(await observe).toBe('resolved');
    const timersBefore = vi.getTimerCount();
    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBeLessThan(timersBefore);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.killCalls).toBe(0);
    await startSession(target.host, 'deferred-new', 'turn-2');
    helper.release('list_targets');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(children.at(-1)?.killed).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('deferred_watch_survives_an_unrelated_stop', async () => {
    const child = new ControlledHelperChild();
    vi.mocked(spawn).mockImplementationOnce(
      () => child as unknown as NodeChildProcess.ChildProcess,
    );
    const target = ledgerTarget(true, undefined, true);
    const session = await startSession(target.host, 'deferred-stop', 'turn-1');
    const helper = target.helper();
    helper.hold('observe');
    helper.hold('list_targets');
    const observe = observeThroughTransport(target.addon, session.sessionId);
    await vi.advanceTimersByTimeAsync(1_000);
    const queued = Promise.resolve(target.addon.listTargets!({})).catch(() => 'rejected');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await queued).toBe('rejected');
    helper.release('observe');
    await vi.advanceTimersByTimeAsync(0);
    expect(await observe).toBe('resolved');
    // A Stop of the session proves nothing about the deferred list read the helper is stuck on.
    helper.holdOnly('list_targets');
    await target.addon.cancel!({ sessionId: session.sessionId, cancelEpoch: 1 });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(child.killCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.killCalls).toBe(1);
    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(0);
  });

  it('normal_deadline_exit_missing_preserves_isolation', async () => {
    const child = new ControlledHelperChild();
    vi.mocked(spawn).mockImplementationOnce(
      () => child as unknown as NodeChildProcess.ChildProcess,
    );
    const target = ledgerTarget(true, undefined, true);
    const notifications: WindowsOwnerStopNotification[] = [];
    target.host.subscribeWindowsStop!((event) => {
      if (event.kind === 'notification') notifications.push(event.notification);
    });
    const session = await startSession(target.host, 'normal-deadline', 'turn-1');
    target.helper().holdOnly('dispatch');
    const result = target.dispatch(session, ledgerActions[4]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.killCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(notifications).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(notifications).toMatchObject([{ phase: 'termination_pending' }]);
    expect(target.rows.size).toBe(1);
    await expect(target.addon.listTargets!({})).rejects.toThrow('native_stop_unconfirmed');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect((await result).outcome).toBe('rejected');
  });

  it.each(['deadline-during-close', 'termination-before-close-cancels-deadline'] as const)(
    'normal_deadline_and_stop_share_one_termination_budget (%s)',
    async (order) => {
      const child = new ControlledHelperChild();
      vi.mocked(spawn).mockImplementationOnce(
        () => child as unknown as NodeChildProcess.ChildProcess,
      );
      const target = ledgerTarget(true, undefined, true);
      const notifications: WindowsOwnerStopNotification[] = [];
      target.host.subscribeWindowsStop!((event) => {
        if (event.kind === 'notification') notifications.push(event.notification);
      });
      const session = await startSession(target.host, 'normal-deadline', 'turn-1');
      target.helper().holdOnly('dispatch');
      target.helper().holdOnly('close_session');
      const dispatch = target.dispatch(session, ledgerActions[4]);
      await vi.advanceTimersByTimeAsync(9_000);
      const terminationFirst = order === 'termination-before-close-cancels-deadline';
      if (terminationFirst) target.addon.requestWindowsTermination!();
      const closeSettled = vi.fn();
      const close = target.host.close(session).then(
        (value) => {
          closeSettled('resolved', value);
          return value;
        },
        (error: unknown) => {
          closeSettled('rejected', error);
          throw error;
        },
      );
      await vi.advanceTimersByTimeAsync(terminationFirst ? 1_999 : 2_999);
      expect(child.killCalls).toBe(1);
      expect(notifications.some((event) => event.phase === 'termination_pending')).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(notifications.filter((event) => event.phase === 'termination_pending')).toHaveLength(
        1,
      );
      expect(child.killCalls).toBe(1);
      await dispatch;
      await expect(close).resolves.toEqual({ kind: 'termination_requested' });
      expect(closeSettled).toHaveBeenCalledExactlyOnceWith('resolved', {
        kind: 'termination_requested',
      });
      child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(0);
      child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(
        notifications.filter(
          (event) => event.phase === 'exit_confirmed' && event.owner.id === session.sessionId,
        ),
      ).toMatchObject([
        {
          reason: terminationFirst ? 'native_unavailable' : 'requested_reason',
          result: 'terminated_target_suspect',
        },
      ]);
      expect(closeSettled).toHaveBeenCalledTimes(1);
      expect(child.killCalls).toBe(1);
    },
  );

  it('late_result_rejected_and_late_exit_delivered_once', async () => {
    const child = new ControlledHelperChild();
    vi.mocked(spawn).mockImplementationOnce(
      () => child as unknown as NodeChildProcess.ChildProcess,
    );
    const target = ledgerTarget(true, undefined, true);
    const notifications: WindowsOwnerStopNotification[] = [];
    target.host.subscribeWindowsStop!((event) => {
      if (event.kind === 'notification') notifications.push(event.notification);
    });
    const session = await startSession(target.host, 'normal-deadline', 'turn-1');
    const helper = target.helper();
    helper.holdOnly('dispatch');
    const result = target.dispatch(session, ledgerActions[4]);
    await vi.advanceTimersByTimeAsync(12_000);
    expect((await result).outcome).toBe('rejected');
    helper.release('dispatch');
    await vi.advanceTimersByTimeAsync(0);
    expect(target.rows.size).toBe(1);
    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(0);
    child.emit('exit', 0, null);
    expect(notifications.map((event) => event.phase)).toEqual([
      'termination_pending',
      'exit_confirmed',
      'cleanup_completed',
    ]);
    expect(notifications.every((event) => event.reason === 'native_unavailable')).toBe(true);
    expect(notifications[1]).toMatchObject({ late: true, result: 'terminated_target_suspect' });
    expect(target.quarantines).toHaveLength(1);
  });

  it('stale_completion_cannot_release_new_generation', async () => {
    const child = new ControlledHelperChild();
    vi.mocked(spawn).mockImplementationOnce(
      () => child as unknown as NodeChildProcess.ChildProcess,
    );
    const target = ledgerTarget(true, undefined, true);
    await startSession(target.host, 'old-session', 'turn-old');
    const oldHelper = target.helper();
    oldHelper.holdOnly('list_windows_cancellable');
    const discovery = target.host.beginWindowDiscovery!(profile);
    const result = discovery.result.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(child.killCalls).toBe(1);
    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(0);
    await result;
    const next = await startSession(target.host, 'new-session', 'turn-new');
    target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
    await target.dispatch(next, ledgerActions[4], 'new-row');
    const rows = [...target.rows.values()];
    oldHelper.release('list_windows_cancellable');
    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(30_000);
    expect([...target.rows.values()]).toEqual(rows);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.helperGeneration).toBe(2);
    expect(children.at(-1)?.killed).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it.each([true, false, 'throw'] as const)(
    'PR7a kill result %s is not exit evidence and T is exactly two seconds',
    async (killResult) => {
      const decide = vi.spyOn(stopKernel, 'decideWindowsStop');
      const child = new ControlledHelperChild();
      child.killResult = killResult;
      vi.mocked(spawn).mockImplementationOnce(
        () => child as unknown as NodeChildProcess.ChildProcess,
      );
      try {
        const target = ledgerTarget(true, undefined, true);
        await startSession(target.host, 'session-1', 'turn-1');
        target.addon.requestWindowsTermination!();
        await vi.advanceTimersByTimeAsync(1_999);
        expect(
          decide.mock.calls.filter(([, event]) => event.kind === 'exit_wait_exceeded'),
        ).toHaveLength(0);
        expect(
          decide.mock.calls.filter(([, event]) => event.kind === 'exit_confirmed'),
        ).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(decide.mock.results.at(-1)?.value.state.result).toBe('termination_requested');
        await expect(target.addon.listTargets!({})).rejects.toThrow('native_stop_unconfirmed');
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(child.killCalls).toBe(1);
        child.emit('exit', 0, null);
        expect(
          decide.mock.calls.find(([, event]) => event.kind === 'exit_confirmed')?.[1],
        ).toMatchObject({ cause: 'stop' });
        expect(decide.mock.results.at(-1)?.value.state.result).toBe('terminated_clean');
        await expect(target.addon.listTargets!({})).resolves.toBeDefined();
        expect(spawn).toHaveBeenCalledTimes(2);
      } finally {
        decide.mockRestore();
      }
    },
  );
  it.each(['attestation', 'connection-retry-exhaustion', 'idle-close'] as const)(
    'PR7a classifies %s outside dispatch and kills each generation once',
    async (failure) => {
      const decide = vi.spyOn(stopKernel, 'decideWindowsStop');
      const child = new ControlledHelperChild();
      const originalConnect = transport.connectPipe;
      const originalAttestation = transport.attestation;
      vi.mocked(spawn).mockImplementationOnce(
        () => child as unknown as NodeChildProcess.ChildProcess,
      );
      const cleanup = vi.fn();
      try {
        const target = ledgerTarget(
          true,
          (addon) => ({
            ...addon,
            cleanupWindowsGeneration: (id) => {
              cleanup(id);
              addon.cleanupWindowsGeneration!(id);
            },
          }),
          true,
        );
        if (failure === 'attestation') transport.attestation = '{}';
        if (failure === 'connection-retry-exhaustion')
          transport.connectPipe = () => {
            throw new Error('synthetic pipe failure');
          };
        if (failure === 'idle-close') {
          const session = await startSession(target.host, 'session-1', 'turn-1');
          await target.host.close(session);
        } else {
          const rejected = expect(target.addon.listTargets!({})).rejects.toThrow();
          await vi.advanceTimersByTimeAsync(5_100);
          await rejected;
        }
        expect(child.killCalls).toBe(1);
        expect(cleanup).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2_000);
        await expect(target.addon.listTargets!({})).rejects.toThrow('native_stop_unconfirmed');
        expect(child.killCalls).toBe(1);
        const exitListener = child.listeners('exit')[0]!;
        child.emit('exit', 0, null);
        exitListener(0, null);
        await vi.advanceTimersByTimeAsync(0);
        expect(cleanup.mock.calls).toEqual([[1]]);
        expect(
          decide.mock.calls.filter(([, event]) => event.kind === 'exit_confirmed'),
        ).toHaveLength(1);
        expect(
          decide.mock.calls.filter(([, event]) => event.kind === 'exit_wait_exceeded'),
        ).toHaveLength(1);
        expect(
          decide.mock.results.filter((result) => result.value.notification.kind !== 'unchanged'),
        ).toHaveLength(2);
        expect(
          decide.mock.calls.find(([, event]) => event.kind === 'exit_confirmed')?.[1],
        ).toMatchObject({ cause: 'abortTransport' });
      } finally {
        transport.connectPipe = originalConnect;
        transport.attestation = originalAttestation;
        decide.mockRestore();
      }
    },
  );
  it('PR7a is absent from production construction', () => {
    expect(readFileSync(join(__dirname, 'index.ts'), 'utf8')).not.toContain(
      'windowsKillStopTermination',
    );
  });
  it('PR7a does not adopt a socket that connects after its child exited', async () => {
    const connect = transport.connectPipe;
    try {
      const target = ledgerTarget(true, undefined, true);
      transport.connectPipe = () => {
        const socket = connect!();
        children[0]!.emit('exit', 1, null);
        return socket;
      };
      const result = Promise.resolve(target.addon.listTargets!({})).then(
        () => 'resolved',
        () => 'rejected',
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await result).toBe('rejected');
      expect(sockets[0]!.writes).toHaveLength(0);
      expect(sockets[0]!.destroyed).toBe(true);
    } finally {
      transport.connectPipe = connect;
    }
  });
  it.each([
    'crash',
    'pipe-close',
    'pipe-error',
    'header',
    'length',
    'binding',
    'json',
    'error-response',
    'write-callback',
    'write-throw',
    'timeout',
  ] as const)('PR7a classifies %s through the same exit ledger', async (failure) => {
    const decide = vi.spyOn(stopKernel, 'decideWindowsStop');
    const child = new ControlledHelperChild();
    vi.mocked(spawn).mockImplementationOnce(
      () => child as unknown as NodeChildProcess.ChildProcess,
    );
    try {
      const cleanup = vi.fn();
      const target = ledgerTarget(
        true,
        (addon) => ({
          ...addon,
          cleanupWindowsGeneration: (id) => {
            cleanup(id);
            addon.cleanupWindowsGeneration!(id);
          },
        }),
        true,
      );
      const session = await startSession(target.host, 'session-1', 'turn-1');
      target.helper().holdOnly('dispatch');
      const socket = sockets[0]!;
      if (failure === 'write-callback') socket.holdWriteCallbacks = true;
      if (failure === 'write-throw') {
        const write = socket.write.bind(socket);
        vi.spyOn(socket, 'write').mockImplementation((bytes, callback) => {
          if (decodeComputerUseNativeFrame(bytes).messageType === 'dispatch')
            throw new Error('synthetic write failure');
          return write(bytes, callback);
        });
      }
      const dispatch = target.dispatch(session);
      await vi.advanceTimersByTimeAsync(0);
      if (failure === 'crash') child.emit('exit', 1, null);
      else if (failure === 'pipe-close') socket.destroy();
      else if (failure === 'pipe-error') socket.emit('error', new Error('synthetic pipe failure'));
      else if (failure === 'header')
        socket.emit('data', Buffer.alloc(COMPUTER_USE_NATIVE_FRAME_HEADER_BYTES, 255));
      else if (failure === 'write-callback')
        socket.writeCallbacks.at(-1)!(new Error('synthetic write failure'));
      else if (failure === 'timeout') await vi.advanceTimersByTimeAsync(10_000);
      else if (failure !== 'write-throw') {
        const sent = decodeComputerUseNativeFrame(dispatchWrites(socket)[0]!);
        const bytes = encodeComputerUseNativeFrame({
          ...sent,
          messageType:
            failure === 'binding'
              ? 'probe_result'
              : failure === 'error-response'
                ? 'error'
                : 'dispatch_result',
          metadata: Buffer.from(failure === 'json' ? '{' : '{}'),
        });
        if (failure === 'length') bytes.writeUInt32LE(0, 60);
        socket.emit('data', bytes);
      }
      expect((await dispatch).outcome).toBe('rejected');
      await vi.advanceTimersByTimeAsync(0);
      if (failure !== 'crash') {
        expect(child.killed).toBe(true);
        expect(target.rows.size).toBe(1);
        expect(cleanup).not.toHaveBeenCalled();
        child.emit('exit', 0, null);
      }
      child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(target.rows.size).toBe(0);
      expect(target.quarantines).toEqual([
        { identity: { pid: 42, creationTime: '133000000000000001' }, reason: 'exit_suspect' },
      ]);
      expect(cleanup.mock.calls).toEqual([[1]]);
      expect(child.killCalls).toBe(failure === 'crash' ? 0 : 1);
      expect(
        decide.mock.results.filter((result) => result.value.notification.kind !== 'unchanged'),
      ).toHaveLength(1);
      expect(
        decide.mock.calls.filter(([, event]) => event.kind === 'exit_wait_exceeded'),
      ).toHaveLength(0);
      expect(decide.mock.calls.filter(([, event]) => event.kind === 'exit_confirmed')).toHaveLength(
        1,
      );
      expect(
        decide.mock.calls.find(([, event]) => event.kind === 'exit_confirmed')?.[1],
      ).toMatchObject({ cause: failure === 'crash' ? 'crash' : 'abortTransport' });
    } finally {
      decide.mockRestore();
    }
  });
  it.each(['before', 'after'] as const)('PR7a exit %s T cleans once', async (order) => {
    const decide = vi.spyOn(stopKernel, 'decideWindowsStop');
    const child = new ControlledHelperChild();
    vi.mocked(spawn).mockImplementationOnce(
      () => child as unknown as NodeChildProcess.ChildProcess,
    );
    try {
      const cleanup = vi.fn();
      const target = ledgerTarget(
        true,
        (addon) => ({
          ...addon,
          cleanupWindowsGeneration: (id) => {
            cleanup(id);
            addon.cleanupWindowsGeneration!(id);
          },
        }),
        true,
      );
      await startSession(target.host, 'session-1', 'turn-1');
      if (order === 'before') setTimeout(() => child.emit('exit', 0, null), 2_000);
      target.addon.requestWindowsTermination!();
      if (order === 'after') setTimeout(() => child.emit('exit', 0, null), 2_000);
      await vi.advanceTimersByTimeAsync(2_000);
      child.emit('exit', 0, null);
      expect(decide.mock.calls.filter(([, event]) => event.kind === 'exit_confirmed')).toHaveLength(
        1,
      );
      expect(decide.mock.results.at(-1)?.value.state.result).toBe('terminated_clean');
      expect(cleanup.mock.calls).toEqual([[1]]);
      expect(child.killCalls).toBe(1);
      expect(
        decide.mock.calls.filter(([, event]) => event.kind === 'exit_wait_exceeded'),
      ).toHaveLength(order === 'before' ? 0 : 1);
      expect(
        decide.mock.results.filter((result) => result.value.notification.kind !== 'unchanged'),
      ).toHaveLength(order === 'before' ? 1 : 2);
    } finally {
      decide.mockRestore();
    }
  });
  it('PR7a R19c retains rows and blockers until storage recovers, and old cleanup cannot touch a new helper', async () => {
    const decide = vi.spyOn(stopKernel, 'decideWindowsStop');
    const cleanup = vi.fn();
    try {
      const target = ledgerTarget(
        true,
        (addon) => ({
          ...addon,
          cleanupWindowsGeneration: (id) => {
            cleanup(id);
            addon.cleanupWindowsGeneration!(id);
          },
        }),
        true,
      );
      const session = await startSession(target.host, 'session-1', 'turn-1');
      target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
      await target.dispatch(session);
      target.control.failTransfer = true;
      children[0]!.emit('exit', 1, null);
      await vi.advanceTimersByTimeAsync(0);
      const exit = decide.mock.results.find(
        (_, index) => decide.mock.calls[index]![1].kind === 'exit_confirmed',
      )!.value;
      expect(exit).toMatchObject({
        helper: 'may_start',
        cleanup: { kind: 'deferred', helperGeneration: 1, holdId: expect.any(String) },
      });
      expect(exit.state.result).toBe('terminated_target_suspect');
      expect(exit.state.nativeBlockers).toHaveLength(1);
      expect(target.rows.size).toBe(1);
      expect(cleanup).not.toHaveBeenCalled();
      await expect(startSession(target.host, 'session-1', 'turn-1')).rejects.toThrow(
        'native_unavailable',
      );
      target.control.pid = 43;
      target.control.response = null;
      await target.host.listWindows(profile);
      const next = await startSession(target.host, 'session-2', 'turn-2');
      await expect(target.addon.listTargets!({})).resolves.toEqual([]);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(target.rows.size).toBe(1);
      expect(cleanup).not.toHaveBeenCalled();
      expect((await target.dispatch(next)).outcome).toBe('resolved');
      // Replay old pipe callbacks before transfer/cleanup, while generation 2 is live.
      sockets[0]!.emit('close');
      sockets[0]!.emit('data', Buffer.alloc(COMPUTER_USE_NATIVE_FRAME_HEADER_BYTES, 255));
      expect(children[1]!.killed).toBe(false);
      expect(sockets[1]!.destroyed).toBe(false);
      expect(target.quarantines).toEqual([]);
      target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
      await target.dispatch(next, ledgerActions[0], 'new-generation-row');
      expect(target.rows.size).toBe(2);
      await expect(startSession(target.host, 'session-1', 'turn-1')).rejects.toThrow(
        'native_unavailable',
      );
      target.control.failTransfer = false;
      await expect(target.addon.listTargets!({})).resolves.toEqual([]);
      expect([...target.rows.values()]).toMatchObject([
        { helperGeneration: 2, sessionId: 'session-2', identity: { pid: 43 } },
      ]);
      expect(cleanup.mock.calls).toEqual([[1]]);
      expect(target.quarantines).toEqual([
        { identity: { pid: 42, creationTime: '133000000000000001' }, reason: 'exit_suspect' },
      ]);
      target.control.response = null;
      expect((await target.dispatch(next, ledgerActions[0], 'after-transfer')).outcome).toBe(
        'resolved',
      );
      target.addon.cleanupWindowsGeneration!(1);
      children[0]!.emit('exit', 1, null);
      sockets[0]!.emit('close');
      sockets[0]!.emit('data', Buffer.alloc(COMPUTER_USE_NATIVE_FRAME_HEADER_BYTES, 255));
      await expect(target.addon.listTargets!({})).resolves.toEqual([]);
      expect(children[1]!.killed).toBe(false);
      expect(sockets[1]!.destroyed).toBe(false);
      expect(cleanup.mock.calls).toEqual([[1]]);
    } finally {
      decide.mockRestore();
    }
  });
  it.each(['ledger-only', 'switch-only'] as const)(
    'PR10 %s preserves the legacy gate or refuses missing storage',
    async (mode) => {
      const configure = vi.fn();
      const adapt = (addon: ComputerUseNativeAddon) => ({
        ...addon,
        configureWindowsTermination: configure,
      });
      const target =
        mode === 'ledger-only'
          ? ledgerTarget(true, adapt)
          : createTarget(
              responders(),
              undefined,
              { windowsKillStopTermination: { enabled: true } },
              adapt,
            );
      if (mode === 'switch-only') {
        await expect(startSession(target.host, 'session-1', 'turn-1')).rejects.toThrow(
          'native_controller_unavailable',
        );
        expect(children).toHaveLength(0);
      } else {
        const session = await startSession(target.host, 'session-1', 'turn-1');
        await target.host.close(session);
        expect(children[0]!.killed).toBe(true);
      }
      expect(configure).not.toHaveBeenCalled();
    },
  );
  it.each(['response', 'dispatch_canceled'] as const)(
    'PR6 reevaluates idle when the final %s storage hold completes',
    async (eventKind) => {
      const target = ledgerTarget();
      let closeLedger!: WindowsCloseCallbacks;
      let teardown = false;
      const reevaluate = vi.fn(() => {
        if (!closeLedger.blocked(1)) teardown = true;
      });
      const abort = new AbortController();
      const host = createComputerUseNativeHost(
        binding({
          ...target.addon,
          configureCloseLedger: (callbacks) => {
            closeLedger = callbacks;
            target.addon.configureCloseLedger!(callbacks);
          },
          reevaluateIdle: reevaluate,
        }),
        'win32',
        {
          windowsPhysicalBoundsToDip: (value) => value,
          windowsLedger: {
            restoreQuarantines: () => true,
            write: () => {
              if (eventKind === 'dispatch_canceled') abort.abort();
              return true;
            },
            update: () => true,
            delete: () => deletion,
          },
        },
      );
      let finish!: (written: boolean) => void;
      const deletion = new Promise<boolean>((resolve) => {
        finish = resolve;
      });
      const active = await startSession(host, 'session-2', 'turn-2');
      const callbacksSpy = vi.spyOn(stopKernel, 'decideWindowsStop');
      const request = {
        session: active,
        requestId: 'idle-row',
        action: ledgerActions[0].action,
        observationRevision: 1,
        cancelEpoch: 0,
        signal: abort.signal,
      };
      const result = host.dispatch(request).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(closeLedger.blocked(1)).toBe(true);
      expect(teardown).toBe(false);
      finish(true);
      await result;
      expect(callbacksSpy.mock.calls.some(([, event]) => event.kind === eventKind)).toBe(true);
      expect(reevaluate).toHaveBeenCalled();
      expect(closeLedger.blocked(1)).toBe(false);
      expect(teardown).toBe(true);
      callbacksSpy.mockRestore();
    },
  );
  it('PR6 normalizes a rejected verification and retries the same lifetime through Host', async () => {
    const target = ledgerTarget();
    const verified = vi
      .fn()
      .mockRejectedValueOnce(new Error('synthetic verification failure'))
      .mockImplementation(async (_generation, _sessionId, persisted: () => void) => {
        persisted();
        return { status: 'confirmed' as const };
      });
    target.addon.configureCloseLedger!({
      received: () => undefined,
      blocked: () => true,
      verified,
    });
    const session = await startSession(target.host, 'session-1', 'turn-1');
    await expect(target.host.close(session)).rejects.toMatchObject({
      reasonCode: 'native_stop_unconfirmed',
    });
    await expect(target.host.close(session)).resolves.toBeUndefined();
    expect(verified).toHaveBeenCalledTimes(2);
  });
  it('PR6 bounds completed lifetimes to 128 without reinstalling evicted blockers', async () => {
    const target = ledgerTarget();
    await startSession(target.host, 'keeper', 'turn-keeper');
    const receipt = { sessionId: 'closed-0', cancelEpoch: 1, inputAttemptCount: 1 };
    let first: unknown;
    for (let index = 0; index <= 128; index += 1) {
      const sessionId = `closed-${index}`;
      await target.addon.startSession!({ sessionId, profile });
      const evidence = await target.addon.close!({ sessionId, cancelEpoch: 1 });
      await target.addon.confirmSessionClosed!({ ...receipt, sessionId }, evidence);
      if (index === 0) first = evidence;
      if (index === 127)
        await expect(target.addon.confirmSessionClosed!(receipt, first)).resolves.toEqual({
          status: 'confirmed',
        });
    }
    expect(() => target.addon.confirmSessionClosed!(receipt, first)).toThrow(
      'native_stop_unconfirmed',
    );
    const duplicate = await target.addon.close!({ sessionId: receipt.sessionId, cancelEpoch: 1 });
    expect(() => target.addon.confirmSessionClosed!(receipt, duplicate)).toThrow(
      'native_stop_unconfirmed',
    );
    const keeper = await target.addon.close!({ sessionId: 'keeper', cancelEpoch: 1 });
    await target.addon.confirmSessionClosed!({ ...receipt, sessionId: 'keeper' }, keeper);
    expect(children[0]!.killed).toBe(true);
  });
  it('PR6 receipt ownership does not swallow another session response with the same request id', async () => {
    const target = ledgerTarget(true);
    const sessionA = await startSession(target.host, 'session-a', 'turn-a');
    target.control.pid = 43;
    const sessionB = await startSession(target.host, 'session-b', 'turn-b');
    target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
    await target.dispatch(sessionA, ledgerActions[0], 'shared-request');
    target.control.failTransfer = true;
    await target.host.close(sessionA);
    target.control.response = null;
    expect(await target.dispatch(sessionB, ledgerActions[0], 'shared-request')).toMatchObject({
      outcome: 'resolved',
      value: { result: 'completed' },
    });
    expect([...target.rows.values()].map((row) => row.sessionId)).toEqual(['session-a']);
    target.control.failTransfer = false;
    await target.host.close(sessionB);
  });
  it.each(ledgerActions.filter((sample) => ['paste', 'click', 'semantic'].includes(sample.name)))(
    'PR6 R19b scopes $name persistence failure to its target',
    async (sample) => {
      const target = ledgerTarget(true);
      const sessionA = await startSession(target.host, 'session-a', 'turn-a');
      const sameTarget = await startSession(target.host, 'same-target', 'turn-same');
      target.control.pid = 43;
      const otherTarget = await startSession(target.host, 'other-target', 'turn-other');
      target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
      await target.dispatch(sessionA, sample);
      target.control.failTransfer = true;
      await target.host.close(sessionA);
      expect(children[0]!.killed).toBe(false);
      expect(target.rows.size).toBe(1);
      target.control.response = null;
      expect(await target.dispatch(sameTarget, sample)).toMatchObject({
        outcome: 'resolved',
        value: { result: 'rejected', reasonCode: 'native_unavailable' },
      });
      await expect(startSession(target.host, 'same-target', 'turn-same')).rejects.toMatchObject({
        reasonCode: 'native_unavailable',
      });
      await expect(startSession(target.host, 'other-target', 'turn-other')).resolves.toMatchObject({
        sessionId: 'other-target',
      });
      expect(await target.dispatch(otherTarget, sample)).toMatchObject({
        outcome: 'resolved',
        value: { result: 'completed' },
      });
      target.control.failTransfer = false;
      await target.host.close(otherTarget);
      target.control.pid = 42;
      await target.host.close(sameTarget);
      expect(target.rows.size).toBe(0);
      expect(children[0]!.killed).toBe(true);
    },
  );
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
  it.each(
    (['close', 'stopPendingStart'] as const).flatMap((entry) =>
      ledgerActions
        .filter((sample) => sample.name === 'click' || sample.name === 'paste')
        .map((sample) => ({ entry, sample })),
    ),
  )(
    'PR6 $entry $sample.name waits for persistence before releasing native blockers or idle teardown',
    async ({ entry, sample }) => {
      const target = ledgerTarget();
      target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
      const session = await startSession(target.host, 'session-1', 'turn-1');
      await target.dispatch(session, sample);
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
  it.each(['controller', 'start', 'discovery'] as const)(
    'PR6 storage failure retains rows while %s retries persistence',
    async (entry) => {
      const target = ledgerTarget();
      target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
      const session = await startSession(target.host, 'session-1', 'turn-1');
      await target.dispatch(session);
      target.control.failReflect = true;
      await expect(target.host.close(session)).resolves.toBeUndefined();
      expect(target.rows.size).toBe(1);
      expect(children[0]!.killed).toBe(false);
      expect(target.host.availability()).toMatchObject({ state: 'ready' });
      target.control.failReflect = false;
      if (entry === 'controller')
        await controllerFor(target.host).listTargets(
          {},
          {
            taskId: 'task-1',
            turnId: 'turn-1',
            workspaceId: null,
            policyEpoch: 0,
          },
        );
      else if (entry === 'start') await startSession(target.host, 'recovered', 'turn-recovered');
      else await target.host.listWindows(profile);
      expect(target.rows.size).toBe(0);
      expect(children[0]!.killed).toBe(true);
      expect(target.host.availability()).toMatchObject({ state: 'ready' });
    },
  );
  it.each(['start', 'discovery'] as const)(
    'PR6 %s retries receipt storage before the availability guard',
    async (entry) => {
      let unavailable = false;
      const target = ledgerTarget(true, (addon) => ({
        ...addon,
        hasUnconfirmedSemanticInputs: () => unavailable || addon.hasUnconfirmedSemanticInputs!(),
      }));
      const session = await startSession(target.host, 'session-1', 'turn-1');
      target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
      await target.dispatch(session);
      target.control.failTransfer = true;
      await target.host.close(session);
      expect(target.rows.size).toBe(1);
      target.control.failTransfer = false;
      // An independent native blocker must still refuse work, but cannot prevent storage recovery.
      unavailable = true;
      await expect(
        entry === 'start'
          ? startSession(target.host, 'recovered', 'turn-recovered')
          : target.host.listWindows(profile),
      ).rejects.toThrow();
      expect(target.rows.size).toBe(0);
      expect(target.control.transfers).toBe(2);
      expect(target.host.availability()).toMatchObject({ reasonCode: 'native_stop_unconfirmed' });
    },
  );
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
    for (const changed of [
      { ...receipt, sessionId: 'proof-other' },
      { ...receipt, cancelEpoch: 2 },
    ])
      expect(() => target.addon.confirmSessionClosed!(changed, evidence)).toThrow(
        'native_stop_unconfirmed',
      );
    await target.addon.startSession!({ sessionId: 'proof-other', profile });
    const otherReceipt = { ...receipt, sessionId: 'proof-other' };
    const otherEvidence = await target.addon.close!(otherReceipt);
    expect(() => target.addon.confirmSessionClosed!(receipt, otherEvidence)).toThrow(
      'native_stop_unconfirmed',
    );
    await target.addon.confirmSessionClosed!(otherReceipt, otherEvidence);
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
        expect(target.host.availability()).toMatchObject({ state: 'ready' });
        expect(target.addon.hasUnconfirmedSemanticInputs!()).toBe(false);
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
        if (path === 'background_semantic')
          expect(target.quarantines).toEqual([
            {
              identity: { pid: 42, creationTime: '133000000000000001' },
              reason: 'effect_unconfirmed',
            },
          ]);
        await target.host.listTargets!().catch(() => undefined);
        expect(target.control.transfers).toBe(2);
        expect(target.quarantines).toHaveLength(path === 'background_semantic' ? 1 : 0);
        expect(children[0]!.killed).toBe(true);
        expect(target.addon.hasUnconfirmedSemanticInputs!()).toBe(false);
      } finally {
        spy.mockRestore();
      }
    },
  );
  it('PR6 R22 transfers identity and reason once and removes the original row', async () => {
    const decide = stopKernel.decideWindowsStop;
    // PR5b/N9 create background rows later; inject one at the receipt boundary.
    const spy = vi.spyOn(stopKernel, 'decideWindowsStop').mockImplementation((state, event) => {
      if (event.kind === 'receipt' && event.status === 'received')
        state = {
          ...state,
          rows: state.rows.map((row) => ({
            ...row,
            kind: 'semantic',
            inputPath: 'background_semantic',
          })),
        };
      return decide(state, event);
    });
    try {
      const target = ledgerTarget(true);
      target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
      const session = await startSession(target.host, 'session-1', 'turn-1');
      await target.dispatch(session, ledgerActions[4]);
      await target.host.close(session);
      expect(target.rows.size).toBe(0);
      expect(target.quarantines).toEqual([
        {
          identity: { pid: 42, creationTime: '133000000000000001' },
          reason: 'effect_unconfirmed',
        },
      ]);
      await target.host.close(session);
      await target.host.listTargets!().catch(() => undefined);
      expect(target.control.transfers).toBe(1);
      expect(target.quarantines).toHaveLength(1);
      await expect(startSession(target.host, 'after-transfer', 'turn-2')).rejects.toThrow(
        'native_unavailable',
      );
    } finally {
      spy.mockRestore();
    }
  });
  it.each(['unknown-hold', 'invalid-window'] as const)(
    'PR10 discovery rejects unsafe candidates after enumeration (%s)',
    async (mode) => {
      let unreadable = false;
      const target = createTarget(
        responders(),
        undefined,
        {
          windowsLedger: {
            write: () => true,
            update: () => true,
            delete: () => true,
            restoreQuarantines: () => true,
            read: () => {
              if (unreadable) throw new Error('synthetic read failure');
              return { rows: [], quarantines: [] };
            },
          },
        },
        (addon) => ({
          ...addon,
          discoverWindows: async (input) => {
            const result = computerUseNativeDiscoveryResultSchema.parse(
              await addon.discoverWindows!(input),
            );
            if (result.result !== 'completed') return result;
            if (mode === 'invalid-window') return { ...result, windows: [null] };
            unreadable = true;
            await target.host.restoreWindowsLedger();
            return { ...result, windows: [...result.windows, ...result.windows] };
          },
        }),
      );
      const discovery = target.host.beginWindowDiscovery!(profile);
      if (mode === 'invalid-window')
        await expect(discovery.result).rejects.toMatchObject({
          reasonCode: 'native_window_invalid',
        });
      else await expect(discovery.result).resolves.toEqual([]);
    },
  );

  it('PR10 cached admission rechecks every candidate after a later identity observation', async () => {
    let unreadable = false;
    const check = vi.fn(async () => {
      unreadable = true;
      await target.host.restoreWindowsLedger();
      return [{ result: 'unverifiable' as const, reason: 'access_denied' as const }];
    });
    const target = createTarget(
      {
        ...responders(),
        list_windows: (metadata) => {
          const [type, value] = responders()['list_windows']!(metadata);
          const row = (value as Record<string, unknown>[])[0]!;
          return [type, [row, { ...row, windowId: '101' }, { ...row, pid: 43, windowId: '102' }]];
        },
      },
      undefined,
      {
        windowsLedger: {
          write: () => true,
          update: () => true,
          delete: () => true,
          restoreQuarantines: () => true,
          read: () => {
            if (unreadable) throw new Error('synthetic read failure');
            return {
              rows: [],
              quarantines: [
                { identity: { pid: 43, creationTime: '133000000000000001' }, reason: 'restored' },
              ],
            };
          },
        },
      },
      (addon) => ({ ...addon, checkTargetIdentity: check }),
    );
    await expect(target.host.beginWindowDiscovery!(profile).result).resolves.toEqual([]);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('PR8 filters mixed-process windows once per PID despite a cached isolated PID', async () => {
    let isolated = false;
    const read = vi.fn(() => ({
      rows: [],
      quarantines: isolated
        ? [{ identity: { pid: 42, creationTime: '133000000000000001' }, reason: 'exit_suspect' }]
        : [],
    }));
    const check = vi.fn((): HelperResponse => [
      'target_identity_result',
      { results: [{ result: 'alive' }] },
    ]);
    const target = createTarget(
      {
        ...responders(),
        check_target_identity: check,
        list_windows: (metadata) => {
          const [type, value] = responders()['list_windows']!(metadata);
          const row = (value as Record<string, unknown>[])[0]!;
          return [
            type,
            [
              { ...row, pid: 43 },
              { ...row, windowId: '101' },
              { ...row, windowId: '102' },
            ],
          ];
        },
      },
      undefined,
      {
        windowsLedger: {
          write: () => true,
          update: () => true,
          delete: () => true,
          restoreQuarantines: () => true,
          read,
        },
      },
    );
    await target.host.listWindows(profile);
    isolated = true;
    read.mockClear();
    expect(await target.host.listWindows(profile)).toMatchObject([{ windowId: '100' }]);
    expect(check).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    isolated = false;
    await target.host.listWindows(profile);
    isolated = true;
    await expect(startSession(target.host, 'other-process', 'turn-a')).resolves.toMatchObject({
      sessionId: 'other-process',
    });
  });
  it.each(['alive', 'access_denied', 'win32_error'] as const)(
    'PR8 refuses new starts and discovery for a quarantined process (%s)',
    async (status) => {
      const target = createTarget(
        {
          ...responders(),
          check_target_identity: () => [
            'target_identity_result',
            {
              results: [
                status === 'alive'
                  ? { result: 'alive' }
                  : { result: 'unverifiable', reason: status },
              ],
            },
          ],
        },
        undefined,
        {
          windowsLedger: {
            write: () => true,
            update: () => true,
            delete: () => true,
            restoreQuarantines: () => true,
            read: () => ({
              rows: [],
              quarantines: [
                {
                  identity: { pid: 42, creationTime: '133000000000000001' },
                  reason: 'exit_suspect',
                },
              ],
            }),
          },
        },
      );
      await expect(startSession(target.host, 'isolated-start', 'turn-a')).rejects.toThrow(
        'native_unavailable',
      );
      expect(target.helper().served).not.toContain('start_session');
      await expect(target.host.listWindows(profile)).resolves.toEqual([]);
    },
  );

  it.each([
    [42, 'signaled'],
    [42, 'start_time_mismatch'],
    [42, 'no_process'],
    [43, 'start_time_mismatch'],
  ] as const)(
    'PR8 releases a terminated identity before PID reuse (isolated PID: %s, %s)',
    async (pid, reason) => {
      const quarantines = [
        { identity: { pid, creationTime: '133000000000000001' }, reason: 'exit_suspect' },
      ];
      const target = createTarget(
        {
          ...responders(),
          check_target_identity: () => [
            'target_identity_result',
            { results: [{ result: 'terminated', reason }] },
          ],
        },
        undefined,
        {
          windowsLedger: {
            write: () => true,
            update: () => true,
            delete: () => true,
            restoreQuarantines: () => true,
            releaseQuarantine: () => {
              quarantines.splice(0);
              return true;
            },
            read: () => ({ rows: [], quarantines }),
          },
        },
      );
      await expect(startSession(target.host, 'reused-pid', 'turn-a')).resolves.toMatchObject({
        sessionId: 'reused-pid',
      });
      expect(target.helper().served.includes('check_target_identity')).toBe(pid === 42);
      expect(quarantines).toHaveLength(pid === 42 ? 0 : 1);
    },
  );
  it.each(['signaled', 'start_time_mismatch', 'no_process'])(
    'PR8 retains isolation when release persistence fails (%s)',
    async (reason) => {
      const releaseQuarantine = vi.fn(() => false);
      const target = createTarget(
        {
          ...responders(),
          check_target_identity: () => [
            'target_identity_result',
            { results: [{ result: 'terminated', reason }] },
          ],
        },
        undefined,
        {
          windowsLedger: {
            write: () => true,
            update: () => true,
            delete: () => true,
            restoreQuarantines: () => true,
            releaseQuarantine,
            read: () => ({
              rows: [],
              quarantines: [
                {
                  identity: { pid: 42, creationTime: '133000000000000001' },
                  reason: 'exit_suspect',
                },
              ],
            }),
          },
        },
      );
      await expect(startSession(target.host, 'failed-release', 'turn-a')).rejects.toThrow(
        'native_unavailable',
      );
      expect(releaseQuarantine).toHaveBeenCalled();
      expect(target.helper().served).not.toContain('start_session');
      expect(await target.host.listWindows(profile)).toEqual([]);
    },
  );
  it('N6 rechecks a consumed token at the transport send boundary', async () => {
    let current = true;
    const target = ledgerTarget(
      true,
      (addon) => ({
        ...addon,
        startSession: (input, assertSend, callbacks) => {
          current = false;
          return addon.startSession!(input, assertSend, callbacks);
        },
      }),
      true,
    );
    await expect(
      target.host.startSession({
        profile,
        windowId: '100',
        sessionId: 'n6-stale',
        taskId: 'task-1',
        turnId: 'turn-a',
        cancelEpoch: 0,
        assertTargetCurrent: () => {
          if (!current) throw new Error('target generation changed');
        },
      }),
    ).rejects.toThrow('target generation changed');
    expect(target.helper().served).not.toContain('start_session');
  });

  it.each([false, true])(
    'N6-3 binds native start to list generation and window (changed=%s)',
    async (changed) => {
      const base = responders();
      const start = vi.fn(base['start_session']!);
      const eligibility = {
        mode: 'v2-denylist' as const,
        rulesetVersion: DENY_RULESET.platforms.win32.rulesetVersion,
        classifierVersion: 1,
        lexiconVersion: 1,
        ticketRequired: true as const,
      };
      const target = createTarget(
        {
          ...base,
          start_session: start,
          handshake: () => [
            'handshake_result',
            {
              protocolVersion: 1,
              apiVersion: 3,
              platform: 'win32',
              napiVersion: 10,
              sourceCommit,
              eligibility,
              capabilities: { cancellableWindowDiscovery: true, artifactRead: true },
            },
          ],
          list_targets: () => [
            'probe_result',
            {
              generation: 17,
              rulesetVersion: DENY_RULESET.platforms.win32.rulesetVersion,
              targets: [],
              truncated: false,
            },
          ],
        },
        undefined,
        {
          effectiveEligibilityMode: () => 'v2-denylist',
          windowsLedger: {
            write: () => true,
            update: () => true,
            delete: () => true,
            restoreQuarantines: () => true,
          },
          windowsKillStopTermination: { enabled: true },
        },
        undefined,
        undefined,
        eligibility,
      );
      const list = await target.host.listTargets!();
      const pending = target.host.startSession({
        profile,
        windowId: '100',
        sessionId: 'n6-start',
        taskId: 'task-1',
        turnId: 'turn-a',
        cancelEpoch: 0,
        windowsGeneration: list.windowsGeneration!,
        expectedWindowIdentityDigest: (changed ? '0' : 'c').repeat(64),
      });
      if (changed) {
        await expect(pending).rejects.toThrow();
        expect(start).not.toHaveBeenCalled();
        return;
      }
      await pending;
      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({
          targetGeneration: 17,
          denyRulesetVersion: DENY_RULESET.platforms.win32.rulesetVersion,
          eligibilityBasis: 'v2-denylist',
        }),
      );
      expect(start.mock.calls[0]?.[0]).not.toHaveProperty('windowsGeneration');
    },
  );

  it('N6 binds a target-list response to its exact helper capability', async () => {
    const target = createTarget(
      {
        ...responders(),
        list_targets: () => [
          'probe_result',
          {
            generation: 17,
            rulesetVersion: DENY_RULESET.platforms.win32.rulesetVersion,
            targets: [],
            truncated: false,
          },
        ],
      },
      undefined,
      {
        windowsLedger: {
          write: () => true,
          update: () => true,
          delete: () => true,
          restoreQuarantines: () => true,
        },
        windowsKillStopTermination: { enabled: true },
      },
    );
    const response = await target.addon.listTargets!({});
    const token = target.addon.captureWindowsGeneration!();
    expect(token).not.toBeNull();
    expect(target.addon.windowsGenerationFor?.(response)).toBe(token);
    expect(target.addon.windowsGenerationFor?.({})).toBeNull();
    expect(target.helper().served).not.toContain('start_session');
  });

  it('PR8 Host rejects a ticket when the helper changes between preflight and dispatch', async () => {
    const oldToken = { helperGeneration: 1 };
    let current = oldToken;
    const nativeDispatch = vi.fn(async () => ({
      result: 'completed',
      inputAttemptCount: 1,
      cancelEpoch: 0,
    }));
    const isCurrent = vi.fn((token) => token === current);
    const target = ledgerTarget(
      true,
      (addon) => ({
        ...addon,
        captureWindowsGeneration: () => current,
        isWindowsGenerationCurrent: isCurrent,
        // Keep the transport/session guards out of this Host boundary test.
        dispatch: nativeDispatch,
        preflight: async (input) => {
          const receipt = await addon.preflight!(input);
          current = { helperGeneration: 2 };
          return receipt;
        },
      }),
      true,
    );
    const session = await startSession(target.host, 'old-generation', 'turn-a');
    await expect(
      target.host.dispatch({
        session,
        requestId: 'old-ticket',
        action: { type: 'click', x: 0.5, y: 0.5, button: 'left' },
        observationRevision: 1,
        cancelEpoch: 0,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ result: 'rejected', reasonCode: 'native_unavailable' });
    expect(current.helperGeneration).toBe(2);
    expect(isCurrent).toHaveBeenCalledWith(oldToken);
    expect(nativeDispatch).not.toHaveBeenCalled();
  });

  it('PR8 reobserves isolation after discovery and before start transmission', async () => {
    let checks = 0;
    const target = createTarget(
      {
        ...responders(),
        check_target_identity: () => [
          'target_identity_result',
          {
            results: [
              ++checks === 1
                ? { result: 'terminated', reason: 'start_time_mismatch' }
                : { result: 'alive' },
            ],
          },
        ],
      },
      undefined,
      {
        windowsLedger: {
          write: () => true,
          update: () => true,
          delete: () => true,
          restoreQuarantines: () => true,
          releaseQuarantine: () => true,
          read: () => ({
            rows: [],
            quarantines: [
              { identity: { pid: 42, creationTime: '133000000000000001' }, reason: 'exit_suspect' },
            ],
          }),
        },
      },
    );
    await expect(startSession(target.host, 'reobserve', 'turn-a')).rejects.toThrow(
      'native_unavailable',
    );
    expect(checks).toBeGreaterThanOrEqual(2);
    expect(target.helper().served).not.toContain('start_session');
  });

  it.each([false, true])(
    'PR8 checks a shared quarantine at the last start gate (resume: %s)',
    async (resume) => {
      let armed = !resume;
      const quarantines: WindowsTargetQuarantine[] = [];
      const target = createTarget(
        {
          ...responders(),
          start_session: (metadata) => {
            const [type, value] = responders()['start_session']!(metadata);
            return [
              type,
              {
                ...(value as Record<string, unknown>),
                pid: 42,
                processStartTime: '133000000000000001',
              },
            ];
          },
        },
        undefined,
        {
          windowsLedger: {
            write: () => true,
            update: () => true,
            delete: () => true,
            restoreQuarantines: () => true,
            read: () => ({ rows: [], quarantines }),
          },
        },
        (addon) => ({
          ...addon,
          configureWindowsAdmission: (check) =>
            addon.configureWindowsAdmission!(async (input) => {
              if (armed && input['sessionId'] !== undefined) {
                quarantines.push({
                  identity: { pid: 42, creationTime: '133000000000000001' },
                  reason: 'exit_suspect',
                });
              }
              return check(input);
            }),
        }),
      );
      if (resume) {
        // Establish the same session before arming the shared-store race.
        await startSession(target.host, 'existing', 'turn-a');
        armed = true;
      }
      await expect(
        startSession(target.host, resume ? 'existing' : 'raced-start', 'turn-a'),
      ).rejects.toThrow('native_unavailable');
      expect(
        target.helper().served.filter((operation) => operation === 'start_session'),
      ).toHaveLength(resume ? 1 : 0);
    },
  );
  it('PR8 discards discovery when canceled during candidate identity checking', async () => {
    const quarantines: WindowsTargetQuarantine[] = [];
    const target = createTarget(
      {
        ...responders(),
        check_target_identity: () => [
          'target_identity_result',
          { results: [{ result: 'terminated', reason: 'start_time_mismatch' }] },
        ],
      },
      undefined,
      {
        windowsLedger: {
          write: () => true,
          update: () => true,
          delete: () => true,
          restoreQuarantines: () => true,
          read: () => ({ rows: [], quarantines }),
        },
      },
    );
    await target.host.listWindows(profile);
    quarantines.push({
      identity: { pid: 42, creationTime: '133000000000000001' },
      reason: 'exit_suspect',
    });
    target.helper().holdOnly('check_target_identity');
    const discovery = target.host.beginWindowDiscovery!(profile);
    const result = expect(discovery.result).rejects.toThrow('native_discovery_canceled');
    await vi.advanceTimersByTimeAsync(0);
    const stopped = discovery.stop().catch(() => undefined);
    target.helper().release('check_target_identity');
    await stopped;
    await result;
    expect(
      target.helper().served.filter((operation) => operation === 'list_windows_cancellable'),
    ).toHaveLength(2);
  });
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
  it.each(['clone', 'lifetime', 'generation'] as const)(
    'PR6 Host rejects independently invalid %s evidence before storage',
    async (boundary) => {
      let evidence: unknown;
      const target = ledgerTarget(true, (addon) => ({ ...addon, close: () => evidence }));
      const session = await startSession(target.host, 'session-1', 'turn-1');
      await target.addon.startSession!({ sessionId: 'keeper', profile });
      target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
      await target.dispatch(session);
      evidence = await target.addon.close!({ sessionId: session.sessionId, cancelEpoch: 1 });
      if (boundary === 'clone') evidence = structuredClone(evidence);
      if (boundary === 'lifetime')
        await target.addon.startSession!({ sessionId: session.sessionId, profile });
      if (boundary === 'generation') {
        children[0]!.emit('exit', 0, null);
        // Reconnect through discovery, without starting a second lifetime of this session.
        await discoverRows(target.addon);
      }
      await expect(target.host.close(session)).rejects.toMatchObject({
        reasonCode: 'native_stop_unconfirmed',
      });
      expect(target.control.transfers).toBe(0);
      expect(target.rows.size).toBe(1);
      expect(target.host.availability()).toMatchObject({ reasonCode: 'native_stop_unconfirmed' });
    },
  );
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
  it.each([
    { sameProcess: false, late: 'success' },
    { sameProcess: false, late: 'false' },
    { sameProcess: false, late: 'exception' },
    { sameProcess: true, late: 'success' },
    { sameProcess: true, late: 'false' },
    { sameProcess: true, late: 'exception' },
    { sameProcess: false, reusedPid: true, late: 'success' },
    { sameProcess: false, reusedPid: true, late: 'false' },
    { sameProcess: false, reusedPid: true, late: 'exception' },
  ] as const)(
    'PR6 AC-4 scopes a timed-out write (same process: $sameProcess, late: $late)',
    async (sample) => {
      const { sameProcess, late } = sample;
      const reusedPid = 'reusedPid' in sample;
      const target = ledgerTarget();
      const sessionA = await startSession(target.host, 'session-a', 'turn-a');
      const pidB = sameProcess || reusedPid ? 42 : 43;
      target.control.pid = pidB;
      if (reusedPid) target.control.creationTime = '133000000000000002';
      const sessionB = await startSession(target.host, 'session-b', 'turn-b');
      target.control.response = ['error', { code: 'input_not_confirmed', accepted: true }];
      await target.dispatch(sessionA, ledgerActions[0], 'retained-a');
      const rowA = structuredClone([...target.rows.values()][0]!);
      expect(rowA).toMatchObject({ sessionId: 'session-a', state: 'effect_unconfirmed' });
      target.control.response = null;
      let release!: () => void;
      let reject!: (error: Error) => void;
      target.control.wait = new Promise<void>((resolve, rejectWrite) => {
        release = resolve;
        reject = rejectWrite;
      });
      let settled = false;
      const pending = target.dispatch(sessionB, ledgerActions[0], 'uncertain-b').then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const denied = {
        outcome: 'resolved',
        value: { result: 'rejected', reasonCode: 'native_unavailable' },
      };
      expect(await pending).toMatchObject(denied);
      const rowB = target.written.at(-1)!;
      expect(rowB.identity).toEqual({
        pid: pidB,
        creationTime: reusedPid ? '133000000000000002' : rowA.identity.creationTime,
      });
      // Only B's already-running storage call retains the deferred promise.
      target.control.wait = null;
      const wireCount = dispatchWrites(sockets.at(-1)!).length;
      expect(await target.dispatch(sessionB, ledgerActions[0], 'blocked-b')).toMatchObject(denied);
      await expect(startSession(target.host, 'session-b', 'turn-b')).rejects.toMatchObject({
        reasonCode: 'native_unavailable',
      });
      expect(dispatchWrites(sockets.at(-1)!)).toHaveLength(wireCount);
      target.control.pid = 42;
      target.control.creationTime = rowA.identity.creationTime;
      if (sameProcess) {
        expect(await target.dispatch(sessionA, ledgerActions[0], 'blocked-a')).toMatchObject(
          denied,
        );
        await expect(startSession(target.host, 'session-a', 'turn-a')).rejects.toMatchObject({
          reasonCode: 'native_unavailable',
        });
        expect(dispatchWrites(sockets.at(-1)!)).toHaveLength(wireCount);
      } else {
        expect(await target.dispatch(sessionA, ledgerActions[0], 'allowed-a')).toMatchObject({
          outcome: 'resolved',
          value: { result: 'completed' },
        });
        await expect(startSession(target.host, 'session-a', 'turn-a')).resolves.toMatchObject({
          sessionId: 'session-a',
        });
        expect(dispatchWrites(sockets.at(-1)!)).toHaveLength(wireCount + 1);
      }
      // A fresh profile has no cached PID: the public start reaches ledgerBlocked(undefined).
      const served = [...target.helper().served];
      await expect(
        target.host.startSession({
          profile: { ...profile, identityDigest: digest('d') },
          windowId: '100',
          sessionId: 'unknown-pid',
          taskId: 'task-1',
          turnId: 'turn-unknown',
          cancelEpoch: 0,
        }),
      ).rejects.toMatchObject({ reasonCode: 'native_unavailable' });
      expect(target.helper().served).toEqual(served);
      expect(target.rows.get(ledgerKey(rowA))).toEqual(rowA);
      expect(target.deleted.some((row) => ledgerKey(row) === ledgerKey(rowA))).toBe(false);

      target.control.failWrite = late === 'false';
      if (late === 'exception') reject(new Error('synthetic storage failure'));
      else release();
      await vi.advanceTimersByTimeAsync(0);
      target.control.failWrite = false;
      expect(target.rows.has(ledgerKey(rowB))).toBe(false);
      expect(target.deleted.filter((row) => ledgerKey(row) === ledgerKey(rowB))).toEqual(
        late === 'success' ? [rowB] : [],
      );
      // Successful starts and sends prove that the uncertain-write hold has been released.
      for (const [session, pid] of [
        [sessionA, 42],
        [sessionB, pidB],
      ] as const) {
        target.control.pid = pid;
        target.control.creationTime =
          session === sessionA ? rowA.identity.creationTime : rowB.identity.creationTime;
        await expect(
          startSession(
            target.host,
            session.sessionId,
            session.sessionId === 'session-a' ? 'turn-a' : 'turn-b',
          ),
        ).resolves.toMatchObject({
          sessionId: session.sessionId,
        });
        expect(await target.dispatch(session, ledgerActions[0], 'recovered')).toMatchObject({
          outcome: 'resolved',
          value: { result: 'completed' },
        });
      }
      expect([...target.rows.values()]).toEqual([rowA]);
    },
  );

  it.each(['false', 'exception'] as const)(
    'PR6 AC-4 a settled write %s refuses only that dispatch',
    async (failure) => {
      const target = ledgerTarget();
      const sessionA = await startSession(target.host, 'session-a', 'turn-a');
      target.control.pid = 43;
      const sessionB = await startSession(target.host, 'session-b', 'turn-b');
      target.control.failWrite = failure === 'false';
      // PR4 will revisit exceptions: today they are treated as confirmed non-writes (L4).
      if (failure === 'exception') {
        target.control.wait = Promise.reject(new Error('synthetic storage failure'));
      }
      expect(await target.dispatch(sessionB)).toMatchObject({
        outcome: 'resolved',
        value: { result: 'rejected', reasonCode: 'native_unavailable' },
      });
      expect(dispatchWrites(sockets.at(-1)!)).toHaveLength(0);
      expect(target.rows.size).toBe(0);
      expect(target.deleted).toEqual([]);
      target.control.failWrite = false;
      target.control.wait = null;
      for (const [session, pid] of [
        [sessionB, 43],
        [sessionA, 42],
      ] as const) {
        target.control.pid = pid;
        await expect(
          startSession(
            target.host,
            session.sessionId,
            session.sessionId === 'session-a' ? 'turn-a' : 'turn-b',
          ),
        ).resolves.toMatchObject({
          sessionId: session.sessionId,
        });
        expect(await target.dispatch(session, ledgerActions[0], 'next')).toMatchObject({
          outcome: 'resolved',
          value: { result: 'completed' },
        });
      }
      expect(dispatchWrites(sockets.at(-1)!)).toHaveLength(2);
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
        path === 'reflect'
          ? target.dispatch(session)
          : expect(target.host.listWindows(profile)).resolves.toEqual([]);
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
          if (decision.kind !== 'ledger_updated')
            throw new Error('Expected response ledger update');
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
          path === 'retry-timeout'
            ? expect(target.host.listWindows(profile)).resolves.toEqual([])
            : target.dispatch(session);
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
        await expect(target.host.listWindows(profile)).resolves.toEqual([]);
        expect(decide.mock.results.at(-1)?.value.state.holds).toMatchObject([
          { recovery: 'write_quarantine', quarantinesToRestore: [quarantine] },
        ]);
        failRestore = false;
        await expect(target.host.listWindows(profile)).resolves.toEqual([]);
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
    try {
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
    } finally {
      decide.mockRestore();
    }
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

  it.each(['same', 'other'] as const)(
    'R19a a hold left while a start waits in discovery refuses only the held target (%s)',
    async (kind) => {
      const target = ledgerTarget();
      const sessionA = await startSession(target.host, 'session-a', 'turn-1');
      // B's window discovery is withheld so A's failed reflection lands during it.
      target.helper().holdOnly('list_windows_cancellable');
      const starting = startSession(target.host, 'session-b', 'turn-2').then(
        (value) => ({ outcome: 'resolved' as const, value }),
        (error: unknown) => ({ outcome: 'rejected' as const, error }),
      );
      await vi.advanceTimersByTimeAsync(1);
      expect(target.helper().served.filter((op) => op === 'start_session')).toHaveLength(1);
      target.control.failReflect = true;
      await target.dispatch(sessionA);
      expect(target.rows.size).toBe(1);
      target.control.failReflect = false;
      if (kind === 'other') target.control.discoveryPid = 43;
      target.helper().release('list_windows_cancellable');
      const startFrames = () =>
        sockets
          .at(-1)!
          .writes.map((bytes) =>
            JSON.parse(decodeComputerUseNativeFrame(bytes).metadata.toString('utf8')),
          )
          .filter((metadata: Record<string, unknown>) => metadata['operation'] === 'start_session');
      if (kind === 'same') {
        const result = await starting;
        expect(result).toMatchObject({ outcome: 'rejected' });
        expect((result as { error: unknown }).error).toMatchObject({
          reasonCode: 'native_unavailable',
        });
        expect(target.helper().served.filter((op) => op === 'start_session')).toHaveLength(1);
        expect(startFrames()).toHaveLength(1);
      } else {
        expect(await starting).toMatchObject({
          outcome: 'resolved',
          value: { sessionId: 'session-b' },
        });
        expect(startFrames().map((metadata: Record<string, unknown>) => metadata['pid'])).toEqual([
          42, 43,
        ]);
      }
    },
  );

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

  it('P5c1 transport binds the permit to its live helper and rejects stale generations', async () => {
    const permit = vi.fn(() => true);
    const createHelperPermit = vi.fn(() => permit);
    const load = vi.spyOn(windowsMain, 'loadWindowsMainAddon').mockReturnValue({
      createHelperPermit,
      readMainIdentity: () => ({
        mainPid: process.pid,
        mainProcessStartTime: '123',
        imagePath: process.execPath,
      }),
    });
    try {
      const target = ledgerTarget(false, undefined, true, undefined, true, true, true);
      const session = await startSession(target.host, 'session-1', 'turn-1');
      expect(target.addon.readWindowsMainIdentity!()).toMatchObject({
        mainPid: process.pid,
        mainProcessStartTime: '123',
      });
      const generation = target.addon.captureWindowsGeneration!()!;
      expect(target.addon.allowWindowsHelperForeground!({ ...generation })).toBe(false);
      expect(target.host.allowWindowsForegroundHandoff!(session, () => {})).toBe(true);
      expect(createHelperPermit).toHaveBeenCalledExactlyOnceWith(4242);
      expect(permit).toHaveBeenCalledExactlyOnceWith(4242);
      target.addon.requestWindowsTermination!();
      expect(target.addon.allowWindowsHelperForeground!(generation)).toBe(false);
      expect(permit).toHaveBeenCalledTimes(1);
    } finally {
      load.mockRestore();
    }
  });

  it.each(['ready', 'missing', 'throws', 'wrong pid', 'gate closed'] as const)(
    'P5c1 round trip uses Main identity or fails closed: %s',
    async (path) => {
      const seen: Readonly<Record<string, unknown>>[] = [];
      const readIdentity = vi.fn(() => {
        if (path === 'throws') throw new Error('identity unavailable');
        return readWindowsMainIdentity({
          createHelperPermit: vi.fn(),
          readMainIdentity: () => ({
            mainPid: path === 'wrong pid' ? 0 : process.pid,
            mainProcessStartTime: '123',
            imagePath: process.execPath,
          }),
        });
      });
      const permit = vi.fn(() => true);
      const target = createTarget(
        {
          ...responders(),
          approval_round_trip_begin: (metadata) => {
            seen.push(metadata);
            const {
              durationMs: _d,
              mainPid: _p,
              mainProcessStartTime: _s,
              mainImageIdentity: _i,
              operation: _o,
              ...bound
            } = metadata;
            return [
              'approval_round_trip_begin_result',
              {
                ...bound,
                kind: 'begin_result',
                accepted: true,
                failureReason: 'none',
                failureLatched: false,
              },
            ];
          },
        },
        undefined,
        { windowsBackgroundInputForTesting: path !== 'gate closed' },
        ({ readWindowsMainIdentity: _readIdentity, ...addon }) => ({
          ...addon,
          captureWindowsGeneration: () => ({ helperGeneration: 1 }),
          ...(path === 'missing' ? {} : { readWindowsMainIdentity: readIdentity }),
          allowWindowsHelperForeground: permit,
        }),
      );
      const session = await startSession(target.host, 'session-1', 'turn-1');
      if (path === 'gate closed') {
        expect(target.host.beginApprovalRoundTrip).toBeUndefined();
        expect(target.host.allowWindowsForegroundHandoff).toBeUndefined();
        expect(readIdentity).not.toHaveBeenCalled();
      } else {
        const begin = target.host.beginApprovalRoundTrip!({
          session,
          taskId: 'task-1',
          turnId: 'turn-1',
          roundTripId: 'card-1',
          durationMs: 60_000,
        });
        if (path === 'ready') {
          await begin;
          expect(seen).toEqual([
            expect.objectContaining({
              mainPid: process.pid,
              mainProcessStartTime: '123',
              mainImageIdentity: createHash('sha256')
                .update(readFileSync(process.execPath))
                .digest('hex'),
            }),
          ]);
        } else {
          await expect(begin).rejects.toThrow();
          expect(seen).toHaveLength(0);
          expect(target.helper().served).not.toContain('dispatch');
        }
      }
      expect(permit).not.toHaveBeenCalled();
    },
  );

  it.each(['allowed', 'gate closed', 'native refused', 'consume refused', 'Stop'] as const)(
    'P5c1 handoff permit stays behind its gate and Stop: %s',
    async (path) => {
      const generation = { helperGeneration: 1 };
      let current = true;
      const permit = vi.fn(() => path !== 'native refused');
      const target = ledgerTarget(
        false,
        (addon) => ({
          ...addon,
          captureWindowsGeneration: () => generation,
          isWindowsGenerationCurrent: () => current,
          allowWindowsHelperForeground: permit,
        }),
        false,
        undefined,
        true,
        true,
        path !== 'gate closed',
      );
      const session = await startSession(target.host, 'session-1', 'turn-1');
      const consume = vi.fn(() => {
        if (path === 'consume refused') throw new Error('handoff already consumed');
        if (path === 'Stop') current = false;
      });
      expect(target.host.allowWindowsForegroundHandoff!(session, consume)).toBe(path === 'allowed');
      expect(permit).toHaveBeenCalledTimes(path === 'allowed' || path === 'native refused' ? 1 : 0);
      if (path === 'gate closed') expect(consume).not.toHaveBeenCalled();
      expect(target.helper().served).not.toContain('dispatch');
    },
  );

  it.each(['approved', 'missing id', 'end first'] as const)(
    'P5b host and transport round trip: %s',
    async (path) => {
      const seen: Array<Readonly<Record<string, unknown>>> = [];
      const base = ticketedTable(seen);
      const reply = (metadata: Readonly<Record<string, unknown>>): HelperResponse => {
        seen.push({ operation: metadata['kind'], ...metadata });
        const {
          durationMs: _duration,
          mainPid: _pid,
          mainProcessStartTime: _start,
          mainImageIdentity: _image,
          operation: _operation,
          reason: _reason,
          ...bound
        } = metadata;
        const begin = metadata['kind'] === 'begin';
        return [
          begin ? 'approval_round_trip_begin_result' : 'approval_round_trip_end_result',
          {
            ...bound,
            kind: begin ? 'begin_result' : 'end_result',
            accepted: true,
            failureReason: 'none',
            failureLatched: false,
          },
        ];
      };
      const target = createTarget(
        {
          ...base,
          approval_round_trip_begin: reply,
          approval_round_trip_end: reply,
          cancel: (metadata) => [
            'dispatch_result',
            {
              result: 'canceled',
              drained: true,
              sessionId: metadata['sessionId'],
              cancelEpoch: metadata['cancelEpoch'],
              inputAttemptCount: path === 'approved' ? 1 : 0,
            },
          ],
          close_session: (metadata) => [
            'probe_result',
            {
              result: 'closed',
              drained: true,
              sessionId: metadata['sessionId'],
              cancelEpoch: metadata['cancelEpoch'],
              inputAttemptCount: path === 'approved' ? 1 : 0,
            },
          ],
          start_session: (metadata) => {
            seen.push({ operation: 'start', ...metadata });
            return base['start_session']!(metadata);
          },
        },
        undefined,
        {
          windowsApprovalRoundTripForTesting: {
            mainPid: 42,
            mainProcessStartTime: '123',
            mainImageIdentity: digest('a'),
          },
        },
        (addon) => ({ ...addon, captureWindowsGeneration: () => ({ helperGeneration: 1 }) }),
      );
      const session = await startSession(target.host, 'session-1', 'turn-1');
      await target.host.beginApprovalRoundTrip!({
        session,
        taskId: 'task-1',
        turnId: 'turn-1',
        roundTripId: 'card-1',
        durationMs: 60_000,
      });
      if (path === 'end first')
        await target.host.endApprovalRoundTrip!(session.sessionId, 'stopped');
      const returned = target.host.startSession({
        profile,
        windowId: '100',
        sessionId: session.sessionId,
        taskId: 'task-1',
        turnId: 'turn-1',
        cancelEpoch: 0,
        ...(path === 'missing id' ? {} : { roundTripId: 'card-1' }),
      });
      if (path !== 'approved') {
        await expect(returned).rejects.toThrow();
        expect(seen.filter((row) => row['operation'] === 'dispatch')).toHaveLength(0);
      } else {
        const focused = await returned;
        await expect(dispatchThrough(target, focused)).resolves.toMatchObject({
          result: 'completed',
        });
        expect(seen.map((row) => row['operation'])).toEqual([
          'start_session',
          'approval_round_trip_begin',
          'start_session',
          'preflight',
          'approval_round_trip_end',
          'dispatch',
        ]);
        expect(seen[2]).toMatchObject({ roundTripId: 'card-1' });
        expect(seen[3]).toMatchObject({ roundTripId: 'card-1' });
        expect(seen[4]).toMatchObject({ roundTripId: 'card-1', reason: 'approved' });
      }
      await target.host.cancel(session, 1);
      await target.host.close(session);
    },
  );

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

  it('sends the connection generation and distinct approval frames', async () => {
    const eligibility = {
      mode: 'v2-denylist',
      classifierVersion: 2,
      rulesetVersion: DENY_RULESET.platforms.win32.rulesetVersion,
      lexiconVersion: 3,
      ticketRequired: true,
      interlockEnforced: true,
    } as const;
    const viewers = { version: 1, digest: 'a'.repeat(16) };
    const seen: Record<string, Record<string, unknown>> = {};
    const base = responders();
    const target = createTarget(
      {
        ...base,
        handshake: (input) => {
          seen['handshake'] = input;
          const [, value] = base['handshake']!(input);
          return [
            'handshake_result',
            {
              ...(value as object),
              eligibility,
              windowsDocumentViewers: viewers,
              capabilities: { cancellableWindowDiscovery: true, approval: true, approvalWire: 3 },
            },
          ];
        },
        approval_approve: (input) => {
          seen['approve'] = input;
          return ['approval_approve_result', { ok: true }];
        },
        approval_discard: (input) => {
          seen['discard'] = input;
          return ['approval_discard_result', { discarded: true }];
        },
        dispatch_approved: (input) => {
          seen['dispatch'] = input;
          // The native host answers an approved dispatch with its own result type (20).
          return ['dispatch_approved_result', { result: 'completed' }];
        },
      },
      undefined,
      {},
      undefined,
      undefined,
      eligibility,
      viewers,
    );
    await startSession(target.host, 'approval-session', 'turn-1');
    const request = {
      sessionId: 'approval-session',
      requestId: 'approval-request',
      approvalGeneration: 1,
      cancelEpoch: 0,
      type: 'click',
    };
    expect(typeof target.addon.approvalApprove).toBe('function');
    await target.addon.approvalApprove!(request);
    await target.addon.approvalDiscard!(request);
    await target.addon.dispatchApproved!(request);
    expect(seen['handshake']!['helperGeneration']).toBe(1);
    for (const key of ['approve', 'discard', 'dispatch'])
      expect(seen[key]!['helperGeneration']).toBe(1);
    expect(target.host.nativeApprovalPathEnabled?.('approval-session')).toBe(false);
    const frames = sockets[0]!.writes.map((bytes) => decodeComputerUseNativeFrame(bytes));
    for (const type of ['approval_approve', 'approval_discard', 'dispatch_approved'])
      expect(frames.some((frame) => frame.messageType === type)).toBe(true);
    expect(new Set(frames.slice(-3).map((frame) => frame.requestId.hex)).size).toBe(3);
  });
  it('N8-5 rejects a supervised start receipt on a closed or v1 approval route', async () => {
    const base = responders();
    const target = createTarget({
      ...base,
      start_session: (input) => {
        const [type, result] = base['start_session']!(input);
        return [type, { ...(result as object), maximumMode: 'supervised' }];
      },
    });
    await expect(
      target.host.startSession({
        profile,
        windowId: '100',
        sessionId: 'ceiling-start',
        taskId: 'task-1',
        turnId: 'turn-1',
        cancelEpoch: 0,
        classifierRoute: 'v1',
      }),
    ).rejects.toThrow('native_approval_ceiling_mismatch');
  });

  it.each([
    'full_access_app',
    'supervised',
    'background',
    'P5b two cards',
    'P5c2b-W failed preflight',
    'P5c2b-W completion revoked',
  ] as const)(
    'P4c connects the Windows host approval gate and distinguishes pre-input failure from unknown effect (%s)',
    async (mode) => {
      const background = mode === 'background';
      const race = mode === 'P5c2b-W failed preflight' || mode === 'P5c2b-W completion revoked';
      const twoCards = mode === 'P5b two cards' || race;
      const maximumMode = background || twoCards ? 'full_access_app' : mode;
      const tripCalls: Array<[unknown, unknown]> = [];
      const tripReply: Responder = (wire) => {
        tripCalls.push([wire['kind'], wire['roundTripId']]);
        const begin = wire['kind'] === 'begin';
        return [
          begin ? 'approval_round_trip_begin_result' : 'approval_round_trip_end_result',
          {
            version: 1,
            kind: begin ? 'begin_result' : 'end_result',
            sessionId: wire['sessionId'],
            taskId: wire['taskId'],
            turnId: wire['turnId'],
            helperGeneration: wire['helperGeneration'],
            cancelEpoch: wire['cancelEpoch'],
            roundTripId: wire['roundTripId'],
            accepted: true,
            failureReason: 'none',
            failureLatched: false,
          },
        ];
      };
      const written: WindowsLedgerRow[] = [];
      const removed: WindowsLedgerRow[] = [];
      const isolated: WindowsTargetQuarantine[] = [];
      const eligibility = {
        mode: 'v2-denylist',
        classifierVersion: 2,
        rulesetVersion: DENY_RULESET.platforms.win32.rulesetVersion,
        lexiconVersion: 3,
        ticketRequired: true,
        interlockEnforced: true,
      } as const;
      const viewers = { version: 1, digest: 'a'.repeat(16) };
      let failApprove = false;
      let failPreflight = false;
      let failDispatch = false;
      let attempts = 0;
      let gateOpen = true;
      const base = responders();
      const table: Record<string, Responder> = {
        ...base,
        approval_round_trip_begin: tripReply,
        approval_round_trip_end: tripReply,
        start_session: (input) => {
          const [type, result] = base['start_session']!(input);
          return [
            type,
            {
              ...(result as object),
              maximumMode,
              pid: 42,
              processStartTime: '133000000000000001',
              ...(background
                ? { inputSession: { kind: 'background', backgroundCapabilityVersion: 1 } }
                : {}),
            },
          ];
        },
        // The close receipt reports every input attempt the approved dispatch made.
        close_session: (metadata) => {
          const [type, result] = base['close_session']!(metadata);
          return [type, { ...(result as object), inputAttemptCount: attempts }];
        },
        handshake: (input) => [
          'handshake_result',
          {
            ...(base['handshake']!(input)[1] as object),
            eligibility,
            windowsDocumentViewers: viewers,
            capabilities: { cancellableWindowDiscovery: true, approval: true, approvalWire: 3 },
          },
        ],
        preflight: (i) =>
          failPreflight
            ? ['error', { code: 'NATIVE_APPROVAL_UNAVAILABLE', accepted: false }]
            : [
                'preflight_result',
                {
                  receiptVersion: 3,
                  classifierVersion: 2,
                  decision: 'single_use_approval',
                  reasonCode: null,
                  deniedResult: null,
                  ticket: null,
                  sessionId: i['sessionId'],
                  requestId: i['requestId'],
                  cancelEpoch: i['cancelEpoch'],
                  observationRevision: i['observationRevision'],
                  inputAttemptCount: attempts,
                  approvalGeneration: 1,
                  remainingMs: 60000,
                  effect: 'supervised_action',
                  display: {
                    effect: 'supervised_action',
                    operation: 'click',
                    targetLabel: null,
                    extension: null,
                    externalApplication: 'not_applicable',
                    unsignedWarning: 'none',
                  },
                },
              ],
        approval_approve: (i) =>
          failApprove
            ? ['error', { code: 'NATIVE_APPROVAL_UNAVAILABLE', accepted: false }]
            : [
                'approval_approve_result',
                {
                  ok: true,
                  reasonCode: null,
                  deniedResult: null,
                  sessionId: i['sessionId'],
                  requestId: i['requestId'],
                  cancelEpoch: i['cancelEpoch'],
                  observationRevision: i['observationRevision'],
                  approvalGeneration: i['approvalGeneration'],
                  inputAttemptCount: 0,
                },
              ],
        approval_discard: () => ['approval_discard_result', { discarded: true }],
        dispatch_approved: () => {
          if (failDispatch) return ['error', { code: 'INPUT_FAILED', accepted: true }];
          attempts = 1;
          return [
            'dispatch_approved_result',
            {
              result: 'completed',
              reasonCode: null,
              sessionId: 'approval-host',
              cancelEpoch: 0,
              inputAttemptCount: 1,
            },
          ];
        },
      };
      const target = createTarget(
        table,
        undefined,
        {
          windowsBackgroundInputForTesting: background,
          ...(twoCards
            ? {
                windowsApprovalRoundTripForTesting: {
                  mainPid: 42,
                  mainProcessStartTime: '123',
                  mainImageIdentity: digest('a'),
                },
              }
            : {}),
          ...(background
            ? {
                windowsLedger: {
                  write: (row: WindowsLedgerRow) => {
                    written.push(row);
                    return true;
                  },
                  update: () => true,
                  delete: (row: WindowsLedgerRow) => {
                    removed.push(row);
                    return true;
                  },
                  updateWithQuarantines: (
                    _row: WindowsLedgerRow,
                    added: readonly WindowsTargetQuarantine[],
                  ) => {
                    isolated.push(...added);
                    return true;
                  },
                  restoreQuarantines: () => true,
                  transferReceipt: () => true,
                },
              }
            : {}),
          ...computerUseNativeHostEligibilityOptions(
            true,
            createComputerUseEligibilityWiring({
              compiled: () => eligibility,
              agentDrivenV2: () => gateOpen,
              environment: () => ({}),
            }),
          ),
        },
        (addon) => ({
          ...addon,
          captureWindowsGeneration: () => ({ helperGeneration: 1 }),
          ...(mode === 'P5c2b-W completion revoked'
            ? {
                completeApprovalRoundTrip: () => {
                  throw new Error('Unbound round trip completion');
                },
              }
            : {}),
        }),
        undefined,
        eligibility,
        viewers,
      );
      const session = await target.host.startSession({
        profile,
        windowId: '100',
        sessionId: 'approval-host',
        taskId: 'task-1',
        turnId: 'turn-1',
        cancelEpoch: 0,
        classifierRoute: 'v2',
      });
      expect(target.host.nativeApprovalPathEnabled?.(session.sessionId)).toBe(true);
      expect(target.host.nativeApprovalPathEnabled?.('unbound')).toBe(false);
      const input = {
        session,
        requestId: 'approved-host-request',
        approvalGeneration: 1,
        observationRevision: 1,
        cancelEpoch: 0,
        action: background
          ? ({ type: 'set_text', targetId: 'node-1', text: 'x' } as const)
          : ({ type: 'click', x: 0.5, y: 0.5, button: 'left' } as const),
        signal: new AbortController().signal,
      };
      const beginAndReturn = async (roundTripId: string) => {
        await target.host.beginApprovalRoundTrip!({
          session,
          taskId: 'task-1',
          turnId: 'turn-1',
          roundTripId,
          durationMs: 60_000,
        });
        await target.host.startSession({
          profile,
          windowId: '100',
          sessionId: session.sessionId,
          taskId: 'task-1',
          turnId: 'turn-1',
          cancelEpoch: 0,
          classifierRoute: 'v2',
          roundTripId,
        });
      };
      if (twoCards) await beginAndReturn('V1-card');
      if (race) {
        target.helper().holdOnly('preflight');
        const pending = target.host.dispatch(input);
        const assertion = expect(pending).resolves.toMatchObject({
          result: 'rejected',
          reasonCode: 'native_interaction_revoked',
        });
        await vi.advanceTimersByTimeAsync(1);
        expect(
          JSON.parse(
            decodeComputerUseNativeFrame(sockets.at(-1)!.writes.at(-1)!).metadata.toString(),
          ).operation,
        ).toBe('preflight');
        if (mode === 'P5c2b-W failed preflight') {
          const socket = sockets.at(-1)!;
          const frame = decodeComputerUseNativeFrame(socket.writes.at(-1)!);
          socket.emit(
            'data',
            encodeComputerUseNativeFrame({
              ...frame,
              messageType: 'approval_round_trip_event',
              metadata: Buffer.from(
                JSON.stringify({
                  version: 1,
                  kind: 'event',
                  sessionId: session.sessionId,
                  taskId: 'task-1',
                  turnId: 'turn-1',
                  helperGeneration: 1,
                  cancelEpoch: 0,
                  roundTripId: 'V1-card',
                  sequence: 1,
                  state: 'failed',
                  foreground: 'other',
                  failureReason: 'third_window',
                  failureLatched: true,
                }),
              ),
            }),
          );
        }
        target.helper().release('preflight');
        await assertion;
        expect(target.helper().served).not.toContain('dispatch');
        expect(target.helper().served).not.toContain('dispatch_approved');
        await target.host.close(session);
        return;
      }
      expect(await target.host.dispatch(input)).toMatchObject({
        approvalOffer: { kind: 'approval_required', effect: 'supervised_action' },
      });
      if (twoCards) {
        expect(tripCalls).toEqual([['begin', 'V1-card']]);
        expect(target.helper().served).not.toContain('dispatch');
        await beginAndReturn('native-card');
        const socket = sockets.at(-1)!;
        const frame = decodeComputerUseNativeFrame(socket.writes.at(-1)!);
        for (const [roundTripId, sequence, state] of [
          ['V1-card', 1, 'ended'],
          ['native-card', 2, 'active'],
        ] as const) {
          socket.emit(
            'data',
            encodeComputerUseNativeFrame({
              ...frame,
              messageType: 'approval_round_trip_event',
              metadata: Buffer.from(
                JSON.stringify({
                  version: 1,
                  kind: 'event',
                  sessionId: session.sessionId,
                  taskId: 'task-1',
                  turnId: 'turn-1',
                  helperGeneration: 1,
                  cancelEpoch: 0,
                  roundTripId,
                  sequence,
                  state,
                  foreground: 'target',
                  failureReason: 'none',
                  failureLatched: false,
                }),
              ),
            }),
          );
        }
        expect(await target.host.approvalApprove!(input)).toEqual({ kind: 'approved' });
        expect(tripCalls).toEqual([
          ['begin', 'V1-card'],
          ['begin', 'native-card'],
          ['end', 'native-card'],
        ]);
        expect(await target.host.dispatchApproved!(input)).toMatchObject({ result: 'completed' });
        expect(
          await target.host.dispatch({ ...input, requestId: 'next-native-offer' }),
        ).toMatchObject({
          approvalOffer: { kind: 'approval_required' },
        });
        await target.host.close(session);
        return;
      }
      failPreflight = true;
      expect(await target.host.dispatch({ ...input, requestId: 'preflight-failed' })).toMatchObject(
        {
          result: 'rejected',
        },
      );
      expect(await target.host.approvalApprove!(input)).toEqual({ kind: 'approved' });
      failApprove = true;
      expect(await target.host.approvalApprove!({ ...input, requestId: 'refused' })).toMatchObject({
        kind: 'refused',
        result: 'rejected',
      });
      // The native success frame (dispatch_approved_result) binds and completes the dispatch.
      expect(await target.host.dispatchApproved!(input)).toMatchObject({ result: 'completed' });
      failDispatch = true;
      await expect(target.host.dispatchApproved!(input)).rejects.toThrow();
      if (background) {
        expect(written).toMatchObject([
          { inputPath: 'background_semantic' },
          { inputPath: 'background_semantic' },
        ]);
        expect(removed).toHaveLength(1);
        expect(isolated).toMatchObject([{ reason: 'effect_unconfirmed' }]);
      }
      await target.host.approvalDiscard!({ session, approvalGeneration: 1 });
      expect(target.helper().served).toContain('approval_discard');
      if (maximumMode === 'supervised') {
        gateOpen = false;
        expect(target.host.nativeApprovalPathEnabled?.(session.sessionId)).toBe(false);
        gateOpen = true;
        expect(target.host.nativeApprovalPathEnabled?.(session.sessionId)).toBe(false);
        const before = sockets[0]!.writes.length;
        expect(await target.host.dispatch(input)).toMatchObject({
          result: 'rejected',
          reasonCode: 'native_approval_closed',
        });
        expect(sockets[0]!.writes).toHaveLength(before);
      }
      await target.host.close(session);
      expect(target.host.nativeApprovalPathEnabled?.(session.sessionId)).toBe(false);
      expect(await target.host.dispatchApproved!(input)).toMatchObject({ result: 'rejected' });
    },
  );

  it.each([
    'matching',
    'interlock',
    'wire',
    'viewers',
    'v1',
    'veto',
    'generation',
    'stop',
  ] as const)(
    'uses production host options and live approval evidence without a test enable flag (%s)',
    async (scenario) => {
      const eligibility = {
        mode: 'v2-denylist',
        classifierVersion: 2,
        rulesetVersion: DENY_RULESET.platforms.win32.rulesetVersion,
        lexiconVersion: 3,
        ticketRequired: true,
        interlockEnforced: scenario !== 'interlock',
      } as const;
      const viewers = { version: 1, digest: 'a'.repeat(16) };
      const base = responders();
      const target = createTarget(
        {
          ...base,
          handshake: (input) => [
            'handshake_result',
            {
              ...(base['handshake']!(input)[1] as object),
              eligibility,
              ...(scenario === 'viewers' ? {} : { windowsDocumentViewers: viewers }),
              capabilities: {
                cancellableWindowDiscovery: true,
                ...(scenario === 'wire' ? {} : { approval: true, approvalWire: 3 }),
              },
            },
          ],
        },
        undefined,
        {
          ...computerUseNativeHostEligibilityOptions(
            true,
            createComputerUseEligibilityWiring({
              compiled: () => eligibility,
              agentDrivenV2: () => scenario !== 'v1',
              environment: () => ({}),
            }),
          ),
          ...(scenario === 'veto' ? { windowsApprovalInterlockForTesting: false } : {}),
        },
        undefined,
        undefined,
        eligibility,
        viewers,
      );
      const session = await target.host.startSession({
        profile,
        windowId: '100',
        sessionId: 'evidence-session',
        taskId: 'task-1',
        turnId: 'turn-1',
        cancelEpoch: 0,
        classifierRoute: scenario === 'v1' ? 'v1' : 'v2',
      });
      const initiallyOpen = ['matching', 'generation', 'stop'].includes(scenario);
      expect(target.host.nativeApprovalPathEnabled?.(session.sessionId)).toBe(initiallyOpen);
      if (scenario === 'generation') {
        sockets[0]!.destroy();
        expect(target.host.nativeApprovalPathEnabled?.(session.sessionId)).toBe(false);
        await vi.advanceTimersByTimeAsync(0);
        await discoverRows(target.addon);
        expect(children).toHaveLength(2);
        expect(target.addon.windowsApprovalAvailable?.()).toBe(true);
        expect(target.host.nativeApprovalPathEnabled?.(session.sessionId)).toBe(false);
      } else {
        await target.host.cancel(session, 1);
        expect(target.host.nativeApprovalPathEnabled?.(session.sessionId)).toBe(false);
        await target.host.close(session);
      }
      expect(target.helper().served).not.toContain('approval_approve');
      expect(target.helper().served).not.toContain('dispatch_approved');
    },
  );

  it('refuses an old helper approval before sending any approval frame', async () => {
    const target = createTarget();
    await startSession(target.host, 'old-helper', 'turn-1');
    expect(target.addon.windowsApprovalReady?.('old-helper')).toBe(false);
    const before = sockets[0]!.writes.length;
    for (const method of ['approvalApprove', 'approvalDiscard', 'dispatchApproved'] as const)
      await expect(
        target.addon[method]!({
          sessionId: 'old-helper',
          requestId: method,
          approvalGeneration: 1,
          cancelEpoch: 0,
          type: 'click',
        }),
      ).rejects.toMatchObject({ accepted: false });
    expect(sockets[0]!.writes).toHaveLength(before);
  });
});
