import { afterEach, describe, expect, it } from 'vitest';
import { link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EffectiveWorkspaceSet } from '@sprint-coder/contracts';
import {
  PROVIDER_WORKSPACE_GUIDANCE,
  ProviderWorkspaceTools,
  providerToolsFromSnapshot,
  workspaceToolAuthorizationGuard,
} from './provider-workspace-tools';
import { FileRevisionRegistry } from './file-revision';
import { commandToolTruncated } from './default-tools';

const roots: string[] = [];

describe('provider command output', () => {
  it('reports truncation when either output boundary truncated', () => {
    expect(commandToolTruncated(true, false)).toBe(true);
    expect(commandToolTruncated(false, true)).toBe(true);
    expect(commandToolTruncated(false, false)).toBe(false);
  });
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'sprint-coder-provider-workspace-'));
  roots.push(root);
  const workspace: EffectiveWorkspaceSet = {
    source: 'task',
    projectId: null,
    primaryRootId: 'root-a',
    roots: [
      {
        rootId: 'root-a',
        path: root,
        label: 'Workspace',
        role: 'primary',
        status: 'available',
      },
    ],
    digest: 'a'.repeat(64),
  };
  const authorizationGuards: unknown[] = [];
  const tools = new ProviderWorkspaceTools({
    workspaceFor: () => workspace,
    rootIdentityFor: () => undefined,
    policyEpochFor: () => 1,
    authorizer: (request) => {
      authorizationGuards.push(workspaceToolAuthorizationGuard(request.input));
      return { decision: 'allow', reason: 'test', beforeExecute: () => true };
    },
  });
  const context = {
    taskId: 'task-1',
    turnId: 'turn-1',
    workspaceId: workspace.digest,
    policyEpoch: 1,
  } as const;
  const snapshot = tools.startTurn(context, 'ollama');
  return { root, tools, context, snapshot, authorizationGuards };
}

describe('Provider workspace read tools', () => {
  it('publishes a deterministic immutable catalog for API Providers', async () => {
    const { tools, context, snapshot } = await harness();
    expect(providerToolsFromSnapshot(snapshot).map(({ name }) => name)).toEqual([
      'list_workspace',
      'read_file',
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    tools.finishTurn(context.taskId, context.turnId);
  });

  it('publishes and dispatches the native directory tool only when mutation is available', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sprint-coder-provider-mutation-'));
    roots.push(root);
    const workspace: EffectiveWorkspaceSet = {
      source: 'task',
      projectId: null,
      primaryRootId: 'root-a',
      roots: [
        { rootId: 'root-a', path: root, label: 'Workspace', role: 'primary', status: 'available' },
      ],
      digest: 'b'.repeat(64),
    };
    const created: string[] = [];
    const tools = new ProviderWorkspaceTools({
      workspaceFor: () => workspace,
      rootIdentityFor: () => undefined,
      policyEpochFor: () => 2,
      authorizer: () => ({ decision: 'allow', reason: 'test', beforeExecute: () => true }),
      workspaceEdit: {
        turnWorkspaceSetFor: () => workspace,
        turnRootMutationBindingsFor: () => new Map(),
        revisions: new FileRevisionRegistry(),
        apply: async () => {
          throw new Error('not used');
        },
        createDirectory: async ({ path, guard }) => {
          expect(workspaceToolAuthorizationGuard({})).toBeUndefined();
          expect(guard.operation).toBe('write');
          created.push(path);
          return {
            rootId: 'root-a',
            path,
            sagaId: 'mkdir-saga',
            state: 'committed',
            kind: 'mkdir',
          };
        },
        policyEpochFor: () => 2,
      },
    });
    const context = {
      taskId: 'task-2',
      turnId: 'turn-2',
      workspaceId: workspace.digest,
      policyEpoch: 2,
    } as const;
    const snapshot = tools.startTurn(context, 'ollama');
    expect(providerToolsFromSnapshot(snapshot).map(({ name }) => name)).toEqual(
      expect.arrayContaining(['create_directory', 'create_file', 'apply_patch']),
    );
    await expect(
      tools.broker.dispatch({
        ...context,
        callId: 'call-mkdir',
        providerName: 'create_directory',
        input: { path: 'discord-mcp' },
      }),
    ).resolves.toEqual({
      rootId: 'root-a',
      path: 'discord-mcp',
      state: 'committed',
      kind: 'mkdir',
      sagaId: 'mkdir-saga',
    });
    expect(created).toEqual(['discord-mcp']);
  });

  it('states the high-impact and honesty constraints in the Provider system guidance', () => {
    expect(PROVIDER_WORKSPACE_GUIDANCE).toMatch(/Never delete or\s+overwrite data/);
    expect(PROVIDER_WORKSPACE_GUIDANCE).toMatch(/send data over a network/);
    expect(PROVIDER_WORKSPACE_GUIDANCE).toMatch(/report that accurately/);
  });

  it('lists one directory in bytewise order without following symlinks', async () => {
    const { root, tools, context, authorizationGuards } = await harness();
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'z.txt'), 'z\n');
    await writeFile(join(root, 'a.txt'), 'a\n');
    if (process.platform !== 'win32') await symlink('/tmp', join(root, 'outside-link'));

    const result = await tools.broker.dispatch({
      ...context,
      callId: 'call-list',
      providerName: 'list_workspace',
      input: { path: '.' },
    });

    expect(result).toMatchObject({
      path: '.',
      truncated: false,
      entries: [
        { name: 'a.txt', kind: 'file' },
        ...(process.platform === 'win32'
          ? []
          : [{ name: 'outside-link', kind: 'symlink' as const }]),
        { name: 'src', kind: 'directory' },
        { name: 'z.txt', kind: 'file' },
      ],
    });
    expect(authorizationGuards).toHaveLength(1);
    expect(authorizationGuards[0]).toMatchObject({ operation: 'read' });
  });

  it('reads UTF-8 content and returns a Turn-bound revision', async () => {
    const { root, tools, context } = await harness();
    await writeFile(join(root, 'hello.txt'), 'こんにちは\n');

    await expect(
      tools.broker.dispatch({
        ...context,
        callId: 'call-read',
        providerName: 'read_file',
        input: { path: 'hello.txt' },
      }),
    ).resolves.toMatchObject({
      path: 'hello.txt',
      content: 'こんにちは\n',
      revision: { version: 1 },
    });
  });

  it('rejects traversal, symlink targets, and multiply-linked files', async () => {
    const { root, tools, context } = await harness();
    const outside = await mkdtemp(join(tmpdir(), 'sprint-coder-provider-outside-'));
    roots.push(outside);
    await writeFile(join(outside, 'secret.txt'), 'outside\n');
    await link(join(outside, 'secret.txt'), join(root, 'hardlink.txt'));
    if (process.platform !== 'win32')
      await symlink(join(outside, 'secret.txt'), join(root, 'symlink.txt'));

    await expect(
      tools.broker.dispatch({
        ...context,
        callId: 'call-traversal',
        providerName: 'read_file',
        input: { path: '../secret.txt' },
      }),
    ).rejects.toThrow();
    await expect(
      tools.broker.dispatch({
        ...context,
        callId: 'call-hardlink',
        providerName: 'read_file',
        input: { path: 'hardlink.txt' },
      }),
    ).rejects.toMatchObject({ code: 'HARDLINK_READ_DENIED' });
    if (process.platform !== 'win32')
      await expect(
        tools.broker.dispatch({
          ...context,
          callId: 'call-symlink',
          providerName: 'read_file',
          input: { path: 'symlink.txt' },
        }),
      ).rejects.toThrow();
  });

  it('withholds secret-bearing content before it can become a tool result', async () => {
    const { root, tools, context } = await harness();
    await writeFile(join(root, 'notes.txt'), 'password=hunter2\n');

    await expect(
      tools.broker.dispatch({
        ...context,
        callId: 'call-secret',
        providerName: 'read_file',
        input: { path: 'notes.txt' },
      }),
    ).rejects.toMatchObject({ code: 'PROTECTED_CONTENT' });
  });

  it('rejects a file identity substituted while authorization is pending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sprint-coder-provider-substitution-'));
    roots.push(root);
    await writeFile(join(root, 'target.txt'), 'safe\n');
    await writeFile(join(root, 'replacement.txt'), 'password=hunter2\n');
    const workspace: EffectiveWorkspaceSet = {
      source: 'task',
      projectId: null,
      primaryRootId: 'root-a',
      roots: [
        { rootId: 'root-a', path: root, label: 'Workspace', role: 'primary', status: 'available' },
      ],
      digest: 'c'.repeat(64),
    };
    const tools = new ProviderWorkspaceTools({
      workspaceFor: () => workspace,
      rootIdentityFor: () => undefined,
      policyEpochFor: () => 1,
      authorizer: async () => {
        await rename(join(root, 'target.txt'), join(root, 'old.txt'));
        await rename(join(root, 'replacement.txt'), join(root, 'target.txt'));
        return { decision: 'allow', reason: 'test', beforeExecute: () => true };
      },
    });
    const context = {
      taskId: 'task-3',
      turnId: 'turn-3',
      workspaceId: workspace.digest,
      policyEpoch: 1,
    } as const;
    tools.startTurn(context, 'ollama');

    await expect(
      tools.broker.dispatch({
        ...context,
        callId: 'call-substitution',
        providerName: 'read_file',
        input: { path: 'target.txt' },
      }),
    ).rejects.toThrow(/identity changed/i);
  });

  it('carries distinct read/write guards through apply_patch and reaches Edit Saga', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sprint-coder-provider-patch-'));
    roots.push(root);
    await writeFile(join(root, 'bot.py'), 'before\n');
    const workspace: EffectiveWorkspaceSet = {
      source: 'task',
      projectId: null,
      primaryRootId: 'root-a',
      roots: [
        { rootId: 'root-a', path: root, label: 'Workspace', role: 'primary', status: 'available' },
      ],
      digest: 'e'.repeat(64),
    };
    let applied = false;
    const tools = new ProviderWorkspaceTools({
      workspaceFor: () => workspace,
      rootIdentityFor: () => undefined,
      policyEpochFor: () => 1,
      authorizer: ({ input }) => {
        expect(workspaceToolAuthorizationGuard(input, 'read')?.operation).toBe('read');
        expect(workspaceToolAuthorizationGuard(input, 'write')?.operation).toBe('write');
        return { decision: 'allow', reason: 'test', beforeExecute: () => true };
      },
      workspaceEdit: {
        turnWorkspaceSetFor: () => workspace,
        turnRootMutationBindingsFor: () => new Map(),
        revisions: new FileRevisionRegistry(),
        apply: async () => {
          applied = true;
          return { id: 'saga-1', state: 'committed' } as never;
        },
        policyEpochFor: () => 1,
      },
    });
    const context = {
      taskId: 'task-4',
      turnId: 'turn-4',
      workspaceId: workspace.digest,
      policyEpoch: 1,
    } as const;
    tools.startTurn(context, 'ollama');
    await expect(
      tools.broker.dispatch({
        ...context,
        callId: 'call-patch',
        providerName: 'apply_patch',
        input: {
          rootId: 'workspace',
          path: 'bot.py',
          edits: [{ oldText: 'before', newText: 'after' }],
        },
      }),
    ).resolves.toMatchObject({ state: 'committed', kind: 'update' });
    expect(applied).toBe(true);
  });
});
