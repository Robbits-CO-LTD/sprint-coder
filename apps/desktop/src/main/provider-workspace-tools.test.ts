import { afterEach, describe, expect, it, vi } from 'vitest';
import { link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EffectiveWorkspaceSet } from '@sprint-coder/contracts';
import {
  PROVIDER_WORKSPACE_GUIDANCE,
  ProviderWorkspaceTools,
  providerDisclosureAuthorizationFacts,
  providerToolsFromSnapshot,
  workspaceToolAuthorizationGuard,
  workspaceToolAuthorizationGuards,
} from './provider-workspace-tools';
import { FileRevisionRegistry } from './file-revision';
import { commandToolTruncated } from './default-tools';
import { approvalFactsForTool } from './approval-coordinator';
import { workspaceMutationBinding } from './path-guard';
import { ManagedCommandSessions } from './managed-command-sessions';

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
  it('exposes Project Memory and Skill import only through the selected managed catalog', async () => {
    const calls: string[] = [];
    const tools = new ProviderWorkspaceTools({
      workspaceFor: () => null,
      rootIdentityFor: () => undefined,
      policyEpochFor: () => 1,
      authorizer: () => ({ decision: 'allow', reason: 'test', beforeExecute: () => true }),
      auxiliary: {
        queueProjectMemory: async () => {
          calls.push('memory');
          return { queued: true };
        },
        createSkillDraft: async () => ({ draft: true }),
        readSkillImport: async () => {
          calls.push('read');
          return { digest: 'a'.repeat(64), files: [] };
        },
        installSkillImport: async () => {
          calls.push('install');
          return { installed: true };
        },
      },
    });
    const context = {
      taskId: 'task-aux',
      turnId: 'turn-aux',
      workspaceId: null,
      policyEpoch: 1,
    } as const;
    const snapshot = tools.startTurn(context, 'codex', {
      projectMemory: true,
      skillImports: true,
      skillImportUserText: 'IMPORT_SKILL claude writer',
    });
    expect(snapshot.entries.map(({ providerName }) => providerName)).toEqual(
      expect.arrayContaining([
        'project_memory_remember',
        'skill_import_read',
        'skill_import_install',
      ]),
    );
    expect(snapshot.entries.map(({ providerName }) => providerName)).not.toContain(
      'skill_draft_create',
    );
    await tools.broker.dispatch({
      ...context,
      callId: 'memory',
      providerName: 'project_memory_remember',
      input: { content: 'durable fact' },
    });
    await tools.broker.dispatch({
      ...context,
      callId: 'import-read',
      providerName: 'skill_import_read',
      input: { cli: 'claude', skillId: 'writer' },
    });
    await tools.broker.dispatch({
      ...context,
      callId: 'import-install',
      providerName: 'skill_import_install',
      input: { source: { cli: 'claude', skillId: 'writer', digest: 'a'.repeat(64) }, files: [] },
    });
    expect(calls).toEqual(['memory', 'read', 'install']);
    await tools.dispose();
  });

  it('omits command tools until the OS sandbox probe succeeds', async () => {
    const { tools, context } = await harness();
    const disposeSessions = vi.spyOn(ManagedCommandSessions.prototype, 'dispose');
    const commandTools = new ProviderWorkspaceTools({
      workspaceFor: () => null,
      rootIdentityFor: () => undefined,
      policyEpochFor: () => 1,
      authorizer: () => ({ decision: 'deny', reason: 'test' }),
      command: { persistence: {} as never, publish: () => undefined },
    });
    const unavailable = commandTools.startTurn(
      { ...context, turnId: 'turn-command-unavailable' },
      'codex',
    );
    expect(unavailable.entries.map(({ providerName }) => providerName)).not.toContain(
      'exec_command',
    );
    commandTools.finishTurn(context.taskId, 'turn-command-unavailable');
    commandTools.setCommandSandboxAvailable(true);
    const available = commandTools.startTurn(
      { ...context, turnId: 'turn-command-available' },
      'codex',
    );
    expect(available.entries.map(({ providerName }) => providerName)).toContain('exec_command');
    await commandTools.dispose();
    expect(disposeSessions).toHaveBeenCalledTimes(1);
    disposeSessions.mockRestore();
    await tools.dispose();
  });

  it('publishes a deterministic immutable catalog for API Providers', async () => {
    const { tools, context, snapshot } = await harness();
    expect(providerToolsFromSnapshot(snapshot).map(({ name }) => name)).toEqual([
      'list_workspace',
      'read_file',
      'request_user_input',
      'search_workspace',
      'update_plan',
      'view_image',
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    tools.finishTurn(context.taskId, context.turnId);
  });

  it('returns the durable approval decision as a user-input choice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sprint-coder-user-input-tool-'));
    roots.push(root);
    const workspace: EffectiveWorkspaceSet = {
      source: 'task',
      projectId: null,
      primaryRootId: 'root-a',
      roots: [
        { rootId: 'root-a', path: root, label: 'Workspace', role: 'primary', status: 'available' },
      ],
      digest: '9'.repeat(64),
    };
    const tools = new ProviderWorkspaceTools({
      workspaceFor: () => workspace,
      rootIdentityFor: () => undefined,
      policyEpochFor: () => 1,
      authorizer: ({ entry }) => ({
        decision: 'allow',
        reason: 'test-choice',
        ...(entry.providerName === 'request_user_input'
          ? { userInputSelection: 1 }
          : { approvalDecision: 'allow_once' as const }),
        beforeExecute: () => true,
      }),
    });
    const context = {
      taskId: 'task-choice',
      turnId: 'turn-choice',
      workspaceId: workspace.digest,
      policyEpoch: 1,
    } as const;
    tools.startTurn(context, 'codex');
    await expect(
      tools.broker.dispatch({
        ...context,
        callId: 'choice-call',
        providerName: 'request_user_input',
        input: { question: 'Choose', choices: ['one', 'two', 'three'] },
      }),
    ).resolves.toEqual({ question: 'Choose', selectedIndex: 1, selected: 'two' });
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
      workspaceFor: (_taskId, _turnId, callId) => {
        if (callId !== undefined) expect(callId).toBe('call-mkdir');
        return workspace;
      },
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
        createDirectory: async ({ path, guard, boundary }) => {
          expect(workspaceToolAuthorizationGuard({})).toBeUndefined();
          expect(guard.operation).toBe('write');
          expect(boundary?.workspace).toEqual(workspace);
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
      encoding: 'utf-8',
      byteLength: Buffer.byteLength('こんにちは\n'),
      truncated: false,
      range: { unit: 'byte', start: 0, end: Buffer.byteLength('こんにちは\n') },
      revision: { version: 1, tokenId: expect.any(String) },
    });
  });

  it('returns explicit line and UTF-8 byte ranges with truncation metadata', async () => {
    const { root, tools, context } = await harness();
    await writeFile(join(root, 'ranges.txt'), 'one\ntwo\n三\n');
    await expect(
      tools.broker.dispatch({
        ...context,
        callId: 'line-range',
        providerName: 'read_file',
        input: { path: 'ranges.txt', lineStart: 2, lineEnd: 3 },
      }),
    ).resolves.toMatchObject({
      content: 'two\n三',
      truncated: true,
      range: { unit: 'line', start: 2, end: 3 },
      encoding: 'utf-8',
    });
    await expect(
      tools.broker.dispatch({
        ...context,
        callId: 'byte-range',
        providerName: 'read_file',
        input: { path: 'ranges.txt', byteStart: 0, byteEnd: 3 },
      }),
    ).resolves.toMatchObject({
      content: 'one',
      truncated: true,
      range: { unit: 'byte', start: 0, end: 3 },
    });
  });

  it('views a bounded image by magic bytes through a guarded handle', async () => {
    const { root, tools, context } = await harness();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    await writeFile(join(root, 'pixel.bin'), png);
    await expect(
      tools.broker.dispatch({
        ...context,
        callId: 'view-image',
        providerName: 'view_image',
        input: { path: 'pixel.bin' },
      }),
    ).resolves.toMatchObject({
      path: 'pixel.bin',
      mimeType: 'image/png',
      byteLength: png.length,
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
    });
  });

  it('searches bounded UTF-8 files without following symlinks or disclosing secrets', async () => {
    const { root, tools, context } = await harness();
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'one.ts'), 'first\nneedle here\n');
    await writeFile(join(root, 'src', 'two.txt'), 'needle ignored by glob\n');
    await writeFile(
      join(root, 'src', 'secret.ts'),
      'API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456\nneedle\n',
    );
    if (process.platform !== 'win32') await symlink('/tmp', join(root, 'src', 'outside'));

    await expect(
      tools.broker.dispatch({
        ...context,
        callId: 'call-search',
        providerName: 'search_workspace',
        input: { path: 'src', query: 'needle', glob: '**/*.ts', maxResults: 20 },
      }),
    ).resolves.toMatchObject({
      path: 'src',
      matches: [{ path: 'src/one.ts', line: 2, text: 'needle here' }],
      withheldFiles: 1,
    });
  });

  it('searches file paths without reading file contents', async () => {
    const { root, tools, context } = await harness();
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'managed-harness.ts'), Buffer.from([0xff, 0xfe]));
    await writeFile(join(root, 'src', 'other.ts'), 'text');
    await expect(
      tools.broker.dispatch({
        ...context,
        callId: 'file-search',
        providerName: 'search_workspace',
        input: { mode: 'files', query: 'harness', glob: '**/*.ts' },
      }),
    ).resolves.toMatchObject({
      files: ['src/managed-harness.ts'],
      matches: [],
      withheldFiles: 0,
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

  it('binds secret-bearing content to disclosure facts and returns only the redacted result', async () => {
    const { root, tools, context } = await harness();
    await writeFile(join(root, 'notes.txt'), 'password=hunter2\n');

    await expect(
      tools.broker.dispatch({
        ...context,
        callId: 'call-secret',
        providerName: 'read_file',
        input: { path: 'notes.txt' },
      }),
    ).resolves.toMatchObject({ content: 'password=[REDACTED]\n' });
  });

  it('presents only a bounded redacted disclosure preview to the authorizer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sprint-coder-provider-disclosure-'));
    roots.push(root);
    await writeFile(join(root, '.env'), 'DATABASE_URL=postgres://alice:hunter2@example.com/db\n');
    const workspace: EffectiveWorkspaceSet = {
      source: 'task',
      projectId: null,
      primaryRootId: 'root-a',
      roots: [
        { rootId: 'root-a', path: root, label: 'Workspace', role: 'primary', status: 'available' },
      ],
      digest: 'd'.repeat(64),
    };
    let facts: ReturnType<typeof providerDisclosureAuthorizationFacts>;
    let permissionFacts: ReturnType<typeof approvalFactsForTool> | undefined;
    const tools = new ProviderWorkspaceTools({
      workspaceFor: () => workspace,
      rootIdentityFor: () => undefined,
      policyEpochFor: () => 1,
      authorizer: (request) => {
        const { input } = request;
        facts = providerDisclosureAuthorizationFacts(input);
        permissionFacts = approvalFactsForTool(request, 'workspace.read');
        return { decision: 'deny', reason: 'user_denied' };
      },
    });
    const context = {
      taskId: 'task-disclosure',
      turnId: 'turn-disclosure',
      workspaceId: workspace.digest,
      policyEpoch: 1,
    } as const;
    tools.startTurn(context, 'openai');

    await expect(
      tools.broker.dispatch({
        ...context,
        callId: 'call-denied-disclosure',
        providerName: 'read_file',
        input: { path: '.env' },
      }),
    ).rejects.toThrow(/authorization deny/u);
    expect(facts).toMatchObject({
      classification: 'sensitive',
      reasons: expect.arrayContaining(['credential-prone-filename', 'uri-userinfo']),
    });
    expect(facts?.preview).not.toContain('hunter2');
    expect(permissionFacts).toMatchObject({
      resource: {
        kind: 'provider-disclosure',
        sourceDigest: facts?.sourceDigest,
        disclosedDigest: facts?.disclosedDigest,
      },
      resourceSet: { kind: 'provider-disclosure-exact' },
    });
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

  it('executes a Worker mutation against its call-bound isolated Workspace', async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'sprint-coder-provider-parent-'));
    const workerRoot = await mkdtemp(join(tmpdir(), 'sprint-coder-provider-worker-'));
    roots.push(parentRoot, workerRoot);
    const makeWorkspace = (path: string, digest: string): EffectiveWorkspaceSet => ({
      source: 'task',
      projectId: null,
      primaryRootId: 'root-a',
      roots: [{ rootId: 'root-a', path, label: 'Workspace', role: 'primary', status: 'available' }],
      digest,
    });
    const parent = makeWorkspace(parentRoot, '1'.repeat(64));
    const worker = makeWorkspace(workerRoot, '2'.repeat(64));
    const binding = await workspaceMutationBinding(workerRoot);
    const applied: unknown[] = [];
    const tools = new ProviderWorkspaceTools({
      workspaceFor: (_taskId, _turnId, callId) => (callId === 'worker-create' ? worker : parent),
      rootIdentityFor: () => undefined,
      mutationBindingFor: (_turnId, _rootId, callId) =>
        callId === 'worker-create' ? binding : undefined,
      policyEpochFor: () => 1,
      authorizer: () => ({ decision: 'allow', reason: 'test', beforeExecute: () => true }),
      workspaceEdit: {
        turnWorkspaceSetFor: () => parent,
        turnRootMutationBindingsFor: () => new Map(),
        revisions: new FileRevisionRegistry(),
        apply: async (request) => {
          applied.push(request);
          return { id: 'worker-saga', state: 'committed' } as never;
        },
        policyEpochFor: () => 1,
      },
    });
    const context = {
      taskId: 'task-worker',
      turnId: 'turn-parent',
      workspaceId: parent.digest,
      policyEpoch: 1,
    } as const;
    tools.startTurn(context, 'codex');
    await expect(
      tools.broker.dispatch({
        ...context,
        callId: 'worker-create',
        providerName: 'create_file',
        input: { path: 'worker-only.txt', content: 'isolated\n' },
      }),
    ).resolves.toMatchObject({ state: 'committed', kind: 'add' });
    expect(applied[0]).toMatchObject({
      mutationBinding: {
        workspaceKey: binding.workspaceKey,
        rootIdentityDigest: binding.rootIdentityDigest,
      },
      plan: {
        operations: [
          expect.objectContaining({
            canonicalPath: join(binding.canonicalPath, 'worker-only.txt'),
          }),
        ],
      },
    });
  });

  it('dispatches a revision-bound multi-file apply_patch batch through one Saga', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sprint-coder-provider-batch-'));
    roots.push(root);
    await writeFile(join(root, 'one.txt'), 'before\n');
    const workspace: EffectiveWorkspaceSet = {
      source: 'task',
      projectId: null,
      primaryRootId: 'root-a',
      roots: [
        { rootId: 'root-a', path: root, label: 'Workspace', role: 'primary', status: 'available' },
      ],
      digest: 'f'.repeat(64),
    };
    const revisions = new FileRevisionRegistry();
    const applied: unknown[] = [];
    const tools = new ProviderWorkspaceTools({
      workspaceFor: () => workspace,
      rootIdentityFor: () => undefined,
      policyEpochFor: () => 1,
      authorizer: ({ input }) => {
        if (workspaceToolAuthorizationGuards(input, 'write').length > 0)
          expect(workspaceToolAuthorizationGuards(input, 'write')).toHaveLength(2);
        return { decision: 'allow', reason: 'test', beforeExecute: () => true };
      },
      workspaceEdit: {
        turnWorkspaceSetFor: () => workspace,
        turnRootMutationBindingsFor: () => new Map(),
        revisions,
        apply: async (request) => {
          applied.push(request);
          return { id: 'batch-saga', state: 'committed' } as never;
        },
        policyEpochFor: () => 1,
      },
    });
    const context = {
      taskId: 'task-batch',
      turnId: 'turn-batch',
      workspaceId: workspace.digest,
      policyEpoch: 1,
    } as const;
    tools.startTurn(context, 'ollama');
    const read = (await tools.broker.dispatch({
      ...context,
      callId: 'batch-read',
      providerName: 'read_file',
      input: { path: 'one.txt' },
    })) as { revision: { version: 1; tokenId: string } };
    await expect(
      tools.broker.dispatch({
        ...context,
        callId: 'batch-patch',
        providerName: 'apply_patch',
        input: {
          operations: [
            {
              kind: 'update',
              path: 'one.txt',
              revision: read.revision,
              edits: [{ oldText: 'before', newText: 'after' }],
            },
            { kind: 'add', path: 'two.txt', content: 'new\n' },
          ],
        },
      }),
    ).resolves.toMatchObject({ state: 'committed', operations: 2 });
    expect(applied).toHaveLength(1);
  });
});
