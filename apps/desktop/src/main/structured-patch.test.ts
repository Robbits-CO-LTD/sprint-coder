import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileRevisionRegistry } from './file-revision';
import { PatchValidationError, prepareStructuredPatch } from './structured-patch';

const roots: string[] = [];
const owner = { taskId: 'task-1', turnId: 'turn-1' } as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'sprint-coder-patch-'));
  roots.push(workspace);
  await mkdir(join(workspace, 'src'));
  await writeFile(join(workspace, 'src', 'a.txt'), 'alpha beta gamma\n');
  await writeFile(join(workspace, 'src', 'b.txt'), 'unchanged\n');
  const registry = new FileRevisionRegistry();
  const a = await registry.read({
    owner,
    workspacePath: workspace,
    targetPath: 'src/a.txt',
    policyEpoch: 1,
  });
  const b = await registry.read({
    owner,
    workspacePath: workspace,
    targetPath: 'src/b.txt',
    policyEpoch: 1,
  });
  return { workspace, registry, a, b };
}

describe('structured patch preparation', () => {
  it('validates the complete set and seals deterministic pre/post images without writing', async () => {
    const { workspace, registry, a } = await fixture();
    const plan = await prepareStructuredPatch({
      owner,
      workspacePath: workspace,
      policyEpoch: 1,
      registry,
      operations: [
        {
          kind: 'update',
          path: 'src/a.txt',
          revision: a.reference,
          edits: [{ oldText: 'beta', newText: 'BETA' }],
        },
        { kind: 'add', path: 'src/new.txt', content: 'new file\n' },
      ],
    });

    expect(plan.operations).toEqual([
      expect.objectContaining({
        kind: 'update',
        preImage: 'alpha beta gamma\n',
        postImage: 'alpha BETA gamma\n',
        preRevision: expect.objectContaining({
          identityDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          nlink: 1,
        }),
      }),
      expect.objectContaining({
        kind: 'add',
        preImage: null,
        preRevision: null,
        postImage: 'new file\n',
      }),
    ]);
    expect(plan.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(
      await import('node:fs/promises').then(({ readFile }) =>
        readFile(join(workspace, 'src/a.txt'), 'utf8'),
      ),
    ).toBe('alpha beta gamma\n');
  });

  it('rejects missing, ambiguous, and overlapping anchors', async () => {
    const { workspace, registry, a } = await fixture();
    for (const edits of [
      [{ oldText: 'absent', newText: 'x' }],
      [{ oldText: 'a', newText: 'x' }],
      [
        { oldText: 'alpha beta', newText: 'x' },
        { oldText: 'beta gamma', newText: 'y' },
      ],
    ])
      await expect(
        prepareStructuredPatch({
          owner,
          workspacePath: workspace,
          policyEpoch: 1,
          registry,
          operations: [{ kind: 'update', path: 'src/a.txt', revision: a.reference, edits }],
        }),
      ).rejects.toBeInstanceOf(PatchValidationError);
  });

  it('rejects aliases, destination collisions, hardlinks, and stale members before any effect', async () => {
    const { workspace, registry, a, b } = await fixture();
    await expect(
      prepareStructuredPatch({
        owner,
        workspacePath: workspace,
        policyEpoch: 1,
        registry,
        operations: [
          { kind: 'delete', path: 'src/a.txt', revision: a.reference },
          { kind: 'rename', path: 'src/b.txt', destination: 'src/a.txt', revision: b.reference },
        ],
      }),
    ).rejects.toMatchObject({ code: 'PATH_COLLISION' } satisfies Partial<PatchValidationError>);

    await writeFile(join(workspace, 'src', 'b.txt'), 'external drift\n');
    await expect(
      prepareStructuredPatch({
        owner,
        workspacePath: workspace,
        policyEpoch: 1,
        registry,
        operations: [
          {
            kind: 'update',
            path: 'src/a.txt',
            revision: a.reference,
            edits: [{ oldText: 'beta', newText: 'B' }],
          },
          { kind: 'delete', path: 'src/b.txt', revision: b.reference },
        ],
      }),
    ).rejects.toBeDefined();
    expect(
      await import('node:fs/promises').then(({ readFile }) =>
        readFile(join(workspace, 'src/a.txt'), 'utf8'),
      ),
    ).toBe('alpha beta gamma\n');
  });
});
