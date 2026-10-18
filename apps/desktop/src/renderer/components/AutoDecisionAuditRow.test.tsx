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

it('summarizes a Turn of Auto decisions and renders the rows only while open (issue #863)', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const decisions = [decision(1, 'allow'), decision(2, 'allow'), decision(3, 'deny')];

  act(() => root.render(<AutoDecisionAuditGroup decisions={decisions} retainedLimit={200} />));
  const summary = container.querySelector('[data-testid="auto-decision-summary"]');
  expect(summary?.textContent).toContain('Auto');
  expect(summary?.textContent).toContain('自動許可 2件 · 拒否 1件');
  expect(summary?.textContent).toContain('最新200件まで表示');
  expect(summary?.getAttribute('aria-label')).toBe(
    'Auto判定 3件。自動許可 2件 · 拒否 1件（最新200件まで表示）',
  );
  expect(container.querySelectorAll('[data-testid="auto-decision-audit"]')).toHaveLength(0);

  const details = container.querySelector('details')!;
  act(() => {
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  });
  const rows = [...container.querySelectorAll('[data-testid="auto-decision-audit"]')];
  expect(rows).toHaveLength(3);
  expect(rows[2]?.textContent).toContain('拒否');
  expect(rows[2]?.textContent).toContain('shell.execute');

  act(() => root.render(<AutoDecisionAuditGroup decisions={[]} retainedLimit={null} />));
  expect(container.querySelector('[data-testid="auto-decision-group"]')).toBeNull();
  act(() => root.unmount());
  container.remove();
});
