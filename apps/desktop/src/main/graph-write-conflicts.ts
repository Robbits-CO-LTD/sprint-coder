import { stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { directoryCaseSensitive } from './directory-name-rules';
import type { GraphMissionClaimBinding } from './graph-mission-review';
import { isIssuedPathGuard, revalidatePathGuard } from './path-guard';

export type GraphWriteFootprint = Readonly<{
  stepKey: string;
  canonicalPath: string;
  declaredPath: string;
  rootKey: string;
  rootAncestors: readonly string[];
  objectKey: string;
  ancestors: readonly string[];
  directory: boolean;
  suffix: readonly string[];
  caseSensitive: boolean | null;
  semanticKeys: readonly string[];
}>;
const issued = new WeakSet<object>();

async function identity(path: string) {
  const info = await stat(path, { bigint: true });
  if (!info.isDirectory() && !info.isFile()) throw new Error('Unsupported graph claim target');
  return {
    key: `${info.dev}:${info.ino}`,
    dev: String(info.dev),
    ino: String(info.ino),
    directory: info.isDirectory(),
  };
}
async function ancestorKeys(path: string): Promise<string[]> {
  const keys: string[] = [];
  for (let current = dirname(path), depth = 0; current !== path; current = dirname(path)) {
    if (++depth > 256) throw new Error('Graph claim ancestry is too deep');
    const entry = await identity(current);
    if (!entry.directory) throw new Error('Graph claim ancestor is not a directory');
    keys.push(entry.key);
    path = current;
  }
  return keys;
}

/** Main-only filesystem preparation. Recompute before dispatch; this is not an ownership lease. */
export async function prepareGraphWriteFootprint(
  claim: GraphMissionClaimBinding,
): Promise<GraphWriteFootprint> {
  const guard = claim.guard;
  if (
    !isIssuedPathGuard(guard) ||
    claim.rootIdentityDigest !== guard.rootIdentityDigest ||
    claim.rootId !== guard.rootId ||
    claim.canonicalPath !== join(guard.resolvedPath, ...claim.missingSuffix) ||
    claim.missingSuffix.some(
      (part) => part === '' || part === '.' || part === '..' || /[/\\\0]/u.test(part),
    )
  )
    throw new Error('Graph claim binding mismatch');
  await revalidatePathGuard(guard);
  const missing = guard.targetIdentity === null;
  if (!missing && claim.missingSuffix.length !== 0) throw new Error('Graph claim suffix mismatch');
  const anchor = missing ? dirname(guard.resolvedPath) : guard.resolvedPath;
  const object = await identity(anchor);
  if (missing && !object.directory) throw new Error('Graph claim parent is not a directory');
  const root = await identity(guard.workspacePath);
  const caseSensitive = missing ? directoryCaseSensitive(anchor, object) : null;
  if (caseSensitive !== claim.missingNameCaseSensitive)
    throw new Error('Graph claim name rules changed');
  const footprint: GraphWriteFootprint = Object.freeze({
    stepKey: claim.stepKey,
    canonicalPath: claim.canonicalPath,
    declaredPath: join(
      resolve(guard.workspacePath, guard.originalTargetPath),
      ...claim.missingSuffix,
    ),
    rootKey: root.key,
    rootAncestors: Object.freeze(await ancestorKeys(guard.workspacePath)),
    objectKey: object.key,
    ancestors: Object.freeze(await ancestorKeys(anchor)),
    directory: object.directory,
    suffix: Object.freeze(missing ? [basename(guard.resolvedPath), ...claim.missingSuffix] : []),
    caseSensitive,
    semanticKeys: Object.freeze([...claim.semanticKeys]),
  });
  await revalidatePathGuard(guard);
  if (
    (await identity(anchor)).key !== object.key ||
    (await identity(guard.workspacePath)).key !== root.key ||
    (missing && directoryCaseSensitive(anchor, object) !== caseSensitive)
  )
    throw new Error('Graph claim identity changed');
  issued.add(footprint);
  return footprint;
}

function nameKey(name: string, sensitive: boolean): string {
  // macOS lookup treats canonically equivalent Unicode spellings alike, including on case-sensitive APFS.
  const normalized =
    process.platform === 'darwin' || (!sensitive && process.platform === 'linux')
      ? name.normalize('NFD')
      : name;
  // Include case expansions in a conservative collision group for names that do not exist yet.
  if (sensitive) return normalized;
  const folded = normalized.toLowerCase().toUpperCase();
  return process.platform === 'win32' ? folded : folded.normalize('NFD');
}
function possibleShortName(name: string): boolean {
  return process.platform === 'win32' && /^[^ .~]{1,6}~[^ .]{1,6}(?:\.[^.]{0,3})?$/u.test(name);
}
function missingPathsOverlap(left: GraphWriteFootprint, right: GraphWriteFootprint): boolean {
  if (left.caseSensitive !== right.caseSensitive || left.caseSensitive === null)
    throw new Error('Graph claim name rules disagree');
  for (let i = 0; i < Math.min(left.suffix.length, right.suffix.length); i++) {
    const a = left.suffix[i]!;
    const b = right.suffix[i]!;
    // A future Windows short alias cannot be derived until its directory entries exist.
    if (possibleShortName(a) || possibleShortName(b)) return true;
    if (nameKey(a, left.caseSensitive) !== nameKey(b, left.caseSensitive)) return false;
  }
  return true;
}

export function graphWriteClaimsConflict(
  left: GraphWriteFootprint,
  right: GraphWriteFootprint,
): boolean {
  if (!issued.has(left) || !issued.has(right)) throw new Error('Unissued graph write footprint');
  const rootsOverlap =
    left.rootKey === right.rootKey ||
    left.rootAncestors.includes(right.rootKey) ||
    right.rootAncestors.includes(left.rootKey);
  if (rootsOverlap && left.semanticKeys.some((key) => right.semanticKeys.includes(key)))
    return true;
  // Keep the declared address occupied if a missing entry appears or a file is replaced while
  // its owner is still active. Inode equality alone would lose that ownership during the change.
  if (rootsOverlap) {
    const atOrBelow = (parent: string, child: string) =>
      parent === child || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
    const overlap = (a: string, b: string) => atOrBelow(a, b) || atOrBelow(b, a);
    for (const a of [left.canonicalPath, left.declaredPath]) {
      for (const b of [right.canonicalPath, right.declaredPath]) {
        if (overlap(a, b)) return true;
        if (
          (left.caseSensitive === false || right.caseSensitive === false) &&
          overlap(nameKey(a, false), nameKey(b, false))
        )
          return true;
      }
    }
  }
  if (left.objectKey === right.objectKey) {
    if (left.suffix.length === 0 || right.suffix.length === 0) return true;
    return missingPathsOverlap(left, right);
  }
  return (
    (left.directory && left.suffix.length === 0 && right.ancestors.includes(left.objectKey)) ||
    (right.directory && right.suffix.length === 0 && left.ancestors.includes(right.objectKey))
  );
}

export function graphWriteConflictPairs(
  footprints: readonly GraphWriteFootprint[],
): { leftStepKey: string; rightStepKey: string }[] {
  const pairs = new Map<string, { leftStepKey: string; rightStepKey: string }>();
  for (let i = 0; i < footprints.length; i++) {
    const left = footprints[i]!;
    for (const right of footprints.slice(i + 1)) {
      if (left.stepKey === right.stepKey || !graphWriteClaimsConflict(left, right)) continue;
      const pair =
        left.stepKey < right.stepKey
          ? { leftStepKey: left.stepKey, rightStepKey: right.stepKey }
          : { leftStepKey: right.stepKey, rightStepKey: left.stepKey };
      pairs.set(JSON.stringify(pair), pair);
    }
  }
  return [...pairs.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, pair]) => pair);
}
