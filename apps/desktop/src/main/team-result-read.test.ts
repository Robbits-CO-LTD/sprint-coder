import { link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EffectiveWorkspaceSet } from '@sprint-coder/contracts';
import {
  ManagedCodingHarness,
  providerDisclosureAuthorizationFacts,
  teamResultReadAuthorizationFacts,
  workspaceToolAuthorizationGuard,
  type ManagedTeamResultReadRequest,
} from './provider-workspace-tools';
import type { TeamResultReadRequest, TeamResultReadSource } from './team-coordinator';
import type { ToolAuthorizer, ToolAuthorizationRequest } from './tool-broker';
import { IpcRouter } from './ipc';
import type { PermissionBroker } from './permission-broker';
import { FileRevisionRegistry } from './file-revision';
import { workspaceMutationBinding, workspacePermissionResourceFromGuard } from './path-guard';

const directories: string[] = [];
const harnesses: ManagedCodingHarness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(
  options: {
    authorize?: ToolAuthorizer;
    subdirectory?: boolean;
    bound?: boolean;
    appPrivate?: boolean;
  } = {},
) {
  // Windows temp is under protected AppData; use the same neutral base as path-guard.test.
  const fixtureBase = process.platform === 'win32' ? process.cwd() : tmpdir();
  const directory = await mkdtemp(join(fixtureBase, 'team-result-read-'));
  directories.push(directory);
  const repositoryPath = options.appPrivate
    ? join(directory, 'AppData', 'central')
    : join(directory, 'central');
  const central = options.subdirectory ? join(repositoryPath, 'nested') : repositoryPath;
  const isolated = join(directory, 'isolated');
  await mkdir(central, { recursive: true });
  await mkdir(isolated);
  const binding = await workspaceMutationBinding(central);
  const workspace: EffectiveWorkspaceSet = {
    source: 'task',
    projectId: null,
    primaryRootId: 'root-a',
    digest: 'a'.repeat(64),
    roots: [
      {
        rootId: 'root-a',
        path: binding.canonicalPath,
        label: 'Central',
        role: 'primary',
        status: 'available',
      },
    ],
  };
  workspace.roots.forEach(Object.freeze);
  Object.freeze(workspace.roots);
  Object.freeze(workspace);
  const prefix = options.subdirectory ? 'nested/' : '';
  const source: TeamResultReadSource = Object.freeze({
    workspace,
    rootId: 'root-a',
    rootIdentityDigest: binding.rootIdentityDigest,
    mutationKey: binding.workspaceKey,
    repositoryPath: (await workspaceMutationBinding(repositoryPath)).canonicalPath,
    changedFiles: Object.freeze([
      `${prefix}result.txt`,
      `${prefix}link.txt`,
      `${prefix}hard.txt`,
      `${prefix}.env`,
    ]),
    executionId: 'child-completed',
    integratedHead: 'b'.repeat(40),
  });
  const state = {
    epoch: 1,
    source,
    reads: 0,
    beforeRead: async (_ordinal: number) => {},
    afterRead: async (_ordinal: number) => {},
  };
  const context = {
    taskId: 'task-1',
    turnId: 'turn-1',
    workspaceId: workspace.digest,
    policyEpoch: 1,
  };
  const revisions = new FileRevisionRegistry();
  const tools = new ManagedCodingHarness({
    workspaceFor: () => ({
      ...workspace,
      roots: workspace.roots.map((root) => ({ ...root, path: isolated })),
    }),
    rootIdentityFor: () => undefined,
    policyEpochFor: () => state.epoch,
    authorizer: options.authorize ?? (() => ({ decision: 'allow', reason: 'test' })),
    ...(options.bound === false
      ? {}
      : {
          readTeamResult: async <T>(
            request: { executionId: string },
            read: (source: TeamResultReadSource) => Promise<T>,
          ) => {
            if (request.executionId !== source.executionId) throw new Error('Unknown result');
            const ordinal = ++state.reads;
            await state.beforeRead(ordinal);
            const result = await read(state.source);
            await state.afterRead(ordinal);
            return result;
          },
        }),
    workspaceEdit: {
      revisions,
      policyEpochFor: () => state.epoch,
      turnWorkspaceSetFor: () => workspace,
      turnRootMutationBindingsFor: () => new Map(),
      apply: async () => {
        throw new Error('Test must not write');
      },
    },
  });
  harnesses.push(tools);
  tools.startTurn(context, 'codex');
  let call = 0;
  const dispatch = (
    input: Record<string, unknown> = {},
    signal?: AbortSignal,
    providerName = 'read_file',
  ) =>
    tools.broker.dispatch({
      ...context,
      callId: `call-${++call}`,
      providerName,
      input: { path: 'result.txt', teamResultExecutionId: source.executionId, ...input },
      ...(signal === undefined ? {} : { signal }),
    });
  await writeFile(join(central, 'result.txt'), 'current central contents\n');
  return { directory, central, isolated, source, tools, context, revisions, state, dispatch };
}

describe('Manager integrated result read boundary', () => {
  it('uses only the live Main call binding for caller identity and cancels a released Manager', async () => {
    const hostRead = Reflect.get(IpcRouter.prototype, 'readManagedTeamResult') as (
      this: unknown,
      request: ManagedTeamResultReadRequest,
      read: (source: TeamResultReadSource) => Promise<unknown>,
    ) => Promise<unknown>;
    const released = new AbortController();
    const calls = new Map<
      string,
      { executionBinding?: { executionId: string; agentId: string }; signal: AbortSignal }
    >();
    const resolve = vi.fn(async (request: TeamResultReadRequest) => request);
    const router = Object.create(IpcRouter.prototype) as Record<string, unknown>;
    Object.assign(router, {
      managedWorkerCall: calls,
      teamCoordinator: { readTeamResult: resolve },
    });
    const context = {
      taskId: 'task-1',
      turnId: 'owner-turn',
      workspaceId: 'workspace',
      policyEpoch: 1,
    };
    const request = { context, callId: 'call-1', executionId: 'child-1' };
    const invoke = async (value = request) => hostRead.call(router, value, async () => 'read');
    await expect(invoke()).rejects.toThrow('live Manager binding');
    calls.set(JSON.stringify([context.turnId, request.callId]), { signal: released.signal });
    await expect(invoke()).rejects.toThrow('live Manager binding');
    calls.set(JSON.stringify([context.turnId, request.callId]), {
      signal: released.signal,
      executionBinding: { executionId: 'host-execution', agentId: 'host-manager' },
    });
    await expect(invoke()).resolves.toMatchObject({
      callerExecutionId: 'host-execution',
      callerAgentId: 'host-manager',
      parentTurnId: 'owner-turn',
      targetExecutionId: 'child-1',
    });
    await expect(invoke({ ...request, callId: 'other-call' })).rejects.toThrow(
      'live Manager binding',
    );
    released.abort();
    await expect(invoke()).rejects.toThrow();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('issues immutable call-scoped authorization facts and maps a subdirectory into sealed Git paths', async () => {
    let authorized = false;
    const f = await fixture({
      subdirectory: true,
      authorize: (request) => {
        const source = teamResultReadAuthorizationFacts(
          request.input,
          request.context,
          request.callId,
        )!;
        expect(source.rootIdentityDigest).toBe(f.source.rootIdentityDigest);
        expect(Object.isFrozen(source)).toBe(true);
        expect(Object.isFrozen(source.changedFiles)).toBe(true);
        expect(
          teamResultReadAuthorizationFacts(
            { ...(request.input as object) },
            request.context,
            request.callId,
          ),
        ).toBeUndefined();
        expect(
          teamResultReadAuthorizationFacts(request.input, request.context, 'another-call'),
        ).toBeUndefined();
        expect(
          teamResultReadAuthorizationFacts(
            request.input,
            { ...request.context, turnId: 'other' },
            request.callId,
          ),
        ).toBeUndefined();
        expect(workspaceToolAuthorizationGuard(request.input)?.workspacePath).toBe(
          f.source.workspace.roots[0]!.path,
        );
        authorized = true;
        return { decision: 'allow', reason: 'test' };
      },
    });
    await expect(f.dispatch({ lineStart: 1, lineEnd: 1 })).resolves.toMatchObject({
      content: 'current central contents',
      source: {
        kind: 'team-result',
        executionId: f.source.executionId,
        integratedHead: f.source.integratedHead,
        contents: 'current-workspace',
      },
    });
    expect(authorized).toBe(true);
    expect(f.state.reads).toBe(2);
    await writeFile(join(f.central, 'outside.txt'), 'not a Worker change\n');
    await expect(f.dispatch({ path: 'outside.txt' })).rejects.toThrow('Main-sealed changed file');
    await expect(f.dispatch({ path: join(f.central, 'result.txt') })).rejects.toThrow(
      'relative path',
    );
    await expect(f.dispatch({ path: '../result.txt' })).rejects.toThrow();
  });

  it('refuses a selector without a host binding and on every other workspace tool', async () => {
    const f = await fixture({ bound: false });
    await expect(f.dispatch()).rejects.toThrow('live Manager binding');
    for (const [name, input] of [
      ['list_workspace', {}],
      ['search_workspace', { query: 'x' }],
      ['view_image', {}],
      ['create_file', { content: 'x' }],
      ['apply_patch', { edits: [{ oldText: 'x', newText: 'y' }] }],
    ] as const)
      await expect(f.dispatch(input, undefined, name)).rejects.toMatchObject({
        code: 'INVALID_TOOL_INPUT',
        hint: expect.stringContaining('unexpected key "teamResultExecutionId"'),
      });
  });

  it('refuses same-root symlink allowlist escapes and hardlinks before authorization', async () => {
    let authorizations = 0;
    const f = await fixture({
      authorize: () => {
        authorizations++;
        return { decision: 'allow', reason: 'test' };
      },
    });
    await writeFile(join(f.central, 'unrelated.txt'), 'must not disclose');
    if (process.platform !== 'win32') {
      await symlink('unrelated.txt', join(f.central, 'link.txt'));
      await expect(f.dispatch({ path: 'link.txt' })).rejects.toThrow();
    }
    await link(join(f.central, 'unrelated.txt'), join(f.central, 'hard.txt'));
    await expect(f.dispatch({ path: 'hard.txt' })).rejects.toMatchObject({
      code: 'HARDLINK_READ_DENIED',
    });
    expect(authorizations).toBe(0);
  });

  it('retains disclosure redaction and the ordinary protected-path classification', async () => {
    const f = await fixture({
      authorize: (request) => {
        expect(providerDisclosureAuthorizationFacts(request.input)).toMatchObject({
          canonicalPath: join(f.source.workspace.roots[0]!.path, '.env'),
          classification: 'sensitive',
        });
        const guard = workspaceToolAuthorizationGuard(request.input)!;
        expect(workspacePermissionResourceFromGuard(guard).classification).toBe('credential');
        return { decision: 'allow', reason: 'test-disclosure' };
      },
    });
    await writeFile(join(f.central, '.env'), 'password=hunter2\n');
    await expect(f.dispatch({ path: '.env' })).resolves.toMatchObject({
      content: 'password=[REDACTED]\n',
    });
  });

  it.each(['contents', 'root', 'source', 'epoch'] as const)(
    'rejects %s changes after authorization',
    async (change) => {
      const f = await fixture({
        authorize: async () => {
          if (change === 'contents')
            await writeFile(join(f.central, 'result.txt'), 'changed after approval');
          if (change === 'root') {
            await rename(f.central, `${f.central}-old`);
            await mkdir(f.central);
            await writeFile(join(f.central, 'result.txt'), 'replacement root');
          }
          if (change === 'source')
            f.state.source = Object.freeze({ ...f.source, integratedHead: 'c'.repeat(40) });
          if (change === 'epoch') f.state.epoch++;
          return { decision: 'allow', reason: 'test' };
        },
      });
      await expect(f.dispatch()).rejects.toThrow();
    },
  );

  it.each([
    ['fence', 'epoch'],
    ['return', 'epoch'],
    ['fence', 'turn-end'],
    ['return', 'turn-end'],
  ] as const)('rejects %s-time %s invalidation inside the result fence', async (timing, kind) => {
    const f = await fixture();
    const invalidate = async (ordinal: number) => {
      if (ordinal !== 2) return;
      if (kind === 'epoch') f.state.epoch++;
      else f.tools.finishTurn(f.context.taskId, f.context.turnId);
    };
    if (timing === 'fence') f.state.beforeRead = invalidate;
    else f.state.afterRead = invalidate;
    await expect(f.dispatch()).rejects.toThrow('Team result read authority expired');
    expect(f.state.reads).toBe(2);
  });

  it('returns no bytes when canceled after execute has begun', async () => {
    const f = await fixture();
    const controller = new AbortController();
    const guardedRead = f.revisions.readGuarded.bind(f.revisions);
    let reads = 0;
    const spy = vi.spyOn(f.revisions, 'readGuarded').mockImplementation(async (request) => {
      const result = await guardedRead(request);
      if (++reads === 2) controller.abort();
      return result;
    });
    try {
      await expect(f.dispatch({}, controller.signal)).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it('authorizes central sources without the sealed-isolation protected-path exception', async () => {
    const preview = vi.fn((request: Parameters<PermissionBroker['preview']>[0]) => {
      expect(request.workspace).toBe(f.source.workspace);
      expect(request.workspaceAuthority).toBeUndefined();
      expect(request.request.resource).toMatchObject({ classification: 'app-private' });
      return { decision: 'deny', reason: 'immutable_protected_resource', policyEpoch: 1 };
    });
    const router = Object.create(IpcRouter.prototype) as Record<string, unknown>;
    const calls = new Map<string, { workspace: EffectiveWorkspaceSet }>();
    Object.assign(router, {
      managedWorkerCall: calls,
      permissionBroker: {
        preview,
        getPolicy: () => ({ preset: 'full' }),
        commitEvaluation: () => undefined,
      },
    });
    const evaluate = Reflect.get(IpcRouter.prototype, 'evaluateToolPermission') as (
      this: unknown,
      request: ToolAuthorizationRequest,
      capability: 'workspace.read',
    ) => ReturnType<ToolAuthorizer>;
    const f = await fixture({
      appPrivate: true,
      authorize: (request) => {
        calls.set(JSON.stringify([request.context.turnId, request.callId]), {
          workspace: {
            ...f.source.workspace,
            roots: f.source.workspace.roots.map((root) => ({ ...root, path: f.isolated })),
          },
        });
        return evaluate.call(router, request, 'workspace.read');
      },
    });
    await expect(f.dispatch()).rejects.toThrow();
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it('cannot reuse a central revision to edit the same path and contents in the Manager isolation', async () => {
    const f = await fixture();
    await writeFile(join(f.isolated, 'result.txt'), 'current central contents\n');
    const result = (await f.dispatch()) as { revision: { version: 1; tokenId: string } };
    await expect(
      f.revisions.resolve({
        owner: f.context,
        reference: result.revision,
        rootId: 'root-a',
        workspacePath: f.isolated,
        targetPath: 'result.txt',
        policyEpoch: 1,
      }),
    ).rejects.toMatchObject({ code: 'TARGET_CHANGED' });
  });
});
