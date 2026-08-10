import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  appendFile,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AttachmentCustodyError, AttachmentCustodyStore } from './attachment-custody-store';
import { runtimeImageManifestDigest } from '../runtime-host/protocol';

const cleanup: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createRoot(): Promise<{ parent: string; root: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'sprint-coder-custody-'));
  cleanup.push(parent);
  return { parent, root: resolve(parent, 'attachment-custody') };
}

function attachment(id: string, mimeType: 'image/png' | 'image/webp', bytes: Buffer) {
  return {
    id,
    mimeType,
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes,
  } as const;
}

describe.skipIf(process.platform === 'win32')('AttachmentCustodyStore', () => {
  it('materializes numbered read-only canonical files and releases only the exact lease', async () => {
    const { root } = await createRoot();
    const store = new AttachmentCustodyStore(root);
    const png = Buffer.from('canonical-png');
    const webp = Buffer.from('canonical-webp');
    const lease = await store.prepare({
      turnId: 'turn-1',
      operationId: 'operation-1',
      attachments: [
        attachment('attachment-2', 'image/webp', webp),
        attachment('attachment-1', 'image/png', png),
      ],
    });

    expect(lease.paths.map((path) => path.split('/').at(-1))).toEqual(['001.webp', '002.png']);
    expect(await readFile(lease.paths[0]!)).toEqual(webp);
    expect(await readFile(lease.paths[1]!)).toEqual(png);
    expect((await stat(lease.paths[0]!)).mode & 0o777).toBe(0o400);
    expect((await stat(dirname(lease.paths[0]!))).mode & 0o777).toBe(0o500);
    expect(lease.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(runtimeImageManifestDigest(lease.manifest)).toBe(lease.manifestDigest);
    expect(
      await store.release({ ...lease, paths: [...lease.paths], manifest: [...lease.manifest] }),
    ).toBe(false);
    expect(await store.release(lease)).toBe(true);
    expect(await store.release(lease)).toBe(true);
    await expect(readFile(lease.paths[0]!)).rejects.toThrow();
  });

  it('shares initialization and reserves duplicate Turn and operation prepares before I/O', async () => {
    const { root } = await createRoot();
    const store = new AttachmentCustodyStore(root);
    const image = attachment('attachment-1', 'image/png', Buffer.from('canonical'));
    const [first, duplicateTurn] = await Promise.allSettled([
      store.prepare({ turnId: 'turn-1', operationId: 'operation-1', attachments: [image] }),
      store.prepare({ turnId: 'turn-1', operationId: 'operation-2', attachments: [image] }),
    ]);
    expect([first.status, duplicateTurn.status].sort()).toEqual(['fulfilled', 'rejected']);
    const lease =
      first.status === 'fulfilled'
        ? first.value
        : duplicateTurn.status === 'fulfilled'
          ? duplicateTurn.value
          : null;
    expect(lease).not.toBeNull();
    if (lease === null) throw new Error('one prepare must succeed');

    await expect(
      store.prepare({ turnId: 'turn-2', operationId: lease.operationId, attachments: [image] }),
    ).rejects.toMatchObject({ reason: 'already_prepared' });
    expect((await readdir(root)).filter((name) => name.startsWith('turn-'))).toHaveLength(1);
    await store.release(lease);

    const [firstOperation, duplicateOperation] = await Promise.allSettled([
      store.prepare({ turnId: 'turn-3', operationId: 'operation-shared', attachments: [image] }),
      store.prepare({ turnId: 'turn-4', operationId: 'operation-shared', attachments: [image] }),
    ]);
    expect([firstOperation.status, duplicateOperation.status].sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const operationLease =
      firstOperation.status === 'fulfilled'
        ? firstOperation.value
        : duplicateOperation.status === 'fulfilled'
          ? duplicateOperation.value
          : null;
    if (operationLease === null) throw new Error('one operation prepare must succeed');
    await store.release(operationLease);
  });

  it('coalesces concurrent cleanup and treats an already missing owned directory as released', async () => {
    const { root } = await createRoot();
    const store = new AttachmentCustodyStore(root);
    const lease = await store.prepare({
      turnId: 'turn-1',
      operationId: 'operation-1',
      attachments: [attachment('attachment-1', 'image/png', Buffer.from('canonical'))],
    });
    expect(await Promise.all([store.release(lease), store.release(lease)])).toEqual([true, true]);

    const missing = await store.prepare({
      turnId: 'turn-2',
      operationId: 'operation-2',
      attachments: [attachment('attachment-2', 'image/png', Buffer.from('second'))],
    });
    const directory = dirname(missing.paths[0]!);
    await chmod(directory, 0o700);
    await rm(directory, { recursive: true });
    expect(await store.release(missing)).toBe(true);
    expect(await store.release(missing)).toBe(true);
    await store.dispose();
  });

  it('keeps a failed release retryable', async () => {
    const { root } = await createRoot();
    let failOnce = true;
    const store = new AttachmentCustodyStore(root, {
      beforeRelease: () => {
        if (!failOnce) return;
        failOnce = false;
        throw new Error('injected cleanup failure');
      },
    });
    const lease = await store.prepare({
      turnId: 'turn-retry',
      operationId: 'operation-retry',
      attachments: [attachment('attachment-retry', 'image/png', Buffer.from('canonical'))],
    });
    await expect(store.release(lease)).rejects.toThrow('injected cleanup failure');
    expect(await stat(dirname(lease.paths[0]!))).toMatchObject({});
    expect(await store.release(lease)).toBe(true);
  });

  it('rejects a mismatched manifest and removes the incomplete directory', async () => {
    const { root } = await createRoot();
    const store = new AttachmentCustodyStore(root);
    const invalid = {
      ...attachment('attachment-1', 'image/png', Buffer.from('canonical')),
      sha256: '0'.repeat(64),
    };
    await expect(
      store.prepare({ turnId: 'turn-1', attachments: [invalid] }),
    ).rejects.toBeInstanceOf(AttachmentCustodyError);
    expect((await readdir(root)).filter((name) => name.startsWith('turn-'))).toEqual([]);
    await store.dispose();
  });

  it('scavenges only a child with this installation nonce and a valid bounded marker', async () => {
    const { root } = await createRoot();
    const first = new AttachmentCustodyStore(root);
    await first.initialize();
    const rootMarker = JSON.parse(
      await readFile(join(root, '.sprint-coder-attachment-custody.json'), 'utf8'),
    ) as { installationNonce: string };
    const validName = `turn-${randomUUID()}`;
    const invalidName = `turn-${randomUUID()}`;
    await mkdir(join(root, validName), { mode: 0o700 });
    await writeFile(
      join(root, validName, '.turn.json'),
      JSON.stringify({
        version: 1,
        installationNonce: rootMarker.installationNonce,
        turnId: 'stale-turn',
        operationId: 'stale-operation',
        manifestDigest: 'a'.repeat(64),
      }),
      { mode: 0o600 },
    );
    await mkdir(join(root, invalidName), { mode: 0o700 });
    await writeFile(join(root, invalidName, '.turn.json'), '{"installationNonce":"foreign"}', {
      mode: 0o600,
    });
    await Promise.all(
      Array.from({ length: 129 }, (_, index) =>
        mkdir(join(root, `unrelated-${String(index).padStart(3, '0')}`), { mode: 0o700 }),
      ),
    );

    const reopened = new AttachmentCustodyStore(root);
    await reopened.initialize();
    expect(await readdir(root)).not.toContain(validName);
    expect(await readdir(root)).toContain(invalidName);
    await reopened.dispose();
  });

  it('rejects a symlinked custody root', async () => {
    const { parent, root } = await createRoot();
    const target = join(parent, 'target');
    await mkdir(target);
    await symlink(target, root);
    await expect(new AttachmentCustodyStore(root).initialize()).rejects.toMatchObject({
      reason: 'unsafe_root',
    });
  });

  it('recovers an empty private root left before its marker was created', async () => {
    const { root } = await createRoot();
    await mkdir(root, { mode: 0o700 });
    const store = new AttachmentCustodyStore(root);
    await store.initialize();
    expect(
      JSON.parse(await readFile(join(root, '.sprint-coder-attachment-custody.json'), 'utf8')),
    ).toMatchObject({ version: 1 });
  });

  it('rejects a marker that grows after validation without an unbounded read', async () => {
    const { root } = await createRoot();
    await new AttachmentCustodyStore(root).initialize();
    let mutated = false;
    const reopened = new AttachmentCustodyStore(root, {
      afterMarkerStat: async () => {
        if (mutated) return;
        mutated = true;
        await appendFile(
          join(root, '.sprint-coder-attachment-custody.json'),
          Buffer.alloc(600, 0x20),
        );
      },
    });
    await expect(reopened.initialize()).rejects.toMatchObject({ reason: 'unsafe_root' });
  });

  it('refuses root and leased-child substitutions instead of deleting replacements', async () => {
    const { parent, root } = await createRoot();
    const movedRoot = join(parent, 'owned-root-moved');
    const replacementSentinel = join(root, 'replacement.txt');
    const preparing = new AttachmentCustodyStore(root, {
      beforePrepareCommit: async () => {
        await rename(root, movedRoot);
        await mkdir(root, { mode: 0o700 });
        await writeFile(replacementSentinel, 'replacement', { mode: 0o600 });
      },
    });
    await expect(
      preparing.prepare({
        turnId: 'turn-root-swap',
        operationId: 'operation-root-swap',
        attachments: [attachment('attachment-1', 'image/png', Buffer.from('canonical'))],
      }),
    ).rejects.toMatchObject({ reason: 'unsafe_root' });
    expect(await readFile(replacementSentinel, 'utf8')).toBe('replacement');

    await rm(root, { recursive: true });
    await rename(movedRoot, root);
    const store = new AttachmentCustodyStore(root);
    const lease = await store.prepare({
      turnId: 'turn-child-swap',
      operationId: 'operation-child-swap',
      attachments: [attachment('attachment-2', 'image/png', Buffer.from('canonical'))],
    });
    const child = dirname(lease.paths[0]!);
    const movedChild = `${child}-moved`;
    await chmod(child, 0o700);
    await rename(child, movedChild);
    await mkdir(child, { mode: 0o700 });
    const childSentinel = join(child, 'replacement.txt');
    await writeFile(childSentinel, 'replacement', { mode: 0o600 });
    await expect(store.release(lease)).rejects.toMatchObject({ reason: 'unsafe_root' });
    expect(await readFile(childSentinel, 'utf8')).toBe('replacement');
    expect(await stat(movedChild)).toMatchObject({});
  });

  it('refuses a stale-child substitution during scavenging', async () => {
    const { root } = await createRoot();
    const first = new AttachmentCustodyStore(root);
    await first.initialize();
    const rootMarker = JSON.parse(
      await readFile(join(root, '.sprint-coder-attachment-custody.json'), 'utf8'),
    ) as { installationNonce: string };
    const staleName = `turn-${randomUUID()}`;
    const stalePath = join(root, staleName);
    const movedPath = `${stalePath}-moved`;
    await mkdir(stalePath, { mode: 0o700 });
    await writeFile(
      join(stalePath, '.turn.json'),
      JSON.stringify({
        version: 1,
        installationNonce: rootMarker.installationNonce,
        turnId: 'stale-turn',
        operationId: 'stale-operation',
        manifestDigest: 'a'.repeat(64),
      }),
      { mode: 0o600 },
    );
    const reopened = new AttachmentCustodyStore(root, {
      beforeScavengeRemove: async () => {
        await rename(stalePath, movedPath);
        await mkdir(stalePath, { mode: 0o700 });
        await writeFile(join(stalePath, 'replacement.txt'), 'replacement', { mode: 0o600 });
      },
    });
    await expect(reopened.initialize()).rejects.toMatchObject({ reason: 'unsafe_root' });
    expect(await readFile(join(stalePath, 'replacement.txt'), 'utf8')).toBe('replacement');
    expect(await stat(movedPath)).toMatchObject({});
  });
});

it.runIf(process.platform === 'win32')(
  'materializes and releases image custody under a private Windows ACL',
  async () => {
    const { root } = await createRoot();
    const store = new AttachmentCustodyStore(root);
    const bytes = Buffer.from('canonical-png');
    const lease = await store.prepare({
      turnId: 'turn-windows',
      attachments: [attachment('attachment-windows', 'image/png', bytes)],
    });

    await expect(readFile(lease.paths[0]!)).resolves.toEqual(bytes);
    await expect(store.release(lease)).resolves.toBe(true);
    await expect(access(lease.paths[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
  },
);
