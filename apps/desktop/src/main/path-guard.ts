import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, readlink, realpath, stat, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { PathClassification, PermissionResource } from '@sprint-coder/domain';

export type PathOperation = 'read' | 'write' | 'rename' | 'delete';
export type FileIdentity = {
  dev: string;
  ino: string;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  nlink: number;
  kind: 'file' | 'directory' | 'symlink' | 'other';
};
export type PathChainEntry = {
  lexicalPath: string;
  identity: FileIdentity;
  linkTarget: string | null;
};
export type CanonicalPathIdentity = {
  rootId: string;
  workspacePath: string;
  originalTargetPath: string;
  resolvedPath: string;
  operation: PathOperation;
  parentIdentity: FileIdentity;
  targetIdentity: FileIdentity | null;
  chain: readonly PathChainEntry[];
};
export type PathGuard = Readonly<CanonicalPathIdentity>;
const issuedPathGuards = new WeakSet<object>();
export type PathGuardErrorCode =
  | 'INVALID_PATH'
  | 'RELATIVE_TRAVERSAL'
  | 'PATH_NOT_FOUND'
  | 'PATH_ESCAPE'
  | 'IDENTITY_CHANGED'
  | 'UNSUPPORTED_RACE_SAFE_OPERATION'
  | 'SPECIAL_FILE'
  | 'HARDLINK_WRITE_DENIED';

export class PathGuardError extends Error {
  constructor(
    readonly code: PathGuardErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PathGuardError';
  }
}

export async function canonicalizeResourcePath(input: {
  rootId?: string | undefined;
  workspacePath: string;
  targetPath: string;
  operation: PathOperation;
}): Promise<CanonicalPathIdentity> {
  validateInput(input.targetPath);
  const workspacePath = await resolveExisting(input.workspacePath, 'PATH_NOT_FOUND');
  const workspaceStats = await stat(workspacePath, { bigint: true });
  if (!workspaceStats.isDirectory())
    throw new PathGuardError('INVALID_PATH', 'Workspace must be a directory');

  const lexicalTarget = isAbsolute(input.targetPath)
    ? resolve(input.targetPath)
    : resolve(workspacePath, input.targetPath);
  if (!isAbsolute(input.targetPath) && hasTraversalSegment(input.targetPath))
    throw new PathGuardError('RELATIVE_TRAVERSAL', 'Relative traversal is not allowed');
  if (!isAbsolute(input.targetPath)) assertContained(workspacePath, lexicalTarget);

  const { existingPath, missingParts } = await nearestExistingAncestor(lexicalTarget);
  if (input.operation !== 'write' && missingParts.length > 0)
    throw new PathGuardError('PATH_NOT_FOUND', 'Target does not exist');

  const canonicalAncestor = await resolveExisting(existingPath, 'PATH_NOT_FOUND');
  assertContained(workspacePath, canonicalAncestor);
  const resolvedPath = join(canonicalAncestor, ...missingParts);
  assertContained(workspacePath, resolvedPath);

  const targetIdentity =
    missingParts.length === 0 ? toIdentity(await lstat(existingPath, { bigint: true })) : null;
  const canonicalTarget =
    missingParts.length === 0
      ? await resolveExisting(existingPath, 'PATH_NOT_FOUND')
      : resolvedPath;
  assertContained(workspacePath, canonicalTarget);
  const parentPath =
    canonicalTarget === workspacePath
      ? workspacePath
      : await resolveExisting(dirname(canonicalTarget), 'PATH_NOT_FOUND');
  assertContained(workspacePath, parentPath);
  const parentIdentity = toIdentity(await stat(parentPath, { bigint: true }));
  const chain = await snapshotLexicalChain(workspacePath, lexicalTarget);

  return {
    rootId: input.rootId ?? 'legacy-primary',
    workspacePath,
    originalTargetPath: input.targetPath,
    resolvedPath: canonicalTarget,
    operation: input.operation,
    parentIdentity,
    targetIdentity,
    chain,
  };
}

export async function createPathGuard(input: {
  rootId?: string | undefined;
  workspacePath: string;
  targetPath: string;
  operation: PathOperation;
}): Promise<PathGuard> {
  const identity = await canonicalizeResourcePath(input);
  const guard = Object.freeze({
    ...identity,
    parentIdentity: Object.freeze({ ...identity.parentIdentity }),
    targetIdentity:
      identity.targetIdentity === null ? null : Object.freeze({ ...identity.targetIdentity }),
    chain: Object.freeze(
      identity.chain.map((entry) =>
        Object.freeze({ ...entry, identity: Object.freeze({ ...entry.identity }) }),
      ),
    ),
  });
  issuedPathGuards.add(guard);
  return guard;
}

export function isIssuedPathGuard(value: PathGuard): boolean {
  return issuedPathGuards.has(value);
}

export async function revalidatePathGuard(guard: PathGuard): Promise<CanonicalPathIdentity> {
  let current: CanonicalPathIdentity;
  try {
    current = await canonicalizeResourcePath({
      rootId: guard.rootId,
      workspacePath: guard.workspacePath,
      targetPath: guard.originalTargetPath,
      operation: guard.operation,
    });
  } catch (error) {
    if (error instanceof PathGuardError && error.code === 'PATH_ESCAPE') throw error;
    throw new PathGuardError('IDENTITY_CHANGED', 'Path identity changed before execution');
  }
  if (
    current.rootId !== guard.rootId ||
    current.workspacePath !== guard.workspacePath ||
    current.resolvedPath !== guard.resolvedPath ||
    !sameIdentity(current.parentIdentity, guard.parentIdentity) ||
    !sameOptionalIdentity(current.targetIdentity, guard.targetIdentity) ||
    !sameChain(current.chain, guard.chain)
  )
    throw new PathGuardError('IDENTITY_CHANGED', 'Path identity changed before execution');
  return current;
}

/**
 * Opens the exact inode that was approved and verifies it through the returned OS handle.
 * Missing-target create/rename/delete remain fail-closed until a native openat/renameat boundary
 * is available; a pathname-only preflight cannot close their parent-directory race in Node.
 */
export async function openGuardedExistingFile(
  guard: PathGuard,
  access: 'read' | 'write',
): Promise<FileHandle> {
  if (guard.operation !== access)
    throw new PathGuardError(
      'UNSUPPORTED_RACE_SAFE_OPERATION',
      'The requested file access does not match the approved operation',
    );
  if (access === 'write')
    throw new PathGuardError(
      'UNSUPPORTED_RACE_SAFE_OPERATION',
      'Writes require a handle-relative transactional replace boundary',
    );
  if (guard.targetIdentity === null)
    throw new PathGuardError(
      'UNSUPPORTED_RACE_SAFE_OPERATION',
      'Creating a new file requires a handle-relative native execution boundary',
    );
  if (guard.targetIdentity.kind !== 'file')
    throw new PathGuardError(
      'SPECIAL_FILE',
      'Only regular files can cross this execution boundary',
    );

  await revalidatePathGuard(guard);
  let handle: FileHandle | undefined;
  try {
    handle = await open(guard.resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedIdentity = toIdentity(await handle.stat({ bigint: true }));
    if (openedIdentity.kind !== 'file' || !sameIdentity(openedIdentity, guard.targetIdentity))
      throw new PathGuardError('IDENTITY_CHANGED', 'Opened file is not the approved inode');
    return handle;
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    if (error instanceof PathGuardError) throw error;
    throw new PathGuardError('IDENTITY_CHANGED', 'File identity changed while opening');
  }
}

export function pathGuardIdentityDigest(guard: PathGuard): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        guard.rootId,
        guard.workspacePath,
        guard.resolvedPath,
        guard.operation,
        guard.parentIdentity,
        guard.targetIdentity,
        guard.chain,
      ]),
    )
    .digest('hex');
}

export async function workspaceMutationBinding(inputPath: string): Promise<
  Readonly<{
    canonicalPath: string;
    rootIdentityDigest: string;
    workspaceKey: string;
  }>
> {
  const canonicalPath = await realpath(inputPath);
  const identity = toIdentity(await lstat(canonicalPath, { bigint: true }));
  if (identity.kind !== 'directory')
    throw new PathGuardError('INVALID_PATH', 'Workspace must be a directory');
  const rootIdentityDigest = createHash('sha256')
    .update(JSON.stringify(['workspace-root-v2', identity.dev, identity.ino, identity.kind]))
    .digest('hex');
  const workspaceKey = createHash('sha256')
    .update(JSON.stringify(['workspace-mutation-v2', rootIdentityDigest]))
    .digest('hex');
  return Object.freeze({ canonicalPath, rootIdentityDigest, workspaceKey });
}

export function workspacePermissionResourceFromGuard(
  guard: PathGuard,
): Extract<PermissionResource, { kind: 'workspace-path' }> {
  if (!isIssuedPathGuard(guard))
    throw new PathGuardError('INVALID_PATH', 'PathGuard was not issued by canonical validation');
  return Object.freeze({
    kind: 'workspace-path',
    workspaceId: createHash('sha256')
      .update(JSON.stringify([guard.rootId, guard.workspacePath]))
      .digest('hex'),
    canonicalPath: guard.resolvedPath,
    identityDigest: pathGuardIdentityDigest(guard),
    classification: classifyWorkspacePath(guard.workspacePath, guard.resolvedPath),
  });
}

function classifyWorkspacePath(workspacePath: string, resolvedPath: string): PathClassification {
  const parts = relative(workspacePath, resolvedPath)
    .split(/[\\/]+/)
    .map((part) => part.toLowerCase());
  const absoluteParts = resolvedPath
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
  const name = parts.at(-1) ?? '';
  if (isAtOrBelow('/System', resolvedPath) || isAtOrBelow('/Library', resolvedPath))
    return 'os-protected';
  if (
    isAtOrBelow('/proc', resolvedPath) ||
    isAtOrBelow('/sys', resolvedPath) ||
    isAtOrBelow('/dev', resolvedPath) ||
    isAtOrBelow('/run', resolvedPath) ||
    isAtOrBelow('/boot', resolvedPath) ||
    isAtOrBelow('/etc', resolvedPath) ||
    isAtOrBelow('/private/etc', resolvedPath) ||
    isAtOrBelow('/private/var/root', resolvedPath)
  )
    return 'os-protected';
  if (
    absoluteParts.includes('windows') ||
    absoluteParts.includes('system32') ||
    absoluteParts.includes('programdata') ||
    absoluteParts.includes('program files') ||
    absoluteParts.includes('program files (x86)')
  )
    return 'os-protected';
  if (
    absoluteParts.includes('.ssh') ||
    absoluteParts.includes('.aws') ||
    absoluteParts.includes('.gnupg') ||
    absoluteParts.includes('.kube') ||
    absoluteParts.includes('gcloud') ||
    absoluteParts.includes('keychains')
  )
    return 'credential';
  if (absoluteParts.includes('appdata')) return 'app-private';
  if (
    absoluteParts.includes('.git') ||
    absoluteParts.includes('.codex') ||
    absoluteParts.includes('.sprint-coder') ||
    absoluteParts.includes('.sprint-coder-team')
  )
    return 'app-private';
  if (absoluteParts.includes('library') && absoluteParts.includes('application support'))
    return 'app-private';
  if (
    parts.some(
      (part) => part === '.git' || part === '.sprint-coder' || part === '.sprint-coder-team',
    )
  )
    return 'app-private';
  if (/^(?:update|auto-update).*(?:key|pem)$/.test(name)) return 'update-key';
  if (/\.(?:p12|pfx)$/.test(name) || /^(?:signing|release).*(?:key|pem)$/.test(name))
    return 'signing-key';
  if (
    name === '.env' ||
    name.startsWith('.env.') ||
    [
      '.npmrc',
      '.pypirc',
      'credentials',
      'credentials.json',
      'application_default_credentials.json',
      'id_rsa',
      'id_ed25519',
    ].includes(name) ||
    /(?:credential|secret|token|private[-_]?key|service[-_]?account)/.test(name) ||
    /^(?:service-account|service_account).+\.json$/.test(name) ||
    /\.(?:pem|key)$/.test(name)
  )
    return 'credential';
  if (workspacePath === parse(workspacePath).root || workspacePath === homedir())
    return 'unclassified';
  return 'workspace';
}

function isAtOrBelow(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return (
    relation === '' ||
    (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation))
  );
}

// Conservative, portable bounds (POSIX NAME_MAX=255, a total well below any platform's
// PATH_MAX/MAX_PATH). Rejecting up front turns what would otherwise be a raw uncaught
// ENAMETOOLONG from a later fs call into a typed, fail-closed PathGuardError.
const MAX_PATH_SEGMENT_LENGTH = 255;
const MAX_TOTAL_PATH_LENGTH = 4_096;

function validateInput(targetPath: string): void {
  if (targetPath.length === 0 || targetPath.includes('\0'))
    throw new PathGuardError('INVALID_PATH', 'Invalid target path');
  if (targetPath.length > MAX_TOTAL_PATH_LENGTH)
    throw new PathGuardError('INVALID_PATH', 'Target path exceeds the maximum supported length');
  if (targetPath.split(/[\\/]+/).some((segment) => segment.length > MAX_PATH_SEGMENT_LENGTH))
    throw new PathGuardError('INVALID_PATH', 'Target path has a segment that is too long');
}

function hasTraversalSegment(targetPath: string): boolean {
  return targetPath.split(/[\\/]+/).includes('..');
}

async function nearestExistingAncestor(
  targetPath: string,
): Promise<{ existingPath: string; missingParts: string[] }> {
  const missingParts: string[] = [];
  let candidate = targetPath;
  while (true) {
    try {
      await lstat(candidate);
      return { existingPath: candidate, missingParts };
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const parent = dirname(candidate);
      if (parent === candidate)
        throw new PathGuardError('PATH_NOT_FOUND', 'No existing path ancestor');
      missingParts.unshift(relative(parent, candidate));
      candidate = parent;
    }
  }
}

async function snapshotLexicalChain(
  workspacePath: string,
  lexicalTarget: string,
): Promise<PathChainEntry[]> {
  const pathParts = relative(workspacePath, lexicalTarget).split(sep).filter(Boolean);
  const chain: PathChainEntry[] = [];
  let current = workspacePath;
  for (const part of pathParts) {
    current = join(current, part);
    try {
      const stats = await lstat(current, { bigint: true });
      chain.push({
        lexicalPath: current,
        identity: toIdentity(stats),
        linkTarget: stats.isSymbolicLink() ? await readlink(current) : null,
      });
    } catch (error) {
      if (isNotFound(error)) break;
      throw error;
    }
  }
  return chain;
}

async function resolveExisting(
  path: string,
  code: Extract<PathGuardErrorCode, 'PATH_NOT_FOUND'>,
): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isNotFound(error)) throw new PathGuardError(code, 'Path does not exist or is dangling');
    throw error;
  }
}

function assertContained(workspacePath: string, candidatePath: string): void {
  const fromWorkspace = relative(workspacePath, candidatePath);
  if (fromWorkspace === '..' || fromWorkspace.startsWith(`..${sep}`) || isAbsolute(fromWorkspace))
    throw new PathGuardError('PATH_ESCAPE', 'Path escapes the canonical workspace');
}

function toIdentity(stats: BigIntStats): FileIdentity {
  return {
    dev: stats.dev.toString(),
    ino: stats.ino.toString(),
    mode: exactStatNumber(stats.mode, 'mode'),
    size: exactStatNumber(stats.size, 'size'),
    mtimeMs: exactStatNumber(stats.mtimeMs, 'mtimeMs'),
    ctimeMs: exactStatNumber(stats.ctimeMs, 'ctimeMs'),
    birthtimeMs: exactStatNumber(stats.birthtimeMs, 'birthtimeMs'),
    nlink: exactStatNumber(stats.nlink, 'nlink'),
    kind: stats.isSymbolicLink()
      ? 'symlink'
      : stats.isDirectory()
        ? 'directory'
        : stats.isFile()
          ? 'file'
          : 'other',
  };
}

function exactStatNumber(value: bigint, name: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new PathGuardError('IDENTITY_CHANGED', `${name} exceeds the exact numeric range`);
  return result;
}

function sameOptionalIdentity(left: FileIdentity | null, right: FileIdentity | null): boolean {
  return left === null || right === null ? left === right : sameIdentity(left, right);
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.birthtimeMs === right.birthtimeMs &&
    left.nlink === right.nlink &&
    left.kind === right.kind
  );
}

function sameChain(left: readonly PathChainEntry[], right: readonly PathChainEntry[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.lexicalPath === right[index]?.lexicalPath &&
        entry.linkTarget === right[index]?.linkTarget &&
        right[index] !== undefined &&
        sameIdentity(entry.identity, right[index].identity),
    )
  );
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    // ENAMETOOLONG is defense in depth: validateInput's length bound should reject these
    // before any fs call, but a late/platform-specific case must still fail closed as a typed
    // PathGuardError instead of an uncaught raw Error.
    (error.code === 'ENOENT' ||
      error.code === 'ENOTDIR' ||
      error.code === 'ELOOP' ||
      error.code === 'ENAMETOOLONG')
  );
}
