import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, readlink, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';

const SHA256 = /^[a-f0-9]{64}$/u;
const UPSTREAM_REVISION = /^[a-f0-9]{40}$/u;
const RUNTIME_VERSION = /^[a-zA-Z0-9._+-]{1,64}$/u;
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const MANIFEST_NAME = 'managed-local-manifest.json';

const managedLocalPlatformSchema = z.enum(['darwin', 'win32', 'linux']);
const managedLocalArchitectureSchema = z.enum(['x64', 'arm64']);
const managedLocalBackendSchema = z.enum(['cpu', 'metal', 'cuda', 'vulkan']);
const managedLocalArtifactRoleSchema = z.enum(['server', 'license', 'runtime_dependency']);

export type ManagedLocalPlatform = z.infer<typeof managedLocalPlatformSchema>;
export type ManagedLocalArchitecture = z.infer<typeof managedLocalArchitectureSchema>;
export type ManagedLocalBackend = z.infer<typeof managedLocalBackendSchema>;
export type ManagedLocalTargetKey = `${ManagedLocalPlatform}-${ManagedLocalArchitecture}`;

function safeArtifactPath(value: string): boolean {
  if (value.includes('\\') || value.includes('\0') || value.startsWith('/') || isAbsolute(value))
    return false;
  const parts = value.split('/');
  return (
    parts.length > 0 &&
    parts.every(
      (part) =>
        part.length > 0 &&
        part.length <= 255 &&
        part !== '.' &&
        part !== '..' &&
        /^[a-zA-Z0-9._+-]+$/u.test(part),
    )
  );
}

const managedLocalArtifactSchema = z
  .object({
    role: managedLocalArtifactRoleSchema,
    path: z.string().min(1).max(512).refine(safeArtifactPath, 'Unsafe artifact path'),
    sha256: z.string().regex(SHA256),
    byteLength: z.number().int().positive().max(MAX_ARTIFACT_BYTES),
    backend: managedLocalBackendSchema.optional(),
    aliasTarget: z
      .string()
      .min(1)
      .max(512)
      .refine(safeArtifactPath, 'Unsafe alias target')
      .optional(),
  })
  .strict()
  .superRefine((artifact, context) => {
    if (artifact.role !== 'runtime_dependency' && artifact.backend !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['backend'],
        message: 'Only runtime dependencies may be backend-specific',
      });
    if (artifact.role !== 'runtime_dependency' && artifact.aliasTarget !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['aliasTarget'],
        message: 'Only runtime dependencies may be aliases',
      });
    if (artifact.aliasTarget === artifact.path)
      context.addIssue({
        code: 'custom',
        path: ['aliasTarget'],
        message: 'Runtime alias cannot target itself',
      });
  });

export const managedLocalSidecarManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    runtime: z.literal('llama.cpp'),
    runtimeVersion: z.string().regex(RUNTIME_VERSION),
    upstreamRepository: z.literal('https://github.com/ggml-org/llama.cpp'),
    upstreamRevision: z.string().regex(UPSTREAM_REVISION),
    platform: managedLocalPlatformSchema,
    architecture: managedLocalArchitectureSchema,
    candidateBackends: z.array(managedLocalBackendSchema).min(1).max(4),
    artifacts: z.array(managedLocalArtifactSchema).min(2).max(128),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (!manifest.candidateBackends.includes('cpu'))
      context.addIssue({
        code: 'custom',
        path: ['candidateBackends'],
        message: 'Managed Local requires a CPU fallback',
      });
    if (new Set(manifest.candidateBackends).size !== manifest.candidateBackends.length)
      context.addIssue({
        code: 'custom',
        path: ['candidateBackends'],
        message: 'Duplicate candidate backend',
      });
    if (manifest.candidateBackends.includes('metal') && manifest.platform !== 'darwin')
      context.addIssue({
        code: 'custom',
        path: ['candidateBackends'],
        message: 'Metal is only valid for macOS bundles',
      });
    const paths = manifest.artifacts.map(({ path }) => path);
    if (new Set(paths).size !== paths.length)
      context.addIssue({ code: 'custom', path: ['artifacts'], message: 'Duplicate artifact path' });
    for (const [index, artifact] of manifest.artifacts.entries()) {
      if (artifact.aliasTarget === undefined) continue;
      const target = manifest.artifacts.find(({ path }) => path === artifact.aliasTarget);
      const parent = artifact.path.split('/').slice(0, -1).join('/');
      const targetParent = artifact.aliasTarget.split('/').slice(0, -1).join('/');
      if (
        target === undefined ||
        target.aliasTarget !== undefined ||
        target.role !== 'runtime_dependency' ||
        parent !== targetParent
      )
        context.addIssue({
          code: 'custom',
          path: ['artifacts', index, 'aliasTarget'],
          message: 'Runtime alias must target a declared regular dependency in the same directory',
        });
    }
    for (const role of ['server', 'license'] as const) {
      if (manifest.artifacts.filter((artifact) => artifact.role === role).length !== 1)
        context.addIssue({
          code: 'custom',
          path: ['artifacts'],
          message: `Managed Local requires exactly one ${role} artifact`,
        });
    }
    for (const [index, artifact] of manifest.artifacts.entries())
      if (artifact.backend !== undefined && !manifest.candidateBackends.includes(artifact.backend))
        context.addIssue({
          code: 'custom',
          path: ['artifacts', index, 'backend'],
          message: 'Artifact backend is not declared by the bundle',
        });
  });

export type ManagedLocalSidecarManifest = z.infer<typeof managedLocalSidecarManifestSchema>;
type ManagedLocalArtifact = z.infer<typeof managedLocalArtifactSchema>;
type VerifiedManagedLocalSidecarManifest = Readonly<
  Omit<ManagedLocalSidecarManifest, 'candidateBackends' | 'artifacts'> & {
    candidateBackends: readonly ManagedLocalBackend[];
    artifacts: readonly Readonly<ManagedLocalArtifact>[];
  }
>;

const managedLocalSidecarPinSchema = z
  .object({
    target: z.string().regex(/^(?:darwin|win32|linux)-(?:x64|arm64)$/u),
    runtimeVersion: z.string().regex(RUNTIME_VERSION),
    upstreamRevision: z.string().regex(UPSTREAM_REVISION),
    manifestSha256: z.string().regex(SHA256),
  })
  .strict();

export type ManagedLocalSidecarPin = z.infer<typeof managedLocalSidecarPinSchema>;

declare const __SPRINT_CODER_MANAGED_LOCAL_SIDECAR_PINS__: unknown;

function compiledManagedLocalSidecarPins(
  value: unknown,
): Readonly<Partial<Record<ManagedLocalTargetKey, ManagedLocalSidecarPin>>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid compiled Managed Local sidecar pins');
  const pins: Partial<Record<ManagedLocalTargetKey, ManagedLocalSidecarPin>> = {};
  for (const [target, rawPin] of Object.entries(value)) {
    const parsedTarget = /^(?:darwin|win32|linux)-(?:x64|arm64)$/u.test(target);
    const parsedPin = managedLocalSidecarPinSchema.safeParse(rawPin);
    if (!parsedTarget || !parsedPin.success || parsedPin.data.target !== target)
      throw new Error('Invalid compiled Managed Local sidecar pin');
    pins[target as ManagedLocalTargetKey] = Object.freeze(parsedPin.data);
  }
  return Object.freeze(pins);
}

/**
 * Populated only by a later native-build Slice after the exact target artifact has been built,
 * signed where required, launch-probed, and its final packaged manifest digest is known.
 * An absent pin is an unsupported target, never a request to search PATH or download a binary.
 */
export const BUNDLED_MANAGED_LOCAL_SIDECAR_PINS: Readonly<
  Partial<Record<ManagedLocalTargetKey, ManagedLocalSidecarPin>>
> = compiledManagedLocalSidecarPins(
  typeof __SPRINT_CODER_MANAGED_LOCAL_SIDECAR_PINS__ === 'undefined'
    ? {}
    : __SPRINT_CODER_MANAGED_LOCAL_SIDECAR_PINS__,
);

export type VerifiedManagedLocalSidecarBundle = Readonly<{
  target: ManagedLocalTargetKey;
  rootPath: string;
  manifest: VerifiedManagedLocalSidecarManifest;
  manifestSha256: string;
  serverPath: string;
  licensePath: string;
  artifactPaths: Readonly<Record<string, string>>;
}>;

export type ManagedLocalSidecarErrorCode =
  | 'unsupported_target'
  | 'unsafe_bundle'
  | 'invalid_manifest'
  | 'manifest_mismatch'
  | 'artifact_mismatch';

export class ManagedLocalSidecarError extends Error {
  constructor(
    readonly code: ManagedLocalSidecarErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ManagedLocalSidecarError';
  }
}

export function managedLocalTargetKey(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): ManagedLocalTargetKey | null {
  if (!managedLocalPlatformSchema.safeParse(platform).success) return null;
  if (!managedLocalArchitectureSchema.safeParse(architecture).success) return null;
  return `${platform as ManagedLocalPlatform}-${architecture as ManagedLocalArchitecture}`;
}

export function managedLocalSidecarBundleRoot(
  input: Readonly<{
    target: ManagedLocalTargetKey;
    packaged?: boolean;
    resourcesPath?: string;
    moduleDirectory?: string;
  }>,
): string {
  const packaged = input.packaged ?? __dirname.includes('app.asar');
  if (packaged) {
    const resourcesPath = input.resourcesPath ?? process.resourcesPath;
    if (typeof resourcesPath !== 'string' || resourcesPath.length === 0)
      throw new ManagedLocalSidecarError(
        'unsafe_bundle',
        'Packaged Managed Local resource root is unavailable',
      );
    return join(resourcesPath, 'managed-local', input.target);
  }
  return join(
    input.moduleDirectory ?? __dirname,
    '..',
    '..',
    'managed-local',
    'build',
    'managed-local',
    input.target,
  );
}

export async function loadBundledManagedLocalSidecar(
  input: Readonly<{
    rootPath?: string;
    pins?: Readonly<Partial<Record<ManagedLocalTargetKey, ManagedLocalSidecarPin>>>;
  }> = {},
): Promise<VerifiedManagedLocalSidecarBundle> {
  const target = managedLocalTargetKey();
  if (target === null)
    throw new ManagedLocalSidecarError(
      'unsupported_target',
      'Managed Local is unsupported on this platform and architecture',
    );
  const pin = (input.pins ?? BUNDLED_MANAGED_LOCAL_SIDECAR_PINS)[target];
  if (pin === undefined)
    throw new ManagedLocalSidecarError(
      'unsupported_target',
      'No verified Managed Local sidecar is bundled for this target',
    );
  return verifyManagedLocalSidecarBundle(
    input.rootPath ?? managedLocalSidecarBundleRoot({ target }),
    pin,
  );
}

export async function verifyManagedLocalSidecarBundle(
  rootPath: string,
  pinInput: ManagedLocalSidecarPin,
): Promise<VerifiedManagedLocalSidecarBundle> {
  const pin = parsePin(pinInput);
  const target = pin.target as ManagedLocalTargetKey;
  if (managedLocalTargetKey() !== target)
    throw new ManagedLocalSidecarError(
      'unsupported_target',
      'Managed Local bundle target does not match the native host',
    );
  const root = await canonicalBundleRoot(rootPath);
  const manifestPath = join(root, MANIFEST_NAME);
  const manifestBytes = await readStableRegularFile(manifestPath, MAX_MANIFEST_BYTES);
  const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
  if (manifestSha256 !== pin.manifestSha256)
    throw new ManagedLocalSidecarError(
      'manifest_mismatch',
      'Managed Local manifest does not match the application pin',
    );

  const manifest = parseManifest(manifestBytes);
  if (
    `${manifest.platform}-${manifest.architecture}` !== target ||
    manifest.runtimeVersion !== pin.runtimeVersion ||
    manifest.upstreamRevision !== pin.upstreamRevision
  )
    throw new ManagedLocalSidecarError(
      'manifest_mismatch',
      'Managed Local manifest identity does not match the application pin',
    );

  const artifactPaths = new Map<string, string>();
  for (const artifact of manifest.artifacts) {
    const path = await resolveBundleArtifact(root, artifact);
    const digest = await hashStableRegularFile(path, artifact.byteLength);
    if (digest !== artifact.sha256)
      throw new ManagedLocalSidecarError(
        'artifact_mismatch',
        'Managed Local artifact does not match its pinned digest',
      );
    if (artifact.role === 'server') await assertExecutable(path, manifest.platform);
    artifactPaths.set(artifact.path, path);
  }

  const server = manifest.artifacts.find((artifact) => artifact.role === 'server')!;
  const license = manifest.artifacts.find((artifact) => artifact.role === 'license')!;
  return Object.freeze({
    target,
    rootPath: root,
    manifest: Object.freeze({
      ...manifest,
      candidateBackends: Object.freeze([...manifest.candidateBackends]),
      artifacts: Object.freeze(manifest.artifacts.map((artifact) => Object.freeze(artifact))),
    }),
    manifestSha256,
    serverPath: artifactPaths.get(server.path)!,
    licensePath: artifactPaths.get(license.path)!,
    artifactPaths: Object.freeze(Object.fromEntries(artifactPaths)),
  });
}

function parsePin(input: ManagedLocalSidecarPin): ManagedLocalSidecarPin {
  const result = managedLocalSidecarPinSchema.safeParse(input);
  if (!result.success)
    throw new ManagedLocalSidecarError('invalid_manifest', 'Invalid Managed Local application pin');
  return result.data;
}

function parseManifest(bytes: Buffer): ManagedLocalSidecarManifest {
  try {
    const value = JSON.parse(bytes.toString('utf8')) as unknown;
    const result = managedLocalSidecarManifestSchema.safeParse(value);
    if (!result.success) throw new Error('schema');
    return result.data;
  } catch {
    throw new ManagedLocalSidecarError('invalid_manifest', 'Invalid Managed Local manifest');
  }
}

async function canonicalBundleRoot(rootPath: string): Promise<string> {
  try {
    const lexical = await lstat(rootPath, { bigint: true });
    if (!lexical.isDirectory() || lexical.isSymbolicLink()) throw new Error('unsafe');
    const canonical = await realpath(rootPath);
    const canonicalInfo = await lstat(canonical, { bigint: true });
    if (
      !canonicalInfo.isDirectory() ||
      canonicalInfo.isSymbolicLink() ||
      lexical.dev !== canonicalInfo.dev ||
      lexical.ino !== canonicalInfo.ino
    )
      throw new Error('unsafe');
    return canonical;
  } catch {
    throw new ManagedLocalSidecarError('unsafe_bundle', 'Managed Local bundle root is unsafe');
  }
}

async function resolveBundleArtifact(
  root: string,
  artifact: ManagedLocalArtifact,
): Promise<string> {
  try {
    const artifactPath = artifact.path;
    const parts = artifactPath.split('/');
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part);
      const info = await lstat(parent, { bigint: true });
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe');
    }
    const candidate = join(root, ...parts);
    const lexical = await lstat(candidate, { bigint: true });
    if (artifact.aliasTarget !== undefined) {
      if (!lexical.isSymbolicLink()) throw new Error('unsafe');
      const linkTarget = await readlink(candidate);
      const expectedLeaf = artifact.aliasTarget.split('/').at(-1);
      if (linkTarget !== expectedLeaf) throw new Error('unsafe');
      const declaredTarget = join(root, ...artifact.aliasTarget.split('/'));
      const targetInfo = await lstat(declaredTarget, { bigint: true });
      if (!targetInfo.isFile() || targetInfo.isSymbolicLink()) throw new Error('unsafe');
      const canonical = await realpath(candidate);
      if (canonical !== (await realpath(declaredTarget))) throw new Error('escape');
      return canonical;
    }
    if (!lexical.isFile() || lexical.isSymbolicLink()) throw new Error('unsafe');
    const canonical = await realpath(candidate);
    const child = relative(root, canonical);
    if (child === '' || child.startsWith('..') || isAbsolute(child)) throw new Error('escape');
    const canonicalInfo = await lstat(canonical, { bigint: true });
    if (lexical.dev !== canonicalInfo.dev || lexical.ino !== canonicalInfo.ino)
      throw new Error('unsafe');
    return canonical;
  } catch {
    throw new ManagedLocalSidecarError('unsafe_bundle', 'Managed Local artifact path is unsafe');
  }
}

async function readStableRegularFile(path: string, maxBytes: number): Promise<Buffer> {
  let handle: FileHandle | undefined;
  try {
    const before = await lstat(path, { bigint: true });
    assertSafeFile(before, maxBytes);
    handle = await open(
      path,
      constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
    );
    const opened = await handle.stat({ bigint: true });
    assertSameFile(before, opened);
    const length = Number(opened.size);
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(bytes, offset, length - offset, offset);
      if (bytesRead === 0) throw new Error('short read');
      offset += bytesRead;
    }
    const overflow = Buffer.alloc(1);
    if ((await handle.read(overflow, 0, 1, length)).bytesRead !== 0) throw new Error('grew');
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    assertSameFile(opened, after);
    assertSameFile(after, pathAfter);
    return bytes;
  } catch (error) {
    if (error instanceof ManagedLocalSidecarError) throw error;
    throw new ManagedLocalSidecarError('unsafe_bundle', 'Managed Local file is unsafe');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function hashStableRegularFile(path: string, expectedBytes: number): Promise<string> {
  let handle: FileHandle | undefined;
  try {
    const before = await lstat(path, { bigint: true });
    assertSafeFile(before, expectedBytes);
    if (before.size !== BigInt(expectedBytes)) throw new Error('size mismatch');
    handle = await open(
      path,
      constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
    );
    const opened = await handle.stat({ bigint: true });
    assertSameFile(before, opened);
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < expectedBytes) {
      const requested = Math.min(buffer.byteLength, expectedBytes - offset);
      const { bytesRead } = await handle.read(buffer, 0, requested, offset);
      if (bytesRead === 0) throw new Error('short read');
      digest.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const overflow = Buffer.alloc(1);
    if ((await handle.read(overflow, 0, 1, expectedBytes)).bytesRead !== 0) throw new Error('grew');
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    assertSameFile(opened, after);
    assertSameFile(after, pathAfter);
    return digest.digest('hex');
  } catch (error) {
    if (error instanceof ManagedLocalSidecarError) throw error;
    throw new ManagedLocalSidecarError(
      'artifact_mismatch',
      'Managed Local artifact is unsafe or changed',
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

type FileIdentity = BigIntStats;

function assertSafeFile(info: FileIdentity, maxBytes: number): void {
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1n ||
    info.size < 1n ||
    info.size > BigInt(maxBytes)
  )
    throw new Error('unsafe file');
}

function assertSameFile(left: FileIdentity, right: FileIdentity): void {
  if (
    left.dev !== right.dev ||
    left.ino !== right.ino ||
    left.size !== right.size ||
    left.mode !== right.mode ||
    left.nlink !== right.nlink ||
    left.mtimeNs !== right.mtimeNs ||
    left.ctimeNs !== right.ctimeNs
  )
    throw new Error('file changed');
}

async function assertExecutable(path: string, platform: ManagedLocalPlatform): Promise<void> {
  const info = await lstat(path, { bigint: true });
  if (platform === 'win32') {
    if (!path.toLowerCase().endsWith('.exe'))
      throw new ManagedLocalSidecarError(
        'artifact_mismatch',
        'Windows Managed Local server must be an executable image',
      );
    return;
  }
  if ((info.mode & 0o111n) === 0n)
    throw new ManagedLocalSidecarError(
      'artifact_mismatch',
      'Managed Local server is not executable',
    );
}
