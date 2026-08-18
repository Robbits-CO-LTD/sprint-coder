import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApprovalCard } from './ApprovalCard';
import type { ApprovalSummary } from '../types/sprint-coder';

const approval: ApprovalSummary = {
  id: 'approval-1',
  taskId: 'task-1',
  turnId: 'turn-1',
  callId: 'call-1',
  state: 'pending',
  decision: null,
  revision: 0,
  policyEpoch: 1,
  toolName: 'request_user_input',
  reason: 'user_choice_required',
  target: 'choice',
  impact: 'control',
  execution: JSON.stringify({
    question: 'Which implementation?',
    choices: ['Safe', 'Fast', 'Compatible'],
  }),
  risk: 'low',
  capability: 'external.open',
  challenge: 'challenge-value',
  createdAt: '2026-08-18T00:00:00.000Z',
  expiresAt: '2026-08-18T01:00:00.000Z',
};

describe('ApprovalCard user input mode', () => {
  it('renders the question and three model-provided choices without permission wording', () => {
    const html = renderToStaticMarkup(
      <ApprovalCard approval={approval} busy={false} onDecision={() => undefined} />,
    );
    expect(html).toContain('Which implementation?');
    expect(html).toContain('Safe');
    expect(html).toContain('Fast');
    expect(html).toContain('Compatible');
    expect(html).not.toContain('実行の承認が必要です');
  });

  it('renders exactly two buttons for a two-choice question', () => {
    const html = renderToStaticMarkup(
      <ApprovalCard
        approval={{
          ...approval,
          execution: JSON.stringify({ question: 'Continue?', choices: ['Yes', 'No'] }),
        }}
        busy={false}
        onDecision={() => undefined}
      />,
    );
    expect(html.match(/<button/g) ?? []).toHaveLength(2);
  });
});
