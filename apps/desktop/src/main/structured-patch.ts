import { createHash } from 'node:crypto';
import { canonicalizeResourcePath } from './path-guard';
import type {
  FileRevisionRegistry,
  FileRevisionOwner,
  FileRevisionReference,
} from './file-revision';

const MAX_POST_IMAGE_BYTES = 1024 * 1024;

export type StructuredPatchOperation =
  | Readonly<{
      kind: 'update';
      path: string;
      revision: FileRevisionReference;
      edits: readonly Readonly<{ oldText: string; newText: string }>[];
    }>
  | Readonly<{ kind: 'add'; path: string; content: string }>
  | Readonly<{ kind: 'delete'; path: string; revision: FileRevisionReference }>
  | Readonly<{
      kind: 'rename';
      path: string;
      destination: string;
      revision: FileRevisionReference;
    }>;

export type PreparedPatchOperation = Readonly<{
  kind: StructuredPatchOperation['kind'];
  path: string;
  canonicalPath: string;
  destination: string | null;
  canonicalDestination: string | null;
  revisionTokenId: string | null;
  preImage: string | null;
  postImage: string | null;
  preHash: string | null;
  postHash: string | null;
}>;

export type PreparedStructuredPatch = Readonly<{
  version: 1;
  policyEpoch: number;
  operations: readonly PreparedPatchOperation[];
  digest: string;
}>;

export type PatchValidationErrorCode =
  | 'INVALID_PATCH'
  | 'PATH_COLLISION'
  | 'ANCHOR_NOT_FOUND'
  | 'ANCHOR_AMBIGUOUS'
  | 'OVERLAPPING_EDITS'
  | 'DESTINATION_EXISTS'
  | 'HARDLINK_WRITE_DENIED'
  | 'POST_IMAGE_TOO_LARGE'
  | 'NON_TEXT_CONTENT';

export class PatchValidationError extends Error {
  constructor(
    readonly code: PatchValidationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PatchValidationError';
  }
}

export async function prepareStructuredPatch(input: {
  owner: FileRevisionOwner;
  workspacePath: string;
  policyEpoch: number;
  registry: FileRevisionRegistry;
  operations: readonly StructuredPatchOperation[];
}): Promise<PreparedStructuredPatch> {
  if (input.operations.length === 0 || input.operations.length > 100)
    throw new PatchValidationError('INVALID_PATCH', 'Patch must contain 1 to 100 operations');

  const prepared: PreparedPatchOperation[] = [];
  const claimedPaths = new Set<string>();
  for (const operation of input.operations) {
    const sourceGuard = await canonicalizeResourcePath({
      workspacePath: input.workspacePath,
      targetPath: operation.path,
      operation: operation.kind === 'add' ? 'write' : 'read',
    });
    claimPath(claimedPaths, sourceGuard.resolvedPath);

    if (operation.kind === 'add') {
      if (sourceGuard.targetIdentity !== null)
        throw new PatchValidationError('DESTINATION_EXISTS', 'Add destination already exists');
      validatePostImage(operation.content);
      prepared.push(
        freezeOperation({
          kind: 'add',
          path: operation.path,
          canonicalPath: sourceGuard.resolvedPath,
          destination: null,
          canonicalDestination: null,
          revisionTokenId: null,
          preImage: null,
          postImage: operation.content,
          preHash: null,
          postHash: hash(operation.content),
        }),
      );
      continue;
    }

    const revision = await input.registry.resolve({
      owner: input.owner,
      reference: operation.revision,
      workspacePath: input.workspacePath,
      targetPath: operation.path,
      policyEpoch: input.policyEpoch,
    });
    if (revision.token.identity.nlink !== 1)
      throw new PatchValidationError(
        'HARDLINK_WRITE_DENIED',
        'Mutating a multiply-linked file is not allowed',
      );

    if (operation.kind === 'update') {
      const postImage = applyAnchoredEdits(revision.content, operation.edits);
      validatePostImage(postImage);
      prepared.push(
        freezeOperation({
          kind: 'update',
          path: operation.path,
          canonicalPath: sourceGuard.resolvedPath,
          destination: null,
          canonicalDestination: null,
          revisionTokenId: operation.revision.tokenId,
          preImage: revision.content,
          postImage,
          preHash: revision.token.contentHash,
          postHash: hash(postImage),
        }),
      );
      continue;
    }

    if (operation.kind === 'delete') {
      prepared.push(
        freezeOperation({
          kind: 'delete',
          path: operation.path,
          canonicalPath: sourceGuard.resolvedPath,
          destination: null,
          canonicalDestination: null,
          revisionTokenId: operation.revision.tokenId,
          preImage: revision.content,
          postImage: null,
          preHash: revision.token.contentHash,
          postHash: null,
        }),
      );
      continue;
    }

    const destinationGuard = await canonicalizeResourcePath({
      workspacePath: input.workspacePath,
      targetPath: operation.destination,
      operation: 'write',
    });
    claimPath(claimedPaths, destinationGuard.resolvedPath);
    if (destinationGuard.targetIdentity !== null)
      throw new PatchValidationError('DESTINATION_EXISTS', 'Rename destination already exists');
    prepared.push(
      freezeOperation({
        kind: 'rename',
        path: operation.path,
        canonicalPath: sourceGuard.resolvedPath,
        destination: operation.destination,
        canonicalDestination: destinationGuard.resolvedPath,
        revisionTokenId: operation.revision.tokenId,
        preImage: revision.content,
        postImage: revision.content,
        preHash: revision.token.contentHash,
        postHash: revision.token.contentHash,
      }),
    );
  }

  const facts = {
    version: 1 as const,
    policyEpoch: input.policyEpoch,
    operations: Object.freeze(prepared),
  };
  return Object.freeze({ ...facts, digest: structuredPatchDigest(facts) });
}

export function structuredPatchDigest(input: {
  version: 1;
  policyEpoch: number;
  operations: readonly PreparedPatchOperation[];
}): string {
  return hash(
    JSON.stringify({
      version: input.version,
      policyEpoch: input.policyEpoch,
      operations: input.operations,
    }),
  );
}

function applyAnchoredEdits(
  content: string,
  edits: readonly Readonly<{ oldText: string; newText: string }>[],
): string {
  if (edits.length === 0 || edits.length > 100)
    throw new PatchValidationError('INVALID_PATCH', 'Update must contain 1 to 100 edits');
  const ranges = edits.map((edit) => {
    if (edit.oldText.length === 0)
      throw new PatchValidationError('INVALID_PATCH', 'Empty anchors are not allowed');
    const start = content.indexOf(edit.oldText);
    if (start < 0)
      throw new PatchValidationError('ANCHOR_NOT_FOUND', 'Update anchor was not found');
    if (content.indexOf(edit.oldText, start + 1) >= 0)
      throw new PatchValidationError('ANCHOR_AMBIGUOUS', 'Update anchor is not unique');
    return { start, end: start + edit.oldText.length, replacement: edit.newText };
  });
  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < ranges.length; index += 1) {
    const previous = ranges[index - 1];
    const current = ranges[index];
    if (previous !== undefined && current !== undefined && current.start < previous.end)
      throw new PatchValidationError('OVERLAPPING_EDITS', 'Update ranges overlap');
  }
  let result = content;
  for (const range of [...ranges].reverse())
    result = `${result.slice(0, range.start)}${range.replacement}${result.slice(range.end)}`;
  return result;
}

function claimPath(paths: Set<string>, path: string): void {
  if (paths.has(path))
    throw new PatchValidationError('PATH_COLLISION', 'Patch contains colliding path endpoints');
  paths.add(path);
}

function validatePostImage(content: string): void {
  if (content.includes('\0'))
    throw new PatchValidationError('NON_TEXT_CONTENT', 'Text patches cannot contain NUL bytes');
  if (Buffer.byteLength(content, 'utf8') > MAX_POST_IMAGE_BYTES)
    throw new PatchValidationError('POST_IMAGE_TOO_LARGE', 'Post-image exceeds the edit limit');
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function freezeOperation(operation: PreparedPatchOperation): PreparedPatchOperation {
  return Object.freeze(operation);
}
