import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  computerWindowsTargetFactsSchema,
  type ComputerUseEligibilityMode,
  type ComputerWindowsNativeTargetList,
} from '@sprint-coder/contracts';
import { parseWindowsComputerUseTargets } from './computer-use-native-targets';
import { createComputerUseNativeHost } from './computer-use-native-host';
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
  return { generation: 4_503_599_627_370_000, rulesetVersion: 2, truncated: true, targets };
}

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
        rulesetVersion: 2,
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
      capabilities: { observe: true, control: true },
    },
    artifactPath: 'C:\\Resources\\helper.exe',
    addon: {
      probe: () => ({}),
      pickApplication: () => null,
      listWindows: vi.fn(() => []),
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
