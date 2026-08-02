import { createRequire } from 'node:module';
import { join, resolve, sep } from 'node:path';
import {
  parseNativeMutationIntentSnapshot,
  type NativeMutationEffectObservation,
  type NativeMutationIntentSnapshot,
  type NativeMutationRevision,
} from './native-mutation-intent';

export type NativeSafeFsErrorCode =
  | 'ADDON_UNAVAILABLE'
  | 'INVALID_INPUT'
  | 'UNSUPPORTED_PLATFORM'
  | 'ROOT_IDENTITY_CHANGED'
  | 'UNSAFE_PATH'
  | 'UNSAFE_LOCK'
  | 'LOCK_BUSY'
  | 'STALE_FENCE'
  | 'STALE_SESSION'
  | 'NATIVE_FAILURE';

export class NativeSafeFsError extends Error {
  constructor(
    readonly code: NativeSafeFsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'NativeSafeFsError';
  }
}

export type NativeSafeFsProbe = Readonly<{
  available: boolean;
  apiVersion: 1;
  platform: NodeJS.Platform;
  capabilities: Readonly<{
    rootSession: boolean;
    workspaceLock: boolean;
    durableFence: boolean;
    synchronousInvalidation: boolean;
    mutation: false;
  }>;
  unavailableReason: string | null;
}>;

export type NativeSafeFsSession = Readonly<{
  id: string;
  rootId: string;
  workspaceKey: string;
  fence: string;
  rootDev: string;
  rootIno: string;
}>;

export type NativeSafeFsOpenInput = Readonly<{
  rootId: string;
  workspacePath: string;
  rootDev: string;
  rootIno: string;
  workspaceKey: string;
  lockDirectoryPath: string;
  fence: string;
}>;

export interface NativeSafeFs {
  probe(): Promise<NativeSafeFsProbe>;
  openSession(input: NativeSafeFsOpenInput): Promise<NativeSafeFsSession>;
  assertSession(
    binding: Readonly<{ id: string; rootId?: string; workspaceKey: string; fence: string }>,
  ): void;
  invalidateWorkspace(workspaceKey: string, minimumFence: string): void;
  observeIntent(
    session: NativeSafeFsSession,
    intent: NativeMutationIntentSnapshot,
  ): Promise<NativeMutationEffectObservation>;
  stageIntentArtifact(
    session: NativeSafeFsSession,
    intent: NativeMutationIntentSnapshot,
    bytes: Buffer,
  ): Promise<NativeMutationRevision>;
  applyIntentEffect(
    session: NativeSafeFsSession,
    intent: NativeMutationIntentSnapshot,
  ): Promise<NativeMutationEffectObservation>;
  cleanupIntentAuxiliary(
    session: NativeSafeFsSession,
    intent: NativeMutationIntentSnapshot,
  ): Promise<Readonly<{ state: 'absent' }>>;
  closeSession(session: NativeSafeFsSession): Promise<void>;
}

type RawJournalBinding = Readonly<{
  sessionId: string;
  intentId: string;
  intentDigest: string;
  recordDigest: string;
  revision: number;
}>;

type RawObserveInput = RawJournalBinding &
  Readonly<{
    sourceSegments: readonly string[];
    destinationSegments: readonly string[] | null;
    auxiliarySegments: readonly string[] | null;
  }>;

type RawStageInput = RawJournalBinding &
  Readonly<{
    parentSegments: readonly string[];
    leafName: string;
    expectedContentHash: string;
    expectedSize: number;
    expectedMode: number;
  }>;

type RawEffectInput = RawJournalBinding &
  Readonly<{
    kind: NativeMutationIntentSnapshot['kind'];
    sourceSegments: readonly string[];
    destinationSegments: readonly string[] | null;
    auxiliarySegments: readonly string[] | null;
    expectedSource: NativeMutationIntentSnapshot['expectedSource'];
    expectedDestination: NativeMutationIntentSnapshot['expectedDestination'];
    expectedAuxiliary: NativeMutationIntentSnapshot['expectedSource'];
  }>;

type RawCleanupInput = RawJournalBinding &
  Readonly<{
    auxiliarySegments: readonly string[];
    expectedAuxiliary: NativeMutationIntentSnapshot['expectedSource'];
  }>;

type RawAddon = Readonly<{
  probe(): unknown;
  openSession(input: NativeSafeFsOpenInput): Promise<unknown>;
  invalidateWorkspace(workspaceKey: string, minimumFence: string): unknown;
  observeIntent(input: RawObserveInput): Promise<unknown>;
  stageIntentArtifact(input: RawStageInput, bytes: Buffer): Promise<unknown>;
  applyIntentEffect(input: RawEffectInput): Promise<unknown>;
  cleanupIntentAuxiliary(input: RawCleanupInput): Promise<unknown>;
  closeSession(id: string): Promise<unknown>;
}>;

export type NativeSafeFsAddonLocation = Readonly<{
  addonPath: string;
  loadedFromUnpacked: boolean;
}>;

const ASAR_DIR_SEGMENT = `${sep}app.asar${sep}`;
const ASAR_UNPACKED_DIR_SEGMENT = `${sep}app.asar.unpacked${sep}`;

// Slice 4.7e: when the main process runs from a packaged build, `__dirname` resolves
// inside the read-only `app.asar` archive. The compiled native addon cannot be dlopen'd
// from inside an asar archive, so Electron Forge unpacks it alongside the archive under
// `app.asar.unpacked` (see forge.config.ts `packagerConfig.asar.unpack`). This function
// redirects the dev-relative path into that sibling directory whenever the caller's
// `dirname` shows the process is actually running from inside `app.asar`. It is pure
// string manipulation — no filesystem access, no Electron import — so it stays testable
// without a packaged build and never becomes a second source of truth for packaging.
export function resolveNativeSafeFsAddonLocation(dirname: string): NativeSafeFsAddonLocation {
  const devRelativePath = join(
    dirname,
    '../../native-safe-fs/build/Release/sprint_coder_native_safe_fs.node',
  );
  const loadedFromUnpacked = devRelativePath.includes(ASAR_DIR_SEGMENT);
  const addonPath = loadedFromUnpacked
    ? devRelativePath.split(ASAR_DIR_SEGMENT).join(ASAR_UNPACKED_DIR_SEGMENT)
    : devRelativePath;
  return Object.freeze({ addonPath, loadedFromUnpacked });
}

export function nativeSafeFsAddonLocation(): NativeSafeFsAddonLocation {
  return resolveNativeSafeFsAddonLocation(__dirname);
}

export function nativeSafeFsAddonPath(): string {
  return nativeSafeFsAddonLocation().addonPath;
}

export function loadNativeSafeFs(
  options: { addonPath?: string; lockDirectoryPath?: string } = {},
): NativeSafeFs {
  const addonPath = resolve(options.addonPath ?? nativeSafeFsAddonPath());
  const lockDirectoryPath =
    options.lockDirectoryPath === undefined ? null : resolve(options.lockDirectoryPath);
  const issuedSessions = new Map<string, NativeSafeFsSession>();
  let addon: RawAddon | null = null;
  let capabilityProbe: NativeSafeFsProbe | null = null;
  let unavailableReason: string | null = null;
  try {
    const require = createRequire(join(__dirname, 'native-safe-fs-loader.cjs'));
    addon = validateRawAddon(require(addonPath));
    capabilityProbe = parseProbe(addon.probe());
  } catch (error) {
    addon = null;
    unavailableReason = safeLoadError(error);
  }

  return Object.freeze({
    async probe(): Promise<NativeSafeFsProbe> {
      return capabilityProbe ?? unavailableProbe(unavailableReason);
    },

    async openSession(input: NativeSafeFsOpenInput): Promise<NativeSafeFsSession> {
      if (addon === null)
        throw new NativeSafeFsError('ADDON_UNAVAILABLE', 'NativeSafeFs addon is unavailable');
      validateOpenInput(input);
      if (
        lockDirectoryPath === null ||
        resolve(input.lockDirectoryPath) !== lockDirectoryPath ||
        input.lockDirectoryPath !== lockDirectoryPath
      )
        throw new NativeSafeFsError(
          'INVALID_INPUT',
          'NativeSafeFs lock directory is not bound to this boundary',
        );
      try {
        const session = parseSession(await addon.openSession(Object.freeze({ ...input })));
        if (
          session.workspaceKey !== input.workspaceKey ||
          session.rootId !== input.rootId ||
          session.fence !== input.fence ||
          session.rootDev !== input.rootDev ||
          session.rootIno !== input.rootIno
        )
          throw new NativeSafeFsError(
            'NATIVE_FAILURE',
            'NativeSafeFs returned a mismatched session',
          );
        issuedSessions.set(session.id, session);
        return session;
      } catch (error) {
        throw mapNativeError(error);
      }
    },

    assertSession(
      binding: Readonly<{ id: string; rootId?: string; workspaceKey: string; fence: string }>,
    ): void {
      const session = issuedSessions.get(binding.id);
      if (
        session === undefined ||
        session.workspaceKey !== binding.workspaceKey ||
        (binding.rootId !== undefined && session.rootId !== binding.rootId) ||
        session.fence !== binding.fence
      )
        throw new NativeSafeFsError('STALE_SESSION', 'NativeSafeFs session is stale');
    },

    invalidateWorkspace(workspaceKey: string, minimumFence: string): void {
      if (addon === null)
        throw new NativeSafeFsError('ADDON_UNAVAILABLE', 'NativeSafeFs addon is unavailable');
      if (!/^[a-f0-9]{64}$/.test(workspaceKey) || !isPositiveDecimal(minimumFence))
        throw new NativeSafeFsError('INVALID_INPUT', 'Invalid NativeSafeFs fence invalidation');
      try {
        addon.invalidateWorkspace(workspaceKey, minimumFence);
        for (const [id, session] of issuedSessions)
          if (session.workspaceKey === workspaceKey) issuedSessions.delete(id);
      } catch (error) {
        throw mapNativeError(error);
      }
    },

    async observeIntent(
      session: NativeSafeFsSession,
      intent: NativeMutationIntentSnapshot,
    ): Promise<NativeMutationEffectObservation> {
      assertIssuedSession(issuedSessions, session);
      const parsed = parseNativeMutationIntentSnapshot(intent);
      assertIntentSession(parsed, session);
      const auxiliary = parsed.temp ?? parsed.tombstone;
      try {
        const observation = await addon!.observeIntent(
          Object.freeze({
            ...journalBinding(session, parsed),
            sourceSegments: parsed.sourceSegments,
            destinationSegments: parsed.destinationSegments,
            auxiliarySegments:
              auxiliary === null
                ? null
                : Object.freeze([...auxiliary.parentSegments, auxiliary.leafName]),
          }),
        );
        assertIssuedSession(issuedSessions, session);
        return parseEffectObservation(observation);
      } catch (error) {
        throw mapNativeError(error);
      }
    },

    async stageIntentArtifact(
      session: NativeSafeFsSession,
      intent: NativeMutationIntentSnapshot,
      bytes: Buffer,
    ): Promise<NativeMutationRevision> {
      assertIssuedSession(issuedSessions, session);
      const parsed = parseNativeMutationIntentSnapshot(intent);
      assertIntentSession(parsed, session);
      if (parsed.state !== 'aux_pending' || parsed.temp === null || parsed.artifact === null)
        throw new NativeSafeFsError(
          'INVALID_INPUT',
          'NativeSafeFs staging requires a journaled pending artifact',
        );
      if (!Buffer.isBuffer(bytes))
        throw new NativeSafeFsError('INVALID_INPUT', 'NativeSafeFs staging bytes are invalid');
      try {
        const observation = await addon!.stageIntentArtifact(
          Object.freeze({
            ...journalBinding(session, parsed),
            parentSegments: parsed.temp.parentSegments,
            leafName: parsed.temp.leafName,
            expectedContentHash: parsed.temp.expectedContentHash,
            expectedSize: parsed.temp.expectedSize,
            expectedMode: parsed.temp.expectedMode,
          }),
          Buffer.from(bytes),
        );
        assertIssuedSession(issuedSessions, session);
        return parseRevision(observation);
      } catch (error) {
        throw mapNativeError(error);
      }
    },

    async applyIntentEffect(
      session: NativeSafeFsSession,
      intent: NativeMutationIntentSnapshot,
    ): Promise<NativeMutationEffectObservation> {
      assertIssuedSession(issuedSessions, session);
      const parsed = parseNativeMutationIntentSnapshot(intent);
      assertIntentSession(parsed, session);
      if (parsed.state !== 'effect_pending')
        throw new NativeSafeFsError(
          'INVALID_INPUT',
          'NativeSafeFs effect requires a durable pending intent',
        );
      const auxiliary = parsed.temp ?? parsed.tombstone;
      const expectedAuxiliary =
        parsed.temp !== null
          ? (parsed.auxObservation ?? failInvalidNativeIntent())
          : ({ state: 'absent' } as const);
      try {
        const observation = await addon!.applyIntentEffect(
          Object.freeze({
            ...journalBinding(session, parsed),
            kind: parsed.kind,
            sourceSegments: parsed.sourceSegments,
            destinationSegments: parsed.destinationSegments,
            auxiliarySegments:
              auxiliary === null
                ? null
                : Object.freeze([...auxiliary.parentSegments, auxiliary.leafName]),
            expectedSource: parsed.expectedSource,
            expectedDestination: parsed.expectedDestination,
            expectedAuxiliary,
          }),
        );
        assertIssuedSession(issuedSessions, session);
        return parseEffectObservation(observation);
      } catch (error) {
        throw mapNativeError(error);
      }
    },

    async cleanupIntentAuxiliary(
      session: NativeSafeFsSession,
      intent: NativeMutationIntentSnapshot,
    ): Promise<Readonly<{ state: 'absent' }>> {
      assertIssuedSession(issuedSessions, session);
      const parsed = parseNativeMutationIntentSnapshot(intent);
      assertIntentSession(parsed, session);
      const auxiliary = parsed.temp ?? parsed.tombstone;
      if (
        parsed.state !== 'cleanup_pending' ||
        auxiliary === null ||
        parsed.effectObservation === null
      )
        throw new NativeSafeFsError(
          'INVALID_INPUT',
          'NativeSafeFs cleanup requires a durable observed auxiliary',
        );
      try {
        const observation = await addon!.cleanupIntentAuxiliary(
          Object.freeze({
            ...journalBinding(session, parsed),
            auxiliarySegments: Object.freeze([...auxiliary.parentSegments, auxiliary.leafName]),
            expectedAuxiliary: parsed.effectObservation.auxiliary,
          }),
        );
        assertIssuedSession(issuedSessions, session);
        const parsedObservation = parseEndpoint(observation);
        if (parsedObservation.state !== 'absent')
          throw new Error('Invalid NativeSafeFs cleanup observation');
        return parsedObservation;
      } catch (error) {
        throw mapNativeError(error);
      }
    },

    async closeSession(session: NativeSafeFsSession): Promise<void> {
      if (addon === null)
        throw new NativeSafeFsError('ADDON_UNAVAILABLE', 'NativeSafeFs addon is unavailable');
      if (issuedSessions.get(session.id) !== session)
        throw new NativeSafeFsError('STALE_SESSION', 'NativeSafeFs session is stale');
      issuedSessions.delete(session.id);
      try {
        await addon.closeSession(session.id);
      } catch (error) {
        throw mapNativeError(error);
      }
    },
  });
}

function validateRawAddon(value: unknown): RawAddon {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as Partial<RawAddon>).probe !== 'function' ||
    typeof (value as Partial<RawAddon>).openSession !== 'function' ||
    typeof (value as Partial<RawAddon>).invalidateWorkspace !== 'function' ||
    typeof (value as Partial<RawAddon>).observeIntent !== 'function' ||
    typeof (value as Partial<RawAddon>).stageIntentArtifact !== 'function' ||
    typeof (value as Partial<RawAddon>).applyIntentEffect !== 'function' ||
    typeof (value as Partial<RawAddon>).cleanupIntentAuxiliary !== 'function' ||
    typeof (value as Partial<RawAddon>).closeSession !== 'function'
  )
    throw new Error('NativeSafeFs addon contract mismatch');
  return value as RawAddon;
}

function failInvalidNativeIntent(): never {
  throw new NativeSafeFsError('INVALID_INPUT', 'NativeSafeFs intent is missing staged identity');
}

function assertIssuedSession(
  issuedSessions: ReadonlyMap<string, NativeSafeFsSession>,
  session: NativeSafeFsSession,
): void {
  if (issuedSessions.get(session.id) !== session)
    throw new NativeSafeFsError('STALE_SESSION', 'NativeSafeFs session is stale');
}

function assertIntentSession(
  intent: NativeMutationIntentSnapshot,
  session: NativeSafeFsSession,
): void {
  if (
    intent.workspaceKey !== session.workspaceKey ||
    intent.leaseFence !== session.fence ||
    intent.nativeSessionId !== session.id
  )
    throw new NativeSafeFsError('STALE_SESSION', 'Native mutation intent session is stale');
}

function journalBinding(
  session: NativeSafeFsSession,
  intent: NativeMutationIntentSnapshot,
): RawJournalBinding {
  return Object.freeze({
    sessionId: session.id,
    intentId: intent.id,
    intentDigest: intent.intentDigest,
    recordDigest: intent.recordDigest,
    revision: intent.revision,
  });
}

function parseEffectObservation(value: unknown): NativeMutationEffectObservation {
  if (!isRecord(value) || !hasExactKeys(value, ['source', 'destination', 'auxiliary']))
    throw new Error('Invalid NativeSafeFs effect observation');
  return Object.freeze({
    source: parseEndpoint(value['source']),
    destination: parseEndpoint(value['destination']),
    auxiliary: parseEndpoint(value['auxiliary']),
  });
}

function parseEndpoint(value: unknown): NativeMutationEffectObservation['source'] {
  if (isRecord(value) && hasExactKeys(value, ['state']) && value['state'] === 'absent')
    return Object.freeze({ state: 'absent' as const });
  return parseRevision(value);
}

function parseRevision(value: unknown): NativeMutationRevision {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['state', 'identityDigest', 'contentHash', 'size', 'mode', 'nlink']) ||
    value['state'] !== 'present' ||
    typeof value['identityDigest'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value['identityDigest']) ||
    typeof value['contentHash'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value['contentHash']) ||
    !Number.isSafeInteger(value['size']) ||
    (value['size'] as number) < 0 ||
    (value['size'] as number) > 1024 * 1024 ||
    !Number.isSafeInteger(value['mode']) ||
    ((value['mode'] as number) & 0o170000) !== 0o100000 ||
    value['nlink'] !== 1
  )
    throw new Error('Invalid NativeSafeFs revision observation');
  return Object.freeze({
    state: 'present',
    identityDigest: value['identityDigest'],
    contentHash: value['contentHash'],
    size: value['size'] as number,
    mode: value['mode'] as number,
    nlink: 1,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validateOpenInput(input: NativeSafeFsOpenInput): void {
  if (
    typeof input.rootId !== 'string' ||
    input.rootId.length === 0 ||
    input.rootId.length > 200 ||
    typeof input.workspacePath !== 'string' ||
    input.workspacePath.length < 1 ||
    input.workspacePath.includes('\0') ||
    typeof input.lockDirectoryPath !== 'string' ||
    input.lockDirectoryPath.length < 1 ||
    input.lockDirectoryPath.includes('\0') ||
    !/^[0-9]+$/.test(input.rootDev) ||
    !/^[0-9]+$/.test(input.rootIno) ||
    !/^[a-f0-9]{64}$/.test(input.workspaceKey) ||
    !isPositiveDecimal(input.fence)
  )
    throw new NativeSafeFsError('INVALID_INPUT', 'Invalid NativeSafeFs session input');
}

function parseProbe(value: unknown): NativeSafeFsProbe {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid native probe');
  const record = value as Record<string, unknown>;
  const capabilities = record['capabilities'];
  if (
    record['available'] !== true ||
    record['apiVersion'] !== 1 ||
    record['platform'] !== process.platform ||
    typeof capabilities !== 'object' ||
    capabilities === null ||
    (capabilities as Record<string, unknown>)['rootSession'] !== true ||
    (capabilities as Record<string, unknown>)['workspaceLock'] !== true ||
    (capabilities as Record<string, unknown>)['durableFence'] !== true ||
    (capabilities as Record<string, unknown>)['synchronousInvalidation'] !== true ||
    (capabilities as Record<string, unknown>)['mutation'] !== false
  )
    throw new Error('Invalid native probe');
  return Object.freeze({
    available: true,
    apiVersion: 1,
    platform: process.platform,
    capabilities: Object.freeze({
      rootSession: true,
      workspaceLock: true,
      durableFence: true,
      synchronousInvalidation: true,
      mutation: false,
    }),
    unavailableReason: null,
  });
}

function parseSession(value: unknown): NativeSafeFsSession {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid native session');
  const record = value as Record<string, unknown>;
  if (
    typeof record['id'] !== 'string' ||
    !/^[a-f0-9]{32}$/.test(record['id']) ||
    typeof record['rootId'] !== 'string' ||
    record['rootId'].length === 0 ||
    record['rootId'].length > 200 ||
    typeof record['workspaceKey'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record['workspaceKey']) ||
    !isPositiveDecimal(record['fence']) ||
    typeof record['rootDev'] !== 'string' ||
    typeof record['rootIno'] !== 'string'
  )
    throw new Error('Invalid native session');
  return Object.freeze({
    id: record['id'],
    rootId: record['rootId'],
    workspaceKey: record['workspaceKey'],
    fence: record['fence'],
    rootDev: record['rootDev'],
    rootIno: record['rootIno'],
  });
}

function unavailableProbe(reason: string | null): NativeSafeFsProbe {
  return Object.freeze({
    available: false,
    apiVersion: 1,
    platform: process.platform,
    capabilities: Object.freeze({
      rootSession: false,
      workspaceLock: false,
      durableFence: false,
      synchronousInvalidation: false,
      mutation: false,
    }),
    unavailableReason: reason ?? 'NativeSafeFs addon is unavailable',
  });
}

function mapNativeError(error: unknown): NativeSafeFsError {
  if (error instanceof NativeSafeFsError) return error;
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    if (isNativeErrorCode(code)) return new NativeSafeFsError(code, error.message);
  }
  return new NativeSafeFsError('NATIVE_FAILURE', 'NativeSafeFs operation failed');
}

function isNativeErrorCode(value: unknown): value is NativeSafeFsErrorCode {
  return [
    'INVALID_INPUT',
    'UNSUPPORTED_PLATFORM',
    'ROOT_IDENTITY_CHANGED',
    'UNSAFE_PATH',
    'UNSAFE_LOCK',
    'LOCK_BUSY',
    'STALE_FENCE',
    'STALE_SESSION',
    'NATIVE_FAILURE',
  ].includes(value as string);
}

function safeLoadError(error: unknown): string {
  if (!(error instanceof Error)) return 'NativeSafeFs addon load failed';
  return error.message.replace(/[\r\n\t]/g, ' ').slice(0, 300);
}

function isPositiveDecimal(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
}
