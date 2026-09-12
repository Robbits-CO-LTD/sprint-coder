import { describe, expect, it } from 'vitest';
import {
  beginGraphGeneration,
  cancelGraphGeneration,
  finishGraphGeneration,
} from './graph-generation';
import { acceptGraphGeneration } from '../renderer/lib/graph-generation';

describe('graph generation state', () => {
  it('keeps cancellation pending until completion is acknowledged and rejects old observations', () => {
    const running = beginGraphGeneration('task-a', 'Proposal', 1, null);
    const canceling = cancelGraphGeneration(running);
    expect(canceling.state).toBe('canceling');
    expect(() => finishGraphGeneration(canceling, 'succeeded', null, 2)).toThrow('cannot publish');
    expect(cancelGraphGeneration(canceling)).toEqual(canceling);
    const canceled = finishGraphGeneration(canceling, 'canceled');
    expect(canceled.sequence).toBe(running.sequence + 2);
    expect(canceled.finishedAt).not.toBeNull();
    expect(() => finishGraphGeneration(canceled, 'succeeded', null, 2)).toThrow();
    expect(acceptGraphGeneration(running, 'task-a', canceled.sequence)).toBeNull();
    expect(acceptGraphGeneration(canceled, 'task-b', 0)).toBeNull();
    expect(acceptGraphGeneration(canceled, 'task-a', running.sequence)).toEqual(canceled);
    const next = beginGraphGeneration('task-a', 'Next', 1, canceled);
    expect(next.id).not.toBe(canceled.id);
    expect(next.sequence).toBeGreaterThan(canceled.sequence);
    expect(() => beginGraphGeneration('task-a', null, 1, next)).toThrow();
  });

  it('requires a result for success and a bounded failure stage for failure', () => {
    const running = beginGraphGeneration('task-a', null, 0, null);
    expect(() => finishGraphGeneration(running, 'succeeded')).toThrow();
    expect(() => finishGraphGeneration(running, 'failed')).toThrow();
    expect(finishGraphGeneration(running, 'succeeded', null, 1)).toMatchObject({
      state: 'succeeded',
      resultRenderRevision: 1,
    });
    expect(finishGraphGeneration(running, 'failed', 'check')).toMatchObject({
      state: 'failed',
      failureStage: 'check',
    });
  });
});
