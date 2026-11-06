import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  lstatSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { nativeSafeFsAddonPath } from './native-safe-fs';
import { persistentProjectFolderIdentity, projectFolderIdentity } from './project-folder-identity';

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'darwin')('APFS Project folder identity', () => {
  function fixture() {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'sc-project-identity-')));
    directories.push(parent);
    const root = join(parent, 'root');
    mkdirSync(root);
    return { parent, root };
  }

  it('reads a durable witness through the native opened directory and preserves runtime seals', async () => {
    const { root } = fixture();
    const first = await projectFolderIdentity(root);
    expect(first.persistentIdentityDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(await projectFolderIdentity(root)).toEqual(first);
    expect(first.persistentIdentityDigest).not.toBe(first.rootIdentityDigest);
    expect(persistentProjectFolderIdentity(root, '0'.repeat(64))).toBeNull();
  });

  it('refuses a stale dev/ino at the native boundary', () => {
    const { root } = fixture();
    const identity = lstatSync(root, { bigint: true });
    const require = createRequire(import.meta.url);
    const addon = require(nativeSafeFsAddonPath());
    expect(() =>
      addon.directoryPersistentIdentity({
        path: root,
        dev: String(identity.dev + 1n),
        ino: String(identity.ino),
      }),
    ).toThrow();
  });

  it('distinguishes a replacement directory and refuses symlink witnesses', async () => {
    const { parent, root } = fixture();
    const before = await projectFolderIdentity(root);
    renameSync(root, join(parent, 'original'));
    mkdirSync(root);
    expect((await projectFolderIdentity(root)).persistentIdentityDigest).not.toBe(
      before.persistentIdentityDigest,
    );
    const alias = join(parent, 'alias');
    symlinkSync(root, alias);
    expect(persistentProjectFolderIdentity(alias)).toBeNull();
    expect(persistentProjectFolderIdentity(join(parent, 'missing'))).toBeNull();
  });
});
