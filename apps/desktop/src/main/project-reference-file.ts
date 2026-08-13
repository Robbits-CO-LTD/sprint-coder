import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ProjectReference } from '@sprint-coder/contracts';
import { assertStableSingleLinkFile } from './stable-file-snapshot';

export const PROJECT_REFERENCE_MAX_BYTES = 65_536;

export type ProjectReferenceRead = Readonly<{
  status: ProjectReference['status'];
  content: string | null;
  digest: string | null;
}>;

export function readProjectReference(input: {
  workspacePath: string | null;
  registeredRootIdentity: string;
  relativePath: string;
}): ProjectReferenceRead {
  if (input.workspacePath === null) return result('workspace_changed');
  let root: string;
  try {
    root = realpathSync(input.workspacePath);
    const rootStat = lstatSync(root, { bigint: true });
    const currentRootIdentity = createHash('sha256')
      .update(
        JSON.stringify([
          'workspace-root-v2',
          rootStat.dev.toString(),
          rootStat.ino.toString(),
          'directory',
        ]),
      )
      .digest('hex');
    if (!rootStat.isDirectory() || currentRootIdentity !== input.registeredRootIdentity)
      return result('workspace_changed');
  } catch {
    return result('workspace_changed');
  }
  const absolute = resolve(root, input.relativePath);
  const relation = relative(root, absolute);
  if (
    relation.length === 0 ||
    relation === '..' ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation)
  )
    return result('unreadable');

  let fd: number | null = null;
  try {
    const lexical = lstatSync(absolute, { bigint: true });
    if (!lexical.isFile()) return result(lexical.isSymbolicLink() ? 'unreadable' : 'non_text');
    if (realpathSync(absolute) !== absolute) return result('unreadable');
    if (lexical.size > PROJECT_REFERENCE_MAX_BYTES) return result('too_large');
    fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) return result('non_text');
    if (before.size > BigInt(PROJECT_REFERENCE_MAX_BYTES)) return result('too_large');
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    const pathAfter = lstatSync(absolute, { bigint: true });
    assertStableSingleLinkFile(lexical, before, after, pathAfter, bytes);
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return result('non_text');
    }
    if (content.includes('\0')) return result('non_text');
    return { status: 'healthy', content, digest: createHash('sha256').update(bytes).digest('hex') };
  } catch (error) {
    return result((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable');
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // The read result is already fixed; close failure cannot make bytes safer to use.
      }
    }
  }
}

function result(status: ProjectReference['status']): ProjectReferenceRead {
  return { status, content: null, digest: null };
}
