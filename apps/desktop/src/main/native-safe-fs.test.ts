import {
  appendFile,
  chmod,
  lstat,
  link,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadNativeSafeFs, nativeSafeFsAddonPath } from './native-safe-fs';
import type { NativeSafeFsError, NativeSafeFsOpenInput } from './native-safe-fs';

const cleanup: string[] = [];
const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

async function childOpenOutcome(addonPath: string, input: NativeSafeFsOpenInput): Promise<string> {
  const source = [
    'const addon = require(process.argv[1]);',
    'addon.openSession(JSON.parse(process.argv[2]))',
    "  .then((session) => addon.closeSession(session.id).then(() => process.stdout.write('OPENED')))",
    '  .catch((error) => { process.stdout.write(String(error.code)); process.exitCode = 17; });',
  ].join('\n');
  try {
    const result = await execFileAsync(process.execPath, [
      '-e',
      source,
      addonPath,
      JSON.stringify(input),
    ]);
    return result.stdout;
  } catch (error) {
    return String((error as { stdout?: string }).stdout ?? 'CHILD_FAILED');
  }
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vibe-native-safe-fs-')));
  cleanup.push(root);
  const workspace = join(root, 'workspace');
  const locks = join(root, 'locks');
  await mkdir(workspace);
  await mkdir(locks);
  await chmod(locks, 0o700);
  const stats = await lstat(workspace, { bigint: true });
  return {
    root,
    workspace,
    workspacePath: workspace,
    locks,
    rootDev: stats.dev.toString(),
    rootIno: stats.ino.toString(),
    workspaceKey: randomBytes(32).toString('hex'),
    lockDirectoryPath: locks,
  };
}

function fixtureBoundary(
  input: { lockDirectoryPath: string },
  addonPath = nativeSafeFsAddonPath(),
) {
  return loadNativeSafeFs({ addonPath, lockDirectoryPath: input.lockDirectoryPath });
}

describe('NativeSafeFs authority boundary', () => {
  it('fails closed when the addon cannot be loaded', async () => {
    const boundary = loadNativeSafeFs({
      addonPath: '/definitely/missing/vibe-native-safe-fs.node',
    });
    await expect(boundary.probe()).resolves.toMatchObject({ available: false });
    await expect(
      boundary.openSession({
        workspacePath: '/tmp',
        rootDev: '1',
        rootIno: '1',
        workspaceKey: 'a'.repeat(64),
        lockDirectoryPath: '/tmp',
        fence: '1',
      }),
    ).rejects.toMatchObject({ code: 'ADDON_UNAVAILABLE' } satisfies Partial<NativeSafeFsError>);
  });

  it('fails closed for malformed or corrupt addon artifacts', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'vibe-native-safe-fs-addon-')));
    cleanup.push(root);
    const malformed = join(root, 'malformed.cjs');
    const corrupt = join(root, 'corrupt.node');
    await writeFile(
      malformed,
      [
        'module.exports = {',
        '  probe() { return { available: true }; },',
        '  openSession() { return Promise.resolve({}); },',
        '  invalidateWorkspace() {},',
        '  closeSession() { return Promise.resolve(); },',
        '};',
      ].join('\n'),
    );
    await writeFile(corrupt, 'not a native addon');
    await expect(loadNativeSafeFs({ addonPath: malformed }).probe()).resolves.toMatchObject({
      available: false,
    });
    await expect(
      loadNativeSafeFs({ addonPath: malformed }).openSession({
        workspacePath: '/tmp',
        rootDev: '1',
        rootIno: '1',
        workspaceKey: 'b'.repeat(64),
        lockDirectoryPath: '/tmp',
        fence: '1',
      }),
    ).rejects.toMatchObject({ code: 'ADDON_UNAVAILABLE' });
    await expect(loadNativeSafeFs({ addonPath: corrupt }).probe()).resolves.toMatchObject({
      available: false,
    });
  });

  it.runIf(process.platform === 'win32')('keeps the Windows stub fail-closed', async () => {
    const boundary = loadNativeSafeFs({ addonPath: nativeSafeFsAddonPath() });
    await expect(boundary.probe()).resolves.toMatchObject({ available: false });
  });

  describe.skipIf(process.platform === 'win32')('POSIX backend', () => {
    it('loads a N-API capability probe without exposing mutation primitives', async () => {
      const boundary = loadNativeSafeFs({ addonPath: nativeSafeFsAddonPath() });
      await expect(boundary.probe()).resolves.toMatchObject({
        available: true,
        apiVersion: 1,
        platform: process.platform,
        capabilities: {
          rootSession: true,
          workspaceLock: true,
          durableFence: true,
          synchronousInvalidation: true,
          mutation: false,
        },
      });
    });

    it('pins the exact workspace root and monotonically fences later sessions', async () => {
      const input = await fixture();
      const boundary = fixtureBoundary(input);
      const first = await boundary.openSession({ ...input, fence: '7' });
      expect(first).toMatchObject({ workspaceKey: input.workspaceKey, fence: '7' });
      await expect(boundary.openSession({ ...input, fence: '8' })).rejects.toMatchObject({
        code: 'LOCK_BUSY',
      } satisfies Partial<NativeSafeFsError>);
      await boundary.closeSession(first);
      await expect(boundary.openSession({ ...input, fence: '7' })).rejects.toMatchObject({
        code: 'STALE_FENCE',
      } satisfies Partial<NativeSafeFsError>);
      const second = await boundary.openSession({ ...input, fence: '8' });
      await boundary.closeSession(second);
    });

    it('invalidates the JavaScript session authority synchronously with the native fence', async () => {
      const input = await fixture();
      const boundary = fixtureBoundary(input);
      const session = await boundary.openSession({ ...input, fence: '10' });
      boundary.assertSession(session);
      boundary.invalidateWorkspace(input.workspaceKey, '11');
      expect(() => boundary.assertSession(session)).toThrow(
        expect.objectContaining({ code: 'STALE_SESSION' }),
      );
      await expect(boundary.closeSession(session)).rejects.toMatchObject({ code: 'STALE_SESSION' });
    });

    it('queues root acquisition off the JavaScript call stack', async () => {
      const input = await fixture();
      const boundary = fixtureBoundary(input);
      let settled = false;
      const opening = boundary.openSession({ ...input, fence: '5' }).then((session) => {
        settled = true;
        return session;
      });
      expect(settled).toBe(false);
      const session = await opening;
      await boundary.closeSession(session);
    });

    it('rejects a lock directory that was not bound when the boundary loaded', async () => {
      const input = await fixture();
      const otherLocks = join(input.root, 'other-locks');
      await mkdir(otherLocks, { mode: 0o700 });
      const boundary = fixtureBoundary(input);
      await expect(
        boundary.openSession({ ...input, lockDirectoryPath: otherLocks, fence: '6' }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });

    it('rejects root identity substitution and a symlink-selected root', async () => {
      const input = await fixture();
      const boundary = fixtureBoundary(input);
      await expect(
        boundary.openSession({ ...input, rootIno: '1', fence: '1' }),
      ).rejects.toMatchObject({
        code: 'ROOT_IDENTITY_CHANGED',
      } satisfies Partial<NativeSafeFsError>);
      const alias = join(input.root, 'workspace-alias');
      await symlink(input.workspace, alias);
      await expect(
        boundary.openSession({ ...input, workspacePath: alias, fence: '2' }),
      ).rejects.toMatchObject({ code: 'UNSAFE_PATH' } satisfies Partial<NativeSafeFsError>);
    });

    it('rejects symlink and hardlink substitution of the OS lock file', async () => {
      const input = await fixture();
      const boundary = fixtureBoundary(input);
      const target = join(input.locks, 'target');
      await writeFile(target, 'lock');
      const lockPath = join(input.lockDirectoryPath, `${input.workspaceKey}.lock`);
      await symlink(target, lockPath);
      await expect(boundary.openSession({ ...input, fence: '1' })).rejects.toMatchObject({
        code: 'UNSAFE_LOCK',
      } satisfies Partial<NativeSafeFsError>);
      await rm(lockPath);
      await link(target, lockPath);
      await expect(boundary.openSession({ ...input, fence: '2' })).rejects.toMatchObject({
        code: 'UNSAFE_LOCK',
      } satisfies Partial<NativeSafeFsError>);
    });

    it('rejects a forged or already-closed session token', async () => {
      const input = await fixture();
      const boundary = fixtureBoundary(input);
      const session = await boundary.openSession({ ...input, fence: '1' });
      expect(() => boundary.assertSession(session)).not.toThrow();
      expect(() => boundary.assertSession({ ...session, fence: '2' })).toThrow(
        expect.objectContaining({ code: 'STALE_SESSION' }),
      );
      await boundary.closeSession(session);
      expect(() => boundary.assertSession(session)).toThrow(
        expect.objectContaining({ code: 'STALE_SESSION' }),
      );
      await expect(boundary.closeSession(session)).rejects.toMatchObject({
        code: 'STALE_SESSION',
      } satisfies Partial<NativeSafeFsError>);
      await expect(
        boundary.closeSession({ ...session, id: 'forged-session-id' }),
      ).rejects.toMatchObject({ code: 'STALE_SESSION' } satisfies Partial<NativeSafeFsError>);
    });

    it('synchronously invalidates an active session and advances its fence', async () => {
      const input = await fixture();
      const boundary = fixtureBoundary(input);
      const session = await boundary.openSession({ ...input, fence: '10' });
      boundary.invalidateWorkspace(input.workspaceKey, '11');
      await expect(boundary.closeSession(session)).rejects.toMatchObject({
        code: 'STALE_SESSION',
      } satisfies Partial<NativeSafeFsError>);
      await expect(boundary.openSession({ ...input, fence: '11' })).rejects.toMatchObject({
        code: 'STALE_FENCE',
      } satisfies Partial<NativeSafeFsError>);
      const next = await boundary.openSession({ ...input, fence: '12' });
      await boundary.closeSession(next);
    });

    it('never rolls a durable fence backward on a lower invalidation', async () => {
      const input = await fixture();
      const addonPath = nativeSafeFsAddonPath();
      const boundary = fixtureBoundary(input, addonPath);
      const session = await boundary.openSession({ ...input, fence: '40' });
      boundary.invalidateWorkspace(input.workspaceKey, '5');
      expect(() => boundary.assertSession(session)).toThrow(
        expect.objectContaining({ code: 'STALE_SESSION' }),
      );
      await expect(boundary.closeSession(session)).rejects.toMatchObject({ code: 'STALE_SESSION' });
      await expect(childOpenOutcome(addonPath, { ...input, fence: '40' })).resolves.toBe(
        'STALE_FENCE',
      );
      await expect(childOpenOutcome(addonPath, { ...input, fence: '41' })).resolves.toBe('OPENED');
    });

    it('invalidates an opening session at the same fence', async () => {
      const input = await fixture();
      const addonPath = nativeSafeFsAddonPath();
      const boundary = fixtureBoundary(input, addonPath);
      const opening = boundary.openSession({ ...input, fence: '70' });
      boundary.invalidateWorkspace(input.workspaceKey, '70');
      await expect(opening).rejects.toMatchObject({ code: 'STALE_FENCE' });
      await expect(childOpenOutcome(addonPath, { ...input, fence: '70' })).resolves.toBe(
        'STALE_FENCE',
      );
      await expect(childOpenOutcome(addonPath, { ...input, fence: '71' })).resolves.toBe('OPENED');
    });

    it('excludes a second process while the workspace lock is held', async () => {
      const input = await fixture();
      const addonPath = nativeSafeFsAddonPath();
      const boundary = fixtureBoundary(input, addonPath);
      const session = await boundary.openSession({ ...input, fence: '20' });
      await expect(childOpenOutcome(addonPath, { ...input, fence: '21' })).resolves.toBe(
        'LOCK_BUSY',
      );
      await boundary.closeSession(session);
    });

    it('keeps exclusion when the durable lock leaf is unlinked and recreated', async () => {
      const input = await fixture();
      const addonPath = nativeSafeFsAddonPath();
      const boundary = fixtureBoundary(input, addonPath);
      const session = await boundary.openSession({ ...input, fence: '50' });
      const lockPath = join(input.lockDirectoryPath, `${input.workspaceKey}.lock`);
      await rm(lockPath);
      await writeFile(lockPath, '', { mode: 0o600 });
      await expect(childOpenOutcome(addonPath, { ...input, fence: '51' })).resolves.toBe(
        'LOCK_BUSY',
      );
      await boundary.closeSession(session);
    });

    it('rejects a durable fence from a fresh process after release', async () => {
      const input = await fixture();
      const addonPath = nativeSafeFsAddonPath();
      const boundary = fixtureBoundary(input, addonPath);
      const session = await boundary.openSession({ ...input, fence: '30' });
      await boundary.closeSession(session);
      await expect(childOpenOutcome(addonPath, { ...input, fence: '30' })).resolves.toBe(
        'STALE_FENCE',
      );
      await expect(childOpenOutcome(addonPath, { ...input, fence: '31' })).resolves.toBe('OPENED');
    });

    it('recovers the last checksummed fence after a partial append', async () => {
      const input = await fixture();
      const addonPath = nativeSafeFsAddonPath();
      const boundary = fixtureBoundary(input, addonPath);
      const session = await boundary.openSession({ ...input, fence: '60' });
      await boundary.closeSession(session);
      const lockPath = join(input.lockDirectoryPath, `${input.workspaceKey}.lock`);
      await appendFile(lockPath, 'v1 partial-record-without-newline');
      await expect(childOpenOutcome(addonPath, { ...input, fence: '60' })).resolves.toBe(
        'STALE_FENCE',
      );
      await expect(childOpenOutcome(addonPath, { ...input, fence: '61' })).resolves.toBe('OPENED');
    });

    it('loads the addon in the Electron runtime ABI', async () => {
      const electronExecutable = require('electron') as string;
      const source = [
        'const addon = require(process.argv[1]);',
        'process.stdout.write(JSON.stringify(addon.probe()));',
      ].join('\n');
      const result = await execFileAsync(
        electronExecutable,
        ['-e', source, nativeSafeFsAddonPath()],
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        },
      );
      expect(JSON.parse(result.stdout)).toMatchObject({ available: true, apiVersion: 1 });
    });
  });
});
