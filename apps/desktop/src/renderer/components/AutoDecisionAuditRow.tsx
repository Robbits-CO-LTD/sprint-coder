import { memo, useState } from 'react';
import type { AutoPermissionDecision } from '../types/sprint-coder';
import type { AutoDecisionTally } from '../store/appStore';

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
 * audit visible — how many decisions of each kind, from `tally`, which counts every decision of
 * the Turn even after its oldest rows left the in-memory window — and says how many rows are not
 * shown. The rows themselves are rendered only while the reader has the group open.
 */
export const AutoDecisionAuditGroup = memo(function AutoDecisionAuditGroup({
  decisions,
  tally,
}: {
  decisions: readonly AutoPermissionDecision[];
  /** Every decision of this Turn counted by kind, or null when only the rows are known. */
  tally: AutoDecisionTally | null;
}) {
  const [open, setOpen] = useState(false);
  const counts = tally ?? tallyRows(decisions);
  const byKind = { allow: counts.allow, allow_once: counts.allowOnce, deny: counts.deny };
  const total = counts.allow + counts.allowOnce + counts.deny;
  if (total === 0 && decisions.length === 0) return null;
  const breakdown = DECISION_ORDER.filter((kind) => byKind[kind] > 0)
    .map((kind) => `${DECISION_LABEL[kind]} ${byKind[kind]}件`)
    .join(' · ');
  const omitted = Math.max(0, total - decisions.length);
  const note =
    omitted === 0
      ? ''
      : decisions.length === 0
        ? `（${omitted}件は省略）`
        : `（${omitted}件は省略、最新${decisions.length}件を表示）`;
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
        aria-label={`Auto判定 ${Math.max(total, decisions.length)}件。${breakdown}${note}`}
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

function tallyRows(decisions: readonly AutoPermissionDecision[]): AutoDecisionTally {
  const tally = { allow: 0, allowOnce: 0, deny: 0 };
  for (const { decision } of decisions)
    if (decision === 'allow') tally.allow += 1;
    else if (decision === 'allow_once') tally.allowOnce += 1;
    else tally.deny += 1;
  return tally;
}
