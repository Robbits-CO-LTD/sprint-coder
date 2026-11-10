import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ResolvedForgeConfig } from '@electron-forge/shared-types';
import config, {
  copyDesktopControlBinary,
  desktopControlResources,
  desktopControlSource,
  assertNativePackagingHost,
  createDMGContents,
  DMG_BACKGROUND_PATH,
  DMG_ICON_SIZE,
  DMG_WINDOW_SIZE,
  resolveWindowsSignOptions,
  NATIVE_ASAR_UNPACK_GLOB,
  refreshPackagedSandboxRunnerDigest,
  shouldIgnoreFromPackage,
  verifyDesktopControlBinary,
  verifyBundledNodeResources,
} from './forge.config';
import viteMainConfig, { macAutoUpdateEligibleForIdentity } from './vite.main.config';
import { planWindowsWizardInstaller, SQUIRREL_SETUP_EXE } from './windows-wizard-installer';
import {
  probeSandboxRunner,
  sandboxRunnerPath,
  verifySandboxRunnerDigest,
} from './src/main/sandbox-runner';

// The binary's path inside the npm package it ships from.
const DESKTOP_CONTROL_SOURCE = resolve(
  __dirname,
  '..',
  '..',
  'node_modules',
  'agent-desktop',
  'bin',
  'agent-desktop-win32-x64.exe',
);

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

describe('macOS DMG presentation', () => {
  it('uses branded standard and Retina backgrounds with a balanced drag-to-install layout', () => {
    const retinaBackground = DMG_BACKGROUND_PATH.replace(/\.png$/, '@2x.png');
    const background = readFileSync(DMG_BACKGROUND_PATH);
    const retina = readFileSync(retinaBackground);
    const pngDimensions = (png: Buffer) => ({
      width: png.readUInt32BE(16),
      height: png.readUInt32BE(20),
    });

    expect([...background.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect([...retina.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(pngDimensions(background)).toEqual(DMG_WINDOW_SIZE);
    expect(pngDimensions(retina)).toEqual({ width: 1316, height: 996 });
    expect(DMG_ICON_SIZE).toBe(112);
    expect(createDMGContents('/tmp/Sprint Coder.app')).toEqual([
      { x: 190, y: 300, type: 'file', path: '/tmp/Sprint Coder.app' },
      { x: 468, y: 300, type: 'link', path: '/Applications' },
    ]);
  });
});

describe('native package target', () => {
  it('unpacks versioned Linux shared libraries required by Sharp', () => {
    expect(NATIVE_ASAR_UNPACK_GLOB).toContain('so.*');
    expect(config.packagerConfig?.asar).toEqual({ unpack: NATIVE_ASAR_UNPACK_GLOB });
  });

  it('rejects cross-platform packages before Forge can emit an incomplete artifact', () => {
    const otherPlatform = process.platform === 'win32' ? 'linux' : 'win32';

    expect(() => assertNativePackagingHost(process.platform)).not.toThrow();
    expect(() => assertNativePackagingHost(otherPlatform)).toThrow(
      'Cross-platform packaging is unsupported',
    );
  });

  it('excludes the retired model runtime while retaining native packaging hooks', () => {
    expect(config.packagerConfig?.extraResource).not.toEqual(
      expect.arrayContaining([expect.stringContaining('managed-local')]),
    );
    expect(shouldIgnoreFromPackage('/managed-local/build/legacy-runtime')).toBe(true);
    expect(typeof config.hooks?.postPackage).toBe('function');
  });

  it.runIf(process.platform === 'win32')(
    'accepts only the pinned signed Node executable used by Windows packages',
    () => {
      expect(() => verifyBundledNodeResources()).not.toThrow();
    },
  );
});

describe('Windows release signing', () => {
  it('selects a CurrentUser code-signing certificate without exporting its private key', () => {
    expect(
      resolveWindowsSignOptions({
        SPRINT_CODER_WINDOWS_CERTIFICATE_SHA1: '4f9b 4eaa cd58 21f7 e84f a525 955a 904d 5eb7 7826',
      }),
    ).toEqual({
      signWithParams: '/sha1 4F9B4EAACD5821F7E84FA525955A904D5EB77826',
      description: 'Sprint Coder',
    });
  });

  it('rejects malformed store thumbprints and incomplete PFX settings', () => {
    expect(() =>
      resolveWindowsSignOptions({ SPRINT_CODER_WINDOWS_CERTIFICATE_SHA1: 'not-a-thumbprint' }),
    ).toThrow('40-character SHA-1 thumbprint');
    expect(() =>
      resolveWindowsSignOptions({ SPRINT_CODER_WINDOWS_CERTIFICATE_FILE: 'release.pfx' }),
    ).toThrow('must be provided together');
    expect(() =>
      resolveWindowsSignOptions({
        SPRINT_CODER_WINDOWS_CERTIFICATE_FILE: 'release.pfx',
        SPRINT_CODER_WINDOWS_CERTIFICATE_PASSWORD: 'secret',
        SPRINT_CODER_WINDOWS_CERTIFICATE_SHA1: 'not-a-thumbprint',
      }),
    ).toThrow('40-character SHA-1 thumbprint');
    expect(() =>
      resolveWindowsSignOptions({
        SPRINT_CODER_WINDOWS_CERTIFICATE_FILE: 'release.pfx',
        SPRINT_CODER_WINDOWS_CERTIFICATE_PASSWORD: 'secret',
        SPRINT_CODER_WINDOWS_CERTIFICATE_SHA1: '4F9B4EAACD5821F7E84FA525955A904D5EB77826',
      }),
    ).toThrow('mutually exclusive');
  });
});

describe('macOS auto-update signing gate', () => {
  it('enables the compiled updater only for a real signing identity', () => {
    expect(macAutoUpdateEligibleForIdentity(undefined)).toBe(false);
    expect(macAutoUpdateEligibleForIdentity('')).toBe(false);
    expect(macAutoUpdateEligibleForIdentity('-')).toBe(false);
    expect(macAutoUpdateEligibleForIdentity('Developer ID Application: Sprint Coder')).toBe(true);
  });
});

describe('retired model runtime package boundary', () => {
  it('does not compile a sidecar pin into Main', () => {
    expect(viteMainConfig.define).not.toHaveProperty('__SPRINT_CODER_MANAGED_LOCAL_SIDECAR_PINS__');
  });
});

describe('macOS sandbox runner sealing', () => {
  it.runIf(process.platform === 'win32')(
    'probes the real Windows helper after sealing its changed PE bytes',
    async () => {
      const root = mkdtempSync(resolve(tmpdir(), 'sprint-coder-real-runner-seal-'));
      try {
        const resources = join(root, 'resources');
        const runner = join(resources, 'sprint-coder-sandbox-runner.exe');
        mkdirSync(resources, { recursive: true });
        copyFileSync(sandboxRunnerPath(), runner);
        copyFileSync(`${sandboxRunnerPath()}.sha256`, `${runner}.sha256`);
        appendFileSync(runner, 'SIGNING_BYTE_MUTATION_FIXTURE');
        await expect(probeSandboxRunner(runner)).resolves.toMatchObject({ available: false });
        refreshPackagedSandboxRunnerDigest(root, 'win32');
        await expect(probeSandboxRunner(runner)).resolves.toMatchObject({
          available: true,
          backend: 'windows-appcontainer',
        });
        appendFileSync(runner, 'TAMPER_FIXTURE');
        await expect(probeSandboxRunner(runner)).resolves.toMatchObject({ available: false });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it('refreshes Windows runner bytes in the real postPackage hook before other native verification', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'sprint-coder-windows-runner-seal-'));
    try {
      const resources = join(root, 'resources');
      const runner = join(resources, 'sprint-coder-sandbox-runner.exe');
      mkdirSync(resources, { recursive: true });
      writeFileSync(runner, 'unsigned-runner');
      writeFileSync(
        `${runner}.sha256`,
        `${createHash('sha256').update('unsigned-runner').digest('hex')}\n`,
      );
      expect(() => verifySandboxRunnerDigest(runner)).not.toThrow();
      // Deterministic signing-byte mutation; no certificate or signing service is used.
      writeFileSync(runner, 'post-signing-runner');
      expect(() => verifySandboxRunnerDigest(runner)).toThrow('digest mismatch');
      // The pinned desktop-control binary the package ships next to it (checked in the same hook).
      const desktop = join(resources, 'sprint-coder-desktop-control.exe');
      copyFileSync(DESKTOP_CONTROL_SOURCE, desktop);
      const resolvedConfig: ResolvedForgeConfig = {
        ...config,
        plugins: config.plugins ?? [],
        rebuildConfig: config.rebuildConfig ?? {},
        packagerConfig: config.packagerConfig ?? {},
        makers: config.makers ?? [],
        publishers: config.publishers ?? [],
        pluginInterface: {
          triggerHook: async () => undefined,
          getHookListrTasks: async () => [],
          triggerMutatingHook: async (_name, item) => item,
          overrideStartLogic: async () => {
            throw new Error('Unexpected plugin invocation');
          },
        },
      };
      await expect(
        config.hooks!.postPackage!(resolvedConfig, {
          platform: 'win32',
          arch: 'x64',
          outputPaths: [root],
        }),
      ).resolves.toBeUndefined();
      expect(() => verifySandboxRunnerDigest(runner)).not.toThrow();
      writeFileSync(runner, 'tampered-after-package');
      expect(() => verifySandboxRunnerDigest(runner)).toThrow('digest mismatch');
      // A signed or otherwise altered desktop-control binary fails the package instead of
      // shipping off.
      appendFileSync(desktop, 'signature');
      await expect(
        config.hooks!.postPackage!(resolvedConfig, {
          platform: 'win32',
          arch: 'x64',
          outputPaths: [root],
        }),
      ).rejects.toThrow('does not match the pin');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('regenerates the packaged digest from the post-signing runner bytes', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'sprint-coder-runner-seal-'));
    try {
      const appPath = resolve(root, 'Sprint Coder.app');
      const resources = resolve(appPath, 'Contents', 'Resources');
      const runner = resolve(resources, 'sprint-coder-sandbox-runner');
      mkdirSync(resources, { recursive: true });
      writeFileSync(runner, 'post-signing-runner-bytes');
      writeFileSync(`${runner}.sha256`, `${'0'.repeat(64)}\n`);

      const digest = refreshPackagedSandboxRunnerDigest(appPath);

      expect(digest).toBe(createHash('sha256').update('post-signing-runner-bytes').digest('hex'));
      expect(readFileSync(`${runner}.sha256`, 'utf8')).toBe(`${digest}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('desktop-control resources', () => {
  const LICENSE = resolve(__dirname, '..', '..', 'docs', 'licenses', 'agent-desktop-license.txt');

  it('ships only the pinned Windows x64 binary, under its shipped name, and its license', () => {
    expect(desktopControlSource('win32', 'x64')).toBe(DESKTOP_CONTROL_SOURCE);
    expect(desktopControlResources('win32', 'x64')).toEqual([LICENSE]);
    for (const [platform, arch] of [
      ['win32', 'arm64'],
      ['darwin', 'arm64'],
      ['darwin', 'x64'],
      ['linux', 'x64'],
    ] as const) {
      expect(desktopControlSource(platform, arch)).toBeNull();
      expect(desktopControlResources(platform, arch)).toEqual([]);
    }
    const extra = (config.packagerConfig?.extraResource ?? []) as string[];
    // The binary never goes through extraResource, which would keep the npm file name.
    expect(extra).not.toContain(DESKTOP_CONTROL_SOURCE);
    expect(extra.filter((path) => path === LICENSE)).toEqual(
      process.platform === 'win32' && process.arch === 'x64' ? [LICENSE] : [],
    );
    expect(config.packagerConfig?.afterCopyExtraResources).toHaveLength(1);
    // node_modules (with every other platform's binary) never enters the package.
    expect(shouldIgnoreFromPackage('/node_modules/agent-desktop/bin/agent-desktop-linux-x64')).toBe(
      true,
    );
    // The third-party license stays shipped in full, with its source.
    const license = readFileSync(LICENSE, 'utf8');
    expect(license).toContain('agent-desktop 1.2.0');
    expect(license).toContain('https://github.com/vercel-labs/agent-desktop');
    expect(license).toContain('Apache License');
    expect(license).toContain('END OF TERMS AND CONDITIONS');
  });

  it('copies the same bytes into resources under the shipped name, in the real hook', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'sprint-coder-desktop-control-copy-'));
    try {
      const resources = join(root, 'resources');
      mkdirSync(resources, { recursive: true });
      const [hook] = config.packagerConfig!.afterCopyExtraResources!;
      await new Promise<void>((done, fail) =>
        hook!(root, '0.0.0', 'win32', 'x64', (error) => (error ? fail(error) : done())),
      );
      const shipped = join(resources, 'sprint-coder-desktop-control.exe');
      expect(readFileSync(shipped).equals(readFileSync(DESKTOP_CONTROL_SOURCE))).toBe(true);
      expect(existsSync(join(resources, 'agent-desktop-win32-x64.exe'))).toBe(false);
      // Nothing is copied for a target without a pin.
      const other = join(root, 'other');
      mkdirSync(other, { recursive: true });
      copyDesktopControlBinary(other, 'linux', 'x64');
      expect(existsSync(join(other, 'sprint-coder-desktop-control.exe'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails the build when the binary is not the pinned bytes', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'sprint-coder-desktop-control-pin-'));
    try {
      const copy = join(root, 'sprint-coder-desktop-control.exe');
      copyFileSync(DESKTOP_CONTROL_SOURCE, copy);
      expect(() => verifyDesktopControlBinary(copy, 'win32', 'x64')).not.toThrow();
      appendFileSync(copy, 'x');
      expect(() => verifyDesktopControlBinary(copy, 'win32', 'x64')).toThrow(
        'does not match the pin',
      );
      expect(() => verifyDesktopControlBinary(join(root, 'missing.exe'), 'win32', 'x64')).toThrow();
      expect(() => verifyDesktopControlBinary(copy, 'linux', 'x64')).toThrow(
        'No desktop-control pin',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('release artifacts', () => {
  it('builds macOS, Ubuntu, and explicitly unsigned Windows artifacts in Actions', () => {
    const workflow = readFileSync(
      resolve(__dirname, '../../.github/workflows/release-beta.yml'),
      'utf8',
    );
    const ciWorkflow = readFileSync(resolve(__dirname, '../../.github/workflows/ci.yml'), 'utf8');
    const macPackageJob = ciWorkflow.slice(
      ciWorkflow.indexOf('\n  package-macos:'),
      ciWorkflow.indexOf('\n  platform-tests:'),
    );
    const requiredJob = ciWorkflow.slice(ciWorkflow.indexOf('\n  required:'));
    const provisioner = readFileSync(resolve(__dirname, 'scripts/ensure-inno-setup.ps1'), 'utf8');
    const unsignedVerifier = readFileSync(
      resolve(__dirname, 'scripts/verify-unsigned-windows-release.ps1'),
      'utf8',
    );

    expect(workflow).toContain('apps/desktop/out/make/**/*.zip');
    expect(workflow).toContain('os: macos-latest');
    expect(workflow).toContain('os: ubuntu-latest');
    expect(workflow).toContain('os: windows-2022');
    expect(workflow).toContain("SPRINT_CODER_ALLOW_UNSIGNED_WINDOWS: '1'");
    expect(workflow).toContain('mac_zip_count != 1');
    expect(workflow).toContain('linux_zip_count != 1');
    expect(workflow).toContain('release-assets/RELEASES.json');
    expect(workflow).toContain('${#assets[@]} != 7');
    expect(workflow).toContain('--prerelease="${RELEASE_PRERELEASE}"');
    expect(workflow).toContain('--draft');
    expect(readFileSync(resolve(__dirname, 'forge.config.ts'), 'utf8')).toContain(
      "new MakerZIP({}, ['darwin', 'linux', 'win32'])",
    );
    expect(workflow).toMatch(
      /release:\n[\s\S]*?- name: Checkout\n\s+uses: actions\/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0/u,
    );
    expect(ciWorkflow).toContain('npx electron-forge package --platform=win32 --arch=x64');
    expect(ciWorkflow).toContain('npx electron-forge make --platform=win32 --arch=x64');
    expect(macPackageJob).not.toContain('if: github.event_name');
    expect(macPackageJob).toContain("if: needs.classify.outputs.full_matrix == 'true'");
    expect(requiredJob).toContain('package-macos,');
    expect(requiredJob).toContain('CI_JOB_RESULTS_JSON: ${{ toJSON(needs) }}');
    expect(requiredJob).toContain('run: node ci-scope.mjs gate');
    expect(ciWorkflow).toContain('Select checks from the complete pull request');
    expect(ciWorkflow).not.toContain('SPRINT_CODER_MANAGED_LOCAL_LIVE');
    expect(ciWorkflow).not.toContain('SPRINT_CODER_MANAGED_LOCAL_CODING_LIVE');
    expect(ciWorkflow).toContain('./apps/desktop/scripts/verify-unsigned-windows-release.ps1');
    expect(unsignedVerifier).toContain('Sprint-Coder-Installer-$version.exe');
    expect(unsignedVerifier).toContain('Sprint-Coder-Setup.exe');
    expect(unsignedVerifier).toContain("$installerSignature.Status -ne 'NotSigned'");
    expect(unsignedVerifier).toContain("$appSignature.Status -ne 'NotSigned'");
    expect(provisioner).toContain('choco install innosetup --version=6.7.1');
    expect(provisioner).toContain('Get-AuthenticodeSignature -LiteralPath $compiler');
    expect(provisioner).toContain("$publisher -ne 'Pyrsys B.V.'");
    expect(provisioner).toContain(
      '4EFD84E6F1091B19321231743B9AA86482EFFD6D0BEA9F7A44DB6211154616F3',
    );
  });

  it.each(['0.7.0', '0.7.0-beta.15'])(
    'wraps the Squirrel bootstrapper in a versioned Windows setup wizard for %s',
    (version) => {
      const script = readFileSync(resolve(__dirname, 'installer/windows-wizard.iss'), 'utf8');
      const sourceSetupPath = resolve('out/make/squirrel.windows/x64', SQUIRREL_SETUP_EXE);
      const plan = planWindowsWizardInstaller([
        {
          platform: 'win32',
          arch: 'x64',
          packageJSON: { version },
          artifacts: [sourceSetupPath, resolve('out/make/squirrel.windows/x64/RELEASES')],
        },
      ]);

      expect(plan).toMatchObject({
        sourceSetupPath,
        outputPath: resolve(
          'out/make/squirrel.windows/x64',
          `Sprint-Coder-Installer-${version}.exe`,
        ),
        version,
      });
      expect(script).toContain('OutputBaseFilename=Sprint-Coder-Installer-{#AppVersion}');
      expect(script).toContain('WizardStyle=modern');
      expect(script).toContain('DisableWelcomePage=no');
      expect(script).toContain('DisableReadyPage=no');
      expect(script).toContain('DisableFinishedPage=no');
      expect(script).toContain('compiler:Languages\\Japanese.isl');
      expect(script).toContain('#if VER >= EncodeVer(6,3,0)');
      expect(script).toContain('ArchitecturesAllowed=x64compatible');
      expect(script).toContain('#else\nArchitecturesAllowed=x64');
      expect(script).toContain('AfterInstall: InstallSprintCoder');
      expect(script).toContain(
        "Exec(Bootstrapper, '--silent', ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, ResultCode)",
      );
      expect(script).toContain('if ResultCode <> 0 then');
      expect(script).toContain('RaiseException');
      expect(script).toContain('Parameters: "--processStart ""Sprint Coder.exe"""; Description:');
      expect(script).toContain('Flags: nowait postinstall skipifsilent skipifdoesntexist');
    },
  );

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
