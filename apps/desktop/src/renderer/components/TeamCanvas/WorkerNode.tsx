import { useEffect, useRef, useState, type Ref } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { TeamMessageSummary, WorkerSummary } from '../../types/sprint-coder';

const TERMINAL_STATES = new Set<WorkerSummary['state']>(['done', 'failed', 'stopped']);

function statusDotClass(state: WorkerSummary['state']): string {
  if (state === 'ready' || state === 'waiting') return 'ready';
  if (state === 'busy' || state === 'spawning' || state === 'invited') return 'busy';
  if (state === 'done') return 'done';
  return '';
}

// Worker report messages are structured envelopes; unwrap `{summary}` when present (see
// demo/index.html's `results` map) and fall back to the raw content otherwise.
function summarize(content: string): string {
  try {
    const parsed = JSON.parse(content) as { summary?: unknown };
    return typeof parsed.summary === 'string' ? parsed.summary : content;
  } catch {
    return content;
  }
}

// A single Worker card on the Team Canvas (demo/index.html lines 346-388, `.worker`/`.w-head`/
// `.w-body`). The Leader hires and dispatches Workers on its own during its Turn (FR-TEAM-06/13,
// team-tools.ts) — this card is purely an OBSERVATION surface: role/objective/status/stop plus the
// Leaderから/報告 message lines and a busy spinner. There is no per-worker composer; the user never
// addresses a Worker directly, only the Leader.
export function WorkerNode({
  worker,
  x,
  y,
  messages,
  teamBusy,
  selected = false,
  onStop,
  ref,
}: {
  worker: WorkerSummary;
  x: number;
  y: number;
  messages: TeamMessageSummary[];
  teamBusy: boolean;
  /** Keyboard-navigation selection ring (Slice 6.1 canvas keyboard nav) — a plain visual/aria
   * prop; the selection index itself lives in TeamCanvas. */
  selected?: boolean;
  onStop: () => void;
  ref?: Ref<HTMLDivElement>;
}) {
  const canStop = !teamBusy && !TERMINAL_STATES.has(worker.state);
  const dotClass = statusDotClass(worker.state);
  const historyRef = useRef<HTMLDivElement>(null);
  const [followingLatest, setFollowingLatest] = useState(true);

  const relevant = messages
    .filter((m) => m.targetAgentId === worker.id || m.sourceAgentId === worker.id)
    .sort((a, b) => a.seq - b.seq);

  useEffect(() => {
    const element = historyRef.current;
    if (element !== null && followingLatest) element.scrollTop = element.scrollHeight;
  }, [followingLatest, relevant.length, worker.currentActivity]);

  return (
    <div
      ref={ref}
      className={`worker${selected ? ' node-selected' : ''}`}
      id={`team-agent-${worker.id}`}
      data-testid="team-worker"
      data-agent-id={worker.id}
      tabIndex={-1}
      aria-label={`Worker ${worker.role} · ${worker.state}`}
      style={{ left: x, top: y }}
    >
      {/* Drag handle (Slice 6.1 layout persistence): TeamCanvas attaches a pointerdown listener
          scoped to `.w-head` (excluding buttons) to reposition this card in world coordinates.
          Camera panning already ignores anything inside `.worker` (see useCamera's pointerdown
          guard), so there is no pan/drag conflict to resolve here. */}
      <div className="w-head">
        <div className="w-avatar" aria-hidden="true">
          {worker.role.slice(0, 1) || '?'}
        </div>
        <div className="role-line">
          <span className="role-name">{worker.role}</span>
          <span className="role-sub">
            {worker.engine === 'claude' ? 'Claude' : worker.engine === 'codex' ? 'Codex' : 'Mock'} ·{' '}
            {worker.objective}
          </span>
        </div>
        <span className={`w-status ${dotClass}`}>
          <span className="dot" aria-hidden="true" />
          <span className="w-status-label team-status">{worker.state}</span>
        </span>
        <button type="button" className="w-stop-btn" disabled={!canStop} onClick={onStop}>
          停止
        </button>
      </div>
      <div className="w-activity" aria-live="polite">
        {worker.currentActivity ?? (worker.state === 'done' ? '完了' : worker.state)}
      </div>
      <div
        className="w-body"
        ref={historyRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          setFollowingLatest(element.scrollHeight - element.scrollTop - element.clientHeight < 32);
        }}
        aria-label={`${worker.role}の通信履歴`}
      >
        {relevant.map((m) => {
          const incoming = m.targetAgentId === worker.id;
          return (
            <div key={m.id} className={`w-line${incoming ? ' msg-in' : ''}`}>
              <span className={`tag${incoming ? '' : ' out'}`}>
                {incoming ? 'Leaderから' : '報告'}
              </span>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                skipHtml
                disallowedElements={['img']}
                unwrapDisallowed
              >
                {incoming ? m.content : summarize(m.content)}
              </ReactMarkdown>
            </div>
          );
        })}
        {worker.liveOutput !== '' && (
          <div className="w-line w-live-output">
            <span className="tag">Live</span>
            <pre>{worker.liveOutput}</pre>
          </div>
        )}
        {worker.state === 'busy' && (
          <div className="w-run">
            <span className="spinner" aria-hidden="true" />
            <span>
              {worker.currentActivity ?? (worker.reasoningActive ? '方針を検討中…' : '実行中…')}
            </span>
          </div>
        )}
      </div>
      <div className="w-footer">
        <time dateTime={worker.updatedAt}>
          更新{' '}
          {new Date(worker.updatedAt).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </time>
        {!followingLatest && (
          <button
            type="button"
            className="w-latest-btn"
            onClick={() => {
              const element = historyRef.current;
              if (element !== null) element.scrollTop = element.scrollHeight;
              setFollowingLatest(true);
            }}
          >
            最新へ
          </button>
        )}
        <details className="w-details">
          <summary>詳細</summary>
          <dl>
            <dt>状態</dt>
            <dd>{worker.state}</dd>
            <dt>Thread</dt>
            <dd>{worker.threadId}</dd>
            <dt>Token</dt>
            <dd>{worker.usage.tokens}</dd>
          </dl>
        </details>
      </div>
    </div>
  );
}
