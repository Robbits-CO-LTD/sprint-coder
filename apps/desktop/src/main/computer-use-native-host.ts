import { createHash } from 'node:crypto';
import {
  bindComputerUseMaximumMode,
  computerAppIdentitySchema,
  computerUseActionResultSchema,
  computerUseAvailabilitySchema,
  computerUseObservationSchema,
  computerUseModeSchema,
  computerUsePolicyLanguageSchema,
  computerUseResultSchema,
  computerUseWindowCandidateSchema,
  type ComputerAppIdentity,
  type ComputerUseAvailability,
  type ComputerUseNativeManifest,
  type ComputerUseObservation,
  type ComputerUsePolicyLanguage,
  type ComputerUseMode,
} from '@sprint-coder/contracts';
import type {
  ComputerUseNativeActionResult,
  ComputerUseNativeHost,
  ComputerUseNativeSession,
  ComputerUseNativeWindow,
} from './computer-use-controller';
import type { ComputerUseNativeBinding, ComputerUseNativeAddon } from './computer-use-native';
import {
  ComputerUseAccessibilityTreeError,
  projectComputerUseAccessibilityTree,
} from './computer-use-accessibility-tree';
import { computerUseActionDigest } from './computer-use-action';

/** Stable Main-side reason for a native boundary that cannot service the controller seam. */
export const COMPUTER_USE_NATIVE_PICKER_UNAVAILABLE = 'native_picker_unavailable' as const;
export const COMPUTER_USE_NATIVE_CONTROLLER_UNAVAILABLE = 'native_controller_unavailable' as const;

export class ComputerUseNativeUnavailableError extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
    this.name = 'ComputerUseNativeUnavailableError';
  }
}

type NativePlatform = 'darwin' | 'win32';
type RuntimePlatform = 'darwin' | 'win32' | 'linux' | 'other';
type NativeMethod =
  'pickApplication' | 'listWindows' | 'startSession' | 'observe' | 'dispatch' | 'cancel' | 'close';

type InternalNativeSession = ComputerUseNativeSession &
  Readonly<{ raw: Readonly<Record<string, unknown>> }>;
type ComputerUseNativeBounds = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;
export type ComputerUseNativeHostOptions = Readonly<{
  windowsPhysicalBoundsToDip?: (bounds: ComputerUseNativeBounds) => ComputerUseNativeBounds;
}>;

/**
 * Adapt the signed loader result to the Main controller contract.  The loader intentionally
 * exposes optional addon methods so malformed or older packages fail closed. A missing picker or
 * controller surface remains unavailable instead of being papered over with renderer-provided
 * paths or process identifiers.
 */
export function createComputerUseNativeHost(
  binding: ComputerUseNativeBinding,
  platform: NodeJS.Platform = process.platform,
  options: ComputerUseNativeHostOptions = {},
): ComputerUseNativeHost {
  const addon = binding.addon;
  const runtimePlatform = runtimePlatformFor(platform);
  const packageReady =
    binding.artifactPath !== null &&
    binding.manifest.nativeVersion !== 'disabled' &&
    binding.manifest.signerDigest !== null;
  const pickerReady = hasMethod(addon, 'pickApplication');
  const coordinateReady = platform !== 'win32' || options.windowsPhysicalBoundsToDip !== undefined;
  const controllerReady =
    coordinateReady &&
    pickerReady &&
    hasMethod(addon, 'listWindows') &&
    hasMethod(addon, 'startSession') &&
    hasMethod(addon, 'observe') &&
    hasMethod(addon, 'dispatch') &&
    hasMethod(addon, 'cancel') &&
    hasMethod(addon, 'close');
  const probeReady = binding.probe.available && binding.probe.capabilities.observe;
  // A protocol probe without the complete Main controller surface is not a usable handshake.
  // Keeping this gate closed also satisfies the availability invariant that a failed state must
  // not advertise all package/handshake gates as ready.
  const handshakeReady =
    packageReady &&
    binding.probe.protocolVersion === 1 &&
    binding.probe.apiVersion === 1 &&
    addon !== null &&
    controllerReady;
  const sessions = new Map<string, InternalNativeSession>();
  const pidsByIdentity = new Map<string, number>();
  const revisionsBySession = new Map<string, number>();

  const unavailableReason = (): string => {
    if (!packageReady) return normalizeReason(binding.probe.reason) || 'unsigned_package';
    if (!pickerReady) return COMPUTER_USE_NATIVE_PICKER_UNAVAILABLE;
    if (!controllerReady) return COMPUTER_USE_NATIVE_CONTROLLER_UNAVAILABLE;
    if (!handshakeReady) return normalizeReason(binding.probe.reason) || 'handshake_failed';
    if (!probeReady) return normalizeReason(binding.probe.reason) || 'native_unavailable';
    return normalizeReason(binding.probe.reason) || 'native_unavailable';
  };

  const requireMethod = (method: NativeMethod): ((input: unknown) => unknown) => {
    if (
      !packageReady ||
      !handshakeReady ||
      !controllerReady ||
      addon === null ||
      !hasMethod(addon, method)
    )
      throw new ComputerUseNativeUnavailableError(
        method === 'pickApplication' && !pickerReady
          ? COMPUTER_USE_NATIVE_PICKER_UNAVAILABLE
          : unavailableReason(),
      );
    if (!probeReady && (method === 'startSession' || method === 'observe' || method === 'dispatch'))
      throw new ComputerUseNativeUnavailableError(unavailableReason());
    return (input: unknown) => addon[method](input);
  };

  const invoke = async (method: NativeMethod, input: unknown): Promise<unknown> =>
    await Promise.resolve(requireMethod(method)(input));

  const host: ComputerUseNativeHost = {
    availability: (): ComputerUseAvailability => {
      const nativeAvailable = binding.probe.available && binding.probe.capabilities.observe;
      const observe = packageReady && handshakeReady && nativeAvailable && controllerReady;
      const control = observe && binding.probe.capabilities.control && hasMethod(addon, 'dispatch');
      const state = !packageReady
        ? 'unsigned_package'
        : !handshakeReady
          ? 'handshake_failed'
          : !observe
            ? 'native_unavailable'
            : 'ready';
      return computerUseAvailabilitySchema.parse({
        platform: runtimePlatform,
        state,
        // The feature flag itself is evaluated by ComputerUseController. This native seam reports
        // only package/protocol/native facts and leaves the exact opt-in gate to Main.
        featureEnabled: true,
        packageReady,
        handshakeReady,
        observe,
        control,
        available: observe,
        reasonCode: observe ? null : unavailableReason(),
        manifestDigest: packageReady ? manifestDigest(binding.manifest, runtimePlatform) : null,
      });
    },

    pickApplication: async (input): Promise<ComputerAppIdentity | null> => {
      const value = await invoke('pickApplication', input);
      if (value === null) return null;
      const raw = asRecord(value, 'native_app_identity_invalid');
      const pid = raw['pid'];
      const publicIdentity = stripNativeEphemeralFields(raw);
      delete publicIdentity['screenBounds'];
      publicIdentity['policyLanguage'] = nativePolicyLanguage(raw);
      publicIdentity['maximumMode'] = nativeMaximumMode(raw);
      const identity = computerAppIdentitySchema.parse(publicIdentity);
      if (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0)
        pidsByIdentity.set(identity.identityDigest, pid);
      return identity;
    },

    listWindows: async (profile): Promise<readonly ComputerUseNativeWindow[]> => {
      const pid = pidsByIdentity.get(profile.identityDigest);
      const value = await invoke('listWindows', {
        ...profile,
        appIdentityDigest: profile.identityDigest,
        ...(pid === undefined ? {} : { pid }),
      });
      if (!Array.isArray(value))
        throw new ComputerUseNativeUnavailableError('native_windows_invalid');
      return value.map((candidate) => {
        const raw = asRecord(candidate, 'native_window_invalid');
        const executableDigest = nativeWindowExecutableDigest(raw, profile);
        const resolvedPid = raw['pid'];
        if (typeof resolvedPid === 'number' && Number.isSafeInteger(resolvedPid) && resolvedPid > 0)
          pidsByIdentity.set(profile.identityDigest, resolvedPid);
        const publicCandidate = stripNativeEphemeralFields(raw);
        delete publicCandidate['executableDigest'];
        publicCandidate['policyLanguage'] = nativePolicyLanguage(raw);
        publicCandidate['maximumMode'] = nativeMaximumMode(raw);
        let screenBounds: ComputerUseNativeBounds;
        if (profile.platform === 'win32') {
          if (
            raw['boundsUnit'] !== 'physical_px' ||
            options.windowsPhysicalBoundsToDip === undefined
          )
            throw new ComputerUseNativeUnavailableError('native_window_coordinate_invalid');
          publicCandidate['bounds'] = options.windowsPhysicalBoundsToDip(
            parseNativeBounds(raw['bounds']),
          );
          screenBounds = options.windowsPhysicalBoundsToDip(parseNativeBounds(raw['screenBounds']));
        } else {
          screenBounds = parseNativeBounds(raw['screenBounds']);
        }
        delete publicCandidate['screenBounds'];
        const parsed = computerUseWindowCandidateSchema.parse(publicCandidate);
        return Object.freeze({
          ...parsed,
          platform: profile.platform,
          executableDigest,
          screenBounds,
        }) as ComputerUseNativeWindow;
      });
    },

    startSession: async (input): Promise<ComputerUseNativeSession> => {
      const existing = sessions.get(input.sessionId);
      if (existing !== undefined) {
        if (
          existing.platform !== input.profile.platform ||
          existing.appIdentityDigest !== input.profile.identityDigest ||
          existing.windowId !== input.windowId ||
          existing.profileRevision !== input.profile.revision
        )
          throw new ComputerUseNativeUnavailableError('native_session_rebind_forbidden');
        const request = {
          ...existing.raw,
          ...input,
          appIdentityDigest: input.profile.identityDigest,
          canonicalPath: input.profile.canonicalPath,
          windowIdentityDigest: existing.windowIdentityDigest,
          resume: input.resume === true,
          expectedPolicyLanguage: existing.policyLanguage,
        };
        const value = await invoke('startSession', request);
        const raw = asRecord(value, 'native_session_invalid');
        const session = parseNativeSession(
          raw,
          input.profile.platform,
          input,
          request,
          options.windowsPhysicalBoundsToDip,
        );
        sessions.set(session.sessionId, session);
        return publicNativeSession(session);
      }
      let pid = pidsByIdentity.get(input.profile.identityDigest);
      if (pid === undefined) {
        const windows = await host.listWindows(input.profile);
        pid = pidsByIdentity.get(input.profile.identityDigest);
        if (
          pid === undefined ||
          windows.every((candidate) => candidate.windowId !== input.windowId)
        )
          throw new ComputerUseNativeUnavailableError('native_app_not_active');
      }
      const candidate = await invoke('listWindows', {
        ...input.profile,
        pid,
        appIdentityDigest: input.profile.identityDigest,
      });
      if (!Array.isArray(candidate))
        throw new ComputerUseNativeUnavailableError('native_windows_invalid');
      const selected = candidate.find((value) => {
        const raw = asRecord(value, 'native_window_invalid');
        return raw['windowId'] === input.windowId && raw['eligible'] === true;
      });
      const selectedRecord =
        selected === undefined ? null : asRecord(selected, 'native_window_invalid');
      if (selectedRecord === null)
        throw new ComputerUseNativeUnavailableError('native_window_stale');
      const selectedPid = selectedRecord['pid'];
      if (typeof selectedPid !== 'number' || !Number.isSafeInteger(selectedPid) || selectedPid < 1)
        throw new ComputerUseNativeUnavailableError('native_window_owner_invalid');
      pid = selectedPid;
      pidsByIdentity.set(input.profile.identityDigest, selectedPid);
      const selectedBounds = asRecord(selectedRecord['bounds'], 'native_window_invalid');
      const expectedMaximumMode = bindComputerUseMaximumMode(
        nativeMaximumMode(input.profile.identity),
        nativeMaximumMode(selectedRecord),
      );
      const request = {
        ...input,
        pid,
        appIdentityDigest: input.profile.identityDigest,
        canonicalPath: input.profile.canonicalPath,
        windowIdentityDigest: stringField(selectedRecord, 'windowIdentityDigest'),
        expectedBoundsX: selectedBounds['x'],
        expectedBoundsY: selectedBounds['y'],
        expectedBoundsWidth: selectedBounds['width'],
        expectedBoundsHeight: selectedBounds['height'],
        expectedPolicyLanguage: nativePolicyLanguage(selectedRecord),
        maximumMode: expectedMaximumMode,
        expectedMaximumMode,
      };
      const value = await invoke('startSession', request);
      const raw = asRecord(value, 'native_session_invalid');
      const session = parseNativeSession(
        raw,
        input.profile.platform,
        input,
        request,
        options.windowsPhysicalBoundsToDip,
      );
      sessions.set(session.sessionId, session);
      // `raw` stays inside this Main/native adapter. It may contain OS handles needed by a native
      // implementation, but it is never returned to the controller or renderer.
      return publicNativeSession(session);
    },

    observe: async (session, input): Promise<ComputerUseObservation> => {
      const internal = sessions.get(session.sessionId);
      if (internal === undefined)
        throw new ComputerUseNativeUnavailableError('native_session_missing');
      const value = await invoke('observe', {
        ...internal.raw,
        appIdentityDigest: session.appIdentityDigest,
        requestId: input.requestId,
        cancelEpoch: input.cancelEpoch,
      });
      return toObservation(
        value,
        session,
        revisionsBySession,
        () => Date.now(),
        options.windowsPhysicalBoundsToDip,
      );
    },

    dispatch: async (input): Promise<ComputerUseNativeActionResult> => {
      const internal = sessions.get(input.session.sessionId);
      if (internal === undefined)
        throw new ComputerUseNativeUnavailableError('native_session_missing');
      const actionDigest = computerUseActionDigest(input.action);
      let value: unknown;
      try {
        value = await invoke('dispatch', {
          ...internal.raw,
          ...input.action,
          requestId: input.requestId,
          observationRevision: input.observationRevision,
          cancelEpoch: input.cancelEpoch,
          actionDigest,
        });
      } catch (error) {
        const preDispatch = classifyComputerUseNativeDispatchFailure(error);
        if (preDispatch !== null) return preDispatch;
        throw error;
      }
      const record = asRecord(value, 'native_action_result_invalid');
      const result = computerUseResultSchema.parse(record['result']);
      const reasonCode = record['reasonCode'];
      if (reasonCode !== null && typeof reasonCode !== 'string')
        throw new ComputerUseNativeUnavailableError('native_action_result_invalid');
      if (
        internal.platform === 'darwin' &&
        (record['requestId'] !== input.requestId ||
          record['sessionId'] !== input.session.sessionId ||
          record['observationRevision'] !== input.observationRevision ||
          record['actionDigest'] !== actionDigest ||
          typeof record['accepted'] !== 'boolean' ||
          typeof record['effectStarted'] !== 'boolean')
      )
        throw new ComputerUseNativeUnavailableError('native_action_envelope_invalid');
      if (internal.platform === 'darwin') {
        const accepted = record['accepted'] === true;
        const effectStarted = record['effectStarted'] === true;
        if (
          (result === 'completed' && !accepted) ||
          (result === 'unknown_effect' && (!accepted || !effectStarted)) ||
          ((result === 'rejected' || result === 'paused' || result === 'canceled') &&
            (accepted || effectStarted))
        )
          throw new ComputerUseNativeUnavailableError('native_action_effect_invalid');
      }
      // Parse the public result shape once here so malformed native responses cannot cross the
      // controller boundary. The action id is native request-bound and is not persisted here.
      computerUseActionResultSchema.partial().parse({
        actionId: input.requestId,
        sessionId: input.session.sessionId,
        observationRevision: input.observationRevision,
        result,
        reasonCode: reasonCode ?? null,
      });
      return Object.freeze({ result, reasonCode: reasonCode ?? null });
    },

    cancel: async (session, cancelEpoch): Promise<void> => {
      const internal = sessions.get(session.sessionId);
      if (internal === undefined) return;
      await invoke('cancel', { ...internal.raw, cancelEpoch });
    },

    close: async (session): Promise<void> => {
      const internal = sessions.get(session.sessionId);
      if (internal === undefined) return;
      try {
        await invoke('close', { ...internal.raw });
      } finally {
        sessions.delete(session.sessionId);
      }
    },
  };
  return Object.freeze(host);
}

/** Default for unit/embedded callers that do not provide a loaded native binding. */
export function createUnavailableComputerUseNativeHost(
  platform: NodeJS.Platform = process.platform,
): ComputerUseNativeHost {
  const nativePlatform: NativePlatform = platform === 'win32' ? 'win32' : 'darwin';
  const zero = '0'.repeat(64);
  return createComputerUseNativeHost(
    {
      manifest: {
        version: 1,
        sourceCommit: '0'.repeat(40),
        platform: nativePlatform,
        architecture: platform === 'win32' ? 'x64' : process.arch === 'arm64' ? 'arm64' : 'x64',
        protocolVersion: 1,
        apiVersion: 1,
        nativeVersion: 'disabled',
        moduleDigest: zero,
        binaryDigest: zero,
        signerDigest: null,
        capabilities: ['observe'],
      },
      probe: {
        available: false,
        protocolVersion: 1,
        apiVersion: 1,
        backend: `${platform}-unavailable`,
        reason: 'FEATURE_FLAG_DISABLED',
        artifactPath: null,
        artifactDigest: null,
        capabilities: { observe: false, control: false },
      },
      artifactPath: null,
      addon: null,
    },
    platform,
  );
}

function hasMethod(
  addon: ComputerUseNativeAddon | null,
  method: NativeMethod,
): addon is ComputerUseNativeAddon & Record<NativeMethod, (input: unknown) => unknown> {
  return addon !== null && typeof addon[method] === 'function';
}

function runtimePlatformFor(platform: NodeJS.Platform): RuntimePlatform {
  if (platform === 'darwin' || platform === 'win32' || platform === 'linux') return platform;
  return 'other';
}

function manifestDigest(
  manifest: ComputerUseNativeManifest,
  platform: RuntimePlatform,
): string | null {
  if (platform !== 'darwin' && platform !== 'win32') return null;
  return platform === 'darwin' ? manifest.moduleDigest : manifest.binaryDigest;
}

function normalizeReason(reason: string): string {
  return reason
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

function asRecord(value: unknown, reason: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ComputerUseNativeUnavailableError(reason);
  return value as Record<string, unknown>;
}

function parseNativeSession(
  raw: Readonly<Record<string, unknown>>,
  platform: NativePlatform,
  input: {
    profile: { identityDigest: string; revision: number };
    windowId: string;
    sessionId: string;
    cancelEpoch: number;
  },
  requestBindings: Readonly<Record<string, unknown>>,
  windowsPhysicalBoundsToDip?: (bounds: ComputerUseNativeBounds) => ComputerUseNativeBounds,
): InternalNativeSession {
  const sessionId = stringField(raw, 'sessionId', input.sessionId);
  const windowId = stringField(raw, 'windowId', input.windowId);
  const appIdentityDigest = stringField(raw, 'appIdentityDigest');
  const windowIdentityDigest = stringField(raw, 'windowIdentityDigest');
  const profileRevision = numberField(raw, 'profileRevision', input.profile.revision);
  const cancelEpoch = numberField(raw, 'cancelEpoch', input.cancelEpoch);
  const policyLanguage = nativePolicyLanguage(raw);
  const maximumMode = bindComputerUseMaximumMode(
    nativeMaximumMode(requestBindings),
    nativeMaximumMode(raw),
  );
  const rawScreenBounds = parseNativeBounds(raw['screenBounds']);
  const screenBounds =
    platform === 'win32' ? windowsPhysicalBoundsToDip?.(rawScreenBounds) : rawScreenBounds;
  if (
    sessionId !== input.sessionId ||
    windowId !== input.windowId ||
    appIdentityDigest !== input.profile.identityDigest ||
    profileRevision !== input.profile.revision
  )
    throw new ComputerUseNativeUnavailableError('native_session_identity_mismatch');
  if (screenBounds === undefined)
    throw new ComputerUseNativeUnavailableError('native_window_coordinate_invalid');
  return Object.freeze({
    sessionId,
    platform,
    appIdentityDigest,
    windowIdentityDigest,
    windowId,
    profileRevision,
    cancelEpoch,
    policyLanguage,
    maximumMode,
    screenBounds,
    // The native response intentionally exposes no OS handles beyond its bounded envelope. Keep
    // Main's already-verified geometry/path bindings so an explicit resume can re-submit them,
    // while authority-bearing response facts (especially policyLanguage) always win.
    raw: Object.freeze({ ...requestBindings, ...raw, policyLanguage, maximumMode }),
  });
}

function publicNativeSession(session: InternalNativeSession): ComputerUseNativeSession {
  return Object.freeze({
    sessionId: session.sessionId,
    platform: session.platform,
    appIdentityDigest: session.appIdentityDigest,
    windowIdentityDigest: session.windowIdentityDigest,
    windowId: session.windowId,
    profileRevision: session.profileRevision,
    cancelEpoch: session.cancelEpoch,
    policyLanguage: session.policyLanguage,
    maximumMode: session.maximumMode,
    screenBounds: session.screenBounds,
  });
}

function stringField(
  value: Readonly<Record<string, unknown>>,
  key: string,
  fallback?: string,
): string {
  const candidate = value[key];
  if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  if (fallback !== undefined) return fallback;
  throw new ComputerUseNativeUnavailableError('native_session_invalid');
}

function numberField(
  value: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
): number {
  const candidate = value[key];
  if (candidate === undefined) return fallback;
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 0)
    throw new ComputerUseNativeUnavailableError('native_session_invalid');
  return candidate;
}

function stripNativeEphemeralFields(
  value: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const result = { ...value };
  delete result['pid'];
  delete result['processId'];
  delete result['windowHandle'];
  delete result['boundsUnit'];
  return result;
}

function nativeWindowExecutableDigest(
  value: Readonly<Record<string, unknown>>,
  profile: Readonly<{
    platform: 'darwin' | 'win32';
    identityDigest: string;
    executableDigest: string | null;
    identity: Readonly<Record<string, unknown>>;
  }>,
): string | null {
  if (profile.platform !== 'win32') return null;
  const executableDigest = value['executableDigest'];
  if (typeof executableDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(executableDigest))
    throw new ComputerUseNativeUnavailableError('native_app_identity_changed');
  if (value['appIdentityDigest'] !== profile.identityDigest)
    throw new ComputerUseNativeUnavailableError('native_app_identity_changed');
  const signerDigest = profile.identity['signerDigest'];
  if (
    executableDigest !== profile.executableDigest &&
    (typeof signerDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(signerDigest))
  )
    throw new ComputerUseNativeUnavailableError('native_app_identity_changed');
  return executableDigest;
}

function parseNativeBounds(value: unknown): ComputerUseNativeBounds {
  const bounds = asRecord(value, 'native_window_coordinate_invalid');
  const parsed = {
    x: bounds['x'],
    y: bounds['y'],
    width: bounds['width'],
    height: bounds['height'],
  };
  if (
    !Object.values(parsed).every((item) => typeof item === 'number' && Number.isFinite(item)) ||
    Number(parsed.width) <= 0 ||
    Number(parsed.height) <= 0 ||
    Number(parsed.width) > 32_768 ||
    Number(parsed.height) > 32_768
  )
    throw new ComputerUseNativeUnavailableError('native_window_coordinate_invalid');
  return {
    x: Number(parsed.x),
    y: Number(parsed.y),
    width: Number(parsed.width),
    height: Number(parsed.height),
  };
}

export function classifyComputerUseNativeDispatchFailure(
  error: unknown,
): ComputerUseNativeActionResult | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { code?: unknown; accepted?: unknown };
  if (candidate.accepted === true || typeof candidate.code !== 'string') return null;
  const code = candidate.code.toUpperCase();
  if (code === 'CANCELED')
    return Object.freeze({ result: 'canceled', reasonCode: 'native_canceled_pre_dispatch' });
  const preDispatchCodes = new Set([
    'INVALID_ACTION',
    'NATIVE_CAPABILITY_UNAVAILABLE',
    'FOCUS_REQUIRED',
    'APP_IDENTITY_CHANGED',
    'WINDOW_UNAVAILABLE',
    'STALE_TARGET',
    'TARGET_REQUIRED',
    'TARGET_UNCLASSIFIED',
    'SECURE_FIELD_BLOCKED',
    'HIGH_IMPACT_BLOCKED',
    'UNSUPPORTED_ACTION',
    'INPUT_UNAVAILABLE',
    'SESSION_MISSING',
    'SESSION_IDENTITY_CHANGED',
    'SESSION_TARGET_REJECTED',
    'WINDOW_IDENTITY_CHANGED',
    'WINDOW_GEOMETRY_CHANGED',
    'WINDOW_NOT_SHAREABLE',
    'ELEVATED_TARGET_BLOCKED',
    'TARGET_AMBIGUOUS',
    'TARGET_INELIGIBLE',
    'SEMANTIC_PATTERN_UNAVAILABLE',
    'SEMANTIC_STATE_UNAVAILABLE',
    'SEMANTIC_ACTION_FAILED',
    'INVALID_KEY',
    'INVALID_TEXT',
    'INVALID_TARGET',
  ]);
  if (candidate.accepted !== false && !preDispatchCodes.has(code)) return null;
  if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(code)) return null;
  return Object.freeze({
    result: 'rejected',
    reasonCode: `native_${code.toLowerCase()}`.slice(0, 64),
  });
}

function toObservation(
  value: unknown,
  session: ComputerUseNativeSession,
  revisions: Map<string, number>,
  now: () => number,
  windowsPhysicalBoundsToDip?: (bounds: ComputerUseNativeBounds) => ComputerUseNativeBounds,
): ComputerUseObservation {
  const raw = asRecord(value, 'native_observation_invalid');
  const rawScreenBounds = parseNativeBounds(raw['screenBounds']);
  const screenBounds =
    session.platform === 'win32' ? windowsPhysicalBoundsToDip?.(rawScreenBounds) : rawScreenBounds;
  if (screenBounds === undefined)
    throw new ComputerUseNativeUnavailableError('native_window_coordinate_invalid');
  const maximumMode = bindComputerUseMaximumMode(session.maximumMode, nativeMaximumMode(raw));
  // Test/native adapters may already return the canonical contract. Keep the check strict while
  // still accepting the low-level `{screenshot, tree, captureWidth, ...}` payload emitted by the
  // Objective-C++ module.
  if (Array.isArray(raw['images'])) {
    const parsed = computerUseObservationSchema.parse({
      ...raw,
      policyLanguage: nativePolicyLanguage(raw),
      maximumMode,
      screenBounds,
    });
    const sanitized = sanitizeCanonicalObservationTree(parsed);
    revisions.set(session.sessionId, sanitized.revision);
    return sanitized;
  }
  const screenshot = bytesValue(raw['screenshot']);
  if (screenshot === null || screenshot.byteLength === 0 || screenshot.byteLength > 8 * 1024 * 1024)
    throw new ComputerUseNativeUnavailableError('native_screenshot_invalid');
  const width = requiredCaptureDimension(raw['captureWidth'] ?? raw['clientWidth'], 2_560);
  const height = requiredCaptureDimension(raw['captureHeight'] ?? raw['clientHeight'], 1_600);
  const tree = typeof raw['tree'] === 'string' ? raw['tree'] : undefined;
  const projection = tree === undefined ? null : projectNativeAccessibilityTree(tree);
  const prior = revisions.get(session.sessionId) ?? 0;
  const revision = Math.max(prior + 1, positiveDimension(raw['revision']) || 1);
  const observedAtMs = now();
  const observedAt = new Date(observedAtMs).toISOString();
  const parsed = computerUseObservationSchema.parse({
    sessionId: session.sessionId,
    appIdentityDigest: session.appIdentityDigest,
    windowIdentityDigest: session.windowIdentityDigest,
    profileRevision: session.profileRevision,
    policyLanguage: nativePolicyLanguage(raw),
    maximumMode,
    screenBounds,
    revision,
    observedAt,
    // Keep a small margin under the contract TTL so timestamp rounding or a slow tree projection
    // cannot make a freshly captured observation appear already invalid.
    expiresAt: new Date(observedAtMs + 29_000).toISOString(),
    clientWidth: width,
    clientHeight: height,
    images: [
      {
        mimeType: raw['screenshotMimeType'] === 'image/jpeg' ? 'image/jpeg' : 'image/png',
        digest: sha256(screenshot),
        byteLength: screenshot.byteLength,
        width,
        height,
        base64: screenshot.toString('base64'),
      },
    ],
    treeDigest: projection?.digest ?? null,
    treeByteLength: projection?.byteLength ?? 0,
    treeDepth: projection?.depth ?? 0,
    treeNodeCount: projection?.nodeCount ?? 0,
    ...(projection === null ? {} : { accessibilityTree: projection.serialized }),
    ...(projection === null
      ? {}
      : {
          targetSignatures: projection.signatures,
          targetMetadata: projection.metadata,
        }),
    focusedElementSignature:
      raw['focusedElementSignature'] === null
        ? null
        : typeof raw['focusedElementSignature'] === 'string'
          ? raw['focusedElementSignature']
          : undefined,
    ...(typeof raw['focusedElementSecure'] === 'boolean'
      ? { focusedElementSecure: raw['focusedElementSecure'] }
      : {}),
    ...(typeof raw['focusedElementHighImpact'] === 'boolean'
      ? { focusedElementHighImpact: raw['focusedElementHighImpact'] }
      : {}),
    dialogSetRevision: raw['dialogSetRevision'] ?? 0,
    dialogSetDigest: raw['dialogSetDigest'] ?? null,
    activeWindowIdentityDigest: raw['activeWindowIdentityDigest'] ?? null,
    activeWindowKind: raw['activeWindowKind'] ?? 'application',
  });
  revisions.set(session.sessionId, parsed.revision);
  return parsed;
}

export function deriveComputerUseTargetFacts(tree: string): Readonly<{
  signatures: Readonly<Record<string, string>>;
  metadata: Readonly<Record<string, Readonly<{ secure: boolean; highImpact: boolean }>>>;
}> {
  const projection = projectNativeAccessibilityTree(tree);
  return Object.freeze({
    signatures: projection.signatures,
    metadata: projection.metadata,
  });
}

function projectNativeAccessibilityTree(
  tree: string,
): ReturnType<typeof projectComputerUseAccessibilityTree> {
  try {
    return projectComputerUseAccessibilityTree(tree);
  } catch (error) {
    if (error instanceof ComputerUseAccessibilityTreeError)
      throw new ComputerUseNativeUnavailableError(
        error.code === 'tree_oversized' ? 'native_tree_oversized' : 'native_tree_invalid',
      );
    throw error;
  }
}

function sanitizeCanonicalObservationTree(
  observation: ComputerUseObservation,
): ComputerUseObservation {
  if (observation.accessibilityTree === undefined || observation.accessibilityTree === '') {
    if (observation.treeDigest !== null || observation.treeByteLength !== 0)
      throw new ComputerUseNativeUnavailableError('native_tree_invalid');
    const {
      accessibilityTree: _tree,
      targetSignatures: _signatures,
      targetMetadata: _metadata,
      ...rest
    } = observation;
    return computerUseObservationSchema.parse({
      ...rest,
      treeDepth: 0,
      treeNodeCount: 0,
    });
  }
  const projection = projectNativeAccessibilityTree(observation.accessibilityTree);
  const targetMetadata = { ...projection.metadata };
  for (const [targetId, facts] of Object.entries(observation.targetMetadata ?? {})) {
    const projectedFacts = targetMetadata[targetId];
    targetMetadata[targetId] = {
      secure: projectedFacts?.secure === true || facts.secure === true,
      highImpact: projectedFacts?.highImpact === true || facts.highImpact === true,
    };
  }
  return computerUseObservationSchema.parse({
    ...observation,
    accessibilityTree: projection.serialized,
    treeDigest: projection.digest,
    treeByteLength: projection.byteLength,
    treeDepth: projection.depth,
    treeNodeCount: projection.nodeCount,
    targetSignatures: { ...projection.signatures, ...observation.targetSignatures },
    targetMetadata,
  });
}

function bytesValue(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  return null;
}

function nativePolicyLanguage(value: Readonly<Record<string, unknown>>): ComputerUsePolicyLanguage {
  const candidate = value['policyLanguage'];
  if (candidate === undefined || candidate === null) return 'unknown';
  const parsed = computerUsePolicyLanguageSchema.safeParse(candidate);
  if (!parsed.success)
    throw new ComputerUseNativeUnavailableError('native_policy_language_invalid');
  return parsed.data;
}

/** Missing or malformed native capability evidence never authorizes control. */
function nativeMaximumMode(value: Readonly<Record<string, unknown>>): ComputerUseMode {
  const parsed = computerUseModeSchema.safeParse(value['maximumMode']);
  return parsed.success ? parsed.data : 'observe_only';
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function positiveDimension(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : 1;
}

function requiredCaptureDimension(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum)
    throw new ComputerUseNativeUnavailableError('native_capture_dimensions_invalid');
  return Number(value);
}
