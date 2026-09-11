// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { GraphMissionReview } from '@sprint-coder/contracts';
import { GraphMissionReviewNotice } from './GraphMissionReviewNotice';

it('discards a previous view or review result and hides a match while source validation is pending', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const resolvers: ((value: GraphMissionReview) => void)[] = [];
  vi.stubGlobal('sprintCoder', {
    graphs: {
      reviewMission: () => new Promise<GraphMissionReview>((resolve) => resolvers.push(resolve)),
    },
  });
  const container = document.createElement('div');
  const root = createRoot(container);
  const a = { taskId: 'a', instanceId: 'view-a', renderRevision: 1 };
  const b = { taskId: 'b', instanceId: 'view-b', renderRevision: 1 };
  const result = (input: typeof a): GraphMissionReview => ({
    ...input,
    checkedAt: new Date().toISOString(),
    matched: true,
    issues: [],
  });
  try {
    await act(async () => root.render(<GraphMissionReviewNotice input={a} reviewKey="same" />));
    await act(async () => root.render(<GraphMissionReviewNotice input={b} reviewKey="same" />));
    await act(async () => resolvers[0]!(result(a)));
    expect(container.textContent).toContain('確認しています');
    await act(async () => resolvers[1]!(result(b)));
    expect(container.textContent).toContain('参照先を確認しました');
    await act(async () => root.render(<GraphMissionReviewNotice input={b} reviewKey={null} />));
    expect(container.textContent).toContain('確認しています');
    expect(container.textContent).not.toContain('参照先を確認しました');
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
