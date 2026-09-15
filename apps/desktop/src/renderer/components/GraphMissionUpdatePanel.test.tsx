// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { GraphMissionUpdatePanel } from './GraphMissionUpdatePanel';

afterEach(() => vi.unstubAllGlobals());
const input = {
  taskId: 'task',
  instanceId: 'view',
  missionId: 'mission',
  renderRevision: 3,
  expectedSemanticRevision: 1,
};

it.each([false, true])(
  'shows the actual agreement difference before a second user gesture (comparison fails: %s)',
  async (fails) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const review = {
      ...input,
      requestId: 'request',
      contextDigest: 'a'.repeat(64),
      beforeRenderRevision: 1,
      changedKeys: ['a'],
      affectedKeys: ['a', 'c'],
    };
    const requestUpdate = vi.fn(async () => review);
    const agreeUpdate = vi.fn(async () => undefined);
    const compare = fails
      ? vi.fn().mockRejectedValue(new Error('comparison unavailable'))
      : vi.fn().mockResolvedValue({
          graphId: 'graph',
          taskId: 'task',
          before: { semanticRevision: 1 },
          after: { semanticRevision: 3 },
          contentChanged: true,
          changes: [],
          presentationOnly: false,
        });
    vi.stubGlobal('sprintCoder', { graphs: { requestUpdate, agreeUpdate, compare } });
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => root.render(<GraphMissionUpdatePanel input={input} />));
      expect(requestUpdate).not.toHaveBeenCalled();
      expect(agreeUpdate).not.toHaveBeenCalled();
      await act(async () => container.querySelector('button')!.click());
      expect(compare).toHaveBeenCalledWith({
        taskId: 'task',
        beforeRenderRevision: 1,
        afterRenderRevision: 3,
      });
      expect(agreeUpdate).not.toHaveBeenCalled();
      if (fails) {
        expect(container.querySelector('[role="alert"]')?.textContent).toBe(
          'comparison unavailable',
        );
        expect(container.querySelectorAll('button')).toHaveLength(1);
      } else {
        expect(container.querySelector('[data-testid="graph-diff"]')).not.toBeNull();
        const agree = container.querySelectorAll('button')[1]!;
        expect(JSON.parse(agree.dataset['computerUseIntent']!)).toMatchObject({
          operation: 'graph-update-agree',
          requestId: 'request',
          contextDigest: review.contextDigest,
        });
        await act(async () => agree.click());
        expect(agreeUpdate).toHaveBeenCalledWith({
          ...input,
          requestId: 'request',
          contextDigest: review.contextDigest,
        });
      }
    } finally {
      await act(async () => root.unmount());
    }
  },
);
