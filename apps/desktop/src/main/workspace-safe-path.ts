import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Resolves an existing regular file without following a reparse-point/symlink chain out of the
 * selected Workspace. Lexical containment alone is insufficient on Windows: an ordinary child
 * path can pass through an NTFS junction whose target is on another drive or outside the root.
 */
export type SafeWorkspaceFileResult =
  | {
      path: string;
      reason: null;
      identity: Readonly<{ dev: bigint; ino: bigint; nlink: bigint }>;
    }
  | { path: null; reason: 'outside_workspace' | 'not_a_file'; identity?: never };

export function resolveSafeWorkspaceFile(
  workspacePath: string,
  relativePath: string,
): SafeWorkspaceFileResult {
  if (relativePath.length === 0 || relativePath.length > 1024)
    return { path: null, reason: 'outside_workspace' };
  let root: string;
  try {
    root = realpathSync(workspacePath);
  } catch {
    return { path: null, reason: 'outside_workspace' };
  }
  let absolute = resolve(root, relativePath);
  if (isAbsolute(relativePath)) {
    try {
      // macOS commonly exposes /var through the /private/var symlink. Canonicalize only the
      // parent so an absolute path selected by the native dialog compares against the canonical
      // Workspace root, while lstat below still sees and rejects a symlink at the file leaf.
      absolute = join(realpathSync(dirname(absolute)), basename(absolute));
    } catch {
      const lexicalRoot = resolve(workspacePath);
      const lexicalRelation = relative(lexicalRoot, absolute);
      const outside =
        lexicalRelation === '..' ||
        lexicalRelation.startsWith(`..${sep}`) ||
        isAbsolute(lexicalRelation);
      return { path: null, reason: outside ? 'outside_workspace' : 'not_a_file' };
    }
  }
  const relation = relative(root, absolute);
  if (
    relation.length === 0 ||
    relation === '..' ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation)
  )
    return { path: null, reason: 'outside_workspace' };
  try {
    const stat = lstatSync(absolute, { bigint: true });
    // A second hardlink can alias a file outside the Workspace without looking like a symlink.
    // The manual editor cannot prove ownership of every alias, so fail closed for multiply-linked
    // files just as it does for reparse points.
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n)
      return { path: null, reason: 'not_a_file' };
    const canonical = realpathSync(absolute);
    if (!samePath(canonical, absolute)) return { path: null, reason: 'outside_workspace' };
    const parentRelation = relative(root, dirname(canonical));
    if (
      parentRelation === '..' ||
      parentRelation.startsWith(`..${sep}`) ||
      isAbsolute(parentRelation)
    )
      return { path: null, reason: 'outside_workspace' };
    return {
      path: canonical,
      reason: null,
      identity: { dev: stat.dev, ino: stat.ino, nlink: stat.nlink },
    };
  } catch {
    return { path: null, reason: 'not_a_file' };
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US')
    : left === right;
}
