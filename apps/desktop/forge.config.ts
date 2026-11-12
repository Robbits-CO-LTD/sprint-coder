import type { ForgeConfig, ForgePlatform } from '@electron-forge/shared-types';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { createHash } from 'node:crypto';
import {
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWindowsWizardInstaller } from './windows-wizard-installer';
import { verifyWindowsSandboxArtifacts } from './windows-sandbox-artifacts';
import {
  DESKTOP_CONTROL_EXECUTABLE,
  DESKTOP_CONTROL_VERSION,
  desktopControlSupported,
} from './src/main/desktop-control-build';
// @electron-forge/plugin-vite auto-sets packagerConfig.ignore to keep only the `.vite`
// build output (everything else, including this project's own source tree, is dropped
// from the packaged app). The native-safe-fs compiled addon lives outside `.vite` and
// outside node_modules, so under that default it would be silently excluded from the
// package before packagerConfig.asar.unpack ever gets a chance to unpack it. Setting our
// own `ignore` here (which suppresses the plugin's auto-set, per its own resolveForgeConfig
// check) preserves the plugin's `.vite`-only behavior and additionally keeps the
// native-safe-fs build directory so the addon actually ships. See native-safe-fs.ts
// (resolveNativeSafeFsAddonLocation) for how the main process finds this file at runtime.
function isNativeSafeFsAddonPackagePath(file: string): boolean {
  return (
    file === '/native-safe-fs' ||
    file === '/native-safe-fs/build' ||
    file === '/native-safe-fs/build/Release' ||
    (file.startsWith('/native-safe-fs/build/Release/') && file.endsWith('.node'))
  );
}

export function shouldIgnoreFromPackage(file: string): boolean {
  if (!file) return false;
  if (file === '/.vite' || file.startsWith('/.vite/')) return false;
  if (file === '/vendor' || file === '/vendor/archify' || file.startsWith('/vendor/archify/'))
    return false;
  if (isNativeSafeFsAddonPackagePath(file)) return false;
  return true;
}

const runtimeModuleFiles = [
  ['better-sqlite3', 'package.json'],
  ['better-sqlite3', 'lib'],
  ['better-sqlite3', 'build', 'Release', 'better_sqlite3.node'],
  ['better-sqlite3', 'LICENSE'],
  ['sharp'],
  ['detect-libc'],
  ['semver'],
  ['@img'],
] as const;
export const NATIVE_ASAR_UNPACK_GLOB = '*.{node,dylib,dll,wasm,so,so.*}';
const appIconPath = resolve(__dirname, 'assets', 'sprint-coder-icon');
const bundledNodeEntitlements = join(__dirname, 'entitlements.node.plist');
export const DMG_BACKGROUND_PATH = resolve(__dirname, 'assets', 'dmg-background.png');
export const DMG_WINDOW_SIZE = { width: 658, height: 498 } as const;
export const DMG_ICON_SIZE = 112;

export function createDMGContents(appPath: string) {
  return [
    { x: 190, y: 300, type: 'file' as const, path: appPath },
    { x: 468, y: 300, type: 'link' as const, path: '/Applications' },
  ];
}
const macCodeSignIdentity = process.env['SPRINT_CODER_CODESIGN_IDENTITY'] ?? '-';
const releasePackage = process.env['SPRINT_CODER_RELEASE'] === '1';
const ciPackage = process.env['CI'] === '1' || process.env['CI'] === 'true';
const allowAdhocCodeSign = process.env['SPRINT_CODER_ALLOW_ADHOC_CODESIGN'] === '1';
const allowUnsignedWindows = process.env['SPRINT_CODER_ALLOW_UNSIGNED_WINDOWS'] === '1';
const windowsSign = resolveWindowsSignOptions(process.env);
const BUNDLED_NODE_VERSION = '22.23.3';
const BUNDLED_NODE_SHA256 = '9C9245166B4A8E182E0B797DA9C20136117FF24368EAFF1FEC8343A123C8DB0E';
const MAC_BUNDLED_NODE_SHA256 = {
  arm64: '68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b',
  x64: 'fdb8d4da9332c2c99c3b2ae4bad4672bfef225ecd603e656cd1378b3644583a2',
} as const;
const MAC_BUNDLED_NODE_LICENSE_SHA256 =
  'c738ae413cf561f174e34f6961f8ca458aae2369a73640dda6234c629b98bcc4';
const BUNDLED_NODE_SIGNER_SUBJECT =
  'CN=OpenJS Foundation, O=OpenJS Foundation, L=San Francisco, S=California, C=US';
const BUNDLED_NODE_SIGNER_ISSUER =
  'CN=Microsoft ID Verified CS EOC CA 03, O=Microsoft Corporation, C=US';
const BUNDLED_NODE_SIGNER_THUMBPRINT = '5A2C440219B027EF812E24A1E15F671D7CD379DE';

function macBundledNodeResources(): [string, string] {
  const nodeExecutable = realpathSync(process.execPath);
  return [nodeExecutable, resolve(nodeExecutable, '..', '..', 'LICENSE')];
}

function bundledNodeResources(): string[] {
  if (process.platform === 'darwin') return macBundledNodeResources();
  if (process.platform !== 'win32') return [];
  const nodeExecutable = process.execPath;
  return [nodeExecutable, join(resolve(nodeExecutable, '..'), 'LICENSE')];
}

function sandboxRunnerResources(): string[] {
  const name =
    process.platform === 'win32'
      ? 'sprint-coder-sandbox-runner.exe'
      : 'sprint-coder-sandbox-runner';
  const executable = resolve(__dirname, 'sandbox-runner', 'build', 'Release', name);
  return [
    executable,
    `${executable}.sha256`,
    ...(process.platform === 'win32'
      ? [join(dirname(executable), 'sandbox-node-pipe-guard.cjs')]
      : []),
  ];
}

// Sprint Coder's desktop control ships the desktop-control executable built from the source in
// desktop-control/ (build-desktop-control.mjs; Windows x64 only for now, see
// src/main/desktop-control-build.ts), the `.sha256` manifest its build wrote beside it, and the
// license of that third-party source. Like the sandbox runner, the files keep their build names.
export function desktopControlSource(
  platform: string = process.platform,
  arch: string = process.arch,
): string | null {
  if (!desktopControlSupported(platform, arch)) return null;
  return resolve(__dirname, 'desktop-control', 'build', 'Release', DESKTOP_CONTROL_EXECUTABLE);
}

export function desktopControlResources(
  platform: string = process.platform,
  arch: string = process.arch,
): string[] {
  const executable = desktopControlSource(platform, arch);
  if (executable === null) return [];
  return [
    executable,
    `${executable}.sha256`,
    resolve(__dirname, '..', '..', 'docs', 'licenses', 'agent-desktop-license.txt'),
  ];
}

/** Fails the build unless the file holds exactly the bytes its `.sha256` manifest seals. */
export function verifyDesktopControlBinary(executable: string): void {
  if (!lstatSync(executable).isFile())
    throw new Error(`desktop-control ${DESKTOP_CONTROL_VERSION} executable was not found`);
  const expected = readFileSync(`${executable}.sha256`, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/u.test(expected))
    throw new Error(`desktop-control ${basename(executable)} has an invalid digest manifest`);
  const digest = createHash('sha256').update(readFileSync(executable)).digest('hex');
  if (digest !== expected)
    throw new Error(
      `desktop-control ${basename(executable)} SHA-256 ${digest} does not match its sealed digest ${expected}`,
    );
}

/**
 * Seals the packaged desktop-control executable's final bytes, after Packager's Authenticode
 * signing changed them (as for the sandbox runner). The copy was checked against its build-time
 * seal before signing, in afterCopyExtraResources.
 */
export function refreshPackagedDesktopControlDigest(appPath: string): string {
  const executable = join(appPath, 'resources', DESKTOP_CONTROL_EXECUTABLE);
  if (!lstatSync(executable).isFile())
    throw new Error('Packaged desktop-control executable was not found');
  const digest = createHash('sha256').update(readFileSync(executable)).digest('hex');
  writeFileSync(`${executable}.sha256`, `${digest}\n`, { mode: 0o600 });
  return digest;
}

export function refreshPackagedSandboxRunnerDigest(
  appPath: string,
  platform: 'darwin' | 'win32' = 'darwin',
): string {
  const executable =
    platform === 'win32'
      ? join(appPath, 'resources', 'sprint-coder-sandbox-runner.exe')
      : join(appPath, 'Contents', 'Resources', 'sprint-coder-sandbox-runner');
  if (!lstatSync(executable).isFile())
    throw new Error(`Packaged ${platform} sandbox runner was not found`);
  const digest = createHash('sha256').update(readFileSync(executable)).digest('hex');
  writeFileSync(`${executable}.sha256`, `${digest}\n`, { mode: 0o600 });
  return digest;
}

function resealMacAppBundle(appPath: string): void {
  execFileSync(
    '/usr/bin/codesign',
    [
      '--force',
      '--options',
      'runtime',
      ...(macCodeSignIdentity === '-' ? ['--timestamp=none'] : ['--timestamp']),
      '--preserve-metadata=identifier,entitlements,requirements',
      '--sign',
      macCodeSignIdentity,
      appPath,
    ],
    { stdio: 'inherit' },
  );
}

export function verifyBundledNodeResources(architecture: string = process.arch): void {
  if (process.platform === 'darwin') {
    if (
      process.versions.node !== BUNDLED_NODE_VERSION ||
      process.arch !== architecture ||
      (architecture !== 'arm64' && architecture !== 'x64')
    ) {
      throw new Error(
        `macOS packages must be built with official Node ${BUNDLED_NODE_VERSION} for ${architecture}, got ${process.version} (${process.arch})`,
      );
    }
    const [nodeExecutable, nodeLicense] = macBundledNodeResources();
    if (
      lstatSync(nodeExecutable).isFile() &&
      lstatSync(nodeLicense, { throwIfNoEntry: false })?.isFile() &&
      createHash('sha256').update(readFileSync(nodeExecutable)).digest('hex') ===
        MAC_BUNDLED_NODE_SHA256[architecture] &&
      createHash('sha256').update(readFileSync(nodeLicense)).digest('hex') ===
        MAC_BUNDLED_NODE_LICENSE_SHA256
    ) {
      return;
    }
    throw new Error(
      `Use the official Node ${BUNDLED_NODE_VERSION} macOS distribution with its LICENSE to build this package`,
    );
  }
  if (process.platform !== 'win32') return;
  if (process.versions.node !== BUNDLED_NODE_VERSION)
    throw new Error(
      `Windows packages must be built with Node ${BUNDLED_NODE_VERSION}, got ${process.version}`,
    );
  const nodeExecutable = process.execPath;
  const nodeLicense = join(resolve(nodeExecutable, '..'), 'LICENSE');
  const signatureJson = execFileSync(
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Import-Module "$PSHOME\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1"; $signature = Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $env:SPRINT_CODER_NODE; [pscustomobject]@{Status=$signature.Status.ToString();Subject=$signature.SignerCertificate.Subject;Issuer=$signature.SignerCertificate.Issuer;Thumbprint=$signature.SignerCertificate.Thumbprint} | ConvertTo-Json -Compress`,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, SPRINT_CODER_NODE: nodeExecutable },
      windowsHide: true,
    },
  ).trim();
  const signature = JSON.parse(signatureJson) as {
    Status?: unknown;
    Subject?: unknown;
    Issuer?: unknown;
    Thumbprint?: unknown;
  };
  if (
    signature.Status !== 'Valid' ||
    signature.Subject !== BUNDLED_NODE_SIGNER_SUBJECT ||
    signature.Issuer !== BUNDLED_NODE_SIGNER_ISSUER ||
    signature.Thumbprint !== BUNDLED_NODE_SIGNER_THUMBPRINT
  )
    throw new Error('Bundled Node signature does not match the pinned OpenJS signer');
  const digest = createHash('sha256')
    .update(readFileSync(nodeExecutable))
    .digest('hex')
    .toUpperCase();
  if (digest !== BUNDLED_NODE_SHA256)
    throw new Error(`Bundled Node SHA-256 does not match the pinned Node ${BUNDLED_NODE_VERSION}`);
  if (!lstatSync(nodeLicense).isFile()) throw new Error('Bundled Node LICENSE was not found');
}

export function assertNativePackagingHost(targetPlatform: ForgePlatform): void {
  if (targetPlatform === process.platform) return;
  throw new Error(
    `Cross-platform packaging is unsupported: target ${targetPlatform} must be built on ${targetPlatform}, not ${process.platform}. The package contains target-native Node and Electron addons.`,
  );
}

if (process.platform === 'win32' && releasePackage && !allowUnsignedWindows && !windowsSign)
  throw new Error(
    'A PFX certificate or SPRINT_CODER_WINDOWS_CERTIFICATE_SHA1 is required for a production Windows package unless SPRINT_CODER_ALLOW_UNSIGNED_WINDOWS=1 is explicitly set',
  );

export function resolveWindowsSignOptions(
  environment: Partial<
    Record<
      | 'SPRINT_CODER_WINDOWS_CERTIFICATE_FILE'
      | 'SPRINT_CODER_WINDOWS_CERTIFICATE_PASSWORD'
      | 'SPRINT_CODER_WINDOWS_CERTIFICATE_SHA1',
      string | undefined
    >
  >,
):
  | Readonly<{
      certificateFile: string;
      certificatePassword: string;
      description: string;
    }>
  | Readonly<{ signWithParams: string; description: string }>
  | undefined {
  const certificateFile = environment.SPRINT_CODER_WINDOWS_CERTIFICATE_FILE;
  const certificatePassword = environment.SPRINT_CODER_WINDOWS_CERTIFICATE_PASSWORD;
  const certificateSha1 = environment.SPRINT_CODER_WINDOWS_CERTIFICATE_SHA1;
  const normalizedSha1 = certificateSha1?.replaceAll(' ', '').toUpperCase();
  if (normalizedSha1 !== undefined && !/^[0-9A-F]{40}$/.test(normalizedSha1))
    throw new Error(
      'SPRINT_CODER_WINDOWS_CERTIFICATE_SHA1 must be a 40-character SHA-1 thumbprint',
    );
  if (
    normalizedSha1 !== undefined &&
    (certificateFile !== undefined || certificatePassword !== undefined)
  )
    throw new Error('Windows PFX and certificate-store signing settings are mutually exclusive');
  if ((certificateFile === undefined) !== (certificatePassword === undefined))
    throw new Error('Windows PFX certificate file and password must be provided together');
  if (certificateFile !== undefined && certificatePassword !== undefined)
    return { certificateFile, certificatePassword, description: 'Sprint Coder' };
  if (normalizedSha1 === undefined) return undefined;
  return { signWithParams: `/sha1 ${normalizedSha1}`, description: 'Sprint Coder' };
}

function copyHoistedRuntimeModules(buildPath: string): void {
  const rootNodeModules = resolve(__dirname, '..', '..', 'node_modules');
  const packagedNodeModules = join(buildPath, 'node_modules');
  mkdirSync(packagedNodeModules, { recursive: true });

  for (const parts of runtimeModuleFiles) {
    const source = join(rootNodeModules, ...parts);
    const destination = join(packagedNodeModules, ...parts);
    mkdirSync(resolve(destination, '..'), { recursive: true });
    cpSync(source, destination, { recursive: true });
  }
}

function isPackagedMacNode(path: string): boolean {
  return path.endsWith('/Contents/Resources/node');
}

function signAdhocBundle(appPath: string): void {
  const targets: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(path);
        if (entry.name.endsWith('.app') || entry.name.endsWith('.framework')) targets.push(path);
        continue;
      }
      if (
        entry.isFile() &&
        (entry.name.endsWith('.node') ||
          entry.name.endsWith('.dylib') ||
          (lstatSync(path).mode & 0o111) !== 0)
      )
        targets.push(path);
    }
  };
  visit(join(appPath, 'Contents'));
  targets.push(appPath);
  const entitlements = join(__dirname, 'entitlements.ad-hoc.plist');
  for (const target of targets) {
    const targetEntitlements = target.endsWith('.app')
      ? entitlements
      : isPackagedMacNode(target)
        ? bundledNodeEntitlements
        : null;
    execFileSync(
      '/usr/bin/codesign',
      [
        '--force',
        '--options',
        'runtime',
        '--timestamp=none',
        '--sign',
        '-',
        ...(targetEntitlements === null ? [] : ['--entitlements', targetEntitlements]),
        target,
      ],
      { stdio: 'inherit' },
    );
  }
}

const config: ForgeConfig = {
  packagerConfig: {
    // Electron Packager appends the platform-specific extension (.icns/.ico).
    icon: appIconPath,
    // @electron/asar matches `unpack` against the full source filename with matchBase enabled.
    // Native addons and sharp's platform libvips/wasm payload cannot be loaded from app.asar.
    // Linux libvips is version-suffixed (for example libvips-cpp.so.8.18.3), so matching only
    // files that end in `.so` leaves Sharp's shared library trapped inside app.asar.
    asar: { unpack: NATIVE_ASAR_UNPACK_GLOB },
    extraResource: [
      resolve(__dirname, '..', '..', 'docs', 'licenses', 'unicode-license.txt'),
      ...bundledNodeResources(),
      ...sandboxRunnerResources(),
      ...desktopControlResources(),
    ],
    ignore: shouldIgnoreFromPackage,
    // Production identities use @electron/osx-sign so nested Electron helpers and Frameworks keep
    // their per-process entitlements. Local ad-hoc packages are signed in the postPackage hook,
    // where the same dependency order is enforced without relying on unavailable Keychain IDs.
    ...(macCodeSignIdentity === '-'
      ? {}
      : {
          osxSign: {
            identity: macCodeSignIdentity,
            optionsForFile: (file) =>
              isPackagedMacNode(file) ? { entitlements: bundledNodeEntitlements } : {},
          },
        }),
    ...(windowsSign === undefined ? {} : { windowsSign }),
    afterCopy: [
      (buildPath, _electronVersion, _platform, _arch, done) => {
        try {
          copyHoistedRuntimeModules(buildPath);
          done();
        } catch (error) {
          done(error instanceof Error ? error : new Error(String(error)));
        }
      },
    ],
    // Runs before Packager's Windows signing, right after the extraResource copies: the copied
    // desktop-control executable must still be the bytes its build sealed. Only Windows x64 ships
    // it, and its resources sit directly under the build path.
    afterCopyExtraResources: [
      (buildPath, _electronVersion, platform, arch, done) => {
        try {
          if (desktopControlSupported(platform, arch))
            verifyDesktopControlBinary(join(buildPath, 'resources', DESKTOP_CONTROL_EXECUTABLE));
          done();
        } catch (error) {
          done(error instanceof Error ? error : new Error(String(error)));
        }
      },
    ],
  },
  hooks: {
    prePackage: async (_forgeConfig, platform, arch) => {
      assertNativePackagingHost(platform);
      verifyBundledNodeResources(arch);
      // The resources above were chosen for the build host's architecture.
      if (desktopControlSupported(platform, arch)) {
        if (arch !== process.arch)
          throw new Error(`desktop-control for ${platform}-${arch} must be packaged on ${arch}`);
        verifyDesktopControlBinary(desktopControlSource(platform, arch)!);
      }
    },
    postPackage: async (_forgeConfig, packageResult) => {
      if (packageResult.platform !== 'darwin') {
        // Packager's Authenticode signing changes the sandbox runner after the build-time seal.
        // Seal its final bytes before ZIP/Squirrel consume this packaged directory.
        if (packageResult.platform === 'win32')
          for (const outputPath of packageResult.outputPaths) {
            refreshPackagedSandboxRunnerDigest(outputPath, 'win32');
            // The same for the desktop-control executable, which signing changes too.
            if (desktopControlSupported('win32', packageResult.arch))
              refreshPackagedDesktopControlDigest(outputPath);
          }
        return;
      }
      if ((releasePackage || ciPackage) && macCodeSignIdentity === '-' && !allowAdhocCodeSign)
        throw new Error(
          'SPRINT_CODER_CODESIGN_IDENTITY is required for a CI or production macOS package',
        );
      // Local packages use an ad-hoc identity; release jobs supply
      // SPRINT_CODER_CODESIGN_IDENTITY. Verify the complete signed graph after Packager has run
      // @electron/osx-sign; never replace its ordered per-file signatures with `--deep`.
      for (const outputPath of packageResult.outputPaths) {
        const appBundles = readdirSync(outputPath, { withFileTypes: true }).filter(
          (entry) => entry.isDirectory() && entry.name.endsWith('.app'),
        );
        if (appBundles.length !== 1)
          throw new Error(
            `Expected one macOS app bundle in packaged output, found ${appBundles.length}`,
          );
        const appPath = join(outputPath, appBundles[0]!.name);
        if (macCodeSignIdentity === '-') signAdhocBundle(appPath);
        // Mach-O signing mutates the sandbox runner after its build-time digest is generated.
        // Seal the signed bytes, then refresh only the outer app signature so CodeResources
        // covers the new manifest without rewriting the already-signed nested executable.
        refreshPackagedSandboxRunnerDigest(appPath);
        resealMacAppBundle(appPath);
        execFileSync(
          '/usr/bin/codesign',
          ['--verify', '--deep', '--strict', '--verbose=2', appPath],
          { stdio: 'inherit' },
        );
        const nodeVersion = execFileSync(
          join(appPath, 'Contents', 'Resources', 'node'),
          ['-p', 'process.version'],
          { encoding: 'utf8', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } },
        ).trim();
        if (nodeVersion !== `v${BUNDLED_NODE_VERSION}`)
          throw new Error(`Unexpected packaged Node version: ${nodeVersion}`);
      }
    },
    postMake: async (_forgeConfig, makeResults) => {
      // Squirrel may sign extracted PE files. Refuse stale seals before wrapping its Setup.
      await verifyWindowsSandboxArtifacts(makeResults);
      return createWindowsWizardInstaller(makeResults, {
        scriptPath: resolve(__dirname, 'installer', 'windows-wizard.iss'),
        iconPath: `${appIconPath}.ico`,
        ...(windowsSign === undefined ? {} : { signOptions: windowsSign }),
      });
    },
  },
  makers: [
    new MakerSquirrel({
      name: 'SprintCoder',
      setupExe: 'Sprint-Coder-Setup.exe',
      setupIcon: `${appIconPath}.ico`,
      noMsi: true,
      ...(windowsSign === undefined ? {} : { windowsSign }),
    }),
    // Windows and Linux ZIPs are portable builds. The macOS ZIP is the signed payload consumed by
    // Squirrel.Mac; the DMG stays the user-facing installer.
    new MakerZIP({}, ['darwin', 'linux', 'win32']),
    new MakerDMG({
      name: 'Sprint Coder',
      format: 'ULFO',
      background: DMG_BACKGROUND_PATH,
      icon: `${appIconPath}.icns`,
      iconSize: DMG_ICON_SIZE,
      contents: ({ appPath }) => createDMGContents(appPath),
      additionalDMGOptions: {
        window: {
          position: { x: 160, y: 100 },
          size: DMG_WINDOW_SIZE,
        },
      },
    }),
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main/index.ts', config: 'vite.main.config.ts' },
        { entry: 'src/preload/index.ts', config: 'vite.preload.config.ts' },
        { entry: 'src/runtime-host/index.ts', config: 'vite.runtime-host.config.ts' },
        { entry: 'src/graph-render-host/index.ts', config: 'vite.graph-render-host.config.ts' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
