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

const DIGEST = 'a'.repeat(64);

/** True when neither allow button can be pressed. */
function allowButtonsDisabled(html: string): boolean {
  return ['approval-allow-once', 'approval-allow-task'].every((testId) =>
    new RegExp(`data-testid="${testId}"[^>]*disabled`).test(html),
  );
}

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

  it('shows the live characters in full and keeps the decision available', () => {
    const html = renderToStaticMarkup(
      <ApprovalCard
        approval={{
          ...shellApproval,
          toolName: 'write_stdin',
          execution: JSON.stringify({ tool: 'write_stdin', charsBytes: 41, charsMac: DIGEST }),
          ephemeralExecution: '--- stdin ---\npassword=hunter2\nrm -rf .',
        }}
        busy={false}
        onDecision={() => undefined}
      />,
    );
    expect(html).toContain('rm -rf .');
    expect(html).toContain('password=hunter2');
    expect(html).not.toContain('承認できません');
    expect(allowButtonsDisabled(html)).toBe(false);
  });

  it('refuses to offer allow when the characters cannot be shown any more', () => {
    // A card rebuilt from a snapshot or the durable event has no live detail. Approving there
    // would approve bytes nobody read, so only 拒否 stays available (Issue #473).
    const html = renderToStaticMarkup(
      <ApprovalCard
        approval={{
          ...shellApproval,
          toolName: 'write_stdin',
          execution: JSON.stringify({ tool: 'write_stdin', charsBytes: 41, charsMac: DIGEST }),
        }}
        busy={false}
        onDecision={() => undefined}
      />,
    );
    expect(html).toContain('入力内容を再取得できないため承認できません');
    expect(html).toContain('stdin 41 bytes');
    expect(html).toContain(DIGEST);
    expect(html).not.toContain('hunter2');
    expect(allowButtonsDisabled(html)).toBe(true);
    // The way out stays open.
    expect(html).toMatch(/data-testid="approval-deny"(?![^>]*disabled)/);
  });

  it('never collapses a stdin value, however long it is', () => {
    // The collapsed view would put an allow within reach of a value the user has only partly
    // seen, which is the whole failure this card exists to prevent.
    const chars = 'a'.repeat(2_048);
    const html = renderToStaticMarkup(
      <ApprovalCard
        approval={{
          ...shellApproval,
          toolName: 'write_stdin',
          execution: JSON.stringify({
            tool: 'write_stdin',
            charsBytes: 2_048,
            charsMac: DIGEST,
          }),
          ephemeralExecution: `--- stdin ---\n${chars}`,
        }}
        busy={false}
        onDecision={() => undefined}
      />,
    );
    expect(html).toContain(chars);
    expect(html).not.toContain('is-collapsed');
    expect(html).not.toContain('実行内容をすべて表示');
    expect(allowButtonsDisabled(html)).toBe(false);
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
