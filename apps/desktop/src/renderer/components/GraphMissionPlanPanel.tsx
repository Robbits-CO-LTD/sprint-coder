import { useState } from 'react';
import { graphResumeActivationIntent } from '../../graph-activation-intent';
import type { GraphMissionPlan, GraphView, TeamMissionStepSummary } from '@sprint-coder/contracts';
import { useAppStore } from '../store/appStore';
import { GraphMissionReviewNotice } from './GraphMissionReviewNotice';

const executionLabels: Record<TeamMissionStepSummary['state'], string> = {
  assigned: '開始待ち',
  queued: '待機中',
  waiting_verification: '確認待ち',
  waiting_rate_limit: '接続待ち',
  running: '実行中',
  waiting_resume: '再開待ち',
  completed: '完了',
  failed: '失敗',
  canceled: '中止',
};
const waitLabels = {
  dependencies: '前提工程待ち',
  resources: '共有資源待ち',
  'write-conflicts': '変更範囲の競合待ち',
  'owner-active': '停止確認待ち',
};

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
  const mission = team?.missions.find(
    (mission) => mission.graph?.id === view.id && mission.graph.semanticRevision === view.revision,
  );
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
      <summary>
        {mission ? '実行状況' : '実行計画案'} · {plan.steps.length}工程
      </summary>
      <div className="graph-history-content">
        {!mission ? (
          <GraphMissionReviewNotice
            input={{ taskId, instanceId: view.instanceId, renderRevision: view.renderRevision }}
            reviewKey={
              sourceStamp === null
                ? null
                : JSON.stringify([view.instanceId, sourceStamp, team?.team.state, workers])
            }
          />
        ) : (
          <p role="status" data-testid="graph-mission-state">
            {mission.state === 'completed'
              ? 'すべての工程が完了しました。'
              : '合意した計画の実行状況'}
          </p>
        )}
        <p className="settings-hint">担当・変更範囲・前提工程を確認し、この計画で開始できます。</p>
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
              {mission?.steps.find((item) => item.graph?.key === step.key)
                ? (() => {
                    const execution = mission.steps.find((item) => item.graph?.key === step.key)!;
                    return (
                      <>
                        <p data-testid="graph-step-state">
                          {execution.graph?.waitReason
                            ? waitLabels[execution.graph.waitReason]
                            : executionLabels[execution.state]}
                          {execution.graph?.resourceState === 'quarantined'
                            ? ' · 資源を保持して停止確認待ち'
                            : ''}
                        </p>
                        {execution.graph?.integrationResumeAvailable ? (
                          <GraphIntegrationResumeButton
                            key={`${view.instanceId}:${execution.executionId}`}
                            view={view}
                            missionId={mission.id}
                            stepKey={step.key}
                            generation={execution.graph.generation}
                          />
                        ) : null}
                      </>
                    );
                  })()
                : null}
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

function GraphIntegrationResumeButton({
  view,
  missionId,
  stepKey,
  generation,
}: {
  view: GraphView;
  missionId: string;
  stepKey: string;
  generation: number;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = {
    taskId: view.taskId,
    instanceId: view.instanceId,
    renderRevision: view.renderRevision,
    missionId,
    stepKey,
    generation,
  };
  const resume = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const api = window.sprintCoder?.graphs;
      if (!api) throw new Error('アプリとの接続を確認できませんでした。');
      await api.resumeIntegration(input);
    } catch (error) {
      setError(error instanceof Error ? error.message : '統合を再開できませんでした。');
    } finally {
      setPending(false);
    }
  };
  return (
    <div>
      <button
        type="button"
        className="button"
        disabled={pending}
        data-computer-use-activation="graph-resume"
        data-computer-use-intent={graphResumeActivationIntent(input)}
        onClick={() => void resume()}
      >
        {pending ? '統合を再開しています…' : '完了した変更の統合を再開'}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
