import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
  computerUseNativeManifestSchema,
  type ComputerUseNativeManifest,
} from '@sprint-coder/contracts';
import {
  createWindowsComputerUseNativeAddon,
  windowsHelperEnvironment,
} from './computer-use-native-windows';
import type {
  ComputerUseNativeAddon,
  ComputerUseNativeBinding,
  ComputerUseNativeProbe,
} from './computer-use-native-types';
import {
  computerUseNativeCompiledPinMatches,
  parseComputerUseNativeCompiledPin,
  type ComputerUseNativeCompiledPin,
} from './computer-use-native-provenance';

export type {
  ComputerUseNativeAddon,
  ComputerUseNativeBinding,
  ComputerUseNativePlatform,
  ComputerUseNativeProbe,
} from './computer-use-native-types';

export const COMPUTER_USE_NATIVE_FEATURE_FLAG = 'SPRINT_CODER_COMPUTER_USE_DESKTOP_V1' as const;
export const COMPUTER_USE_NATIVE_PROTOCOL_VERSION = 1 as const;
export const COMPUTER_USE_NATIVE_API_VERSION = 1 as const;
export const COMPUTER_USE_NATIVE_NAPI_VERSION = 10 as const;
const COMPUTER_USE_NATIVE_MANIFEST_NAME = 'computer-use-native.manifest.json';
const COMPUTER_USE_NATIVE_MAX_PROBE_BYTES = 64 * 1024;
const ASAR_DIR_SEGMENT = `${sep}app.asar${sep}`;
const MAC_TEAM_IDENTIFIER_PATTERN = /^[A-Z0-9]{10}$/u;

export type ComputerUseNativeLoadOptions = Readonly<{
  /** Override the runtime environment in tests. Production callers must leave this undefined. */
  environment?: Readonly<Record<string, string | undefined>>;
  /** Override only for deterministic tests; the production loader derives this from __dirname. */
  dirname?: string;
  resourcesPath?: string;
  platform?: NodeJS.Platform;
  architecture?: string;
  requireAddon?: (path: string) => unknown;
  probeHelper?: (path: string) => unknown;
  /** Override only for deterministic tests; production uses the Vite-embedded package pin. */
  compiledPin?: ComputerUseNativeCompiledPin | null;
  verifySignature?: (
    platform: 'darwin' | 'win32',
    artifactPath: string,
    resourcesPath: string,
  ) => string | null;
}>;

const DENIED_PROBE = (
  reason: string,
  artifactPath: string | null = null,
  artifactDigest: string | null = null,
): ComputerUseNativeProbe =>
  Object.freeze({
    available: false,
    protocolVersion: COMPUTER_USE_NATIVE_PROTOCOL_VERSION,
    apiVersion: COMPUTER_USE_NATIVE_API_VERSION,
    backend: `${process.platform}-unavailable`,
    reason,
    artifactPath,
    artifactDigest,
    capabilities: Object.freeze({ observe: false, control: false }),
  });

/**
 * Resolve only a packaged resource or the repository's fixed build output.  The second path is
 * useful to the Gate 0 compiler/probe tests, but `loadComputerUseNative` never enables it as a
 * runtime capability.  In particular, arbitrary PATH/module resolution is intentionally absent.
 */
export function resolveComputerUseNativeArtifactPath(
  dirname: string,
  resourcesPath: string | undefined,
  platform: NodeJS.Platform,
  packaged: boolean,
): string | null {
  const artifactName =
    platform === 'darwin'
      ? 'sprint_coder_computer_use_native.node'
      : platform === 'win32'
        ? 'sprint-coder-computer-use-host.exe'
        : null;
  if (artifactName === null) return null;
  if (packaged) {
    if (resourcesPath === undefined || resourcesPath.length === 0) return null;
    return join(resolve(resourcesPath), artifactName);
  }
  return join(
    resolve(dirname, '..', '..', '..', 'computer-use-native', 'build', 'Release'),
    artifactName,
  );
}

export function resolveComputerUseNativeManifestPath(
  dirname: string,
  resourcesPath: string | undefined,
  platform: NodeJS.Platform,
  packaged: boolean,
): string | null {
  if (platform !== 'darwin' && platform !== 'win32' && platform !== 'linux') return null;
  if (packaged) {
    if (resourcesPath === undefined || resourcesPath.length === 0) return null;
    return join(resolve(resourcesPath), COMPUTER_USE_NATIVE_MANIFEST_NAME);
  }
  return join(
    resolve(dirname, '..', '..', '..', 'computer-use-native', 'build', 'Release'),
    COMPUTER_USE_NATIVE_MANIFEST_NAME,
  );
}

export function parseComputerUseNativeManifest(value: unknown): ComputerUseNativeManifest {
  return Object.freeze(computerUseNativeManifestSchema.parse(value));
}

export function evaluateComputerUseNativeGate(input: unknown): ComputerUseNativeProbe {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return DENIED_PROBE('INVALID_GATE_INPUT');
  const value = input as Record<string, unknown>;
  const manifest = value['manifest'];
  const probe = value['probe'];
  if (value['featureFlag'] !== true) return DENIED_PROBE('FEATURE_FLAG_DISABLED');
  if (value['packaged'] !== true) return DENIED_PROBE('PACKAGED_RUNTIME_REQUIRED');
  if (value['platform'] !== 'darwin' && value['platform'] !== 'win32')
    return DENIED_PROBE('PLATFORM_UNSUPPORTED');
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest))
    return DENIED_PROBE('MANIFEST_UNAVAILABLE');
  let parsed: ComputerUseNativeManifest;
  try {
    parsed = parseComputerUseNativeManifest(manifest);
  } catch {
    return DENIED_PROBE('MANIFEST_INVALID');
  }
  if (parsed.platform !== value['platform']) return DENIED_PROBE('ARTIFACT_UNAVAILABLE');
  if (Object.prototype.hasOwnProperty.call(value, 'compiledPin')) {
    let compiledPin: ComputerUseNativeCompiledPin;
    try {
      compiledPin = parseComputerUseNativeCompiledPin(value['compiledPin']);
    } catch {
      return DENIED_PROBE('COMPILED_PROVENANCE_UNAVAILABLE');
    }
    const candidateDigest = value['artifactDigest'];
    if (
      typeof candidateDigest !== 'string' ||
      !computerUseNativeCompiledPinMatches(compiledPin, parsed, candidateDigest)
    )
      return DENIED_PROBE('COMPILED_PROVENANCE_MISMATCH');
  }
  if (parsed.signerDigest === null && parsed.platform === 'darwin')
    return DENIED_PROBE('MACOS_SIGNATURE_REQUIRED');
  if (parsed.signerDigest === null && parsed.platform === 'win32')
    return DENIED_PROBE('WINDOWS_SIGNATURE_REQUIRED');
  if (!parsed.capabilities.includes('observe')) return DENIED_PROBE('OBSERVATION_UNSUPPORTED');
  if (!isProbe(probe)) return DENIED_PROBE('HANDSHAKE_INVALID');
  if (parsed.platform === 'win32' && probe.sourceCommit !== parsed.sourceCommit)
    return DENIED_PROBE('SOURCE_COMMIT_MISMATCH');
  if (probe.available !== true) return DENIED_PROBE('NATIVE_PROBE_UNAVAILABLE');
  const artifactDigest = parsed.platform === 'darwin' ? parsed.moduleDigest : parsed.binaryDigest;
  if (value['artifactDigest'] !== artifactDigest) return DENIED_PROBE('ARTIFACT_DIGEST_MISMATCH');
  return Object.freeze({
    available: true,
    protocolVersion: 1,
    apiVersion: 1,
    backend: probe.backend,
    reason: '',
    artifactPath: typeof value['artifactPath'] === 'string' ? value['artifactPath'] : null,
    artifactDigest,
    capabilities: Object.freeze({ observe: true, control: true }),
  });
}

function isProbe(value: unknown): value is Readonly<{
  protocolVersion: 1;
  apiVersion: 1;
  backend: string;
  available: boolean;
  sourceCommit?: string | null;
}> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const probe = value as Record<string, unknown>;
  return (
    probe['protocolVersion'] === 1 &&
    probe['apiVersion'] === 1 &&
    typeof probe['available'] === 'boolean' &&
    (probe['sourceCommit'] === undefined ||
      probe['sourceCommit'] === null ||
      /^[0-9a-f]{40}$/u.test(String(probe['sourceCommit']))) &&
    typeof probe['backend'] === 'string' &&
    probe['backend'].length > 0 &&
    probe['backend'].length <= 128
  );
}

export function loadComputerUseNative(
  options: ComputerUseNativeLoadOptions = {},
): ComputerUseNativeBinding {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? (process.arch === 'arm64' ? 'arm64' : 'x64');
  const dirname = options.dirname ?? __dirname;
  const packaged = dirname.includes(ASAR_DIR_SEGMENT);
  const artifactPath = resolveComputerUseNativeArtifactPath(
    dirname,
    options.resourcesPath ?? process.resourcesPath,
    platform,
    packaged,
  );
  const manifestPath = resolveComputerUseNativeManifestPath(
    dirname,
    options.resourcesPath ?? process.resourcesPath,
    platform,
    packaged,
  );
  if (environment[COMPUTER_USE_NATIVE_FEATURE_FLAG] !== '1')
    return deniedBinding('FEATURE_FLAG_DISABLED', null, artifactPath);
  if (!packaged) return deniedBinding('PACKAGED_RUNTIME_REQUIRED', null, artifactPath);
  if (platform !== 'darwin' && platform !== 'win32')
    return deniedBinding('PLATFORM_UNSUPPORTED', null, artifactPath);
  if (manifestPath === null || artifactPath === null)
    return deniedBinding('NATIVE_PATH_UNAVAILABLE');

  let manifest: ComputerUseNativeManifest;
  try {
    manifest = parseComputerUseNativeManifest(
      JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown,
    );
  } catch {
    return deniedBinding('MANIFEST_UNAVAILABLE', null, artifactPath);
  }
  if (manifest.platform !== platform || manifest.architecture !== architecture)
    return deniedBinding('MANIFEST_TARGET_MISMATCH', manifest, artifactPath);
  const compiledPin = resolveComputerUseNativeCompiledPin(options);
  if (compiledPin.required) {
    if (compiledPin.value === null)
      return deniedBinding('COMPILED_PROVENANCE_UNAVAILABLE', manifest, artifactPath);
    if (
      compiledPin.value.sourceCommit !== manifest.sourceCommit ||
      compiledPin.value.platform !== manifest.platform ||
      compiledPin.value.architecture !== manifest.architecture
    )
      return deniedBinding('COMPILED_PROVENANCE_MISMATCH', manifest, artifactPath);
  }
  if (manifest.signerDigest === null && platform === 'darwin')
    return deniedBinding('MACOS_SIGNATURE_REQUIRED', manifest, artifactPath);
  if (manifest.signerDigest === null && platform === 'win32')
    return deniedBinding('WINDOWS_SIGNATURE_REQUIRED', manifest, artifactPath);
  try {
    const stat = lstatSync(artifactPath);
    if (!stat.isFile() || stat.size <= 0)
      return deniedBinding('ARTIFACT_SIZE_MISMATCH', manifest, artifactPath);
    const digest = createHash('sha256').update(readFileSync(artifactPath)).digest('hex');
    const expectedDigest = platform === 'darwin' ? manifest.moduleDigest : manifest.binaryDigest;
    if (digest !== expectedDigest)
      return deniedBinding('ARTIFACT_DIGEST_MISMATCH', manifest, artifactPath, digest);
    if (
      compiledPin.required &&
      (compiledPin.value === null ||
        !computerUseNativeCompiledPinMatches(compiledPin.value, manifest, digest))
    )
      return deniedBinding('COMPILED_PROVENANCE_MISMATCH', manifest, artifactPath, digest);
    const resourcesPath = options.resourcesPath ?? process.resourcesPath;
    const verifiedSigner = (options.verifySignature ?? verifyComputerUseNativeSignature)(
      platform,
      artifactPath,
      resourcesPath,
    );
    if (verifiedSigner === null || verifiedSigner !== manifest.signerDigest)
      return deniedBinding('ARTIFACT_SIGNATURE_MISMATCH', manifest, artifactPath, digest);
    const raw = loadRawBinding(platform, artifactPath, manifest, options);
    const nativeProbe = parseNativeProbe(raw.probe());
    const handshake = raw.handshake?.({ protocolVersion: 1, apiVersion: 1, featureFlag: true });
    if (handshake === undefined) throw new Error('HANDSHAKE_UNAVAILABLE');
    parseNativeHandshake(handshake, platform);
    const result = evaluateComputerUseNativeGate({
      featureFlag: true,
      packaged: true,
      platform,
      manifest,
      probe: nativeProbe,
      artifactDigest: digest,
      artifactPath,
      ...(compiledPin.required ? { compiledPin: compiledPin.value } : {}),
    });
    if (!result.available)
      return Object.freeze({
        manifest,
        probe: result,
        artifactPath,
        addon: result.reason === 'NATIVE_PROBE_UNAVAILABLE' ? raw : null,
      });
    return Object.freeze({ manifest, probe: result, artifactPath, addon: raw });
  } catch (error) {
    const reason =
      error instanceof Error && error.message.length > 0 ? error.message : 'NATIVE_LOAD_FAILED';
    return deniedBinding(reason.slice(0, 128), manifest, artifactPath);
  }
}

function resolveComputerUseNativeCompiledPin(options: ComputerUseNativeLoadOptions): Readonly<{
  required: boolean;
  value: ComputerUseNativeCompiledPin | null;
}> {
  if (Object.prototype.hasOwnProperty.call(options, 'compiledPin')) {
    try {
      return {
        required: true,
        value:
          options.compiledPin === null
            ? null
            : parseComputerUseNativeCompiledPin(options.compiledPin),
      };
    } catch {
      return { required: true, value: null };
    }
  }
  if (typeof __SPRINT_CODER_COMPUTER_USE_NATIVE_PIN__ === 'undefined')
    return { required: false, value: null };
  try {
    return {
      required: true,
      value: parseComputerUseNativeCompiledPin(__SPRINT_CODER_COMPUTER_USE_NATIVE_PIN__),
    };
  } catch {
    return { required: true, value: null };
  }
}

export function verifyComputerUseNativeSignature(
  platform: 'darwin' | 'win32',
  artifactPath: string,
  resourcesPath: string,
): string | null {
  if (platform === 'darwin') {
    const appPath = resolve(resourcesPath, '..', '..');
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], {
      stdio: 'ignore',
      timeout: 10_000,
    });
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', artifactPath], {
      stdio: 'ignore',
      timeout: 10_000,
    });
    const details = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', artifactPath], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    if (details.status !== 0) return null;
    const output = `${details.stdout ?? ''}\n${details.stderr ?? ''}`;
    const teamIdentifier = /(?:^|\n)TeamIdentifier=([^\n\r]+)/u.exec(output)?.[1]?.trim();
    if (teamIdentifier === undefined || !MAC_TEAM_IDENTIFIER_PATTERN.test(teamIdentifier))
      return null;
    const appDetails = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', appPath], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    if (appDetails.status !== 0) return null;
    const appOutput = `${appDetails.stdout ?? ''}\n${appDetails.stderr ?? ''}`;
    const appTeamIdentifier = /(?:^|\n)TeamIdentifier=([^\n\r]+)/u.exec(appOutput)?.[1]?.trim();
    if (
      typeof appTeamIdentifier !== 'string' ||
      appTeamIdentifier !== teamIdentifier ||
      !MAC_TEAM_IDENTIFIER_PATTERN.test(appTeamIdentifier)
    )
      return null;
    return createHash('sha256').update(teamIdentifier, 'utf8').digest('hex');
  }
  const signatureJson = execFileSync(
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$helper = Get-AuthenticodeSignature -LiteralPath $env:SPRINT_CODER_COMPUTER_USE_HELPER; $app = Get-AuthenticodeSignature -LiteralPath $env:SPRINT_CODER_APP_EXE; [pscustomobject]@{HelperStatus=$helper.Status.ToString();AppStatus=$app.Status.ToString();HelperThumbprint=$helper.SignerCertificate.Thumbprint;AppThumbprint=$app.SignerCertificate.Thumbprint} | ConvertTo-Json -Compress',
    ],
    {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      env: {
        ...windowsHelperEnvironment(process.env),
        SPRINT_CODER_COMPUTER_USE_HELPER: artifactPath,
        SPRINT_CODER_APP_EXE: process.execPath,
      },
    },
  ).trim();
  const signature = JSON.parse(signatureJson) as {
    HelperStatus?: unknown;
    AppStatus?: unknown;
    HelperThumbprint?: unknown;
    AppThumbprint?: unknown;
  };
  if (
    signature.HelperStatus !== 'Valid' ||
    signature.AppStatus !== 'Valid' ||
    typeof signature.HelperThumbprint !== 'string' ||
    typeof signature.AppThumbprint !== 'string' ||
    signature.HelperThumbprint.toUpperCase() !== signature.AppThumbprint.toUpperCase() ||
    !/^[0-9A-F]{40}$/u.test(signature.HelperThumbprint.toUpperCase())
  )
    return null;
  return createHash('sha256')
    .update(signature.HelperThumbprint.toUpperCase(), 'utf8')
    .digest('hex');
}

function loadRawBinding(
  platform: NodeJS.Platform,
  artifactPath: string,
  manifest: ComputerUseNativeManifest,
  options: ComputerUseNativeLoadOptions,
): ComputerUseNativeAddon {
  if (platform === 'darwin') {
    const requireAddon =
      options.requireAddon ??
      ((path: string) => createRequire(join(__dirname, 'computer-use-native-loader.cjs'))(path));
    const value = requireAddon(artifactPath);
    if (!isAddon(value)) throw new Error('NATIVE_ADDON_INVALID');
    return value;
  }
  const probeHelper =
    options.probeHelper ??
    ((path: string) => {
      const text = execFileSync(path, ['--probe-json'], {
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
        maxBuffer: COMPUTER_USE_NATIVE_MAX_PROBE_BYTES,
      });
      return JSON.parse(text) as unknown;
    });
  const value = probeHelper(artifactPath);
  if (manifest.signerDigest === null) throw new Error('WINDOWS_SIGNATURE_REQUIRED');
  return createWindowsComputerUseNativeAddon(artifactPath, value, {
    binaryDigest: manifest.binaryDigest,
    signerDigest: manifest.signerDigest,
    sourceCommit: manifest.sourceCommit,
  });
}

function isAddon(value: unknown): value is ComputerUseNativeAddon {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { probe?: unknown }).probe === 'function'
  );
}

function parseNativeProbe(value: unknown): Readonly<{
  protocolVersion: 1;
  apiVersion: 1;
  backend: string;
  available: boolean;
  sourceCommit: string | null;
}> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('HANDSHAKE_INVALID');
  const probe = value as Record<string, unknown>;
  if (
    probe['protocolVersion'] !== 1 ||
    probe['apiVersion'] !== 1 ||
    typeof probe['backend'] !== 'string' ||
    probe['backend'].length === 0 ||
    probe['backend'].length > 128 ||
    typeof probe['available'] !== 'boolean' ||
    (probe['sourceCommit'] !== undefined &&
      (typeof probe['sourceCommit'] !== 'string' || !/^[0-9a-f]{40}$/u.test(probe['sourceCommit'])))
  )
    throw new Error('HANDSHAKE_INVALID');
  return Object.freeze({
    protocolVersion: 1,
    apiVersion: 1,
    backend: probe['backend'],
    available: probe['available'],
    sourceCommit: typeof probe['sourceCommit'] === 'string' ? probe['sourceCommit'] : null,
  });
}

function parseNativeHandshake(value: unknown, platform: NodeJS.Platform): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('HANDSHAKE_INVALID');
  const handshake = value as Record<string, unknown>;
  if (
    handshake['protocolVersion'] !== 1 ||
    handshake['apiVersion'] !== 1 ||
    handshake['platform'] !== platform ||
    handshake['napiVersion'] !== 10
  )
    throw new Error('HANDSHAKE_INVALID');
}

function deniedBinding(
  reason: string,
  manifest: ComputerUseNativeManifest | null = null,
  artifactPath: string | null = null,
  artifactDigest: string | null = null,
): ComputerUseNativeBinding {
  return Object.freeze({
    manifest: manifest ?? disabledManifest(),
    probe: DENIED_PROBE(reason, artifactPath, artifactDigest),
    artifactPath,
    addon: null,
  });
}

function disabledManifest(): ComputerUseNativeManifest {
  const manifest: ComputerUseNativeManifest = {
    version: 1,
    sourceCommit: '0'.repeat(40),
    protocolVersion: 1,
    apiVersion: 1,
    nativeVersion: 'disabled',
    moduleDigest: '0'.repeat(64),
    binaryDigest: '0'.repeat(64),
    signerDigest: null,
    capabilities: ['observe'],
    platform: process.platform === 'win32' ? 'win32' : 'darwin',
    architecture: process.arch === 'arm64' ? 'arm64' : 'x64',
  };
  return Object.freeze(manifest);
}
