import { describe, expect, it } from 'vitest';
import {
  aggregateContextUsage,
  estimateTokens,
  selectHistoryForCompaction,
  type ContextFragment,
} from './context-ledger';

describe('ContextLedger calculations', () => {
  it('estimates tokens as the ceiling of Unicode character count divided by three', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('abcd')).toBe(2);
    expect(estimateTokens('あいうえ')).toBe(2);
    expect(estimateTokens('😀😀😀😀')).toBe(2);
  });

  it('compacts only when history is over eighty percent of the cap', () => {
    expect(selectHistoryForCompaction([fragment('a', 80)], 100)).toEqual([]);
    expect(selectHistoryForCompaction([fragment('a', 81)], 100).map(({ id }) => id)).toEqual(['a']);
  });

  it('supersedes oldest fragments until kept history reaches the fifty percent floor', () => {
    const history = [fragment('oldest', 20), fragment('middle', 20), fragment('newest', 41)];
    expect(selectHistoryForCompaction(history, 100).map(({ id }) => id)).toEqual([
      'oldest',
      'middle',
    ]);

    const exactFloor = [fragment('oldest', 31), fragment('middle', 20), fragment('newest', 30)];
    const superseded = selectHistoryForCompaction(exactFloor, 100);
    expect(superseded.map(({ id }) => id)).toEqual(['oldest']);
    expect(
      exactFloor.reduce((total, item) => total + item.tokenEstimate, 0) -
        superseded.reduce((total, item) => total + item.tokenEstimate, 0),
    ).toBe(50);
  });

  it('pre-aggregates usage by source in stable source order', () => {
    expect(
      aggregateContextUsage([
        fragment('history-1', 4),
        { ...fragment('goal', 3), source: 'goal' },
        { ...fragment('system', 2), source: 'system' },
        fragment('history-2', 5),
        { ...fragment('summary', 6), source: 'compaction' },
      ]),
    ).toEqual({
      usedTokens: 20,
      hardCapTokens: 32_000,
      projectTokens: 0,
      fragments: [
        { source: 'system', tokens: 2 },
        { source: 'history', tokens: 9 },
        { source: 'goal', tokens: 3 },
        { source: 'compaction', tokens: 6 },
      ],
    });
  });

  it('reports Project tokens separately while keeping the total consistent', () => {
    const usage = aggregateContextUsage([fragment('history', 7)], 3);
    expect(usage).toMatchObject({ usedTokens: 10, projectTokens: 3 });
    expect(usage.fragments.reduce((total, item) => total + item.tokens, usage.projectTokens)).toBe(
      usage.usedTokens,
    );
  });
});

function fragment(id: string, tokenEstimate: number): ContextFragment {
  return {
    id,
    taskId: 'task',
    source: 'history',
    trust: 'user',
    tokenEstimate,
    content: id,
    createdAt: '2026-01-01T00:00:00.000Z',
    messageId: id,
  };
}
