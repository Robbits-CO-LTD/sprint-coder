import type { GraphMissionPlan, GraphView } from '@sprint-coder/contracts';
import { useAppStore } from '../store/appStore';
import { GraphMissionReviewNotice } from './GraphMissionReviewNotice';

export function GraphMissionPlanPanel({
  view,
  plan,
  sourceStamp,
}: {
  view: GraphView;
  plan: GraphMissionPlan;
  sourceStamp: string | null;
}) {
  const taskId = view.taskId;
  const team = useAppStore((state) => state.teamByTask[taskId]);
  const workers = plan.steps.map((step) => {
    const worker = team?.workers.find((worker) => worker.id === step.workerId);
    return [
      step.workerId,
      worker?.state,
      worker?.writeCapable,
      team?.executions.some(
        (execution) =>
          execution.assigneeAgentId === step.workerId &&
          !['completed', 'failed', 'canceled'].includes(execution.state),
      ),
    ];
  });
  return (
    <details className="graph-history" data-testid="graph-mission-plan">
      <summary>実行計画案 · {plan.steps.length}工程</summary>
      <div className="graph-history-content">
        <GraphMissionReviewNotice
          input={{ taskId, instanceId: view.instanceId, renderRevision: view.renderRevision }}
          reviewKey={
            sourceStamp === null
              ? null
              : JSON.stringify([view.instanceId, sourceStamp, team?.team.state, workers])
          }
        />
        <p className="settings-hint">開始前の確認用の計画案です。</p>
        <strong>{plan.objective}</strong>
        <ul>
          {plan.doneCriteria.map((criterion, index) => (
            <li key={index}>{criterion}</li>
          ))}
        </ul>
        <ol>
          {plan.steps.map((step) => (
            <li key={step.key}>
              <strong>
                {step.key} · {step.objective}
              </strong>
              <p>
                担当:{' '}
                {team?.workers.find((worker) => worker.id === step.workerId)?.role ??
                  `未確認（${step.workerId}）`}{' '}
                · {step.access === 'read-only' ? '読取りのみ' : 'Workspaceへの書込み'}
              </p>
              <p>前提工程: {step.dependsOn.length ? step.dependsOn.join('・') : 'なし'}</p>
              <ul>
                {step.doneCriteria.map((criterion, index) => (
                  <li key={index}>{criterion}</li>
                ))}
              </ul>
              {step.access === 'workspace-write' && step.writeClaims.length === 0 ? (
                <p>変更範囲未指定: Workspace全体として扱います。</p>
              ) : null}
              {step.writeClaims.length ? (
                <div>
                  変更範囲
                  <ul>
                    {step.writeClaims.map((claim, index) => (
                      <li key={index}>
                        {claim.rootId}: {claim.path ?? 'Workspace全体'}
                        {claim.semanticKeys.length
                          ? ` · 競合キー: ${claim.semanticKeys.join('・')}`
                          : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {step.resourceClaims.length ? (
                <div>
                  共有資源
                  <ul>
                    {step.resourceClaims.map((claim, index) => (
                      <li key={index}>
                        {claim.key}（
                        {claim.scope === 'machine' ? 'この端末全体' : `Workspace: ${claim.rootId}`}
                        ）
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p>共有資源: なし</p>
              )}
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}
