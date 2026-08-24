import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const repositoryRoot = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(repositoryRoot, 'apps', 'desktop');
const releaseConfigPath = join(desktopRoot, 'managed-local-release.json');
const managedLocalRoot = join(desktopRoot, 'managed-local');
const cacheRoot = join(managedLocalRoot, 'cache');
const buildRoot = join(managedLocalRoot, 'build');
const packagedResourceRoot = join(buildRoot, 'managed-local');
const generatedPinsPath = join(buildRoot, 'managed-local-sidecar-pins.json');
const SHA256 = /^[a-f0-9]{64}$/u;
const TARGET = /^(darwin|linux|win32)-(arm64|x64)$/u;
const MAX_ARCHIVE_ENTRIES = 256;
const MAX_ARCHIVE_LIST_BYTES = 1024 * 1024;
const MAX_BUNDLE_ARTIFACTS = 128;

export function hostTarget(platform = process.platform, architecture = process.arch) {
  const target = `${platform}-${architecture}`;
  if (!TARGET.test(target)) throw new Error(`Unsupported Managed Local target: ${target}`);
  return target;
}

export function readManagedLocalReleaseConfig(path = releaseConfigPath) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (
    parsed?.schemaVersion !== 1 ||
    parsed.runtime !== 'llama.cpp' ||
    !/^b\d{1,8}$/u.test(parsed.runtimeVersion) ||
    parsed.upstreamRepository !== 'https://github.com/ggml-org/llama.cpp' ||
    !/^[a-f0-9]{40}$/u.test(parsed.upstreamRevision) ||
    !Number.isSafeInteger(parsed.licenseSize) ||
    parsed.licenseSize < 1 ||
    parsed.licenseSize > 128 * 1024 ||
    !SHA256.test(parsed.licenseSha256) ||
    typeof parsed.targets !== 'object' ||
    parsed.targets === null
  )
    throw new Error('Invalid Managed Local release configuration');
  for (const [target, value] of Object.entries(parsed.targets)) {
    if (
      !TARGET.test(target) ||
      typeof value !== 'object' ||
      value === null ||
      !/^llama-b\d+-bin-[a-z0-9.-]+\.(?:tar\.gz|zip)$/u.test(value.archiveName) ||
      !Number.isSafeInteger(value.archiveSize) ||
      value.archiveSize < 1 ||
      value.archiveSize > 512 * 1024 * 1024 ||
      !SHA256.test(value.archiveSha256) ||
      !Array.isArray(value.candidateBackends) ||
      !value.candidateBackends.includes('cpu') ||
      new Set(value.candidateBackends).size !== value.candidateBackends.length ||
      value.candidateBackends.some(
        (backend) => !['cpu', 'metal', 'cuda', 'vulkan'].includes(backend),
      )
    )
      throw new Error(`Invalid Managed Local target configuration: ${target}`);
  }
  return parsed;
}

export function validateArchiveEntries(text, runtimeVersion, target) {
  if (!TARGET.test(target)) throw new Error('Managed Local archive target is invalid');
  if (Buffer.byteLength(text, 'utf8') > MAX_ARCHIVE_LIST_BYTES)
    throw new Error('Managed Local archive listing is too large');
  const windows = target.startsWith('win32-');
  const root = windows ? '' : `llama-${runtimeVersion}/`;
  const entries = text.split(/\r?\n/u).filter(Boolean);
  if (entries.length < 3 || entries.length > MAX_ARCHIVE_ENTRIES)
    throw new Error('Managed Local archive entry count is invalid');
  for (const entry of entries) {
    if (
      entry.includes('\0') ||
      entry.includes('\\') ||
      entry.startsWith('/') ||
      (!windows && !entry.startsWith(root)) ||
      (windows && (entry.includes('/') || !/^[a-zA-Z0-9._+-]+$/u.test(entry))) ||
      entry
        .slice(root.length)
        .split('/')
        .some((part) => part === '..' || part === '.')
    )
      throw new Error('Managed Local archive contains an unsafe entry');
  }
  return entries;
}

export function responseLengthMatches(headers, pinnedSize) {
  const contentLength = Number(headers.get('content-length'));
  return (
    headers.get('content-encoding') !== null ||
    !Number.isFinite(contentLength) ||
    contentLength === pinnedSize
  );
}

export function createManagedLocalManifest({
  release,
  target,
  candidateBackends,
  server,
  license,
  dependencies,
}) {
  const [platform, architecture] = target.split('-');
  const artifacts = [
    artifactRecord('server', server),
    artifactRecord('license', license),
    ...dependencies
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((dependency) =>
        artifactRecord(
          'runtime_dependency',
          dependency,
          backendForDependency(dependency.name, candidateBackends),
        ),
      ),
  ];
  if (artifacts.length > MAX_BUNDLE_ARTIFACTS)
    throw new Error('Managed Local bundle contains too many runtime artifacts');
  return {
    schemaVersion: 1,
    runtime: 'llama.cpp',
    runtimeVersion: release.runtimeVersion,
    upstreamRepository: release.upstreamRepository,
    upstreamRevision: release.upstreamRevision,
    platform,
    architecture,
    candidateBackends,
    artifacts,
  };
}

function artifactRecord(role, input, backend) {
  return {
    role,
    path: input.relativePath,
    sha256: input.sha256,
    byteLength: input.byteLength,
    ...(backend === undefined ? {} : { backend }),
    ...(input.aliasTarget === undefined ? {} : { aliasTarget: input.aliasTarget }),
  };
}

function backendForDependency(name, candidateBackends) {
  const normalized = name.toLowerCase();
  if (normalized.includes('metal') && candidateBackends.includes('metal')) return 'metal';
  if (normalized.includes('cuda') && candidateBackends.includes('cuda')) return 'cuda';
  if (normalized.includes('vulkan') && candidateBackends.includes('vulkan')) return 'vulkan';
  if (normalized.includes('cpu')) return 'cpu';
  return undefined;
}

async function downloadPinnedArchive(release, targetConfig) {
  return downloadPinnedFile({
    name: targetConfig.archiveName,
    size: targetConfig.archiveSize,
    sha256: targetConfig.archiveSha256,
    url: `${release.upstreamRepository}/releases/download/${release.runtimeVersion}/${targetConfig.archiveName}`,
    label: 'archive',
  });
}

async function downloadPinnedLicense(release) {
  return downloadPinnedFile({
    name: `llama-${release.runtimeVersion}-LICENSE`,
    size: release.licenseSize,
    sha256: release.licenseSha256,
    url: `https://raw.githubusercontent.com/ggml-org/llama.cpp/${release.upstreamRevision}/LICENSE`,
    label: 'license',
  });
}

async function downloadPinnedFile({ name, size, sha256: expectedSha256, url, label }) {
  mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  const finalPath = join(cacheRoot, name);
  if (existsSync(finalPath)) {
    if (verifyFile(finalPath, size, expectedSha256)) return finalPath;
    rmSync(finalPath, { force: true });
  }
  const partialPath = `${finalPath}.partial`;
  rmSync(partialPath, { force: true });
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
  if (!response.ok || response.body === null)
    throw new Error(`Managed Local ${label} request failed with HTTP ${response.status}`);
  const finalUrl = new URL(response.url);
  const allowedHost =
    finalUrl.hostname === 'github.com' ||
    finalUrl.hostname.endsWith('.githubusercontent.com') ||
    finalUrl.hostname.endsWith('.github.com');
  if (finalUrl.protocol !== 'https:' || !allowedHost)
    throw new Error(`Managed Local ${label} redirected outside the allowed GitHub hosts`);
  if (!responseLengthMatches(response.headers, size))
    throw new Error(`Managed Local ${label} size changed before download`);
  let receivedBytes = 0;
  const sizeGate = new Transform({
    transform(chunk, _encoding, callback) {
      receivedBytes += chunk.length;
      callback(
        receivedBytes > size ? new Error(`Managed Local ${label} exceeded its pinned size`) : null,
        chunk,
      );
    },
  });
  await pipeline(
    Readable.fromWeb(response.body),
    sizeGate,
    createWriteStream(partialPath, { flags: 'wx', mode: 0o600 }),
  );
  if (!verifyFile(partialPath, size, expectedSha256))
    throw new Error(`Managed Local ${label} digest or size mismatch`);
  renameSync(partialPath, finalPath);
  return finalPath;
}

function verifyFile(path, expectedSize, expectedSha256) {
  const info = lstatSync(path);
  return (
    info.isFile() &&
    !info.isSymbolicLink() &&
    info.nlink === 1 &&
    info.size === expectedSize &&
    sha256(readFileSync(path)) === expectedSha256
  );
}

function extractArchive(archivePath, release, stagingRoot, target) {
  const listing = execFileSync('tar', ['-tf', archivePath], {
    encoding: 'utf8',
    maxBuffer: MAX_ARCHIVE_LIST_BYTES,
    windowsHide: true,
  });
  validateArchiveEntries(listing, release.runtimeVersion, target);
  const extractedRoot = join(stagingRoot, 'extracted');
  mkdirSync(extractedRoot, { mode: 0o700 });
  execFileSync('tar', ['-xf', archivePath, '-C', extractedRoot], {
    stdio: 'inherit',
    windowsHide: true,
  });
  const runtimeRoot = target.startsWith('win32-')
    ? extractedRoot
    : join(extractedRoot, `llama-${release.runtimeVersion}`);
  const rootInfo = lstatSync(runtimeRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error('Managed Local archive root is unsafe');
  return runtimeRoot;
}

function selectRuntimeArtifacts(runtimeRoot, target, fallbackLicensePath) {
  const platform = target.split('-')[0];
  const serverName = platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const entries = readdirSync(runtimeRoot, { withFileTypes: true });
  const files = new Map();
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      const symlinkPath = join(runtimeRoot, entry.name);
      const target = readlinkSync(symlinkPath);
      if (basename(target) !== target || !/^[a-zA-Z0-9._+-]+$/u.test(target))
        throw new Error('Managed Local archive contains an unsafe symlink');
      const canonical = realpathSync(symlinkPath);
      if (dirname(canonical) !== realpathSync(runtimeRoot) || !lstatSync(canonical).isFile())
        throw new Error('Managed Local archive symlink escaped its root');
      files.set(entry.name, {
        name: entry.name,
        path: canonical,
        aliasTarget: basename(canonical),
      });
      continue;
    }
    if (!entry.isFile()) continue;
    const path = join(runtimeRoot, entry.name);
    if (statSync(path).nlink !== 1) throw new Error('Managed Local archive contains a hardlink');
    files.set(entry.name, { name: entry.name, path });
  }
  const server = files.get(serverName);
  const license =
    files.get('LICENSE') ??
    (fallbackLicensePath === undefined
      ? undefined
      : { name: 'LICENSE', path: fallbackLicensePath });
  if (server === undefined || license === undefined)
    throw new Error('Managed Local archive is missing llama-server or LICENSE');
  const dependencyPattern =
    platform === 'darwin'
      ? /\.dylib$/u
      : platform === 'win32'
        ? /\.dll$/iu
        : /\.so(?:\.\d+(?:\.\d+)*)?$/u;
  const dependencies = [...files.values()].filter(
    ({ name }) => dependencyPattern.test(name) && isServerRuntimeDependency(name),
  );
  if (dependencies.length === 0)
    throw new Error('Managed Local archive has no runtime dependencies');
  return {
    server,
    license,
    dependencies,
  };
}

function isServerRuntimeDependency(name) {
  const normalized = name.toLowerCase();
  return (
    normalized.startsWith('libggml') ||
    normalized.startsWith('ggml') ||
    /^libllama(?:\.[0-9]+)*\.dylib$/u.test(normalized) ||
    /^libllama\.so(?:\.[0-9]+)*$/u.test(normalized) ||
    normalized === 'llama.dll' ||
    normalized.startsWith('libllama-server-impl') ||
    normalized.startsWith('llama-server-impl') ||
    normalized.startsWith('libllama-common') ||
    normalized.startsWith('llama-common') ||
    normalized.startsWith('libmtmd') ||
    normalized.startsWith('mtmd') ||
    normalized.startsWith('libomp')
  );
}

function materializeBundle(stagingTarget, selected) {
  const binRoot = join(stagingTarget, 'bin');
  const licenseRoot = join(stagingTarget, 'licenses');
  mkdirSync(binRoot, { recursive: true, mode: 0o700 });
  mkdirSync(licenseRoot, { recursive: true, mode: 0o700 });
  const copy = (input, destinationRoot, relativeRoot, mode) => {
    const destination = join(destinationRoot, input.name);
    if (input.aliasTarget === undefined) {
      copyFileSync(input.path, destination);
      chmodSync(destination, mode);
    } else {
      symlinkSync(input.aliasTarget, destination, 'file');
    }
    const bytes = readFileSync(input.path);
    return {
      name: input.name,
      path: destination,
      relativePath: `${relativeRoot}/${input.name}`,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
      ...(input.aliasTarget === undefined
        ? {}
        : { aliasTarget: `${relativeRoot}/${input.aliasTarget}` }),
    };
  };
  const server = copy(selected.server, binRoot, 'bin', 0o700);
  const license = copy(selected.license, licenseRoot, 'licenses', 0o600);
  const dependencies = selected.dependencies.map((dependency) =>
    copy(dependency, binRoot, 'bin', 0o700),
  );
  return { server, license, dependencies };
}

async function signNativeArtifacts(target, artifacts) {
  const platform = target.split('-')[0];
  const nativeFiles = [
    ...artifacts.dependencies
      .filter(({ aliasTarget }) => aliasTarget === undefined)
      .map(({ path }) => path),
    artifacts.server.path,
  ];
  if (platform === 'darwin') {
    const identity = process.env.SPRINT_CODER_CODESIGN_IDENTITY ?? '-';
    for (const path of nativeFiles) {
      if (identity !== '-')
        execFileSync(
          '/usr/bin/codesign',
          ['--force', '--options', 'runtime', '--timestamp', '--sign', identity, path],
          { stdio: 'inherit' },
        );
      execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', path], {
        stdio: 'inherit',
      });
    }
    return;
  }
  if (platform !== 'win32') return;
  const signing = windowsSigningOptions(process.env);
  if (signing === null) return;
  const { sign } = await import('@electron/windows-sign');
  await sign({ files: nativeFiles, description: 'Sprint Coder Managed Local', ...signing });
}

export function windowsSigningOptions(environment) {
  const certificateFile = environment.SPRINT_CODER_WINDOWS_CERTIFICATE_FILE;
  const certificatePassword = environment.SPRINT_CODER_WINDOWS_CERTIFICATE_PASSWORD;
  const certificateSha1 = environment.SPRINT_CODER_WINDOWS_CERTIFICATE_SHA1?.replaceAll(
    ' ',
    '',
  ).toUpperCase();
  if (certificateSha1 !== undefined && !/^[0-9A-F]{40}$/u.test(certificateSha1))
    throw new Error('Invalid Windows certificate thumbprint for Managed Local');
  if (
    certificateSha1 !== undefined &&
    (certificateFile !== undefined || certificatePassword !== undefined)
  )
    throw new Error('Managed Local Windows signing settings are mutually exclusive');
  if ((certificateFile === undefined) !== (certificatePassword === undefined))
    throw new Error('Managed Local Windows PFX settings are incomplete');
  if (certificateSha1 !== undefined) return { signWithParams: `/sha1 ${certificateSha1}` };
  if (certificateFile !== undefined && certificatePassword !== undefined)
    return { certificateFile, certificatePassword };
  return null;
}

function refreshArtifactDigests(artifacts) {
  const refresh = (artifact) => {
    const bytes = readFileSync(artifact.path);
    return { ...artifact, byteLength: bytes.byteLength, sha256: sha256(bytes) };
  };
  return {
    server: refresh(artifacts.server),
    license: refresh(artifacts.license),
    dependencies: artifacts.dependencies.map(refresh),
  };
}

function probeServer(server, release, target) {
  const result = spawnSync(server.path, ['--version'], {
    cwd: dirname(server.path),
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`Managed Local launch probe failed for ${target}`);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const build = release.runtimeVersion.slice(1);
  if (!output.includes(`build ${build}`) || !output.includes(release.upstreamRevision.slice(0, 9)))
    throw new Error('Managed Local launch probe returned an unexpected version');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function prepareManagedLocalSidecar(target = hostTarget()) {
  if (target !== hostTarget())
    throw new Error('Managed Local cross-target preparation is forbidden');
  const release = readManagedLocalReleaseConfig();
  const targetConfig = release.targets[target];
  if (targetConfig === undefined) throw new Error(`No Managed Local release asset for ${target}`);
  const archivePath = await downloadPinnedArchive(release, targetConfig);
  const fallbackLicensePath = target.startsWith('win32-')
    ? await downloadPinnedLicense(release)
    : undefined;
  mkdirSync(buildRoot, { recursive: true, mode: 0o700 });
  const stagingRoot = mkdtempSync(join(buildRoot, '.staging-'));
  try {
    const runtimeRoot = extractArchive(archivePath, release, stagingRoot, target);
    const selected = selectRuntimeArtifacts(runtimeRoot, target, fallbackLicensePath);
    if (!verifyFile(selected.license.path, release.licenseSize, release.licenseSha256))
      throw new Error('Managed Local LICENSE digest or size mismatch');
    const stagingTarget = join(stagingRoot, 'bundle', target);
    let artifacts = materializeBundle(stagingTarget, selected);
    await signNativeArtifacts(target, artifacts);
    artifacts = refreshArtifactDigests(artifacts);
    probeServer(artifacts.server, release, target);
    const manifest = createManagedLocalManifest({
      release,
      target,
      candidateBackends: targetConfig.candidateBackends,
      ...artifacts,
    });
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const manifestSha256 = sha256(manifestBytes);
    writeFileSync(join(stagingTarget, 'managed-local-manifest.json'), manifestBytes, {
      mode: 0o600,
    });

    rmSync(packagedResourceRoot, { recursive: true, force: true });
    mkdirSync(packagedResourceRoot, { recursive: true, mode: 0o700 });
    const finalTarget = join(packagedResourceRoot, target);
    renameSync(stagingTarget, finalTarget);
    mkdirSync(dirname(generatedPinsPath), { recursive: true, mode: 0o700 });
    const pin = {
      target,
      runtimeVersion: release.runtimeVersion,
      upstreamRevision: release.upstreamRevision,
      manifestSha256,
    };
    writeFileSync(generatedPinsPath, `${JSON.stringify({ [target]: pin }, null, 2)}\n`, {
      mode: 0o600,
    });
    return { target, bundlePath: finalTarget, manifestSha256, pin };
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

async function main() {
  const requestedTarget = process.argv[2] ?? hostTarget();
  const result = await prepareManagedLocalSidecar(requestedTarget);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
