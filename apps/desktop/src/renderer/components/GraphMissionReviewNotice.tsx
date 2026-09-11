import { useEffect, useState } from 'react';
import { graphStartActivationIntent } from '../../graph-activation-intent';
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
  const [retry, setRetry] = useState(0);
  const [start, setStart] = useState<{
    key: string;
    state: 'starting' | 'started' | 'failed';
    error?: string;
  } | null>(null);
  const scopeKey = JSON.stringify([taskId, instanceId, renderRevision, reviewKey, retry]);
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
  const action = start?.key === scopeKey ? start : null;
  const startInput = current?.value?.matched
    ? { taskId, instanceId, renderRevision, contextDigest: current.value.contextDigest }
    : null;
  const begin = async () => {
    if (startInput === null || action?.state === 'starting' || action?.state === 'started') return;
    setStart({ key: scopeKey, state: 'starting' });
    try {
      const api = window.sprintCoder?.graphs;
      if (!api) throw new Error('アプリとの接続を確認できませんでした。');
      await api.startMission(startInput);
      setStart({ key: scopeKey, state: 'started' });
    } catch (error) {
      setStart({
        key: scopeKey,
        state: 'failed',
        error: error instanceof Error ? error.message : '開始できませんでした。',
      });
    }
  };
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
      {startInput !== null && action?.state !== 'failed' ? (
        <button
          type="button"
          className="button button-primary"
          data-computer-use-activation="graph-start"
          data-computer-use-intent={graphStartActivationIntent(startInput)}
          disabled={action?.state === 'starting' || action?.state === 'started'}
          onClick={() => void begin()}
        >
          {action?.state === 'starting'
            ? '開始しています…'
            : action?.state === 'started'
              ? '開始しました'
              : 'この計画で開始'}
        </button>
      ) : null}
      {action?.state === 'failed' ? <p role="alert">{action.error}</p> : null}
      {current !== null &&
      (current.value === null || !current.value.matched || action?.state === 'failed') ? (
        <button type="button" className="button" onClick={() => setRetry((value) => value + 1)}>
          もう一度確認
        </button>
      ) : null}
    </div>
  );
}
