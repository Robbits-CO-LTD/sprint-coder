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
import { spawn, spawnSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { electronTestExecutablePath } from './electron-test-runtime';
import { loadNativeSafeFs, nativeSafeFsAddonPath } from './native-safe-fs';
import type { NativeSafeFs, NativeSafeFsSession } from './native-safe-fs';
import { NativeSafeFsEditEffectBoundary } from './native-safe-fs-edit-boundary';
import { reconcileStartupNativeMutations } from './native-mutation-recovery';
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
import {
  MutationLeaseStaleError,
  MutationQuarantinedError,
  type MutationLeaseToken,
} from './mutation-lease';
import { workspaceMutationBinding } from './path-guard';

const runsWithElectronAbi = process.env.SPRINT_CODER_ELECTRON_DB_TEST === '1';
const cleanup: string[] = [];

// Keep fixture roots alive for the whole process. NativeSafeFs fences by the sealed
// dev/inode workspace identity; deleting each tmpfs fixture after a test lets Linux
// reuse the inode for the next test while the addon correctly retains the old fence.
afterAll(async () => {
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

async function buildUpdatePatch(workspace: string) {
  const path = join(workspace, 'restart-update.txt');
  await writeFile(path, 'UPDATE_BEFORE', { mode: 0o600 });
  const operation = Object.freeze({
    kind: 'update' as const,
    path: 'restart-update.txt',
    canonicalPath: path,
    destination: null,
    canonicalDestination: null,
    revisionTokenId: 'token-restart-update',
    preRevision: await fileRevision(path),
    preImage: 'UPDATE_BEFORE',
    postImage: 'UPDATE_AFTER',
    preHash: hash('UPDATE_BEFORE'),
    postHash: hash('UPDATE_AFTER'),
  });
  const facts = { version: 1 as const, policyEpoch: 0, operations: Object.freeze([operation]) };
  return { path, plan: Object.freeze({ ...facts, digest: structuredPatchDigest(facts) }) };
}

function crashAfterNativeCall(native: NativeSafeFs, method: keyof NativeSafeFs): NativeSafeFs {
  const value = native[method];
  if (typeof value !== 'function') throw new Error('Native crash checkpoint is not callable');
  return Object.freeze({
    ...native,
    [method]: async (...args: unknown[]) => {
      await Reflect.apply(value, native, args);
      throw new EditSagaCrashError(`simulated process crash after ${String(method)}`);
    },
  }) as NativeSafeFs;
}

/**
 * Scripts the native preflight of the forward update: each call takes the next answer ('crash'
 * dies as the process would before answering, 'refuse' refuses), and calls past the script ask the
 * real addon. `calls` counts the forward update preflights, so a refused step asked about again
 * during compensation, when the preflight would now allow it, shows up as another call.
 */
function scriptForwardUpdatePreflight(
  native: NativeSafeFs,
  script: readonly ('crash' | 'refuse')[],
): { native: NativeSafeFs; calls: () => number } {
  let calls = 0;
  const preflight = native.preflightIntentEffect;
  if (preflight === undefined) throw new Error('Native preflight is not available');
  const scripted: NativeSafeFs = Object.freeze({
    ...native,
    preflightIntentEffect: async (
      ...args: Parameters<NonNullable<NativeSafeFs['preflightIntentEffect']>>
    ) => {
      const [, seed] = args;
      if (seed.direction !== 'forward' || seed.kind !== 'update')
        return Reflect.apply(preflight, native, args);
      const answer = script[calls];
      calls += 1;
      if (answer === 'crash')
        throw new EditSagaCrashError('simulated process crash before the preflight answered');
      if (answer === 'refuse')
        return Object.freeze({ allowed: false as const, reason: 'refused by the test preflight' });
      return Reflect.apply(preflight, native, args);
    },
  });
  return { native: scripted, calls: () => calls };
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

/**
 * The environment for a Windows PowerShell 5.1 child. A PSModulePath inherited from a PowerShell 7
 * parent (a CI step, a pwsh terminal) points 5.1 at modules it cannot load, so Get-Acl and Set-Acl
 * fail with CouldNotAutoloadMatchingModule; without it, 5.1 uses its own module path.
 */
function windowsPowerShellEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  return env;
}

/**
 * Windows only: a file's DACL as SDDL. `ownerOnly` first replaces it with a protected DACL that
 * grants the current user alone.
 */
async function windowsDacl(path: string, ownerOnly = false): Promise<string> {
  const script = [
    '$path = $env:SPRINT_CODER_DACL_PATH',
    "if ($env:SPRINT_CODER_DACL_OWNER_ONLY -eq '1') {",
    '  $acl = Get-Acl -LiteralPath $path',
    '  $user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    '  $acl.SetSecurityDescriptorSddlForm("D:P(A;;FA;;;$user)", "Access")',
    '  Set-Acl -LiteralPath $path -AclObject $acl',
    '}',
    '(Get-Acl -LiteralPath $path).GetSecurityDescriptorSddlForm("Access")',
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    env: windowsPowerShellEnv({
      SPRINT_CODER_DACL_PATH: path,
      SPRINT_CODER_DACL_OWNER_ONLY: ownerOnly ? '1' : '',
    }),
  });
  if (result.status !== 0) throw new Error(`Get-Acl failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** One DACL entry: `flags` without INHERITED_ACE, which `inherited` carries. */
type WindowsAce = { type: string; flags: number; inherited: boolean; mask: number; sid: string };

/**
 * A DACL as what grants access: whether it is protected and its entries (null for a NULL DACL),
 * with every SID in its `S-` form. The other control flags, such as SE_DACL_AUTO_INHERITED (`AI`),
 * and SDDL's SID aliases depend on how the descriptor was written and on who runs the test, not on
 * who can access the file, so tests compare this instead of the SDDL text.
 */
type WindowsAccess = { protected: boolean; entries: WindowsAce[] | null };

/** Windows only: `windowsDacl`, returned as the access it grants (see `WindowsAccess`). */
async function windowsAccess(path: string, ownerOnly = false): Promise<WindowsAccess> {
  const script = [
    '$protected = $false',
    '$entries = $null',
    'if ($env:SPRINT_CODER_DACL_SDDL) {',
    '  $sd = New-Object Security.AccessControl.RawSecurityDescriptor ($env:SPRINT_CODER_DACL_SDDL)',
    '  $flag = [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected',
    '  $protected = ($sd.ControlFlags -band $flag) -ne 0',
    '  if ($null -ne $sd.DiscretionaryAcl) {',
    '    $entries = @(foreach ($ace in $sd.DiscretionaryAcl) {',
    '      $aceFlags = [int]$ace.AceFlags',
    '      [ordered]@{ type = $ace.AceType.ToString(); flags = $aceFlags -band 0xEF;',
    '        inherited = ($aceFlags -band 0x10) -ne 0; mask = $ace.AccessMask;',
    '        sid = $ace.SecurityIdentifier.Value }',
    '    })',
    '  }',
    '}',
    'ConvertTo-Json -Compress -Depth 4 -InputObject ([ordered]@{',
    '  protected = $protected; entries = $entries })',
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    env: windowsPowerShellEnv({ SPRINT_CODER_DACL_SDDL: await windowsDacl(path, ownerOnly) }),
  });
  if (result.status !== 0) throw new Error(`parsing the DACL failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as WindowsAccess;
}

/**
 * Windows only: writes a DACL through SetFileSecurityW, which stores it as given, so a protected
 * DACL keeps entries flagged as inherited (what a re-application through SetSecurityInfo drops).
 */
function windowsSetRawDacl(path: string, sddl: string): void {
  const script = [
    'Add-Type -TypeDefinition @"',
    'using System; using System.Runtime.InteropServices;',
    'public static class RawSd {',
    '  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
    '  public static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string s, uint r, out IntPtr sd, IntPtr size);',
    '  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
    '  public static extern bool SetFileSecurityW(string f, uint info, IntPtr sd);',
    '}',
    '"@',
    '$user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    "$sddl = $env:SPRINT_CODER_RAW_SDDL.Replace('{user}', $user)",
    '$sd = [IntPtr]::Zero',
    'if (-not [RawSd]::ConvertStringSecurityDescriptorToSecurityDescriptorW($sddl, 1, [ref]$sd, [IntPtr]::Zero)) { throw "convert" }',
    'if (-not [RawSd]::SetFileSecurityW($env:SPRINT_CODER_RAW_PATH, 4, $sd)) { throw "set" }',
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    env: windowsPowerShellEnv({ SPRINT_CODER_RAW_PATH: path, SPRINT_CODER_RAW_SDDL: sddl }),
  });
  if (result.status !== 0) throw new Error(`SetFileSecurityW failed: ${result.stderr}`);
}

/**
 * Windows only: a separate process that opens `path` the way .NET's default FileShare.Read does
 * (no FILE_SHARE_DELETE) and holds it until killed.
 */
async function holdWithoutShareDelete(path: string): Promise<ReturnType<typeof spawn>> {
  const holder = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      [
        "$stream = [IO.File]::Open($env:SPRINT_CODER_HELD_PATH, 'Open', 'Read', 'Read')",
        "[Console]::Out.WriteLine('held')",
        '[Console]::Out.Flush()',
        'Start-Sleep -Seconds 120',
      ].join('; '),
    ],
    {
      env: windowsPowerShellEnv({ SPRINT_CODER_HELD_PATH: path }),
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  await new Promise<void>((resolve, reject) => {
    holder.stdout!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('held')) resolve();
    });
    holder.once('exit', () => reject(new Error('the holder exited before holding the file')));
  });
  return holder;
}

function currentUserSid(): string {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],
    { encoding: 'utf8', env: windowsPowerShellEnv() },
  );
  return result.stdout.trim();
}

async function expectMissing(path: string): Promise<void> {
  await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
}

if (runsWithElectronAbi) {
  describe.runIf(process.platform === 'win32')('Windows EditSaga integration', () => {
    it('commits an add through the real native boundary', async () => {
      const env = await fixture('windows-add');
      const native = loadNativeSafeFs({
        addonPath: nativeSafeFsAddonPath(),
        lockDirectoryPath: env.locks,
      });
      const { resolveSession, sessions } = makeResolveSession(native, env);
      const { persistence, task, turn, workspaceKey, rootIdentityDigest } =
        await preparePersistence(env);
      const artifacts = await EditArtifactStore.open({
        rootPath: env.artifactRoot,
        quotaBytes: 4096,
      });
      const operation = Object.freeze({
        kind: 'add' as const,
        path: 'windows-add.txt',
        canonicalPath: join(env.workspace, 'windows-add.txt'),
        destination: null,
        canonicalDestination: null,
        revisionTokenId: null,
        preRevision: null,
        preImage: null,
        postImage: 'WINDOWS_ADD',
        preHash: null,
        postHash: hash('WINDOWS_ADD'),
      });
      const facts = {
        version: 1 as const,
        policyEpoch: 0,
        operations: Object.freeze([operation]),
      };
      const plan = Object.freeze({ ...facts, digest: structuredPatchDigest(facts) });
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
        new SqliteEditSagaLeaseGuard(persistence, 'windows-add-instance'),
      );

      const saga = await executor.apply(
        buildRequest({
          id: 'windows-add-saga',
          taskId: task.id,
          turnId: turn.turnId,
          operationId: 'windows-add-operation',
          plan,
          workspaceKey,
          rootIdentityDigest,
        }),
      );
      const verification = persistence.recordWorkspaceReadVerification({
        taskId: task.id,
        turnId: turn.turnId,
        rootId: 'legacy-primary',
        path: operation.path,
        content: 'WINDOWS_ADD',
        createdAt: '2026-07-23T00:00:01.000Z',
      });

      for (const session of sessions.values()) await native.closeSession(session);
      persistence.close();
      expect(saga).toMatchObject({ state: 'committed', recovery: null });
      expect(verification).toMatchObject({ decision: 'complete' });
      await expect(readFile(operation.canonicalPath, 'utf8')).resolves.toBe('WINDOWS_ADD');
    });

    it('restores updated, renamed and deleted files under their original access control', async () => {
      const env = await fixture('windows-compensate-acl');
      const native = loadNativeSafeFs({
        addonPath: nativeSafeFsAddonPath(),
        lockDirectoryPath: env.locks,
      });
      const { resolveSession, sessions } = makeResolveSession(native, env);
      const { plan, paths } = await buildFullPatch(env.workspace);
      // Owner-only protected DACLs on the updated and renamed files; the identity digests the plan
      // sealed do not depend on them. A delete of such a file is refused (native-safe-fs.test.ts),
      // so the deleted file keeps the DACL it inherits, which re-creating it reproduces.
      const restoredPaths = {
        update: paths.updatePath,
        rename: paths.renameSrcPath,
        delete: paths.deletePath,
      };
      const original: Record<string, WindowsAccess> = {};
      for (const [kind, path] of Object.entries(restoredPaths))
        original[kind] = await windowsAccess(path, kind !== 'delete');
      // The deleted file keeps only what it inherited from the Workspace.
      expect(original['delete']!.protected).toBe(false);
      expect(original['delete']!.entries!.every((entry) => entry.inherited)).toBe(true);
      const { persistence, task, turn, workspaceKey, rootIdentityDigest } =
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
        {
          hit(point) {
            if (point.kind === 'beforeFinalize')
              throw new Error('deterministic finalize failure injected by test');
          },
        },
        new SqliteEditSagaLeaseGuard(persistence, 'windows-compensate-acl'),
      );

      const result = await executor.apply(
        buildRequest({
          id: 'saga-windows-compensate-acl',
          taskId: task.id,
          turnId: turn.turnId,
          operationId: 'op-windows-compensate-acl',
          plan,
          workspaceKey,
          rootIdentityDigest,
        }),
      );

      expect(result.state).toBe('restored');
      await expect(readFile(paths.updatePath, 'utf8')).resolves.toBe('UPDATE_BEFORE');
      await expect(readFile(paths.renameSrcPath, 'utf8')).resolves.toBe('RENAME_CONTENT');
      await expect(readFile(paths.deletePath, 'utf8')).resolves.toBe('DELETE_CONTENT');
      const restored: Record<string, WindowsAccess> = {};
      for (const [kind, path] of Object.entries(restoredPaths))
        restored[kind] = await windowsAccess(path);
      expect(restored).toEqual(original);
      for (const session of sessions.values()) await native.closeSession(session);
      persistence.close();
    });

    it.each([
      ['after an update it has to undo', true],
      ['on its own', false],
    ])(
      'leaves a patch unapplied when Windows refuses its delete %s',
      async (_label, withUpdate) => {
        const env = await fixture(`windows-refused-${withUpdate ? 'batch' : 'single'}`);
        const native = loadNativeSafeFs({
          addonPath: nativeSafeFsAddonPath(),
          lockDirectoryPath: env.locks,
        });
        const { resolveSession, sessions } = makeResolveSession(native, env);
        const keptPath = join(env.workspace, 'kept.txt');
        const ownPath = join(env.workspace, 'own-acl.txt');
        await writeFile(keptPath, 'UPDATE_BEFORE', { mode: 0o600 });
        await writeFile(ownPath, 'OWN_ACL', { mode: 0o600 });
        const ownAccess = await windowsAccess(ownPath, true);
        const operations: PreparedPatchOperation[] = [];
        if (withUpdate)
          operations.push(
            Object.freeze({
              kind: 'update' as const,
              path: 'kept.txt',
              canonicalPath: keptPath,
              destination: null,
              canonicalDestination: null,
              revisionTokenId: 'token-kept',
              preRevision: await fileRevision(keptPath),
              preImage: 'UPDATE_BEFORE',
              postImage: 'UPDATE_AFTER',
              preHash: hash('UPDATE_BEFORE'),
              postHash: hash('UPDATE_AFTER'),
            }),
          );
        operations.push(
          Object.freeze({
            kind: 'delete' as const,
            path: 'own-acl.txt',
            canonicalPath: ownPath,
            destination: null,
            canonicalDestination: null,
            revisionTokenId: 'token-own-acl',
            preRevision: await fileRevision(ownPath),
            preImage: 'OWN_ACL',
            postImage: null,
            preHash: hash('OWN_ACL'),
            postHash: null,
          }),
        );
        const facts = {
          version: 1 as const,
          policyEpoch: 0,
          operations: Object.freeze(operations),
        };
        const plan = Object.freeze({ ...facts, digest: structuredPatchDigest(facts) });
        const { persistence, task, turn, workspaceKey, rootIdentityDigest } =
          await preparePersistence(env);
        const artifacts = await EditArtifactStore.open({
          rootPath: env.artifactRoot,
          quotaBytes: 4096,
        });
        const instance = `windows-refused-${withUpdate ? 'batch' : 'single'}`;
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
          new SqliteEditSagaLeaseGuard(persistence, instance),
        );
        const request = buildRequest({
          id: `saga-${instance}`,
          taskId: task.id,
          turnId: turn.turnId,
          operationId: `op-${instance}`,
          plan,
          workspaceKey,
          rootIdentityDigest,
        });

        // The reason is what apply_patch hands the model as its rejection.
        await expect(executor.apply(request)).rejects.toMatchObject({
          name: 'EditEffectRefusedError',
          message: 'このファイルは独自のアクセス制御を持つため、Windows では削除できません',
        });
        expect(persistence.getEditSaga(request.id)).toMatchObject({
          state: 'restored',
          recovery: null,
        });
        await expect(readFile(keptPath, 'utf8')).resolves.toBe('UPDATE_BEFORE');
        await expect(readFile(ownPath, 'utf8')).resolves.toBe('OWN_ACL');
        await expect(windowsAccess(ownPath)).resolves.toEqual(ownAccess);
        // No intent was journaled for the refused step, so nothing is left to recover.
        expect(persistence.listRecoverableNativeMutationIntents()).toEqual([]);
        expect(
          (await readdir(env.workspace)).filter((name) => name.startsWith('.sprint-coder-')),
        ).toEqual([]);
        for (const session of sessions.values()) await native.closeSession(session);
        persistence.close();
        const reopened = new SqlitePersistenceClient(env.dbPath, verifyRealNativeSession);
        expect(
          reopened.initializeMutationRecovery(`${instance}-2`, new Date().toISOString()),
        ).toEqual([]);
        reopened.close();
      },
    );

    it('commits updates whose protected DACL has inherited-flagged entries or mixes explicit and inherited ones', async () => {
      const env = await fixture('windows-carried-dacl-kinds');
      const native = loadNativeSafeFs({
        addonPath: nativeSafeFsAddonPath(),
        lockDirectoryPath: env.locks,
      });
      const { resolveSession, sessions } = makeResolveSession(native, env);
      const protectedPath = join(env.workspace, 'protected.txt');
      const mixedPath = join(env.workspace, 'mixed.txt');
      await writeFile(protectedPath, 'UPDATE_BEFORE', { mode: 0o600 });
      await writeFile(mixedPath, 'UPDATE_BEFORE', { mode: 0o600 });
      windowsSetRawDacl(protectedPath, 'D:PAI(A;ID;FA;;;{user})(A;ID;FR;;;BU)');
      spawnSync('icacls.exe', [mixedPath, '/grant', '*S-1-5-32-545:(R)']);
      const protectedAccess = await windowsAccess(protectedPath);
      const mixedAccess = await windowsAccess(mixedPath);
      expect(protectedAccess.protected).toBe(true);
      expect(protectedAccess.entries!.every((entry) => entry.inherited)).toBe(true);
      // One explicit entry for BUILTIN\Users ahead of those inherited from the Workspace.
      expect(mixedAccess.protected).toBe(false);
      expect(mixedAccess.entries![0]).toMatchObject({ inherited: false, sid: 'S-1-5-32-545' });
      expect(mixedAccess.entries!.length).toBeGreaterThan(1);
      expect(mixedAccess.entries!.slice(1).every((entry) => entry.inherited)).toBe(true);
      const operation = async (path: string, name: string) =>
        Object.freeze({
          kind: 'update' as const,
          path: name,
          canonicalPath: path,
          destination: null,
          canonicalDestination: null,
          revisionTokenId: `token-${name}`,
          preRevision: await fileRevision(path),
          preImage: 'UPDATE_BEFORE',
          postImage: 'UPDATE_AFTER',
          preHash: hash('UPDATE_BEFORE'),
          postHash: hash('UPDATE_AFTER'),
        });
      const facts = {
        version: 1 as const,
        policyEpoch: 0,
        operations: Object.freeze([
          await operation(protectedPath, 'protected.txt'),
          await operation(mixedPath, 'mixed.txt'),
        ]),
      };
      const plan = Object.freeze({ ...facts, digest: structuredPatchDigest(facts) });
      const { persistence, task, turn, workspaceKey, rootIdentityDigest } =
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
        new SqliteEditSagaLeaseGuard(persistence, 'windows-carried-dacl-kinds'),
      );

      // The preflight passes both, and staging produces exactly what it predicted.
      const saga = await executor.apply(
        buildRequest({
          id: 'saga-windows-carried-dacl-kinds',
          taskId: task.id,
          turnId: turn.turnId,
          operationId: 'op-windows-carried-dacl-kinds',
          plan,
          workspaceKey,
          rootIdentityDigest,
        }),
      );
      expect(saga).toMatchObject({ state: 'committed', recovery: null });
      await expect(readFile(protectedPath, 'utf8')).resolves.toBe('UPDATE_AFTER');
      await expect(readFile(mixedPath, 'utf8')).resolves.toBe('UPDATE_AFTER');
      // A protected re-application keeps every entry and drops only where it came from. Get-Acl
      // prints explicit entries in canonical order, so compare protection and the set of entries.
      const withoutOrigin = (access: WindowsAccess) => ({
        protected: access.protected,
        entries: (access.entries ?? [])
          .map(({ inherited: _inherited, ...entry }) => JSON.stringify(entry))
          .sort(),
      });
      expect(withoutOrigin(await windowsAccess(protectedPath))).toEqual(
        withoutOrigin(protectedAccess),
      );
      await expect(windowsAccess(mixedPath)).resolves.toEqual(mixedAccess);
      expect(persistence.listRecoverableNativeMutationIntents()).toEqual([]);
      for (const session of sessions.values()) await native.closeSession(session);
      persistence.close();
    });

    it.each([
      ['an inherited integrity label its new parent would not give', 'label', 'update'],
      ['an inherited integrity label its new parent would not give', 'label', 'delete'],
      ['a handle another program holds without FILE_SHARE_DELETE', 'held', 'update'],
      ['a handle another program holds without FILE_SHARE_DELETE', 'held', 'delete'],
    ] as const)(
      'refuses before journaling a file with %s (%s, %s) and restores the Saga',
      async (_label, condition, kind) => {
        const instance = `windows-refused-${condition}-${kind}`;
        const env = await fixture(instance);
        const native = loadNativeSafeFs({
          addonPath: nativeSafeFsAddonPath(),
          lockDirectoryPath: env.locks,
        });
        const { resolveSession, sessions } = makeResolveSession(native, env);
        const targetPath = join(env.workspace, 'target.txt');
        let holder: ReturnType<typeof spawn> | null = null;
        if (condition === 'label') {
          const labelled = join(env.workspace, 'labelled');
          await mkdir(labelled);
          spawnSync('icacls.exe', [labelled, '/setintegritylevel', '(OI)(CI)Low']);
          await writeFile(join(labelled, 'target.txt'), 'UPDATE_BEFORE', { mode: 0o600 });
          // The file keeps the Low label it inherited; its new parent passes none down.
          await rename(join(labelled, 'target.txt'), targetPath);
        } else {
          await writeFile(targetPath, 'UPDATE_BEFORE', { mode: 0o600 });
          holder = await holdWithoutShareDelete(targetPath);
        }
        const operation = Object.freeze({
          kind,
          path: 'target.txt',
          canonicalPath: targetPath,
          destination: null,
          canonicalDestination: null,
          revisionTokenId: 'token-target',
          preRevision: await fileRevision(targetPath),
          preImage: 'UPDATE_BEFORE',
          postImage: kind === 'update' ? 'UPDATE_AFTER' : null,
          preHash: hash('UPDATE_BEFORE'),
          postHash: kind === 'update' ? hash('UPDATE_AFTER') : null,
        });
        const facts = {
          version: 1 as const,
          policyEpoch: 0,
          operations: Object.freeze([operation]),
        };
        const plan = Object.freeze({ ...facts, digest: structuredPatchDigest(facts) });
        const { persistence, task, turn, workspaceKey, rootIdentityDigest } =
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
          new SqliteEditSagaLeaseGuard(persistence, instance),
        );
        try {
          await expect(
            executor.apply(
              buildRequest({
                id: `saga-${instance}`,
                taskId: task.id,
                turnId: turn.turnId,
                operationId: `op-${instance}`,
                plan,
                workspaceKey,
                rootIdentityDigest,
              }),
            ),
          ).rejects.toMatchObject({
            name: 'EditEffectRefusedError',
            message:
              condition === 'label'
                ? 'このファイルは整合性レベルを引き継げないため、Windows では更新・削除できません'
                : 'このファイルは他のプログラムが開いているため、Windows では変更できません',
          });
        } finally {
          holder?.kill();
        }
        expect(persistence.getEditSaga(`saga-${instance}`)).toMatchObject({ state: 'restored' });
        await expect(readFile(targetPath, 'utf8')).resolves.toBe('UPDATE_BEFORE');
        expect(persistence.listRecoverableNativeMutationIntents()).toEqual([]);
        expect(
          (await readdir(env.workspace)).filter((name) => name.startsWith('.sprint-coder-')),
        ).toEqual([]);
        for (const session of sessions.values()) await native.closeSession(session);
        persistence.close();
      },
    );

    it('leaves a patch unapplied when Windows refuses to update a file moved in from a stricter directory', async () => {
      const env = await fixture('windows-refused-moved-update');
      const native = loadNativeSafeFs({
        addonPath: nativeSafeFsAddonPath(),
        lockDirectoryPath: env.locks,
      });
      const { resolveSession, sessions } = makeResolveSession(native, env);
      const strict = join(env.workspace, 'strict');
      await mkdir(strict);
      await windowsDacl(strict, true);
      // Make the protected DACL inheritable so the file created inside takes it as inherited.
      spawnSync('icacls.exe', [strict, '/grant:r', `*${currentUserSid()}:(OI)(CI)F`]);
      const movedPath = join(env.workspace, 'moved.txt');
      await writeFile(join(strict, 'moved.txt'), 'UPDATE_BEFORE', { mode: 0o600 });
      await rename(join(strict, 'moved.txt'), movedPath);
      const movedAccess = await windowsAccess(movedPath);
      const operation = Object.freeze({
        kind: 'update' as const,
        path: 'moved.txt',
        canonicalPath: movedPath,
        destination: null,
        canonicalDestination: null,
        revisionTokenId: 'token-moved',
        preRevision: await fileRevision(movedPath),
        preImage: 'UPDATE_BEFORE',
        postImage: 'UPDATE_AFTER',
        preHash: hash('UPDATE_BEFORE'),
        postHash: hash('UPDATE_AFTER'),
      });
      const facts = { version: 1 as const, policyEpoch: 0, operations: Object.freeze([operation]) };
      const plan = Object.freeze({ ...facts, digest: structuredPatchDigest(facts) });
      const { persistence, task, turn, workspaceKey, rootIdentityDigest } =
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
        new SqliteEditSagaLeaseGuard(persistence, 'windows-refused-moved-update'),
      );
      const request = buildRequest({
        id: 'saga-windows-refused-moved-update',
        taskId: task.id,
        turnId: turn.turnId,
        operationId: 'op-windows-refused-moved-update',
        plan,
        workspaceKey,
        rootIdentityDigest,
      });

      await expect(executor.apply(request)).rejects.toMatchObject({
        name: 'EditEffectRefusedError',
        message: 'このファイルのアクセス制御は引き継げないため、Windows では更新できません',
      });
      expect(persistence.getEditSaga(request.id)).toMatchObject({ state: 'restored' });
      await expect(readFile(movedPath, 'utf8')).resolves.toBe('UPDATE_BEFORE');
      await expect(windowsAccess(movedPath)).resolves.toEqual(movedAccess);
      expect(persistence.listRecoverableNativeMutationIntents()).toEqual([]);
      expect(
        (await readdir(env.workspace)).filter((name) => name.startsWith('.sprint-coder-')),
      ).toEqual([]);
      for (const session of sessions.values()) await native.closeSession(session);
      persistence.close();
    });

    // Windows has no atomic exchange: an update is three no-replace renames. A process that dies
    // between them must neither report success nor strand the displaced revision.
    it.each(['after parking the previous revision', 'after publishing the staged artifact'])(
      'converges an update whose process died %s',
      async (point) => {
        const env = await fixture(`windows-interrupted-${point.split(' ')[1]}`);
        const native = loadNativeSafeFs({
          addonPath: nativeSafeFsAddonPath(),
          lockDirectoryPath: env.locks,
        });
        const firstSessions = makeResolveSession(native, env);
        const { path, plan } = await buildUpdatePatch(env.workspace);
        const { persistence, task, turn, workspaceKey, rootIdentityDigest } =
          await preparePersistence(env);
        const artifacts = await EditArtifactStore.open({
          rootPath: env.artifactRoot,
          quotaBytes: 4096,
        });
        const request = buildRequest({
          id: `saga-interrupted-${point.split(' ')[1]}`,
          taskId: task.id,
          turnId: turn.turnId,
          operationId: `op-interrupted-${point.split(' ')[1]}`,
          plan,
          workspaceKey,
          rootIdentityDigest,
        });
        // Reproduces the renames the native update performs up to the crash point, then dies.
        const dying = Object.freeze({
          ...native,
          applyIntentEffect: async (_session: NativeSafeFsSession, intent: { temp: unknown }) => {
            const temp = intent.temp as { leafName: string };
            const nonce = temp.leafName.slice('.sprint-coder-temp-'.length);
            await rename(path, join(env.workspace, `.sprint-coder-swap-${nonce}`));
            if (point === 'after publishing the staged artifact')
              await rename(join(env.workspace, temp.leafName), path);
            throw new EditSagaCrashError(`simulated process crash ${point}`);
          },
        }) as NativeSafeFs;
        await expect(
          new EditSagaExecutor(
            new PersistenceEditSagaStore(persistence),
            new NativeSafeFsEditEffectBoundary({
              native: dying,
              journal: persistence,
              artifacts,
              resolveSession: firstSessions.resolveSession,
            }),
            artifacts,
            undefined,
            new SqliteEditSagaLeaseGuard(persistence, `interrupted-${point.split(' ')[1]}-1`),
          ).apply(request),
        ).rejects.toBeInstanceOf(EditSagaCrashError);
        expect(persistence.getEditSaga(request.id)).toMatchObject({ state: 'applying' });
        await Promise.all(
          [...firstSessions.sessions.values()].map((session) => native.closeSession(session)),
        );
        persistence.close();

        const reopened = new SqlitePersistenceClient(env.dbPath, verifyRealNativeSession);
        const instance = `interrupted-${point.split(' ')[1]}-2`;
        const startupQuarantines = reopened.initializeMutationRecovery(
          instance,
          new Date().toISOString(),
        );
        const secondSessions = makeResolveSession(native, env);
        const reopenedArtifacts = await EditArtifactStore.open({
          rootPath: env.artifactRoot,
          quotaBytes: 4096,
        });
        const releasedFences = new Map<string, number>();
        const executor = new EditSagaExecutor(
          new PersistenceEditSagaStore(reopened),
          new NativeSafeFsEditEffectBoundary({
            native,
            journal: reopened,
            artifacts: reopenedArtifacts,
            resolveSession: secondSessions.resolveSession,
          }),
          reopenedArtifacts,
          undefined,
          new SqliteEditSagaLeaseGuard(reopened, instance, undefined, undefined, async (lease) => {
            const active = secondSessions.sessions.get(lease.fence);
            if (active !== undefined) await native.closeSession(active);
            releasedFences.set(lease.workspaceKey, lease.fence);
          }),
        );
        await reconcileStartupNativeMutations({
          journal: reopened,
          recoverSaga: (sagaId) => executor.recover(sagaId),
          reconcileEditSagas: () => executor.reconcileAll(),
          startupQuarantines,
          releasedFences,
          now: () => new Date().toISOString(),
        });

        await expect(readFile(path, 'utf8')).resolves.toBe('UPDATE_AFTER');
        expect(reopened.getEditSaga(request.id)).toMatchObject({ state: 'committed' });
        expect(reopened.listRecoverableNativeMutationIntents()).toEqual([]);
        expect(
          (await readdir(env.workspace)).filter((name) => name.startsWith('.sprint-coder-')),
        ).toEqual([]);
        reopened.close();
      },
    );
  });

  describe('EditSagaExecutor native integration', () => {
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

    it.each([
      ['stageIntentArtifact', 'aux_pending'],
      ['applyIntentEffect', 'effect_pending'],
      ['cleanupIntentAuxiliary', 'cleanup_pending'],
    ] as const)(
      'restarts from a persisted %s crash without repeating the logical update',
      async (crashMethod, expectedState) => {
        const env = await fixture(`intent-${expectedState}`);
        const native = loadNativeSafeFs({
          addonPath: nativeSafeFsAddonPath(),
          lockDirectoryPath: env.locks,
        });
        const firstSessions = makeResolveSession(native, env);
        const { path, plan } = await buildUpdatePatch(env.workspace);
        const { persistence, task, turn, workspaceKey, rootIdentityDigest } =
          await preparePersistence(env);
        const artifacts = await EditArtifactStore.open({
          rootPath: env.artifactRoot,
          quotaBytes: 4096,
        });
        const request = buildRequest({
          id: `saga-${expectedState}`,
          taskId: task.id,
          turnId: turn.turnId,
          operationId: `op-${expectedState}`,
          plan,
          workspaceKey,
          rootIdentityDigest,
        });
        await expect(
          new EditSagaExecutor(
            new PersistenceEditSagaStore(persistence),
            new NativeSafeFsEditEffectBoundary({
              native: crashAfterNativeCall(native, crashMethod),
              journal: persistence,
              artifacts,
              resolveSession: firstSessions.resolveSession,
            }),
            artifacts,
            undefined,
            new SqliteEditSagaLeaseGuard(persistence, `instance-${expectedState}-1`),
          ).apply(request),
        ).rejects.toBeInstanceOf(EditSagaCrashError);
        expect(
          persistence.getNativeMutationIntent(`nmi-forward-1-saga-${expectedState}`),
        ).toMatchObject({ state: expectedState });
        await Promise.all(
          [...firstSessions.sessions.values()].map((session) => native.closeSession(session)),
        );
        persistence.close();

        const reopened = new SqlitePersistenceClient(env.dbPath, verifyRealNativeSession);
        const startupQuarantines = reopened.initializeMutationRecovery(
          `instance-${expectedState}-2`,
          new Date().toISOString(),
        );
        const secondSessions = makeResolveSession(native, env);
        const reopenedArtifacts = await EditArtifactStore.open({
          rootPath: env.artifactRoot,
          quotaBytes: 4096,
        });
        const releasedFences = new Map<string, number>();
        const executor = new EditSagaExecutor(
          new PersistenceEditSagaStore(reopened),
          new NativeSafeFsEditEffectBoundary({
            native,
            journal: reopened,
            artifacts: reopenedArtifacts,
            resolveSession: secondSessions.resolveSession,
          }),
          reopenedArtifacts,
          undefined,
          new SqliteEditSagaLeaseGuard(
            reopened,
            `instance-${expectedState}-2`,
            undefined,
            undefined,
            async (lease) => {
              const active = secondSessions.sessions.get(lease.fence);
              if (active !== undefined) await native.closeSession(active);
              releasedFences.set(lease.workspaceKey, lease.fence);
            },
          ),
        );
        await reconcileStartupNativeMutations({
          journal: reopened,
          recoverSaga: (sagaId) => executor.recover(sagaId),
          reconcileEditSagas: () => executor.reconcileAll(),
          startupQuarantines,
          releasedFences,
          now: () => new Date().toISOString(),
        });

        await expect(readFile(path, 'utf8')).resolves.toBe('UPDATE_AFTER');
        expect(reopened.getEditSaga(request.id)).toMatchObject({ state: 'committed' });
        expect(
          reopened.getNativeMutationIntent(`nmi-forward-1-saga-${expectedState}`),
        ).toMatchObject({ state: 'completed' });
        expect(reopened.listRecoverableNativeMutationIntents()).toEqual([]);
        expect(reopened.startTurn(task.id, `continued after ${expectedState}`)).toBeDefined();
        reopened.close();
      },
    );

    it('keeps the Task quarantined when restart observation drift requires recovery', async () => {
      const env = await fixture('intent-observation-drift');
      const native = loadNativeSafeFs({
        addonPath: nativeSafeFsAddonPath(),
        lockDirectoryPath: env.locks,
      });
      const firstSessions = makeResolveSession(native, env);
      const { path, plan } = await buildUpdatePatch(env.workspace);
      const { persistence, task, turn, workspaceKey, rootIdentityDigest } =
        await preparePersistence(env);
      const artifacts = await EditArtifactStore.open({
        rootPath: env.artifactRoot,
        quotaBytes: 4096,
      });
      const request = buildRequest({
        id: 'saga-observation-drift',
        taskId: task.id,
        turnId: turn.turnId,
        operationId: 'op-observation-drift',
        plan,
        workspaceKey,
        rootIdentityDigest,
      });
      await expect(
        new EditSagaExecutor(
          new PersistenceEditSagaStore(persistence),
          new NativeSafeFsEditEffectBoundary({
            native: crashAfterNativeCall(native, 'stageIntentArtifact'),
            journal: persistence,
            artifacts,
            resolveSession: firstSessions.resolveSession,
          }),
          artifacts,
          undefined,
          new SqliteEditSagaLeaseGuard(persistence, 'instance-observation-drift-1'),
        ).apply(request),
      ).rejects.toBeInstanceOf(EditSagaCrashError);
      await Promise.all(
        [...firstSessions.sessions.values()].map((session) => native.closeSession(session)),
      );
      persistence.close();

      await writeFile(path, 'EXTERNAL_CHANGE', { mode: 0o600 });
      const reopened = new SqlitePersistenceClient(env.dbPath, verifyRealNativeSession);
      const startupQuarantines = reopened.initializeMutationRecovery(
        'instance-observation-drift-2',
        new Date().toISOString(),
      );
      const secondSessions = makeResolveSession(native, env);
      const reopenedArtifacts = await EditArtifactStore.open({
        rootPath: env.artifactRoot,
        quotaBytes: 4096,
      });
      const releasedFences = new Map<string, number>();
      const executor = new EditSagaExecutor(
        new PersistenceEditSagaStore(reopened),
        new NativeSafeFsEditEffectBoundary({
          native,
          journal: reopened,
          artifacts: reopenedArtifacts,
          resolveSession: secondSessions.resolveSession,
        }),
        reopenedArtifacts,
        undefined,
        new SqliteEditSagaLeaseGuard(
          reopened,
          'instance-observation-drift-2',
          undefined,
          undefined,
          async (lease) => {
            releasedFences.set(lease.workspaceKey, lease.fence);
          },
        ),
      );

      await expect(
        reconcileStartupNativeMutations({
          journal: reopened,
          recoverSaga: (sagaId) => executor.recover(sagaId),
          reconcileEditSagas: () => executor.reconcileAll(),
          startupQuarantines,
          releasedFences,
          now: () => new Date().toISOString(),
        }),
      ).rejects.toBeInstanceOf(MutationLeaseStaleError);

      expect(
        reopened.getNativeMutationIntent('nmi-forward-1-saga-observation-drift'),
      ).toMatchObject({
        state: 'recovery_required',
      });
      expect(() => reopened.startTurn(task.id, 'must remain quarantined')).toThrow(
        MutationQuarantinedError,
      );
      await Promise.all(
        [...secondSessions.sessions.values()].map((session) => native.closeSession(session)),
      );
      reopened.close();
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

    // The preflight refuses the update the first time and would allow it the second time: the
    // Saga must restore the earlier add without asking about the refused update again, because a
    // forward intent prepared while compensating is stale and would quarantine the Workspace.
    it('restores the earlier steps without re-running a step the preflight refused', async () => {
      const env = await fixture('refused-once');
      const native = loadNativeSafeFs({
        addonPath: nativeSafeFsAddonPath(),
        lockDirectoryPath: env.locks,
      });
      const scripted = scriptForwardUpdatePreflight(native, ['refuse']);
      const { resolveSession, sessions } = makeResolveSession(native, env);
      const { plan, paths } = await buildFullPatch(env.workspace);
      const { persistence, task, turn, workspaceKey, rootIdentityDigest } =
        await preparePersistence(env);
      const artifacts = await EditArtifactStore.open({
        rootPath: env.artifactRoot,
        quotaBytes: 4096,
      });
      const executor = new EditSagaExecutor(
        new PersistenceEditSagaStore(persistence),
        new NativeSafeFsEditEffectBoundary({
          native: scripted.native,
          journal: persistence,
          artifacts,
          resolveSession,
        }),
        artifacts,
        undefined,
        new SqliteEditSagaLeaseGuard(persistence, 'refused-once-instance'),
      );
      const request = buildRequest({
        id: 'saga-refused-once',
        taskId: task.id,
        turnId: turn.turnId,
        operationId: 'op-refused-once',
        plan,
        workspaceKey,
        rootIdentityDigest,
      });

      await expect(executor.apply(request)).rejects.toMatchObject({
        name: 'EditEffectRefusedError',
        message: 'refused by the test preflight',
      });
      const saga = persistence.getEditSaga(request.id);
      expect(saga).toMatchObject({ state: 'restored', recovery: null });
      expect(saga.steps.map((step) => step.state)).toEqual([
        'restored',
        'restored',
        'pending',
        'pending',
      ]);
      expect(scripted.calls()).toBe(1);
      expect(persistence.getNativeMutationIntent('nmi-forward-1-saga-refused-once')).toMatchObject({
        state: 'completed',
      });
      expect(() => persistence.getNativeMutationIntent('nmi-forward-2-saga-refused-once')).toThrow(
        'Native mutation intent not found',
      );
      expect(persistence.listRecoverableNativeMutationIntents()).toEqual([]);
      await expectMissing(paths.addPath);
      await expect(readFile(paths.updatePath, 'utf8')).resolves.toBe('UPDATE_BEFORE');
      await expect(readFile(paths.renameSrcPath, 'utf8')).resolves.toBe('RENAME_CONTENT');
      await expectMissing(paths.renameDstPath);
      await expect(readFile(paths.deletePath, 'utf8')).resolves.toBe('DELETE_CONTENT');

      for (const session of sessions.values()) await native.closeSession(session);
      persistence.close();
    });

    it('restores the earlier steps when the preflight refuses the step a restart resumes', async () => {
      const env = await fixture('refused-on-resume');
      const native = loadNativeSafeFs({
        addonPath: nativeSafeFsAddonPath(),
        lockDirectoryPath: env.locks,
      });
      // The process dies after journaling the update as effect_pending, before its preflight
      // answered; after the restart the preflight refuses once and would then allow.
      const scripted = scriptForwardUpdatePreflight(native, ['crash', 'refuse']);
      const firstSessions = makeResolveSession(native, env);
      const { plan, paths } = await buildFullPatch(env.workspace);
      const { persistence, task, turn, workspaceKey, rootIdentityDigest } =
        await preparePersistence(env);
      const artifacts = await EditArtifactStore.open({
        rootPath: env.artifactRoot,
        quotaBytes: 4096,
      });
      const request = buildRequest({
        id: 'saga-refused-on-resume',
        taskId: task.id,
        turnId: turn.turnId,
        operationId: 'op-refused-on-resume',
        plan,
        workspaceKey,
        rootIdentityDigest,
      });
      await expect(
        new EditSagaExecutor(
          new PersistenceEditSagaStore(persistence),
          new NativeSafeFsEditEffectBoundary({
            native: scripted.native,
            journal: persistence,
            artifacts,
            resolveSession: firstSessions.resolveSession,
          }),
          artifacts,
          undefined,
          new SqliteEditSagaLeaseGuard(persistence, 'refused-on-resume-1'),
        ).apply(request),
      ).rejects.toBeInstanceOf(EditSagaCrashError);
      expect(persistence.getEditSaga(request.id).steps.map((step) => step.state)).toEqual([
        'effect_observed',
        'effect_pending',
        'pending',
        'pending',
      ]);
      await Promise.all(
        [...firstSessions.sessions.values()].map((session) => native.closeSession(session)),
      );
      persistence.close();

      const reopened = new SqlitePersistenceClient(env.dbPath, verifyRealNativeSession);
      const startupQuarantines = reopened.initializeMutationRecovery(
        'refused-on-resume-2',
        new Date().toISOString(),
      );
      const secondSessions = makeResolveSession(native, env);
      const reopenedArtifacts = await EditArtifactStore.open({
        rootPath: env.artifactRoot,
        quotaBytes: 4096,
      });
      const releasedFences = new Map<string, number>();
      const executor = new EditSagaExecutor(
        new PersistenceEditSagaStore(reopened),
        new NativeSafeFsEditEffectBoundary({
          native: scripted.native,
          journal: reopened,
          artifacts: reopenedArtifacts,
          resolveSession: secondSessions.resolveSession,
        }),
        reopenedArtifacts,
        undefined,
        new SqliteEditSagaLeaseGuard(
          reopened,
          'refused-on-resume-2',
          undefined,
          undefined,
          async (lease) => {
            const active = secondSessions.sessions.get(lease.fence);
            if (active !== undefined) await native.closeSession(active);
            releasedFences.set(lease.workspaceKey, lease.fence);
          },
        ),
      );
      await reconcileStartupNativeMutations({
        journal: reopened,
        recoverSaga: (sagaId) => executor.recover(sagaId),
        reconcileEditSagas: () => executor.reconcileAll(),
        startupQuarantines,
        releasedFences,
        now: () => new Date().toISOString(),
      });

      const saga = reopened.getEditSaga(request.id);
      expect(saga).toMatchObject({ state: 'restored', recovery: null });
      expect(saga.steps.map((step) => step.state)).toEqual([
        'restored',
        'restored',
        'pending',
        'pending',
      ]);
      expect(scripted.calls()).toBe(2);
      expect(() =>
        reopened.getNativeMutationIntent('nmi-forward-2-saga-refused-on-resume'),
      ).toThrow('Native mutation intent not found');
      expect(reopened.listRecoverableNativeMutationIntents()).toEqual([]);
      await expectMissing(paths.addPath);
      await expect(readFile(paths.updatePath, 'utf8')).resolves.toBe('UPDATE_BEFORE');
      await expect(readFile(paths.renameSrcPath, 'utf8')).resolves.toBe('RENAME_CONTENT');
      await expect(readFile(paths.deletePath, 'utf8')).resolves.toBe('DELETE_CONTENT');
      expect(reopened.startTurn(task.id, 'continued after the refused resume')).toBeDefined();
      reopened.close();
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
