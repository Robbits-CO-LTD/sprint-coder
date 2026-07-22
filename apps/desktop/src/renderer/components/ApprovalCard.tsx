import type { ApprovalDecision, ApprovalSummary } from '../types/vibe';

export function ApprovalCard({
  approval,
  busy,
  onDecision,
}: {
  approval: ApprovalSummary;
  busy: boolean;
  onDecision: (decision: ApprovalDecision) => void;
}) {
  return (
    <section className="approval-card" aria-label="ツール実行の承認" data-testid="approval-card">
      <div className="approval-card__head">
        <span className="approval-card__icon" aria-hidden="true">
          !
        </span>
        <div>
          <strong>実行の承認が必要です</strong>
          <div className="approval-card__tool">
            {approval.toolName} · {approval.capability}
          </div>
        </div>
        <span className={`approval-card__risk risk-${approval.risk}`}>{approval.risk}</span>
      </div>
      <p>{approval.reason}</p>
      {approval.capability === 'shell.execute' ? (
        <p className="approval-card__warning" role="note">
          OS
          sandboxなしで、あなたと同じ権限で実行されます。Workspace外のファイルやネットワークにもアクセスできます。
        </p>
      ) : null}
      <dl className="approval-card__facts">
        <div>
          <dt>対象</dt>
          <dd>{approval.target}</dd>
        </div>
        <div>
          <dt>影響</dt>
          <dd>{approval.impact}</dd>
        </div>
        <div>
          <dt>実行内容</dt>
          <dd>
            <code>{approval.execution}</code>
          </dd>
        </div>
      </dl>
      <div className="approval-card__actions">
        <button disabled={busy} onClick={() => onDecision('allow_once')}>
          今回のみ許可
        </button>
        <button
          data-testid="approval-allow-task"
          disabled={busy}
          onClick={() => onDecision('allow_task')}
        >
          Task中許可
        </button>
        <button
          className="danger"
          data-testid="approval-deny"
          disabled={busy}
          onClick={() => onDecision('deny')}
        >
          拒否
        </button>
      </div>
    </section>
  );
}
