import { useEffect, useRef, useState, type Ref } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  TeamExecutionSummary,
  TeamMessageSummary,
  WorkerSummary,
} from '../../types/sprint-coder';
import { TeamExecutionStatus } from '../TeamExecutionStatus';
import {
  describeMessagePeer,
  describeWorkerModel,
  workerRuntimeLabel,
} from '../../lib/team-activity-display';
import { describeHierarchy } from './placement';

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
// message lines (tagged with the counterpart's own role) and a busy spinner. There is no
// per-worker composer; the user never
// addresses a Worker directly, only the Leader.
export function WorkerNode({
  worker,
  parent,
  leaderAgentId,
  agents,
  x,
  y,
  messages,
  execution,
  teamBusy,
  selected = false,
  onStop,
  ref,
}: {
  worker: WorkerSummary;
  /** The Worker that hired this one, or null when its parent is the Leader (Team v2 hierarchy).
   * Resolved by TeamCanvas from `worker.parentAgentId` — the exact same resolution TeamListView
   * does — so both views name the same parent. */
  parent: WorkerSummary | null;
  /** `team.leaderAgentId` — the only id the message lines below may name "Leader". */
  leaderAgentId: string;
  /** Every Worker in the Team, so a message from a SIBLING Worker can be named by its own role
   * instead of being attributed to the Leader. Same list TeamListView resolves against. */
  agents: readonly WorkerSummary[];
  x: number;
  y: number;
  messages: TeamMessageSummary[];
  /** Newest persisted execution row for this Worker, or null when it has none (Core C1b). The
   * card below is derived purely from it — `worker.state` never stands in for it. */
  execution: TeamExecutionSummary | null;
  teamBusy: boolean;
  /** Keyboard-navigation selection ring (Slice 6.1 canvas keyboard nav) — a plain visual/aria
   * prop; the selection index itself lives in TeamCanvas. */
  selected?: boolean;
  onStop: () => void;
  ref?: Ref<HTMLDivElement>;
}) {
  const canStop = !teamBusy && !TERMINAL_STATES.has(worker.state);
  const dotClass = statusDotClass(worker.state);
  const model = describeWorkerModel(worker);
  const runtime = workerRuntimeLabel(worker);
  const hierarchy = describeHierarchy(worker, parent);
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
      data-depth={worker.depth}
      data-parent-agent-id={parent?.id ?? ''}
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
          {/* The runtime name comes from the shared helper, not from `engine`: an external-API
              Worker still carries a mock/codex/claude `engine` for backend compatibility, so
              reading it here announced GPT-5 Workers as "Claude". TeamListView renders the exact
              same helper into the exact same sub-line. */}
          <span className="role-sub">
            {runtime} · {worker.objective}
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
      {/* Which model this Worker actually got, and on which Connection (Team v2). The exact same
          block, from the exact same helper, is rendered by TeamListView — only the variant class
          differs, exactly as TeamExecutionStatus does it — so List/Canvas parity holds by
          construction. Reuses the execution card's own key/value classes so no new styling (and no
          new animation for `prefers-reduced-motion` to suppress) is introduced. Inert: no button,
          no `tabIndex`, no `<details>`, so the Canvas's arrow-key node order is unchanged. */}
      <div className="team-exec team-exec-canvas" data-testid="team-worker-model">
        {/* Where this Worker sits in the Team's agent tree (Team v2 hierarchy). Same helper, same
            wording, same testid as TeamListView's row — the depth/parent/kind facts must read
            identically in both views. */}
        <p className="team-exec-row" data-testid="team-worker-hierarchy">
          <span className="team-exec-key">階層</span>
          <span className="team-exec-value team-exec-instruction">{hierarchy}</span>
        </p>
        <p className="team-exec-row" data-testid="team-worker-model-name">
          <span className="team-exec-key">モデル</span>
          <span className="team-exec-value team-exec-instruction">{model.modelLabel}</span>
        </p>
        <p className="team-exec-row" data-testid="team-worker-model-connection">
          <span className="team-exec-key">Connection</span>
          <span className="team-exec-value team-exec-instruction">{model.connectionLabel}</span>
        </p>
      </div>
      <TeamExecutionStatus execution={execution} variant="canvas" />
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
          // Who the line is with comes from the message's own persisted agent ids (the shared
          // helper TeamListView calls with the same context), not from the old assumption that a
          // Worker only ever talks to the Leader. Direction is decided exactly as before, so
          // ordering, styling and the rendered body are unchanged.
          const peer = describeMessagePeer(m, {
            agentId: worker.id,
            leaderAgentId,
            agents,
          });
          const incoming = peer.direction === 'incoming';
          return (
            <div key={m.id} className={`w-line${incoming ? ' msg-in' : ''}`}>
              <span className={`tag${incoming ? '' : ' out'}`}>{peer.tagLabel}</span>
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
