import { ComputerUseDiscoveryScope } from './computer-use-discovery-scope';
import {
  ComputerUseController,
  computerUseAppIdentityIsPermanentlyDenied,
  type ComputerUseControllerPersistence,
  type ComputerUseNativeWindow,
} from './computer-use-controller';
import { createComputerAppGrantFixtureStore } from './computer-use-grant-fixture';
import { computerAppGrantIdentityFrom } from './computer-use-grant-identity';
import type { ComputerAppGrantRequest, SelectableComputerTarget } from '@sprint-coder/contracts';
import type { ComputerAppProfileRecord } from './persistence';
import { windowsApprovalEvidenceMatches } from './computer-use-native-handshake';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computerWindowsTargetFactsSchema,
  type ComputerUseEligibilityMode,
  type ComputerWindowsNativeTargetList,
} from '@sprint-coder/contracts';
import {
  parseWindowsComputerUseTargets,
  windowsComputerTargetCandidates,
} from './computer-use-native-targets';
import {
  createComputerUseNativeHost,
  readWindowsExplorerPrestart,
  windowsExplorerPrestartIsCurrent,
  readWindowsExplorerApproval,
  readCurrentWindowsExplorerFacts,
  type WindowsExplorerApproval,
  type WindowsDispatchLedgerStorage,
} from './computer-use-native-host';
import { computerUseNativeCompiledPin } from './computer-use-native-provenance';
import {
  createWindowsExplorerPrestartContext,
  WINDOWS_EXPLORER_FINAL_VERSIONS,
  windowsExplorerFinalPinMatches,
} from './computer-use-explorer-prestart';
import { classifyTarget } from './computer-use-target-eligibility';
import type { WindowsTerminationCallbacks } from './computer-use-native-types';
import type { ComputerUseNativeBinding } from './computer-use-native-types';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const golden: unknown = JSON.parse(
  readFileSync(join(__dirname, '../../computer-use-native/target-eligibility-golden.json'), 'utf8'),
);
if (typeof golden !== 'object' || golden === null || !('base' in golden))
  throw new Error('Missing target eligibility golden base');
const facts = computerWindowsTargetFactsSchema.parse(golden.base);
type Selectable = Extract<
  ComputerWindowsNativeTargetList['targets'][number],
  { kind: 'eligible' | 'upper' }
>;

function row(kind: 'eligible' | 'upper' = 'eligible'): Selectable {
  const executablePath = 'C:\\Program Files\\Contoso\\Editor\\editor.exe';
  const signerDigest = 'd'.repeat(64);
  const identityDigest = sha256(
    `computer-win-identity-v1-signed\n${executablePath.toLowerCase()}\n${signerDigest}`,
  );
  const maximumMode = kind === 'eligible' ? 'full_access_app' : 'observe_only';
  return {
    kind,
    windowId: '42',
    pid: 42,
    appIdentityDigest: identityDigest,
    executableDigest: 'b'.repeat(64),
    windowIdentityDigest: 'c'.repeat(64),
    title: '  ',
    bounds: { x: -800, y: 0, width: 800, height: 600 },
    screenBounds: { x: -1920, y: 0, width: 1920, height: 1080 },
    boundsUnit: 'physical_px',
    maximumMode,
    identity: {
      platform: 'win32',
      identityDigest,
      executablePath,
      executableDigest: 'b'.repeat(64),
      signerDigest,
      packageFamilyName: null,
      appUserModelId: null,
      displayName: 'Contoso Editor',
      policyLanguage: 'unknown',
      maximumMode,
    },
    facts: { ...facts },
  };
}

function envelope(targets: ComputerWindowsNativeTargetList['targets'] = [row()]) {
  return { generation: 4_503_599_627_370_000, rulesetVersion: 5, truncated: true, targets };
}

it.each([
  ['chrome.exe', 'C:\\Program Files', 'supervised'],
  ['chrome.exe', 'C:\\Program Files (x86)', 'observe_only'],
  ['msedge.exe', 'C:\\Program Files (x86)', 'supervised'],
  ['msedge.exe', 'C:\\Program Files', 'observe_only'],
  ['chrome.exe', 'D:\\CanonicalApps', 'supervised'],
  ['msedge.exe', 'D:\\CanonicalAppsX86', 'supervised'],
] as const)(
  'Main preserves native Known Folder ceiling for %s in %s: %s',
  (leaf, root, expected) => {
    vi.stubEnv('ProgramW6432', 'C:\\Program Files');
    vi.stubEnv('ProgramFiles(x86)', 'C:\\Program Files (x86)');
    const target = row('upper');
    const relative =
      leaf === 'chrome.exe'
        ? 'google\\chrome\\application\\chrome.exe'
        : 'microsoft\\edge\\application\\msedge.exe';
    const path = `${root}\\${relative}`;
    target.facts = {
      ...facts,
      imageLeaf: leaf,
      originalFilename: leaf,
      imageRelativePath: relative,
      signerOrganization: leaf === 'chrome.exe' ? 'google llc' : 'microsoft corporation',
      signerMicrosoftRoot: leaf === 'msedge.exe',
    };
    target.maximumMode = expected;
    target.appIdentityDigest = sha256(
      `computer-win-identity-v1-signed\n${path.toLowerCase()}\n${target.identity.signerDigest}`,
    );
    target.identity = {
      ...target.identity,
      executablePath: path,
      identityDigest: target.appIdentityDigest,
      maximumMode: expected,
    };
    expect(parseWindowsComputerUseTargets(envelope([target]), true)?.targets[0]).toMatchObject({
      kind: 'selectable',
      maximumMode: expected,
    });
    vi.stubEnv('ProgramW6432', undefined);
    vi.stubEnv('ProgramFiles(x86)', undefined);
    expect(parseWindowsComputerUseTargets(envelope([target]), true)?.targets[0]).toMatchObject({
      maximumMode: expected,
    });
    // A valid signed identity must also agree with the measured browser-relative path.
    const mismatchedPath = `${root}\\other\\${leaf}`;
    target.appIdentityDigest = sha256(
      `computer-win-identity-v1-signed\n${mismatchedPath.toLowerCase()}\n${target.identity.signerDigest}`,
    );
    target.identity = {
      ...target.identity,
      executablePath: mismatchedPath,
      identityDigest: target.appIdentityDigest,
    };
    expect(parseWindowsComputerUseTargets(envelope([target]), true)?.targets[0]).toMatchObject({
      kind: 'selectable',
      maximumMode: 'observe_only',
    });
  },
);

function nativeFixture() {
  const listTargets = vi.fn<() => unknown>(() => envelope());
  const binding: ComputerUseNativeBinding = {
    manifest: {
      version: 1,
      sourceCommit: 'f'.repeat(40),
      platform: 'win32',
      architecture: 'x64',
      protocolVersion: 1,
      apiVersion: 3,
      nativeVersion: 'test-native',
      moduleDigest: '1'.repeat(64),
      binaryDigest: '2'.repeat(64),
      signerDigest: '3'.repeat(64),
      capabilities: ['observe', 'capture', 'accessibility', 'input'],
      // Injected inactive v2 binding. Production manifest admission stays closed until PR-6.
      eligibility: {
        mode: 'v2-denylist',
        rulesetVersion: 5,
        classifierVersion: 1,
        lexiconVersion: 1,
        ticketRequired: true,
      },
    },
    probe: {
      available: true,
      protocolVersion: 1,
      apiVersion: 3,
      backend: 'test-native',
      reason: '',
      artifactPath: 'C:\\Resources\\helper.exe',
      artifactDigest: '2'.repeat(64),
      capabilities: { observe: true, control: true, cancellableWindowDiscovery: true },
    },
    artifactPath: 'C:\\Resources\\helper.exe',
    addon: {
      probe: () => ({}),
      pickApplication: () => null,
      listWindows: vi.fn(() => []),
      discoverWindows: vi.fn(),
      stopWindowDiscovery: vi.fn(),
      cancelUnsubmittedDiscovery: () => 'unknown',
      listTargets,
      startSession: vi.fn(),
      observe: vi.fn(),
      dispatch: vi.fn(),
      cancel: vi.fn(),
      stopPendingStart: vi.fn(),
      close: vi.fn(),
    },
  };
  const options = {
    effectiveEligibilityMode: (): ComputerUseEligibilityMode => 'v2-denylist',
    windowsPhysicalBoundsToDip: (bounds: { x: number; y: number; width: number; height: number }) =>
      bounds,
  };
  return { binding, options, listTargets };
}

describe('Windows native targets independently classified in Main', () => {
  it('N6-2 groups candidate-only profiles without registration or consent and keeps exact generations', () => {
    const native = row();
    const parsed = parseWindowsComputerUseTargets(
      envelope([
        native,
        { ...row('upper'), windowId: '43', windowIdentityDigest: 'e'.repeat(64) },
        { kind: 'denied' },
        { kind: 'unresolvable' },
      ]),
    )!;
    const windowsGeneration = {
      helper: Object.freeze({ helperGeneration: 2 }),
      listGeneration: parsed.generation,
      rulesetVersion: parsed.rulesetVersion,
    };
    const candidates = windowsComputerTargetCandidates({ ...parsed, windowsGeneration });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.profile).toMatchObject({
      platform: 'win32',
      kind: 'win32-executable',
      identity: native.identity,
      identityDigest: native.appIdentityDigest,
      executableDigest: native.executableDigest,
      providerEgressConsent: false,
      remember: false,
      connectionId: '',
      modelId: '',
    });
    expect(candidates[0]!.windows.map((window) => window.maximumMode)).toEqual([
      'full_access_app',
      'observe_only',
    ]);
    expect(
      candidates[0]!.windows.every((window) => window.windowsGeneration === windowsGeneration),
    ).toBe(true);
    expect(windowsComputerTargetCandidates({ ...parsed, windowsGeneration })[0]!.profile.id).toBe(
      candidates[0]!.profile.id,
    );
    expect(() => windowsComputerTargetCandidates(parsed)).toThrow(/generation/);
    expect(() =>
      windowsComputerTargetCandidates({
        ...parsed,
        windowsGeneration: { ...windowsGeneration, listGeneration: 1 },
      }),
    ).toThrow(/generation/);
    expect(() =>
      windowsComputerTargetCandidates({
        ...parsed,
        windowsGeneration: { ...windowsGeneration, rulesetVersion: 1 },
      }),
    ).toThrow(/generation/);
  });

  it('N6 carries exact response ownership separately from the native list generation', async () => {
    const fixture = nativeFixture();
    const helper = Object.freeze({ helperGeneration: 4 });
    let current = true;
    const value = envelope();
    fixture.listTargets.mockReturnValue(value);
    const host = createComputerUseNativeHost(
      {
        ...fixture.binding,
        addon: {
          ...fixture.binding.addon!,
          captureWindowsGeneration: () => (current ? helper : null),
          windowsGenerationFor: (response) => (response === value ? helper : null),
          isWindowsGenerationCurrent: (token) => current && token === helper,
          configureWindowsTermination: () => undefined,
          requestWindowsTermination: () => undefined,
          cleanupWindowsGeneration: () => undefined,
        },
      },
      'win32',
      {
        ...fixture.options,
        windowsLedger: {
          write: () => true,
          update: () => true,
          delete: () => true,
          restoreQuarantines: () => true,
        },
        windowsKillStopTermination: { enabled: true },
      },
    );
    const result = await host.listTargets!();
    expect(result.windowsGeneration).toEqual({
      helper,
      listGeneration: value.generation,
      rulesetVersion: value.rulesetVersion,
    });
    expect(result.windowsGeneration?.helper).toBe(helper);
    expect(host.captureWindowsGeneration!()).toBe(helper);
    expect(host.isWindowsTargetGenerationCurrent?.(result.windowsGeneration!)).toBe(true);
    value.generation += 1;
    const second = await host.listTargets!();
    expect(host.isWindowsTargetGenerationCurrent?.(result.windowsGeneration!)).toBe(false);
    fixture.listTargets.mockReturnValueOnce({});
    await expect(host.listTargets!()).rejects.toThrow();
    expect(host.isWindowsTargetGenerationCurrent?.(second.windowsGeneration!)).toBe(false);
    current = false;
    expect(host.isWindowsGenerationCurrent!(helper)).toBe(false);
    await expect(host.listTargets!()).rejects.toThrow('native_target_generation_changed');
    expect(fixture.binding.addon!.startSession).not.toHaveBeenCalled();
  });

  it('PR8 excludes the isolated process from cross-application discovery and retains another process', async () => {
    const fixture = nativeFixture();
    fixture.listTargets.mockReturnValue(envelope([row(), row(), { ...row(), pid: 43 }]));
    const checkTargetIdentity = vi.fn(async () => [{ result: 'alive' as const }]);
    const read = vi.fn(() => ({
      rows: [],
      quarantines: [
        { identity: { pid: 42, creationTime: '133000000000000001' }, reason: 'exit_suspect' },
      ],
    }));
    const host = createComputerUseNativeHost(
      {
        ...fixture.binding,
        addon: {
          ...fixture.binding.addon!,
          checkTargetIdentity,
        },
      },
      'win32',
      {
        ...fixture.options,
        windowsLedger: {
          write: () => true,
          update: () => true,
          delete: () => true,
          restoreQuarantines: () => true,
          read,
        },
      },
    );
    expect((await host.listTargets!()).targets).toMatchObject([
      { kind: 'denied' },
      { kind: 'denied' },
      { kind: 'selectable', native: { pid: 43 } },
    ]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(checkTargetIdentity).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['eligible', false, 'full_access_app'],
    ['eligible', true, 'observe_only'],
    ['upper', false, 'observe_only'],
    ['upper', true, 'observe_only'],
  ] as const)('takes the narrower mode: native=%s, Main capped=%s', (kind, capped, expected) => {
    const native = row(kind);
    native.facts.descendantShell = capped;
    const input = envelope([native]);
    expect(parseWindowsComputerUseTargets(input)).toEqual({
      ...input,
      targets: [{ kind: 'selectable', native, maximumMode: expected }],
    });
    expect(native.maximumMode).toBe(kind === 'eligible' ? 'full_access_app' : 'observe_only');
  });

  it('never promotes native refusals or returns their metadata', () => {
    expect(
      parseWindowsComputerUseTargets(envelope([{ kind: 'denied' }, { kind: 'unresolvable' }])),
    ).toMatchObject({ targets: [{ kind: 'denied' }, { kind: 'unresolvable' }] });
  });

  it.each([
    [{ tokenElevated: true }, 'denied'],
    [{ tokenElevated: null }, 'unresolvable'],
  ] as const)('removes identity and title when Main refuses %j', (override, kind) => {
    const native = row();
    Object.assign(native.facts, override);
    expect(parseWindowsComputerUseTargets(envelope([native]))?.targets).toEqual([{ kind }]);
  });

  it('rejects malformed wire, wrong versions, and a self-consistent but false native digest', () => {
    expect(parseWindowsComputerUseTargets({ ...envelope(), rulesetVersion: 4 }, true)).toBeNull();
    expect(parseWindowsComputerUseTargets({ ...envelope(), rulesetVersion: 1 })).toBeNull();
    expect(parseWindowsComputerUseTargets({ ...envelope(), extra: true })).toBeNull();
    const native = row();
    native.identity.identityDigest = 'a'.repeat(64);
    native.appIdentityDigest = native.identity.identityDigest;
    expect(parseWindowsComputerUseTargets(envelope([native]))).toBeNull();
  });

  it('validates package identity and refuses facts from a different package', () => {
    const native = row();
    const family = 'Contoso.Editor_123456789abcd';
    Object.assign(native.identity, {
      executablePath: 'C:\\Program Files\\WindowsApps\\Contoso.Editor_1.0\\editor.exe',
      packageFamilyName: family,
      packagePublisherId: '123456789abcd',
      packageRelativePath: 'editor.exe',
      signerDigest: null,
      identityDigest: sha256(
        `computer-win-identity-v2-package\n${family}\n123456789abcd\neditor.exe`,
      ),
    });
    native.appIdentityDigest = native.identity.identityDigest;
    Object.assign(native.facts, {
      imageRoot: 'windows_apps',
      packaged: true,
      packageFamily: family,
      packageSignatureKind: 'store',
    });
    expect(parseWindowsComputerUseTargets(envelope([native]))?.targets[0]?.kind).toBe('selectable');
    native.facts.packageFamily = 'Contoso.Other_123456789abcd';
    expect(parseWindowsComputerUseTargets(envelope([native]))).toBeNull();
    native.facts.packaged = false;
    native.facts.imageRoot = 'program_files';
    expect(parseWindowsComputerUseTargets(envelope([native]))).toBeNull();
  });

  it('binds the measured leaf to the image using ASCII folding only', () => {
    const native = row();
    native.facts.imageLeaf = 'EDITOR.EXE';
    expect(parseWindowsComputerUseTargets(envelope([native]))?.targets[0]?.kind).toBe('selectable');
    native.facts.imageLeaf = 'another.exe';
    expect(parseWindowsComputerUseTargets(envelope([native]))).toBeNull();
  });
});

describe('inactive native discovery host seam', () => {
  it('returns classified private evidence without using picker, window lookup, or input', async () => {
    const { binding, options, listTargets } = nativeFixture();
    const host = createComputerUseNativeHost(binding, 'win32', options);
    const result = await host.listTargets!();
    expect(result.targets[0]).toMatchObject({ kind: 'selectable', maximumMode: 'full_access_app' });
    expect(listTargets).toHaveBeenCalledWith({});
    expect(binding.addon!.listWindows).not.toHaveBeenCalled();
    expect(binding.addon!.startSession).not.toHaveBeenCalled();
    expect(binding.addon!.dispatch).not.toHaveBeenCalled();
  });

  it.each(['darwin', 'v1', 'version', 'disabled', 'unsigned', 'no-observe', 'legacy-addon'])(
    'refuses %s before requesting a native list',
    async (closed) => {
      const fixture = nativeFixture();
      let { binding, options } = fixture;
      const platform = closed === 'darwin' ? 'darwin' : 'win32';
      if (closed === 'v1')
        binding = { ...binding, manifest: { ...binding.manifest, eligibility: undefined } };
      if (closed === 'version')
        binding = {
          ...binding,
          manifest: {
            ...binding.manifest,
            eligibility: { ...binding.manifest.eligibility!, rulesetVersion: 1 },
          },
        };
      if (closed === 'disabled')
        options = { ...options, effectiveEligibilityMode: () => 'v1-allowlist' };
      if (closed === 'unsigned') binding = { ...binding, artifactPath: null };
      if (closed === 'no-observe')
        binding = {
          ...binding,
          probe: { ...binding.probe, capabilities: { observe: false, control: false } },
        };
      if (closed === 'legacy-addon') {
        const addon = { ...binding.addon! };
        delete addon.listTargets;
        binding = { ...binding, addon };
      }
      const host = createComputerUseNativeHost(binding, platform, options);
      await expect(host.listTargets!()).rejects.toThrow();
      expect(fixture.listTargets).not.toHaveBeenCalled();
      if (closed === 'legacy-addon') expect(host.availability().available).toBe(true);
    },
  );

  it('rechecks the effective mode after awaiting native and rejects malformed evidence', async () => {
    const { binding, options, listTargets } = nativeFixture();
    let mode: ComputerUseEligibilityMode = 'v2-denylist';
    listTargets.mockImplementation(async () => {
      mode = 'v1-allowlist';
      return envelope();
    });
    const host = createComputerUseNativeHost(binding, 'win32', {
      ...options,
      effectiveEligibilityMode: () => mode,
    });
    await expect(host.listTargets!()).rejects.toThrow('native_target_discovery_unavailable');
    mode = 'v2-denylist';
    listTargets.mockReturnValue({ private: 'must not be printed' });
    await expect(host.listTargets!()).rejects.toThrow('native_target_list_invalid');
  });
});

it('N8-5 caps the presented C ceiling without build evidence', () => {
  const target = {
    ...row('upper'),
    maximumMode: 'supervised',
    identity: { ...row('upper').identity, maximumMode: 'supervised' },
    facts: { ...facts, descendantShell: true },
  };
  const value = { ...envelope(), targets: [target] };
  expect(parseWindowsComputerUseTargets(value)?.targets[0]).toMatchObject({
    kind: 'selectable',
    maximumMode: 'observe_only',
  });
});

it('N8-5 presents C only with matching approval evidence and never calls the session predicate', async () => {
  const target = {
    ...row('upper'),
    maximumMode: 'supervised',
    identity: { ...row('upper').identity, maximumMode: 'supervised' },
    facts: { ...facts, descendantShell: true },
  };
  const value = { ...envelope(), targets: [target] };
  const eligibility = {
    mode: 'v2-denylist',
    classifierVersion: 4,
    rulesetVersion: 5,
    lexiconVersion: 3,
    ticketRequired: true,
    interlockEnforced: true,
  };
  const viewers = { version: 1, digest: 'a'.repeat(16) };
  const declaration = { eligibility, windowsDocumentViewers: viewers };
  const handshake = {
    ...declaration,
    protocolVersion: 1,
    apiVersion: 3,
    napiVersion: 10,
    platform: 'win32',
    capabilities: { approval: true, approvalWire: 3 },
  };
  const variants: unknown[][] = [[declaration, declaration, handshake]];
  for (const side of [0, 1, 2])
    for (const interlockEnforced of [undefined, false])
      variants.push(
        [declaration, declaration, handshake].map((entry, index) =>
          index === side ? { ...entry, eligibility: { ...eligibility, interlockEnforced } } : entry,
        ),
      );
  for (const side of [0, 1, 2])
    for (const changed of [
      undefined,
      { version: 2, digest: viewers.digest },
      { version: 1, digest: 'b'.repeat(16) },
    ])
      variants.push(
        [declaration, declaration, handshake].map((entry, index) =>
          index === side ? { ...entry, windowsDocumentViewers: changed } : entry,
        ),
      );
  variants.push([declaration, declaration, { ...handshake, capabilities: {} }]);
  variants.push([declaration, declaration, handshake]);
  for (const [index, evidence] of variants.entries()) {
    const fixture = nativeFixture();
    fixture.listTargets.mockReturnValue(value);
    const sessionPredicate = vi.fn(() => {
      throw new Error('discovery must not query a session');
    });
    const host = createComputerUseNativeHost(
      {
        ...fixture.binding,
        windowsApprovalVerified: windowsApprovalEvidenceMatches(
          evidence[0],
          evidence[1],
          evidence[2],
        ),
        addon: {
          ...fixture.binding.addon!,
          windowsApprovalAvailable: () => index !== variants.length - 1,
          windowsApprovalReady: sessionPredicate,
          preflight: vi.fn(),
          approvalApprove: vi.fn(),
          approvalDiscard: vi.fn(),
          dispatchApproved: vi.fn(),
        },
      },
      'win32',
      { ...fixture.options, classifierV2Attested: true },
    );
    const list = await host.listTargets!();
    const maximumMode = index === 0 ? 'supervised' : 'observe_only';
    expect(list.targets[0]).toMatchObject({ kind: 'selectable', maximumMode });
    const candidates = windowsComputerTargetCandidates({
      ...list,
      windowsGeneration: {
        helper: { helperGeneration: 1 },
        listGeneration: list.generation,
        rulesetVersion: list.rulesetVersion,
      },
    });
    expect(candidates[0]?.profile.identity['maximumMode']).toBe(maximumMode);
    expect(candidates[0]?.profile.identityDigest).toBe(target.appIdentityDigest);
    expect(sessionPredicate).not.toHaveBeenCalled();
  }
  const browser = { ...target, facts: { ...target.facts, signerOrganization: 'google llc' } };
  expect(
    parseWindowsComputerUseTargets({ ...value, targets: [browser] }, true)?.targets[0],
  ).toMatchObject({ maximumMode: 'observe_only' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function explorerRow(): Selectable {
  vi.stubEnv('WINDIR', 'C:\\Windows');
  const target = row('upper');
  const path = 'C:\\Windows\\explorer.exe';
  target.appIdentityDigest = sha256(
    `computer-win-identity-v1-signed\n${path.toLowerCase()}\n${target.identity.signerDigest}`,
  );
  target.maximumMode = 'supervised';
  target.identity = {
    ...target.identity,
    executablePath: path,
    identityDigest: target.appIdentityDigest,
    maximumMode: 'supervised',
  };
  target.facts = {
    ...facts,
    imageRoot: 'windows_directory',
    imageRelativePath: 'explorer.exe',
    imageLeaf: 'explorer.exe',
    signerMicrosoftRoot: true,
    windowClass: 'CabinetWClass',
  };
  target.explorerPrestart = {
    version: 1,
    ...WINDOWS_EXPLORER_FINAL_VERSIONS,
    pid: target.pid,
    listGeneration: envelope().generation,
    processStartTime: '133000000000000001',
    shellView: 'filesystem_folder',
  };
  target.windowIdentityDigest = sha256(
    `computer-window-identity-v1\n${target.appIdentityDigest}\n${target.explorerPrestart.processStartTime}\n${target.windowId}`,
  );
  return target;
}

const finalPin = () => ({
  ...computerUseNativeCompiledPin(nativeFixture().binding.manifest),
  eligibility: {
    mode: 'v2-denylist' as const,
    ...WINDOWS_EXPLORER_FINAL_VERSIONS,
    ticketRequired: true,
    interlockEnforced: true,
  },
});

it('approval_boolean_cannot_enable_explorer', () => {
  const native = explorerRow();
  for (const approval of [false, true])
    expect(parseWindowsComputerUseTargets(envelope([native]), approval)?.targets).toEqual([
      classifyTarget(native.facts),
    ]);
  const { explorerPrestart: _evidence, ...missing } = native;
  expect(
    parseWindowsComputerUseTargets(
      envelope([missing]),
      true,
      createWindowsExplorerPrestartContext(() => true),
    )?.targets,
  ).toEqual([{ kind: 'denied' }]);
});

it('explorer_private_evidence_is_strict_and_version_bound', () => {
  const native = explorerRow();
  const evidence = native.explorerPrestart!;
  const context = createWindowsExplorerPrestartContext(() => true);
  expect(
    parseWindowsComputerUseTargets(envelope([native]), true, context)?.targets[0],
  ).toMatchObject({ kind: 'selectable', maximumMode: 'supervised' });
  const invalid: unknown[] = [
    null,
    true,
    {},
    { ...evidence, extra: true },
    { ...evidence, shellView: 'virtual' },
    { ...evidence, processStartTime: '0' },
    { ...evidence, processStartTime: '18446744073709551616' },
  ];
  for (const key of Object.keys(evidence)) {
    const missing: Record<string, unknown> = { ...evidence };
    delete missing[key];
    invalid.push(missing);
  }
  for (const key of [
    'version',
    'rulesetVersion',
    'classifierVersion',
    'lexiconVersion',
    'listGeneration',
  ] as const)
    for (const delta of [-1, 1]) invalid.push({ ...evidence, [key]: evidence[key] + delta });
  for (const explorerPrestart of invalid)
    expect(
      parseWindowsComputerUseTargets(
        { ...envelope(), targets: [{ ...native, explorerPrestart }] },
        true,
        context,
      ),
    ).toBeNull();
  for (const changed of [
    { pid: 43 },
    { windowId: '43' },
    { windowIdentityDigest: 'f'.repeat(64) },
    { explorerPrestart: { ...evidence, processStartTime: '133000000000000002' } },
  ])
    expect(
      parseWindowsComputerUseTargets(envelope([{ ...native, ...changed }]), true, context),
    ).toBeNull();
});

it('explorer_exception_cannot_override_unrelated_denial', () => {
  const native = explorerRow();
  const context = createWindowsExplorerPrestartContext(() => true);
  for (const changed of [
    { tokenElevated: true },
    { tokenOtherUser: true },
    { tokenOtherSession: true },
    { tokenProtected: true },
    { tokenUiAccess: true },
    { tokenIntegrityAboveSelf: true },
    { requiresAdministrator: true },
    { imageLeaf: 'cmd.exe' },
    { runningImageMatches: false },
    { windowClass: 'Progman' },
    { signerMicrosoftRoot: false },
    { windowClass: null },
  ]) {
    const target = { ...native, facts: { ...native.facts, ...changed } };
    expect(
      parseWindowsComputerUseTargets(envelope([target]), true, context)?.targets[0]?.kind,
    ).toBe(classifyTarget(target.facts).kind);
  }
});

function explorerHost(
  enabled = true,
  verified = true,
  ledger: Partial<WindowsDispatchLedgerStorage> = {},
  exceptionEnabled = true,
  addonOverrides: Partial<NonNullable<ComputerUseNativeBinding['addon']>> = {},
) {
  const fixture = nativeFixture();
  let helper: Readonly<{ helperGeneration: number }> = Object.freeze({ helperGeneration: 1 });
  let captureMissing = false;
  let approvalAvailable = true;
  let callbacks: WindowsTerminationCallbacks | undefined;
  const value = envelope([explorerRow()]);
  fixture.listTargets.mockReturnValue(value);
  const responses = new WeakMap<object, typeof helper>([[value, helper]]);
  const sessionReady = vi.fn(() => {
    throw new Error('prestart must not use session readiness');
  });
  const host = createComputerUseNativeHost(
    {
      ...fixture.binding,
      windowsApprovalVerified: verified,
      addon: {
        ...fixture.binding.addon!,
        captureWindowsGeneration: () => (captureMissing ? null : helper),
        windowsGenerationFor: (response) =>
          typeof response === 'object' && response !== null
            ? (responses.get(response) ?? null)
            : null,
        isWindowsGenerationCurrent: (token) => token === helper,
        configureWindowsTermination: (value) => {
          callbacks = value;
        },
        requestWindowsTermination: () => {},
        cleanupWindowsGeneration: () => {},
        windowsApprovalAvailable: () => approvalAvailable,
        windowsApprovalReady: sessionReady,
        preflight: vi.fn(),
        approvalApprove: vi.fn(),
        approvalDiscard: vi.fn(),
        dispatchApproved: vi.fn(),
        ...addonOverrides,
      },
    },
    'win32',
    {
      ...fixture.options,
      classifierV2Attested: true,
      windowsExplorerPrestartForTesting: enabled,
      windowsExplorerExceptionForTesting: exceptionEnabled,
      windowsKillStopTermination: { enabled: true },
      windowsLedger: {
        write: () => true,
        update: () => true,
        delete: () => true,
        restoreQuarantines: () => true,
        ...ledger,
      },
    },
  );
  return {
    ...fixture,
    host,
    value,
    sessionReady,
    replaceHelper: () => {
      helper = Object.freeze({ helperGeneration: 2 });
    },
    loseCapability: () => {
      approvalAvailable = false;
    },
    missingCapture: () => {
      captureMissing = true;
    },
    bindResponse: () => responses.set(value, helper),
    stop: () => callbacks!.stopping!(1, 'E1', 'test-stop'),
  };
}

it('explorer_prestart_capability_requires_build_and_host', async () => {
  const pin = finalPin();
  const header = readFileSync(
    join(__dirname, '../../computer-use-native/computer_use_native_eligibility.h'),
    'utf8',
  );
  const definition = JSON.parse(
    readFileSync(join(__dirname, '../../computer-use-native/eligibility.json'), 'utf8'),
  );
  const declaration = header.match(
    /constexpr bool WindowsV2FinalDeclaration\([^]*?return from_build && v2 && ruleset == (\d+) && classifier == (\d+) && lexicon == (\d+)/u,
  );
  expect(declaration).not.toBeNull();
  expect(declaration!.slice(1).map(Number)).toEqual([
    definition.versions.win32.v2.rulesetVersion,
    definition.versions.win32.v2.classifierVersion,
    definition.versions.win32.v2.lexiconVersion,
  ]);
  const variants: unknown[] = [
    undefined,
    null,
    { ...pin, eligibility: undefined },
    { ...pin, platform: 'darwin' },
    { ...pin, eligibility: { ...pin.eligibility, mode: 'v1-allowlist' } },
  ];
  for (const key of ['rulesetVersion', 'classifierVersion', 'lexiconVersion'] as const)
    for (const delta of [-1, 1])
      variants.push({
        ...pin,
        eligibility: {
          ...pin.eligibility,
          [key]: pin.eligibility[key] + delta,
        },
      });
  for (const key of ['ticketRequired', 'interlockEnforced'])
    variants.push({ ...pin, eligibility: { ...pin.eligibility, [key]: false } });
  for (const value of [...variants, pin]) {
    vi.stubGlobal('__SPRINT_CODER_COMPUTER_USE_NATIVE_PIN__', value);
    expect(windowsExplorerFinalPinMatches(value)).toBe(value === pin);
    const fixture = explorerHost();
    const list = await fixture.host.listTargets!();
    expect(readWindowsExplorerPrestart(fixture.host, '42') !== undefined).toBe(value === pin);
    expect(list.targets[0]?.kind).toBe(value === pin ? 'selectable' : 'denied');
    expect(fixture.sessionReady).not.toHaveBeenCalled();
  }
  for (const [enabled, verified] of [
    [false, true],
    [true, false],
  ]) {
    const fixture = explorerHost(enabled, verified);
    expect((await fixture.host.listTargets!()).targets).toEqual([{ kind: 'denied' }]);
    expect(readWindowsExplorerPrestart(fixture.host, '42')).toBeUndefined();
    expect(fixture.listTargets).toHaveBeenCalledTimes(1);
    expect(fixture.binding.addon!.startSession).not.toHaveBeenCalled();
    expect(fixture.binding.addon!.dispatch).not.toHaveBeenCalled();
  }
});

it('prestart_capability_cannot_enable_session_approval', async () => {
  vi.stubGlobal('__SPRINT_CODER_COMPUTER_USE_NATIVE_PIN__', finalPin());
  const { host } = explorerHost();
  const list = await host.listTargets!();
  const capability = readWindowsExplorerPrestart(host, '42');
  expect(capability).toBeDefined();
  expect(windowsExplorerPrestartIsCurrent(capability, host, '42', list.windowsGeneration!)).toBe(
    true,
  );
  expect(windowsExplorerPrestartIsCurrent(capability, host, '43', list.windowsGeneration!)).toBe(
    false,
  );
  expect(readWindowsExplorerApproval(host, '42')).toBeUndefined();
  // Deliberate hostile cast tests runtime separation as well as the distinct opaque TS brands.
  expect(
    await readCurrentWindowsExplorerFacts(
      capability as unknown as WindowsExplorerApproval,
      host,
      '42',
      { x: 1, y: 1 },
    ),
  ).toBeUndefined();
  expect(
    windowsExplorerPrestartIsCurrent({} as typeof capability, host, '42', list.windowsGeneration!),
  ).toBe(false);
});

it('explorer_list_evidence_cannot_cross_helper_generations', async () => {
  vi.stubGlobal('__SPRINT_CODER_COMPUTER_USE_NATIVE_PIN__', finalPin());
  for (const invalidate of ['helper', 'stop', 'list'] as const) {
    const fixture = explorerHost();
    const list = await fixture.host.listTargets!();
    const capability = readWindowsExplorerPrestart(fixture.host, '42');
    expect(capability).toBeDefined();
    if (invalidate === 'helper') fixture.replaceHelper();
    else if (invalidate === 'stop') fixture.stop();
    else await fixture.host.listTargets!();
    expect(
      windowsExplorerPrestartIsCurrent(capability, fixture.host, '42', list.windowsGeneration!),
    ).toBe(false);
  }
  for (const invalidate of ['helper', 'stop', 'list'] as const) {
    const fixture = explorerHost();
    let complete!: (value: unknown) => void;
    fixture.listTargets.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const pending = fixture.host.listTargets!();
    await vi.waitFor(() => expect(fixture.listTargets).toHaveBeenCalledTimes(1));
    if (invalidate === 'helper') fixture.replaceHelper();
    else if (invalidate === 'stop') fixture.stop();
    else await fixture.host.listTargets!();
    complete(fixture.value);
    await expect(pending).rejects.toThrow('native_target_generation_changed');
    expect(fixture.binding.addon!.startSession).not.toHaveBeenCalled();
  }
});

it('gate off preserves the entire list, ceilings and native call counts', async () => {
  vi.stubGlobal('__SPRINT_CODER_COMPUTER_USE_NATIVE_PIN__', finalPin());
  const fixture = explorerHost(false);
  fixture.value.targets = [
    row(),
    row('upper'),
    explorerRow(),
    { kind: 'denied' },
    { kind: 'unresolvable' },
  ];
  const expected = parseWindowsComputerUseTargets(fixture.value, true)!;
  const result = await fixture.host.listTargets!();
  expect(result.targets).toEqual(expected.targets);
  expect(fixture.listTargets).toHaveBeenCalledTimes(1);
  for (const method of ['listWindows', 'startSession', 'dispatch', 'discoverWindows'] as const)
    expect(fixture.binding.addon![method]).not.toHaveBeenCalled();
  expect(readWindowsExplorerPrestart(fixture.host, '42')).toBeUndefined();
});

it('prestart cancellation during ledger preparation stops before native enumeration', async () => {
  vi.stubGlobal('__SPRINT_CODER_COMPUTER_USE_NATIVE_PIN__', finalPin());
  let complete!: (value: { rows: never[]; quarantines: never[] }) => void;
  const read = vi.fn(
    () =>
      new Promise<{ rows: never[]; quarantines: never[] }>((resolve) => {
        complete = resolve;
      }),
  );
  const fixture = explorerHost(true, true, { read });
  const pending = fixture.host.listTargets!();
  await vi.waitFor(() => expect(read).toHaveBeenCalled());
  fixture.stop();
  complete({ rows: [], quarantines: [] });
  await expect(pending).rejects.toThrow('native_target_generation_changed');
  expect(fixture.listTargets).not.toHaveBeenCalled();
});

it('file and non-file windows of the same Explorer process are judged separately', () => {
  const native = explorerRow();
  const { explorerPrestart: _evidence, ...unmeasured } = native;
  const nonFile = { ...unmeasured, windowId: '43', windowIdentityDigest: 'e'.repeat(64) };
  expect(
    parseWindowsComputerUseTargets(
      envelope([native, nonFile]),
      true,
      createWindowsExplorerPrestartContext(() => true),
    )?.targets.map((target) => target.kind),
  ).toEqual(['selectable', 'denied']);
});

it('explorer list binds the responding helper after lazy start or replacement', async () => {
  vi.stubGlobal('__SPRINT_CODER_COMPUTER_USE_NATIVE_PIN__', finalPin());
  for (const initiallyMissing of [true, false]) {
    const fixture = explorerHost();
    fixture.value.targets.push(row());
    if (initiallyMissing) fixture.missingCapture();
    fixture.listTargets.mockImplementationOnce(() => {
      fixture.replaceHelper();
      fixture.bindResponse();
      return fixture.value;
    });
    const list = await fixture.host.listTargets!();
    expect(list.targets.map((target) => target.kind)).toEqual(['selectable', 'selectable']);
    expect(readWindowsExplorerPrestart(fixture.host, '42')).toBeDefined();
    expect(fixture.listTargets).toHaveBeenCalledTimes(1);
  }
});

it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])(
  'Explorer list requires both switches: prestart=%s exception=%s',
  async (prestart, exception) => {
    vi.stubGlobal('__SPRINT_CODER_COMPUTER_USE_NATIVE_PIN__', finalPin());
    const fixture = explorerHost(prestart, true, {}, exception);
    const list = await fixture.host.listTargets!();
    expect(list.targets[0]?.kind).toBe(prestart && exception ? 'selectable' : 'denied');
    expect(readWindowsExplorerPrestart(fixture.host, '42') !== undefined).toBe(
      prestart && exception,
    );
  },
);

// Controller uses the real Host capability issuer; no boolean substitutes for its WeakMap evidence.
const explorerContext = {
  taskId: 'explorer-task',
  turnId: 'explorer-turn',
  workspaceId: null,
  policyEpoch: 0,
};
async function explorerController(enabled = true, ordinary = false) {
  vi.stubGlobal('__SPRINT_CODER_COMPUTER_USE_NATIVE_PIN__', finalPin());
  const fixture = explorerHost();
  if (ordinary) fixture.value.targets = [row()];
  const list = await fixture.host.listTargets!();
  const candidate = windowsComputerTargetCandidates(list)[0]!;
  const profile = candidate.profile;
  const profiles: ComputerAppProfileRecord[] = [];
  const store = createComputerAppGrantFixtureStore();
  const published: ComputerAppGrantRequest[] = [];
  const persistence: ComputerUseControllerPersistence = {
    ...store.api,
    listComputerAppProfiles: () => profiles,
    getComputerAppProfile: (id) => {
      const found = profiles.find((p) => p.id === id);
      if (!found) throw new Error('profile missing');
      return found;
    },
    createComputerAppProfile: vi.fn(),
    updateComputerAppProfile: vi.fn(),
    removeComputerAppProfile: vi.fn(),
    recordComputerActionAudit: vi.fn(),
    completeComputerActionAudit: vi.fn(),
    recordComputerActionApprovalOutcome: vi.fn(),
    listComputerActionAudits: () => [],
    getActiveTurnId: () => explorerContext.turnId,
    getPermissionPolicy: () => ({ policyEpoch: 0 }),
  };
  const window: ComputerUseNativeWindow = {
    ...candidate.windows[0]!,
    platform: 'win32',
    appIdentityDigest: profile.identityDigest,
    executableDigest: profile.executableDigest,
    revision: 1,
    policyLanguage: 'en',
    focused: true,
    ownerKind: 'application',
    modal: false,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    screenBounds: { x: 0, y: 0, width: 800, height: 600 },
  };
  let windows = [window];
  let beforeWindows: (() => Promise<void> | void) | undefined;
  const discovery = vi
    .spyOn(ComputerUseDiscoveryScope.prototype, 'read')
    .mockImplementation(async () => {
      await beforeWindows?.();
      return windows;
    });
  const start = vi.mocked(fixture.binding.addon!.startSession!);
  const arm = vi.fn(async () => true);
  let mode: ComputerUseEligibilityMode = 'v2-denylist';
  const currentGeneration = vi.fn(fixture.host.isWindowsTargetGenerationCurrent!);
  const controller = new ComputerUseController({
    armEmergencyStop: arm,
    persistence,
    native: ordinary
      ? { ...fixture.host, isWindowsTargetGenerationCurrent: currentGeneration }
      : fixture.host,
    featureEnabled: () => true,
    agentDrivenEnabled: () => true,
    windowsTargetDiscoveryEnabled: () => true,
    effectiveEligibilityMode: () => mode,
    windowsExplorerStartForTesting: enabled,
    currentPolicyEpoch: () => 0,
    providerEgressBindingFor: () => ({ connectionId: 'connection', modelId: 'model' }),
    publishGrantRequest: (card) => published.push(card),
    repositionEmergencyStop: () => true,
  });
  const identity = computerAppGrantIdentityFrom(profile.identity)!;
  const grant = (version = 4) =>
    store.api.createComputerAppGrant({
      identity,
      displayName: 'File Explorer',
      maxMode: 'supervised',
      denyRulesetVersion: version,
      providerEgress: { connectionId: 'connection', modelId: 'model' },
    });
  const targets = async () =>
    (await controller.listTargets({}, explorerContext)).targets.filter(
      (target): target is SelectableComputerTarget => target.kind === 'selectable',
    );
  const approve = async (card: ComputerAppGrantRequest) =>
    controller.resolveAppGrantRequest(
      {
        requestId: card.id,
        expectedRevision: card.revision,
        decision: 'allow_always',
      },
      card.activationIntents.allow_always!,
    );
  const request = (target: SelectableComputerTarget) =>
    controller.requestAccess(
      {
        appToken: target.appToken,
        reason: 'Select a measured folder',
      },
      explorerContext,
    );
  const card = async () => {
    await vi.waitFor(() => expect(published.some((p) => p.state === 'pending')).toBe(true));
    return published.find((p) => p.state === 'pending')!;
  };
  return {
    ...fixture,
    controller,
    profile,
    profiles,
    identity,
    store,
    persistence,
    published,
    window,
    targets,
    grant,
    approve,
    request,
    card,
    start,
    discovery,
    arm,
    currentGeneration,
    setWindows: (value: ComputerUseNativeWindow[]) => {
      windows = value;
    },
    beforeWindows: (hook: () => Promise<void> | void) => {
      beforeWindows = hook;
    },
    setMode: (value: ComputerUseEligibilityMode) => {
      mode = value;
    },
  };
}

it('explorer_registration_stays_denied', async () => {
  const f = await explorerController();
  expect(() =>
    f.controller.registerProfile({
      label: 'File Explorer',
      identity: explorerRow().identity,
      mode: 'supervised',
      connectionId: 'connection',
      modelId: 'model',
      providerEgressConsent: true,
      remember: true,
    }),
  ).toThrow(/cannot register/);
  expect(f.persistence.createComputerAppProfile).not.toHaveBeenCalled();
});

it.each([1, 4, 5, 6])('temporary_capability_loss_does_not_delete_grant (%s)', async (version) => {
  const f = await explorerController();
  const saved = f.grant(version);
  f.replaceHelper();
  expect(f.controller.appGrantFor(f.profile)?.id ?? null).toBe(version > 5 ? null : saved.id);
  expect(f.controller.listAppGrants().grants).toEqual([saved]);
  expect(f.store.grants.get(saved.id)).toEqual(saved);
});

it('explorer_grant_requires_reverified_card_context', async () => {
  const f = await explorerController();
  expect(() =>
    f.controller.createAppGrant(f.identity, {
      maxMode: 'supervised',
      providerEgress: null,
    }),
  ).toThrow(/cannot be granted/);
  const target = (await f.targets())[0]!;
  const pending = f.request(target);
  await f.approve(await f.card());
  expect(await pending).toEqual({ granted: true, reasonCode: null });
  expect(f.store.grants.size).toBe(1);
  expect(() =>
    f.controller.createAppGrant(f.identity, {
      maxMode: 'supervised',
      providerEgress: null,
    }),
  ).toThrow(/cannot be granted/);
});

it('app_grant_and_window_eligibility_are_separate', async () => {
  const f = await explorerController();
  const target = (await f.targets())[0]!;
  expect(target.granted).toBe(false);
  await expect(
    f.controller.startForAgent(
      { targetToken: target.targetToken, goal: 'folder' },
      explorerContext,
    ),
  ).rejects.toThrow(/access_not_granted/);
  const saved = f.grant();
  const granted = (await f.targets())[0]!;
  expect(granted.granted).toBe(true);
  f.replaceHelper();
  expect(f.controller.appGrantFor(f.profile)).toEqual(saved);
  await expect(
    f.controller.startForAgent(
      { targetToken: granted.targetToken, goal: 'folder' },
      explorerContext,
    ),
  ).rejects.toThrow(/target token is not valid/);
  expect(f.start).not.toHaveBeenCalled();
});

it('saved_explorer_profile_cannot_bypass_v2_discovery', async () => {
  const f = await explorerController();
  f.profiles.push(f.profile);
  f.value.targets = [];
  expect(await f.targets()).toEqual([]);
  expect(f.discovery).not.toHaveBeenCalled();
});

it('explorer_snapshot_requires_current_window_evidence', async () => {
  const f = await explorerController();
  const target = (await f.targets())[0]!;
  expect(f.controller.targetTokenBinding(target.targetToken)).not.toBeNull();
  f.stop();
  expect(f.controller.targetTokenBinding(target.targetToken)).toBeNull();
  expect(f.start).not.toHaveBeenCalled();
});

it('already_granted_explorer_still_requires_current_candidate', async () => {
  const f = await explorerController();
  const saved = f.grant();
  const target = (await f.targets())[0]!;
  expect(await f.request(target)).toEqual({ granted: true, reasonCode: null });
  f.replaceHelper();
  expect(await f.request(target)).toEqual({
    granted: false,
    reasonCode: 'access_request_invalid_token',
  });
  expect(f.published).toHaveLength(0);
  expect(f.store.grants.get(saved.id)).toEqual(saved);
});

it('explorer_card_requires_eligible_window_and_rechecks_on_answer', async () => {
  const f = await explorerController();
  const target = (await f.targets())[0]!;
  const pending = f.request(target);
  const card = await f.card();
  f.beforeWindows(() => f.replaceHelper());
  await f.approve(card);
  expect(await pending).toEqual({ granted: false, reasonCode: 'access_request_withdrawn' });
  expect(f.store.grants.size).toBe(0);
  expect(f.start).not.toHaveBeenCalled();
});

it('explorer_start_rejects_evidence_from_another_window', async () => {
  const f = await explorerController();
  f.grant();
  const target = (await f.targets())[0]!;
  f.setWindows([{ ...f.window, windowId: '43', windowIdentityDigest: 'e'.repeat(64) }]);
  await expect(
    f.controller.startForAgent(
      { targetToken: target.targetToken, goal: 'folder' },
      explorerContext,
    ),
  ).rejects.toThrow(/identity changed/);
  expect(f.start).not.toHaveBeenCalled();
});

it.each([1, 2, 3])('explorer_start_rechecks_evidence_around_awaits (%s)', async (boundary) => {
  const f = await explorerController();
  f.grant();
  const target = (await f.targets())[0]!;
  let calls = 0;
  f.beforeWindows(() => {
    if (++calls === boundary) f.replaceHelper();
  });
  await expect(
    f.controller.startForAgent(
      { targetToken: target.targetToken, goal: 'folder' },
      explorerContext,
    ),
  ).rejects.toThrow(/target token is not valid|target generation changed/);
  expect(f.start).not.toHaveBeenCalled();
});

it('explorer_common_start_rejects_panel_and_v1', async () => {
  const f = await explorerController();
  f.profiles.push(f.profile);
  await expect(
    f.controller.start({
      taskId: explorerContext.taskId,
      turnId: explorerContext.turnId,
      profileId: f.profile.id,
      windowId: '42',
      mode: 'supervised',
      connectionId: 'connection',
      modelId: 'model',
      providerEgressConsent: true,
      providerEgressConsentBinding: {
        connectionId: 'connection',
        modelId: 'model',
      },
      remember: false,
      expectedPolicyEpoch: 0,
      expectedWindowRevision: 1,
      expectedProfileRevision: 1,
    }),
  ).rejects.toThrow(/cannot target/);
  expect(f.start).not.toHaveBeenCalled();
});

it('explorer_path_exception_does_not_relax_other_denials', () => {
  vi.stubGlobal('__SPRINT_CODER_COMPUTER_USE_NATIVE_PIN__', finalPin());
  const identity = { ...explorerRow().identity, signerMicrosoftRoot: true };
  expect(computerUseAppIdentityIsPermanentlyDenied(identity, true)).toBe(false);
  for (const change of [
    { executablePath: 'C:\\Windows\\cmd.exe' },
    { appUserModelId: 'windowsterminal' },
    { displayName: 'Settings' },
    { signerDigest: null },
    { signerMicrosoftRoot: false },
    { signerMicrosoftRoot: undefined },
    { executablePath: 'C:\\Users\\u\\Downloads\\explorer.exe' },
    { executablePath: 'C:\\Windows\\System32\\explorer.exe' },
    { executablePath: 'C:\\Windows.old\\explorer.exe' },
  ])
    expect(computerUseAppIdentityIsPermanentlyDenied({ ...identity, ...change }, true)).toBe(true);
});

it('explorer_permanent_exception_requires_the_actual_windows_directory', () => {
  vi.stubGlobal('__SPRINT_CODER_COMPUTER_USE_NATIVE_PIN__', finalPin());
  const identity = { ...explorerRow().identity, signerMicrosoftRoot: true };
  vi.stubEnv('WINDIR', 'D:\\WinNT');
  expect(computerUseAppIdentityIsPermanentlyDenied(identity, true)).toBe(true);
  expect(
    computerUseAppIdentityIsPermanentlyDenied(
      {
        ...identity,
        executablePath: 'd:\\wInNt\\EXPLORER.EXE',
      },
      true,
    ),
  ).toBe(false);
  vi.stubEnv('WINDIR', '');
  expect(computerUseAppIdentityIsPermanentlyDenied(identity, true)).toBe(true);
});

it('ordinary_gate_off_start_preserves_base_host_query_count', async () => {
  const f = await explorerController(false, true);
  f.grant();
  const target = (await f.targets())[0]!;
  const current = f.currentGeneration.mockClear();
  f.arm.mockRejectedValueOnce(new Error('common start reached'));
  await expect(
    f.controller.startForAgent(
      { targetToken: target.targetToken, goal: 'editor' },
      explorerContext,
    ),
  ).rejects.toThrow('common start reached');
  // W3a's token, grant and await-boundary checks make nine queries before the overlay.
  // The Explorer-only second token check must not add a tenth query for ordinary apps.
  expect(current).toHaveBeenCalledTimes(9);
  expect(f.start).not.toHaveBeenCalled();
});

it('file_explorer_label_is_not_identity_evidence', () => {
  vi.stubGlobal('__SPRINT_CODER_COMPUTER_USE_NATIVE_PIN__', finalPin());
  expect(
    computerUseAppIdentityIsPermanentlyDenied(
      { ...row().identity, displayName: 'File Explorer' },
      true,
    ),
  ).toBe(true);
  expect(
    computerUseAppIdentityIsPermanentlyDenied(
      { ...explorerRow().identity, displayName: 'File Explorer' },
      false,
    ),
  ).toBe(true);
});

it('explorer_gate_off_retains_unusable_grant_without_native_calls', async () => {
  const f = await explorerController(false);
  const saved = f.grant();
  expect(await f.targets()).toEqual([]);
  expect(f.published).toEqual([]);
  expect(f.discovery).not.toHaveBeenCalled();
  expect(f.start).not.toHaveBeenCalled();
  expect(f.store.grants.get(saved.id)).toEqual(saved);
  expect(f.controller.appGrantFor(f.profile)).toEqual(saved);
  expect(f.store.grants.get(saved.id)).toEqual(saved);
});

it('explorer_build_mismatch_retains_unusable_grant', async () => {
  const f = await explorerController();
  const saved = f.grant();
  const target = (await f.targets())[0]!;
  vi.stubGlobal('__SPRINT_CODER_COMPUTER_USE_NATIVE_PIN__', {
    ...finalPin(),
    eligibility: { ...finalPin().eligibility, rulesetVersion: 4 },
  });
  expect(f.controller.appGrantFor(f.profile)).toEqual(saved);
  expect(await f.targets()).toEqual([]);
  expect(await f.request(target)).toEqual({
    granted: false,
    reasonCode: 'access_request_invalid_token',
  });
  expect(f.store.grants.get(saved.id)).toEqual(saved);
  expect(f.start).not.toHaveBeenCalled();
  vi.stubGlobal('__SPRINT_CODER_COMPUTER_USE_NATIVE_PIN__', finalPin());
  expect((await f.targets())[0]?.granted).toBe(true);
  expect(f.controller.appGrantFor(f.profile)).toEqual(saved);
});

it('eligible_explorer_reaches_common_start_after_approval', async () => {
  const f = await explorerController();
  const target = (await f.targets())[0]!;
  const pending = f.request(target);
  await f.approve(await f.card());
  expect(await pending).toEqual({ granted: true, reasonCode: null });
  f.arm.mockRejectedValueOnce(new Error('verified common start reached'));
  await expect(
    f.controller.startForAgent(
      { targetToken: target.targetToken, goal: 'folder' },
      explorerContext,
    ),
  ).rejects.toThrow('verified common start reached');
  expect(f.arm).toHaveBeenCalledOnce();
  expect(f.discovery).toHaveBeenCalledTimes(5);
  expect(f.start).not.toHaveBeenCalled();
});

it('explorer_rechecks_after_the_stop_overlay_await', async () => {
  const f = await explorerController();
  f.grant();
  const target = (await f.targets())[0]!;
  f.arm.mockImplementationOnce(async () => {
    f.replaceHelper();
    return true;
  });
  await expect(
    f.controller.startForAgent(
      { targetToken: target.targetToken, goal: 'folder' },
      explorerContext,
    ),
  ).rejects.toThrow(/target token is not valid/);
  expect(f.arm).toHaveBeenCalledOnce();
  expect(f.start).not.toHaveBeenCalled();
});

it.each(['missing', 'cancelled', 'old-epoch', 'new-list'] as const)(
  'explorer_current_evidence_is_required_with_a_saved_grant: %s',
  async (state) => {
    const f = await explorerController();
    const saved = f.grant();
    const target = (await f.targets())[0]!;
    if (state === 'missing') f.loseCapability();
    else if (state === 'cancelled') f.stop();
    else if (state === 'old-epoch') f.replaceHelper();
    else await f.host.listTargets!();
    expect(await f.request(target)).toEqual({
      granted: false,
      reasonCode: 'access_request_invalid_token',
    });
    expect(f.controller.appGrantFor(f.profile)).toEqual(saved);
    expect(f.store.grants.get(saved.id)).toEqual(saved);
    expect(f.published).toEqual([]);
    expect(f.start).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  'explorer_denies_fake_and_non_file_windows (enabled=%s)',
  async (enabled) => {
    const f = await explorerController(enabled);
    const native = explorerRow();
    const { explorerPrestart: _prestart, ...nonFile } = native;
    f.value.targets = [nonFile];
    expect(await f.targets()).toEqual([]);
    f.value.targets = [{ ...native, facts: { ...native.facts, signerMicrosoftRoot: false } }];
    expect(await f.targets()).toEqual([]);
    expect(f.published).toEqual([]);
    expect(f.start).not.toHaveBeenCalled();
  },
);

it.each([undefined, 1, 4, 5, 6])(
  'explorer_grant_versions_keep_their_existing_meaning (%s)',
  async (version) => {
    const f = await explorerController();
    const saved = version === undefined ? undefined : f.grant(version);
    const target = (await f.targets())[0]!;
    expect(target.mode).toBe('supervised');
    expect(target.granted).toBe(version !== undefined && version <= 5);
    if (saved !== undefined) expect(f.store.grants.get(saved.id)).toEqual(saved);
    if (version === undefined || version === 6) {
      const pending = f.request(target);
      await f.approve(await f.card());
      expect(await pending).toEqual({ granted: true, reasonCode: null });
      expect(f.controller.appGrantFor(f.profile)?.denyRulesetVersion).toBe(5);
      expect(f.store.grants.size).toBe(1);
    }
  },
);

it('explorer_permanent_denial_still_revokes_the_grant', async () => {
  const f = await explorerController();
  const saved = f.grant();
  expect(
    f.controller.appGrantFor({
      ...f.profile,
      identity: {
        ...f.profile.identity,
        displayName: 'Settings',
      },
    }),
  ).toBeNull();
  expect(f.store.grants.has(saved.id)).toBe(false);
});

it('explorer_v1_cannot_reuse_a_v2_candidate', async () => {
  const f = await explorerController();
  f.grant();
  const target = (await f.targets())[0]!;
  f.setMode('v1-allowlist');
  expect(await f.request(target)).toEqual({
    granted: false,
    reasonCode: 'access_request_invalid_token',
  });
  await expect(
    f.controller.startForAgent(
      { targetToken: target.targetToken, goal: 'folder' },
      explorerContext,
    ),
  ).rejects.toThrow(/target token is not valid/);
  expect(f.published).toEqual([]);
  expect(f.start).not.toHaveBeenCalled();
});

it('quarantined_explorer_has_no_prestart_capability_or_candidate', async () => {
  vi.stubGlobal('__SPRINT_CODER_COMPUTER_USE_NATIVE_PIN__', finalPin());
  const f = explorerHost(
    true,
    true,
    {
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
    true,
    { checkTargetIdentity: async () => [{ result: 'alive' }] },
  );
  const list = await f.host.listTargets!();
  expect(list.targets).toEqual([{ kind: 'denied' }]);
  expect(windowsComputerTargetCandidates(list)).toEqual([]);
  expect(readWindowsExplorerPrestart(f.host, '42')).toBeUndefined();
  expect(f.binding.addon!.startSession).not.toHaveBeenCalled();
});
