import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileRevisionRegistry,
  fileRevisionIdentityDigest,
  readRevisionBoundFile,
  revalidateFileRevisionToken,
} from './file-revision';
import type { FileRevisionError } from './file-revision';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sprint-coder-file-revision-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  await mkdir(join(workspace, 'src'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(workspace, 'src', 'file.ts'), 'export const value = 1;\n');
  await writeFile(join(outside, 'secret.txt'), 'secret');
  return { workspace, outside, target: join(workspace, 'src', 'file.ts') };
}

describe('FileRevisionToken', () => {
  it('keeps 64-bit device and inode identities as exact decimal strings', () => {
    const identity = {
      dev: '9007199254740993',
      ino: '18446744073709551615',
      mode: 0o100600,
      size: 1,
      mtimeMs: 1,
      ctimeMs: 1,
      birthtimeMs: 1,
      nlink: 1,
      kind: 'file' as const,
    };
    expect(fileRevisionIdentityDigest(identity)).not.toBe(
      fileRevisionIdentityDigest({ ...identity, dev: '9007199254740992' }),
    );
  });

  it('reads a regular UTF-8 file through an exact handle and seals its revision facts', async () => {
    const { workspace } = await fixture();
    const result = await readRevisionBoundFile({
      workspacePath: workspace,
      targetPath: 'src/file.ts',
      policyEpoch: 3,
    });

    expect(result.content).toBe('export const value = 1;\n');
    expect(result.token).toMatchObject({
      version: 1,
      size: 24,
      policyEpoch: 3,
      identity: { kind: 'file', nlink: 1 },
    });
    expect(result.token.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.token.identityDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(result.token)).toBe(true);
    await expect(
      revalidateFileRevisionToken({
        token: result.token,
        workspacePath: workspace,
        targetPath: 'src/file.ts',
        policyEpoch: 3,
      }),
    ).resolves.toEqual(result.token);
  });

  it('rejects same-inode content drift and path replacement', async () => {
    const { workspace, target } = await fixture();
    const read = await readRevisionBoundFile({
      workspacePath: workspace,
      targetPath: 'src/file.ts',
      policyEpoch: 0,
    });
    await writeFile(target, 'export const value = 2;\n');
    await expect(
      revalidateFileRevisionToken({
        token: read.token,
        workspacePath: workspace,
        targetPath: 'src/file.ts',
        policyEpoch: 0,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' } satisfies Partial<FileRevisionError>);

    const fresh = await readRevisionBoundFile({
      workspacePath: workspace,
      targetPath: 'src/file.ts',
      policyEpoch: 0,
    });
    await rename(target, `${target}.old`);
    await writeFile(target, 'export const value = 2;\n');
    await expect(
      revalidateFileRevisionToken({
        token: fresh.token,
        workspacePath: workspace,
        targetPath: 'src/file.ts',
        policyEpoch: 0,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' } satisfies Partial<FileRevisionError>);
  });

  it('rejects forged tokens, changed policy epochs, and target rebinding', async () => {
    const { workspace } = await fixture();
    await writeFile(join(workspace, 'src', 'other.ts'), 'export {};\n');
    const read = await readRevisionBoundFile({
      workspacePath: workspace,
      targetPath: 'src/file.ts',
      policyEpoch: 4,
    });
    await expect(
      revalidateFileRevisionToken({
        token: { ...read.token },
        workspacePath: workspace,
        targetPath: 'src/file.ts',
        policyEpoch: 4,
      }),
    ).rejects.toMatchObject({ code: 'FORGED_TOKEN' } satisfies Partial<FileRevisionError>);
    await expect(
      revalidateFileRevisionToken({
        token: read.token,
        workspacePath: workspace,
        targetPath: 'src/file.ts',
        policyEpoch: 5,
      }),
    ).rejects.toMatchObject({ code: 'POLICY_EPOCH_CHANGED' } satisfies Partial<FileRevisionError>);
    await expect(
      revalidateFileRevisionToken({
        token: read.token,
        workspacePath: workspace,
        targetPath: 'src/other.ts',
        policyEpoch: 4,
      }),
    ).rejects.toMatchObject({ code: 'TARGET_CHANGED' } satisfies Partial<FileRevisionError>);
  });

  it('rejects escaping symlinks, invalid UTF-8, NUL content, and oversized files', async () => {
    const { workspace, outside } = await fixture();
    await symlink(outside, join(workspace, 'escape'));
    await expect(
      readRevisionBoundFile({
        workspacePath: workspace,
        targetPath: 'escape/secret.txt',
        policyEpoch: 0,
      }),
    ).rejects.toBeDefined();

    await writeFile(join(workspace, 'src', 'binary'), Buffer.from([0xff, 0xfe, 0x00]));
    await expect(
      readRevisionBoundFile({
        workspacePath: workspace,
        targetPath: 'src/binary',
        policyEpoch: 0,
      }),
    ).rejects.toMatchObject({ code: 'NON_TEXT_FILE' } satisfies Partial<FileRevisionError>);

    await writeFile(join(workspace, 'src', 'nul.txt'), 'before\0after');
    await expect(
      readRevisionBoundFile({
        workspacePath: workspace,
        targetPath: 'src/nul.txt',
        policyEpoch: 0,
      }),
    ).rejects.toMatchObject({ code: 'NON_TEXT_FILE' } satisfies Partial<FileRevisionError>);

    await writeFile(join(workspace, 'src', 'large.txt'), 'x'.repeat(33));
    await expect(
      readRevisionBoundFile({
        workspacePath: workspace,
        targetPath: 'src/large.txt',
        policyEpoch: 0,
        maxBytes: 32,
      }),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' } satisfies Partial<FileRevisionError>);
  });

  it('exposes only opaque references and binds them to one Task and Turn', async () => {
    const { workspace } = await fixture();
    const registry = new FileRevisionRegistry();
    const read = await registry.read({
      owner: { taskId: 'task-1', turnId: 'turn-1' },
      workspacePath: workspace,
      targetPath: 'src/file.ts',
      policyEpoch: 2,
    });

    expect(read.reference).toEqual({ version: 1, tokenId: expect.any(String) });
    expect(JSON.stringify(read.reference)).not.toContain(workspace);
    await expect(
      registry.resolve({
        owner: { taskId: 'task-1', turnId: 'turn-1' },
        reference: read.reference,
        workspacePath: workspace,
        targetPath: 'src/file.ts',
        policyEpoch: 2,
      }),
    ).resolves.toMatchObject({ content: 'export const value = 1;\n' });
    await expect(
      registry.resolve({
        owner: { taskId: 'task-1', turnId: 'turn-2' },
        reference: read.reference,
        workspacePath: workspace,
        targetPath: 'src/file.ts',
        policyEpoch: 2,
      }),
    ).rejects.toMatchObject({ code: 'TOKEN_SCOPE_MISMATCH' } satisfies Partial<FileRevisionError>);
    await expect(
      registry.resolve({
        owner: { taskId: 'task-1', turnId: 'turn-1' },
        reference: { version: 1, tokenId: 'forged' },
        workspacePath: workspace,
        targetPath: 'src/file.ts',
        policyEpoch: 2,
      }),
    ).rejects.toMatchObject({ code: 'FORGED_TOKEN' } satisfies Partial<FileRevisionError>);

    expect(registry.finishTurn({ taskId: 'task-1', turnId: 'turn-1' })).toBe(1);
    await expect(
      registry.resolve({
        owner: { taskId: 'task-1', turnId: 'turn-1' },
        reference: read.reference,
        workspacePath: workspace,
        targetPath: 'src/file.ts',
        policyEpoch: 2,
      }),
    ).rejects.toMatchObject({ code: 'FORGED_TOKEN' } satisfies Partial<FileRevisionError>);
  });
});
