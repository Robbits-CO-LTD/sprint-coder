import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileRevisionRegistry } from './file-revision';
import {
  PatchValidationError,
  prepareStructuredPatch,
  type AnchorRecovery,
} from './structured-patch';

// Measuring the diagnosis instead of only testing it.
//
// The hand-written tests next door check that each cause is reachable on an example chosen to
// produce it, which proves the branches work and nothing about how the classifier behaves on
// anchors that went stale the ways anchors actually go stale. This generates those ways — a file
// edited above the anchor, reindented, converted to CRLF, renamed underneath — across several
// shapes of source, and scores the result.
//
// The property worth measuring is not "what cause was reported" but **could the model have
// retried from the message alone**. For a drift that means the returned region must be findable
// verbatim in the file as it now stands, and findable exactly once: an anchor the tool hands back
// that does not match, or matches twice, sends the model into the retry loop the whole design
// exists to avoid. That is asserted per case rather than as an aggregate, because a 90% success
// rate here would mean one edit in ten costs a wasted round.

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Sources chosen to differ in the ways that matter: indentation, nesting, and repetition. */
const SOURCES: readonly Readonly<{ name: string; text: string; anchor: string }>[] = [
  {
    name: 'flat functions',
    text: [
      'function alpha(input) {',
      '  return input + 1;',
      '}',
      '',
      'function beta(input) {',
      '  return input * 2;',
      '}',
      '',
    ].join('\n'),
    anchor: 'function beta(input) {\n  return input * 2;\n}',
  },
  {
    name: 'nested block',
    text: [
      'class Service {',
      '  handle(request) {',
      '    if (request.ok) {',
      '      return this.accept(request);',
      '    }',
      '    return this.reject(request);',
      '  }',
      '}',
      '',
    ].join('\n'),
    anchor: '    if (request.ok) {\n      return this.accept(request);\n    }',
  },
  {
    name: 'repeated shapes',
    text: [
      'const a = { id: 1, name: "first" };',
      'const b = { id: 2, name: "second" };',
      'const c = { id: 3, name: "third" };',
      '',
    ].join('\n'),
    anchor: 'const b = { id: 2, name: "second" };',
  },
];

/** The ways an anchor goes stale in practice, each with the cause it should be reported as. */
const MUTATIONS: readonly Readonly<{
  name: string;
  expected: AnchorRecovery['cause'];
  apply: (text: string) => string;
}>[] = [
  {
    name: 'lines inserted above the anchor',
    expected: 'drifted',
    apply: (text) => `// added header\n// second line\n${text}`,
  },
  {
    name: 'the file converted to CRLF',
    expected: 'line_ending',
    apply: (text) => text.replace(/\n/g, '\r\n'),
  },
  {
    name: 'the whole file reindented',
    expected: 'indentation',
    apply: (text) =>
      text
        .split('\n')
        .map((line) => (line.trim().length === 0 ? line : line.replace(/^(\s*)/, '$1$1')))
        .join('\n'),
  },
  {
    name: 'trailing whitespace introduced',
    expected: 'trailing_whitespace',
    apply: (text) =>
      text
        .split('\n')
        .map((line) => (line.trim().length === 0 ? line : `${line}  `))
        .join('\n'),
  },
  {
    name: 'the anchored body rewritten',
    expected: 'drifted',
    apply: (text) =>
      text
        .replace('return input * 2;', 'return input * 3;')
        .replace('return this.accept(request);', 'return this.acceptNow(request);')
        .replace('name: "second"', 'name: "SECOND"'),
  },
];

async function diagnose(content: string, anchor: string): Promise<AnchorRecovery | null> {
  const workspace = await mkdtemp(join(tmpdir(), 'sprint-coder-accuracy-'));
  roots.push(workspace);
  await mkdir(join(workspace, 'src'));
  await writeFile(join(workspace, 'src', 'a.txt'), content);
  const registry = new FileRevisionRegistry();
  const revision = await registry.read({
    owner: { taskId: 't', turnId: 'u' },
    workspacePath: workspace,
    targetPath: 'src/a.txt',
    policyEpoch: 1,
  });
  try {
    await prepareStructuredPatch({
      owner: { taskId: 't', turnId: 'u' },
      workspacePath: workspace,
      policyEpoch: 1,
      registry,
      operations: [
        {
          kind: 'update',
          path: 'src/a.txt',
          revision: revision.reference,
          edits: [{ oldText: anchor, newText: '// replaced' }],
        },
      ],
    });
    return null;
  } catch (error) {
    return error instanceof PatchValidationError ? error.recovery : null;
  }
}

describe('how the anchor diagnosis behaves on anchors that went stale realistically', () => {
  for (const source of SOURCES)
    for (const mutation of MUTATIONS) {
      it(`${source.name}: ${mutation.name}`, async () => {
        const mutated = mutation.apply(source.text);
        // A mutation that happens not to disturb this source's anchor has nothing to diagnose.
        if (mutated.includes(source.anchor)) return;

        const recovery = await diagnose(mutated, source.anchor);
        expect(recovery, 'the failure carried no recovery data').not.toBeNull();
        expect(recovery?.cause).toBe(mutation.expected);

        // The property that decides whether the message is worth sending: when it hands back a
        // region, that region must be usable as the next anchor without any further reading.
        const nearest = recovery?.nearest;
        if (nearest !== null && nearest !== undefined && !nearest.truncated) {
          const first = mutated.indexOf(nearest.text);
          expect(
            first,
            'the returned region is not in the file it came from',
          ).toBeGreaterThanOrEqual(0);
          expect(
            mutated.indexOf(nearest.text, first + 1),
            'the returned region matches twice, so retrying with it is ambiguous',
          ).toBe(-1);
        }
      });
    }
});

describe('what the diagnosis must never do', () => {
  it('never reports a near-miss for an anchor that is genuinely gone', async () => {
    for (const source of SOURCES) {
      const recovery = await diagnose(source.text, 'ABSOLUTELY NOT PRESENT ANYWHERE\nSECOND LINE');
      expect(['absent', 'drifted']).toContain(recovery?.cause);
    }
  });

  it('never points at a line when it could not localise the region', async () => {
    const recovery = await diagnose(SOURCES[0]?.text ?? '', 'NOT HERE\nNOR HERE');
    expect(recovery?.cause).toBe('absent');
    expect(recovery?.occurrences).toEqual([]);
    expect(recovery?.nearest).toBeNull();
  });

  it('locates a single-line anchor whose own line was rewritten', async () => {
    // The most common edit shape: the model anchors on exactly the line it means to replace, and
    // that line has already changed. Giving up here is what sends it back to re-read.
    const content = 'const b = { id: 2, name: "SECOND" };\n';
    const recovery = await diagnose(content, 'const b = { id: 2, name: "second" };');
    expect(recovery?.cause).toBe('drifted');
    expect(recovery?.nearest?.text).toBe('const b = { id: 2, name: "SECOND" };');
  });

  it('refuses to guess when the resemblance is only a shared idiom', async () => {
    // `function ` is shared by every function in the file; matching on it would hand back a region
    // from an unrelated function, which is a silent bad edit rather than a wasted read.
    const content = 'function alpha(input) {\n  return input + 1;\n}\n';
    const recovery = await diagnose(content, 'function gamma(other) {\n  return 0;\n}');
    expect(recovery?.cause).toBe('absent');
    expect(recovery?.nearest).toBeNull();
  });

  it('refuses to guess when two lines are equally plausible', async () => {
    const content = 'const value = compute(1);\nconst value = compute(2);\n';
    const recovery = await diagnose(content, 'const value = compute(9);');
    expect(recovery?.cause).toBe('absent');
  });

  it('reports drift rather than a near-miss when only the body changed', async () => {
    const source = SOURCES[0];
    const mutated = (source?.text ?? '').replace('return input * 2;', 'return input * 3;');
    const recovery = await diagnose(mutated, source?.anchor ?? '');
    expect(recovery?.cause).toBe('drifted');
    expect(recovery?.nearest?.text).toContain('return input * 3;');
  });
});
