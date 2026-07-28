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

/** A workspace holding one file with exactly `content`, plus a revision reference for it. */
async function fileFixture(content: string) {
  const workspace = await mkdtemp(join(tmpdir(), 'sprint-coder-anchor-'));
  roots.push(workspace);
  await mkdir(join(workspace, 'src'));
  await writeFile(join(workspace, 'src', 'a.txt'), content);
  const registry = new FileRevisionRegistry();
  const a = await registry.read({
    owner,
    workspacePath: workspace,
    targetPath: 'src/a.txt',
    policyEpoch: 1,
  });
  return { workspace, registry, a };
}

/** Runs one update patch and returns the error it threw. */
async function anchorFailure(
  content: string,
  edits: readonly Readonly<{ oldText: string; newText: string }>[],
): Promise<PatchValidationError> {
  const { workspace, registry, a } = await fileFixture(content);
  try {
    await prepareStructuredPatch({
      owner,
      workspacePath: workspace,
      policyEpoch: 1,
      registry,
      operations: [{ kind: 'update', path: 'src/a.txt', revision: a.reference, edits }],
    });
  } catch (error) {
    return error as PatchValidationError;
  }
  throw new Error('expected the patch to be rejected');
}

const SOURCE = [
  'function alpha(input) {',
  '  return input + 1;',
  '}',
  '',
  'function beta(input) {',
  '  return input * 2;',
  '}',
  '',
].join('\n');

describe('anchor failure recovery', () => {
  it('names the near-miss when only line endings differ', async () => {
    const failure = await anchorFailure(SOURCE, [
      { oldText: 'function alpha(input) {\r\n  return input + 1;\r\n}', newText: 'x' },
    ]);
    expect(failure.code).toBe('ANCHOR_NOT_FOUND');
    expect(failure.recovery).toMatchObject({ editIndex: 0, cause: 'line_ending', nearest: null });
  });

  it('names the near-miss when only trailing whitespace differs', async () => {
    const failure = await anchorFailure(SOURCE, [
      { oldText: '  return input + 1;   ', newText: 'x' },
    ]);
    expect(failure.recovery).toMatchObject({ cause: 'trailing_whitespace' });
  });

  it('names the near-miss when only indentation differs', async () => {
    const failure = await anchorFailure(SOURCE, [
      { oldText: '    return input + 1;', newText: 'x' },
    ]);
    expect(failure.recovery).toMatchObject({ cause: 'indentation' });
  });

  it('returns the current text of a drifted region so the caller can retry without re-reading', async () => {
    const failure = await anchorFailure(SOURCE, [
      { oldText: 'function beta(input) {\n  return input - 2;\n}', newText: 'x' },
    ]);
    expect(failure.recovery).toEqual({
      editIndex: 0,
      cause: 'drifted',
      occurrences: [5],
      nearest: {
        line: 5,
        text: 'function beta(input) {\n  return input * 2;\n}',
        truncated: false,
      },
    });
  });

  it('lists the candidate lines when the opening line appears more than once', async () => {
    const failure = await anchorFailure(SOURCE, [
      { oldText: '}\nSOMETHING THAT IS NOT THERE', newText: 'x' },
    ]);
    expect(failure.recovery).toMatchObject({
      cause: 'drifted',
      occurrences: [3, 7],
      nearest: null,
    });
  });

  it('reports absent rather than guessing when nothing resembles the anchor', async () => {
    const failure = await anchorFailure(SOURCE, [
      { oldText: 'function gamma(input) {\n  return 0;\n}', newText: 'x' },
    ]);
    expect(failure.recovery).toEqual({
      editIndex: 0,
      cause: 'absent',
      occurrences: [],
      nearest: null,
    });
  });

  it('does not treat a whitespace-only anchor as a normalized match for the empty string', async () => {
    const failure = await anchorFailure(SOURCE, [{ oldText: '   ', newText: 'x' }]);
    expect(failure.recovery).toEqual({
      editIndex: 0,
      cause: 'absent',
      occurrences: [],
      nearest: null,
    });
  });

  it('includes leading blank lines in the reusable drifted region', async () => {
    const failure = await anchorFailure(SOURCE, [
      { oldText: '\nfunction beta(input) {\n  return input - 2;\n}', newText: 'x' },
    ]);
    expect(failure.recovery).toMatchObject({
      cause: 'drifted',
      nearest: {
        line: 4,
        text: '\nfunction beta(input) {\n  return input * 2;\n}',
      },
    });
  });

  it('diagnoses long non-trailing whitespace runs without pathological backtracking', async () => {
    const content = `${' '.repeat(50_000)}x\n`;
    const failure = await anchorFailure(content, [{ oldText: 'not present', newText: 'x' }]);
    expect(failure.recovery?.cause).toBe('absent');
  }, 2_000);

  it('reports absent rather than pointing at one of many identical opening lines', async () => {
    const content = `${Array.from({ length: 12 }, () => 'x = 1;').join('\n')}\n`;
    const failure = await anchorFailure(content, [
      { oldText: 'x = 1;\nNOT PRESENT', newText: 'y' },
    ]);
    expect(failure.recovery).toMatchObject({ cause: 'absent', occurrences: [] });
  });

  it('identifies which edit of a batch failed', async () => {
    const failure = await anchorFailure(SOURCE, [
      { oldText: '  return input + 1;', newText: 'a' },
      { oldText: 'function gamma() {}', newText: 'b' },
    ]);
    expect(failure.recovery?.editIndex).toBe(1);
  });

  it('reports every occurrence of an ambiguous anchor by line', async () => {
    const failure = await anchorFailure(SOURCE, [{ oldText: 'input', newText: 'x' }]);
    expect(failure.code).toBe('ANCHOR_AMBIGUOUS');
    expect(failure.recovery).toEqual({
      editIndex: 0,
      cause: 'ambiguous',
      occurrences: [1, 2, 5, 6],
      nearest: null,
    });
  });

  it('bounds the returned region so a large file cannot become a large message', async () => {
    const padding = 'padding line long enough to add up over two hundred lines';
    const content = `MARKER\n${Array.from({ length: 300 }, () => padding).join('\n')}\n`;
    const failure = await anchorFailure(content, [
      {
        oldText: ['MARKER', ...Array.from({ length: 199 }, () => 'nope')].join('\n'),
        newText: 'x',
      },
    ]);
    expect(failure.recovery?.nearest?.truncated).toBe(true);
    expect(Buffer.byteLength(failure.recovery?.nearest?.text ?? '', 'utf8')).toBeLessThanOrEqual(
      4096,
    );
  });

  it('leaves every non-anchor failure without a recovery payload', async () => {
    const failure = await anchorFailure(SOURCE, [{ oldText: '', newText: 'x' }]);
    expect(failure.code).toBe('INVALID_PATCH');
    expect(failure.recovery).toBeNull();
  });
});

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
