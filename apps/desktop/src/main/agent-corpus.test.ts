import { describe, expect, it } from 'vitest';
import {
  BASELINE_CORPUS,
  runBaselineCorpus,
  summarizeBaselineCorpus,
} from './agent-corpus';

describe('Standard Assurance baseline corpus', () => {
  it('runs the fixed 30 cases with all required categories and comparable metrics', async () => {
    const first = await runBaselineCorpus();
    const second = await runBaselineCorpus();
    const categories = new Set(BASELINE_CORPUS.map(({ category }) => category));

    expect(BASELINE_CORPUS).toHaveLength(30);
    expect(categories).toEqual(
      new Set([
        'locate',
        'edit',
        'debug',
        'multi-file',
        'safety',
        'recovery',
        'context',
        'review',
      ]),
    );
    expect(first.configurationDigest).toBe(
      'ff20a0c26012967120d007942dfa61f87269cc924f4c7ccf3a3a9ceca57abb0f',
    );
    expect(second.configurationDigest).toBe(first.configurationDigest);
    expect(first.cases.every(({ success }) => success)).toBe(true);
    expect(first.cases.every(({ falseCompletion }) => !falseCompletion)).toBe(true);
    expect(first.cases.every(({ unnecessaryDiffLines }) => unnecessaryDiffLines === 0)).toBe(true);
    expect(first.cases.some(({ repairRounds }) => repairRounds === 1)).toBe(true);
    expect(
      first.cases.every(
        ({ inputTokens, outputTokens, estimatedCostUnits, wallTimeMs }) =>
          inputTokens > 0 && outputTokens > 0 && estimatedCostUnits > 0 && wallTimeMs >= 0,
      ),
    ).toBe(true);

    expect(summarizeBaselineCorpus(first)).toEqual({
      totalCases: 30,
      successfulCases: 30,
      falseCompletions: 0,
      gatingCriteriaPassed: 25,
      unnecessaryDiffLines: 0,
      toolCalls: 22,
      inputTokens: 244,
      outputTokens: 275,
      estimatedCostUnits: 739,
      approvalCount: 0,
      repairRounds: 11,
      userInterventions: 5,
    });
  });
});
