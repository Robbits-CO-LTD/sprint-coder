import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMPUTER_USE_NATIVE_FEATURE_FLAG,
  evaluateComputerUseNativeGate,
  loadComputerUseNative,
  parseComputerUseNativeManifest,
} from './computer-use-native';
import { computerUseNativeCompiledPin } from './computer-use-native-provenance';

const sha256 = (character: string): string => character.repeat(64);
const commit = (character: string): string => character.repeat(40);

describe('Computer Use native compiled provenance', () => {
  it('rejects a same-signer helper/manifest rollback against the signed Main pin', () => {
    const manifest = {
      version: 1,
      sourceCommit: commit('a'),
      platform: 'win32',
      architecture: 'x64',
      protocolVersion: 1,
      apiVersion: 1,
      nativeVersion: 'computer-use-native-gate0-1',
      moduleDigest: sha256('b'),
      binaryDigest: sha256('b'),
      signerDigest: sha256('c'),
      capabilities: ['observe', 'capture', 'accessibility', 'input'],
    } as const;

    const result = evaluateComputerUseNativeGate({
      featureFlag: true,
      packaged: true,
      platform: 'win32',
      manifest,
      probe: {
        protocolVersion: 1,
        apiVersion: 1,
        sourceCommit: commit('a'),
        available: true,
        backend: 'windows-uia-graphics-capture-sendinput',
      },
      artifactDigest: manifest.binaryDigest,
      compiledPin: {
        version: 1,
        sourceCommit: commit('d'),
        platform: 'win32',
        architecture: 'x64',
        artifactDigest: sha256('e'),
        manifestDigest: sha256('f'),
      },
    });

    expect(result).toMatchObject({ available: false, reason: 'COMPILED_PROVENANCE_MISMATCH' });
  });

  it('loads only the exact packaged Windows artifact bound into Main', () => {
    const root = mkdtempSync(join(tmpdir(), 'sprint-coder-computer-use-provenance-'));
    try {
      const resources = join(root, 'resources');
      const dirname = join(root, 'app.asar', '.vite', 'build');
      const artifactPath = join(resources, 'sprint-coder-computer-use-host.exe');
      const artifact = Buffer.from('signed-helper-fixture');
      const artifactDigest = createDigest(artifact);
      mkdirSync(resources, { recursive: true });
      mkdirSync(dirname, { recursive: true });
      writeFileSync(artifactPath, artifact);
      const manifest = parseComputerUseNativeManifest({
        version: 1,
        sourceCommit: commit('a'),
        platform: 'win32',
        architecture: 'x64',
        protocolVersion: 1,
        apiVersion: 1,
        nativeVersion: 'computer-use-native-gate0-1',
        moduleDigest: artifactDigest,
        binaryDigest: artifactDigest,
        signerDigest: sha256('c'),
        capabilities: ['observe', 'capture', 'accessibility', 'input'],
      });
      writeFileSync(join(resources, 'computer-use-native.manifest.json'), JSON.stringify(manifest));
      let probed = 0;
      const load = (compiledPin: ReturnType<typeof computerUseNativeCompiledPin>) =>
        loadComputerUseNative({
          environment: { [COMPUTER_USE_NATIVE_FEATURE_FLAG]: '1' },
          dirname,
          resourcesPath: resources,
          platform: 'win32',
          architecture: 'x64',
          compiledPin,
          verifySignature: () => sha256('c'),
          probeHelper: () => {
            probed += 1;
            return {
              protocolVersion: 1,
              apiVersion: 1,
              sourceCommit: commit('a'),
              platform: 'win32',
              napiVersion: 10,
              available: true,
              backend: 'windows-uia-graphics-capture-sendinput',
            };
          },
        });

      expect(load(computerUseNativeCompiledPin(manifest)).probe.available).toBe(true);
      expect(probed).toBe(1);
      expect(
        load({ ...computerUseNativeCompiledPin(manifest), artifactDigest: sha256('d') }).probe,
      ).toMatchObject({ available: false, reason: 'COMPILED_PROVENANCE_MISMATCH' });
      expect(probed).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps Windows maximum mode positive-only and emits authoritative display bounds', () => {
    const source = readFileSync(
      resolve(__dirname, '../../computer-use-native/computer_use_windows_host.cc'),
      'utf8',
    );

    expect(source).toContain('sprint-coder-computer-use-fixture.exe');
    expect(source).toContain('Microsoft Corporation');
    expect(source).toContain('IsTrustedSystemNotepad');
    expect(source).toContain('GetSystemDirectoryW');
    expect(source).toContain('\\"maximumMode\\"');
    expect(source).toContain('\\"screenBounds\\"');
    expect(source).toContain('ClientBoundsPhysical(window, bounds)');
    expect(source.match(/\\"screenBounds\\"/gu)?.length).toBeGreaterThanOrEqual(3);
    const modePolicy = source.slice(
      source.indexOf('std::string MaximumModeForWindowsExecutable('),
      source.indexOf('bool ScreenBoundsPhysicalForWindow('),
    );
    expect(modePolicy).toContain('IsTrustedSystemNotepad(identity)');
    expect(modePolicy).toContain('IsAcceptanceFixtureExecutable(identity.path)');
    expect(modePolicy).toContain('identity.signer_digest == helper_signer');
    expect(modePolicy).toContain('return "observe_only"');
    expect(modePolicy.match(/return "full_access_app"/gu)).toHaveLength(2);
    expect(modePolicy).not.toContain('display_name');
  });

  it('rejects an arbitrary signed-looking Acme executable at every Windows attach boundary', () => {
    const source = readFileSync(
      resolve(__dirname, '../../computer-use-native/computer_use_windows_host.cc'),
      'utf8',
    );
    const picker = source.slice(
      source.indexOf('bool PickWindowsExecutable('),
      source.indexOf('bool SameWindowsPath('),
    );
    const list = source.slice(
      source.indexOf('bool ListWindowsForIdentity('),
      source.indexOf('std::string FrameIdKey('),
    );
    const start = source.slice(
      source.indexOf('bool StartWindowsSession('),
      source.indexOf('bool CloseWindowsSession('),
    );

    for (const boundary of [picker, list, start])
      expect(boundary).toContain('IsSupportedWindowsV1Target');
    const eligibility = source.slice(
      source.indexOf('bool IsSupportedWindowsV1Target('),
      source.indexOf('bool ScreenBoundsPhysicalForWindow('),
    );
    expect(eligibility).toContain('MaximumModeForWindowsExecutable(identity) == "full_access_app"');
    expect(eligibility).not.toContain('Acme.exe');
  });
});

function createDigest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
