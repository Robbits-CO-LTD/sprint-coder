import { describe, expect, it } from 'vitest';
import { BASELINE_CORPUS, runBaselineCorpus } from './agent-corpus';

describe('baseline agent corpus', () => {
  it('runs answer-only and mock-tool fixtures with comparable metrics', async () => {
    const first = await runBaselineCorpus();
    const second = await runBaselineCorpus();

    expect(BASELINE_CORPUS.map(({ mode }) => mode)).toEqual(['answer-only', 'mock-tool']);
    expect(first.configurationDigest).toBe(second.configurationDigest);
    expect(first.cases).toMatchObject([
      { caseId: 'answer-only-001', success: true, falseCompletion: false, toolCalls: 0, steps: 1 },
      { caseId: 'mock-tool-001', success: true, falseCompletion: false, toolCalls: 1, steps: 2 },
    ]);
    expect(
      first.cases.every(({ inputTokens, outputTokens }) => inputTokens > 0 && outputTokens > 0),
    ).toBe(true);
  });
});
