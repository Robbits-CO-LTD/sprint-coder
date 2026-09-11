import { useEffect, useState } from 'react';
import type { GraphMissionReview, GraphSourceCheckInput } from '@sprint-coder/contracts';

const messages: Record<GraphMissionReview['issues'][number]['code'], string> = {
  plan_missing: '実行計画案がありません。',
  team_unavailable: '利用できるTeamを確認できません。',
  worker_unavailable: '担当Workerをこのタスクで確認できません。',
  worker_busy: '担当Workerに未完了の作業があります。',
  write_denied: '担当Workerは書込み可能として登録されていません。',
  root_unavailable: 'Workspaceの参照先を確認できません。',
  root_changed: 'Workspaceの実体が変更されています。',
  path_unavailable: '変更範囲のパスを確認できません。',
  source_changed: '根拠ファイルが変わったか、確認できなくなっています。',
  state_changed: '確認中に状態が変わりました。',
};
export function GraphMissionReviewNotice({
  input,
  reviewKey,
}: {
  input: GraphSourceCheckInput;
  reviewKey: string | null;
}) {
  const { taskId, instanceId, renderRevision } = input;
  const scopeKey = JSON.stringify([taskId, instanceId, renderRevision, reviewKey]);
  const [result, setResult] = useState<{ key: string; value: GraphMissionReview | null } | null>(
    null,
  );
  useEffect(() => {
    const request = { taskId, instanceId, renderRevision };
    const api = window.sprintCoder?.graphs;
    if (reviewKey === null || typeof api?.reviewMission !== 'function') return;
    let active = true;
    void api
      .reviewMission(request)
      .then((value) => {
        if (
          active &&
          value.instanceId === instanceId &&
          value.taskId === taskId &&
          value.renderRevision === renderRevision
        )
          setResult({ key: scopeKey, value });
      })
      .catch(() => {
        if (active) setResult({ key: scopeKey, value: null });
      });
    return () => {
      active = false;
    };
  }, [instanceId, taskId, renderRevision, reviewKey, scopeKey]);
  const current = reviewKey !== null && result?.key === scopeKey ? result : null;
  return (
    <div data-testid="graph-mission-review" aria-live="polite">
      {current === null ? (
        <p>担当とWorkspaceを確認しています…</p>
      ) : current.value === null ? (
        <p>参照先の状態を確認できませんでした。</p>
      ) : current.value.matched ? (
        <p>担当とWorkspaceの参照先を確認しました。開始時にもう一度確認します。</p>
      ) : (
        <>
          <strong>開始前に確認が必要です</strong>
          <ul>
            {current.value.issues.map((issue, index) => (
              <li key={index}>
                {issue.stepKey ? `${issue.stepKey}: ` : ''}
                {messages[issue.code]}
                {issue.path ? ` (${issue.path})` : ''}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
