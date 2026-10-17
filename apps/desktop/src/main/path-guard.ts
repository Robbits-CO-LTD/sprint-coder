import { constants, lstatSync, realpathSync, type BigIntStats } from 'node:fs';
import { lstat, open, readlink, realpath, stat, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { PathClassification, PermissionResource } from '@sprint-coder/domain';
import { canonicalizeExistingPath, pathsEquivalent } from '../path-comparison';

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
  rootIdentityDigest: string;
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
  expectedRootIdentityDigest?: string | undefined;
  targetPath: string;
  operation: PathOperation;
}): Promise<CanonicalPathIdentity> {
  validateInput(input.targetPath);
  const workspacePath = await resolveExisting(input.workspacePath, 'PATH_NOT_FOUND');
  const workspaceStats = await stat(workspacePath, { bigint: true });
  if (!workspaceStats.isDirectory())
    throw new PathGuardError('INVALID_PATH', 'Workspace must be a directory');
  if (
    input.expectedRootIdentityDigest !== undefined &&
    workspaceRootIdentityDigest(workspaceStats) !== input.expectedRootIdentityDigest
  )
    throw new PathGuardError('IDENTITY_CHANGED', 'Workspace root identity changed');

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
    rootIdentityDigest: workspaceRootIdentityDigest(workspaceStats),
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
  expectedRootIdentityDigest?: string | undefined;
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
      expectedRootIdentityDigest: guard.rootIdentityDigest,
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
  const canonicalPath = realpathSync.native(inputPath);
  const identity = toIdentity(await lstat(canonicalPath, { bigint: true }));
  if (identity.kind !== 'directory')
    throw new PathGuardError('INVALID_PATH', 'Workspace must be a directory');
  const rootIdentityDigest = workspaceRootIdentityDigest(identity);
  const workspaceKey = createHash('sha256')
    .update(JSON.stringify(['workspace-mutation-v2', rootIdentityDigest]))
    .digest('hex');
  return Object.freeze({ canonicalPath, rootIdentityDigest, workspaceKey });
}

/**
 * The sealed identity of a Workspace root as it is *right now*, or null when the path is not a
 * directory this process can identify.
 *
 * Same digest as `workspaceMutationBinding` seals, computed synchronously and without resolving
 * symlinks, so a caller holding a sealed `rootIdentityDigest` can ask whether the root it was
 * sealed against is still the directory sitting at that path. A root that was renamed away and
 * replaced by a fresh directory of the same name has the same path and a different identity.
 */
export function currentWorkspaceRootIdentityDigest(rootPath: string): string | null {
  try {
    const stats = lstatSync(rootPath, { bigint: true, throwIfNoEntry: false });
    if (stats === undefined || !stats.isDirectory()) return null;
    return workspaceRootIdentityDigest(stats);
  } catch {
    return null;
  }
}

/**
 * The same digest, from a `dev`/`ino` pair someone else observed — a pinned descriptor, say, rather
 * than a path that could have been re-pointed since. Always a directory: only a directory is ever
 * sealed as a Workspace root.
 */
export function workspaceRootIdentityDigestFor(dev: string, ino: string): string {
  return workspaceRootIdentityDigest({ dev, ino, kind: 'directory' });
}

function workspaceRootIdentityDigest(
  identity: Pick<FileIdentity, 'dev' | 'ino' | 'kind'> | BigIntStats,
): string {
  const normalized = 'kind' in identity ? identity : toIdentity(identity);
  return createHash('sha256')
    .update(
      JSON.stringify([
        'workspace-root-v2',
        String(normalized.dev),
        String(normalized.ino),
        normalized.kind,
      ]),
    )
    .digest('hex');
}

export function workspacePermissionResourceFromGuard(
  guard: PathGuard,
  workspaceAuthority?: 'sealed-team-isolation',
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
    classification: classifyWorkspacePath(
      guard.workspacePath,
      guard.resolvedPath,
      workspaceAuthority,
    ),
  });
}

/**
 * The protected classification a Workspace root itself carries, or null for an ordinary folder.
 * The home folder and a drive root stay null here: they have their own confirmation.
 */
export function protectedWorkspaceRootClassification(
  canonicalRootPath: string,
  workspaceAuthority?: 'sealed-team-isolation',
): Exclude<PathClassification, 'workspace' | 'unclassified'> | null {
  const classification = classifyWorkspacePath(
    canonicalRootPath,
    canonicalRootPath,
    workspaceAuthority,
  );
  return classification === 'workspace' || classification === 'unclassified'
    ? null
    : classification;
}

/** A user-facing name for the kind of protected place a Workspace root sits in. */
export function protectedWorkspaceRootLabel(
  classification: Exclude<PathClassification, 'workspace' | 'unclassified'>,
): string {
  if (classification === 'os-protected') return 'OS のシステムフォルダ';
  if (classification === 'credential') return '認証情報を置くフォルダ';
  if (classification === 'app-private') return 'アプリの内部データの場所（AppData など）';
  return '鍵などを置く保護された場所';
}

const CREDENTIAL_DIRECTORY_NAMES = ['.ssh', '.aws', '.gnupg', '.kube', 'gcloud', 'keychains'];

function classifyWorkspacePath(
  workspacePath: string,
  resolvedPath: string,
  workspaceAuthority?: 'sealed-team-isolation',
): PathClassification {
  const parts = relative(workspacePath, resolvedPath)
    .split(/[\\/]+/)
    .map((part) => part.toLowerCase());
  // Only the AppData / app-state names below are deliberately judged on every ancestor. Any other
  // folder name above the Workspace (a parent called `windows` or `gcloud`) says nothing about the
  // files inside it: OS areas are compared with the real system roots and credential folders with
  // the real ones in the home folder, while names are judged from the Workspace root down.
  const absoluteParts = resolvedPath
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
  const appStateParts = workspaceAuthority === 'sealed-team-isolation' ? parts : absoluteParts;
  const credentialParts =
    workspaceAuthority === 'sealed-team-isolation'
      ? parts
      : [basename(workspacePath).toLowerCase(), ...parts];
  const name = parts.at(-1) ?? '';
  const home = canonicalizeExistingPath(homedir());
  if (
    workspaceAuthority === undefined &&
    (isAtOrBelow('/System', resolvedPath) || isAtOrBelow('/Library', resolvedPath))
  )
    return 'os-protected';
  if (
    workspaceAuthority === undefined &&
    (isAtOrBelow('/proc', resolvedPath) ||
      isAtOrBelow('/sys', resolvedPath) ||
      isAtOrBelow('/dev', resolvedPath) ||
      isAtOrBelow('/run', resolvedPath) ||
      isAtOrBelow('/boot', resolvedPath) ||
      isAtOrBelow('/etc', resolvedPath) ||
      isAtOrBelow('/private/etc', resolvedPath) ||
      isAtOrBelow('/private/var/root', resolvedPath))
  )
    return 'os-protected';
  if (workspaceAuthority === undefined && isAtOrBelowAnyRoot(windowsSystemRoots(), resolvedPath))
    return 'os-protected';
  if (
    parts.includes('windows') ||
    parts.includes('system32') ||
    parts.includes('programdata') ||
    parts.includes('program files') ||
    parts.includes('program files (x86)')
  )
    return 'os-protected';
  if (
    workspaceAuthority === undefined &&
    isAtOrBelowAnyRoot(
      [
        ['.ssh'],
        ['.aws'],
        ['.gnupg'],
        ['.kube'],
        ['.config', 'gcloud'],
        ['Library', 'Keychains'],
      ].map((segments) => join(home, ...segments)),
      resolvedPath,
    )
  )
    return 'credential';
  if (CREDENTIAL_DIRECTORY_NAMES.some((directory) => credentialParts.includes(directory)))
    return 'credential';
  if (appStateParts.includes('appdata')) return 'app-private';
  if (
    appStateParts.includes('.git') ||
    appStateParts.includes('.codex') ||
    appStateParts.includes('.sprint-coder') ||
    appStateParts.includes('.sprint-coder-team')
  )
    return 'app-private';
  if (
    workspaceAuthority === undefined &&
    isAtOrBelowAnyRoot([join(home, 'Library', 'Application Support')], resolvedPath)
  )
    return 'app-private';
  if (credentialParts.includes('library') && credentialParts.includes('application support'))
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
  if (
    pathsEquivalent(workspacePath, parse(workspacePath).root) ||
    pathsEquivalent(workspacePath, canonicalizeExistingPath(homedir()))
  )
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

/** The Windows install and its program folders, from the environment plus the usual defaults. */
function windowsSystemRoots(): string[] {
  if (process.platform !== 'win32') return [];
  const drive = process.env['SystemDrive'] ?? 'C:';
  return [
    process.env['SystemRoot'],
    process.env['WINDIR'],
    process.env['ProgramData'],
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)'],
    process.env['ProgramW6432'],
    `${drive}\\Windows`,
    `${drive}\\ProgramData`,
    `${drive}\\Program Files`,
    `${drive}\\Program Files (x86)`,
  ].filter((root): root is string => root !== undefined && root !== '' && isAbsolute(root));
}

/**
 * Whether a resolved path is at or below one of the protected roots. Each root is compared both as
 * written and resolved, because the root itself may be a symlink or junction to another place
 * (`~/.aws -> /mnt/profile/.aws`) while the guarded path is always the resolved one.
 */
function isAtOrBelowAnyRoot(roots: readonly string[], resolvedPath: string): boolean {
  return roots.some(
    (root) =>
      isAtOrBelow(resolve(root), resolvedPath) ||
      isAtOrBelow(canonicalizeExistingPath(root), resolvedPath),
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
  if (/[\uD800-\uDFFF]/u.test(targetPath))
    throw new PathGuardError('INVALID_PATH', 'Target path contains an unpaired surrogate');
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
    // fs/promises.realpath already uses the native canonicalizer. The callback/sync
    // emulations can retain case aliases and break structured-patch endpoint claims.
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
