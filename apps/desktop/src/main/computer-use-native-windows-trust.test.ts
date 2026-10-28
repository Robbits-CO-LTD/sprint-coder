import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WindowsComputerUseHelperTrust } from './computer-use-native-windows';

const captured: WindowsComputerUseHelperTrust[] = [];

vi.mock('./computer-use-native-windows', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    createWindowsComputerUseNativeAddon: (
      helperPath: string,
      probe: unknown,
      trust: WindowsComputerUseHelperTrust,
    ) => {
      captured.push(trust);
      return (original['createWindowsComputerUseNativeAddon'] as (...input: unknown[]) => unknown)(
        helperPath,
        probe,
        trust,
      );
    },
  };
});

const { COMPUTER_USE_NATIVE_FEATURE_FLAG, loadComputerUseNative } =
  await import('./computer-use-native');

const roots: string[] = [];
afterEach(() => {
  captured.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const V1 = {
  mode: 'v1-allowlist',
  rulesetVersion: 1,
  classifierVersion: 1,
  lexiconVersion: 1,
  ticketRequired: false,
};

function load(eligibility: Record<string, unknown> | undefined) {
  const root = mkdtempSync(join(tmpdir(), 'sprint-coder-computer-use-trust-'));
  roots.push(root);
  const resources = join(root, 'resources');
  const packagedDirname = join(root, 'app.asar', '.vite', 'build');
  mkdirSync(packagedDirname, { recursive: true });
  mkdirSync(resources, { recursive: true });
  const bytes = Buffer.from('trusted-native-fixture');
  writeFileSync(join(resources, 'sprint-coder-computer-use-host.exe'), bytes);
  const digest = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(
    join(resources, 'computer-use-native.manifest.json'),
    JSON.stringify({
      version: 1,
      sourceCommit: 'f'.repeat(40),
      platform: 'win32',
      architecture: 'x64',
      protocolVersion: 1,
      apiVersion: 3,
      nativeVersion: 'computer-use-native-gate0-1',
      moduleDigest: digest,
      binaryDigest: digest,
      signerDigest: 'a'.repeat(64),
      capabilities: ['observe', 'capture', 'accessibility', 'input'],
      ...(eligibility === undefined ? {} : { eligibility }),
    }),
  );
  return loadComputerUseNative({
    environment: { [COMPUTER_USE_NATIVE_FEATURE_FLAG]: '1' },
    dirname: packagedDirname,
    resourcesPath: resources,
    platform: 'win32',
    architecture: 'x64',
    probeHelper: () => ({
      protocolVersion: 1,
      apiVersion: 3,
      platform: 'win32',
      napiVersion: 10,
      sourceCommit: 'f'.repeat(40),
      backend: 'windows-uia-graphics-capture-sendinput',
      architecture: 'x64',
      available: true,
      reason: 'READY',
      capabilities: {
        observe: true,
        control: true,
        uiAutomation: true,
        graphicsCapture: true,
        sendInput: true,
      },
      ...(eligibility === undefined ? {} : { eligibility }),
    }),
    verifySignature: () => 'a'.repeat(64),
  });
}

describe('the Windows helper trust the loader hands to the pipe client (D7)', () => {
  it('carries the manifest eligibility, so the pipe handshake is checked against it', () => {
    const binding = load(V1);
    expect(binding.probe.available).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      sourceCommit: 'f'.repeat(40),
      eligibility: V1,
    });
  });

  it('carries no eligibility for a manifest that declares none', () => {
    const binding = load(undefined);
    expect(binding.probe.available).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]).not.toHaveProperty('eligibility');
  });
});
