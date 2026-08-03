import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
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
  it('publishes every Windows and macOS auto-update artifact', () => {
    const workflow = readFileSync(
      resolve(__dirname, '../../.github/workflows/release-beta.yml'),
      'utf8',
    );

    expect(workflow).toContain('apps/desktop/out/make/**/*.zip');
    expect(workflow).toContain('apps/desktop/out/make/squirrel.windows/**/*.nupkg');
    expect(workflow).toContain('apps/desktop/out/make/squirrel.windows/**/RELEASES');
    expect(workflow).toContain('mac_zip_count != 1');
    expect(workflow).toContain('windows_zip_count != 1');
    expect(workflow).toContain('release-assets/RELEASES.json');
    expect(workflow).toContain('${#assets[@]} != 6');
    expect(workflow).toMatch(/release:\n[\s\S]*?- name: Checkout\n\s+uses: actions\/checkout@v7/);
  });

  it('generates a Squirrel.Mac manifest that targets the release ZIP', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'sprint-coder-update-'));
    try {
      const zipPath = resolve(directory, 'Sprint-Coder-darwin-arm64-0.0.1-beta.5.zip');
      const outputPath = resolve(directory, 'RELEASES.json');
      writeFileSync(zipPath, 'fixture');
      execFileSync(process.execPath, [
        resolve(__dirname, 'scripts/create-macos-update-manifest.mjs'),
        '--version',
        '0.0.1-beta.5',
        '--tag',
        'v0.0.1-beta.5',
        '--repository',
        'Robbits-CO-LTD/sprint-coder',
        '--zip',
        zipPath,
        '--output',
        outputPath,
      ]);

      expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toMatchObject({
        currentRelease: '0.0.1-beta.5',
        releases: [
          {
            version: '0.0.1-beta.5',
            updateTo: {
              version: '0.0.1-beta.5',
              url: 'https://github.com/Robbits-CO-LTD/sprint-coder/releases/download/v0.0.1-beta.5/Sprint-Coder-darwin-arm64-0.0.1-beta.5.zip',
            },
          },
        ],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
