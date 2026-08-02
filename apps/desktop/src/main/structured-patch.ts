import { createHash } from 'node:crypto';
import { canonicalizeResourcePath } from './path-guard';
import type {
  FileRevisionToken,
  FileRevisionRegistry,
  FileRevisionOwner,
  FileRevisionReference,
} from './file-revision';

export type PreparedFileRevision = Readonly<{
  identityDigest: string;
  contentHash: string;
  size: number;
  mode: number;
  nlink: 1;
}>;

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
  preRevision: PreparedFileRevision | null;
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

/**
 * Why an anchor did not resolve, most specific first.
 *
 * The first three are near-misses the caller can fix without looking at the file again: the anchor
 * describes the right region and only its whitespace or line endings are wrong. `drifted` means the
 * region is recognisable but its text has moved on, so the caller needs the current text. `absent`
 * means the region could not be located at all — either nothing resembles the anchor, or its opening
 * line is so common that naming any one occurrence would mislead.
 */
export type AnchorFailureCause =
  'line_ending' | 'trailing_whitespace' | 'indentation' | 'drifted' | 'absent' | 'ambiguous';

/**
 * What the file looks like now, attached to the failure that reported it.
 *
 * An anchor failure is the common way a patch from a model dies, and a bare "anchor was not found"
 * forces the caller to re-read the whole file and guess again. Everything needed to retry is already
 * in hand at the moment the match fails, so it is returned instead of discarded: which edit failed,
 * why, and — when the region is still identifiable — the text that is actually there. A caller can
 * copy `nearest.text` straight back as `oldText`.
 *
 * Deliberately bounded. This travels back to a model, so a large file must not become a large
 * message: `text` is capped at MAX_RECOVERY_TEXT_BYTES with `truncated` saying so, and `occurrences`
 * at MAX_RECOVERY_OCCURRENCES.
 */
export type AnchorRecovery = Readonly<{
  /** Index into the failing operation's `edits`, so a 100-edit batch names its one bad anchor. */
  editIndex: number;
  cause: AnchorFailureCause;
  /** 1-based line numbers where the anchor, or its opening line, currently occurs. */
  occurrences: readonly number[];
  /** The file's current text where the anchor was expected, or null when nothing matched. */
  nearest: Readonly<{ line: number; text: string; truncated: boolean }> | null;
}>;

/** A recovery payload is a hint for the next attempt, never large enough to crowd out the retry. */
const MAX_RECOVERY_TEXT_BYTES = 4096;
const MAX_RECOVERY_OCCURRENCES = 10;
/** Above this the whitespace probes would copy more than they are worth; drift search still runs. */
const MAX_NORMALIZATION_PROBE_CHARS = 4_000_000;

export class PatchValidationError extends Error {
  constructor(
    readonly code: PatchValidationErrorCode,
    message: string,
    /** Present on ANCHOR_NOT_FOUND and ANCHOR_AMBIGUOUS; absent on every other code. */
    readonly recovery: AnchorRecovery | null = null,
  ) {
    super(message);
    this.name = 'PatchValidationError';
  }
}

export async function prepareStructuredPatch(input: {
  owner: FileRevisionOwner;
  rootId?: string | undefined;
  workspacePath: string;
  expectedRootIdentityDigest?: string | undefined;
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
      rootId: input.rootId,
      workspacePath: input.workspacePath,
      expectedRootIdentityDigest: input.expectedRootIdentityDigest,
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
          preRevision: null,
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
      rootId: input.rootId,
      workspacePath: input.workspacePath,
      expectedRootIdentityDigest: input.expectedRootIdentityDigest,
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
          preRevision: preparedFileRevision(revision.token),
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
          preRevision: preparedFileRevision(revision.token),
          preImage: revision.content,
          postImage: null,
          preHash: revision.token.contentHash,
          postHash: null,
        }),
      );
      continue;
    }

    const destinationGuard = await canonicalizeResourcePath({
      rootId: input.rootId,
      workspacePath: input.workspacePath,
      expectedRootIdentityDigest: input.expectedRootIdentityDigest,
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
        preRevision: preparedFileRevision(revision.token),
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
  const ranges = edits.map((edit, editIndex) => {
    if (edit.oldText.length === 0)
      throw new PatchValidationError('INVALID_PATCH', 'Empty anchors are not allowed');
    const start = content.indexOf(edit.oldText);
    if (start < 0)
      throw new PatchValidationError(
        'ANCHOR_NOT_FOUND',
        `Update anchor ${editIndex} was not found`,
        describeMissingAnchor(content, edit.oldText, editIndex),
      );
    if (content.indexOf(edit.oldText, start + 1) >= 0)
      throw new PatchValidationError(
        'ANCHOR_AMBIGUOUS',
        `Update anchor ${editIndex} is not unique`,
        {
          editIndex,
          cause: 'ambiguous',
          occurrences: occurrencesOf(content, edit.oldText).lines,
          nearest: null,
        },
      );
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

/**
 * Works out why an anchor missed, cheaply and only once the match has already failed.
 *
 * The whitespace probes run first because they are the near-misses: when the anchor matches after
 * normalising line endings, trailing spaces, or indentation, the caller can fix its own text without
 * being shown the file. Only when none of those explain it does the drift search look for where the
 * region went, using the anchor's opening line as the locator.
 */
function describeMissingAnchor(content: string, anchor: string, editIndex: number): AnchorRecovery {
  const miss = (cause: AnchorFailureCause): AnchorRecovery => ({
    editIndex,
    cause,
    occurrences: [],
    nearest: null,
  });

  // Normalizing a blank-only anchor produces the empty string, and every string includes `''`.
  // Such an anchor has no locator and must not be reported as a whitespace near-match.
  if (anchor.trim().length === 0) return miss('absent');

  if (content.length <= MAX_NORMALIZATION_PROBE_CHARS) {
    if (stripCarriageReturns(content).includes(stripCarriageReturns(anchor)))
      return miss('line_ending');
    if (stripTrailingSpaces(content).includes(stripTrailingSpaces(anchor)))
      return miss('trailing_whitespace');
    if (stripIndentation(content).includes(stripIndentation(anchor))) return miss('indentation');
  }

  // The opening line locates the region. A blank-only anchor has nothing to locate with.
  const anchorLines = anchor.split('\n');
  const leadingBlankLines = anchorLines.findIndex((line) => line.trim().length > 0);
  const opening = anchorLines[leadingBlankLines]?.trim();
  if (opening === undefined) return miss('absent');

  const found = occurrencesOf(content, opening);
  // The opening line is gone too. That is the ordinary case for a single-line anchor — a model
  // anchors on exactly the line it means to replace, and someone else replaced it first — so
  // giving up here would send the most common edit shape back to re-read the file.
  if (found.lines.length === 0) return resembling(content, anchor, opening, editIndex);
  // So common it locates nothing: pointing at an arbitrary one of them would mislead.
  if (!found.exhaustive) return miss('absent');
  // Several candidates: the caller picks, so the line numbers are the useful answer.
  if (found.lines.length > 1)
    return { editIndex, cause: 'drifted', occurrences: found.lines, nearest: null };

  const line = found.lines[0] ?? 1;
  return {
    editIndex,
    cause: 'drifted',
    occurrences: found.lines,
    nearest: regionAt(content, Math.max(1, line - leadingBlankLines), anchorLines.length),
  };
}

/**
 * Locates the region by resemblance when the opening line itself has changed.
 *
 * Matched on the longest common prefix of the trimmed line, which is what survives the edits that
 * cause this: a renamed value, a changed argument, a flipped literal all keep the line's beginning.
 * Only the beginning — no attempt is made to be a diff algorithm, because a wrong guess here is
 * worse than none. The tool would be handing back a region the model then anchors to, and anchoring
 * to the wrong place is a silent bad edit where `absent` is merely a wasted read.
 *
 * So the bar is deliberately high: the match must share a substantial run with the anchor, and it
 * must be strictly the best in the file. A tie means two lines are equally plausible, and picking
 * either would be a coin flip presented to the model as a finding.
 */
function resembling(
  content: string,
  anchor: string,
  opening: string,
  editIndex: number,
): AnchorRecovery {
  const absent: AnchorRecovery = { editIndex, cause: 'absent', occurrences: [], nearest: null };
  const minimum = Math.max(
    MIN_RESEMBLANCE_CHARS,
    Math.ceil(opening.length * MIN_RESEMBLANCE_RATIO),
  );
  if (opening.length < minimum) return absent;

  const lines = content.split('\n');
  let bestLine = 0;
  let best = 0;
  let runnerUp = 0;
  for (const [index, line] of lines.entries()) {
    const shared = commonPrefixLength(line.trim(), opening);
    if (shared > best) {
      runnerUp = best;
      best = shared;
      bestLine = index + 1;
    } else if (shared > runnerUp) {
      runnerUp = shared;
    }
  }
  if (best < minimum || best === runnerUp) return absent;
  return {
    editIndex,
    cause: 'drifted',
    occurrences: Object.freeze([bestLine]),
    nearest: regionAt(content, bestLine, anchor.split('\n').length),
  };
}

/**
 * Enough shared text that the match is about this line and not about a shared idiom.
 *
 * The ratio does the real work. Two different functions share `function `, two different fields
 * share their indentation and a keyword, and a low bar would call any of those the same region —
 * returning a confidently wrong anchor. Requiring most of the line means the match survives a
 * changed value or argument but not a changed subject.
 */
const MIN_RESEMBLANCE_CHARS = 8;
const MIN_RESEMBLANCE_RATIO = 0.6;

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

/**
 * 1-based line numbers where `needle` occurs.
 *
 * `exhaustive` is false when the search stopped at the cap, which is the difference between "these
 * are the places" and "there are more than this many" — the caller treats those differently.
 */
function occurrencesOf(
  content: string,
  needle: string,
): { lines: readonly number[]; exhaustive: boolean } {
  const lines: number[] = [];
  let from = 0;
  for (;;) {
    const at = content.indexOf(needle, from);
    if (at < 0) return { lines: Object.freeze(lines), exhaustive: true };
    if (lines.length === MAX_RECOVERY_OCCURRENCES)
      return { lines: Object.freeze(lines), exhaustive: false };
    lines.push(lineNumberAt(content, at));
    from = at + 1;
  }
}

function lineNumberAt(content: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1)
    if (content.charCodeAt(index) === 10 /* \n */) line += 1;
  return line;
}

/** `lineCount` lines of the file as it stands now, starting at 1-based `line`. */
function regionAt(
  content: string,
  line: number,
  lineCount: number,
): Readonly<{ line: number; text: string; truncated: boolean }> {
  const lines = content.split('\n');
  const start = Math.max(0, line - 1);
  const capped = capBytes(lines.slice(start, start + Math.max(1, lineCount)).join('\n'));
  return Object.freeze({ line, text: capped.text, truncated: capped.truncated });
}

function capBytes(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= MAX_RECOVERY_TEXT_BYTES) return { text, truncated: false };
  let end = Math.min(text.length, MAX_RECOVERY_TEXT_BYTES);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > MAX_RECOVERY_TEXT_BYTES)
    end -= 1;
  // Never cut between the halves of a surrogate pair; that would emit a lone unpaired code unit.
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function stripCarriageReturns(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

function stripTrailingSpaces(value: string): string {
  const chunks: string[] = [];
  let lineStart = 0;
  for (let index = 0; index <= value.length; index += 1) {
    if (index < value.length && value.charCodeAt(index) !== 10 /* \n */) continue;
    const hasCarriageReturn = index > lineStart && value.charCodeAt(index - 1) === 13; /* \r */
    let end = hasCarriageReturn ? index - 1 : index;
    while (
      end > lineStart &&
      (value.charCodeAt(end - 1) === 32 /* space */ || value.charCodeAt(end - 1) === 9) /* tab */
    )
      end -= 1;
    chunks.push(value.slice(lineStart, end));
    if (hasCarriageReturn) chunks.push('\r');
    if (index < value.length) chunks.push('\n');
    lineStart = index + 1;
  }
  return chunks.join('');
}

function stripIndentation(value: string): string {
  return value.replace(/^[ \t]+/gm, '');
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
  return Object.freeze({
    ...operation,
    preRevision:
      operation.preRevision === null ? null : Object.freeze({ ...operation.preRevision }),
  });
}

function preparedFileRevision(token: FileRevisionToken): PreparedFileRevision {
  if (token.identity.kind !== 'file' || token.identity.nlink !== 1)
    throw new PatchValidationError('HARDLINK_WRITE_DENIED', 'Expected one regular file identity');
  return Object.freeze({
    identityDigest: token.identityDigest,
    contentHash: token.contentHash,
    size: token.size,
    mode: token.identity.mode,
    nlink: 1 as const,
  });
}
