import type { AutoPermissionDecision } from '../types/sprint-coder';

const DECISION_LABEL = {
  allow: '自動許可',
  allow_once: '今回のみ許可',
  deny: '拒否',
} as const;

export function AutoDecisionAuditRow({ decision }: { decision: AutoPermissionDecision }) {
  return (
    <div className="approval-audit-row" data-testid="auto-decision-audit">
      <span className="approval-audit-row__kind">Auto</span>
      <span>{DECISION_LABEL[decision.decision]}</span>
      <code>{decision.capability}</code>
      <span>{decision.outcome}</span>
      <span>{decision.reason}</span>
    </div>
  );
}
