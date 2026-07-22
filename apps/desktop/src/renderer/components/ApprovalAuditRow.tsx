import type { ApprovalSummary } from '../types/vibe';

const DECISION_LABEL = {
  allow_once: '今回のみ許可しました',
  allow_task: 'このTask中は許可しました',
  deny: '拒否しました — Runは代替案を続行しました',
} as const;

export function ApprovalAuditRow({ approval }: { approval: ApprovalSummary }) {
  if (approval.decision === null) return null;
  return (
    <div
      className={`approval-audit approval-audit--${approval.decision}`}
      data-testid="approval-audit-row"
      role="status"
    >
      <span aria-hidden="true">{approval.decision === 'deny' ? '×' : '✓'}</span>
      <span>{DECISION_LABEL[approval.decision]}</span>
      <span className="approval-audit__scope">
        {approval.capability} · {approval.risk}
      </span>
    </div>
  );
}
