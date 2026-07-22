import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

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
  workspaceKey: string;
  fence: string;
  rootDev: string;
  rootIno: string;
}>;

export type NativeSafeFsOpenInput = Readonly<{
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
  invalidateWorkspace(workspaceKey: string, minimumFence: string): void;
  closeSession(session: NativeSafeFsSession): Promise<void>;
}

type RawAddon = Readonly<{
  probe(): unknown;
  openSession(input: NativeSafeFsOpenInput): Promise<unknown>;
  invalidateWorkspace(workspaceKey: string, minimumFence: string): unknown;
  closeSession(id: string): Promise<unknown>;
}>;

export function nativeSafeFsAddonPath(): string {
  return join(__dirname, '../../native-safe-fs/build/Release/vibe_native_safe_fs.node');
}

export function loadNativeSafeFs(
  options: { addonPath?: string; lockDirectoryPath?: string } = {},
): NativeSafeFs {
  const addonPath = resolve(options.addonPath ?? nativeSafeFsAddonPath());
  const lockDirectoryPath =
    options.lockDirectoryPath === undefined ? null : resolve(options.lockDirectoryPath);
  const issuedSessions = new WeakSet<object>();
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
          session.fence !== input.fence ||
          session.rootDev !== input.rootDev ||
          session.rootIno !== input.rootIno
        )
          throw new NativeSafeFsError(
            'NATIVE_FAILURE',
            'NativeSafeFs returned a mismatched session',
          );
        issuedSessions.add(session);
        return session;
      } catch (error) {
        throw mapNativeError(error);
      }
    },

    invalidateWorkspace(workspaceKey: string, minimumFence: string): void {
      if (addon === null)
        throw new NativeSafeFsError('ADDON_UNAVAILABLE', 'NativeSafeFs addon is unavailable');
      if (!/^[a-f0-9]{64}$/.test(workspaceKey) || !isPositiveDecimal(minimumFence))
        throw new NativeSafeFsError('INVALID_INPUT', 'Invalid NativeSafeFs fence invalidation');
      try {
        addon.invalidateWorkspace(workspaceKey, minimumFence);
      } catch (error) {
        throw mapNativeError(error);
      }
    },

    async closeSession(session: NativeSafeFsSession): Promise<void> {
      if (addon === null)
        throw new NativeSafeFsError('ADDON_UNAVAILABLE', 'NativeSafeFs addon is unavailable');
      if (!issuedSessions.has(session))
        throw new NativeSafeFsError('STALE_SESSION', 'NativeSafeFs session is stale');
      issuedSessions.delete(session);
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
    typeof (value as Partial<RawAddon>).closeSession !== 'function'
  )
    throw new Error('NativeSafeFs addon contract mismatch');
  return value as RawAddon;
}

function validateOpenInput(input: NativeSafeFsOpenInput): void {
  if (
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
    typeof record['workspaceKey'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record['workspaceKey']) ||
    !isPositiveDecimal(record['fence']) ||
    typeof record['rootDev'] !== 'string' ||
    typeof record['rootIno'] !== 'string'
  )
    throw new Error('Invalid native session');
  return Object.freeze({
    id: record['id'],
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
