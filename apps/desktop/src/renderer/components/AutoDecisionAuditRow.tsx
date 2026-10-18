import { memo, useState } from 'react';
import type { AutoPermissionDecision } from '../types/sprint-coder';

const DECISION_LABEL = {
  allow: '自動許可',
  allow_once: '今回のみ許可',
  deny: '拒否',
} as const;

const DECISION_ORDER = ['allow', 'allow_once', 'deny'] as const;

export const AutoDecisionAuditRow = memo(function AutoDecisionAuditRow({
  decision,
}: {
  decision: AutoPermissionDecision;
}) {
  return (
    <div className="approval-audit-row" data-testid="auto-decision-audit">
      <span className="approval-audit-row__kind">Auto</span>
      <span>{DECISION_LABEL[decision.decision]}</span>
      <code>{decision.capability}</code>
      <span>{decision.outcome}</span>
      <span>{decision.reason}</span>
    </div>
  );
});

/**
 * One Turn's Auto decisions behind a single summary line (issue #863). A long Team run records
 * thousands, and a row per decision made the Timeline grow without bound. The summary keeps the
 * audit visible — how many decisions of each kind — and the rows are rendered only while the
 * reader has the group open. `retainedLimit` is set on the group that may have lost its oldest
 * rows to the in-memory window, so the count never reads as the Turn's full total.
 */
export const AutoDecisionAuditGroup = memo(function AutoDecisionAuditGroup({
  decisions,
  retainedLimit,
}: {
  decisions: readonly AutoPermissionDecision[];
  retainedLimit: number | null;
}) {
  const [open, setOpen] = useState(false);
  if (decisions.length === 0) return null;
  const counts = { allow: 0, allow_once: 0, deny: 0 };
  for (const { decision } of decisions) counts[decision] += 1;
  const breakdown = DECISION_ORDER.filter((kind) => counts[kind] > 0)
    .map((kind) => `${DECISION_LABEL[kind]} ${counts[kind]}件`)
    .join(' · ');
  const note = retainedLimit === null ? '' : `（最新${retainedLimit}件まで表示）`;
  return (
    <details
      className="auto-decision-group"
      data-testid="auto-decision-group"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary
        className="approval-audit-row"
        data-testid="auto-decision-summary"
        aria-label={`Auto判定 ${decisions.length}件。${breakdown}${note}`}
      >
        <span className="approval-audit-row__kind">Auto</span>
        <span>{breakdown}</span>
        {note !== '' && <span>{note}</span>}
        <span className="auto-decision-group__chevron" aria-hidden="true">
          {open ? '⌄' : '›'}
        </span>
      </summary>
      {open &&
        decisions.map((decision) => <AutoDecisionAuditRow key={decision.id} decision={decision} />)}
    </details>
  );
});
