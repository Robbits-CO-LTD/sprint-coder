import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import {
  createPathGuard,
  openGuardedExistingFile,
  type FileIdentity,
  type PathGuard,
} from './path-guard';

const DEFAULT_MAX_BYTES = 1024 * 1024;
const issuedRevisionTokens = new WeakSet<object>();

export type FileRevisionErrorCode =
  | 'INVALID_REQUEST'
  | 'FILE_TOO_LARGE'
  | 'NON_TEXT_FILE'
  | 'READ_RACE'
  | 'FORGED_TOKEN'
  | 'TOKEN_SCOPE_MISMATCH'
  | 'POLICY_EPOCH_CHANGED'
  | 'TARGET_CHANGED'
  | 'STALE_REVISION';

export class FileRevisionError extends Error {
  constructor(
    readonly code: FileRevisionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FileRevisionError';
  }
}

export type FileRevisionToken = Readonly<{
  version: 1;
  id: string;
  identity: Readonly<FileIdentity>;
  contentHash: string;
  mtimeHint: number;
  size: number;
  policyEpoch: number;
  workspaceBinding: string;
  targetBinding: string;
  maxBytes: number;
}>;

export type RevisionBoundFile = Readonly<{
  content: string;
  token: FileRevisionToken;
}>;

export type FileRevisionReference = Readonly<{ version: 1; tokenId: string }>;
export type FileRevisionOwner = Readonly<{ taskId: string; turnId: string }>;

type RegisteredRevision = Readonly<{
  owner: FileRevisionOwner;
  content: string;
  token: FileRevisionToken;
}>;

export class FileRevisionRegistry {
  private readonly records = new Map<string, RegisteredRevision>();

  async read(input: {
    owner: FileRevisionOwner;
    workspacePath: string;
    targetPath: string;
    policyEpoch: number;
    maxBytes?: number;
  }): Promise<Readonly<{ content: string; reference: FileRevisionReference }>> {
    validateOwner(input.owner);
    const read = await readRevisionBoundFile(input);
    this.records.set(
      read.token.id,
      Object.freeze({
        owner: Object.freeze({ ...input.owner }),
        content: read.content,
        token: read.token,
      }),
    );
    return Object.freeze({
      content: read.content,
      reference: Object.freeze({ version: 1 as const, tokenId: read.token.id }),
    });
  }

  async resolve(input: {
    owner: FileRevisionOwner;
    reference: FileRevisionReference;
    workspacePath: string;
    targetPath: string;
    policyEpoch: number;
  }): Promise<RevisionBoundFile> {
    validateOwner(input.owner);
    const record = this.records.get(input.reference.tokenId);
    if (record === undefined || input.reference.version !== 1)
      throw new FileRevisionError('FORGED_TOKEN', 'Unknown revision token reference');
    if (record.owner.taskId !== input.owner.taskId || record.owner.turnId !== input.owner.turnId)
      throw new FileRevisionError(
        'TOKEN_SCOPE_MISMATCH',
        'Revision token belongs to another Task or Turn',
      );
    await revalidateFileRevisionToken({
      token: record.token,
      workspacePath: input.workspacePath,
      targetPath: input.targetPath,
      policyEpoch: input.policyEpoch,
    });
    return Object.freeze({ content: record.content, token: record.token });
  }

  finishTurn(owner: FileRevisionOwner): number {
    validateOwner(owner);
    let removed = 0;
    for (const [id, record] of this.records) {
      if (record.owner.taskId !== owner.taskId || record.owner.turnId !== owner.turnId) continue;
      this.records.delete(id);
      removed += 1;
    }
    return removed;
  }
}

export async function readRevisionBoundFile(input: {
  workspacePath: string;
  targetPath: string;
  policyEpoch: number;
  maxBytes?: number;
}): Promise<RevisionBoundFile> {
  const policyEpoch = validateNonNegativeInteger(input.policyEpoch, 'policyEpoch');
  const maxBytes = validatePositiveInteger(input.maxBytes ?? DEFAULT_MAX_BYTES, 'maxBytes');
  const guard = await createPathGuard({
    workspacePath: input.workspacePath,
    targetPath: input.targetPath,
    operation: 'read',
  });
  let handle: FileHandle | undefined;
  try {
    handle = await openGuardedExistingFile(guard, 'read');
    const before = await handle.stat();
    assertRegularAndBounded(before, maxBytes);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameStableReadIdentity(before, after) || bytes.byteLength !== after.size)
      throw new FileRevisionError('READ_RACE', 'File changed while it was being read');
    const content = decodeText(bytes);
    const identity = Object.freeze(toIdentity(after));
    const token = Object.freeze({
      version: 1 as const,
      id: randomUUID(),
      identity,
      contentHash: createHash('sha256').update(bytes).digest('hex'),
      mtimeHint: after.mtimeMs,
      size: bytes.byteLength,
      policyEpoch,
      workspaceBinding: digest(guard.workspacePath),
      targetBinding: targetBinding(guard),
      maxBytes,
    });
    issuedRevisionTokens.add(token);
    return Object.freeze({ content, token });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function revalidateFileRevisionToken(input: {
  token: FileRevisionToken;
  workspacePath: string;
  targetPath: string;
  policyEpoch: number;
}): Promise<FileRevisionToken> {
  if (!issuedRevisionTokens.has(input.token))
    throw new FileRevisionError('FORGED_TOKEN', 'Revision token was not issued by Main');
  const policyEpoch = validateNonNegativeInteger(input.policyEpoch, 'policyEpoch');
  if (policyEpoch !== input.token.policyEpoch)
    throw new FileRevisionError(
      'POLICY_EPOCH_CHANGED',
      'Permission policy changed after the file was read',
    );

  const guard = await createPathGuard({
    workspacePath: input.workspacePath,
    targetPath: input.targetPath,
    operation: 'read',
  });
  if (
    digest(guard.workspacePath) !== input.token.workspaceBinding ||
    targetBinding(guard) !== input.token.targetBinding
  )
    throw new FileRevisionError('TARGET_CHANGED', 'Revision token is bound to another target');

  const current = await readRevisionBoundFile({
    workspacePath: input.workspacePath,
    targetPath: input.targetPath,
    policyEpoch,
    maxBytes: input.token.maxBytes,
  });
  if (
    current.token.contentHash !== input.token.contentHash ||
    current.token.size !== input.token.size ||
    !sameFileIdentity(current.token.identity, input.token.identity)
  )
    throw new FileRevisionError('STALE_REVISION', 'File revision changed after it was read');
  return input.token;
}

function assertRegularAndBounded(stats: Stats, maxBytes: number): void {
  if (!stats.isFile()) throw new FileRevisionError('NON_TEXT_FILE', 'Target is not a regular file');
  if (stats.size > maxBytes)
    throw new FileRevisionError('FILE_TOO_LARGE', 'File exceeds the configured read limit');
}

function decodeText(bytes: Buffer): string {
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new FileRevisionError('NON_TEXT_FILE', 'File is not valid UTF-8 text');
  }
  if (content.includes('\0'))
    throw new FileRevisionError('NON_TEXT_FILE', 'NUL bytes are not allowed in text files');
  return content;
}

function sameStableReadIdentity(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sameFileIdentity(left: Readonly<FileIdentity>, right: Readonly<FileIdentity>): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.kind === right.kind
  );
}

function toIdentity(stats: Stats): FileIdentity {
  return {
    dev: String(stats.dev),
    ino: String(stats.ino),
    mode: stats.mode,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    birthtimeMs: stats.birthtimeMs,
    nlink: stats.nlink,
    kind: stats.isFile()
      ? 'file'
      : stats.isDirectory()
        ? 'directory'
        : stats.isSymbolicLink()
          ? 'symlink'
          : 'other',
  };
}

function targetBinding(guard: PathGuard): string {
  return digest(JSON.stringify([guard.workspacePath, guard.resolvedPath]));
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function validateNonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new FileRevisionError('INVALID_REQUEST', `${name} must be a non-negative integer`);
  return value;
}

function validatePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new FileRevisionError('INVALID_REQUEST', `${name} must be a positive integer`);
  return value;
}

function validateOwner(owner: FileRevisionOwner): void {
  if (
    owner.taskId.length === 0 ||
    owner.taskId.length > 200 ||
    owner.turnId.length === 0 ||
    owner.turnId.length > 200
  )
    throw new FileRevisionError('INVALID_REQUEST', 'Invalid revision token owner');
}
