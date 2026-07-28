import { describe, expect, it, vi } from 'vitest';
import {
  extractJsonObject,
  runAdversarialPanel,
  type SkepticRunner,
} from './adversarial-panel-runner';
import type { SkepticFinding } from './adversarial-panel';

const APPROVAL = JSON.stringify({
  refuted: false,
  evidence: 'every criterion holds',
  confidence: 'high',
});

const refusal = (detail: string) =>
  JSON.stringify({
    refuted: true,
    findings: [{ kind: 'gap', location: 'criterion 1', detail }],
    evidence: 'criterion 1 unmet',
    confidence: 'medium',
  });

/** Answers each skeptic from a list, by index. */
const scripted =
  (answers: readonly string[]): SkepticRunner =>
  async ({ skepticIndex }) => {
    const answer = answers[skepticIndex];
    if (answer === undefined) throw new Error(`no scripted answer for ${skepticIndex}`);
    return answer;
  };

describe('extracting a verdict from what a model actually returns', () => {
  it('reads a bare object', () => {
    expect(extractJsonObject('{"refuted": false}')).toEqual({ refuted: false });
  });

  it('reads a fenced block', () => {
    expect(extractJsonObject('```json\n{"refuted": true}\n```')).toEqual({ refuted: true });
    expect(extractJsonObject('```\n{"refuted": true}\n```')).toEqual({ refuted: true });
  });

  it('reads an object a model narrated its way up to', () => {
    const answer = 'I checked the tests and they do not drive the real path.\n{"refuted": true}';
    expect(extractJsonObject(answer)).toEqual({ refuted: true });
  });

  it('prefers the concluding object when a model shows its working', () => {
    const answer = 'Draft: {"refuted": false}\nFinal answer:\n{"refuted": true}';
    expect(extractJsonObject(answer)).toEqual({ refuted: true });
  });

  it('prefers the concluding fenced object over a fenced draft', () => {
    const answer = [
      'Draft:',
      '```json',
      '{"refuted": false}',
      '```',
      'Final answer:',
      '```json',
      '{"refuted": true}',
      '```',
    ].join('\n');
    expect(extractJsonObject(answer)).toEqual({ refuted: true });
  });

  it('returns from an unterminated fence with a long whitespace header', () => {
    expect(extractJsonObject(`\`\`\`json${' '.repeat(30_000)}`)).toBeNull();
  }, 2_000);

  it('is not fooled by a brace inside a string value', () => {
    const answer = '{"detail": "the handler drops `}` on the floor", "refuted": true}';
    expect(extractJsonObject(answer)).toEqual({
      detail: 'the handler drops `}` on the floor',
      refuted: true,
    });
  });

  it('is not fooled by an escaped quote inside a string value', () => {
    expect(extractJsonObject('{"detail": "he said \\"done\\" {", "refuted": true}')).toMatchObject({
      refuted: true,
    });
  });

  it('rejects anything that is not an object', () => {
    expect(extractJsonObject('[]')).toBeNull();
    expect(extractJsonObject('"refuted"')).toBeNull();
    expect(extractJsonObject('not json at all')).toBeNull();
    expect(extractJsonObject('')).toBeNull();
  });

  // No wall-clock assertion here: it would measure the runner, not the code, and CI machines differ
  // by more than the margin worth asserting. The test's own timeout is the signal — copying a span
  // per closing brace makes these quadratic in the nesting depth, so a regression does not return.
  it('does not allocate its way through a deeply nested answer', () => {
    // 40k deep closes spans of length 2, 4, 6 … 80,000: over a billion characters if each is
    // copied, even though all but the last few are thrown away.
    const depth = 40_000;
    expect(extractJsonObject(`${'{'.repeat(depth)}${'}'.repeat(depth)}`)).toBeNull();
  }, 10_000);

  it('still finds the verdict when a deeply nested answer ends with one', () => {
    const depth = 20_000;
    const nested = `${'{'.repeat(depth)}${'}'.repeat(depth)}`;
    expect(extractJsonObject(`${nested}\n{"refuted": true}`)).toEqual({ refuted: true });
  }, 10_000);

  it('still finds a verdict a model buried under a wall of narration', () => {
    const answer = `${'narration. '.repeat(20_000)}\n{"refuted": true}`;
    expect(extractJsonObject(answer)).toEqual({ refuted: true });
  });

  it('ignores an object too large to be a verdict', () => {
    const huge = `{"detail": "${'x'.repeat(200_000)}"}`;
    expect(extractJsonObject(huge)).toBeNull();
  });
});

describe('running the panel', () => {
  it('runs one skeptic per seat and approves when the cold panel agrees', async () => {
    const run = await runAdversarialPanel({
      runner: scripted([APPROVAL, APPROVAL, APPROVAL]),
      prompt: 'p',
    });
    expect(run.result.total).toBe(3);
    expect(run.result.achieved).toBe(true);
    expect(run.failureClass).toBeNull();
  });

  it('runs the skeptics concurrently rather than one after another', async () => {
    let running = 0;
    let peak = 0;
    const runner: SkepticRunner = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return APPROVAL;
    };
    await runAdversarialPanel({ runner, prompt: 'p' });
    expect(peak).toBe(3);
  });

  it('counts a skeptic that answered in the wrong shape as a refute', async () => {
    const run = await runAdversarialPanel({
      runner: scripted([APPROVAL, 'sure, looks good to me!', APPROVAL]),
      prompt: 'p',
    });
    expect(run.verdicts[1]).toMatchObject({ source: 'degraded', refuted: true });
    expect(run.result.achieved).toBe(false);
  });

  it('counts a refute with nothing to fix as unusable rather than as a refusal to act on', async () => {
    const empty = JSON.stringify({ refuted: true, findings: [], evidence: 'x', confidence: 'low' });
    const run = await runAdversarialPanel({ runner: scripted([empty, empty, empty]), prompt: 'p' });
    expect(run.verdicts.every((verdict) => verdict.source === 'degraded')).toBe(true);
    expect(run.failureClass).toBe('infrastructure');
  });

  it('counts a skeptic that threw as a refute rather than failing the round', async () => {
    const runner: SkepticRunner = async ({ skepticIndex }) => {
      if (skepticIndex === 1) throw new Error('provider exploded');
      return APPROVAL;
    };
    const run = await runAdversarialPanel({ runner, prompt: 'p' });
    expect(run.verdicts[1]).toMatchObject({ source: 'degraded', refuted: true });
    expect(run.result.achieved).toBe(false);
  });

  it('never rejects, however badly every skeptic fails', async () => {
    const runner: SkepticRunner = () => Promise.reject(new Error('all down'));
    const run = await runAdversarialPanel({ runner, prompt: 'p' });
    expect(run.result.total).toBe(3);
    expect(run.result.achieved).toBe(false);
    // Nobody judged the work, so this is not the implementer's repair round to spend.
    expect(run.failureClass).toBe('infrastructure');
  });

  it('gives up on a skeptic that runs past its deadline and tells it to stop', async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const runner: SkepticRunner = ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
          });
          // Never resolves on its own.
          void resolve;
        });
      const pending = runAdversarialPanel({ runner, prompt: 'p', timeoutMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_000);
      const run = await pending;
      expect(aborted).toBe(true);
      expect(run.verdicts.every((verdict) => verdict.source === 'degraded')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('honours the requested panel size within the allowed range', async () => {
    const runner = scripted(Array.from({ length: 9 }, () => APPROVAL));
    expect((await runAdversarialPanel({ runner, prompt: 'p', panelSize: 1 })).result.total).toBe(1);
    expect((await runAdversarialPanel({ runner, prompt: 'p', panelSize: 9 })).result.total).toBe(5);
  });

  it('filters a later round to what an earlier round had already raised, plus real defects', async () => {
    const prior: SkepticFinding[] = [
      { kind: 'gap', location: 'criterion 1', detail: 'no evidence' },
    ];
    const fresh = JSON.stringify({
      refuted: true,
      findings: [
        { kind: 'gap', location: 'criterion 1', detail: 'no evidence' },
        { kind: 'gap', location: 'criterion 2', detail: 'prefer a table-driven test' },
        { kind: 'bug', location: 'src/a.ts:4', detail: 'throws on empty input' },
      ],
      evidence: 'x',
      confidence: 'medium',
    });
    const run = await runAdversarialPanel({
      runner: scripted([fresh, fresh, fresh]),
      prompt: 'p',
      priorGaps: prior,
    });
    expect(run.actionableGaps.map((gap) => gap.detail)).toEqual([
      'no evidence',
      'throws on empty input',
    ]);
  });

  it('acts on everything the first round found', async () => {
    const run = await runAdversarialPanel({
      runner: scripted([refusal('one'), refusal('two'), refusal('three')]),
      prompt: 'p',
    });
    expect(run.actionableGaps).toHaveLength(3);
    expect(run.failureClass).toBe('verification');
  });

  it('hands every skeptic the same prompt', async () => {
    const seen: string[] = [];
    const runner: SkepticRunner = async ({ prompt }) => {
      seen.push(prompt);
      return APPROVAL;
    };
    await runAdversarialPanel({ runner, prompt: 'the one prompt' });
    expect(seen).toEqual(['the one prompt', 'the one prompt', 'the one prompt']);
  });
});
