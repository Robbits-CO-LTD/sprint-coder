import { afterEach, describe, expect, it } from 'vitest';
import { link, mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PathGuardError,
  canonicalizeResourcePath,
  createPathGuard,
  openGuardedExistingFile,
  revalidatePathGuard,
  workspacePermissionResourceFromGuard,
  workspaceMutationBinding,
} from './path-guard';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sprint-coder-path-guard-'));
  temporaryRoots.push(root);
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  await mkdir(join(workspace, 'src'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(workspace, 'src', 'safe.txt'), 'safe');
  await writeFile(join(outside, 'secret.txt'), 'secret');
  return { root, workspace, outside };
}

describe('path guard', () => {
  it('canonicalizes a workspace-relative path to a stable identity', async () => {
    const { workspace } = await fixture();
    const identity = await canonicalizeResourcePath({
      workspacePath: workspace,
      targetPath: 'src/safe.txt',
      operation: 'read',
    });

    expect(identity.resolvedPath).toBe(await realpath(join(workspace, 'src', 'safe.txt')));
    expect(identity.targetIdentity).toMatchObject({ kind: 'file' });
    expect(identity.chain.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects relative traversal even when normalization would return inside the workspace', async () => {
    const { workspace } = await fixture();

    await expect(
      canonicalizeResourcePath({
        workspacePath: workspace,
        targetPath: 'src/../src/safe.txt',
        operation: 'read',
      }),
    ).rejects.toMatchObject({ code: 'RELATIVE_TRAVERSAL' } satisfies Partial<PathGuardError>);
  });

  it('rejects a symlink that escapes the canonical workspace', async () => {
    const { workspace, outside } = await fixture();
    await symlink(outside, join(workspace, 'escape'));

    await expect(
      canonicalizeResourcePath({
        workspacePath: workspace,
        targetPath: 'escape/secret.txt',
        operation: 'read',
      }),
    ).rejects.toMatchObject({ code: 'PATH_ESCAPE' } satisfies Partial<PathGuardError>);
  });

  it('allows a missing write target only when its existing parent is inside the workspace', async () => {
    const { workspace } = await fixture();
    const identity = await canonicalizeResourcePath({
      workspacePath: workspace,
      targetPath: 'src/new.txt',
      operation: 'write',
    });

    expect(identity.resolvedPath).toBe(join(await realpath(join(workspace, 'src')), 'new.txt'));
    expect(identity.targetIdentity).toBeNull();
    expect(identity.parentIdentity.kind).toBe('directory');
  });

  it('detects target replacement between approval and execution', async () => {
    const { workspace } = await fixture();
    const target = join(workspace, 'src', 'safe.txt');
    const guard = await createPathGuard({
      workspacePath: workspace,
      targetPath: target,
      operation: 'read',
    });
    await rm(target);
    await writeFile(target, 'replacement');

    await expect(revalidatePathGuard(guard)).rejects.toMatchObject({
      code: 'IDENTITY_CHANGED',
    } satisfies Partial<PathGuardError>);
  });

  it('detects a parent directory swapped for an escaping symlink before a write', async () => {
    const { workspace, outside } = await fixture();
    const guardedParent = join(workspace, 'src');
    const guard = await createPathGuard({
      workspacePath: workspace,
      targetPath: 'src/new.txt',
      operation: 'write',
    });
    await rename(guardedParent, join(workspace, 'src-original'));
    await symlink(outside, guardedParent);

    await expect(revalidatePathGuard(guard)).rejects.toBeInstanceOf(PathGuardError);
  });

  it('binds execution to the approved inode through an open file handle', async () => {
    const { workspace } = await fixture();
    const guard = await createPathGuard({
      workspacePath: workspace,
      targetPath: 'src/safe.txt',
      operation: 'read',
    });

    const handle = await openGuardedExistingFile(guard, 'read');
    try {
      expect(await handle.readFile('utf8')).toBe('safe');
    } finally {
      await handle.close();
    }
  });

  it('rejects a replacement that wins the race before the guarded open', async () => {
    const { workspace } = await fixture();
    const target = join(workspace, 'src', 'safe.txt');
    const guard = await createPathGuard({
      workspacePath: workspace,
      targetPath: 'src/safe.txt',
      operation: 'read',
    });
    await rename(target, join(workspace, 'src', 'approved.txt'));
    await writeFile(target, 'attacker replacement');

    await expect(openGuardedExistingFile(guard, 'read')).rejects.toMatchObject({
      code: 'IDENTITY_CHANGED',
    } satisfies Partial<PathGuardError>);
  });

  it('fails closed for new-file writes without a native handle-relative boundary', async () => {
    const { workspace } = await fixture();
    const guard = await createPathGuard({
      workspacePath: workspace,
      targetPath: 'src/new.txt',
      operation: 'write',
    });

    await expect(openGuardedExistingFile(guard, 'write')).rejects.toMatchObject({
      code: 'UNSUPPORTED_RACE_SAFE_OPERATION',
    } satisfies Partial<PathGuardError>);
  });

  it('denies writes through multiply-linked files', async () => {
    const { workspace, outside } = await fixture();
    const outsideTarget = join(outside, 'linked-secret.txt');
    await writeFile(outsideTarget, 'linked');
    await link(outsideTarget, join(workspace, 'src', 'linked.txt'));
    const guard = await createPathGuard({
      workspacePath: workspace,
      targetPath: 'src/linked.txt',
      operation: 'write',
    });

    await expect(openGuardedExistingFile(guard, 'write')).rejects.toMatchObject({
      code: 'UNSUPPORTED_RACE_SAFE_OPERATION',
    } satisfies Partial<PathGuardError>);
  });

  it('never lets a read approval open a writable handle', async () => {
    const { workspace } = await fixture();
    const guard = await createPathGuard({
      workspacePath: workspace,
      targetPath: 'src/safe.txt',
      operation: 'read',
    });

    await expect(openGuardedExistingFile(guard, 'write')).rejects.toMatchObject({
      code: 'UNSUPPORTED_RACE_SAFE_OPERATION',
    } satisfies Partial<PathGuardError>);
  });

  it('derives protected classification and workspace identity from the guard', async () => {
    const { workspace } = await fixture();
    await mkdir(join(workspace, '.git'));
    await writeFile(join(workspace, '.git', 'config'), 'protected');
    const guard = await createPathGuard({
      workspacePath: workspace,
      targetPath: '.git/config',
      operation: 'read',
    });

    const resource = workspacePermissionResourceFromGuard(guard);
    expect(resource.classification).toBe('app-private');
    expect(resource.workspaceId).toMatch(/^[a-f0-9]{64}$/);
    expect(resource.identityDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('classifies common credential directories independently of the file extension', async () => {
    const { workspace } = await fixture();
    await mkdir(join(workspace, '.config', 'gcloud'), { recursive: true });
    await writeFile(
      join(workspace, '.config', 'gcloud', 'application_default_credentials.json'),
      '{}',
    );
    const guard = await createPathGuard({
      workspacePath: workspace,
      targetPath: '.config/gcloud/application_default_credentials.json',
      operation: 'read',
    });
    expect(workspacePermissionResourceFromGuard(guard).classification).toBe('credential');
  });

  it('inherits a protected classification when the sensitive directory is the Workspace root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sprint-coder-sensitive-root-'));
    temporaryRoots.push(root);
    const credentialRoot = join(root, '.ssh');
    await mkdir(credentialRoot);
    await writeFile(join(credentialRoot, 'config'), 'Host example');
    const guard = await createPathGuard({
      workspacePath: credentialRoot,
      targetPath: 'config',
      operation: 'read',
    });
    expect(workspacePermissionResourceFromGuard(guard).classification).toBe('credential');
  });

  it('classifies an ordinary canonical Workspace write as Workspace policy scope', async () => {
    const { workspace } = await fixture();
    const guard = await createPathGuard({
      workspacePath: workspace,
      targetPath: 'src/safe.txt',
      operation: 'write',
    });
    expect(workspacePermissionResourceFromGuard(guard).classification).toBe('workspace');
  });

  it('does not treat an OS root selected as a Workspace as ordinary Workspace content', async () => {
    const guard = await createPathGuard({
      workspacePath: '/',
      targetPath: '/etc/hosts',
      operation: 'read',
    });
    expect(workspacePermissionResourceFromGuard(guard).classification).toBe('os-protected');
  });

  it('classifies platform system roots as protected when selected through a broad Workspace', async () => {
    if (process.platform === 'win32') {
      const windowsRoot = process.env['WINDIR'];
      if (windowsRoot === undefined) return;
      const guard = await createPathGuard({
        workspacePath: windowsRoot,
        targetPath: join(windowsRoot, 'System32'),
        operation: 'read',
      });
      expect(workspacePermissionResourceFromGuard(guard).classification).toBe('os-protected');
      return;
    }
    const guard = await createPathGuard({
      workspacePath: '/',
      targetPath: '/dev/null',
      operation: 'read',
    });
    expect(workspacePermissionResourceFromGuard(guard).classification).toBe('os-protected');
  });

  it('rejects directories and contained symlinks at the regular-file handle boundary', async () => {
    const { workspace } = await fixture();
    const directoryGuard = await createPathGuard({
      workspacePath: workspace,
      targetPath: 'src',
      operation: 'read',
    });
    await symlink('safe.txt', join(workspace, 'src', 'inside-link'));
    const symlinkGuard = await createPathGuard({
      workspacePath: workspace,
      targetPath: 'src/inside-link',
      operation: 'read',
    });

    await expect(openGuardedExistingFile(directoryGuard, 'read')).rejects.toMatchObject({
      code: 'SPECIAL_FILE',
    } satisfies Partial<PathGuardError>);
    await expect(openGuardedExistingFile(symlinkGuard, 'read')).rejects.toMatchObject({
      code: 'SPECIAL_FILE',
    } satisfies Partial<PathGuardError>);
  });

  it('binds canonical workspace aliases to one root identity and mutation scope', async () => {
    const { root, workspace } = await fixture();
    const alias = `${workspace}-alias`;
    await symlink(workspace, alias);

    const direct = await workspaceMutationBinding(workspace);
    const throughAlias = await workspaceMutationBinding(alias);
    await writeFile(join(workspace, 'new-file.txt'), 'changes directory metadata');
    const afterContentChange = await workspaceMutationBinding(workspace);
    const renamed = join(root, 'renamed-workspace');
    await rename(workspace, renamed);
    const afterRename = await workspaceMutationBinding(renamed);

    expect(throughAlias).toEqual(direct);
    expect(afterContentChange.workspaceKey).toBe(direct.workspaceKey);
    expect(afterRename.workspaceKey).toBe(direct.workspaceKey);
    expect(afterRename.rootIdentityDigest).toBe(direct.rootIdentityDigest);
    expect(direct.workspaceKey).toMatch(/^[a-f0-9]{64}$/);
    expect(direct.rootIdentityDigest).toMatch(/^[a-f0-9]{64}$/);
  });
});
