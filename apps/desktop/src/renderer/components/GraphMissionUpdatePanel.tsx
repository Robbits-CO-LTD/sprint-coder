import { useState } from 'react';
import type {
  GraphDiff,
  GraphMissionUpdateInput,
  GraphMissionUpdateReview,
} from '@sprint-coder/contracts';
import { graphUpdateActivationIntent } from '../../graph-activation-intent';
import { GraphDifference } from './GraphHistoryPanel';

export function GraphMissionUpdatePanel({ input }: { input: GraphMissionUpdateInput }) {
  const [review, setReview] = useState<GraphMissionUpdateReview | null>(null);
  const [diff, setDiff] = useState<GraphDiff | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = async () => {
    if (pending) return;
    setPending(true);
    setReview(null);
    setDiff(null);
    setError(null);
    try {
      const api = window.sprintCoder?.graphs;
      if (!api) throw new Error('アプリとの接続を確認できませんでした。');
      const value = await api.requestUpdate(input);
      const difference = await api.compare({
        taskId: input.taskId,
        beforeRenderRevision: value.beforeRenderRevision,
        afterRenderRevision: input.renderRevision,
      });
      setReview(value);
      setDiff(difference);
    } catch (error) {
      setError(error instanceof Error ? error.message : '変更の確認を完了できませんでした。');
    } finally {
      setPending(false);
    }
  };
  const agreement = review
    ? { ...input, requestId: review.requestId, contextDigest: review.contextDigest }
    : null;
  const agree = async () => {
    if (!agreement || !diff || pending) return;
    setPending(true);
    setError(null);
    try {
      const api = window.sprintCoder?.graphs;
      if (!api) throw new Error('アプリとの接続を確認できませんでした。');
      await api.agreeUpdate(agreement);
      setReview(null);
      setDiff(null);
    } catch (error) {
      setReview(null);
      setDiff(null);
      setError(error instanceof Error ? error.message : '更新できませんでした。');
    } finally {
      setPending(false);
    }
  };
  return (
    <section data-testid="graph-mission-update" aria-label="実行計画の更新">
      <p>表示中の案は未合意です。現在の実行計画は版 {input.expectedSemanticRevision} です。</p>
      <p>
        依存・変更範囲・共有資源を更新できます。担当・権限・完了条件・工程構造の変更は、現行計画を停止・取消した後の別案として扱います。
      </p>
      <button
        type="button"
        className="button"
        disabled={pending}
        data-computer-use-activation="graph-start"
        data-computer-use-intent={graphUpdateActivationIntent(input, 'request')}
        onClick={() => void request()}
      >
        影響する工程を停止して変更を確認
      </button>
      {pending ? <p role="status">停止状態と変更内容を確認しています…</p> : null}
      {review && diff ? (
        <>
          <p>
            停止を確認した工程:{' '}
            {review.affectedKeys.length
              ? review.affectedKeys.join('・')
              : 'なし（工程の条件変更なし）'}
          </p>
          <p>
            独立した工程は継続します。次の差分に合意すると、変更後の条件で対象工程を再開します。
          </p>
          <GraphDifference diff={diff} />
          <button
            type="button"
            className="button button-primary"
            disabled={pending}
            data-computer-use-activation="graph-start"
            data-computer-use-intent={graphUpdateActivationIntent(agreement!, 'agree')}
            onClick={() => void agree()}
          >
            この変更に再合意して再開
          </button>
        </>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
