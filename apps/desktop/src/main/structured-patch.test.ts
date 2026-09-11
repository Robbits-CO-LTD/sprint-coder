import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
  it('preserves intentional literal escapes when the exact anchor already matches', async () => {
    const { workspace, registry, a } = await fileFixture('const pattern = "\\n";\n');
    const patch = await prepareStructuredPatch({
      owner,
      workspacePath: workspace,
      policyEpoch: 1,
      registry,
      operations: [
        {
          kind: 'update',
          path: 'src/a.txt',
          revision: a.reference,
          edits: [{ oldText: '"\\n"', newText: '"\\r\\n"' }],
        },
      ],
    });
    expect(patch.operations[0]?.postImage).toBe('const pattern = "\\r\\n";\n');
  });
  it.each(['\n', '\r\n'])(
    'identifies literal newline escapes without applying them (%j)',
    async (lineEnding) => {
      const content = [
        'def line_total(unit_cents, quantity):',
        '    return unit_cents + quantity',
        '',
      ].join(lineEnding);
      const escaped = content.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
      const failure = await anchorFailure(content, [{ oldText: escaped, newText: 'replacement' }]);
      expect(failure.code).toBe('ANCHOR_NOT_FOUND');
      expect(failure.recovery).toMatchObject({ cause: 'escaped_whitespace', nearest: null });
    },
  );

  it('does not blame escaping when decoded text is also unrelated', async () => {
    const failure = await anchorFailure('alpha\nbeta\n', [
      { oldText: 'other\\nregion', newText: 'x' },
    ]);
    expect(failure.recovery?.cause).toBe('absent');
  });

  it.each([
    ['first\r\nsecond\r\n', 'first\\nsecond\\n'],
    ['first\nsecond\n', 'first\\r\\nsecond\\r\\n'],
    ['first\n\tsecond\n', 'first\\n\\tsecond\\n'],
  ])(
    'identifies escaped whitespace combined with line endings or tabs',
    async (content, oldText) => {
      const failure = await anchorFailure(content, [{ oldText, newText: 'x' }]);
      expect(failure.code).toBe('ANCHOR_NOT_FOUND');
      expect(failure.recovery?.cause).toBe('escaped_whitespace');
    },
  );

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

  it.each(['add', 'mkdir', 'rename'] as const)(
    'checks missing %s endpoints using the parent directory case rules before any effect',
    async (kind) => {
      const { workspace, registry, a } = await fixture();
      const insensitive = (await stat(join(workspace, 'src/A.txt')).catch(() => null)) !== null;
      const before = await readdir(join(workspace, 'src'));
      const patch = prepareStructuredPatch({
        owner,
        workspacePath: workspace,
        policyEpoch: 1,
        registry,
        operations: [
          kind === 'rename'
            ? { kind, path: 'src/a.txt', destination: 'src/New.txt', revision: a.reference }
            : kind === 'mkdir'
              ? { kind, path: 'src/New.txt' }
              : { kind, path: 'src/New.txt', content: 'first' },
          { kind: 'add', path: 'src/new.txt', content: 'second' },
        ],
      });
      if (insensitive) await expect(patch).rejects.toMatchObject({ code: 'PATH_COLLISION' });
      else await expect(patch).resolves.toMatchObject({ operations: [{}, {}] });
      expect(await readdir(join(workspace, 'src'))).toEqual(before);
      expect(await readFile(join(workspace, 'src/a.txt'), 'utf8')).toBe('alpha beta gamma\n');
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'preserves distinct Windows Unicode names for new files',
    async () => {
      const { workspace, registry } = await fixture();
      const paths = ['src/straße.txt', 'src/strasse.txt', 'src/é.txt', 'src/e\u0301.txt'];
      const patch = await prepareStructuredPatch({
        owner,
        workspacePath: workspace,
        policyEpoch: 1,
        registry,
        operations: paths.map((path) => ({ kind: 'add' as const, path, content: path })),
      });
      expect(patch.operations).toHaveLength(4);
      for (const path of paths) await writeFile(join(workspace, path), path, { flag: 'wx' });
      for (const path of paths) expect(await readFile(join(workspace, path), 'utf8')).toBe(path);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'keeps dotted and dotless i as distinct new names',
    async () => {
      const { workspace, registry } = await fixture();
      const paths = ['src/i.txt', 'src/ı.txt'];
      for (const path of paths) await writeFile(join(workspace, path), path, { flag: 'wx' });
      for (const path of paths) expect(await readFile(join(workspace, path), 'utf8')).toBe(path);
      for (const path of paths) await rm(join(workspace, path));
      const patch = await prepareStructuredPatch({
        owner,
        workspacePath: workspace,
        policyEpoch: 1,
        registry,
        operations: paths.map((path) => ({ kind: 'add' as const, path, content: path })),
      });
      expect(patch.operations).toHaveLength(2);
    },
  );

  it('rejects two differently cased references to the same file before preparing effects', async ({
    skip,
  }) => {
    const { workspace, registry, a } = await fixture();
    const alias = join(workspace, 'src', 'A.txt');
    const aliasStat = await stat(alias).catch(() => null);
    if (aliasStat === null) {
      skip();
      return;
    }
    const other = await registry.read({
      owner,
      workspacePath: workspace,
      targetPath: 'src/A.txt',
      policyEpoch: 1,
    });
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
            edits: [{ oldText: 'beta', newText: 'first' }],
          },
          {
            kind: 'update',
            path: 'src/A.txt',
            revision: other.reference,
            edits: [{ oldText: 'beta', newText: 'second' }],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'PATH_COLLISION' });
    expect(await readFile(join(workspace, 'src/a.txt'), 'utf8')).toBe('alpha beta gamma\n');
    expect((await stat(alias)).ino).toBe(aliasStat.ino);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects actual symlink aliases before preparing effects',
    async () => {
      const { workspace, registry, a } = await fixture();
      // File symlinks are refused at the read boundary. A directory alias can be
      // read and must still converge when its regular-file endpoints are claimed.
      await symlink('src', join(workspace, 'alias-src'), 'dir');
      const alias = await registry.read({
        owner,
        workspacePath: workspace,
        targetPath: 'alias-src/a.txt',
        policyEpoch: 1,
      });
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
              edits: [{ oldText: 'beta', newText: 'first' }],
            },
            {
              kind: 'update',
              path: 'alias-src/a.txt',
              revision: alias.reference,
              edits: [{ oldText: 'beta', newText: 'second' }],
            },
          ],
        }),
      ).rejects.toMatchObject({ code: 'PATH_COLLISION' });
      expect(await readFile(join(workspace, 'src/a.txt'), 'utf8')).toBe('alpha beta gamma\n');
    },
  );

  it('preserves distinct case-sensitive files as separate endpoints', async ({ skip }) => {
    const { workspace, registry, a } = await fixture();
    if (await stat(join(workspace, 'src/A.txt')).catch(() => null))
      return skip('The fixture filesystem is case-insensitive');
    await writeFile(join(workspace, 'src/A.txt'), 'separate');
    const alternate = await registry.read({
      owner,
      workspacePath: workspace,
      targetPath: 'src/A.txt',
      policyEpoch: 1,
    });
    const patch = await prepareStructuredPatch({
      owner,
      workspacePath: workspace,
      policyEpoch: 1,
      registry,
      operations: [
        {
          kind: 'update',
          path: 'src/a.txt',
          revision: a.reference,
          edits: [{ oldText: 'beta', newText: 'first' }],
        },
        {
          kind: 'update',
          path: 'src/A.txt',
          revision: alternate.reference,
          edits: [{ oldText: 'separate', newText: 'second' }],
        },
      ],
    });
    expect(new Set(patch.operations.map((operation) => operation.canonicalPath)).size).toBe(2);
  });
});
