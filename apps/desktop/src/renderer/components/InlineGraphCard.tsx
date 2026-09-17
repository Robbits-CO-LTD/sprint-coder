import { useContext } from 'react';
import type { ReactNode } from 'react';
import type { GraphInlineReference } from '@sprint-coder/contracts';
import { useAppStore } from '../store/appStore';
import { knownGraphVersion } from '../lib/graph-anchor';
import { GraphTaskContext } from './GraphTaskContext';
import { Hexagon } from './icons';

/** An anchor's reference, or a saved version (whose node and edge counts are not recorded). */
export type InlineGraphCardReference = Omit<GraphInlineReference, 'nodeCount' | 'edgeCount'> &
  Partial<Pick<GraphInlineReference, 'nodeCount' | 'edgeCount'>>;

/**
 * Where a graph was rendered inside an assistant reply: the anchor Main appends at that moment.
 * The diagram itself lives in the graph panel beside the chat, which opened on its own when the
 * tool ran; this card marks the spot in the reply and is the way back to the panel once closed.
 *
 * The card only appears when the reference names a version this Task really saved. Main writes
 * the anchor, but a model can type the same fence, so a reference the loaded history does not
 * know renders `fallback` (the ordinary code block) instead of a card that claims a graph which
 * does not exist. Until that history has loaded — or if it cannot be read — nothing is known
 * either way, and a quiet placeholder stands in: never the raw anchor JSON, never a false card.
 */
export function InlineGraphCard({
  reference,
  fallback = null,
  caption,
}: {
  reference: InlineGraphCardReference;
  fallback?: ReactNode;
  caption?: string;
}) {
  const contextTaskId = useContext(GraphTaskContext);
  const selectedTaskId = useAppStore((s) => s.selectedTaskId);
  const taskId = contextTaskId ?? selectedTaskId;
  const versions = useAppStore((s) =>
    taskId === null ? undefined : s.graphVersionsByTask[taskId],
  );
  const versionsState = useAppStore((s) =>
    taskId === null ? undefined : s.graphVersionsStateByTask[taskId],
  );
  const requestGraphOpen = useAppStore((s) => s.requestGraphOpen);
  const kindLabel = reference.kind === 'architecture' ? '構成図' : '作業フロー';
  if (taskId === null || !knownGraphVersion(versions, reference)) {
    if (taskId !== null && versionsState === 'loaded') return <>{fallback}</>;
    return (
      <p className="inline-graph-pending" data-testid="inline-graph-pending" role="status">
        {versionsState === 'unavailable'
          ? `${kindLabel}「${reference.title}」の保存済みの版を確認できませんでした。`
          : `${kindLabel}「${reference.title}」の参照を確認しています…`}
      </p>
    );
  }
  const counts =
    reference.nodeCount === undefined || reference.edgeCount === undefined
      ? ''
      : ` · ノード ${reference.nodeCount} · 接続 ${reference.edgeCount}`;
  return (
    <div
      className="inline-graph-card"
      data-testid="inline-graph-card"
      data-graph-id={reference.graphId}
      data-graph-revision={String(reference.revision)}
      role="note"
    >
      <span className="inline-graph-mark" aria-hidden="true">
        <Hexagon size={16} />
      </span>
      <div className="inline-graph-body">
        <strong className="inline-graph-title">{reference.title}</strong>
        <span className="inline-graph-meta">
          {`${caption === undefined ? '' : `${caption} · `}${kindLabel} · 版 ${reference.revision}${counts}`}
        </span>
      </div>
      <button
        type="button"
        className="settings-secondary-button inline-graph-open"
        data-testid="inline-graph-open"
        onClick={() => requestGraphOpen(taskId)}
      >
        グラフを開く
      </button>
    </div>
  );
}
