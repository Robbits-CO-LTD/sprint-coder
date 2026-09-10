import { createHash } from 'node:crypto';
import type { GraphSourceRef, GraphSourcePreview } from '@sprint-coder/contracts';
import { workspaceMutationBinding, PathGuardError } from './path-guard';
import { readRevisionBoundFile } from './file-revision';

/** User-initiated local inspection, using the same guarded read boundary as Workspace reads. */
export async function previewGraphSource(
  source: GraphSourceRef,
  workspacePath: string | null,
  policyEpoch: number,
): Promise<GraphSourcePreview> {
  const unavailable = (status: GraphSourcePreview['status']): GraphSourcePreview => ({
    source,
    status,
    currentExcerpt: null,
    truncated: false,
  });
  if (workspacePath === null) return unavailable('unavailable');
  try {
    const root = await workspaceMutationBinding(workspacePath);
    if (root.rootIdentityDigest !== source.rootIdentityDigest) return unavailable('root_changed');
    const read = await readRevisionBoundFile({
      rootId: source.rootId,
      workspacePath: root.canonicalPath,
      expectedRootIdentityDigest: source.rootIdentityDigest,
      targetPath: source.path,
      policyEpoch,
      maxBytes: 4 * 1024 * 1024,
    });
    const excerpt = read.content
      .split('\n')
      .slice(source.lineStart - 1, source.lineEnd)
      .join('\n');
    const current =
      read.token.contentHash === source.contentHash &&
      createHash('sha256').update(excerpt).digest('hex') === source.excerptHash;
    return {
      source,
      status: current ? 'current' : 'changed',
      currentExcerpt: excerpt.slice(0, 16384),
      truncated: excerpt.length > 16384,
    };
  } catch (error) {
    return unavailable(
      error instanceof PathGuardError && error.code === 'PATH_NOT_FOUND'
        ? 'missing'
        : 'unavailable',
    );
  }
}
