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

describe('ApprovalCard standard input wording', () => {
  const shellApproval: ApprovalSummary = {
    ...approval,
    toolName: 'exec_command',
    reason: 'provider_command_requires_explicit_approval',
    target: '/bin/sh',
    impact: 'process',
    risk: 'high',
    capability: 'shell.execute',
    execution: JSON.stringify({
      executable: '/bin/sh',
      argv: ['-c', 'tee notes.txt'],
      cwd: '/workspace',
      shell: 'none',
      stdinMode: 'approved-writes',
    }),
  };

  it('says the command keeps stdin open and that later input is approved separately', () => {
    const html = renderToStaticMarkup(
      <ApprovalCard approval={shellApproval} busy={false} onDecision={() => undefined} />,
    );
    expect(html).toContain('標準入力は開いたままです');
    expect(html).toContain('write_stdin');
  });

  it('says nothing about stdin when the approved spec closed it', () => {
    const html = renderToStaticMarkup(
      <ApprovalCard
        approval={{
          ...shellApproval,
          execution: JSON.stringify({ executable: '/bin/sh', stdinMode: 'closed' }),
        }}
        busy={false}
        onDecision={() => undefined}
      />,
    );
    expect(html).not.toContain('標準入力');
  });

  it('tells the user a stdin write changes what the running command does', () => {
    const html = renderToStaticMarkup(
      <ApprovalCard
        approval={{
          ...shellApproval,
          toolName: 'write_stdin',
          target: 'stdin → /bin/sh -c tee notes.txt (session session-1)',
          execution: JSON.stringify({ tool: 'write_stdin', chars: 'rm -rf /' }),
        }}
        busy={false}
        onDecision={() => undefined}
      />,
    );
    expect(html).toContain('実行中のコマンドの標準入力へ送信されます');
    expect(html).toContain('session-1');
  });
});
