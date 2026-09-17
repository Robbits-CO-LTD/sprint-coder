import { useContext } from 'react';
import type { GraphInlineReference } from '@sprint-coder/contracts';
import { useAppStore } from '../store/appStore';
import { GraphTaskContext } from './GraphTaskContext';
import { Hexagon } from './icons';

/**
 * Where a graph was rendered inside an assistant reply: the anchor Main appends at that moment.
 * The diagram itself lives in the graph panel beside the chat, which opened on its own when the
 * tool ran; this card marks the spot in the reply and is the way back to the panel once closed.
 */
export function InlineGraphCard({ reference }: { reference: GraphInlineReference }) {
  const contextTaskId = useContext(GraphTaskContext);
  const selectedTaskId = useAppStore((s) => s.selectedTaskId);
  const requestGraphOpen = useAppStore((s) => s.requestGraphOpen);
  const taskId = contextTaskId ?? selectedTaskId;
  const kindLabel = reference.kind === 'architecture' ? '構成図' : '作業フロー';
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
          {`${kindLabel} · 版 ${reference.revision} · ノード ${reference.nodeCount} · 接続 ${reference.edgeCount}`}
        </span>
      </div>
      <button
        type="button"
        className="settings-secondary-button inline-graph-open"
        data-testid="inline-graph-open"
        disabled={taskId === null}
        onClick={() => {
          if (taskId !== null) requestGraphOpen(taskId);
        }}
      >
        グラフを開く
      </button>
    </div>
  );
}
