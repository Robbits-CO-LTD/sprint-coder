// Slice 4.7f: full-stack integration between the real SQLite persistence client, the
// real NativeSafeFs addon, the real NativeSafeFsEditEffectBoundary, and the real
// EditSagaExecutor. Unlike edit-saga.test.ts / native-safe-fs-edit-boundary.test.ts
// (in-memory fakes) and native-safe-fs.test.ts (addon only), this file drives edits
// through every real layer at once and asserts on the real filesystem and the real
// on-disk SQLite journal.
//
// better-sqlite3 in this repo is built against Electron's Node ABI, so (mirroring
// persistence.test.ts) this file re-spawns itself once under the bundled Electron
// binary with ELECTRON_RUN_AS_NODE=1 unless it is already running that way.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { electronTestExecutablePath } from './electron-test-runtime';
import { loadNativeSafeFs, nativeSafeFsAddonPath } from './native-safe-fs';
import type { NativeSafeFs, NativeSafeFsSession } from './native-safe-fs';
import { NativeSafeFsEditEffectBoundary } from './native-safe-fs-edit-boundary';
import {
  EditSagaCrashError,
  EditSagaExecutor,
  PersistenceEditSagaStore,
  type EditSagaApplyRequest,
  type EditSagaFaultInjector,
} from './edit-saga';
import { EditArtifactStore } from './edit-artifact-store';
import { SqlitePersistenceClient, SqliteEditSagaLeaseGuard } from './persistence';
import { ProviderWorkspaceTools } from './provider-workspace-tools';
import { FileRevisionRegistry } from './file-revision';
import { executeWorkspaceCreateDirectory, type WorkspacePatchDeps } from './workspace-patch-tool';
import {
  structuredPatchDigest,
  type PreparedFileRevision,
  type PreparedPatchOperation,
  type PreparedStructuredPatch,
} from './structured-patch';
import { MutationLeaseStaleError, type MutationLeaseToken } from './mutation-lease';
import { workspaceMutationBinding } from './path-guard';

const runsWithElectronAbi = process.env.SPRINT_CODER_ELECTRON_DB_TEST === '1';
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// Mirrors native-safe-fs.test.ts's `revision()` helper exactly: the identity/content
// hash the real addon independently derives from the file on disk. Any test-side
// preRevision must be computed the same way or the real addon will fail closed.
async function fileRevision(path: string): Promise<PreparedFileRevision> {
  const stats = await lstat(path, { bigint: true });
  const bytes = await readFile(path);
  const mode = Number(stats.mode);
  return Object.freeze({
    identityDigest: hash(
      JSON.stringify([
        'native-file-identity-v1',
        stats.dev.toString(),
        stats.ino.toString(),
        mode,
        Number(stats.nlink),
        'file',
      ]),
    ),
    contentHash: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.byteLength,
    mode,
    nlink: 1 as const,
  });
}

async function fixture(prefix: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), `sprint-coder-edit-saga-native-${prefix}-`)),
  );
  cleanup.push(root);
  const workspace = join(root, 'workspace');
  const locks = join(root, 'locks');
  const dbDir = join(root, 'db');
  const artifactRoot = join(root, 'edit-artifacts');
  await mkdir(workspace, { recursive: true });
  await mkdir(locks, { recursive: true });
  await chmod(locks, 0o700);
  await mkdir(dbDir, { recursive: true });
  const stats = await lstat(workspace, { bigint: true });
  return {
    workspace,
    locks,
    dbPath: join(dbDir, 'test.sqlite3'),
    artifactRoot,
    rootDev: stats.dev.toString(),
    rootIno: stats.ino.toString(),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

// Accepts any well-formed session binding the real addon issued. Production supplies
// a callback that checks the session against an external authority; here the real
// addon's own session bookkeeping is the authority being exercised.
function verifyRealNativeSession(binding: {
  id: string;
  workspaceKey: string;
  fence: string;
}): void {
  if (
    !/^[a-f0-9]{32}$/.test(binding.id) ||
    !/^[a-f0-9]{64}$/.test(binding.workspaceKey) ||
    !/^[1-9][0-9]*$/.test(binding.fence)
  )
    throw new MutationLeaseStaleError();
}

// Caches one real native session per lease fence so every boundary call for the same
// lease reuses the same session, matching how a real long-lived process would resolve
// sessions. A brand-new resolveSession (fresh cache) models a fresh process restart.
function makeResolveSession(native: NativeSafeFs, env: Fixture) {
  const sessions = new Map<number, NativeSafeFsSession>();
  const pending = new Map<number, Promise<NativeSafeFsSession>>();
  const resolveSession = async (token: MutationLeaseToken): Promise<NativeSafeFsSession> => {
    const cached = sessions.get(token.fence);
    if (cached !== undefined) return cached;
    let inFlight = pending.get(token.fence);
    if (inFlight === undefined) {
      inFlight = native.openSession({
        rootId: token.rootId ?? 'legacy-primary',
        workspacePath: env.workspace,
        rootDev: env.rootDev,
        rootIno: env.rootIno,
        workspaceKey: token.workspaceKey,
        lockDirectoryPath: env.locks,
        fence: String(token.fence),
      });
      pending.set(token.fence, inFlight);
    }
    const session = await inFlight;
    sessions.set(token.fence, session);
    return session;
  };
  return { resolveSession, sessions };
}

type FullPatchPaths = {
  addPath: string;
  updatePath: string;
  renameSrcPath: string;
  renameDstPath: string;
  deletePath: string;
};

// One structured patch exercising all four operation kinds in a single Edit Saga,
// against real pre-existing files whose preRevision matches the real filesystem.
async function buildFullPatch(
  workspace: string,
): Promise<{ plan: PreparedStructuredPatch; paths: FullPatchPaths }> {
  const paths: FullPatchPaths = {
    addPath: join(workspace, 'added.txt'),
    updatePath: join(workspace, 'updated.txt'),
    renameSrcPath: join(workspace, 'rename-src.txt'),
    renameDstPath: join(workspace, 'rename-dst.txt'),
    deletePath: join(workspace, 'delete-me.txt'),
  };
  await writeFile(paths.updatePath, 'UPDATE_BEFORE', { mode: 0o600 });
  await writeFile(paths.renameSrcPath, 'RENAME_CONTENT', { mode: 0o600 });
  await writeFile(paths.deletePath, 'DELETE_CONTENT', { mode: 0o600 });

  const updateRevision = await fileRevision(paths.updatePath);
  const renameRevision = await fileRevision(paths.renameSrcPath);
  const deleteRevision = await fileRevision(paths.deletePath);

  const operations: readonly PreparedPatchOperation[] = Object.freeze([
    Object.freeze({
      kind: 'add' as const,
      path: 'added.txt',
      canonicalPath: paths.addPath,
      destination: null,
      canonicalDestination: null,
      revisionTokenId: null,
      preRevision: null,
      preImage: null,
      postImage: 'ADD_CONTENT',
      preHash: null,
      postHash: hash('ADD_CONTENT'),
    }),
    Object.freeze({
      kind: 'update' as const,
      path: 'updated.txt',
      canonicalPath: paths.updatePath,
      destination: null,
      canonicalDestination: null,
      revisionTokenId: 'token-update',
      preRevision: updateRevision,
      preImage: 'UPDATE_BEFORE',
      postImage: 'UPDATE_AFTER',
      preHash: hash('UPDATE_BEFORE'),
      postHash: hash('UPDATE_AFTER'),
    }),
    Object.freeze({
      kind: 'rename' as const,
      path: 'rename-src.txt',
      canonicalPath: paths.renameSrcPath,
      destination: 'rename-dst.txt',
      canonicalDestination: paths.renameDstPath,
      revisionTokenId: 'token-rename',
      preRevision: renameRevision,
      preImage: 'RENAME_CONTENT',
      postImage: 'RENAME_CONTENT',
      preHash: hash('RENAME_CONTENT'),
      postHash: hash('RENAME_CONTENT'),
    }),
    Object.freeze({
      kind: 'delete' as const,
      path: 'delete-me.txt',
      canonicalPath: paths.deletePath,
      destination: null,
      canonicalDestination: null,
      revisionTokenId: 'token-delete',
      preRevision: deleteRevision,
      preImage: 'DELETE_CONTENT',
      postImage: null,
      preHash: hash('DELETE_CONTENT'),
      postHash: null,
    }),
  ]);
  const facts = { version: 1 as const, policyEpoch: 0, operations };
  const plan: PreparedStructuredPatch = Object.freeze({
    ...facts,
    digest: structuredPatchDigest(facts),
  });
  return { plan, paths };
}

async function preparePersistence(env: Fixture) {
  const persistence = new SqlitePersistenceClient(env.dbPath, verifyRealNativeSession);
  const task = persistence.createTask();
  const { rootIdentityDigest, workspaceKey } = await workspaceMutationBinding(env.workspace);
  persistence.setWorkspaceBinding(task.id, {
    path: env.workspace,
    workspaceKey,
    rootIdentityDigest,
  });
  const turn = persistence.startTurn(task.id, 'edit saga native integration');
  const workspace = persistence.sealTurnWorkspaceSet(task.id, turn.turnId);
  return { persistence, task, turn, workspace, workspaceKey, rootIdentityDigest };
}

function buildRequest(input: {
  id: string;
  taskId: string;
  turnId: string;
  operationId: string;
  plan: PreparedStructuredPatch;
  workspaceKey: string;
  rootIdentityDigest: string;
}): EditSagaApplyRequest {
  return Object.freeze({
    id: input.id,
    taskId: input.taskId,
    turnId: input.turnId,
    operationId: input.operationId,
    plan: input.plan,
    mutationBinding: {
      workspaceKey: input.workspaceKey,
      rootIdentityDigest: input.rootIdentityDigest,
    },
    createdAt: '2026-07-23T00:00:00.000Z',
  });
}

async function expectMissing(path: string): Promise<void> {
  await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
}

if (runsWithElectronAbi) {
  describe.skipIf(process.platform === 'win32')('EditSagaExecutor native integration', () => {
    it('runs the Provider create_directory call through the durable Saga to a terminal intent', async () => {
      const env = await fixture('mkdir');
      const native = loadNativeSafeFs({
        addonPath: nativeSafeFsAddonPath(),
        lockDirectoryPath: env.locks,
      });
      const { resolveSession, sessions } = makeResolveSession(native, env);
      const directoryPath = join(env.workspace, 'provider-directory');
      const { persistence, task, turn, workspace, rootIdentityDigest } =
        await preparePersistence(env);
      const artifacts = await EditArtifactStore.open({
        rootPath: env.artifactRoot,
        quotaBytes: 4096,
      });
      const executor = new EditSagaExecutor(
        new PersistenceEditSagaStore(persistence),
        new NativeSafeFsEditEffectBoundary({
          native,
          journal: persistence,
          artifacts,
          resolveSession,
        }),
        artifacts,
        undefined,
        new SqliteEditSagaLeaseGuard(persistence, 'mkdir-instance'),
      );
      const rootId = workspace.primaryRootId ?? 'legacy-primary';
      const ids = ['saga-mkdir', 'op-mkdir'][Symbol.iterator]();
      const workspaceEdit: WorkspacePatchDeps = {
        turnWorkspaceSetFor: () => workspace,
        turnRootMutationBindingsFor: () =>
          persistence.getTurnWorkspaceMutationBindings(turn.turnId),
        revisions: new FileRevisionRegistry(),
        apply: (request) => executor.apply(request),
        createDirectory: ({ taskId, turnId, rootId, path, guard }) =>
          executeWorkspaceCreateDirectory(
            { rootId, path },
            { taskId, turnId },
            workspaceEdit,
            guard,
          ),
        policyEpochFor: () => 0,
        newId: () => ids.next().value ?? 'unexpected-extra-id',
        now: () => '2026-07-23T00:00:00.000Z',
      };
      const provider = new ProviderWorkspaceTools({
        workspaceFor: () => workspace,
        rootIdentityFor: () => rootIdentityDigest,
        policyEpochFor: () => 0,
        authorizer: () => ({
          decision: 'allow',
          reason: 'integration test',
          beforeExecute: () => true,
        }),
        workspaceEdit,
      });
      const context = {
        taskId: task.id,
        turnId: turn.turnId,
        workspaceId: workspace.digest,
        policyEpoch: 0,
      } as const;
      provider.startTurn(context, 'ollama');
      const result = await provider.broker.dispatch({
        ...context,
        callId: 'call-mkdir',
        providerName: 'create_directory',
        input: { rootId, path: 'provider-directory' },
      });

      expect(result).toEqual({
        rootId,
        path: 'provider-directory',
        sagaId: 'saga-mkdir',
        state: 'committed',
        kind: 'mkdir',
      });
      expect((await lstat(directoryPath)).isDirectory()).toBe(true);
      await expect(
        readFile(join(directoryPath, '.sprint-coder-mkdir-placeholder')),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(persistence.getNativeMutationIntent('nmi-forward-1-saga-mkdir')).toMatchObject({
        kind: 'mkdir',
        state: 'completed',
      });
      provider.finishTurn(task.id, turn.turnId);
      await provider.dispose();
      await Promise.all([...sessions.values()].map((session) => native.closeSession(session)));
      persistence.close();
    });

    it('converges a restart after mkdir completed before the Saga journal update', async () => {
      const env = await fixture('mkdir-restart');
      const native = loadNativeSafeFs({
        addonPath: nativeSafeFsAddonPath(),
        lockDirectoryPath: env.locks,
      });
      const firstSessions = makeResolveSession(native, env);
      const directoryPath = join(env.workspace, 'restart-directory');
      const operations: readonly PreparedPatchOperation[] = Object.freeze([
        Object.freeze({
          kind: 'mkdir' as const,
          path: 'restart-directory',
          canonicalPath: directoryPath,
          destination: null,
          canonicalDestination: null,
          revisionTokenId: null,
          preRevision: null,
          preImage: null,
          postImage: null,
          preHash: null,
          postHash: null,
        }),
      ]);
      const facts = { version: 1 as const, policyEpoch: 0, operations };
      const plan = Object.freeze({ ...facts, digest: structuredPatchDigest(facts) });
      const { persistence, task, turn, workspaceKey, rootIdentityDigest } =
        await preparePersistence(env);
      const artifacts = await EditArtifactStore.open({
        rootPath: env.artifactRoot,
        quotaBytes: 4096,
      });
      const boundary = new NativeSafeFsEditEffectBoundary({
        native,
        journal: persistence,
        artifacts,
        resolveSession: firstSessions.resolveSession,
      });
      const crash: EditSagaFaultInjector = {
        hit(point) {
          if (point.kind === 'afterEffectBeforeJournal')
            throw new EditSagaCrashError('mkdir crash');
        },
      };
      const request = buildRequest({
        id: 'saga-mkdir-restart',
        taskId: task.id,
        turnId: turn.turnId,
        operationId: 'op-mkdir-restart',
        plan,
        workspaceKey,
        rootIdentityDigest,
      });
      await expect(
        new EditSagaExecutor(
          new PersistenceEditSagaStore(persistence),
          boundary,
          artifacts,
          crash,
          new SqliteEditSagaLeaseGuard(persistence, 'mkdir-crash-1'),
        ).apply(request),
      ).rejects.toBeInstanceOf(EditSagaCrashError);
      expect(persistence.getEditSaga(request.id).steps[0]).toMatchObject({
        state: 'effect_pending',
      });
      await Promise.all(
        [...firstSessions.sessions.values()].map((session) => native.closeSession(session)),
      );
      persistence.close();
      const reopened = new SqlitePersistenceClient(env.dbPath, verifyRealNativeSession);
      reopened.initializeMutationRecovery('mkdir-crash-2', new Date().toISOString());
      const secondSessions = makeResolveSession(native, env);
      const reopenedArtifacts = await EditArtifactStore.open({
        rootPath: env.artifactRoot,
        quotaBytes: 4096,
      });
      const recovered = await new EditSagaExecutor(
        new PersistenceEditSagaStore(reopened),
        new NativeSafeFsEditEffectBoundary({
          native,
          journal: reopened,
          artifacts: reopenedArtifacts,
          resolveSession: secondSessions.resolveSession,
        }),
        reopenedArtifacts,
        undefined,
        new SqliteEditSagaLeaseGuard(reopened, 'mkdir-crash-2'),
      ).recover(request.id);
      expect(recovered.state).toBe('committed');
      expect((await lstat(directoryPath)).isDirectory()).toBe(true);
      expect(reopened.getNativeMutationIntent('nmi-forward-1-saga-mkdir-restart')).toMatchObject({
        state: 'completed',
        cleanupObservation: { state: 'absent' },
      });
      await expect(readFile(directoryPath)).rejects.toMatchObject({ code: 'EISDIR' });
      expect(
        (await readdir(directoryPath)).filter((name) => name.startsWith('.sprint-coder-')),
      ).toEqual([]);
      await Promise.all(
        [...secondSessions.sessions.values()].map((session) => native.closeSession(session)),
      );
      reopened.close();
    });

    it('applies add+update+rename+delete atomically through the real native boundary', async () => {
      const env = await fixture('forward');
      const native = loadNativeSafeFs({
        addonPath: nativeSafeFsAddonPath(),
        lockDirectoryPath: env.locks,
      });
      const { resolveSession, sessions } = makeResolveSession(native, env);
      const { plan, paths } = await buildFullPatch(env.workspace);
      const { persistence, task, turn, workspaceKey, rootIdentityDigest } =
        await preparePersistence(env);
      const artifacts = await EditArtifactStore.open({
        rootPath: env.artifactRoot,
        quotaBytes: 4096,
      });
      const boundary = new NativeSafeFsEditEffectBoundary({
        native,
        journal: persistence,
        artifacts,
        resolveSession,
      });
      const executor = new EditSagaExecutor(
        new PersistenceEditSagaStore(persistence),
        boundary,
        artifacts,
        undefined,
        new SqliteEditSagaLeaseGuard(persistence, 'forward-instance'),
      );
      const request = buildRequest({
        id: 'saga-forward',
        taskId: task.id,
        turnId: turn.turnId,
        operationId: 'op-forward',
        plan,
        workspaceKey,
        rootIdentityDigest,
      });

      const result = await executor.apply(request);

      expect(result.state).toBe('committed');
      expect(result.artifactCleanupPending).toBe(false);
      await expect(readFile(paths.addPath, 'utf8')).resolves.toBe('ADD_CONTENT');
      await expect(readFile(paths.updatePath, 'utf8')).resolves.toBe('UPDATE_AFTER');
      await expect(readFile(paths.renameDstPath, 'utf8')).resolves.toBe('RENAME_CONTENT');
      await expectMissing(paths.renameSrcPath);
      await expectMissing(paths.deletePath);

      for (let ordinal = 1; ordinal <= 4; ordinal += 1)
        expect(
          persistence.getNativeMutationIntent(`nmi-forward-${ordinal}-saga-forward`),
        ).toMatchObject({
          state: 'completed',
        });
      expect(persistence.getEditSaga('saga-forward')).toMatchObject({
        state: 'committed',
        artifactCleanupPending: false,
      });

      for (const session of sessions.values()) await native.closeSession(session);
      persistence.close();
    });

    it('compensates every applied step back to its pre-image when finalize fails deterministically', async () => {
      const env = await fixture('compensate');
      const native = loadNativeSafeFs({
        addonPath: nativeSafeFsAddonPath(),
        lockDirectoryPath: env.locks,
      });
      const { resolveSession, sessions } = makeResolveSession(native, env);
      const { plan, paths } = await buildFullPatch(env.workspace);
      const { persistence, task, turn, workspaceKey, rootIdentityDigest } =
        await preparePersistence(env);
      const artifacts = await EditArtifactStore.open({
        rootPath: env.artifactRoot,
        quotaBytes: 4096,
      });
      const boundary = new NativeSafeFsEditEffectBoundary({
        native,
        journal: persistence,
        artifacts,
        resolveSession,
      });
      // The fault seam is used only as a deterministic timing hook (as edit-saga.ts
      // defines it), not to fake a crash: a plain Error thrown at 'beforeFinalize'
      // fires only after every step's real native effect already journaled cleanly
      // (effect_observed), so the Saga's own compensate() path treats each step as
      // safely reversible and drives the real reverse native effect for every one of
      // them. This is the only fault point that reaches a clean 'restored' outcome
      // instead of 'recovery_required': every earlier seam
      // (afterEffectBeforeJournal) fires while the step that just ran is still only
      // 'effect_pending', so compensate() must (correctly, fail-closed) treat that
      // step's outcome as ambiguous rather than roll it back automatically.
      const fault: EditSagaFaultInjector = {
        hit(point) {
          if (point.kind === 'beforeFinalize')
            throw new Error('deterministic finalize failure injected by test');
        },
      };
      const executor = new EditSagaExecutor(
        new PersistenceEditSagaStore(persistence),
        boundary,
        artifacts,
        fault,
        new SqliteEditSagaLeaseGuard(persistence, 'compensate-instance'),
      );
      const request = buildRequest({
        id: 'saga-compensate',
        taskId: task.id,
        turnId: turn.turnId,
        operationId: 'op-compensate',
        plan,
        workspaceKey,
        rootIdentityDigest,
      });

      const result = await executor.apply(request);

      expect(result.state).toBe('restored');
      await expectMissing(paths.addPath);
      await expect(readFile(paths.updatePath, 'utf8')).resolves.toBe('UPDATE_BEFORE');
      await expect(readFile(paths.renameSrcPath, 'utf8')).resolves.toBe('RENAME_CONTENT');
      await expectMissing(paths.renameDstPath);
      await expect(readFile(paths.deletePath, 'utf8')).resolves.toBe('DELETE_CONTENT');
      expect(persistence.getEditSaga('saga-compensate')).toMatchObject({ state: 'restored' });

      for (const session of sessions.values()) await native.closeSession(session);
      persistence.close();
    });

    it('recovers a workspace-bound prepared Saga under a recovery lease', async () => {
      const env = await fixture('prepared-crash');
      const native = loadNativeSafeFs({
        addonPath: nativeSafeFsAddonPath(),
        lockDirectoryPath: env.locks,
      });
      const { resolveSession, sessions } = makeResolveSession(native, env);
      const { plan } = await buildFullPatch(env.workspace);
      const { persistence, task, turn, workspaceKey, rootIdentityDigest } =
        await preparePersistence(env);
      const artifacts = await EditArtifactStore.open({
        rootPath: env.artifactRoot,
        quotaBytes: 4096,
      });
      const boundary = new NativeSafeFsEditEffectBoundary({
        native,
        journal: persistence,
        artifacts,
        resolveSession,
      });
      const request = buildRequest({
        id: 'saga-prepared-crash',
        taskId: task.id,
        turnId: turn.turnId,
        operationId: 'op-prepared-crash',
        plan,
        workspaceKey,
        rootIdentityDigest,
      });
      const crashing = new EditSagaExecutor(
        new PersistenceEditSagaStore(persistence),
        boundary,
        artifacts,
        {
          hit(point) {
            if (point.kind === 'afterJournalPrepared')
              throw new EditSagaCrashError('simulated crash after journal prepare');
          },
        },
        new SqliteEditSagaLeaseGuard(persistence, 'prepared-crash-instance-1'),
      );

      await expect(crashing.apply(request)).rejects.toBeInstanceOf(EditSagaCrashError);
      expect(persistence.getEditSaga('saga-prepared-crash')).toMatchObject({ state: 'prepared' });

      persistence.initializeMutationRecovery('prepared-crash-instance-2', new Date().toISOString());
      const recovered = await new EditSagaExecutor(
        new PersistenceEditSagaStore(persistence),
        boundary,
        artifacts,
        undefined,
        new SqliteEditSagaLeaseGuard(persistence, 'prepared-crash-instance-2'),
      ).reconcileAll();

      expect(recovered).toEqual([
        expect.objectContaining({ id: 'saga-prepared-crash', state: 'restored' }),
      ]);
      expect(persistence.getEditSaga('saga-prepared-crash')).toMatchObject({ state: 'restored' });

      for (const session of sessions.values()) await native.closeSession(session);
      persistence.close();
    });

    it('reconciles an abandoned Saga to a restored disk state after a simulated crash and restart', async () => {
      const env = await fixture('crash');
      const native1 = loadNativeSafeFs({
        addonPath: nativeSafeFsAddonPath(),
        lockDirectoryPath: env.locks,
      });
      const { resolveSession: resolveSession1, sessions: sessions1 } = makeResolveSession(
        native1,
        env,
      );
      const { plan, paths } = await buildFullPatch(env.workspace);
      const { persistence, task, turn, workspaceKey, rootIdentityDigest } =
        await preparePersistence(env);
      const artifacts = await EditArtifactStore.open({
        rootPath: env.artifactRoot,
        quotaBytes: 4096,
      });
      const boundary1 = new NativeSafeFsEditEffectBoundary({
        native: native1,
        journal: persistence,
        artifacts,
        resolveSession: resolveSession1,
      });
      // EditSagaCrashError models a genuine process death: apply() rejects instead of
      // compensating in-process, exactly like edit-saga.ts's own contract (runForward
      // re-throws EditSagaCrashError instead of calling compensate()). It fires at
      // 'beforeFinalize', i.e. after every real forward native effect already
      // journaled as effect_observed, so the durable state left behind is exactly
      // what a real crash there would leave: every file mutated on disk, the Saga
      // stuck in 'applying', and the mutation lease still held by the dead instance.
      const crashFault: EditSagaFaultInjector = {
        hit(point) {
          if (point.kind === 'beforeFinalize')
            throw new EditSagaCrashError('simulated process crash before finalize');
        },
      };
      const executor1 = new EditSagaExecutor(
        new PersistenceEditSagaStore(persistence),
        boundary1,
        artifacts,
        crashFault,
        new SqliteEditSagaLeaseGuard(persistence, 'crash-instance-1'),
      );
      const request = buildRequest({
        id: 'saga-crash',
        taskId: task.id,
        turnId: turn.turnId,
        operationId: 'op-crash',
        plan,
        workspaceKey,
        rootIdentityDigest,
      });

      await expect(executor1.apply(request)).rejects.toBeInstanceOf(EditSagaCrashError);

      // Every forward native effect genuinely landed on disk before the crash.
      await expect(readFile(paths.addPath, 'utf8')).resolves.toBe('ADD_CONTENT');
      await expect(readFile(paths.updatePath, 'utf8')).resolves.toBe('UPDATE_AFTER');
      await expect(readFile(paths.renameDstPath, 'utf8')).resolves.toBe('RENAME_CONTENT');
      await expectMissing(paths.renameSrcPath);
      await expectMissing(paths.deletePath);
      expect(persistence.getEditSaga('saga-crash')).toMatchObject({ state: 'applying' });

      // Simulate the OS releasing file descriptors and advisory locks on process
      // death. The durable SQLite lease and Saga state are left exactly as the
      // crashed process wrote them; only the live, in-process native session handle
      // is closed here to free the real OS lock for the next (restarted) process.
      for (const session of sessions1.values()) await native1.closeSession(session);
      persistence.close();

      const reopened = new SqlitePersistenceClient(env.dbPath, verifyRealNativeSession);
      reopened.initializeMutationRecovery('crash-instance-2', new Date().toISOString());

      const native2 = loadNativeSafeFs({
        addonPath: nativeSafeFsAddonPath(),
        lockDirectoryPath: env.locks,
      });
      const { resolveSession: resolveSession2, sessions: sessions2 } = makeResolveSession(
        native2,
        env,
      );
      const reopenedArtifacts = await EditArtifactStore.open({
        rootPath: env.artifactRoot,
        quotaBytes: 4096,
      });
      const boundary2 = new NativeSafeFsEditEffectBoundary({
        native: native2,
        journal: reopened,
        artifacts: reopenedArtifacts,
        resolveSession: resolveSession2,
      });
      const executor2 = new EditSagaExecutor(
        new PersistenceEditSagaStore(reopened),
        boundary2,
        reopenedArtifacts,
        undefined,
        new SqliteEditSagaLeaseGuard(reopened, 'crash-instance-2'),
      );

      const recovered = await executor2.reconcileAll();

      expect(recovered).toEqual([expect.objectContaining({ id: 'saga-crash', state: 'restored' })]);
      await expectMissing(paths.addPath);
      await expect(readFile(paths.updatePath, 'utf8')).resolves.toBe('UPDATE_BEFORE');
      await expect(readFile(paths.renameSrcPath, 'utf8')).resolves.toBe('RENAME_CONTENT');
      await expectMissing(paths.renameDstPath);
      await expect(readFile(paths.deletePath, 'utf8')).resolves.toBe('DELETE_CONTENT');
      expect(await executor2.reconcileAll()).toEqual([]);

      for (const session of sessions2.values()) await native2.closeSession(session);
      reopened.close();
    });
  });
} else {
  describe('EditSagaExecutor native integration Electron ABI bridge', () => {
    it('runs the full-stack Edit Saga integration suite with the bundled Electron Node ABI', () => {
      const result = spawnSync(
        electronTestExecutablePath(),
        [
          join(process.cwd(), '../../node_modules/vitest/vitest.mjs'),
          'run',
          'src/main/edit-saga-native-integration.test.ts',
        ],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SPRINT_CODER_ELECTRON_DB_TEST: '1' },
          timeout: 60_000,
        },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    }, 65_000);
  });
}
