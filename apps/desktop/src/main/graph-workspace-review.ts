import { createHash } from 'node:crypto';
import { basename, dirname } from 'node:path';
import { workspaceMutationBinding } from './path-guard';
import type { SealedPostImageObserver, SealedPostImageSession } from './persistence';
import type { WorkerWorktreeManager, CreateWorktreeInput } from './worker-worktree';

/** This snapshot permits reviewing a continuation; it is never a completion checkpoint. */
export async function reviewGraphWorkspace(
  manager: WorkerWorktreeManager,
  input: CreateWorktreeInput & { path: string; baseHead: string },
  observe: SealedPostImageObserver,
) {
  const before = await manager.inspectPreserved(input);
  const workspace = await workspaceMutationBinding(before.path);
  const indexRoot = await workspaceMutationBinding(dirname(before.indexPath));
  const sessions: SealedPostImageSession[] = [];
  const pin = (root: typeof workspace, id: string) => {
    const session = observe({
      rootId: id,
      workspacePath: root.canonicalPath,
      workspaceKey: root.workspaceKey,
    });
    if (!session) throw new Error('Native workspace review is unavailable');
    sessions.push(session);
    if (session.rootIdentityDigest !== root.rootIdentityDigest)
      throw new Error('Preserved workspace identity changed');
    return session;
  };
  try {
    const files = pin(workspace, 'graph-preserved-workspace');
    const index = pin(indexRoot, 'graph-preserved-index');
    const capture = () => {
      const inventory = before.changedFiles.map((path) => {
        const segments = path.split('/');
        if (segments.some((part) => !part || part === '.' || part === '..' || part.includes('\\')))
          throw new Error('Preserved workspace contains an unsupported path');
        const image = files.observe(segments);
        if (image.kind !== 'file' && image.kind !== 'absent')
          throw new Error(
            'Preserved workspace contains a link, directory or special file requiring manual review',
          );
        return { path, image };
      });
      const indexImage = index.observe([basename(before.indexPath)]);
      if (indexImage.kind !== 'file') throw new Error('Preserved Git index is unavailable');
      const gitFile = files.observe(['.git']);
      if (gitFile.kind !== 'file') throw new Error('Preserved worktree registration file changed');
      return { inventory, indexImage, gitFile };
    };
    const captured = capture();
    const after = await manager.inspectPreserved(input);
    if (
      JSON.stringify(before) !== JSON.stringify(after) ||
      JSON.stringify(captured) !== JSON.stringify(capture())
    )
      throw new Error('Preserved workspace changed during review');
    if (
      (await workspaceMutationBinding(input.path)).rootIdentityDigest !==
        workspace.rootIdentityDigest ||
      (await workspaceMutationBinding(dirname(before.indexPath))).rootIdentityDigest !==
        indexRoot.rootIdentityDigest
    )
      throw new Error('Preserved workspace was replaced during review');
    return {
      digest: createHash('sha256')
        .update(
          JSON.stringify({
            before,
            captured,
            root: workspace.rootIdentityDigest,
            indexRoot: indexRoot.rootIdentityDigest,
          }),
        )
        .digest('hex'),
      changedFiles: before.changedFiles,
    };
  } finally {
    for (const session of sessions.reverse()) session.close();
  }
}
