import { expect, it, vi } from 'vitest';
import {
  computerUseObservationSchema,
  computerUseSessionStatusSchema,
  type ComputerUseAction,
} from '@sprint-coder/contracts';
import { createComputerAppGrantFixtureStore } from './computer-use-grant-fixture';
import { createToolId } from '@sprint-coder/domain';
import type { ComputerActionAuditRecord } from './persistence';
import type { ComputerUseNativeBinding } from './computer-use-native';
import type { ComputerUseNativeHost } from './computer-use-controller';
import {
  createComputerUseNativeHost,
  readWindowsExplorerApproval,
  type ComputerUseNativeHostOptions,
} from './computer-use-native-host';
import {
  ComputerUseController,
  windowsExplorerExceptionAllowed,
  windowsExplorerExceptionAllowedForTesting,
} from './computer-use-controller';
import type { TargetFacts } from './computer-use-target-eligibility';
import {
  classifyWindowsExplorerOperation,
  windowsExplorerItemInView,
  type WindowsExplorerOperation,
} from './computer-use-explorer-effect';
import type { WindowsInteractionListener } from './computer-use-windows-transport-events';
import type { WindowsCloseCallbacks } from './computer-use-native-types';
const digest = (digit: string): string => digit.repeat(64);
function binding(
  addon: NonNullable<ComputerUseNativeBinding['addon']>,
  probeOverrides: Partial<ComputerUseNativeBinding['probe']> = {},
  platform: 'darwin' | 'win32' = 'darwin',
): ComputerUseNativeBinding {
  const adapted: typeof addon =
    platform === 'win32' && addon.listWindows !== undefined
      ? {
          ...addon,
          discoverWindows:
            addon.discoverWindows ??
            (async (input: unknown) => {
              if (
                typeof input !== 'object' ||
                input === null ||
                !('discoveryId' in input) ||
                typeof input.discoveryId !== 'string'
              )
                throw new Error('fixture discovery input');
              const { discoveryId, ...request } = input;
              return {
                discoveryId,
                result: 'completed',
                drained: true,
                launchAttemptCount: 0,
                windows: await Promise.resolve(addon.listWindows!(request)),
              };
            }),
          stopWindowDiscovery:
            addon.stopWindowDiscovery ??
            (async (input: unknown) => {
              if (typeof input !== 'object' || input === null || !('discoveryId' in input))
                throw new Error('fixture discovery stop');
              return {
                discoveryId: input.discoveryId,
                result: 'stopped',
                drained: true,
                launchAttemptCount: 0,
              };
            }),
          cancelUnsubmittedDiscovery:
            addon.cancelUnsubmittedDiscovery ?? (() => 'may_have_been_sent'),
        }
      : addon;
  return {
    manifest: {
      version: 1,
      sourceCommit: 'f'.repeat(40),
      platform,
      architecture: platform === 'win32' ? 'x64' : 'arm64',
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
      artifactPath: '/Resources/sprint_coder_computer_use_native.node',
      artifactDigest: digest('1'),
      ...probeOverrides,
      capabilities: {
        observe: true,
        control: true,
        ...(platform === 'win32' ? { cancellableWindowDiscovery: true } : {}),
        ...probeOverrides.capabilities,
      },
    },
    artifactPath:
      platform === 'win32'
        ? '/Resources/sprint-coder-computer-use-host.exe'
        : '/Resources/sprint_coder_computer_use_native.node',
    addon: adapted,
  };
}

const explorerScenario = async (
  overrides: Partial<ComputerUseNativeHostOptions> = {},
  extraSurface: Record<string, unknown> = {},
  bindingOverrides: Partial<ComputerUseNativeBinding> = {},
  classifierRoute: 'v1' | 'v2' = 'v2',
  platform: 'win32' | 'darwin' = 'win32',
  beforeStart?: (host: ComputerUseNativeHost) => void,
  measuredFacts: Record<string, unknown> = facts,
) => {
  const startSession = vi.fn((input: { sessionId: string; cancelEpoch: number }) => ({
    sessionId: input.sessionId,
    windowId: '100',
    pid: 42,
    processStartTime: '123456',
    appIdentityDigest: digest('a'),
    windowIdentityDigest: digest('c'),
    profileRevision: 1,
    cancelEpoch: input.cancelEpoch,
    screenBounds: { x: 300, y: 150, width: 1_200, height: 900 },
    maximumMode: 'full_access_app',
    inputAttemptCount: 0,
  }));
  const appIdentityDigest = digest('a');
  const windowIdentityDigest = digest('c');
  const screen = { x: 300, y: 150, width: 1_200, height: 900 };
  const winTicket = 'cd'.repeat(32);
  const preflight = vi.fn((input: unknown) => {
    const request = input as Record<string, unknown>;
    return {
      decision: 'ordinary',
      reasonCode: null,
      deniedResult: null,
      ticket: winTicket,
      classifierVersion: classifierRoute === 'v2' ? (platform === 'win32' ? 4 : 3) : 1,
      ...(classifierRoute === 'v2' ? { receiptVersion: 2 } : {}),
      inputAttemptCount: 0,
      requestId: request['requestId'],
      sessionId: request['sessionId'],
      cancelEpoch: request['cancelEpoch'],
      observationRevision: request['observationRevision'],
    };
  });
  const dispatch = vi.fn((input: unknown) => {
    const request = input as Record<string, unknown>;
    return {
      result: 'completed',
      reasonCode: null,
      sessionId: request['sessionId'],
      cancelEpoch: request['cancelEpoch'],
      inputAttemptCount: 1,
    };
  });
  let discoveryCount = 0;
  const surface = {
    probe: () => ({}),
    pickApplication: () => null,
    listWindows: () => [
      {
        // First discovery is the legacy profile lookup; the bound-row measurement follows.
        ...(discoveryCount++ === 0 ? {} : { facts: measuredFacts }),
        pid: 42,
        windowHandle: '100',
        boundsUnit: 'physical_px',
        windowId: '100',
        appIdentityDigest,
        executableDigest: digest('b'),
        windowIdentityDigest,
        title: 'Target',
        bounds: screen,
        screenBounds: screen,
        focused: false,
        eligible: true,
        ownerKind: 'application',
        modal: false,
        revision: 1,
        maximumMode: 'full_access_app',
      },
    ],
    measureExplorerView: () => ({
      shellView: measuredFacts.shellView,
      pointOwnerMatches: true,
      item: measuredItem,
    }),
    startSession,
    observe: () => ({}),
    preflight,
    approvalApprove: () => ({}),
    approvalDiscard: () => ({}),
    dispatchApproved: () => ({}),
    windowsApprovalAvailable: () => true,
    windowsApprovalReady: () => true,
    dispatch,
    cancel: () => undefined,
    stopPendingStart: (input: unknown) => ({
      result: 'closed',
      drained: true,
      sessionId: (input as Record<string, unknown>)['sessionId'],
      cancelEpoch: 1,
      inputAttemptCount: 0,
    }),
    close: () => undefined,
    ...extraSurface,
  };
  const host = createComputerUseNativeHost(
    { ...binding(surface, {}, platform), windowsApprovalVerified: true, ...bindingOverrides },
    platform,
    {
      classifierV2Attested: true,
      effectiveEligibilityMode: () => 'v2-denylist',
      ...overrides,
      windowsPhysicalBoundsToDip: (bounds) => bounds,
    },
  );
  const profile = {
    id: 'profile-1',
    platform: 'win32' as const,
    kind: 'win32-executable' as const,
    label: 'Target',
    canonicalPath:
      measuredFacts['imageLeaf'] === 'Target.exe'
        ? 'C:\\Target\\Target.exe'
        : 'C:\\Windows\\explorer.exe',
    appUrl: null,
    identity: {
      platform: 'win32' as const,
      identityDigest: appIdentityDigest,
      executablePath:
        measuredFacts['imageLeaf'] === 'Target.exe'
          ? 'C:\\Target\\Target.exe'
          : 'C:\\Windows\\explorer.exe',
      executableDigest: digest('b'),
      signerDigest: digest('d'),
      packageFamilyName: null,
      appUserModelId: null,
      displayName: 'Target',
      maximumMode: 'full_access_app' as const,
    },
    identityDigest: appIdentityDigest,
    version: null,
    executableDigest: digest('b'),
    mode: 'full_access_app' as const,
    connectionId: 'connection-1',
    modelId: 'model-1',
    providerEgressConsent: true,
    remember: false,
    revision: 1,
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
  };
  const startInput = {
    profile,
    windowId: '100',
    sessionId: 'session-w',
    taskId: 'task-1',
    turnId: 'turn-1',
    cancelEpoch: 0,
    ...(classifierRoute === undefined ? {} : { classifierRoute }),
  };
  beforeStart?.(host);
  const session = await host.startSession(startInput);
  return {
    profile,
    preflight,
    dispatch,

    winTicket,
    startSession,
    host,
    session,
    startInput,
  };
};

const facts = {
  platform: 'win32',
  imageRoot: 'windows_directory',
  imageRelativePath: 'explorer.exe',
  imageLeaf: 'explorer.exe',
  imageVolume: 'fixed',
  runningImageMatches: true,
  signature: 'valid',
  signerMicrosoftRoot: true,
  packaged: false,
  windowClass: 'CabinetWClass',
  shellView: { kind: 'filesystem_folder', path: 'C:\\Folder' },
} satisfies Partial<TargetFacts> & { shellView: { kind: string; path: string } };
const measuredItem = {
  path: 'C:\\Folder\\Child',
  kind: 'folder',
  surface: 'file_list',
  pidlDigest: 'a'.repeat(64),
};
const operation: WindowsExplorerOperation = {
  verb: 'open',
  point: { x: 400, y: 300 },
  item: { path: 'C:\\Folder\\Child', kind: 'folder', surface: 'file_list' },
};
const inputFor = (host: ComputerUseNativeHost, sessionId: string) => ({
  host,
  sessionId,
  approval: readWindowsExplorerApproval(host, sessionId),
  operation,
});

// Start/list/grant acceptance belongs to D. This fixture installs an already bound
// session and executes the real controller dispatch boundary over the real Host.
async function actionScenario(enabled: boolean, item: unknown = measuredItem) {
  const measure = vi.fn(() => ({ shellView: facts.shellView, pointOwnerMatches: true, item }));
  const observe = vi.fn<() => unknown>(() => ({}));
  const f = await explorerScenario({}, { measureExplorerView: measure, observe });
  const audits = new Map<string, ComputerActionAuditRecord>();
  const authorize = vi.fn(() => ({ decision: 'allow' as const, reason: 'fixture_approved' }));
  const controller = new ComputerUseController({
    native: f.host,
    windowsExplorerActionForTesting: enabled,
    repositionEmergencyStop: () => true,
    featureEnabled: () => true,
    authorize,
    persistence: {
      ...createComputerAppGrantFixtureStore().api,
      listComputerAppProfiles: () => [],
      getComputerAppProfile: () => f.profile,
      createComputerAppProfile: vi.fn(),
      updateComputerAppProfile: vi.fn(),
      removeComputerAppProfile: vi.fn(),
      recordComputerActionAudit: (input) => {
        const now = new Date().toISOString();
        const audit: ComputerActionAuditRecord = {
          ...input,
          id: `audit-${audits.size}`,
          state: input.state ?? 'pending',
          reasonCode: input.reasonCode ?? null,
          approvalId: input.approvalId ?? null,
          approvalParentRequestId: input.approvalParentRequestId ?? null,
          approvalOutcome: null,
          approvalEffect: input.approvalEffect ?? null,
          createdAt: now,
          updatedAt: now,
        };
        audits.set(audit.id, audit);
        return audit;
      },
      completeComputerActionAudit: (input) => {
        const previous = audits.get(input.auditId);
        if (!previous) throw new Error('Missing fixture audit');
        const audit = {
          ...previous,
          state: input.state,
          reasonCode: input.reasonCode ?? null,
          updatedAt: input.updatedAt,
        };
        audits.set(audit.id, audit);
        return audit;
      },
      recordComputerActionApprovalOutcome: vi.fn(),
      listComputerActionAudits: () => [...audits.values()],
      getActiveTurnId: () => 'turn-1',
      getPermissionPolicy: () => ({ policyEpoch: 0 }),
    },
  });
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 20_000).toISOString();
  const status = computerUseSessionStatusSchema.parse({
    sessionId: f.session.sessionId,
    taskId: 'task-1',
    profileId: f.profile.id,
    profileRevision: f.profile.revision,
    windowId: f.session.windowId,
    connectionId: 'connection-1',
    modelId: 'model-1',
    appIdentityDigest: f.session.appIdentityDigest,
    windowIdentityDigest: f.session.windowIdentityDigest,
    mode: 'supervised',
    maximumMode: 'supervised',
    state: 'acting',
    policyEpoch: 0,
    observationRevision: 1,
    round: 0,
    maxRounds: 5,
    startedAt: now,
    expiresAt,
    lastObservationAt: now,
    stopReason: null,
  });
  const observation = computerUseObservationSchema.parse({
    sessionId: f.session.sessionId,
    appIdentityDigest: f.session.appIdentityDigest,
    windowIdentityDigest: f.session.windowIdentityDigest,
    profileRevision: 1,
    maximumMode: 'supervised',
    screenBounds: f.session.screenBounds,
    revision: 1,
    observedAt: now,
    expiresAt,
    clientWidth: 1200,
    clientHeight: 900,
    images: [
      {
        mimeType: 'image/png',
        digest: digest('1'),
        byteLength: 1,
        width: 1,
        height: 1,
        base64: 'AA==',
      },
    ],
    treeDigest: null,
    treeByteLength: 0,
    treeDepth: 0,
    treeNodeCount: 0,
  });
  const record: Parameters<ComputerUseController['dispatchNativeAction']>[0] = {
    status,
    profile: f.profile,
    native: f.session,
    agent: null,
    classifierRoute: 'v2',
    approvalHelperGeneration: undefined,
    screenBounds: f.session.screenBounds,
    controller: new AbortController(),
    turnId: 'turn-1',
    syntheticTurn: false,
    observation,
    planGrant: null,
    plannerExecutionId: null,
    planner: null,
    expiryTimer: null,
    stopPromise: null,
    artifactGeneration: 0,
  };
  observe.mockImplementation(() => ({ ...observation, revision: 2 }));
  controller['sessions'].set(f.session.sessionId, record);
  controller['broker'].startTurn(
    { taskId: 'task-1', turnId: 'turn-1', workspaceId: null, policyEpoch: 0 },
    'computer-controller',
    [createToolId({ provider: 'builtin', namespace: 'computer', name: 'act', version: '1' })],
  );
  const run = (action: ComputerUseAction) =>
    controller['dispatchNativeAction'](record, action, 'action-1', 1, record.controller.signal);
  const runAgent = (action: ComputerUseAction) =>
    controller.act(f.session.sessionId, action, 'agent-action');
  return { ...f, measure, controller, record, run, runAgent, authorize };
}

const folderClick: ComputerUseAction = { type: 'click', x: 0.5, y: 0.5, button: 'left' };
it('explorer_folder_action_uses_measured_item', async () => {
  const f = await actionScenario(true);
  expect(await f.runAgent(folderClick)).toMatchObject({ result: 'completed', reasonCode: null });
  expect(f.measure).toHaveBeenCalledTimes(2);
  expect(f.measure).toHaveBeenLastCalledWith(
    expect.objectContaining({
      x: 0.5,
      y: 0.5,
      observationRevision: 1,
      sessionId: f.session.sessionId,
    }),
  );
  expect(f.preflight).toHaveBeenCalledOnce();
  expect(f.authorize).toHaveBeenCalledOnce();
  expect(f.measure.mock.invocationCallOrder[0]).toBeLessThan(
    f.authorize.mock.invocationCallOrder[0]!,
  );
  expect(f.authorize.mock.invocationCallOrder[0]).toBeLessThan(
    f.measure.mock.invocationCallOrder[1]!,
  );
  expect(f.dispatch).toHaveBeenCalledOnce();
  expect(f.measure.mock.invocationCallOrder[0]).toBeLessThan(
    f.preflight.mock.invocationCallOrder[0]!,
  );
  expect(f.preflight.mock.invocationCallOrder[0]).toBeLessThan(
    f.dispatch.mock.invocationCallOrder[0]!,
  );
  expect(f.dispatch.mock.calls[0]![0]).not.toHaveProperty('item');
  expect(f.dispatch.mock.calls[0]![0]).not.toHaveProperty('path');
});

it.each([false, true])('explorer_click_after_restart_resume_%s', async (resume) => {
  const f = await actionScenario(true);
  const previous = readWindowsExplorerApproval(f.host, f.session.sessionId)!;
  expect(
    await windowsExplorerExceptionAllowedForTesting(inputFor(f.host, f.session.sessionId)),
  ).toBe(true);
  f.measure.mockClear();
  f.dispatch.mockClear();
  if (resume) {
    f.record.native = await f.host.startSession({ ...f.startInput, resume: true });
  } else {
    await f.controller['refocusAndReobserve'](f.record, { focusedSession: null }, () => true, true);
    f.record.status = { ...f.record.status, observationRevision: f.record.observation!.revision };
  }
  expect(
    await windowsExplorerExceptionAllowedForTesting({
      ...inputFor(f.host, f.session.sessionId),
      approval: previous,
    }),
  ).toBe(false);
  expect(await f.runAgent(folderClick)).toMatchObject({ result: 'completed' });
  expect(f.measure).toHaveBeenCalledTimes(2);
  expect(f.dispatch).toHaveBeenCalledOnce();
  expect(f.startSession).toHaveBeenCalledTimes(2);
});

it('explorer_action_allowed_after_approval_reobservation_without_status_sync', async () => {
  const f = await actionScenario(true);
  const before = f.record.status.observationRevision;
  // The native approval path re-observes and keeps status.observationRevision unchanged.
  await f.controller['refocusAndReobserve'](f.record, { focusedSession: null }, () => true, true);
  expect(f.record.status.observationRevision).toBe(before);
  expect(f.record.observation!.revision).not.toBe(before);
  expect(
    await f.controller['explorerActionAllowed'](
      f.record,
      folderClick,
      f.record.observation!.revision,
    ),
  ).toBe(true);
  // A stale revision (the one the status still holds) is refused.
  expect(await f.controller['explorerActionAllowed'](f.record, folderClick, before)).toBe(false);
  // An observation that moved on after the re-observation refuses the re-observed revision.
  const reobserved = f.record.observation!.revision;
  f.record.observation = { ...f.record.observation!, revision: reobserved + 1 };
  expect(await f.controller['explorerActionAllowed'](f.record, folderClick, reobserved)).toBe(
    false,
  );
  // An expired observation is refused even at its own revision.
  f.record.observation = {
    ...f.record.observation!,
    revision: reobserved,
    expiresAt: new Date(0).toISOString(),
  };
  expect(await f.controller['explorerActionAllowed'](f.record, folderClick, reobserved)).toBe(
    false,
  );
});

it.each(['windowIdentityDigest', 'appIdentityDigest', 'pid', 'processStartTime'] as const)(
  'explorer_restart_rejects_changed_%s',
  async (field) => {
    const f = await actionScenario(true);
    const original = f.startSession.getMockImplementation()!;
    f.startSession.mockImplementation((input) => ({
      ...original(input),
      [field]: field === 'pid' ? 43 : field === 'processStartTime' ? '654321' : digest('e'),
    }));
    if (field === 'appIdentityDigest' || field === 'processStartTime') {
      await expect(f.host.startSession({ ...f.startInput, resume: true })).rejects.toThrow(
        'native_session_identity_mismatch',
      );
    } else {
      f.record.native = await f.host.startSession({ ...f.startInput, resume: true });
      expect(readWindowsExplorerApproval(f.host, f.session.sessionId)).toBeUndefined();
      expect(await f.run(folderClick)).toEqual({
        result: 'rejected',
        reasonCode: 'explorer_action_denied',
      });
    }
    expect(f.measure).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  },
);

it.each(['select', 'open'])('measured folder %s needs no model path', async (verb) => {
  const f = await explorerScenario();
  expect(
    await windowsExplorerExceptionAllowedForTesting({
      ...inputFor(f.host, f.session.sessionId),
      operation: { verb, point: { x: 400, y: 300 } },
    }),
  ).toBe(true);
});

it('explorer_scroll_and_document_open_emit_no_input', async () => {
  const refused: ComputerUseAction[] = [
    { type: 'scroll', x: 0.5, y: 0.5, deltaX: 0, deltaY: 1 },
    { type: 'key', key: 'Enter' },
    { type: 'type', text: 'C:\\Folder' },
    { type: 'invoke', targetId: 'node', name: 'activate', arguments: {} },
    { type: 'set_text', targetId: 'node', text: 'C:\\Folder' },
    { type: 'select', targetId: 'node', value: 'folder' },
    { type: 'toggle', targetId: 'node', value: true },
    { type: 'expand_collapse', targetId: 'node', expanded: true },
  ];
  for (const action of refused) {
    const f = await actionScenario(true);
    expect(await f.run(action)).toEqual({
      result: 'rejected',
      reasonCode: 'explorer_action_denied',
    });
    expect(f.measure).not.toHaveBeenCalled();
    expect(f.preflight).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
    await expect(f.runAgent(action)).rejects.toThrow();
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  }
  for (const item of [
    { ...measuredItem, kind: 'file', path: 'C:\\Folder\\document.txt' },
    { ...measuredItem, path: 'C:\\Folder\\program.exe' },
    { ...measuredItem, surface: 'address_bar' },
    { ...measuredItem, surface: 'search_box' },
    { kind: 'unknown' },
    undefined,
  ]) {
    const f = await actionScenario(true, item === undefined ? null : item);
    expect(await f.run(folderClick)).toEqual({
      result: 'rejected',
      reasonCode: 'explorer_action_denied',
    });
    expect(f.measure).toHaveBeenCalledOnce();
    expect(f.preflight).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
    await expect(f.runAgent(folderClick)).rejects.toThrow();
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  }
});

it('explorer_action_gate_off_preserves_zero_native_calls', async () => {
  const f = await actionScenario(false);
  expect(await f.run(folderClick)).toEqual({
    result: 'rejected',
    reasonCode: 'explorer_action_denied',
  });
  expect(f.measure).not.toHaveBeenCalled();
  expect(f.preflight).not.toHaveBeenCalled();
  expect(f.dispatch).not.toHaveBeenCalled();
  await expect(f.runAgent(folderClick)).rejects.toThrow();
  expect(f.authorize).not.toHaveBeenCalled();
  expect(f.measure).not.toHaveBeenCalled();
  expect(f.preflight).not.toHaveBeenCalled();
  expect(f.dispatch).not.toHaveBeenCalled();
});

it('ordinary click keeps its output and native calls with the Explorer gate off', async () => {
  const f = await actionScenario(false);
  f.record.profile = {
    ...f.profile,
    identity: { ...f.profile.identity, executablePath: 'C:\\Apps\\Editor.exe' },
  };
  expect(await f.runAgent(folderClick)).toMatchObject({ result: 'completed', reasonCode: null });
  expect(f.authorize).toHaveBeenCalledOnce();
  expect(f.measure).not.toHaveBeenCalled();
  expect(f.preflight).toHaveBeenCalledOnce();
  expect(f.dispatch).toHaveBeenCalledOnce();
});

it('Explorer measurement cannot outlive Stop or its observation', async () => {
  for (const change of ['stop', 'observation'] as const) {
    const f = await actionScenario(true);
    f.measure.mockImplementationOnce(() => {
      if (change === 'stop') f.record.controller.abort();
      else f.record.status = { ...f.record.status, observationRevision: 2 };
      return { shellView: facts.shellView, pointOwnerMatches: true, item: measuredItem };
    });
    expect(await f.run(folderClick)).toMatchObject({ result: 'rejected' });
    expect(f.preflight).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  }
});
const withFacts = (measured: Record<string, unknown>) =>
  explorerScenario({}, {}, {}, 'v2', 'win32', undefined, measured);
it('explorer_item_is_measured_at_action_point', async () => {
  const measureExplorerView = vi.fn(() => ({
    shellView: facts.shellView,
    pointOwnerMatches: true,
    item: { ...measuredItem, path: 'c:\\folder\\child' },
  }));
  const { host, session } = await explorerScenario({}, { measureExplorerView });
  const input = inputFor(host, session.sessionId);
  expect(await windowsExplorerExceptionAllowedForTesting(input)).toBe(true);
  expect(measureExplorerView).toHaveBeenLastCalledWith(expect.objectContaining(operation.point!));
  expect(
    await windowsExplorerExceptionAllowedForTesting({
      ...input,
      operation: { ...operation, item: { ...measuredItem, path: 'C:\\Folder\\Other' } },
    }),
  ).toBe(false);
});
it.each([
  undefined,
  { kind: 'unknown' },
  { ...measuredItem, kind: 'file' },
  { ...measuredItem, path: 'C:\\Folder\\shortcut.lnk' },
  { ...measuredItem, path: 'shell:AppsFolder' },
  { ...measuredItem, path: 'C:\\Folder\\nested\\Child' },
  { ...measuredItem, pidlDigest: '' },
  { ...measuredItem, surface: 'address_bar' },
])('never uses the model path as a measured item (%j)', async (item) => {
  const { host, session } = await explorerScenario(
    {},
    {
      measureExplorerView: () => ({ shellView: facts.shellView, pointOwnerMatches: true, item }),
    },
  );
  expect(await windowsExplorerExceptionAllowedForTesting(inputFor(host, session.sessionId))).toBe(
    false,
  );
});
it.each(['C:\\Folder\\shortcut.lnk', 'shell:AppsFolder', 'C:\\Folder\\nested\\Child'])(
  'rejects measured classification/containment even with matching model path (%s)',
  async (path) => {
    const item = { ...measuredItem, path };
    const measureExplorerView = vi.fn(() => ({
      shellView: facts.shellView,
      pointOwnerMatches: true,
      item,
    }));
    const { host, session } = await explorerScenario(
      {},
      {
        measureExplorerView,
      },
    );
    expect(
      await windowsExplorerExceptionAllowedForTesting({
        ...inputFor(host, session.sessionId),
        operation: { ...operation, item },
      }),
    ).toBe(false);
    expect(measureExplorerView).toHaveBeenCalledOnce();
  },
);
it('remeasures the item on every use and refuses a replacement path', async () => {
  let item = measuredItem;
  const { host, session } = await explorerScenario(
    {},
    {
      measureExplorerView: () => ({ shellView: facts.shellView, pointOwnerMatches: true, item }),
    },
  );
  const input = inputFor(host, session.sessionId);
  expect(await windowsExplorerExceptionAllowedForTesting(input)).toBe(true);
  item = { ...measuredItem, path: 'C:\\Folder\\Replacement', pidlDigest: 'b'.repeat(64) };
  expect(await windowsExplorerExceptionAllowedForTesting(input)).toBe(false);
});
it('explorer_exception_requires_verified_v2_approval', async () => {
  const { host, session } = await explorerScenario();
  const input = inputFor(host, session.sessionId);
  expect(input.approval).toBeDefined();
  expect(await windowsExplorerExceptionAllowed(input)).toBe(false);
  expect(await windowsExplorerExceptionAllowedForTesting(input)).toBe(true);
  expect(await windowsExplorerExceptionAllowedForTesting({ ...input, approval: undefined })).toBe(
    false,
  );
  expect(await windowsExplorerExceptionAllowedForTesting({ ...input, sessionId: 'other' })).toBe(
    false,
  );
  expect(await windowsExplorerExceptionAllowedForTesting({ ...input, host: { ...host } })).toBe(
    false,
  );
  for (const key of Object.keys(facts)) {
    const scenario = await withFacts({ ...facts, [key]: null });
    expect(
      await windowsExplorerExceptionAllowedForTesting(
        inputFor(scenario.host, scenario.session.sessionId),
      ),
      key,
    ).toBe(false);
  }
  for (const changed of [
    { imageRelativePath: 'system32/explorer.exe' },
    { imageRoot: 'temp' },
    { imageVolume: 'removable' },
    { runningImageMatches: false },
    { signature: 'unsigned' },
    { signerMicrosoftRoot: false },
    { packaged: true },
    { platform: 'darwin' },
  ]) {
    const scenario = await withFacts({ ...facts, ...changed });
    expect(
      await windowsExplorerExceptionAllowedForTesting(
        inputFor(scenario.host, scenario.session.sessionId),
      ),
    ).toBe(false);
  }
});
it('explorer_non_file_window_stays_denied', async () => {
  for (const windowClass of [
    'Progman',
    'WorkerW',
    'Shell_TrayWnd',
    'Windows.UI.Core.CoreWindow',
    '',
    null,
  ]) {
    const { host, session } = await withFacts({ ...facts, windowClass });
    expect(await windowsExplorerExceptionAllowedForTesting(inputFor(host, session.sessionId))).toBe(
      false,
    );
  }
  for (const shellView of [
    undefined,
    { kind: 'namespace', path: '::{00000000-0000-0000-0000-000000000000}' },
    { kind: 'filesystem_folder', path: 'shell:AppsFolder' },
    { kind: 'filesystem_folder', path: '::{00000000-0000-0000-0000-000000000000}' },
  ]) {
    const { host, session } = await withFacts({ ...facts, shellView });
    expect(await windowsExplorerExceptionAllowedForTesting(inputFor(host, session.sessionId))).toBe(
      false,
    );
  }
});
it('explorer_executable_open_stays_blocked', async () => {
  const { host, session } = await explorerScenario();
  const input = inputFor(host, session.sessionId);
  for (const extension of [
    'exe',
    'msi',
    'bat',
    'cmd',
    'ps1',
    'vbs',
    'js',
    'wsf',
    'lnk',
    'url',
    'scf',
    'cpl',
    'msc',
    'appref-ms',
    'com',
    'pif',
    'scr',
    'ExE',
    'MsI',
    '',
  ]) {
    for (const kind of ['file', 'folder']) {
      const operation = {
        verb: 'open',
        item: {
          path: 'C:\\Folder\\item' + (extension ? '.' + extension : ''),
          kind,
          surface: 'file_list',
        },
        effect: 'ordinary',
      };
      // A measured folder without an extension is ordinary; a file without one is unknown.
      if (!extension && kind === 'folder') continue;
      expect(
        await windowsExplorerExceptionAllowedForTesting({ ...input, operation }),
        extension,
      ).toBe(false);
    }
  }
  for (const surface of ['address_bar', 'search_box']) {
    const operation = { verb: 'type', item: { path: 'C:\\Folder', kind: 'folder', surface } };
    expect(classifyWindowsExplorerOperation(operation)).toBe('command_surface');
    expect(await windowsExplorerExceptionAllowedForTesting({ ...input, operation })).toBe(false);
  }
  for (const operation of [
    { verb: 'open' },
    { verb: 'unknown', item: input.operation.item! },
    { verb: 'open', item: { path: 'shell:AppsFolder', kind: 'folder', surface: 'file_list' } },
  ])
    expect(await windowsExplorerExceptionAllowedForTesting({ ...input, operation })).toBe(false);
  // A real directory named as a shell junction opens as that namespace, not as a folder.
  for (const path of [
    'C:\\Folder\\x.{21EC2020-3AEA-1069-A2DD-08002B30309D}',
    'C:\\Folder\\x.{21ec2020-3aea-1069-a2dd-08002b30309d}\\inner',
  ]) {
    const operation = { verb: 'open', item: { path, kind: 'folder', surface: 'file_list' } };
    expect(classifyWindowsExplorerOperation(operation), path).toBe('unknown');
    expect(await windowsExplorerExceptionAllowedForTesting({ ...input, operation })).toBe(false);
  }
});
it.each([
  'hta',
  'jse',
  'vbe',
  'wsh',
  'ws',
  'reg',
  'msp',
  'mst',
  'application',
  'appinstaller',
  'msix',
  'appx',
  'diagcab',
  'settingcontent-ms',
  'library-ms',
  'search-ms',
  'searchconnector-ms',
  'chm',
  'inf',
  'jar',
  'xbap',
  'website',
  'unknown',
  '',
])('does not classify .%s as a document', (extension) => {
  const effect = classifyWindowsExplorerOperation({
    verb: 'open',
    item: {
      path: 'C:\\Folder\\item' + (extension ? '.' + extension : ''),
      kind: 'file',
      surface: 'file_list',
    },
  });
  expect(['unknown', 'executable_open']).toContain(effect);
});
it.each([
  'txt',
  'md',
  'log',
  'csv',
  'json',
  'xml',
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'bmp',
  'webp',
  'docx',
  'xlsx',
  'pptx',
  'rtf',
  'TXT',
])('classifies allowed documents .%s but keeps them blocked', async (extension) => {
  const { host, session } = await explorerScenario();
  const operation = {
    verb: 'open',
    item: { path: 'C:\\Folder\\item.' + extension, kind: 'file', surface: 'file_list' },
  };
  expect(classifyWindowsExplorerOperation(operation)).toBe('document_open');
  expect(
    await windowsExplorerExceptionAllowedForTesting({
      ...inputFor(host, session.sessionId),
      operation,
    }),
  ).toBe(false);
});
it('rejects caller Explorer facts for a session bound to Target.exe', async () => {
  const { host, session } = await withFacts({
    ...facts,
    imageRoot: 'other',
    imageRelativePath: 'Target.exe',
    imageLeaf: 'Target.exe',
  });
  const input = { ...inputFor(host, session.sessionId), facts, effect: 'ordinary' };
  expect(await windowsExplorerExceptionAllowedForTesting(input)).toBe(false);
});
it('rejects document_open until P5', async () => {
  const { host, session } = await explorerScenario();
  const operation = {
    verb: 'open',
    item: { path: 'C:\\Folder\\document.txt', kind: 'file', surface: 'file_list' },
  };
  expect(classifyWindowsExplorerOperation(operation)).toBe('document_open');
  expect(
    await windowsExplorerExceptionAllowedForTesting({
      ...inputFor(host, session.sessionId),
      operation,
    }),
  ).toBe(false);
});
it('requires every Host approval gate and rechecks issued capabilities', async () => {
  for (const overrides of [
    { classifierV2Attested: false },
    { windowsApprovalInterlockForTesting: false },
    { effectiveEligibilityMode: () => 'v1-allowlist' as const },
  ]) {
    const { host, session } = await explorerScenario(overrides);
    expect(readWindowsExplorerApproval(host, session.sessionId)).toBeUndefined();
  }
  for (const name of [
    'approvalApprove',
    'approvalDiscard',
    'dispatchApproved',
    'preflight',
    'windowsApprovalAvailable',
    'windowsApprovalReady',
  ]) {
    const { host, session } = await explorerScenario({}, { [name]: undefined });
    expect(readWindowsExplorerApproval(host, session.sessionId), name).toBeUndefined();
  }
  const unverified = await explorerScenario({}, {}, { windowsApprovalVerified: false });
  expect(
    readWindowsExplorerApproval(unverified.host, unverified.session.sessionId),
  ).toBeUndefined();
  for (const platform of ['win32', 'darwin'] as const)
    for (const route of ['v1', 'v2'] as const) {
      if (platform === 'win32' && route === 'v2') continue;
      const { host, session } = await explorerScenario({}, {}, {}, route, platform);
      expect(readWindowsExplorerApproval(host, session.sessionId)).toBeUndefined();
    }
  let ready = true;
  const { host, session } = await explorerScenario({}, { windowsApprovalReady: () => ready });
  const approval = readWindowsExplorerApproval(host, session.sessionId);
  expect(approval).toBeDefined();
  expect(readWindowsExplorerApproval(host, 'missing')).toBeUndefined();
  ready = false;
  expect(
    await windowsExplorerExceptionAllowedForTesting({
      host,
      sessionId: session.sessionId,
      approval,
      operation,
    }),
  ).toBe(false);
});

it('refuses absent package, handshake, and probe evidence before a session exists', async () => {
  const base = binding({ probe: () => ({}) }, {}, 'win32');
  for (const changed of [
    { artifactPath: null },
    { manifest: { ...base.manifest, apiVersion: 1 } },
    { probe: { ...base.probe, available: false } },
    { probe: { ...base.probe, capabilities: { observe: false, control: false } } },
  ]) {
    let captured: ComputerUseNativeHost | undefined;
    await expect(
      explorerScenario({}, {}, changed, 'v2', 'win32', (host) => {
        captured = host;
        expect(readWindowsExplorerApproval(host, 'session-w')).toBeUndefined();
      }),
    ).rejects.toThrow();
    expect(captured).toBeDefined();
    expect(readWindowsExplorerApproval(captured!, 'session-w')).toBeUndefined();
  }
});

it('revokes retained Explorer evidence when a Stop enters quarantine', async () => {
  const { host, session } = await explorerScenario();
  const approval = readWindowsExplorerApproval(host, session.sessionId);
  expect(approval).toBeDefined();
  // The fixture has no close receipt: the existing Host must retain its Stop quarantine.
  await expect(host.close(session)).rejects.toThrow();
  expect(readWindowsExplorerApproval(host, session.sessionId)).toBeUndefined();
  expect(
    await windowsExplorerExceptionAllowedForTesting({
      host,
      sessionId: session.sessionId,
      approval,
      operation,
    }),
  ).toBe(false);
});

it('rejects the old cancel epoch after ledger receipt completion without replacing the session', async () => {
  let ledger!: WindowsCloseCallbacks;
  let forgetCompletedStart!: (sessionId: string) => boolean;
  const scenario = await explorerScenario(
    {
      windowsCompletedStartForTesting: (forget) => {
        forgetCompletedStart = forget;
      },
      windowsLedger: {
        write: () => true,
        update: () => true,
        delete: () => true,
        restoreQuarantines: () => true,
      },
    },
    {
      configureCloseLedger: (callbacks: WindowsCloseCallbacks) => {
        ledger = callbacks;
      },
      cancel: (input: { sessionId: string; cancelEpoch: number }) => ({
        result: 'canceled',
        drained: true,
        ...input,
        inputAttemptCount: 0,
      }),
    },
  );
  const old = inputFor(scenario.host, scenario.session.sessionId);
  expect(await windowsExplorerExceptionAllowedForTesting(old)).toBe(true);
  expect(forgetCompletedStart(scenario.session.sessionId)).toBe(true);
  await scenario.host.cancel(scenario.session, 1);
  expect(await windowsExplorerExceptionAllowedForTesting(old)).toBe(false);
  expect(readWindowsExplorerApproval(scenario.host, scenario.session.sessionId)).toBeUndefined();
  ledger.received(1, scenario.session.sessionId);
  const completed = vi.fn();
  await expect(ledger.verified(1, scenario.session.sessionId, completed)).resolves.toEqual({
    status: 'confirmed',
  });
  expect(completed).toHaveBeenCalledTimes(1);
  expect(ledger.blocked(1)).toBe(false);
  const fresh = inputFor(scenario.host, scenario.session.sessionId);
  expect(fresh.approval).toBeDefined();
  expect(await windowsExplorerExceptionAllowedForTesting(fresh)).toBe(true);
  expect(await windowsExplorerExceptionAllowedForTesting(old)).toBe(false);
  expect(scenario.startSession).toHaveBeenCalledTimes(1);
});
it.each([false, true])(
  'explorer_operation_capability_cannot_be_reused_after_reopen (cancel=%s)',
  async (cancelFirst) => {
    const scenario = await explorerScenario(
      {},
      {
        cancel: (input: { sessionId: string; cancelEpoch: number }) => ({
          result: 'canceled',
          drained: true,
          sessionId: input.sessionId,
          cancelEpoch: input.cancelEpoch,
          inputAttemptCount: 0,
        }),
        close: (input: { sessionId: string; cancelEpoch: number }) => ({
          result: 'closed',
          drained: true,
          sessionId: input.sessionId,
          cancelEpoch: input.cancelEpoch,
          inputAttemptCount: 0,
        }),
      },
    );
    const old = inputFor(scenario.host, scenario.session.sessionId);
    expect(await windowsExplorerExceptionAllowedForTesting(old)).toBe(true);
    if (cancelFirst) {
      await scenario.host.cancel(scenario.session, 1);
      expect(await windowsExplorerExceptionAllowedForTesting(old)).toBe(false);
    }
    await scenario.host.close(scenario.session);
    expect(await windowsExplorerExceptionAllowedForTesting(old)).toBe(false);
    await expect(scenario.host.startSession(scenario.startInput)).rejects.toThrow(
      'native_session_closed',
    );
    // The Host intentionally forgets closed ids after 128 entries. Exercise real id reuse.
    for (let index = 0; index < 129; index++) {
      const temporary = await scenario.host.startSession({
        ...scenario.startInput,
        sessionId: `replacement-${index}`,
      });
      await scenario.host.close(temporary);
    }
    await scenario.host.startSession(scenario.startInput);
    expect(
      await windowsExplorerExceptionAllowedForTesting(
        inputFor(scenario.host, scenario.session.sessionId),
      ),
    ).toBe(true);
    expect(await windowsExplorerExceptionAllowedForTesting(old)).toBe(false);
  },
);
it.each(['background_event', 'failed'] as const)(
  'revokes retained capability on %s',
  async (kind) => {
    let listener: WindowsInteractionListener | undefined;
    const { host, session } = await explorerScenario(
      {},
      {
        subscribeWindowsInteraction: (callback: WindowsInteractionListener) => {
          listener = callback;
          return () => {};
        },
      },
    );
    const input = inputFor(host, session.sessionId);
    expect(await windowsExplorerExceptionAllowedForTesting(input)).toBe(true);
    const common = {
      version: 1 as const,
      sessionId: session.sessionId,
      taskId: 'task-1',
      turnId: 'turn-1',
      helperGeneration: 1,
      cancelEpoch: 0,
      interactionEpoch: 1,
      sequence: 1,
    };
    if (kind === 'background_event') listener!({ ...common, kind, state: 'paused' });
    else
      listener!({
        ...common,
        kind: 'event',
        roundTripId: 'trip-1',
        state: 'failed',
        foreground: 'other',
        failureReason: 'stopped',
        failureLatched: true,
      });
    expect(await windowsExplorerExceptionAllowedForTesting(input)).toBe(false);
    expect(readWindowsExplorerApproval(host, session.sessionId)).toBeUndefined();
  },
);
it('keeps identity immutable but remeasures the view on every use', async () => {
  const measured = { ...facts, shellView: { ...facts.shellView } };
  const { host, session } = await withFacts(measured);
  const input = inputFor(host, session.sessionId);
  measured.imageLeaf = 'Target.exe';
  expect(await windowsExplorerExceptionAllowedForTesting(input)).toBe(true);
  measured.shellView.kind = 'namespace';
  expect(await windowsExplorerExceptionAllowedForTesting(input)).toBe(false);
  measured.shellView.kind = 'filesystem_folder';
  measured.shellView.path = 'shell:AppsFolder';
  expect(await windowsExplorerExceptionAllowedForTesting(input)).toBe(false);
});

it('rejects an item outside the current Explorer folder', async () => {
  const { host, session } = await explorerScenario();
  expect(
    await windowsExplorerExceptionAllowedForTesting({
      ...inputFor(host, session.sessionId),
      operation: {
        ...operation,
        item: { path: 'C:\\Outside', kind: 'folder', surface: 'file_list' },
      },
    }),
  ).toBe(false);
});

it('requires the input point owner and never measures through the production gate', async () => {
  const measureExplorerView = vi.fn(() => ({
    shellView: facts.shellView,
    pointOwnerMatches: false,
  }));
  const { host, session } = await explorerScenario({}, { measureExplorerView });
  const input = inputFor(host, session.sessionId);
  expect(await windowsExplorerExceptionAllowed(input)).toBe(false);
  expect(measureExplorerView).not.toHaveBeenCalled();
  expect(await windowsExplorerExceptionAllowedForTesting(input)).toBe(false);
  expect(measureExplorerView).toHaveBeenCalledTimes(1);
  expect(measureExplorerView).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: session.sessionId,
      windowId: '100',
      cancelEpoch: 0,
      x: 400,
      y: 300,
    }),
  );
});

it('rejects measurement failure and evidence revoked while measurement is pending', async () => {
  const measureExplorerView = vi
    .fn<() => Promise<unknown>>()
    .mockRejectedValue(new Error('unreadable'));
  const { host, session } = await explorerScenario({}, { measureExplorerView });
  const input = inputFor(host, session.sessionId);
  expect(await windowsExplorerExceptionAllowedForTesting(input)).toBe(false);
  measureExplorerView.mockImplementation(async () => {
    await host.close(session);
    return { shellView: facts.shellView, pointOwnerMatches: true, item: measuredItem };
  });
  expect(await windowsExplorerExceptionAllowedForTesting(input)).toBe(false);
});

it('accepts only a direct child of the measured folder, compared by ASCII case', async () => {
  expect(windowsExplorerItemInView('C:\\Folder\\Child', 'C:\\Folder')).toBe(true);
  expect(windowsExplorerItemInView('c:\\FOLDER\\Child', 'C:\\folder')).toBe(true);
  expect(windowsExplorerItemInView('C:\\Folder\\Child', 'C:\\Folder\\')).toBe(true);
  expect(windowsExplorerItemInView('C:\\Child', 'C:\\')).toBe(true);
  for (const path of [
    // Deeper descendants are not what the measured file list shows.
    'C:\\Folder\\Child\\Grandchild',
    'C:\\Folder',
    'C:\\Folder\\',
    'C:\\Folder\\Child\\',
    'C:\\Folder\\\\Child',
    'C:\\Folder/Child',
    'C:\\Folder\\.',
    'C:\\Folder\\..',
    'C:\\Folder\\Child.',
    'C:\\Folder\\Child ',
    'C:\\Folder\\..\\Folder\\Child',
    // ':' in the name addresses an alternate data stream.
    'C:\\Folder\\Child:stream',
    'C:\\Folder\\Child::$DATA',
    'D:\\Folder\\Child',
    '\\\\server\\share\\Child',
    'C:\\Folderx\\Child',
  ])
    expect(windowsExplorerItemInView(path, 'C:\\Folder'), path).toBe(false);
  // Unicode case folding is not NTFS's: a non-ASCII case difference is refused, never matched.
  expect(windowsExplorerItemInView('C:\\\u00c4rger\\Child', 'C:\\\u00c4rger')).toBe(true);
  expect(windowsExplorerItemInView('C:\\\u00e4rger\\Child', 'C:\\\u00c4rger')).toBe(false);
  expect(windowsExplorerItemInView('C:\\\u212aey\\Child', 'C:\\key')).toBe(false);
  expect(windowsExplorerItemInView('C:\\Key\\Child', 'C:\\\u212aey')).toBe(false);
  expect(windowsExplorerItemInView('C:\\\u0130d\\Child', 'C:\\id')).toBe(false);
  const { host, session } = await explorerScenario();
  for (const path of ['C:\\Folder\\Child\\Grandchild', 'C:\\Folder\\Child:stream']) {
    expect(
      await windowsExplorerExceptionAllowedForTesting({
        ...inputFor(host, session.sessionId),
        operation: { ...operation, item: { path, kind: 'folder', surface: 'file_list' } },
      }),
      path,
    ).toBe(false);
  }
});
