import { useEffect, useRef, useState } from 'react';
import { TriangleAlert } from './icons';
import type { ApprovalDecision, ApprovalSummary } from '../types/sprint-coder';

export function ApprovalCard({
  approval,
  busy,
  onDecision,
}: {
  approval: ApprovalSummary;
  busy: boolean;
  onDecision: (decision: ApprovalDecision) => void;
}) {
  const cardRef = useRef<HTMLElement>(null);
  const [executionExpanded, setExecutionExpanded] = useState(false);
  const executionIsLong = approval.execution.length > 512;

  useEffect(() => {
    cardRef.current?.focus({ preventScroll: true });
  }, [approval.id]);

  return (
    <section
      ref={cardRef}
      className="approval-card"
      aria-label="ツール実行の承認"
      aria-busy={busy}
      data-testid="approval-card"
      tabIndex={-1}
    >
      <div className="approval-card__head">
        <span className="approval-card__icon">
          <TriangleAlert size={16} />
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
            <code className={executionIsLong && !executionExpanded ? 'is-collapsed' : undefined}>
              {executionIsLong && !executionExpanded
                ? `${approval.execution.slice(0, 512)}…`
                : approval.execution}
            </code>
            {executionIsLong ? (
              <button
                type="button"
                className="approval-card__disclosure"
                aria-expanded={executionExpanded}
                onClick={() => setExecutionExpanded((value) => !value)}
              >
                {executionExpanded ? '実行内容を折り畳む' : '実行内容をすべて表示'}
              </button>
            ) : null}
          </dd>
        </div>
      </dl>
      <div className="approval-card__actions">
        <button
          type="button"
          className="primary"
          data-testid="approval-allow-once"
          disabled={busy}
          onClick={() => onDecision('allow_once')}
        >
          今回のみ許可
        </button>
        <button
          data-testid="approval-allow-task"
          type="button"
          disabled={busy}
          onClick={() => onDecision('allow_task')}
        >
          Task中許可
        </button>
        <button
          className="danger"
          data-testid="approval-deny"
          type="button"
          disabled={busy}
          onClick={() => onDecision('deny')}
        >
          拒否
        </button>
      </div>
      {busy ? (
        <span className="sr-only" role="status">
          承認結果を保存しています
        </span>
      ) : null}
    </section>
  );
}
