import { Check, X } from './icons';
import type { ApprovalSummary } from '../types/sprint-coder';

const DECISION_LABEL = {
  allow_once: '今回のみ許可しました',
  allow_task: 'このTask中は許可しました',
  deny: '拒否しました — Runは代替案を続行しました',
} as const;

export function ApprovalAuditRow({ approval }: { approval: ApprovalSummary }) {
  if (approval.decision === null) return null;
  const selectedChoice = userInputChoice(approval);
  return (
    <div
      className={`approval-audit approval-audit--${selectedChoice === null ? approval.decision : 'allow_once'}`}
      data-testid="approval-audit-row"
      role="status"
    >
      <span>
        {selectedChoice === null && approval.decision === 'deny' ? (
          <X size={13} />
        ) : (
          <Check size={13} />
        )}
      </span>
      <span>{selectedChoice ?? DECISION_LABEL[approval.decision]}</span>
      <span className="approval-audit__scope">
        {approval.capability} · {approval.risk}
      </span>
    </div>
  );
}

function userInputChoice(approval: ApprovalSummary): string | null {
  if (approval.toolName !== 'request_user_input' || approval.decision === null) return null;
  try {
    const value = JSON.parse(approval.execution) as { choices?: unknown };
    if (
      !Array.isArray(value.choices) ||
      !value.choices.every((choice) => typeof choice === 'string')
    )
      return null;
    const index =
      approval.decision === 'allow_once' ? 0 : approval.decision === 'allow_task' ? 1 : 2;
    return (value.choices[Math.min(index, value.choices.length - 1)] as string | undefined) ?? null;
  } catch {
    return null;
  }
}
