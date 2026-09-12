import { useEffect, useRef, useState, useCallback, type MouseEvent } from 'react';
import type {
  GraphClick,
  GraphSelection,
  GraphView,
  GraphGeneration,
} from '@sprint-coder/contracts';
import { useAppStore } from '../store/appStore';
import { acceptGraphReady, acceptGraphSelection } from '../lib/graph-selection';
import { GraphHistoryPanel } from './GraphHistoryPanel';
import { GraphGenerationNotice } from './GraphGenerationNotice';
import { GraphSourcesPanel } from './GraphSourcesPanel';
import { acceptGraphGeneration } from '../lib/graph-generation';
import { useGraphSourceStatus } from '../lib/use-graph-source-status';
import { GraphMissionPlanPanel } from './GraphMissionPlanPanel';

export function GraphPanel({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const [view, setView] = useState<GraphView | null>(null);
  const [selection, setSelection] = useState<GraphSelection | null>(null);
  // The artifact's diagram is painted before its bridge script has registered the selection
  // listeners, so the panel waits for the artifact to say those listeners exist before presenting
  // the frame as interactive. This is not the same thing as the click reaching it — see
  // forwardFrameClick for the routing half of issue #464.
  const [ready, setReady] = useState(false);
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState<GraphGeneration | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const generationSequence = useRef(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const team = useAppStore((state) => state.teamByTask[taskId]);
  const graphMission = team?.missions.find(
    (mission) =>
      view !== null &&
      mission.graph !== undefined &&
      mission.graph.id === view.id &&
      mission.graph.semanticRevision === view.revision,
  );
  const sendExecutionState = useCallback(() => {
    if (!view) return;
    frame.current?.contentWindow?.postMessage(
      {
        type: 'sprint-graph-execution',
        instanceId: view.instanceId,
        graphId: view.id,
        revision: view.revision,
        nodes:
          graphMission?.steps.flatMap((step) =>
            step.graph ? [{ id: step.graph.nodeId, state: step.state }] : [],
          ) ?? [],
      },
      '*',
    );
  }, [view, graphMission]);
  useEffect(sendExecutionState, [sendExecutionState]);
  // The graph artifact runs out of process. Until Chromium has registered that frame's hit-test
  // region — roughly the first 100ms of its life — a click aimed at the diagram is delivered to
  // THIS renderer instead, and arrives here as a click on the iframe element. That never happens
  // once routing works (the frame consumes the event), so receiving one is itself the evidence
  // that the click was not delivered: forward it in frame-relative coordinates so the artifact can
  // replay it on the element the user aimed at (issue #464).
  const forwardFrameClick = useCallback(
    (event: MouseEvent<HTMLIFrameElement>) => {
      if (view === null || !ready) return;
      const box = event.currentTarget.getBoundingClientRect();
      const forwarded: GraphClick = {
        type: 'sprint-graph-click',
        instanceId: view.instanceId,
        graphId: view.id,
        revision: view.revision,
        x: event.clientX - box.left,
        y: event.clientY - box.top,
      };
      frame.current?.contentWindow?.postMessage(forwarded, '*');
    },
    [view, ready],
  );
  const currentView = useRef<GraphView | null>(null);
  const sourceState = useGraphSourceStatus(
    view,
    selection ? `${selection.kind}:${selection.id}` : null,
  );
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
        setReady(false);
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
      const expected = frame.current?.contentWindow ?? null;
      if (acceptGraphReady(event.data, event.source, expected, view)) setReady(true);
      const accepted = acceptGraphSelection(event.data, event.source, expected, view);
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
        <>
          <iframe
            key={view.instanceId}
            ref={frame}
            src={view.artifactUrl}
            sandbox="allow-scripts"
            title={`${view.title} — Archify`}
            data-testid="graph-frame"
            data-graph-ready={ready ? '1' : '0'}
            onLoad={sendExecutionState}
            onClick={forwardFrameClick}
          />
          {ready ? null : (
            <p className="settings-hint" role="status" data-testid="graph-frame-pending">
              図を操作できるように準備しています…
            </p>
          )}
        </>
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
      {view?.missionPlan ? (
        <GraphMissionPlanPanel
          view={view}
          plan={view.missionPlan}
          sourceStamp={
            sourceState.status?.phase === 'checked' ? sourceState.status.checkedAt : null
          }
        />
      ) : null}
      {sourceState.error ? (
        <p role="status">根拠の現在状態を確認できませんでした。</p>
      ) : sourceState.status ? (
        <p className="settings-hint" role="status" data-testid="graph-source-freshness">
          {sourceState.status.phase === 'checking'
            ? '根拠の現在状態を確認しています…'
            : sourceState.status.sources.length === 0
              ? 'コード根拠の参照はありません。'
              : sourceState.status.sources.every((source) => source.status === 'current')
                ? '確認時点では、根拠ファイルの内容は一致しています。'
                : '古い根拠、または確認できない参照があります。'}
          {sourceState.status.checkedAt
            ? ` 確認: ${new Date(sourceState.status.checkedAt).toLocaleTimeString()}`
            : ''}
          {!sourceState.status.monitoring && sourceState.status.sources.length > 0
            ? ' 自動通知を利用できないため、再表示時に確認します。'
            : ''}
        </p>
      ) : null}
      <section className="graph-comment" aria-label="選択箇所へのコメント">
        {view && selection ? (
          <GraphSourcesPanel
            key={`${view.id}:${view.renderRevision}:${selection.kind}:${selection.id}`}
            view={view}
            selection={selection}
            freshness={sourceState.status}
          />
        ) : null}
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
