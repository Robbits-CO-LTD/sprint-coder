import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import config, { assertNativePackagingHost, verifyBundledNodeResources } from './forge.config';

describe('desktop package icon', () => {
  it('points Electron Packager at real macOS and Windows icon files', () => {
    const iconPath = resolve(__dirname, 'assets', 'sprint-coder-icon');

    expect(config.packagerConfig?.icon).toBe(iconPath);
    expect(existsSync(`${iconPath}.icns`)).toBe(true);
    expect(existsSync(`${iconPath}.ico`)).toBe(true);
    expect(readFileSync(`${iconPath}.icns`).subarray(0, 4).toString('ascii')).toBe('icns');
    expect([...readFileSync(`${iconPath}.ico`).subarray(0, 4)]).toEqual([0, 0, 1, 0]);
  });
});

describe('native package target', () => {
  it('rejects cross-platform packages before Forge can emit an incomplete artifact', () => {
    const otherPlatform = process.platform === 'win32' ? 'linux' : 'win32';

    expect(() => assertNativePackagingHost(process.platform)).not.toThrow();
    expect(() => assertNativePackagingHost(otherPlatform)).toThrow(
      'Cross-platform packaging is unsupported',
    );
  });

  it.runIf(process.platform === 'win32')(
    'accepts only the pinned signed Node executable used by Windows packages',
    () => {
      expect(() => verifyBundledNodeResources()).not.toThrow();
    },
  );
});

describe('beta release artifacts', () => {
  it('uploads and publishes the portable Windows ZIP alongside the installer', () => {
    const workflow = readFileSync(
      resolve(__dirname, '../../.github/workflows/release-beta.yml'),
      'utf8',
    );

    expect(workflow).toContain('apps/desktop/out/make/**/*.zip');
    expect(workflow).toContain("-name '*.exe' -o -name '*.zip'");
    expect(workflow).toContain('zip_count != 1');
    expect(workflow).toContain('${#assets[@]} != 3');
  });
});
