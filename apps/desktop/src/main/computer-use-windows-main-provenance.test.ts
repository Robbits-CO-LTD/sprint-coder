import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computerUseNativeManifestSchema } from '@sprint-coder/contracts';
import { computerUseNativeCompiledPin } from './computer-use-native-provenance';
import { loadWindowsMainAddon } from './computer-use-windows-main';

const load = vi.hoisted(() =>
  vi.fn(() => ({ readMainIdentity: vi.fn(), createHelperPermit: vi.fn() })),
);
vi.mock('node:module', () => ({ createRequire: () => load }));
const addonName = 'sprint_coder_computer_use_windows_main.node';
const digest = createHash('sha256').update('addon').digest('hex');
const manifest = computerUseNativeManifestSchema.parse({
  version: 1,
  sourceCommit: 'a'.repeat(40),
  platform: 'win32',
  architecture: 'x64',
  protocolVersion: 1,
  apiVersion: 3,
  nativeVersion: 'fixture',
  moduleDigest: 'b'.repeat(64),
  binaryDigest: 'b'.repeat(64),
  signerDigest: null,
  capabilities: ['observe'],
  windowsMainAddon: { kind: 'windows-main-addon', file: addonName, sha256: digest },
});

afterEach(() => {
  vi.unstubAllGlobals();
  load.mockClear();
});
describe('Windows Main addon pre-load provenance', () => {
  it.each([
    'valid',
    'tampered',
    'missing',
    'no-entry',
    'changed-manifest',
    'no-pin',
    'undefined-pin',
    'coherent-tampering',
  ] as const)(
    'validates the compiled provenance pin before allowing Windows Main addon loading: %s',
    (scenario) => {
      const root = mkdtempSync(join(tmpdir(), 'sc-main-addon-'));
      try {
        const candidate = { ...manifest };
        if (scenario === 'coherent-tampering')
          candidate.windowsMainAddon = {
            ...manifest.windowsMainAddon!,
            sha256: createHash('sha256').update('changed').digest('hex'),
          };
        if (scenario === 'no-entry') delete candidate.windowsMainAddon;
        if (scenario === 'changed-manifest') candidate.sourceCommit = 'c'.repeat(40);
        writeFileSync(join(root, 'computer-use-native.manifest.json'), JSON.stringify(candidate));
        if (scenario !== 'missing')
          writeFileSync(
            join(root, addonName),
            scenario === 'tampered' || scenario === 'coherent-tampering' ? 'changed' : 'addon',
          );
        vi.stubGlobal(
          '__SPRINT_CODER_COMPUTER_USE_NATIVE_PIN__',
          scenario === 'undefined-pin'
            ? undefined
            : scenario === 'no-pin'
              ? null
              : computerUseNativeCompiledPin(manifest),
        );
        const attempt = () =>
          loadWindowsMainAddon(join(root, 'sprint-coder-computer-use-host.exe'));
        if (scenario === 'valid') {
          expect(attempt().readMainIdentity).toBeTypeOf('function');
          expect(load).toHaveBeenCalledExactlyOnceWith(join(root, addonName));
        } else {
          expect(attempt).toThrow(
            scenario === 'no-pin' || scenario === 'undefined-pin'
              ? 'Computer Use native compile pin is unavailable'
              : scenario === 'missing'
                ? 'ENOENT'
                : scenario === 'tampered'
                  ? 'Windows Main addon digest mismatch'
                  : 'Windows Main addon provenance mismatch',
          );
          expect(load).not.toHaveBeenCalled();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it('binds the addon entry into the compiled pin and restricts it to Windows and a fixed filename', () => {
    expect(computerUseNativeCompiledPin(manifest).manifestDigest).not.toBe(
      computerUseNativeCompiledPin({
        ...manifest,
        windowsMainAddon: { ...manifest.windowsMainAddon!, sha256: 'c'.repeat(64) },
      }).manifestDigest,
    );
    expect(
      computerUseNativeManifestSchema.safeParse({ ...manifest, platform: 'darwin' }).success,
    ).toBe(false);
    expect(
      computerUseNativeManifestSchema.safeParse({
        ...manifest,
        windowsMainAddon: { ...manifest.windowsMainAddon, file: '../other.node' },
      }).success,
    ).toBe(false);
  });
});
