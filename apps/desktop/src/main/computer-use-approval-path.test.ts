import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ComputerUseEligibility, ComputerUseEligibilityMode } from '@sprint-coder/contracts';
import type { ComputerUseNativeBinding } from './computer-use-native';
import type { ComputerAppProfileRecord } from './persistence';
import {
  COMPUTER_USE_APPROVAL_CLASSIFIER_VERSION,
  COMPUTER_USE_FORCE_V1_ALLOWLIST_ENV,
  computerUseApprovalPathEnabled,
  computerUseClassifierV2Attested,
  computerUseClassifierRoute,
  type ComputerUseApprovalRoute,
} from './computer-use-eligibility';
import { createComputerUseEligibilityWiring } from './computer-use-eligibility-wiring';
import { splitHighImpact } from './computer-use-controller';
import {
  NATIVE_APPROVAL_CLASSIFIER_VERSION,
  createComputerUseNativeHost,
} from './computer-use-native-host';

// C5-1: the "native approval path is open" predicate (version, attest, mode and route together), the
// production wiring of the effective mode and the attest, and the split of the high-impact flag.
// While every version is 1 the production wiring attests classifier 1, so no session is bound to
// route v2 for the native and nothing opens; C5-2 raises the versions.

const eligibility = (
  mode: ComputerUseEligibilityMode,
  classifierVersion: number,
): ComputerUseEligibility =>
  ({
    mode,
    rulesetVersion: 1,
    classifierVersion,
    lexiconVersion: 1,
    ticketRequired: true,
  }) as ComputerUseEligibility;

describe('the approval path predicate (C5-1)', () => {
  it('opens for exactly one combination: macOS, exported, attested 2, a session bound to v2 under the v2 deny-list', () => {
    const platforms = ['darwin', 'win32', 'linux'];
    const versions = [0, 1, 2, 3];
    const modes: ComputerUseEligibilityMode[] = ['v1-allowlist', 'v2-denylist'];
    const routes: ComputerUseApprovalRoute[] = ['v1', 'v2', 'unbound'];
    let open = 0;
    for (const platform of platforms)
      for (const methodsExported of [true, false])
        for (const attestedClassifierVersion of versions)
          for (const effectiveMode of modes)
            for (const route of routes) {
              const expected =
                platform === 'darwin' &&
                methodsExported &&
                attestedClassifierVersion === 2 &&
                route === 'v2' &&
                effectiveMode === 'v2-denylist';
              const actual = computerUseApprovalPathEnabled({
                platform,
                methodsExported,
                attestedClassifierVersion,
                effectiveMode,
                route,
              });
              expect(
                actual,
                `${platform} ${methodsExported} ${attestedClassifierVersion} ${effectiveMode} ${route}`,
              ).toBe(expected);
              if (actual) open += 1;
            }
    // Only darwin, exported, attested 2, route v2 under the deny-list. A session with no binding
    // (unbound) never opens, whatever else is true.
    expect(open).toBe(1);
    expect(COMPUTER_USE_APPROVAL_CLASSIFIER_VERSION).toBe(NATIVE_APPROVAL_CLASSIFIER_VERSION);
  });

  it('never opens for a session on route v1, whatever the build attests', () => {
    for (const effectiveMode of ['v1-allowlist', 'v2-denylist'] as const)
      expect(
        computerUseApprovalPathEnabled({
          platform: 'darwin',
          methodsExported: true,
          attestedClassifierVersion: 2,
          effectiveMode,
          route: 'v1',
        }),
      ).toBe(false);
  });

  it('attests classifier 2 only for a gate-open v2 build compiled for classifier 2', () => {
    const cases: Array<[ComputerUseEligibility | null, boolean, boolean]> = [
      [null, true, false],
      [eligibility('v1-allowlist', 1), true, false],
      [eligibility('v1-allowlist', 2), true, false],
      [eligibility('v2-denylist', 1), true, false],
      [eligibility('v2-denylist', 2), true, true],
      [eligibility('v2-denylist', 2), false, false],
      [eligibility('v2-denylist', 3), true, false],
    ];
    for (const [compiled, gateOpen, expected] of cases)
      expect(
        computerUseClassifierV2Attested({ compiled, gateOpen }),
        `${JSON.stringify(compiled)} ${gateOpen}`,
      ).toBe(expected);
  });
});

describe('the production wiring while every version is 1 (C5-1)', () => {
  const wiringFor = (
    compiled: ComputerUseEligibility | null,
    agentDrivenV2: boolean,
    environment: Record<string, string | undefined> = {},
  ) =>
    createComputerUseEligibilityWiring({
      compiled: () => compiled,
      agentDrivenV2: () => agentDrivenV2,
      environment: () => environment,
    });

  it('derives the effective mode from the compiled mode, the flag and the force-v1 variable', () => {
    expect(wiringFor(null, true).effectiveEligibilityMode()).toBe('v1-allowlist');
    expect(wiringFor(eligibility('v1-allowlist', 1), true).effectiveEligibilityMode()).toBe(
      'v1-allowlist',
    );
    expect(wiringFor(eligibility('v2-denylist', 1), false).effectiveEligibilityMode()).toBe(
      'v1-allowlist',
    );
    expect(wiringFor(eligibility('v2-denylist', 1), true).effectiveEligibilityMode()).toBe(
      'v2-denylist',
    );
    expect(
      wiringFor(eligibility('v2-denylist', 1), true, {
        [COMPUTER_USE_FORCE_V1_ALLOWLIST_ENV]: '1',
      }).effectiveEligibilityMode(),
    ).toBe('v1-allowlist');
  });

  // The production gate: with versions at 1, no build attests classifier 2.
  const buildsAtVersionOne: Array<[string, ComputerUseEligibility | null]> = [
    ['no compiled eligibility', null],
    ['v1 allow-list', eligibility('v1-allowlist', 1)],
    ['v2 deny-list at classifier 1', eligibility('v2-denylist', 1)],
  ];

  it.each(buildsAtVersionOne)(
    '%s: not attested, route v2 never reaches the native, no approval opens',
    async (_name, compiled) => {
      for (const agentDrivenV2 of [true, false])
        for (const environment of [{}, { [COMPUTER_USE_FORCE_V1_ALLOWLIST_ENV]: '1' }]) {
          const wiring = wiringFor(compiled, agentDrivenV2, environment);
          expect(wiring.classifierV2Attested(true)).toBe(false);
          expect(wiring.classifierV2Attested(false)).toBe(false);
          // The controller asks for v2 only under the v2 deny-list (an agent session)...
          const asked = computerUseClassifierRoute({
            agent: true,
            effectiveMode: wiring.effectiveEligibilityMode(),
          });
          // ...and the host, given the attest, hands the native v1 whatever was asked.
          const built = buildHost(
            wiring.classifierV2Attested(true),
            wiring.effectiveEligibilityMode,
          );
          const session = await startSession(built.host, asked);
          expect(built.sent()['classifierRoute']).toBe('v1');
          expect(built.host.nativeApprovalPathEnabled?.(session.sessionId)).toBe(false);
          expect(built.host.nativeApprovalPathEnabled?.('no-such-session')).toBe(false);
        }
    },
  );

  it('a build compiled for classifier 2 attests it, binds v2 and opens the path only for that session', async () => {
    const wiring = wiringFor(eligibility('v2-denylist', 2), true);
    expect(wiring.classifierV2Attested(true)).toBe(true);
    const built = buildHost(true, wiring.effectiveEligibilityMode);
    const agent = await startSession(built.host, 'v2', 'session-agent');
    const panel = await startSession(built.host, 'v1', 'session-panel');
    expect(built.sent('session-agent')['classifierRoute']).toBe('v2');
    expect(built.host.nativeApprovalPathEnabled?.(agent.sessionId)).toBe(true);
    // The panel session is bound to v1: the attest does not open an approval for it.
    expect(built.host.nativeApprovalPathEnabled?.(panel.sessionId)).toBe(false);
    // A session the host has no binding for is closed (fail closed), and so is one whose binding a
    // verified close dropped, however much the build attests.
    expect(built.host.nativeApprovalPathEnabled?.('no-such-session')).toBe(false);
    await built.host.close(agent);
    expect(built.host.nativeApprovalPathEnabled?.(agent.sessionId)).toBe(false);
    // The V2 flag turned off afterwards closes the mode.
    const lowered = buildHost(true, () => 'v1-allowlist');
    const loweredAgent = await startSession(lowered.host, 'v2', 'session-agent');
    expect(lowered.host.nativeApprovalPathEnabled?.(loweredAgent.sessionId)).toBe(false);
  });
});

describe('a session the host has no binding for gets no approval (C5-1, fail closed)', () => {
  it('refuses approvalApprove and dispatchApproved for a session started without a route', async () => {
    const built = buildHost(true, () => 'v2-denylist');
    await built.host.listWindows(profile);
    const unbound = await built.host.startSession({
      profile,
      windowId: 'window-1',
      sessionId: 'session-unbound',
      taskId: 'task-1',
      turnId: 'turn-1',
      cancelEpoch: 0,
    });
    expect(built.sent('session-unbound')).not.toHaveProperty('classifierRoute');
    expect(built.host.nativeApprovalPathEnabled?.(unbound.sessionId)).toBe(false);
    const input = {
      session: unbound,
      requestId: 'request-1',
      action: { type: 'click', x: 0.5, y: 0.5, button: 'left' } as const,
      observationRevision: 1,
      cancelEpoch: 0,
      signal: new AbortController().signal,
      approvalGeneration: 1,
    };
    await expect(built.host.approvalApprove!(input)).resolves.toMatchObject({
      kind: 'refused',
      reasonCode: 'native_approval_route_forbidden',
    });
    await expect(built.host.dispatchApproved!(input)).rejects.toThrow('native_approval_closed');
  });
});

// The tripwire: the versions the repository declares today. While they are 1, no build attests
// classifier 2, no session is bound to route v2 for the native, and no approval path opens, for
// every mode the table can describe. A change of those versions is C5-2; if it lands in another
// change, this fails and says why.
describe('the declared versions keep the approval path closed (C5-1 tripwire)', () => {
  const table = JSON.parse(
    readFileSync(join(__dirname, '../../computer-use-native/eligibility.json'), 'utf8'),
  ) as {
    versions: { rulesetVersion: number; classifierVersion: number; lexiconVersion: number };
    ticketRequired: Record<string, boolean>;
  };

  it('declares classifier version 1 (raising it is C5-2, after the #777 measurement)', () => {
    expect(table.versions.classifierVersion, 'C5-2 raises this, not another change').toBe(1);
    expect(table.versions.rulesetVersion).toBe(1);
    expect(table.versions.lexiconVersion).toBe(1);
  });

  it.each(['v1-allowlist', 'v2-denylist'] as const)(
    'a %s build declared by the table attests nothing, binds v1, opens no approval',
    async (mode) => {
      const compiled = {
        mode,
        ...table.versions,
        ticketRequired: table.ticketRequired['darwin'] === true,
      } as ComputerUseEligibility;
      const wiring = createComputerUseEligibilityWiring({
        compiled: () => compiled,
        agentDrivenV2: () => true,
        environment: () => ({}),
      });
      expect(wiring.classifierV2Attested(true)).toBe(false);
      const built = buildHost(wiring.classifierV2Attested(true), wiring.effectiveEligibilityMode);
      // An agent session asks for v2 under the v2 deny-list, a panel session asks for v1.
      const agent = await startSession(
        built.host,
        computerUseClassifierRoute({
          agent: true,
          effectiveMode: wiring.effectiveEligibilityMode(),
        }),
        'session-agent',
      );
      const panel = await startSession(built.host, 'v1', 'session-panel');
      expect(built.sent('session-agent')['classifierRoute']).toBe('v1');
      expect(built.sent('session-panel')['classifierRoute']).toBe('v1');
      expect(built.host.nativeApprovalPathEnabled?.(agent.sessionId)).toBe(false);
      expect(built.host.nativeApprovalPathEnabled?.(panel.sessionId)).toBe(false);
    },
  );
});

describe('the high-impact flag has two sources (C5-1, 3-A)', () => {
  it('splits native facts from the part only Main saw; only the native part can be waived', () => {
    expect(splitHighImpact(undefined)).toEqual({
      any: false,
      native: false,
      mainProjectionOnly: false,
    });
    expect(splitHighImpact({})).toEqual({ any: false, native: false, mainProjectionOnly: false });
    expect(splitHighImpact({ highImpact: true })).toEqual({
      any: true,
      native: false,
      mainProjectionOnly: true,
    });
    expect(splitHighImpact({ highImpact: true, highImpactNative: true })).toEqual({
      any: true,
      native: true,
      mainProjectionOnly: false,
    });
    // Native's flag alone is high impact too, and is never "Main only".
    expect(splitHighImpact({ highImpactNative: true })).toEqual({
      any: true,
      native: true,
      mainProjectionOnly: false,
    });
    expect(splitHighImpact({ highImpact: false, highImpactNative: false }).any).toBe(false);
  });
});

// ---- A fake macOS addon, enough to start a session and report what the native was asked ----------

const zero = (digit: string): string => digit.repeat(64);
const identityDigest = zero('a');
const profile = {
  id: 'profile-1',
  platform: 'darwin',
  kind: 'macos-bundle',
  label: 'Target',
  canonicalPath: '/Applications/Target.app/Contents/MacOS/Target',
  appUrl: null,
  identity: {
    platform: 'darwin',
    kind: 'macos-bundle',
    displayName: 'Target',
    canonicalPath: '/Applications/Target.app/Contents/MacOS/Target',
    identityDigest,
    executableDigest: zero('b'),
    policyLanguage: 'en',
    maximumMode: 'full_access_app',
  },
  identityDigest,
  version: null,
  executableDigest: zero('b'),
  mode: 'full_access_app',
  connectionId: 'connection-1',
  modelId: 'model-1',
  providerEgressConsent: true,
  remember: false,
  revision: 1,
  createdAt: '2026-10-14T00:00:00.000Z',
  updatedAt: '2026-10-14T00:00:00.000Z',
} as unknown as ComputerAppProfileRecord;

function buildHost(attested: boolean, effectiveEligibilityMode: () => ComputerUseEligibilityMode) {
  const startSessionCalls: Array<Record<string, unknown>> = [];
  const addon = {
    probe: () => ({}),
    pickApplication: () => null,
    listWindows: () => [
      {
        pid: 42,
        windowId: 'window-1',
        platform: 'darwin',
        appIdentityDigest: identityDigest,
        windowIdentityDigest: zero('d'),
        executableDigest: zero('b'),
        title: 'Target',
        bounds: { x: 0, y: 0, width: 100, height: 80 },
        screenBounds: { x: 0, y: 0, width: 100, height: 80 },
        focused: true,
        eligible: true,
        ownerKind: 'application',
        modal: false,
        revision: 1,
        policyLanguage: 'en',
        maximumMode: 'full_access_app',
      },
    ],
    startSession: vi.fn((input: unknown) => {
      const record = input as Record<string, unknown>;
      startSessionCalls.push(record);
      return {
        inputAttemptCount: 0,
        sessionId: record['sessionId'],
        platform: 'darwin',
        appIdentityDigest: identityDigest,
        windowIdentityDigest: zero('d'),
        windowId: 'window-1',
        profileRevision: 1,
        cancelEpoch: 0,
        policyLanguage: 'en',
        maximumMode: 'full_access_app',
        screenBounds: { x: 0, y: 0, width: 100, height: 80 },
        pid: 42,
      };
    }),
    observe: () => ({}),
    preflight: () => ({}),
    approvalApprove: () => ({}),
    approvalDiscard: () => ({}),
    dispatchApproved: () => ({}),
    dispatch: () => ({}),
    cancel: () => ({}),
    stopPendingStart: (input: unknown) => ({
      result: 'closed',
      drained: true,
      sessionId: (input as Record<string, unknown>)['sessionId'],
      cancelEpoch: 1,
      inputAttemptCount: 0,
    }),
    close: (input: unknown) => ({
      result: 'closed',
      drained: true,
      sessionId: (input as Record<string, unknown>)['sessionId'],
      cancelEpoch: (input as Record<string, unknown>)['cancelEpoch'],
      inputAttemptCount: 0,
    }),
  };
  const binding = {
    manifest: {
      version: 1,
      sourceCommit: 'f'.repeat(40),
      platform: 'darwin',
      architecture: 'arm64',
      protocolVersion: 1,
      apiVersion: 3,
      nativeVersion: 'test-native',
      moduleDigest: zero('1'),
      binaryDigest: zero('2'),
      signerDigest: zero('3'),
      capabilities: ['observe', 'capture', 'accessibility', 'input'],
    },
    probe: {
      available: true,
      protocolVersion: 1,
      apiVersion: 3,
      backend: 'test-native',
      reason: '',
      artifactPath: '/Resources/sprint_coder_computer_use_native.node',
      artifactDigest: zero('1'),
      capabilities: { observe: true, control: true },
    },
    artifactPath: '/Resources/sprint_coder_computer_use_native.node',
    addon,
  } as unknown as ComputerUseNativeBinding;
  const host = createComputerUseNativeHost(binding, 'darwin', {
    classifierV2Attested: attested,
    effectiveEligibilityMode,
  });
  return {
    host,
    sent: (sessionId?: string) =>
      (sessionId === undefined
        ? startSessionCalls.at(-1)
        : [...startSessionCalls].reverse().find((call) => call['sessionId'] === sessionId))!,
  };
}

async function startSession(
  host: ReturnType<typeof buildHost>['host'],
  route: 'v1' | 'v2',
  sessionId = 'session-1',
) {
  await host.listWindows(profile);
  return host.startSession({
    profile,
    windowId: 'window-1',
    sessionId,
    taskId: 'task-1',
    turnId: 'turn-1',
    cancelEpoch: 0,
    classifierRoute: route,
  });
}

// ---- The wiring is in the places that build the host and the controller --------------------------

describe('the production wiring is where the host and the controller are built (C5-1)', () => {
  const main = (name: string): string => readFileSync(join(__dirname, name), 'utf8');

  it('hands the host the attest and the effective mode, and the controller the effective mode', () => {
    const index = main('index.ts');
    expect(index).toContain(
      "import { computerUseEligibilityWiring } from './computer-use-eligibility-wiring';",
    );
    expect(index).toMatch(
      /classifierV2Attested: computerUseEligibilityWiring\.classifierV2Attested\(\s*computerUseBinding\.probe\.available === true,?\s*\)/u,
    );
    expect(index).toContain(
      'effectiveEligibilityMode: computerUseEligibilityWiring.effectiveEligibilityMode,',
    );
    const ipc = main('ipc.ts');
    expect(ipc).toContain(
      'effectiveEligibilityMode: computerUseEligibilityWiring.effectiveEligibilityMode,',
    );
  });

  it('reads the build and the flag only: the compiled eligibility, the V2 flag, the force-v1 variable', () => {
    const wiring = main('computer-use-eligibility-wiring.ts');
    expect(wiring.match(/process\.env/gu)).toHaveLength(1);
    expect(wiring).toContain('computerUseCompiledEligibility()');
    expect(wiring).toContain('computerUseAgentDrivenV2Enabled()');
    // The attest is derived from the build; no version number is written here.
    expect(wiring).not.toMatch(/classifierVersion|=== 2|!== 2/u);
  });

  it('keeps the approval predicate in one place, with the session id passed by the controller', () => {
    const host = main('computer-use-native-host.ts');
    expect(host.match(/computerUseApprovalPathEnabled\(/gu)).toHaveLength(1);
    // Every use in the host names a session, except the capability answer.
    expect(host).toContain('approvalPathEnabled(input.session.sessionId)');
    const controller = main('computer-use-controller.ts');
    expect(controller).toContain('nativeApprovalPathEnabled?.(sessionId)');
    expect(controller).not.toMatch(/nativeApprovalPathOpen\(\)/u);
  });
});
