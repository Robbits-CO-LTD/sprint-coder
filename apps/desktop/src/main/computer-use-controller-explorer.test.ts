import { expect, it, vi } from 'vitest';
import type { ComputerUseNativeBinding } from './computer-use-native';
import type { ComputerUseNativeHost } from './computer-use-controller';
import {
  createComputerUseNativeHost,
  readWindowsExplorerApproval,
  type ComputerUseNativeHostOptions,
} from './computer-use-native-host';
import {
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
      classifierVersion: 1,
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
    measureExplorerView: () => ({ shellView: measuredFacts.shellView, pointOwnerMatches: true }),
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
const withFacts = (measured: Record<string, unknown>) =>
  explorerScenario({}, {}, {}, 'v2', 'win32', undefined, measured);
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
  'rejects old capability after quarantine release and id reuse (cancel=%s)',
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
    return { shellView: facts.shellView, pointOwnerMatches: true };
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
