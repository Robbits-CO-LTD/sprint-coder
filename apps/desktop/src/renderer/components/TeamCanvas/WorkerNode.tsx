import { useState } from 'react';
import type { Ref } from 'react';
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
// `.w-body`). Anatomy matches the mock; the per-worker composer at the bottom is a functional
// addition (not in the static demo) needed to actually message a live Worker.
export function WorkerNode({
  worker,
  x,
  y,
  messages,
  teamBusy,
  selected = false,
  onSend,
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
  onSend: (content: string) => void;
  onStop: () => void;
  ref?: Ref<HTMLDivElement>;
}) {
  const [draft, setDraft] = useState('');
  const canSend = (worker.state === 'ready' || worker.state === 'waiting') && !teamBusy;
  const canStop = !teamBusy && !TERMINAL_STATES.has(worker.state);
  const dotClass = statusDotClass(worker.state);

  const relevant = messages
    .filter((m) => m.targetAgentId === worker.id || m.sourceAgentId === worker.id)
    .sort((a, b) => a.seq - b.seq)
    .slice(-4);

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
          <span className="role-sub">{worker.objective}</span>
        </div>
        <span className={`w-status ${dotClass}`}>
          <span className="dot" aria-hidden="true" />
          <span className="w-status-label team-status">{worker.state}</span>
        </span>
        <button type="button" className="w-stop-btn" disabled={!canStop} onClick={onStop}>
          停止
        </button>
      </div>
      <div className="w-body">
        {relevant.map((m) => {
          const incoming = m.targetAgentId === worker.id;
          return (
            <div key={m.id} className={`w-line${incoming ? ' msg-in' : ''}`}>
              <span className={`tag${incoming ? '' : ' out'}`}>
                {incoming ? 'Leaderから' : '報告'}
              </span>
              {incoming ? m.content : summarize(m.content)}
            </div>
          );
        })}
        {worker.state === 'busy' && (
          <div className="w-run">
            <span className="spinner" aria-hidden="true" />
            <span>{worker.currentActivity ?? '実行中…'}</span>
          </div>
        )}
      </div>
      <form
        className="w-compose"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = draft.trim();
          if (!trimmed || !canSend) return;
          onSend(trimmed);
          setDraft('');
        }}
      >
        <label className="visually-hidden" htmlFor={`team-message-${worker.id}`}>
          依頼
        </label>
        <textarea
          id={`team-message-${worker.id}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={!canSend}
          rows={2}
        />
        <button type="submit" className="cc-btn" disabled={!canSend || !draft.trim()}>
          Leaderから送信
        </button>
      </form>
    </div>
  );
}
