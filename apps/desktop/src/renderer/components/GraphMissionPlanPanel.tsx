import { useState } from 'react';
import {
  graphResumeActivationIntent,
  graphResumeStepActivationIntent,
} from '../../graph-activation-intent';
import type {
  GraphMissionPlan,
  GraphView,
  TeamMissionStepSummary,
  GraphWorkspaceReview,
} from '@sprint-coder/contracts';
import { useAppStore } from '../store/appStore';
import { GraphMissionReviewNotice } from './GraphMissionReviewNotice';
import { useGraphDisclosure } from '../lib/graph-view-preference';

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
  const [open, setOpen] = useGraphDisclosure(view, 'planOpen');
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
    <details
      className="graph-history"
      data-testid="graph-mission-plan"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
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
                            : execution.graph?.stepResumePending
                              ? '再開済み · 依存の完了待ち'
                              : executionLabels[execution.state]}
                          {execution.graph?.resourceState === 'quarantined'
                            ? ' · 資源を保持して停止確認待ち'
                            : ''}
                        </p>
                        {execution.graph?.integrationResumeAvailable ||
                        execution.graph?.stepResumeAvailable ? (
                          <GraphResumeButton
                            // The mode is part of the identity: a pending/error left over from one
                            // resume must not carry into the other.
                            key={`${view.instanceId}:${execution.executionId}:${execution.graph.generation}:${
                              execution.graph.integrationResumeAvailable ? 'integration' : 'step'
                            }`}
                            view={view}
                            missionId={mission.id}
                            stepKey={step.key}
                            generation={execution.graph.generation}
                            integration={execution.graph.integrationResumeAvailable}
                            reviewRequired={execution.graph.workspaceReviewRequired ?? false}
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

/**
 * One control for the two ways a parked graph step moves again. `integration` means the Worker
 * already delivered its result and only the repository step is left, so it resumes that and never
 * runs the Worker again; otherwise the step itself is dispatched once more. Each half carries its
 * own trusted-activation kind and intent, so an activation for one can never drive the other.
 */
function GraphResumeButton({
  view,
  missionId,
  stepKey,
  generation,
  integration,
  reviewRequired,
}: {
  view: GraphView;
  missionId: string;
  stepKey: string;
  generation: number;
  integration: boolean;
  reviewRequired: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<GraphWorkspaceReview | null>(null);
  const input = {
    taskId: view.taskId,
    instanceId: view.instanceId,
    renderRevision: view.renderRevision,
    missionId,
    stepKey,
    generation,
    ...(!integration && review ? { workspaceReviewDigest: review.digest } : {}),
  };
  const resume = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const api = window.sprintCoder?.graphs;
      if (!api) throw new Error('アプリとの接続を確認できませんでした。');
      if (integration) await api.resumeIntegration(input);
      else await api.resumeStep(input);
    } catch (error) {
      setReview(null);
      setError(error instanceof Error ? error.message : '再開できませんでした。');
    } finally {
      setPending(false);
    }
  };
  return (
    <div>
      {!integration && reviewRequired ? (
        <>
          <p>中断前の変更を保持しています。変更一覧を確認し、同じ作業場所で続きを実行できます。</p>
          <button
            type="button"
            className="settings-secondary-button"
            disabled={pending}
            onClick={() => {
              setPending(true);
              setError(null);
              setReview(null);
              const api = window.sprintCoder?.graphs;
              if (!api) {
                setError('アプリとの接続を確認できませんでした。');
                setPending(false);
                return;
              }
              void api
                .reviewWorkspace(input)
                .then(setReview)
                .catch(() => {
                  setError(
                    '保持した変更を確認できませんでした。停止状態と作業場所を確認してください。',
                  );
                })
                .finally(() => setPending(false));
            }}
          >
            保持した変更一覧を確認
          </button>
          {review ? (
            <div data-testid="graph-workspace-review">
              <p>
                {review.files.length}ファイルの変更を保持しています。完了・統合済みではありません。
              </p>
              <ul>
                {review.files.map((file) => (
                  <li key={`${file.repository}:${file.path}`}>
                    リポジトリ {file.repository}: {file.path}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
      <button
        type="button"
        className="button"
        disabled={pending || (!integration && reviewRequired && !review)}
        data-computer-use-activation={integration ? 'graph-resume' : 'graph-resume-step'}
        data-computer-use-intent={
          integration ? graphResumeActivationIntent(input) : graphResumeStepActivationIntent(input)
        }
        onClick={() => void resume()}
      >
        {pending
          ? '確認しています…'
          : integration
            ? '完了した変更の統合を再開'
            : reviewRequired
              ? '変更を保持して工程を再開'
              : 'この工程を再開'}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
