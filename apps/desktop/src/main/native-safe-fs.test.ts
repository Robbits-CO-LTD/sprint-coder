import {
  appendFile,
  chmod,
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadNativeSafeFs, nativeSafeFsAddonPath } from './native-safe-fs';
import type {
  NativeSafeFs,
  NativeSafeFsError,
  NativeSafeFsOpenInput,
  NativeSafeFsSession,
} from './native-safe-fs';
import {
  createNativeMutationIntentSeed,
  createNativeMutationIntentSnapshot,
  transitionNativeMutationIntent,
  type NativeMutationEffectObservation,
  type NativeMutationEndpointExpectation,
  type NativeMutationIntentKind,
  type NativeMutationIntentSnapshot,
  type NativeMutationRevision,
} from './native-mutation-intent';

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

type MutationTestBoundary = NativeSafeFs &
  Readonly<{
    observeIntent(
      session: NativeSafeFsSession,
      intent: NativeMutationIntentSnapshot,
    ): Promise<NativeMutationEffectObservation>;
    stageIntentArtifact(
      session: NativeSafeFsSession,
      intent: NativeMutationIntentSnapshot,
      bytes: Buffer,
    ): Promise<NativeMutationRevision>;
    applyIntentEffect(
      session: NativeSafeFsSession,
      intent: NativeMutationIntentSnapshot,
    ): Promise<NativeMutationEffectObservation>;
    cleanupIntentAuxiliary(
      session: NativeSafeFsSession,
      intent: NativeMutationIntentSnapshot,
    ): Promise<Readonly<{ state: 'absent' }>>;
  }>;

function mutationBoundary(boundary: NativeSafeFs): MutationTestBoundary {
  return boundary as MutationTestBoundary;
}

async function revision(path: string): Promise<NativeMutationRevision> {
  const stats = await lstat(path, { bigint: true });
  const bytes = await readFile(path);
  const mode = Number(stats.mode);
  const nlink = Number(stats.nlink);
  const identityDigest = createHash('sha256')
    .update(
      JSON.stringify([
        'native-file-identity-v1',
        stats.dev.toString(),
        stats.ino.toString(),
        mode,
        nlink,
        'file',
      ]),
    )
    .digest('hex');
  return Object.freeze({
    state: 'present',
    identityDigest,
    contentHash: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.byteLength,
    mode,
    nlink: 1,
  });
}

function nativeIntent(input: {
  session: NativeSafeFsSession;
  kind: NativeMutationIntentKind;
  sourceSegments: readonly string[];
  destinationSegments?: readonly string[] | null;
  expectedSource: NativeMutationEndpointExpectation;
  artifactBytes?: Buffer;
}): NativeMutationIntentSnapshot {
  const artifactBytes = input.artifactBytes ?? null;
  const expectedMode =
    input.kind === 'add'
      ? 0o100600
      : input.expectedSource.state === 'present'
        ? input.expectedSource.mode
        : 0o100600;
  return createNativeMutationIntentSnapshot(
    createNativeMutationIntentSeed({
      id: `intent-${input.kind}`,
      sagaId: 'saga-native-safe-fs',
      ordinal: 1,
      direction: 'forward',
      kind: input.kind,
      operationDigest: '1'.repeat(64),
      workspaceKey: input.session.workspaceKey,
      rootIdentityDigest: '2'.repeat(64),
      policyEpoch: 1,
      leaseFence: input.session.fence,
      nativeSessionId: input.session.id,
      sourceSegments: input.sourceSegments,
      destinationSegments: input.destinationSegments ?? null,
      expectedSource: input.expectedSource,
      expectedDestination: { state: 'absent' },
      artifact:
        artifactBytes === null
          ? null
          : {
              artifactId: 'artifact-native-safe-fs',
              contentHash: createHash('sha256').update(artifactBytes).digest('hex'),
              size: artifactBytes.byteLength,
              expectedMode,
            },
      createdAt: '2026-07-23T00:00:00.000Z',
    }),
    'a'.repeat(32),
  );
}

async function stageNativeIntent(
  boundary: MutationTestBoundary,
  session: NativeSafeFsSession,
  intent: NativeMutationIntentSnapshot,
  bytes: Buffer,
): Promise<NativeMutationIntentSnapshot> {
  const pending = transitionNativeMutationIntent(intent, { state: 'aux_pending' });
  const auxObservation = await boundary.stageIntentArtifact(session, pending, bytes);
  return transitionNativeMutationIntent(pending, { state: 'aux_observed', auxObservation });
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

    it('observes source, destination, and journaled auxiliary paths from the pinned root', async () => {
      const input = await fixture();
      await mkdir(join(input.workspace, 'src'));
      await writeFile(join(input.workspace, 'src', 'before.txt'), 'before', { mode: 0o600 });
      const expectedSource = await revision(join(input.workspace, 'src', 'before.txt'));
      const boundary = mutationBoundary(fixtureBoundary(input));
      const session = await boundary.openSession({ ...input, fence: '80' });
      const intent = nativeIntent({
        session,
        kind: 'rename',
        sourceSegments: ['src', 'before.txt'],
        destinationSegments: ['src', 'after.txt'],
        expectedSource,
      });

      await expect(boundary.observeIntent(session, intent)).resolves.toEqual({
        source: expectedSource,
        destination: { state: 'absent' },
        auxiliary: { state: 'absent' },
      });
      await boundary.closeSession(session);
    });

    it('rejects symlink, hardlink, and special-file observations without following them', async () => {
      const input = await fixture();
      await writeFile(join(input.workspace, 'target.txt'), 'target', { mode: 0o600 });
      const expectedSource = await revision(join(input.workspace, 'target.txt'));
      const boundary = mutationBoundary(fixtureBoundary(input));
      const session = await boundary.openSession({ ...input, fence: '81' });
      const unsafeLeaves = ['symlink.txt', 'hardlink.txt', 'fifo'];
      await symlink('target.txt', join(input.workspace, unsafeLeaves[0]!));
      await link(join(input.workspace, 'target.txt'), join(input.workspace, unsafeLeaves[1]!));
      await execFileAsync('mkfifo', [join(input.workspace, unsafeLeaves[2]!)]);

      for (const leaf of unsafeLeaves) {
        const intent = nativeIntent({
          session,
          kind: 'delete',
          sourceSegments: [leaf],
          expectedSource,
        });
        await expect(boundary.observeIntent(session, intent)).rejects.toMatchObject({
          code: 'UNSAFE_PATH',
        } satisfies Partial<NativeSafeFsError>);
      }
      await boundary.closeSession(session);
    });

    it('rejects unsafe segments and forged staged bytes inside the raw addon contract', async () => {
      const input = await fixture();
      const boundary = mutationBoundary(fixtureBoundary(input));
      const session = await boundary.openSession({ ...input, fence: '811' });
      const bytes = Buffer.from('sealed');
      let intent = nativeIntent({
        session,
        kind: 'add',
        sourceSegments: ['new.txt'],
        expectedSource: { state: 'absent' },
        artifactBytes: bytes,
      });
      intent = transitionNativeMutationIntent(intent, { state: 'aux_pending' });
      const raw = require(nativeSafeFsAddonPath()) as Readonly<{
        observeIntent(input: Readonly<Record<string, unknown>>): Promise<unknown>;
        stageIntentArtifact(
          input: Readonly<Record<string, unknown>>,
          bytes: Buffer,
        ): Promise<unknown>;
        applyIntentEffect(input: Readonly<Record<string, unknown>>): Promise<unknown>;
        cleanupIntentAuxiliary(input: Readonly<Record<string, unknown>>): Promise<unknown>;
      }>;
      const journal = {
        sessionId: session.id,
        intentId: intent.id,
        intentDigest: intent.intentDigest,
        recordDigest: intent.recordDigest,
        revision: intent.revision,
      };
      expect(() =>
        raw.observeIntent({
          ...journal,
          sourceSegments: ['..'],
          destinationSegments: null,
          auxiliarySegments: null,
        }),
      ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
      expect(() =>
        raw.observeIntent({
          ...journal,
          revision: 1.5,
          sourceSegments: ['new.txt'],
          destinationSegments: null,
          auxiliarySegments: null,
        }),
      ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
      expect(() =>
        raw.stageIntentArtifact(
          {
            ...journal,
            parentSegments: null,
            leafName: intent.temp!.leafName,
            expectedContentHash: intent.temp!.expectedContentHash,
            expectedSize: intent.temp!.expectedSize,
            expectedMode: intent.temp!.expectedMode,
          },
          bytes,
        ),
      ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
      expect(() =>
        raw.stageIntentArtifact(
          {
            ...journal,
            parentSegments: [],
            leafName: 'not-a-journal-temp',
            expectedContentHash: intent.temp!.expectedContentHash,
            expectedSize: intent.temp!.expectedSize,
            expectedMode: intent.temp!.expectedMode,
          },
          bytes,
        ),
      ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
      expect(() =>
        raw.applyIntentEffect({
          ...journal,
          kind: 'rename',
          sourceSegments: ['new.txt'],
          destinationSegments: null,
          auxiliarySegments: [intent.temp!.leafName],
          expectedSource: { state: 'absent' },
          expectedDestination: { state: 'absent' },
          expectedAuxiliary: { state: 'absent' },
        }),
      ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
      expect(() =>
        raw.cleanupIntentAuxiliary({
          ...journal,
          auxiliarySegments: ['unowned-file.txt'],
          expectedAuxiliary: { state: 'absent' },
        }),
      ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
      await expect(
        raw.stageIntentArtifact(
          {
            ...journal,
            parentSegments: intent.temp!.parentSegments,
            leafName: intent.temp!.leafName,
            expectedContentHash: intent.temp!.expectedContentHash,
            expectedSize: intent.temp!.expectedSize,
            expectedMode: intent.temp!.expectedMode,
          },
          Buffer.from('forged'),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(readFile(join(input.workspace, intent.temp!.leafName))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await boundary.closeSession(session);
    });

    it('rejects a workspace root namespace replacement instead of staging through the stale fd', async () => {
      const input = await fixture();
      const bytes = Buffer.from('must stay inside the selected workspace');
      const boundary = mutationBoundary(fixtureBoundary(input));
      const session = await boundary.openSession({ ...input, fence: '812' });
      let intent = nativeIntent({
        session,
        kind: 'add',
        sourceSegments: ['new.txt'],
        expectedSource: { state: 'absent' },
        artifactBytes: bytes,
      });
      intent = transitionNativeMutationIntent(intent, { state: 'aux_pending' });
      const movedWorkspace = join(input.root, 'moved-workspace');
      await rename(input.workspace, movedWorkspace);
      await mkdir(input.workspace);

      await expect(boundary.stageIntentArtifact(session, intent, bytes)).rejects.toMatchObject({
        code: 'UNSAFE_PATH',
      } satisfies Partial<NativeSafeFsError>);
      await expect(readFile(join(movedWorkspace, intent.temp!.leafName))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(readFile(join(input.workspace, intent.temp!.leafName))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await boundary.closeSession(session);
    });

    it('stages only the sealed journal artifact asynchronously with exact bytes and mode', async () => {
      const input = await fixture();
      await mkdir(join(input.workspace, 'nested'));
      const bytes = Buffer.from('staged post-image\n');
      const boundary = mutationBoundary(fixtureBoundary(input));
      const session = await boundary.openSession({ ...input, fence: '82' });
      let intent = nativeIntent({
        session,
        kind: 'add',
        sourceSegments: ['nested', 'new.txt'],
        expectedSource: { state: 'absent' },
        artifactBytes: bytes,
      });
      intent = transitionNativeMutationIntent(intent, { state: 'aux_pending' });
      let settled = false;
      const staging = boundary.stageIntentArtifact(session, intent, bytes).then((value) => {
        settled = true;
        return value;
      });
      expect(settled).toBe(false);
      const observed = await staging;
      expect(observed).toEqual(
        await revision(join(input.workspace, 'nested', intent.temp!.leafName)),
      );
      expect(observed).toMatchObject({
        contentHash: intent.artifact!.contentHash,
        size: bytes.byteLength,
        mode: 0o100600,
        nlink: 1,
      });
      await expect(
        readFile(join(input.workspace, 'nested', intent.temp!.leafName)),
      ).resolves.toEqual(bytes);
      await boundary.closeSession(session);
    });

    it('applies and cleans a journaled add with kernel no-replace semantics', async () => {
      const input = await fixture();
      const bytes = Buffer.from('added\n');
      const boundary = mutationBoundary(fixtureBoundary(input));
      const session = await boundary.openSession({ ...input, fence: '821' });
      let intent = nativeIntent({
        session,
        kind: 'add',
        sourceSegments: ['added.txt'],
        expectedSource: { state: 'absent' },
        artifactBytes: bytes,
      });
      intent = await stageNativeIntent(boundary, session, intent, bytes);
      intent = transitionNativeMutationIntent(intent, { state: 'effect_pending' });

      const effect = await boundary.applyIntentEffect(session, intent);
      expect(effect).toEqual({
        source: intent.auxObservation,
        destination: { state: 'absent' },
        auxiliary: { state: 'absent' },
      });
      expect(await readFile(join(input.workspace, 'added.txt'))).toEqual(bytes);
      intent = transitionNativeMutationIntent(intent, {
        state: 'effect_observed',
        effectObservation: effect,
      });
      intent = transitionNativeMutationIntent(intent, { state: 'cleanup_pending' });
      await expect(boundary.cleanupIntentAuxiliary(session, intent)).resolves.toEqual({
        state: 'absent',
      });
      await boundary.closeSession(session);
    });

    it('atomically exchanges a journaled update and cleans only the displaced exact inode', async () => {
      const input = await fixture();
      const sourcePath = join(input.workspace, 'updated.txt');
      await writeFile(sourcePath, 'before\n', { mode: 0o640 });
      const expectedSource = await revision(sourcePath);
      const bytes = Buffer.from('after\n');
      const boundary = mutationBoundary(fixtureBoundary(input));
      const session = await boundary.openSession({ ...input, fence: '822' });
      let intent = nativeIntent({
        session,
        kind: 'update',
        sourceSegments: ['updated.txt'],
        expectedSource,
        artifactBytes: bytes,
      });
      intent = await stageNativeIntent(boundary, session, intent, bytes);
      const staged = intent.auxObservation!;
      intent = transitionNativeMutationIntent(intent, { state: 'effect_pending' });

      const effect = await boundary.applyIntentEffect(session, intent);
      expect(effect).toEqual({
        source: staged,
        destination: { state: 'absent' },
        auxiliary: expectedSource,
      });
      expect(await readFile(sourcePath)).toEqual(bytes);
      expect(await readFile(join(input.workspace, intent.temp!.leafName))).toEqual(
        Buffer.from('before\n'),
      );
      intent = transitionNativeMutationIntent(intent, {
        state: 'effect_observed',
        effectObservation: effect,
      });
      intent = transitionNativeMutationIntent(intent, { state: 'cleanup_pending' });
      await expect(boundary.cleanupIntentAuxiliary(session, intent)).resolves.toEqual({
        state: 'absent',
      });
      await expect(readFile(join(input.workspace, intent.temp!.leafName))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(boundary.cleanupIntentAuxiliary(session, intent)).resolves.toEqual({
        state: 'absent',
      });
      await boundary.closeSession(session);
    });

    it('moves a journaled delete to its exact tombstone and cleans it durably', async () => {
      const input = await fixture();
      const sourcePath = join(input.workspace, 'deleted.txt');
      await writeFile(sourcePath, 'delete me\n', { mode: 0o600 });
      const expectedSource = await revision(sourcePath);
      const boundary = mutationBoundary(fixtureBoundary(input));
      const session = await boundary.openSession({ ...input, fence: '823' });
      let intent = nativeIntent({
        session,
        kind: 'delete',
        sourceSegments: ['deleted.txt'],
        expectedSource,
      });
      intent = transitionNativeMutationIntent(intent, { state: 'effect_pending' });

      const effect = await boundary.applyIntentEffect(session, intent);
      expect(effect).toEqual({
        source: { state: 'absent' },
        destination: { state: 'absent' },
        auxiliary: expectedSource,
      });
      await expect(readFile(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(input.workspace, intent.tombstone!.leafName))).toEqual(
        Buffer.from('delete me\n'),
      );
      intent = transitionNativeMutationIntent(intent, {
        state: 'effect_observed',
        effectObservation: effect,
      });
      intent = transitionNativeMutationIntent(intent, { state: 'cleanup_pending' });
      await expect(boundary.cleanupIntentAuxiliary(session, intent)).resolves.toEqual({
        state: 'absent',
      });
      await boundary.closeSession(session);
    });

    it('moves a journaled rename across parents without replacing a destination', async () => {
      const input = await fixture();
      await mkdir(join(input.workspace, 'from'));
      await mkdir(join(input.workspace, 'to'));
      const sourcePath = join(input.workspace, 'from', 'source.txt');
      const destinationPath = join(input.workspace, 'to', 'destination.txt');
      await writeFile(sourcePath, 'rename me\n', { mode: 0o600 });
      const expectedSource = await revision(sourcePath);
      const boundary = mutationBoundary(fixtureBoundary(input));
      const session = await boundary.openSession({ ...input, fence: '824' });
      let intent = nativeIntent({
        session,
        kind: 'rename',
        sourceSegments: ['from', 'source.txt'],
        destinationSegments: ['to', 'destination.txt'],
        expectedSource,
      });
      intent = transitionNativeMutationIntent(intent, { state: 'effect_pending' });

      await expect(boundary.applyIntentEffect(session, intent)).resolves.toEqual({
        source: { state: 'absent' },
        destination: expectedSource,
        auxiliary: { state: 'absent' },
      });
      await expect(readFile(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(destinationPath)).toEqual(Buffer.from('rename me\n'));
      await boundary.closeSession(session);
    });

    it('never replaces an external add target and keeps the staged artifact recoverable', async () => {
      const input = await fixture();
      const bytes = Buffer.from('managed\n');
      const boundary = mutationBoundary(fixtureBoundary(input));
      const session = await boundary.openSession({ ...input, fence: '825' });
      let intent = nativeIntent({
        session,
        kind: 'add',
        sourceSegments: ['collision.txt'],
        expectedSource: { state: 'absent' },
        artifactBytes: bytes,
      });
      intent = await stageNativeIntent(boundary, session, intent, bytes);
      intent = transitionNativeMutationIntent(intent, { state: 'effect_pending' });
      await writeFile(join(input.workspace, 'collision.txt'), 'external\n', { mode: 0o600 });

      await expect(boundary.applyIntentEffect(session, intent)).rejects.toMatchObject({
        code: 'UNSAFE_PATH',
      } satisfies Partial<NativeSafeFsError>);
      await expect(readFile(join(input.workspace, 'collision.txt'), 'utf8')).resolves.toBe(
        'external\n',
      );
      expect(await readFile(join(input.workspace, intent.temp!.leafName))).toEqual(bytes);
      await boundary.closeSession(session);
    });

    it('rejects an externally modified update source and preserves both revisions', async () => {
      const input = await fixture();
      const sourcePath = join(input.workspace, 'modified-before-update.txt');
      await writeFile(sourcePath, 'journal preimage\n', { mode: 0o600 });
      const expectedSource = await revision(sourcePath);
      const bytes = Buffer.from('managed postimage\n');
      const boundary = mutationBoundary(fixtureBoundary(input));
      const session = await boundary.openSession({ ...input, fence: '826' });
      let intent = nativeIntent({
        session,
        kind: 'update',
        sourceSegments: ['modified-before-update.txt'],
        expectedSource,
        artifactBytes: bytes,
      });
      intent = await stageNativeIntent(boundary, session, intent, bytes);
      intent = transitionNativeMutationIntent(intent, { state: 'effect_pending' });
      await writeFile(sourcePath, 'external revision\n', { mode: 0o600 });

      await expect(boundary.applyIntentEffect(session, intent)).rejects.toMatchObject({
        code: 'UNSAFE_PATH',
      } satisfies Partial<NativeSafeFsError>);
      await expect(readFile(sourcePath, 'utf8')).resolves.toBe('external revision\n');
      expect(await readFile(join(input.workspace, intent.temp!.leafName))).toEqual(bytes);
      await boundary.closeSession(session);
    });

    it('rejects a rename destination collision without moving either file', async () => {
      const input = await fixture();
      const sourcePath = join(input.workspace, 'rename-source.txt');
      const destinationPath = join(input.workspace, 'rename-destination.txt');
      await writeFile(sourcePath, 'managed source\n', { mode: 0o600 });
      const expectedSource = await revision(sourcePath);
      const boundary = mutationBoundary(fixtureBoundary(input));
      const session = await boundary.openSession({ ...input, fence: '827' });
      let intent = nativeIntent({
        session,
        kind: 'rename',
        sourceSegments: ['rename-source.txt'],
        destinationSegments: ['rename-destination.txt'],
        expectedSource,
      });
      intent = transitionNativeMutationIntent(intent, { state: 'effect_pending' });
      await writeFile(destinationPath, 'external destination\n', { mode: 0o600 });

      await expect(boundary.applyIntentEffect(session, intent)).rejects.toMatchObject({
        code: 'UNSAFE_PATH',
      } satisfies Partial<NativeSafeFsError>);
      await expect(readFile(sourcePath, 'utf8')).resolves.toBe('managed source\n');
      await expect(readFile(destinationPath, 'utf8')).resolves.toBe('external destination\n');
      await boundary.closeSession(session);
    });

    it('refuses to clean an auxiliary inode whose content changed after the effect', async () => {
      const input = await fixture();
      const sourcePath = join(input.workspace, 'cleanup-content.txt');
      await writeFile(sourcePath, 'preimage\n', { mode: 0o600 });
      const expectedSource = await revision(sourcePath);
      const bytes = Buffer.from('postimage\n');
      const boundary = mutationBoundary(fixtureBoundary(input));
      const session = await boundary.openSession({ ...input, fence: '828' });
      let intent = nativeIntent({
        session,
        kind: 'update',
        sourceSegments: ['cleanup-content.txt'],
        expectedSource,
        artifactBytes: bytes,
      });
      intent = await stageNativeIntent(boundary, session, intent, bytes);
      intent = transitionNativeMutationIntent(intent, { state: 'effect_pending' });
      const effect = await boundary.applyIntentEffect(session, intent);
      intent = transitionNativeMutationIntent(intent, {
        state: 'effect_observed',
        effectObservation: effect,
      });
      intent = transitionNativeMutationIntent(intent, { state: 'cleanup_pending' });
      const auxiliaryPath = join(input.workspace, intent.temp!.leafName);
      await appendFile(auxiliaryPath, 'external mutation\n');

      await expect(boundary.cleanupIntentAuxiliary(session, intent)).rejects.toMatchObject({
        code: 'UNSAFE_PATH',
      } satisfies Partial<NativeSafeFsError>);
      await expect(readFile(auxiliaryPath, 'utf8')).resolves.toBe('preimage\nexternal mutation\n');
      await expect(readFile(sourcePath)).resolves.toEqual(bytes);
      await boundary.closeSession(session);
    });

    it('refuses to clean an auxiliary inode after an external hardlink is added', async () => {
      const input = await fixture();
      const sourcePath = join(input.workspace, 'cleanup-link.txt');
      await writeFile(sourcePath, 'preimage\n', { mode: 0o600 });
      const expectedSource = await revision(sourcePath);
      const bytes = Buffer.from('postimage\n');
      const boundary = mutationBoundary(fixtureBoundary(input));
      const session = await boundary.openSession({ ...input, fence: '829' });
      let intent = nativeIntent({
        session,
        kind: 'update',
        sourceSegments: ['cleanup-link.txt'],
        expectedSource,
        artifactBytes: bytes,
      });
      intent = await stageNativeIntent(boundary, session, intent, bytes);
      intent = transitionNativeMutationIntent(intent, { state: 'effect_pending' });
      const effect = await boundary.applyIntentEffect(session, intent);
      intent = transitionNativeMutationIntent(intent, {
        state: 'effect_observed',
        effectObservation: effect,
      });
      intent = transitionNativeMutationIntent(intent, { state: 'cleanup_pending' });
      const auxiliaryPath = join(input.workspace, intent.temp!.leafName);
      const externalLinkPath = join(input.workspace, 'external-hardlink.txt');
      await link(auxiliaryPath, externalLinkPath);

      await expect(boundary.cleanupIntentAuxiliary(session, intent)).rejects.toMatchObject({
        code: 'UNSAFE_PATH',
      } satisfies Partial<NativeSafeFsError>);
      await expect(readFile(auxiliaryPath, 'utf8')).resolves.toBe('preimage\n');
      await expect(readFile(externalLinkPath, 'utf8')).resolves.toBe('preimage\n');
      await boundary.closeSession(session);
    });

    it('fails closed on a staged-name collision and after synchronous session invalidation', async () => {
      const input = await fixture();
      const bytes = Buffer.from('post-image');
      const boundary = mutationBoundary(fixtureBoundary(input));
      const session = await boundary.openSession({ ...input, fence: '83' });
      let intent = nativeIntent({
        session,
        kind: 'add',
        sourceSegments: ['new.txt'],
        expectedSource: { state: 'absent' },
        artifactBytes: bytes,
      });
      intent = transitionNativeMutationIntent(intent, { state: 'aux_pending' });
      const tempPath = join(input.workspace, intent.temp!.leafName);
      await writeFile(tempPath, 'external', { mode: 0o600 });
      await expect(boundary.stageIntentArtifact(session, intent, bytes)).rejects.toMatchObject({
        code: 'UNSAFE_PATH',
      } satisfies Partial<NativeSafeFsError>);
      await expect(readFile(tempPath, 'utf8')).resolves.toBe('external');

      await rm(tempPath);
      boundary.invalidateWorkspace(input.workspaceKey, '84');
      await expect(boundary.stageIntentArtifact(session, intent, bytes)).rejects.toMatchObject({
        code: 'STALE_SESSION',
      } satisfies Partial<NativeSafeFsError>);
      await expect(readFile(tempPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('never reports staging success after invalidation races a one-megabyte async stage', async () => {
      const input = await fixture();
      const bytes = Buffer.alloc(1024 * 1024, 0x5a);
      const boundary = mutationBoundary(fixtureBoundary(input));
      const session = await boundary.openSession({ ...input, fence: '85' });
      let intent = nativeIntent({
        session,
        kind: 'add',
        sourceSegments: ['large.txt'],
        expectedSource: { state: 'absent' },
        artifactBytes: bytes,
      });
      intent = transitionNativeMutationIntent(intent, { state: 'aux_pending' });
      const staging = boundary.stageIntentArtifact(session, intent, bytes);
      boundary.invalidateWorkspace(input.workspaceKey, '86');
      await expect(staging).rejects.toMatchObject({ code: 'STALE_SESSION' });
      const tempPath = join(input.workspace, intent.temp!.leafName);
      const stagedOrError = await readFile(tempPath).catch((error: unknown) => error);
      if (Buffer.isBuffer(stagedOrError)) expect(stagedOrError).toEqual(bytes);
      else expect(stagedOrError).toMatchObject({ code: 'ENOENT' });
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
