import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, rmdir, link, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import type { EffectiveWorkspaceSet } from '@sprint-coder/contracts';
import { expandAccessPreset } from '@sprint-coder/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { workspaceMutationBinding } from './path-guard';
import { PermissionBroker } from './permission-broker';
import { loadProjectPermissionSettings } from './project-permission-settings';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'sc-push-read-'));
  temporary.push(base);
  const root = join(base, 'root');
  await mkdir(root);
  const { canonicalPath, rootIdentityDigest } = await workspaceMutationBinding(root);
  const workspace: EffectiveWorkspaceSet = {
    source: 'project',
    projectId: 'project',
    primaryRootId: 'root',
    roots: [
      {
        rootId: 'root',
        role: 'primary',
        status: 'available',
        path: canonicalPath,
        label: 'Fixture',
      },
    ],
    digest: 'f'.repeat(64),
  };
  let policyEpoch = 1;
  const unused = (): never => {
    throw new Error('Unexpected persistence access during offline push preparation');
  };
  const broker = new PermissionBroker(
    {
      readTurnWorkspaceSetForTask: () => workspace,
      getTurnWorkspaceRootIdentities: () => new Map([['root', rootIdentityDigest]]),
      getPermissionPolicy: () => ({
        preset: 'ask',
        expandedPolicy: expandAccessPreset('ask'),
        policyEpoch,
        revokedCapabilities: [],
      }),
      getEffectiveWorkspaceSet: unused,
      setAccessPreset: unused,
      listPermissionGrants: unused,
      revokePermissionCapability: unused,
      recordPermissionAudit: unused,
      listPendingPermissionPolicyEpochs: unused,
      markPermissionPolicyEpochDelivered: unused,
      registerPermissionOneTimeToken: unused,
      consumePermissionOneTimeToken: unused,
      commitPermissionEvaluation: unused,
    },
    undefined,
    {
      snapshot: loadProjectPermissionSettings,
    },
  );
  const pathFor = (oid: string) => join(root, '.git', 'objects', oid.slice(0, 2), oid.slice(2));
  async function object(kind: string, payload: Buffer | string) {
    const body = Buffer.from(payload);
    const raw = Buffer.concat([Buffer.from(kind + ' ' + body.length + '\0'), body]);
    const oid = createHash('sha1').update(raw).digest('hex');
    const path = pathFor(oid);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, deflateSync(raw));
    return oid;
  }
  const parent = 'b'.repeat(40);
  const tree = (items: Array<[string, string]>) =>
    object(
      'tree',
      Buffer.concat(
        items.flatMap(([name, oid]) => [
          Buffer.from('100644 ' + name + '\0'),
          Buffer.from(oid, 'hex'),
        ]),
      ),
    );
  const commit = (treeOid: string, extra = '') =>
    object(
      'commit',
      [
        'tree ' + treeOid,
        'parent ' + parent,
        'author Fixture <fixture@example.invalid> 1700000000 +0900',
        'committer Fixture <fixture@example.invalid> 1700000010 +0000',
        extra + '\nFixture message\n',
      ].join('\n'),
    );
  const prepare = (commitOid: string, rootId = 'root', signal = new AbortController().signal) =>
    broker.prepareLocalGithubPush({ taskId: 'task', turnId: 'turn', rootId, commitOid, signal });
  return {
    base,
    root,
    pathFor,
    parent,
    object,
    tree,
    commit,
    prepare,
    bumpPolicy: () => ++policyEpoch,
  };
}

describe('offline local GitHub push preparation', () => {
  it('binds the selected root and exact immutable bytes without involving Git or the checkout', async () => {
    const f = await fixture();
    const blob = await f.object('blob', 'persisted only in Git');
    const tree = await f.tree([['readme.md', blob]]);
    const commit = await f.commit(tree);
    await f.object('blob', 'unselected data');
    await expect(f.prepare(commit, 'unknown')).rejects.toMatchObject({ code: 'workspace_changed' });
    const prepared = await f.prepare(commit);
    expect(prepared).toMatchObject({
      commitOid: commit,
      paths: ['readme.md'],
      commit: {
        parent: f.parent,
        tree,
        message: 'Fixture message\n',
        author: { date: '2023-11-15T07:13:20+09:00' },
        committer: { date: '2023-11-14T22:13:30+00:00' },
      },
      objects: [
        {
          oid: blob,
          kind: 'blob',
          contentBase64: Buffer.from('persisted only in Git').toString('base64'),
        },
        { oid: tree, kind: 'tree', entries: [{ name: 'readme.md', mode: '100644', oid: blob }] },
      ],
    });
    expect(Object.isFrozen(prepared)).toBe(true);
    await writeFile(f.pathFor(blob), 'changed');
    expect(prepared.objects[0]).toMatchObject({
      contentBase64: Buffer.from('persisted only in Git').toString('base64'),
    });
    await expect(f.prepare(commit)).rejects.toMatchObject({ code: 'unsupported_history' });
  });

  it('applies the existing protected-path classification and Project denies to each alias', async () => {
    const f = await fixture();
    const missingBlob = 'd'.repeat(40);
    const protectedTree = await f.tree([
      ['a.txt', missingBlob],
      ['z-token.txt', missingBlob],
    ]);
    await expect(f.prepare(await f.commit(protectedTree))).rejects.toMatchObject({
      code: 'protected_path',
    });
    const projectTree = await f.tree([
      ['a.txt', missingBlob],
      ['z-denied.txt', missingBlob],
    ]);
    await mkdir(join(f.root, '.sprint-coder'));
    const settings = join(f.root, '.sprint-coder', 'settings.json');
    await writeFile(
      settings,
      JSON.stringify({ permissions: { allow: ['Read'], deny: ['Read(z-denied.txt)'] } }),
    );
    await expect(f.prepare(await f.commit(projectTree))).rejects.toMatchObject({
      code: 'protected_path',
    });
    await writeFile(settings, 'malformed settings');
    await expect(f.prepare(await f.commit(projectTree))).rejects.toMatchObject({
      code: 'protected_path',
    });
  });

  it('rejects signed or external-object history and changes to rights or Task cancellation', async () => {
    const f = await fixture();
    const blob = await f.object('blob', 'fixture');
    const tree = await f.tree([['file.md', blob]]);
    const commit = await f.commit(tree);
    const signed = await f.commit(tree, 'gpgsig fixture\n continuation\n');
    await expect(f.prepare(signed)).rejects.toMatchObject({ code: 'unsupported_history' });
    const pending = f.prepare(commit);
    f.bumpPolicy();
    await expect(pending).rejects.toMatchObject({ code: 'workspace_changed' });
    const controller = new AbortController();
    controller.abort();
    await expect(f.prepare(commit, 'root', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    await link(f.pathFor(blob), join(f.base, 'outside-object'));
    await expect(f.prepare(commit)).rejects.toMatchObject({ code: 'unsupported_history' });
  });

  it('does not follow an object-directory link even if the external object has the expected SHA', async () => {
    const f = await fixture();
    const blob = await f.object('blob', 'fixture');
    const tree = await f.tree([['file.md', blob]]);
    const commit = await f.commit(tree);
    const blobPath = f.pathFor(blob);
    const external = join(f.base, 'external');
    await mkdir(external);
    await link(blobPath, join(external, blob.slice(2)));
    const objectDirectory = dirname(blobPath);
    await rm(blobPath);
    await rmdir(objectDirectory);
    await symlink(external, objectDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(f.prepare(commit)).rejects.toMatchObject({ code: 'unsupported_history' });
  });
});
