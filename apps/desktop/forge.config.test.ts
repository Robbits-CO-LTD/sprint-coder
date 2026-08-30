import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPackage as createAsarPackage, uncache as uncacheAsar } from '@electron/asar';
import { computerUseNativeManifestSchema } from '@sprint-coder/contracts';
import { describe, expect, it } from 'vitest';
import config, {
  assertNativePackagingHost,
  createDMGContents,
  DMG_BACKGROUND_PATH,
  DMG_ICON_SIZE,
  DMG_WINDOW_SIZE,
  isManagedLocalPackagedPath,
  isComputerUseNativeArtifactPath,
  MANAGED_LOCAL_PACKAGED_RESOURCE_ROOT,
  COMPUTER_USE_NATIVE_MANIFEST_PATH,
  COMPUTER_USE_NATIVE_RESOURCE_ROOT,
  resolveWindowsSignOptions,
  NATIVE_ASAR_UNPACK_GLOB,
  refreshPackagedComputerUseArtifactDigest,
  refreshPackagedSandboxRunnerDigest,
  shouldIgnoreFromPackage,
  verifyComputerUseNativeBuild,
  verifyPackagedComputerUseNativeBundle,
  verifyBundledNodeResources,
} from './forge.config';
import {
  macAutoUpdateEligibleForIdentity,
  computerUseNativePinForBuild,
  managedLocalSidecarPinsForBuild,
} from './vite.main.config';
import { computerUseNativeCompiledPin } from './src/main/computer-use-native-provenance';
import {
  planWindowsWizardInstaller,
  SQUIRREL_SETUP_EXE,
  WINDOWS_WIZARD_INSTALLER_EXE,
} from './windows-wizard-installer';

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

  it('prepares and packages only the native Managed Local resource tree', () => {
    expect(config.packagerConfig?.extraResource).toContain(MANAGED_LOCAL_PACKAGED_RESOURCE_ROOT);
    expect(typeof config.hooks?.generateAssets).toBe('function');
    expect(typeof config.hooks?.postPackage).toBe('function');
    expect(
      isManagedLocalPackagedPath(
        '/Applications/Sprint Coder.app/Contents/Resources/managed-local/darwin-arm64/bin/llama-server',
      ),
    ).toBe(true);
    expect(
      isManagedLocalPackagedPath(
        'C:\\Sprint Coder\\resources\\managed-local\\win32-x64\\bin\\llama-server.exe',
      ),
    ).toBe(true);
    expect(isManagedLocalPackagedPath('C:\\Sprint Coder\\Sprint Coder.exe')).toBe(false);
    expect(
      isComputerUseNativeArtifactPath(
        'C:\\Sprint Coder\\resources\\sprint-coder-computer-use-host.exe',
      ),
    ).toBe(true);
    expect(
      isComputerUseNativeArtifactPath(
        '/Applications/Sprint Coder.app/Contents/Resources/sprint_coder_computer_use_native.node',
      ),
    ).toBe(true);
  });

  it('keeps the Computer Use native artifact and manifest on the target host only', () => {
    const resources = config.packagerConfig?.extraResource ?? [];
    if (process.platform === 'darwin')
      expect(resources).toContain(
        join(COMPUTER_USE_NATIVE_RESOURCE_ROOT, 'sprint_coder_computer_use_native.node'),
      );
    else if (process.platform === 'win32')
      expect(resources).toContain(
        join(COMPUTER_USE_NATIVE_RESOURCE_ROOT, 'sprint-coder-computer-use-host.exe'),
      );
    else expect(resources).not.toContain(COMPUTER_USE_NATIVE_MANIFEST_PATH);
    expect(config.packagerConfig?.extendInfo).toMatchObject({
      NSScreenCaptureUsageDescription: expect.stringContaining('Screen Recording'),
    });
    expect(readFileSync(resolve(__dirname, 'computer-use-native/binding.gyp'), 'utf8')).toContain(
      'MACOSX_DEPLOYMENT_TARGET',
    );
    expect(() => verifyComputerUseNativeBuild('linux', 'x64')).not.toThrow();
    expect(
      shouldIgnoreFromPackage(
        '/computer-use-native/build/Release/sprint_coder_computer_use_native.node',
      ),
    ).toBe(true);
    expect(
      shouldIgnoreFromPackage(
        '/computer-use-native/build/Release/computer-use-native.manifest.json',
      ),
    ).toBe(true);
  });

  it('packages exactly one Computer Use artifact/manifest in Resources and rejects asar duplicates', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'sprint-coder-computer-use-package-'));
    try {
      const outputPath = join(root, 'out');
      const resources = join(outputPath, 'Sprint Coder.app', 'Contents', 'Resources');
      const asarSource = join(root, 'asar-source');
      const artifactName = 'sprint_coder_computer_use_native.node';
      const artifactBytes = Buffer.from('native-fixture');
      const digest = createHash('sha256').update(artifactBytes).digest('hex');
      mkdirSync(join(asarSource, '.vite', 'build'), { recursive: true });
      mkdirSync(resources, { recursive: true });
      writeFileSync(join(resources, artifactName), artifactBytes);
      const manifest = computerUseNativeManifestSchema.parse({
        version: 1,
        sourceCommit: 'f'.repeat(40),
        platform: 'darwin',
        architecture: 'arm64',
        protocolVersion: 1,
        apiVersion: 1,
        nativeVersion: 'fixture',
        moduleDigest: digest,
        binaryDigest: digest,
        signerDigest: null,
        capabilities: ['observe'],
      });
      const compiledPin = computerUseNativeCompiledPin(manifest);
      writeFileSync(
        join(asarSource, '.vite', 'build', 'index.js'),
        `const computerUsePin=${JSON.stringify(compiledPin)};`,
      );
      writeFileSync(join(resources, 'computer-use-native.manifest.json'), JSON.stringify(manifest));
      await createAsarPackage(asarSource, join(resources, 'app.asar'));
      expect(() =>
        verifyPackagedComputerUseNativeBundle(outputPath, 'darwin', 'arm64'),
      ).not.toThrow();

      writeFileSync(join(asarSource, '.vite', 'build', 'index.js'), 'const stalePin=true;');
      rmSync(join(resources, 'app.asar'), { force: true });
      await createAsarPackage(asarSource, join(resources, 'app.asar'));
      uncacheAsar(join(resources, 'app.asar'));
      expect(() => verifyPackagedComputerUseNativeBundle(outputPath, 'darwin', 'arm64')).toThrow(
        'Packaged Computer Use native artifact verification failed',
      );
      writeFileSync(
        join(asarSource, '.vite', 'build', 'index.js'),
        `const computerUsePin=${JSON.stringify(compiledPin)};`,
      );

      const duplicateDirectory = join(asarSource, 'computer-use-native', 'build', 'Release');
      mkdirSync(duplicateDirectory, { recursive: true });
      writeFileSync(join(duplicateDirectory, artifactName), artifactBytes);
      rmSync(join(resources, 'app.asar'), { force: true });
      await createAsarPackage(asarSource, join(resources, 'app.asar'));
      uncacheAsar(join(resources, 'app.asar'));
      expect(() => verifyPackagedComputerUseNativeBundle(outputPath, 'darwin', 'arm64')).toThrow(
        'Packaged Computer Use native artifact verification failed',
      );

      rmSync(join(asarSource, 'computer-use-native'), { recursive: true, force: true });
      writeFileSync(join(asarSource, artifactName), artifactBytes);
      rmSync(join(resources, 'app.asar'), { force: true });
      await createAsarPackage(asarSource, join(resources, 'app.asar'));
      uncacheAsar(join(resources, 'app.asar'));
      expect(() => verifyPackagedComputerUseNativeBundle(outputPath, 'darwin', 'arm64')).toThrow(
        'Packaged Computer Use native artifact verification failed',
      );

      rmSync(join(asarSource, artifactName), { force: true });
      rmSync(join(resources, 'app.asar'), { force: true });
      await createAsarPackage(asarSource, join(resources, 'app.asar'));
      uncacheAsar(join(resources, 'app.asar'));
      const incompleteManifest = JSON.parse(
        readFileSync(join(resources, 'computer-use-native.manifest.json'), 'utf8'),
      ) as Record<string, unknown>;
      delete incompleteManifest.capabilities;
      writeFileSync(
        join(resources, 'computer-use-native.manifest.json'),
        JSON.stringify(incompleteManifest),
      );
      expect(() => verifyPackagedComputerUseNativeBundle(outputPath, 'darwin', 'arm64')).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

describe('Computer Use native Vite provenance pin', () => {
  it('derives the signed Main pin only for a supported matching platform manifest', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'sprint-coder-computer-use-vite-pin-'));
    try {
      const path = resolve(root, 'computer-use-native.manifest.json');
      const digest = 'b'.repeat(64);
      const manifest = computerUseNativeManifestSchema.parse({
        version: 1,
        sourceCommit: 'a'.repeat(40),
        platform: process.platform === 'win32' ? 'win32' : 'darwin',
        architecture: process.arch === 'arm64' ? 'arm64' : 'x64',
        protocolVersion: 1,
        apiVersion: 1,
        nativeVersion: 'computer-use-native-gate0-1',
        moduleDigest: digest,
        binaryDigest: digest,
        signerDigest: 'c'.repeat(64),
        capabilities: ['observe', 'capture', 'accessibility', 'input'],
      });
      writeFileSync(path, JSON.stringify(manifest));

      expect(computerUseNativePinForBuild(path)).toEqual(
        process.platform === 'linux' ? null : computerUseNativeCompiledPin(manifest),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Managed Local Vite pin injection', () => {
  it('defaults to no supported target and reads only the generated build pin', () => {
    expect(managedLocalSidecarPinsForBuild('/definitely/missing/pins.json')).toEqual({});
    const root = mkdtempSync(resolve(tmpdir(), 'sprint-coder-managed-local-pins-'));
    try {
      const path = resolve(root, 'pins.json');
      const pin = {
        'darwin-arm64': {
          target: 'darwin-arm64',
          runtimeVersion: 'b10516',
          upstreamRevision: 'a'.repeat(40),
          manifestSha256: 'b'.repeat(64),
        },
      };
      writeFileSync(path, JSON.stringify(pin));
      expect(managedLocalSidecarPinsForBuild(path)).toEqual(pin);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('macOS sandbox runner sealing', () => {
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

describe('Computer Use native sealing', () => {
  it('refreshes the manifest from post-signing artifact bytes', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'sprint-coder-computer-use-seal-'));
    try {
      const artifact = resolve(root, 'sprint_coder_computer_use_native.node');
      const manifest = resolve(root, 'computer-use-native.manifest.json');
      writeFileSync(artifact, 'post-signing-native-bytes');
      writeFileSync(
        manifest,
        JSON.stringify({
          version: 1,
          sourceCommit: 'f'.repeat(40),
          platform: 'darwin',
          architecture: 'arm64',
          protocolVersion: 1,
          apiVersion: 1,
          nativeVersion: 'fixture',
          moduleDigest: '0'.repeat(64),
          binaryDigest: '0'.repeat(64),
          signerDigest: null,
          capabilities: ['observe'],
        }),
      );

      const digest = refreshPackagedComputerUseArtifactDigest(root, 'darwin');
      const refreshed = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>;
      expect(digest).toBe(createHash('sha256').update('post-signing-native-bytes').digest('hex'));
      expect(refreshed['moduleDigest']).toBe(digest);
      expect(refreshed['binaryDigest']).toBe(digest);
      expect(refreshed['sourceCommit']).toBe('f'.repeat(40));
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
      ciWorkflow.indexOf('\n  windows-smoke:'),
    );
    const macResultJob = ciWorkflow.slice(
      ciWorkflow.indexOf('\n  macos-result:'),
      ciWorkflow.indexOf('\n  windows-result:'),
    );
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
    expect(workflow).toMatch(/release:\n[\s\S]*?- name: Checkout\n\s+uses: actions\/checkout@v7/);
    expect(ciWorkflow).toContain('npx electron-forge make --platform=win32 --arch=x64');
    expect(macPackageJob).not.toContain('if: github.event_name');
    expect(macResultJob).toContain('test "${MACOS_PACKAGE_RESULT}" = \'success\'');
    expect(ciWorkflow).toContain('build-(native-safe-fs|managed-local-sidecar)');
    expect(ciWorkflow.match(/Managed Local transport smoke/gu)).toHaveLength(3);
    expect(ciWorkflow.match(/SPRINT_CODER_MANAGED_LOCAL_LIVE/gu)).toHaveLength(3);
    expect(ciWorkflow).toContain('./apps/desktop/scripts/verify-unsigned-windows-release.ps1');
    expect(unsignedVerifier).toContain('Sprint-Coder-Installer.exe');
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

  it('wraps the Squirrel bootstrapper in a localized Windows setup wizard', () => {
    const script = readFileSync(resolve(__dirname, 'installer/windows-wizard.iss'), 'utf8');
    const sourceSetupPath = resolve('out/make/squirrel.windows/x64', SQUIRREL_SETUP_EXE);
    const plan = planWindowsWizardInstaller([
      {
        platform: 'win32',
        arch: 'x64',
        packageJSON: { version: '0.0.1-beta.5' },
        artifacts: [sourceSetupPath, resolve('out/make/squirrel.windows/x64/RELEASES')],
      },
    ]);

    expect(plan).toMatchObject({
      sourceSetupPath,
      outputPath: resolve('out/make/squirrel.windows/x64', WINDOWS_WIZARD_INSTALLER_EXE),
      version: '0.0.1-beta.5',
    });
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
