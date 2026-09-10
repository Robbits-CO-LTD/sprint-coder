import { useEffect, useRef, useState } from 'react';
import type { GraphSelection, GraphView, GraphGeneration } from '@sprint-coder/contracts';
import { useAppStore } from '../store/appStore';
import { acceptGraphSelection } from '../lib/graph-selection';
import { GraphHistoryPanel } from './GraphHistoryPanel';
import { GraphGenerationNotice } from './GraphGenerationNotice';
import { acceptGraphGeneration } from '../lib/graph-generation';

export function GraphPanel({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const [view, setView] = useState<GraphView | null>(null);
  const [selection, setSelection] = useState<GraphSelection | null>(null);
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState<GraphGeneration | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const generationSequence = useRef(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const currentView = useRef<GraphView | null>(null);
  useEffect(() => {
    const api = window.sprintCoder?.graphs;
    if (typeof api?.generation !== 'function' || typeof api.subscribeGeneration !== 'function')
      return;
    let active = true;
    const update = (value: unknown) => {
      if (!active) return;
      const accepted = acceptGraphGeneration(value, taskId, generationSequence.current);
      if (!accepted) return;
      generationSequence.current = accepted.sequence;
      setGeneration(accepted);
      setCancelError(null);
    };
    const unsubscribe = api.subscribeGeneration(update);
    void api
      .generation(taskId)
      .then(update)
      .catch(() => {
        if (active) setCancelError('図の生成状態を確認できませんでした。');
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [taskId]);
  useEffect(() => {
    let disposed = false;
    const api = window.sprintCoder?.graphs;
    if (api === undefined) return;
    const update = (next: GraphView) => {
      if (
        !disposed &&
        next.taskId === taskId &&
        (currentView.current?.viewRevision ?? 0) < next.viewRevision
      ) {
        currentView.current = next;
        setView(next);
        setSelection(null);
        setError(null);
      }
    };
    const unsubscribe = api.subscribe(update);
    void api
      .get(taskId)
      .then((next) => {
        if (disposed && next) void api.release(taskId, next.instanceId).catch(() => undefined);
        else if (next) update(next);
      })
      .catch(() => {
        if (!disposed) setError('グラフを取得できませんでした。');
      });
    return () => {
      disposed = true;
      unsubscribe();
      if (currentView.current)
        void api.release(taskId, currentView.current.instanceId).catch(() => undefined);
    };
  }, [taskId]);
  useEffect(() => {
    if (view === null) return;
    const listener = (event: MessageEvent) => {
      const accepted = acceptGraphSelection(
        event.data,
        event.source,
        frame.current?.contentWindow ?? null,
        view,
      );
      if (accepted !== null) setSelection(accepted);
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [view]);
  function insertComment() {
    if (!selection || !comment.trim()) return;
    const reference = JSON.stringify({
      graphId: selection.graphId,
      revision: selection.revision,
      kind: selection.kind,
      id: selection.id,
    });
    const state = useAppStore.getState();
    const current = state.draftByTask[taskId] ?? '';
    state.setDraft(
      taskId,
      `${current}${current ? '\n\n' : ''}${comment.trim()}\n\n参照する図の識別情報:\n${reference}`,
    );
    setComment('');
  }
  return (
    <aside className="graph-panel" data-testid="graph-panel" aria-label="設計・作業グラフ">
      <header>
        <div>
          <strong>{view?.title ?? 'グラフ'}</strong>
          {view ? (
            <small>
              {view.kind === 'architecture' ? '構成図' : '作業フロー'} · 版 {view.revision}
            </small>
          ) : null}
        </div>
        <button type="button" className="settings-secondary-button" onClick={onClose}>
          閉じる
        </button>
      </header>
      {generation ? (
        <GraphGenerationNotice
          generation={generation}
          view={view}
          onCancel={() => {
            setCancelError(null);
            const sequence = generationSequence.current;
            void window.sprintCoder?.graphs.cancel(taskId, generation.id).catch(() => {
              if (generationSequence.current === sequence)
                setCancelError('取消処理を確認できませんでした。');
            });
          }}
        />
      ) : null}
      {cancelError ? (
        <p role="alert" className="settings-provider-error">
          {cancelError}
        </p>
      ) : null}
      {view ? (
        <iframe
          key={view.instanceId}
          ref={frame}
          src={view.artifactUrl}
          sandbox="allow-scripts"
          title={`${view.title} — Archify`}
          data-testid="graph-frame"
        />
      ) : (
        <p className="settings-hint">
          作成した図をここで確認できます。図の表示だけでは作業を開始しません。
        </p>
      )}
      {error ? (
        <p role="alert" className="settings-provider-error">
          {error}
        </p>
      ) : null}
      {view ? <GraphHistoryPanel key={`${view.id}:${view.renderRevision}`} view={view} /> : null}
      <section className="graph-comment" aria-label="選択箇所へのコメント">
        <p className="settings-hint" data-testid="graph-selection">
          {selection
            ? `選択: ${selection.kind === 'node' ? 'ノード' : '接続'} ${selection.id}`
            : '図のノードまたは接続を選択してください。'}
        </p>
        <label htmlFor={`graph-comment-${taskId}`}>この箇所への指示</label>
        <textarea
          id={`graph-comment-${taskId}`}
          className="settings-text-input"
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          maxLength={4000}
          disabled={!selection}
        />
        <button
          type="button"
          className="settings-secondary-button"
          onClick={insertComment}
          disabled={!selection || !comment.trim()}
        >
          チャット入力へ追加
        </button>
      </section>
    </aside>
  );
}
