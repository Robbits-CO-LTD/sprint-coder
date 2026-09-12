import { lstat, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { GraphMissionRecord } from './graph-mission-record';
import { graphMissionStoredContextSchema } from './graph-mission-record';
import type { GraphWriteFootprint } from './graph-write-conflicts';
import { validateGraphWriteInventory } from './graph-write-inventory';
import { directoryCaseSensitive } from './directory-name-rules';
import { workspaceMutationBinding } from './path-guard';
import type { SealedWorktreeChange } from './worker-worktree';

export class GraphWriteScopeError extends Error {
  constructor(readonly undeclaredPaths: readonly string[]) {
    super(
      `Graph integration held: ${undeclaredPaths.length} change(s) are outside the declared write scope`,
    );
    this.name = 'GraphWriteScopeError';
  }
}
function sameEntry(a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }) {
  return a.dev === b.dev && a.ino === b.ino;
}
async function namesAlias(
  parent: string,
  declared: string,
  changed: string,
  missingCaseSensitive: boolean | null,
): Promise<boolean> {
  if (declared === changed) return true;
  let parentInfo;
  try {
    parentInfo = await lstat(parent, { bigint: true });
  } catch (error) {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT' &&
      missingCaseSensitive === false &&
      /^[\x20-\x7e]+$/u.test(declared + changed) &&
      declared.toLowerCase() === changed.toLowerCase()
    );
  }
  if (!parentInfo.isDirectory()) return false;
  if (
    /^[\x20-\x7e]+$/u.test(declared + changed) &&
    declared.toLowerCase() === changed.toLowerCase()
  )
    return !directoryCaseSensitive(parent, {
      dev: String(parentInfo.dev),
      ino: String(parentInfo.ino),
    });
  // Unlike collision grouping, permission coverage needs proof of the same existing entry.
  // Do not infer authorization from Unicode expansions or possible future short names.
  let a, b;
  try {
    [a, b] = await Promise.all([
      lstat(join(parent, declared), { bigint: true }),
      lstat(join(parent, changed), { bigint: true }),
    ]);
  } catch {
    return false;
  }
  if (!sameEntry(a, b)) return false;
  if (!a.isDirectory()) return a.nlink === 1n && b.nlink === 1n;
  let entries = 0;
  let aliases = 0;
  for await (const entry of await opendir(parent)) {
    if (++entries > 4096 || entry.name.includes('\ufffd')) return false;
    try {
      if (sameEntry(a, await lstat(join(parent, entry.name), { bigint: true }))) aliases++;
    } catch {
      return false;
    }
    if (aliases > 1) return false;
  }
  return aliases === 1;
}
async function covers(
  repo: string,
  footprint: GraphWriteFootprint,
  path: string,
): Promise<boolean> {
  const target = path.split('/');
  const subtree = footprint.directory || footprint.suffix.length > 0;
  for (const address of [footprint.declaredPath, footprint.canonicalPath]) {
    const scoped = relative(repo, address);
    if (isAbsolute(scoped) || scoped === '..' || scoped.startsWith(`..${sep}`)) continue;
    const prefix = scoped === '' ? [] : scoped.split(sep);
    if (prefix.length > target.length || (!subtree && prefix.length !== target.length)) continue;
    let matched = true;
    for (let i = 0; i < prefix.length; i++) {
      if (
        !(await namesAlias(
          join(repo, ...target.slice(0, i)),
          prefix[i]!,
          target[i]!,
          footprint.caseSensitive,
        ))
      ) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/** Validate actual sealed Git paths. No file is edited and no scope is widened on failure. */
export async function assertGraphWriteCoverage(
  graph: GraphMissionRecord,
  stepKey: string,
  footprints: readonly GraphWriteFootprint[],
  repositoryPath: string,
  changes: readonly SealedWorktreeChange[],
): Promise<void> {
  validateGraphWriteInventory(graph, stepKey, footprints);
  const context = graphMissionStoredContextSchema.parse(JSON.parse(graph.contextJson));
  const identities = new Map(context.roots);
  for (const root of context.workspace.roots) {
    const expected = identities.get(root.rootId);
    if (!expected || (await workspaceMutationBinding(root.path)).rootIdentityDigest !== expected)
      throw new Error('Graph integration root changed');
  }
  const repo = await realpath(repositoryPath);
  const undeclared: string[] = [];
  for (const change of changes) {
    const parts = change.path.split('/');
    if (
      isAbsolute(change.path) ||
      change.path.includes('\0') ||
      parts.some((part) => part === '' || part === '.' || part === '..') ||
      (process.platform === 'win32' &&
        parts.some(
          (part) =>
            /[<>:"\\|?*]/u.test(part) ||
            [...part].some((char) => char.charCodeAt(0) < 32) ||
            /[ .]$/u.test(part) ||
            /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part),
        ))
    )
      throw new Error('Invalid graph integration change path');
    if (
      parts.some(
        (part) =>
          part
            .normalize('NFKC')
            .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
            .toLowerCase() === '.git' ||
          (process.platform === 'win32' && /^git~[0-9]/iu.test(part)),
      )
    )
      throw new Error('Graph changes cannot modify repository control data');
    let covered = false;
    for (const footprint of footprints) {
      if (await covers(repo, footprint, change.path)) {
        covered = true;
        break;
      }
    }
    if (!covered) undeclared.push(change.path);
  }
  if (undeclared.length) throw new GraphWriteScopeError(undeclared);
}
