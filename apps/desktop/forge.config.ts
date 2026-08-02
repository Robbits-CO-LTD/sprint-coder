import type { ForgeConfig, ForgePlatform } from '@electron-forge/shared-types';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { cpSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

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

function shouldIgnoreFromPackage(file: string): boolean {
  if (!file) return false;
  if (file === '/.vite' || file.startsWith('/.vite/')) return false;
  if (isNativeSafeFsAddonPackagePath(file)) return false;
  return true;
}

const runtimeModuleFiles = [
  ['better-sqlite3', 'package.json'],
  ['better-sqlite3', 'lib'],
  ['better-sqlite3', 'build', 'Release', 'better_sqlite3.node'],
  ['bindings', 'package.json'],
  ['bindings', 'bindings.js'],
  ['file-uri-to-path', 'package.json'],
  ['file-uri-to-path', 'index.js'],
] as const;
const appIconPath = resolve(__dirname, 'assets', 'sprint-coder-icon');
const macCodeSignIdentity = process.env['SPRINT_CODER_CODESIGN_IDENTITY'] ?? '-';
const releasePackage = process.env['SPRINT_CODER_RELEASE'] === '1';
const ciPackage = process.env['CI'] === '1' || process.env['CI'] === 'true';
const allowAdhocCodeSign = process.env['SPRINT_CODER_ALLOW_ADHOC_CODESIGN'] === '1';
const allowUnsignedWindows = process.env['SPRINT_CODER_ALLOW_UNSIGNED_WINDOWS'] === '1';
const windowsCertificateFile = process.env['SPRINT_CODER_WINDOWS_CERTIFICATE_FILE'];
const windowsCertificatePassword = process.env['SPRINT_CODER_WINDOWS_CERTIFICATE_PASSWORD'];
const windowsSign =
  windowsCertificateFile !== undefined && windowsCertificatePassword !== undefined
    ? {
        certificateFile: windowsCertificateFile,
        certificatePassword: windowsCertificatePassword,
        description: 'Sprint Coder',
      }
    : undefined;

function verifiedBundledNodeResources(): string[] {
  if (process.platform !== 'win32') return [];
  if (process.versions.node.split('.')[0] !== '22')
    throw new Error(`Windows packages must be built with Node 22, got ${process.version}`);
  const nodeExecutable = process.execPath;
  const nodeLicense = join(resolve(nodeExecutable, '..'), 'LICENSE');
  const signature = execFileSync(
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Import-Module "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1"; $signature = Get-AuthenticodeSignature -LiteralPath $env:SPRINT_CODER_NODE; $signature.Status.ToString() + '|' + $signature.SignerCertificate.Subject`,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, SPRINT_CODER_NODE: nodeExecutable },
      windowsHide: true,
    },
  ).trim();
  if (!signature.startsWith('Valid|') || !signature.includes('OpenJS Foundation'))
    throw new Error(`Bundled Node signature is not trusted OpenJS: ${signature}`);
  if (!lstatSync(nodeLicense).isFile()) throw new Error('Bundled Node LICENSE was not found');
  return [nodeExecutable, nodeLicense];
}

export function assertNativePackagingHost(targetPlatform: ForgePlatform): void {
  if (targetPlatform === process.platform) return;
  throw new Error(
    `Cross-platform packaging is unsupported: target ${targetPlatform} must be built on ${targetPlatform}, not ${process.platform}. The package contains target-native Node and Electron addons.`,
  );
}

if (
  process.platform === 'win32' &&
  releasePackage &&
  !allowUnsignedWindows &&
  (windowsCertificateFile === undefined || windowsCertificatePassword === undefined)
)
  throw new Error(
    'SPRINT_CODER_WINDOWS_CERTIFICATE_FILE and SPRINT_CODER_WINDOWS_CERTIFICATE_PASSWORD are required for a production Windows package unless SPRINT_CODER_ALLOW_UNSIGNED_WINDOWS=1 is explicitly set',
  );

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
    execFileSync(
      '/usr/bin/codesign',
      [
        '--force',
        '--options',
        'runtime',
        '--timestamp=none',
        '--sign',
        '-',
        ...(target.endsWith('.app') ? ['--entitlements', entitlements] : []),
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
    // Native addons cannot be loaded from inside app.asar, so unpack only `.node` binaries.
    asar: { unpack: '*.node' },
    extraResource: verifiedBundledNodeResources(),
    ignore: shouldIgnoreFromPackage,
    // Production identities use @electron/osx-sign so nested Electron helpers and Frameworks keep
    // their per-process entitlements. Local ad-hoc packages are signed in the postPackage hook,
    // where the same dependency order is enforced without relying on unavailable Keychain IDs.
    ...(macCodeSignIdentity === '-'
      ? {}
      : {
          osxSign: {
            identity: macCodeSignIdentity,
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
  },
  hooks: {
    prePackage: async (_forgeConfig, platform) => {
      assertNativePackagingHost(platform);
    },
    postPackage: async (_forgeConfig, packageResult) => {
      if (packageResult.platform !== 'darwin') return;
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
        execFileSync(
          '/usr/bin/codesign',
          ['--verify', '--deep', '--strict', '--verbose=2', appPath],
          { stdio: 'inherit' },
        );
      }
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
    new MakerZIP({}, ['win32']),
    new MakerDMG({
      name: 'Sprint Coder',
      format: 'ULFO',
    }),
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main/index.ts', config: 'vite.main.config.ts' },
        { entry: 'src/preload/index.ts', config: 'vite.preload.config.ts' },
        { entry: 'src/runtime-host/index.ts', config: 'vite.runtime-host.config.ts' },
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
