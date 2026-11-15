import { Check, X } from './icons';
import type { ApprovalSummary } from '../types/sprint-coder';
import { desktopActionSummary } from '../lib/desktop-action';

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
      {approval.requester === undefined ? null : (
        // Whose call it was, in words only: by now its color may belong to another Worker.
        <span className="approval-audit__requester" data-testid="approval-audit-requester">
          依頼した Worker: {approval.requester.label}
        </span>
      )}
      {approval.desktopAction === undefined ? (
        <span className="approval-audit__scope">
          {approval.capability} · {approval.risk}
        </span>
      ) : (
        <span className="approval-audit__scope" data-testid="approval-audit-desktop">
          デスクトップ操作 · {desktopActionSummary(approval.desktopAction)}
        </span>
      )}
    </div>
  );
}

/**
 * A card its Turn left unanswered (issue #1285): the Runtime ended the Turn, or the call that asked
 * went away, while the card still waited, so the card was withdrawn and nothing ran. Said under
 * the Turn's reply, in the history's quiet note, so the card does not vanish without a word.
 */
export function ApprovalCanceledRow({ approval }: { approval: ApprovalSummary }) {
  if (approval.state !== 'canceled') return null;
  return (
    <p className="turn-interrupted-marker" role="note" data-testid="approval-canceled-row">
      <strong>取り消し</strong>
      <span>
        承認を待っていた操作は、答えが無いまま取り消されました。実行していません。
        {approval.requester === undefined ? null : ` 依頼した Worker: ${approval.requester.label}`}
        {' — '}
        <span data-testid="approval-canceled-subject">
          {approval.desktopAction === undefined
            ? `${approval.toolName} · ${approval.target}`
            : `デスクトップ操作 · ${desktopActionSummary(approval.desktopAction)}`}
        </span>
      </span>
    </p>
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
