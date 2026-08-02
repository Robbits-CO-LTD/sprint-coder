import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileRevisionRegistry } from './file-revision';
import {
  executeWorkspacePatch,
  WorkspacePatchRejection,
  WORKSPACE_PATCH_TOOL,
  type WorkspacePatchDeps,
} from './workspace-patch-tool';
import type { EditSagaApplyRequest, EditSagaSnapshot } from './edit-saga';
import { workspaceMutationBinding } from './path-guard';

const roots: string[] = [];
const context = { taskId: 'task-1', turnId: 'turn-1' } as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const SOURCE = ['function alpha(input) {', '  return input + 1;', '}', ''].join('\n');

async function harness(content = SOURCE) {
  const workspace = await mkdtemp(join(tmpdir(), 'sprint-coder-patch-tool-'));
  roots.push(workspace);
  await mkdir(join(workspace, 'src'));
  await writeFile(join(workspace, 'src', 'a.txt'), content);
  const identity = await workspaceMutationBinding(workspace);
  const applied: EditSagaApplyRequest[] = [];
  const deps: WorkspacePatchDeps = {
    turnWorkspaceSetFor: () => ({
      source: 'project',
      projectId: 'project-1',
      primaryRootId: 'root-a',
      roots: [
        {
          rootId: 'root-a',
          path: workspace,
          label: 'a',
          role: 'primary',
          status: 'available',
        },
      ],
      digest: 'a'.repeat(64),
    }),
    turnRootIdentitiesFor: () => new Map([['root-a', identity.rootIdentityDigest]]),
    revisions: new FileRevisionRegistry(),
    policyEpochFor: () => 1,
    apply: async (request) => {
      applied.push(request);
      return { id: request.id, state: 'committed' } as unknown as EditSagaSnapshot;
    },
  };
  return { workspace, deps, applied };
}

describe('the agent edit tool', () => {
  it('declares both capabilities used by its read-before-write behavior', () => {
    expect(WORKSPACE_PATCH_TOOL.kind).toBe('fileWrite');
    expect(WORKSPACE_PATCH_TOOL.sideEffect).toBe('write');
    expect(WORKSPACE_PATCH_TOOL.risk).toBe('high');
    expect(WORKSPACE_PATCH_TOOL.requiredCapabilities).toEqual([
      'workspace.read',
      'workspace.write',
    ]);
    expect(WORKSPACE_PATCH_TOOL.workspaceBinding.kind).toBe('any');
  });

  it('publishes the same non-empty edit constraint that execution enforces', () => {
    const schema = WORKSPACE_PATCH_TOOL.inputSchema as {
      properties: { edits: { minItems?: number } };
    };
    expect(schema.properties.edits.minItems).toBe(1);
  });

  it('hands a validated plan to the Saga rather than writing anything itself', async () => {
    const { workspace, deps, applied } = await harness();
    const result = await executeWorkspacePatch(
      { path: 'src/a.txt', edits: [{ oldText: '  return input + 1;', newText: '  return 42;' }] },
      context,
      deps,
    );
    expect(result).toMatchObject({ path: 'src/a.txt', state: 'committed', edits: 1 });
    expect(applied).toHaveLength(1);
    expect(applied[0]?.plan.operations[0]).toMatchObject({
      kind: 'update',
      postImage: 'function alpha(input) {\n  return 42;\n}\n',
    });
    // The tool is not an effect boundary: the file is untouched until the Saga applies the plan.
    expect(await readFile(join(workspace, 'src/a.txt'), 'utf8')).toBe(SOURCE);
  });

  it('selects a Secondary by rootId and never falls through to the Primary', async () => {
    const { workspace: primary, deps, applied } = await harness('primary only\n');
    const primaryIdentity = await workspaceMutationBinding(primary);
    const secondary = await mkdtemp(join(tmpdir(), 'sprint-coder-patch-tool-secondary-'));
    roots.push(secondary);
    await mkdir(join(secondary, 'src'));
    await writeFile(join(secondary, 'src', 'a.txt'), SOURCE);
    const secondaryIdentity = await workspaceMutationBinding(secondary);
    const result = await executeWorkspacePatch(
      {
        rootId: 'root-b',
        path: 'src/a.txt',
        edits: [{ oldText: '  return input + 1;', newText: '  return 42;' }],
      },
      context,
      {
        ...deps,
        turnWorkspaceSetFor: () => ({
          source: 'project',
          projectId: 'project-1',
          primaryRootId: 'root-a',
          roots: [
            {
              rootId: 'root-a',
              path: primary,
              label: 'a',
              role: 'primary',
              status: 'available',
            },
            {
              rootId: 'root-b',
              path: secondary,
              label: 'b',
              role: 'secondary',
              status: 'available',
            },
          ],
          digest: 'b'.repeat(64),
        }),
        turnRootIdentitiesFor: () =>
          new Map([
            ['root-a', primaryIdentity.rootIdentityDigest],
            ['root-b', secondaryIdentity.rootIdentityDigest],
          ]),
      },
    );
    expect(result.rootId).toBe('root-b');
    expect(applied[0]?.plan.operations[0]?.canonicalPath).toBe(
      join(await realpath(secondary), 'src/a.txt'),
    );
    expect(await readFile(join(primary, 'src/a.txt'), 'utf8')).toBe('primary only\n');
  });

  it('rejects an unknown rootId before reading a same-relative-path file', async () => {
    const { deps } = await harness();
    await expect(
      executeWorkspacePatch(
        {
          rootId: 'forged-root',
          path: 'src/a.txt',
          edits: [{ oldText: 'x', newText: 'y' }],
        },
        context,
        deps,
      ),
    ).rejects.toThrow('valid Workspace rootId');
  });

  it('rejects a replacement directory at the sealed root path', async () => {
    const { workspace, deps } = await harness();
    await rm(workspace, { recursive: true });
    await mkdir(join(workspace, 'src'), { recursive: true });
    await writeFile(join(workspace, 'src', 'a.txt'), SOURCE);

    await expect(
      executeWorkspacePatch(
        {
          path: 'src/a.txt',
          edits: [{ oldText: '  return input + 1;', newText: '  return 42;' }],
        },
        context,
        deps,
      ),
    ).rejects.toMatchObject({ code: 'IDENTITY_CHANGED' });
  });

  it('reports the Saga state instead of claiming success for a patch that did not commit', async () => {
    const { deps } = await harness();
    const result = await executeWorkspacePatch(
      { path: 'src/a.txt', edits: [{ oldText: '}', newText: '};' }] },
      context,
      { ...deps, apply: async (request) => ({ id: request.id, state: 'restored' }) as never },
    );
    expect(result.state).toBe('restored');
  });
});

describe('what the model is told when a patch is rejected', () => {
  it('returns the anchor diagnosis, not a bare validation message', async () => {
    const { deps } = await harness();
    const failure = await executeWorkspacePatch(
      { path: 'src/a.txt', edits: [{ oldText: '    return input + 1;', newText: 'x' }] },
      context,
      deps,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WorkspacePatchRejection);
    expect((failure as Error).message).toContain('indentation');
    expect((failure as Error).message).toContain('Do not re-read');
  });

  it('hands back the current text when the region drifted', async () => {
    const { deps } = await harness();
    const failure = await executeWorkspacePatch(
      {
        path: 'src/a.txt',
        edits: [{ oldText: 'function alpha(input) {\n  return 0;\n}' }].map((edit) => ({
          ...edit,
          newText: 'x',
        })),
      },
      context,
      deps,
    ).catch((error: unknown) => error);
    expect((failure as Error).message).toContain('return input + 1;');
    expect((failure as Error).message).toContain('verbatim');
  });

  it('does not run the Saga for a patch that failed validation', async () => {
    const { deps, applied } = await harness();
    await executeWorkspacePatch(
      { path: 'src/a.txt', edits: [{ oldText: 'nowhere at all', newText: 'x' }] },
      context,
      deps,
    ).catch(() => undefined);
    expect(applied).toEqual([]);
  });
});

describe('refusing malformed or unsupported requests', () => {
  it('requires a selected Workspace', async () => {
    const { deps } = await harness();
    await expect(
      executeWorkspacePatch(
        { path: 'src/a.txt', edits: [{ oldText: 'a', newText: 'b' }] },
        context,
        {
          ...deps,
          turnWorkspaceSetFor: () => ({
            source: 'none',
            projectId: null,
            primaryRootId: null,
            roots: [],
            digest: '0'.repeat(64),
          }),
        },
      ),
    ).rejects.toThrow('requires a selected Workspace');
  });

  it.each([
    ['a non-object', 'nope'],
    ['a missing path', { edits: [{ oldText: 'a', newText: 'b' }] }],
    ['an empty edit list', { path: 'src/a.txt', edits: [] }],
    ['an edit missing newText', { path: 'src/a.txt', edits: [{ oldText: 'a' }] }],
  ])('rejects %s', async (_label, input) => {
    const { deps } = await harness();
    await expect(executeWorkspacePatch(input, context, deps)).rejects.toBeInstanceOf(Error);
  });

  it('refuses a path outside the Workspace', async () => {
    const { deps } = await harness();
    await expect(
      executeWorkspacePatch(
        { path: '../escape.txt', edits: [{ oldText: 'a', newText: 'b' }] },
        context,
        deps,
      ),
    ).rejects.toBeInstanceOf(Error);
  });
});
