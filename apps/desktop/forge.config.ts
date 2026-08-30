import type { ForgeConfig, ForgePlatform } from '@electron-forge/shared-types';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { extractFile as extractAsarFile, listPackage as listAsarPackage } from '@electron/asar';
import { sign as signWindowsFiles } from '@electron/windows-sign';
import { createHash } from 'node:crypto';
import { computerUseNativeManifestSchema } from '@sprint-coder/contracts';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createWindowsWizardInstaller } from './windows-wizard-installer';
import {
  managedLocalTargetKey,
  verifyManagedLocalSidecarBundle,
  type ManagedLocalSidecarPin,
  type ManagedLocalTargetKey,
} from './src/main/managed-local-sidecar-bundle';
import { computerUseNativeCompiledPin } from './src/main/computer-use-native-provenance';

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
  ['sharp'],
  ['detect-libc'],
  ['semver'],
  ['@img'],
] as const;
export const NATIVE_ASAR_UNPACK_GLOB = '*.{node,dylib,dll,wasm,so,so.*}';
const appIconPath = resolve(__dirname, 'assets', 'sprint-coder-icon');
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
const packagerWindowsSign =
  windowsSign === undefined
    ? undefined
    : {
        ...windowsSign,
        hookFunction: async (file: string) => {
          if (shouldSkipPackagerCodeSign(file)) return;
          await signWindowsFiles({ files: [file], ...windowsSign });
        },
      };
const BUNDLED_NODE_VERSION = '22.23.2';
const BUNDLED_NODE_SHA256 = '0D0F5E39F9F3D9587BC19F73EAB3C2C9C4903FD02D6DBF9C853DD81B3D95FAD4';
const BUNDLED_NODE_SIGNER_SUBJECT =
  'CN=OpenJS Foundation, O=OpenJS Foundation, L=San Francisco, S=California, C=US';
const BUNDLED_NODE_SIGNER_ISSUER =
  'CN=Microsoft ID Verified CS AOC CA 03, O=Microsoft Corporation, C=US';
const BUNDLED_NODE_SIGNER_THUMBPRINT = '01A4F6F4AA2524CECF7A926DCD0BAA64B4956CF0';
const MAC_TEAM_IDENTIFIER_PATTERN = /^[A-Z0-9]{10}$/u;

function computerUseRepositorySourceCommit(): string {
  const commit = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: resolve(__dirname, '..', '..'),
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error('Computer Use source commit is unavailable');
  return commit;
}

function bundledNodeResources(): string[] {
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
  return [executable, `${executable}.sha256`];
}

export const COMPUTER_USE_NATIVE_RESOURCE_ROOT = resolve(
  __dirname,
  'computer-use-native',
  'build',
  'Release',
);
export const COMPUTER_USE_NATIVE_MANIFEST_PATH = join(
  COMPUTER_USE_NATIVE_RESOURCE_ROOT,
  'computer-use-native.manifest.json',
);

function computerUseNativeResources(): string[] {
  if (process.platform === 'darwin')
    return [
      join(COMPUTER_USE_NATIVE_RESOURCE_ROOT, 'sprint_coder_computer_use_native.node'),
      COMPUTER_USE_NATIVE_MANIFEST_PATH,
    ];
  if (process.platform === 'win32')
    return [
      join(COMPUTER_USE_NATIVE_RESOURCE_ROOT, 'sprint-coder-computer-use-host.exe'),
      COMPUTER_USE_NATIVE_MANIFEST_PATH,
    ];
  return [];
}

export const MANAGED_LOCAL_PACKAGED_RESOURCE_ROOT = resolve(
  __dirname,
  'managed-local',
  'build',
  'managed-local',
);

function managedLocalSidecarResources(): string[] {
  return [MANAGED_LOCAL_PACKAGED_RESOURCE_ROOT];
}

export function isManagedLocalPackagedPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').toLowerCase();
  return normalized.includes('/resources/managed-local/');
}

export function isComputerUseNativeArtifactPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').toLowerCase();
  return (
    normalized.endsWith('/sprint-coder-computer-use-host.exe') ||
    normalized.endsWith('/sprint_coder_computer_use_native.node')
  );
}

function shouldSkipPackagerCodeSign(path: string): boolean {
  return isManagedLocalPackagedPath(path) || isComputerUseNativeArtifactPath(path);
}

function managedLocalPackageTarget(
  platform: ForgePlatform,
  architecture: string,
): ManagedLocalTargetKey | null {
  if (!['darwin', 'linux', 'win32'].includes(platform)) return null;
  return managedLocalTargetKey(platform as NodeJS.Platform, architecture);
}

function buildManagedLocalSidecar(platform: ForgePlatform, architecture: string): void {
  assertNativePackagingHost(platform);
  const target = managedLocalPackageTarget(platform, architecture);
  if (target === null)
    throw new Error(`Unsupported Managed Local package target: ${platform}-${architecture}`);
  execFileSync(
    process.execPath,
    [resolve(__dirname, '..', '..', 'build-managed-local-sidecar.mjs'), target],
    {
      cwd: resolve(__dirname, '..', '..'),
      stdio: 'inherit',
      windowsHide: true,
    },
  );
}

function buildComputerUseNative(platform: ForgePlatform, architecture: string): void {
  assertNativePackagingHost(platform);
  const sourceCommit = computerUseRepositorySourceCommit();
  execFileSync(
    process.execPath,
    [
      resolve(__dirname, '..', '..', 'build-computer-use-native.mjs'),
      `--target=${platform}`,
      `--arch=${architecture}`,
      `--source-commit=${sourceCommit}`,
    ],
    {
      cwd: resolve(__dirname, '..', '..'),
      stdio: 'inherit',
      windowsHide: true,
    },
  );
}

async function prepareComputerUseNativeForViteBuild(
  platform: ForgePlatform,
  architecture: string,
): Promise<void> {
  if (platform !== 'darwin' && platform !== 'win32') return;
  const artifactPath = join(
    COMPUTER_USE_NATIVE_RESOURCE_ROOT,
    platform === 'darwin'
      ? 'sprint_coder_computer_use_native.node'
      : 'sprint-coder-computer-use-host.exe',
  );
  if (platform === 'win32') {
    if (windowsSign !== undefined)
      await signWindowsFiles({ files: [artifactPath], ...windowsSign });
    refreshPackagedComputerUseArtifactDigest(COMPUTER_USE_NATIVE_RESOURCE_ROOT, 'win32');
    refreshPackagedComputerUseWindowsSignerDigest(COMPUTER_USE_NATIVE_RESOURCE_ROOT);
  } else {
    execFileSync(
      '/usr/bin/codesign',
      [
        '--force',
        '--options',
        'runtime',
        ...(macCodeSignIdentity === '-' ? ['--timestamp=none'] : ['--timestamp']),
        '--sign',
        macCodeSignIdentity,
        artifactPath,
      ],
      { stdio: 'inherit' },
    );
    refreshPackagedComputerUseArtifactDigest(COMPUTER_USE_NATIVE_RESOURCE_ROOT, 'darwin');
    refreshComputerUseNativeMacModuleSignerDigest(COMPUTER_USE_NATIVE_RESOURCE_ROOT);
  }
  verifyComputerUseNativeBuild(platform, architecture);
}

function generatedManagedLocalPin(target: ManagedLocalTargetKey): ManagedLocalSidecarPin {
  const path = resolve(__dirname, 'managed-local', 'build', 'managed-local-sidecar-pins.json');
  const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const pin = value[target] as ManagedLocalSidecarPin | undefined;
  if (pin === undefined || pin.target !== target)
    throw new Error('Generated Managed Local sidecar pin is unavailable');
  return pin;
}

export async function verifyPackagedManagedLocalSidecar(
  outputPath: string,
  platform: ForgePlatform,
  architecture: string,
): Promise<void> {
  const target = managedLocalPackageTarget(platform, architecture);
  if (target === null) throw new Error('Packaged Managed Local target is unsupported');
  let resources: string;
  if (platform === 'darwin') {
    const appBundles = readdirSync(outputPath, { withFileTypes: true }).filter(
      (entry) => entry.isDirectory() && entry.name.endsWith('.app'),
    );
    if (appBundles.length !== 1)
      throw new Error(`Expected one packaged macOS app, found ${appBundles.length}`);
    resources = join(outputPath, appBundles[0]!.name, 'Contents', 'Resources');
  } else {
    resources = join(outputPath, 'resources');
  }
  const pin = generatedManagedLocalPin(target);
  await verifyManagedLocalSidecarBundle(join(resources, 'managed-local', target), pin);
  const packagedMain = extractAsarFile(
    join(resources, 'app.asar'),
    join('.vite', 'build', 'index.js'),
  ).toString('utf8');
  if (!packagedMain.includes(pin.manifestSha256) || !packagedMain.includes(pin.upstreamRevision))
    throw new Error('Packaged Main does not contain the Managed Local compile-time pin');
}

export function verifyComputerUseNativeBuild(platform: ForgePlatform, architecture: string): void {
  if (platform !== 'darwin' && platform !== 'win32') return;
  assertNativePackagingHost(platform);
  const expectedArtifact =
    platform === 'darwin'
      ? join(COMPUTER_USE_NATIVE_RESOURCE_ROOT, 'sprint_coder_computer_use_native.node')
      : join(COMPUTER_USE_NATIVE_RESOURCE_ROOT, 'sprint-coder-computer-use-host.exe');
  if (!existsSync(expectedArtifact) || !lstatSync(expectedArtifact).isFile())
    throw new Error(`Computer Use native artifact was not built for ${platform}-${architecture}`);
  if (!lstatSync(COMPUTER_USE_NATIVE_MANIFEST_PATH).isFile())
    throw new Error('Computer Use native manifest was not built');
  const manifest = computerUseNativeManifestSchema.parse(
    JSON.parse(readFileSync(COMPUTER_USE_NATIVE_MANIFEST_PATH, 'utf8')) as unknown,
  );
  const digest = createHash('sha256').update(readFileSync(expectedArtifact)).digest('hex');
  const sourceCommit = computerUseRepositorySourceCommit();
  if (
    manifest.sourceCommit !== sourceCommit ||
    manifest.platform !== platform ||
    manifest.architecture !== architecture ||
    manifest.protocolVersion !== 1 ||
    manifest.apiVersion !== 1 ||
    manifest.moduleDigest !== digest ||
    manifest.binaryDigest !== digest
  )
    throw new Error('Computer Use native manifest does not match its artifact');
}

export function verifyPackagedComputerUseNativeBundle(
  outputPath: string,
  platform: ForgePlatform,
  architecture: string,
): void {
  if (platform !== 'darwin' && platform !== 'win32') return;
  const resources =
    platform === 'darwin'
      ? join(
          outputPath,
          readdirSync(outputPath, { withFileTypes: true }).find(
            (entry) => entry.isDirectory() && entry.name.endsWith('.app'),
          )?.name ?? '',
          'Contents',
          'Resources',
        )
      : join(outputPath, 'resources');
  const manifestPath = join(resources, 'computer-use-native.manifest.json');
  const manifest = computerUseNativeManifestSchema.parse(
    JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown,
  );
  const artifactName =
    platform === 'darwin'
      ? 'sprint_coder_computer_use_native.node'
      : 'sprint-coder-computer-use-host.exe';
  const artifactPath = join(resources, artifactName);
  const packagedArtifactCount = countResourceBasename(resources, artifactName);
  const packagedManifestCount = countResourceBasename(
    resources,
    'computer-use-native.manifest.json',
  );
  const asarEntries = listAsarPackage(join(resources, 'app.asar'), { isPack: false }).map((entry) =>
    entry.replaceAll('\\', '/').replace(/^\/+/, '').toLowerCase(),
  );
  const artifactEntry = artifactName.toLowerCase();
  const manifestEntry = 'computer-use-native.manifest.json';
  const hasAsarDuplicate = asarEntries.some(
    (entry) =>
      entry.includes('/computer-use-native/') ||
      entry.startsWith('computer-use-native/') ||
      entry === manifestEntry ||
      entry.endsWith(`/${manifestEntry}`) ||
      entry === artifactEntry ||
      entry.endsWith(`/${artifactEntry}`),
  );
  const digest =
    existsSync(artifactPath) && lstatSync(artifactPath).isFile()
      ? createHash('sha256').update(readFileSync(artifactPath)).digest('hex')
      : null;
  const compiledPin = computerUseNativeCompiledPin(manifest);
  const packagedMain = extractAsarFile(
    join(resources, 'app.asar'),
    join('.vite', 'build', 'index.js'),
  ).toString('utf8');
  const mainContainsCompiledPin = [
    compiledPin.sourceCommit,
    compiledPin.artifactDigest,
    compiledPin.manifestDigest,
  ].every((value) => packagedMain.includes(value));
  if (
    manifest.platform !== platform ||
    manifest.architecture !== architecture ||
    manifest.protocolVersion !== 1 ||
    manifest.apiVersion !== 1 ||
    packagedArtifactCount !== 1 ||
    packagedManifestCount !== 1 ||
    hasAsarDuplicate ||
    !existsSync(artifactPath) ||
    !lstatSync(artifactPath).isFile() ||
    digest === null ||
    manifest.moduleDigest !== digest ||
    manifest.binaryDigest !== digest ||
    !mainContainsCompiledPin
  )
    throw new Error(`Packaged Computer Use native artifact verification failed for ${platform}`);
}

function countResourceBasename(directory: string, expectedName: string): number {
  let count = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.name === expectedName) count += 1;
    if (entry.isDirectory() && !entry.isSymbolicLink())
      count += countResourceBasename(path, expectedName);
  }
  return count;
}

export function refreshPackagedComputerUseArtifactDigest(
  resourcesPath: string,
  platform: 'darwin' | 'win32',
): string {
  const manifestPath = join(resourcesPath, 'computer-use-native.manifest.json');
  const artifactPath = join(
    resourcesPath,
    platform === 'darwin'
      ? 'sprint_coder_computer_use_native.node'
      : 'sprint-coder-computer-use-host.exe',
  );
  if (!lstatSync(artifactPath).isFile() || !lstatSync(manifestPath).isFile())
    throw new Error('Packaged Computer Use artifact or manifest is unavailable');
  const digest = createHash('sha256').update(readFileSync(artifactPath)).digest('hex');
  const manifest = computerUseNativeManifestSchema.parse(
    JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown,
  );
  if (manifest.platform !== platform)
    throw new Error('Packaged Computer Use manifest platform changed');
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ ...manifest, moduleDigest: digest, binaryDigest: digest }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return digest;
}

export function refreshPackagedComputerUseWindowsSignerDigest(
  resourcesPath: string,
): string | null {
  const artifactPath = join(resourcesPath, 'sprint-coder-computer-use-host.exe');
  const manifestPath = join(resourcesPath, 'computer-use-native.manifest.json');
  const signatureJson = execFileSync(
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$signature = Get-AuthenticodeSignature -LiteralPath $env:SPRINT_CODER_COMPUTER_USE_HELPER; [pscustomobject]@{Status=$signature.Status.ToString();Thumbprint=$signature.SignerCertificate.Thumbprint} | ConvertTo-Json -Compress',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, SPRINT_CODER_COMPUTER_USE_HELPER: artifactPath },
      windowsHide: true,
    },
  ).trim();
  const signature = JSON.parse(signatureJson) as { Status?: unknown; Thumbprint?: unknown };
  const signerDigest =
    signature.Status === 'Valid' &&
    typeof signature.Thumbprint === 'string' &&
    /^[0-9A-F]{40}$/u.test(signature.Thumbprint.toUpperCase())
      ? createHash('sha256').update(signature.Thumbprint.toUpperCase(), 'utf8').digest('hex')
      : null;
  if (windowsSign !== undefined && signerDigest === null)
    throw new Error('Signed Windows Computer Use helper failed Authenticode verification');
  const manifest = computerUseNativeManifestSchema.parse(
    JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown,
  );
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, signerDigest }, null, 2)}\n`, {
    mode: 0o600,
  });
  return signerDigest;
}

export function refreshComputerUseNativeMacModuleSignerDigest(
  resourcesPath: string,
): string | null {
  const artifactPath = join(resourcesPath, 'sprint_coder_computer_use_native.node');
  const manifestPath = join(resourcesPath, 'computer-use-native.manifest.json');
  const details = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', artifactPath], {
    encoding: 'utf8',
  });
  if (details.status !== 0)
    throw new Error('Unable to inspect the macOS Computer Use native module identity');
  const output = `${details.stdout ?? ''}\n${details.stderr ?? ''}`;
  const teamIdentifier = /(?:^|\n)TeamIdentifier=([^\n\r]+)/u.exec(output)?.[1]?.trim();
  const signerDigest =
    teamIdentifier !== undefined && MAC_TEAM_IDENTIFIER_PATTERN.test(teamIdentifier)
      ? createHash('sha256').update(teamIdentifier, 'utf8').digest('hex')
      : null;
  if (macCodeSignIdentity !== '-' && signerDigest === null)
    throw new Error('Developer ID-signed Computer Use native module has no TeamIdentifier');
  const manifest = computerUseNativeManifestSchema.parse(
    JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown,
  );
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, signerDigest }, null, 2)}\n`, {
    mode: 0o600,
  });
  return signerDigest;
}

/**
 * Stamp the native manifest with proof from the already signed macOS app. Build-time environment
 * variables are intentionally not accepted as signer evidence. The outer app is resealed by the
 * caller after this write, so the signer digest is covered by CodeResources.
 */
export function refreshPackagedComputerUseSignerDigest(appPath: string): string {
  const details = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', appPath], {
    encoding: 'utf8',
  });
  if (details.status !== 0)
    throw new Error('Unable to inspect the signed macOS Computer Use app identity');
  const output = `${details.stdout ?? ''}\n${details.stderr ?? ''}`;
  const teamIdentifier = /(?:^|\n)TeamIdentifier=([^\n\r]+)/u.exec(output)?.[1]?.trim();
  if (teamIdentifier === undefined || !MAC_TEAM_IDENTIFIER_PATTERN.test(teamIdentifier))
    throw new Error('Signed macOS Computer Use app identity is incomplete');
  const modulePath = join(
    appPath,
    'Contents',
    'Resources',
    'sprint_coder_computer_use_native.node',
  );
  const moduleDetails = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', modulePath], {
    encoding: 'utf8',
  });
  if (moduleDetails.status !== 0)
    throw new Error('Unable to inspect the signed macOS Computer Use native module identity');
  const moduleOutput = `${moduleDetails.stdout ?? ''}\n${moduleDetails.stderr ?? ''}`;
  const moduleTeamIdentifier = /(?:^|\n)TeamIdentifier=([^\n\r]+)/u.exec(moduleOutput)?.[1]?.trim();
  if (
    moduleTeamIdentifier !== teamIdentifier ||
    moduleTeamIdentifier === undefined ||
    !MAC_TEAM_IDENTIFIER_PATTERN.test(moduleTeamIdentifier)
  )
    throw new Error('macOS Computer Use app and native module signer identities differ');
  const signerDigest = createHash('sha256').update(teamIdentifier, 'utf8').digest('hex');
  const manifestPath = join(appPath, 'Contents', 'Resources', 'computer-use-native.manifest.json');
  const manifest = computerUseNativeManifestSchema.parse(
    JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown,
  );
  if (manifest.platform !== 'darwin')
    throw new Error('Packaged macOS Computer Use manifest is invalid');
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, signerDigest }, null, 2)}\n`, {
    mode: 0o600,
  });
  return signerDigest;
}

export function refreshPackagedSandboxRunnerDigest(appPath: string): string {
  const executable = join(appPath, 'Contents', 'Resources', 'sprint-coder-sandbox-runner');
  if (!lstatSync(executable).isFile())
    throw new Error('Packaged macOS sandbox runner was not found');
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

export function verifyBundledNodeResources(): void {
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
      `Import-Module "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1"; $signature = Get-AuthenticodeSignature -LiteralPath $env:SPRINT_CODER_NODE; [pscustomobject]@{Status=$signature.Status.ToString();Subject=$signature.SignerCertificate.Subject;Issuer=$signature.SignerCertificate.Issuer;Thumbprint=$signature.SignerCertificate.Thumbprint} | ConvertTo-Json -Compress`,
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

function signAdhocBundle(appPath: string): void {
  const targets: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (shouldSkipPackagerCodeSign(path)) continue;
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
    // Native addons and sharp's platform libvips/wasm payload cannot be loaded from app.asar.
    // Linux libvips is version-suffixed (for example libvips-cpp.so.8.18.3), so matching only
    // files that end in `.so` leaves Sharp's shared library trapped inside app.asar.
    asar: { unpack: NATIVE_ASAR_UNPACK_GLOB },
    extraResource: [
      ...bundledNodeResources(),
      ...sandboxRunnerResources(),
      ...computerUseNativeResources(),
      ...managedLocalSidecarResources(),
    ],
    extendInfo: {
      NSScreenCaptureUsageDescription:
        'Sprint Coder needs Screen Recording permission to observe the explicitly selected app window.',
    },
    ignore: shouldIgnoreFromPackage,
    // Production identities use @electron/osx-sign so nested Electron helpers and Frameworks keep
    // their per-process entitlements. Local ad-hoc packages are signed in the postPackage hook,
    // where the same dependency order is enforced without relying on unavailable Keychain IDs.
    ...(macCodeSignIdentity === '-'
      ? {}
      : {
          osxSign: {
            identity: macCodeSignIdentity,
            ignore: shouldSkipPackagerCodeSign,
          },
        }),
    ...(packagerWindowsSign === undefined ? {} : { windowsSign: packagerWindowsSign }),
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
    generateAssets: async (_forgeConfig, platform, architecture) => {
      buildComputerUseNative(platform, architecture);
      buildManagedLocalSidecar(platform, architecture);
    },
    prePackage: async (_forgeConfig, platform, architecture) => {
      assertNativePackagingHost(platform);
      await prepareComputerUseNativeForViteBuild(platform, architecture);
      if (platform === 'win32') verifyBundledNodeResources();
    },
    postPackage: async (_forgeConfig, packageResult) => {
      if (packageResult.platform !== 'darwin') {
        for (const outputPath of packageResult.outputPaths) {
          if (packageResult.platform === 'win32')
            refreshPackagedComputerUseArtifactDigest(join(outputPath, 'resources'), 'win32');
          if (packageResult.platform === 'win32')
            refreshPackagedComputerUseWindowsSignerDigest(join(outputPath, 'resources'));
          verifyPackagedComputerUseNativeBundle(
            outputPath,
            packageResult.platform,
            packageResult.arch,
          );
        }
        for (const outputPath of packageResult.outputPaths)
          await verifyPackagedManagedLocalSidecar(
            outputPath,
            packageResult.platform,
            packageResult.arch,
          );
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
        refreshPackagedComputerUseArtifactDigest(join(appPath, 'Contents', 'Resources'), 'darwin');
        if (macCodeSignIdentity !== '-') refreshPackagedComputerUseSignerDigest(appPath);
        resealMacAppBundle(appPath);
        execFileSync(
          '/usr/bin/codesign',
          ['--verify', '--deep', '--strict', '--verbose=2', appPath],
          { stdio: 'inherit' },
        );
        verifyPackagedComputerUseNativeBundle(
          outputPath,
          packageResult.platform,
          packageResult.arch,
        );
        await verifyPackagedManagedLocalSidecar(
          outputPath,
          packageResult.platform,
          packageResult.arch,
        );
      }
    },
    postMake: async (_forgeConfig, makeResults) =>
      createWindowsWizardInstaller(makeResults, {
        scriptPath: resolve(__dirname, 'installer', 'windows-wizard.iss'),
        iconPath: `${appIconPath}.ico`,
        ...(windowsSign === undefined ? {} : { signOptions: windowsSign }),
      }),
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
