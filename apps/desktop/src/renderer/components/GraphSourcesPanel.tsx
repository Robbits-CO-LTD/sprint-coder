import { useEffect, useRef, useState } from 'react';
import type {
  GraphSelection,
  GraphSourceRef,
  GraphSourcePreview,
  GraphView,
  GraphSourceStatus,
} from '@sprint-coder/contracts';

const statusText = {
  current: '現在のファイルと一致しています。',
  changed: '読取り後にファイルが変更されています。',
  root_changed: 'Workspaceが変更されているため、現在の内容を表示しません。',
  missing: '参照先のファイルが見つかりません。',
  unavailable: '現在の参照先を確認できませんでした。',
};

export function GraphSourcesPanel({
  view,
  selection,
  freshness,
}: {
  view: GraphView;
  selection: GraphSelection;
  freshness: GraphSourceStatus | null;
}) {
  const [sources, setSources] = useState<GraphSourceRef[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [storedPreviews, setPreviews] = useState<
    Record<string, { value: GraphSourcePreview; sequence: number | undefined }>
  >({});
  const previews = Object.fromEntries(
    Object.entries(storedPreviews)
      .filter(([, entry]) => entry.sequence === freshness?.sequence)
      .map(([id, entry]) => [id, entry.value]),
  );
  const [loading, setLoading] = useState<string | null>(null);
  const alive = useRef(true);
  const annotation = view.annotations?.find(
    (value) => value.elementKind === selection.kind && value.elementId === selection.id,
  );
  useEffect(() => {
    let active = true;
    alive.current = true;
    const api = window.sprintCoder?.graphs;
    if (typeof api?.sources === 'function')
      void api
        .sources({
          taskId: view.taskId,
          renderRevision: view.renderRevision,
          elementKind: selection.kind,
          elementId: selection.id,
        })
        .then((items) => {
          if (active) setSources(items);
        })
        .catch(() => {
          if (active) setError('根拠参照を取得できませんでした。');
        });
    return () => {
      active = false;
      alive.current = false;
    };
  }, [view.taskId, view.renderRevision, selection.kind, selection.id]);
  async function inspect(source: GraphSourceRef) {
    const api = window.sprintCoder?.graphs;
    if (typeof api?.previewSource !== 'function' || loading !== null) return;
    setLoading(source.id);
    const sequence = freshness?.sequence;
    setError(null);
    try {
      const preview = await api.previewSource({
        taskId: view.taskId,
        renderRevision: view.renderRevision,
        sourceId: source.id,
      });
      if (alive.current)
        setPreviews((current) => ({ ...current, [source.id]: { value: preview, sequence } }));
    } catch {
      if (alive.current) setError('根拠参照を確認できませんでした。');
    } finally {
      if (alive.current) setLoading(null);
    }
  }
  return (
    <div className="graph-sources" data-testid="graph-sources">
      <p data-testid="graph-evidence-kind">
        {annotation?.basis === 'inferred'
          ? '推定'
          : annotation?.basis === 'proposed'
            ? '追加案'
            : sources && sources.length > 0
              ? 'コード参照あり'
              : '未確認'}
      </p>
      {annotation ? <p className="settings-hint">AIの説明: {annotation.rationale}</p> : null}
      <strong>根拠ファイル</strong>
      {error ? <p role="alert">{error}</p> : null}
      {sources?.length === 0 ? (
        <p className="settings-hint">この箇所には読取り済みの根拠参照がありません。</p>
      ) : null}
      {sources?.map((source) => (
        <details key={source.id}>
          <summary>
            {source.path}:{source.lineStart}–{source.lineEnd}
          </summary>
          <p className="settings-hint">読取り時点の内容</p>
          <pre>{source.excerpt}</pre>
          <button
            className="settings-secondary-button"
            disabled={loading !== null}
            onClick={() => void inspect(source)}
          >
            {loading === source.id
              ? '確認しています…'
              : previews[source.id]
                ? '再確認'
                : '現在の内容を確認'}
          </button>
          <p role="status" data-testid="graph-source-status">
            {freshness?.phase === 'checking'
              ? '現在の内容を確認しています…'
              : previews[source.id]
                ? statusText[previews[source.id]!.status]
                : freshness?.sources.some((entry) => entry.sourceId === source.id)
                  ? statusText[
                      freshness.sources.find((entry) => entry.sourceId === source.id)!.status
                    ]
                  : '現在のファイルとはまだ照合していません。'}
          </p>
          {previews[source.id]?.currentExcerpt !== null &&
          previews[source.id]?.currentExcerpt !== undefined ? (
            <>
              <p className="settings-hint">
                現在の内容{previews[source.id]!.truncated ? '（一部表示）' : ''}
              </p>
              <pre>{previews[source.id]!.currentExcerpt}</pre>
            </>
          ) : null}
        </details>
      ))}
    </div>
  );
}
