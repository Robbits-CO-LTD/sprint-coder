// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { AutoPermissionDecision } from '../types/sprint-coder';
import { AutoDecisionAuditGroup } from './AutoDecisionAuditRow';

afterEach(() => vi.unstubAllGlobals());

function decision(index: number, kind: AutoPermissionDecision['decision']): AutoPermissionDecision {
  return {
    id: `auto-${index}`,
    taskId: 'task-1',
    turnId: 'turn-1',
    callId: `call-${index}`,
    reviewRequestId: `review-${index}`,
    capability: 'shell.execute',
    source: 'reviewer',
    decision: kind,
    outcome: kind,
    reason: `reason ${index}`,
    risk: 'low',
    model: 'fixture',
    templateVersion: '1',
    requestFingerprint: 'f'.repeat(64),
    executionSpecDigest: 'd'.repeat(64),
    inputDigest: 'e'.repeat(64),
    policyEpoch: 0,
    createdAt: '2026-10-18T00:00:00.000Z',
  };
}

function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  return {
    container,
    root,
    summary: () => container.querySelector('[data-testid="auto-decision-summary"]'),
    rows: () => [...container.querySelectorAll('[data-testid="auto-decision-audit"]')],
    dispose: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

it('summarizes a Turn of Auto decisions and renders the rows only while open (issue #863)', () => {
  const view = mount();
  const decisions = [decision(1, 'allow'), decision(2, 'allow'), decision(3, 'deny')];

  act(() => view.root.render(<AutoDecisionAuditGroup decisions={decisions} tally={null} />));
  expect(view.summary()?.textContent).toContain('Auto');
  expect(view.summary()?.textContent).toContain('自動許可 2件 · 拒否 1件');
  expect(view.summary()?.textContent).not.toContain('省略');
  expect(view.summary()?.getAttribute('aria-label')).toBe('Auto判定 3件。自動許可 2件 · 拒否 1件');
  expect(view.rows()).toHaveLength(0);

  const details = view.container.querySelector('details')!;
  act(() => {
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  });
  expect(view.rows()).toHaveLength(3);
  expect(view.rows()[2]?.textContent).toContain('拒否');
  expect(view.rows()[2]?.textContent).toContain('shell.execute');

  act(() => view.root.render(<AutoDecisionAuditGroup decisions={[]} tally={null} />));
  expect(view.container.querySelector('[data-testid="auto-decision-group"]')).toBeNull();
  view.dispose();
});

it('counts from the Turn tally and says how many rows are not shown', () => {
  const view = mount();
  act(() =>
    view.root.render(
      <AutoDecisionAuditGroup
        decisions={[decision(1, 'allow'), decision(2, 'deny')]}
        tally={{ allow: 250, allowOnce: 0, deny: 3 }}
      />,
    ),
  );
  expect(view.summary()?.textContent).toContain('自動許可 250件 · 拒否 3件');
  expect(view.summary()?.textContent).toContain('251件は省略、最新2件を表示');
  expect(view.summary()?.getAttribute('aria-label')).toBe(
    'Auto判定 253件。自動許可 250件 · 拒否 3件（251件は省略、最新2件を表示）',
  );
  view.dispose();
});

it('keeps the summary of a Turn whose rows were all pushed out of memory', () => {
  const view = mount();
  act(() =>
    view.root.render(
      <AutoDecisionAuditGroup decisions={[]} tally={{ allow: 0, allowOnce: 1, deny: 2 }} />,
    ),
  );
  expect(view.container.querySelector('[data-testid="auto-decision-group"]')).not.toBeNull();
  expect(view.summary()?.textContent).toContain('今回のみ許可 1件 · 拒否 2件');
  expect(view.summary()?.getAttribute('aria-label')).toBe(
    'Auto判定 3件。今回のみ許可 1件 · 拒否 2件（3件は省略）',
  );
  view.dispose();
});

it('tells the Timeline when the reader opens the group, and only then', () => {
  const view = mount();
  const onExpand = vi.fn();
  act(() =>
    view.root.render(
      <AutoDecisionAuditGroup
        decisions={[decision(1, 'allow')]}
        tally={null}
        onExpand={onExpand}
      />,
    ),
  );
  const details = view.container.querySelector('details')!;
  act(() => {
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  });
  expect(onExpand).toHaveBeenCalledTimes(1);
  act(() => {
    details.open = false;
    details.dispatchEvent(new Event('toggle'));
  });
  expect(onExpand).toHaveBeenCalledTimes(1);
  view.dispose();
});
