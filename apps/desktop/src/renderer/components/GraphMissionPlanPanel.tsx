import type { GraphMissionPlan } from '@sprint-coder/contracts';
import { useAppStore } from '../store/appStore';

export function GraphMissionPlanPanel({
  taskId,
  plan,
}: {
  taskId: string;
  plan: GraphMissionPlan;
}) {
  const team = useAppStore((state) => state.teamByTask[taskId]);
  return (
    <details className="graph-history" data-testid="graph-mission-plan">
      <summary>実行計画案 · {plan.steps.length}工程</summary>
      <div className="graph-history-content">
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
