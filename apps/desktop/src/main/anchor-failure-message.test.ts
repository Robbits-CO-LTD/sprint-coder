import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileRevisionRegistry } from './file-revision';
import { PatchValidationError, prepareStructuredPatch } from './structured-patch';
import { describeAnchorFailure } from './anchor-failure-message';

const roots: string[] = [];
const owner = { taskId: 'task-1', turnId: 'turn-1' } as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Drives the real diagnosis rather than hand-building a recovery payload. */
async function messageFor(
  content: string,
  edits: readonly Readonly<{ oldText: string; newText: string }>[],
): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'sprint-coder-anchor-msg-'));
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
  try {
    await prepareStructuredPatch({
      owner,
      workspacePath: workspace,
      policyEpoch: 1,
      registry,
      operations: [{ kind: 'update', path: 'src/a.txt', revision: a.reference, edits }],
    });
  } catch (error) {
    return describeAnchorFailure(error as PatchValidationError) ?? '(no recovery)';
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

describe('telling a model why its edit did not apply', () => {
  it('says which edit of the batch failed', async () => {
    const message = await messageFor(SOURCE, [
      { oldText: '  return input + 1;', newText: 'a' },
      { oldText: 'function gamma() {}', newText: 'b' },
    ]);
    expect(message.startsWith('edits[1] did not apply:')).toBe(true);
  });

  it.each([
    ['line endings', 'function alpha(input) {\r\n  return input + 1;\r\n}', 'line endings'],
    ['trailing whitespace', '  return input + 1;   ', 'trailing whitespace'],
    ['indentation', '    return input + 1;', 'indentation'],
  ])(
    'names a %s near-miss and does not send the model back to the file',
    async (_label, oldText, expected) => {
      const message = await messageFor(SOURCE, [{ oldText, newText: 'x' }]);
      expect(message).toContain(expected);
      expect(message).toContain('Do not re-read');
    },
  );

  it('hands back the current text of a drifted region, ready to reuse', async () => {
    const message = await messageFor(SOURCE, [
      { oldText: 'function beta(input) {\n  return input - 2;\n}', newText: 'x' },
    ]);
    expect(message).toContain('the file has moved on');
    expect(message).toContain('what is at line 5 now');
    expect(message).toContain('  function beta(input) {');
    expect(message).toContain('    return input * 2;');
    expect(message).toContain('Use that text verbatim as the anchor and retry');
    expect(message).toContain('Do not re-read');
  });

  it('lists the candidates when the opening line appears in several places', async () => {
    const message = await messageFor(SOURCE, [
      { oldText: '}\nSOMETHING THAT IS NOT THERE', newText: 'x' },
    ]);
    expect(message).toContain('now appears at lines 3, 7.');
    expect(message).toContain('Anchor to whichever of those you meant');
  });

  it('tells the model to lengthen an ambiguous anchor, and where it matched', async () => {
    const message = await messageFor(SOURCE, [{ oldText: 'input', newText: 'x' }]);
    expect(message).toContain('appears more than once');
    expect(message).toContain('currently appears at lines 1, 2, 5, 6.');
    expect(message).toContain('Extend the anchor');
  });

  it('reserves the advice to re-read for the one case that needs it', async () => {
    const message = await messageFor(SOURCE, [
      { oldText: 'function gamma(input) {\n  return 0;\n}', newText: 'x' },
    ]);
    expect(message).toContain('nothing in the file resembles the anchor');
    expect(message).toContain('worth re-reading');
  });

  it('says a returned region was cut, and does not claim it can be reused whole', async () => {
    const padding = 'padding line long enough to add up over two hundred lines';
    const content = `MARKER\n${Array.from({ length: 300 }, () => padding).join('\n')}\n`;
    const message = await messageFor(content, [
      {
        oldText: ['MARKER', ...Array.from({ length: 199 }, () => 'nope')].join('\n'),
        newText: 'x',
      },
    ]);
    expect(message).toContain('(truncated)');
    expect(message).toContain('Anchor to a part of this you can see in full');
    expect(message).not.toContain('verbatim');
  });

  it('says nothing for a failure that carries no recovery data', () => {
    expect(
      describeAnchorFailure(new PatchValidationError('PATH_COLLISION', 'collision')),
    ).toBeNull();
  });

  it('uses the singular when only one line matched', () => {
    const error = new PatchValidationError('ANCHOR_AMBIGUOUS', 'x', {
      editIndex: 0,
      cause: 'ambiguous',
      occurrences: [12],
      nearest: null,
    });
    expect(describeAnchorFailure(error)).toContain('appears at line 12.');
  });
});
