import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  TeamExecutionSummary,
  TeamMessageSummary,
  WorkerSummary,
} from '../../types/sprint-coder';
import { TeamExecutionStatus } from '../TeamExecutionStatus';
import { TeamMessageMarkdown } from '../TeamMessageMarkdown';
import {
  describeMessagePeer,
  describeWorkerModel,
  workerRuntimeLabel,
} from '../../lib/team-activity-display';
import { describeHierarchy } from './placement';
import { WorkStep } from '../WorkStep';
import {
  executionNeedsAttention,
  workerGlance,
  workerReportText,
  workerThread,
  workStepLabel,
} from '../../lib/worker-thread';
import { workerStatusLabel, workerWorkPhase } from '../../lib/team-execution-display';

const TERMINAL_STATES = new Set<WorkerSummary['state']>(['done', 'failed', 'stopped']);

function statusDotClass(state: WorkerSummary['state']): string {
  if (state === 'ready' || state === 'waiting') return 'ready';
  if (state === 'busy' || state === 'spawning' || state === 'invited') return 'busy';
  if (state === 'done') return 'done';
  return '';
}

// The card shows the end of a Worker's live output only (issue #863): rendering the whole
// stream into a <pre> on every update grew with the run, and the reader follows its tail.
const LIVE_OUTPUT_DISPLAY_CHARS = 4096;

function liveOutputTail(output: string): string {
  return output.length > LIVE_OUTPUT_DISPLAY_CHARS
    ? `…${output.slice(output.length - LIVE_OUTPUT_DISPLAY_CHARS)}`
    : output;
}

// A single Worker card on the Team Canvas. The Leader hires and dispatches Workers on its own
// during its Turn (FR-TEAM-06/13, team-tools.ts) — this card is purely an OBSERVATION surface,
// drawn as a read-only T3 Code / Codex thread with no composer: the Leader's request, the Worker's
// steps (tool calls, file edits) as one-line work-log rows, its streaming text, and its report back
// to the Leader. Who the Worker is and how it runs (hierarchy, model, Connection, execution facts,
// Thread, tokens) sits behind 詳細; only an execution that needs the user is surfaced on the card.
// The user never addresses a Worker directly, only the Leader.
//
// Memoized (issue #863): a Team update touches one or two Workers, and every card re-rendering for
// each one was a large share of the renderer's work with 32 Workers. TeamCanvas passes stable
// callbacks and per-Worker message lists so an unchanged card skips the render.
export const WorkerNode = memo(WorkerNodeCard, (previous, next) => {
  for (const key of Object.keys(next) as (keyof WorkerNodeProps)[])
    if (key !== 'onElement' && previous[key] !== next[key]) return false;
  return Object.keys(previous).length === Object.keys(next).length;
});

type WorkerNodeProps = Parameters<typeof WorkerNodeCard>[0];

function WorkerNodeCard({
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
  onResumeMission,
  onResumeIntegration,
  onElement,
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
  agents: readonly Pick<WorkerSummary, 'id' | 'role'>[];
  x: number;
  y: number;
  /** This Worker's own messages (either end is this Worker), oldest first — split once per
   * update by TeamCanvas rather than filtered by every card. */
  messages: readonly TeamMessageSummary[];
  /** Newest persisted execution row for this Worker, or null when it has none (Core C1b). The
   * card below is derived purely from it — `worker.state` never stands in for it. */
  execution: TeamExecutionSummary | null;
  teamBusy: boolean;
  /** Keyboard-navigation selection ring (Slice 6.1 canvas keyboard nav) — a plain visual/aria
   * prop; the selection index itself lives in TeamCanvas. */
  selected?: boolean;
  onStop: (workerId: string) => void;
  onResumeMission: (missionId: string) => void;
  onResumeIntegration: (executionId: string) => void;
  /** Called with this card's element when it mounts and with null when it unmounts. Not part of
   * the memo comparison: the newest handler is kept in a ref, and the element is attached once
   * per mount with the handler of the render that mounted it. */
  onElement: (workerId: string, element: HTMLDivElement | null) => void;
}) {
  const canStop = !teamBusy && !TERMINAL_STATES.has(worker.state);
  const phase = workerWorkPhase(worker, execution);
  const statusLabel = workerStatusLabel(worker, execution);
  const dotClass = phase === 'waiting_integration' ? 'ready' : statusDotClass(worker.state);
  const model = describeWorkerModel(worker);
  const runtime = workerRuntimeLabel(worker);
  const hierarchy = describeHierarchy(worker, parent);
  const historyRef = useRef<HTMLDivElement>(null);
  const [followingLatest, setFollowingLatest] = useState(true);

  const thread = workerThread(messages, worker.activityLog ?? []);
  const attention = executionNeedsAttention(execution);
  const glance = workerGlance(worker, thread, execution);
  const newestStep = worker.activityLog?.at(-1);
  const newestStepAt = newestStep?.at;
  const newestStepLabel = newestStep?.label;
  const newestMessageId = messages.at(-1)?.id;
  const onElementRef = useRef(onElement);
  useLayoutEffect(() => {
    onElementRef.current = onElement;
  });
  const workerId = worker.id;
  const attachElement = useCallback(
    (element: HTMLDivElement | null) => onElementRef.current(workerId, element),
    [workerId],
  );
  const missionId = execution?.missionId ?? null;
  const executionId = execution?.id ?? null;

  useEffect(() => {
    const element = historyRef.current;
    if (element !== null && followingLatest) element.scrollTop = element.scrollHeight;
    // Keyed on the newest entry, not on the count: once the log reaches its cap a new step replaces
    // the oldest and the length stays the same.
  }, [
    followingLatest,
    thread.length,
    newestStepAt,
    newestStepLabel,
    newestMessageId,
    worker.liveOutput,
    worker.currentActivity,
  ]);

  return (
    <div
      ref={attachElement}
      className={`worker${selected ? ' node-selected' : ''}`}
      id={`team-agent-${worker.id}`}
      data-testid="team-worker"
      data-agent-id={worker.id}
      data-depth={worker.depth}
      data-parent-agent-id={parent?.id ?? ''}
      tabIndex={-1}
      aria-label={`Worker ${worker.role} · ${statusLabel}`}
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
          <span className="w-status-label team-status">{statusLabel}</span>
        </span>
        <button
          type="button"
          className="w-stop-btn"
          disabled={!canStop}
          onClick={() => onStop(workerId)}
        >
          解雇
        </button>
      </div>
      {attention && (
        <div className="w-attention">
          <TeamExecutionStatus
            execution={execution}
            variant="canvas"
            onResume={missionId === null ? undefined : () => onResumeMission(missionId)}
            onResumeIntegration={
              executionId === null ? undefined : () => onResumeIntegration(executionId)
            }
            resumeDisabled={teamBusy}
          />
        </div>
      )}
      {/* Zoomed out (LOD 1/2) the thread is too small to read, so CSS swaps it for this: the role,
          its state in words and the newest line, set large enough to read at that scale. Hidden at
          LOD 0, and hidden from assistive tech always, since it repeats the head and the thread. */}
      <div className="w-glance" aria-hidden="true" data-testid="team-worker-glance">
        <span className="w-glance-role">{worker.role}</span>
        <span className={`w-glance-state ${dotClass}`}>{glance.state}</span>
        {glance.line !== '' && <p className="w-glance-line">{glance.line}</p>}
      </div>
      <div
        className="w-body"
        ref={historyRef}
        tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget;
          setFollowingLatest(element.scrollHeight - element.scrollTop - element.clientHeight < 32);
        }}
        aria-label={`${worker.role}の作業`}
      >
        {thread.map((item) => {
          if (item.kind === 'step') return <WorkStep key={`step-${item.index}`} step={item.step} />;
          const m = item.message;
          // Who the line is with comes from the message's own persisted agent ids (the shared
          // helper TeamListView calls with the same context). The line keeps its markup — tag
          // first, then the Markdown body — because the List/Canvas parity spec diffs innerText.
          const peer = describeMessagePeer(m, {
            agentId: worker.id,
            leaderAgentId,
            agents,
          });
          const incoming = peer.direction === 'incoming';
          return (
            <div key={m.id} className={`w-line${incoming ? ' msg-in' : ' msg-out'}`}>
              <span className={`tag${incoming ? '' : ' out'}`}>{peer.tagLabel}</span>
              <TeamMessageMarkdown text={incoming ? m.content : workerReportText(m.content)} />
            </div>
          );
        })}
        {worker.liveOutput !== '' && (
          // The Worker's own text as it streams — the answer forming, not a log panel.
          <div className="w-stream">{liveOutputTail(worker.liveOutput)}</div>
        )}
        {worker.state === 'busy' && phase !== null && (
          <div className="w-run">
            <span className={phase === 'working' ? 'w-run-title run-title sheen' : 'w-run-title'}>
              {phase !== 'working' ? statusLabel : worker.reasoningActive ? '思考中' : '作業中'}
            </span>
            {/* The current step, unless the log just above already ends with it. */}
            {phase === 'working' &&
              worker.currentActivity !== null &&
              worker.currentActivity !== worker.activityLog?.at(-1)?.label && (
                <span className="w-run-detail">{workStepLabel(worker.currentActivity)}</span>
              )}
          </div>
        )}
        {thread.length === 0 && worker.liveOutput === '' && worker.state !== 'busy' && (
          <p className="w-empty">
            {worker.state === 'done'
              ? '完了'
              : worker.state === 'stopped'
                ? '停止済み'
                : 'Leaderからの依頼を待っています'}
          </p>
        )}
      </div>
      <div className="w-footer">
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
          <div className="w-details-panel">
            {/* Which model this Worker actually got, on which Connection, and where it sits in the
                agent tree. Same helpers, same wording, same testids as TeamListView, so the two
                views never disagree. */}
            <div className="team-exec team-exec-canvas" data-testid="team-worker-model">
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
                <span className="team-exec-value team-exec-instruction">
                  {model.connectionLabel}
                </span>
              </p>
            </div>
            {!attention && (
              <TeamExecutionStatus
                execution={execution}
                variant="canvas"
                onResume={missionId === null ? undefined : () => onResumeMission(missionId)}
                onResumeIntegration={
                  executionId === null ? undefined : () => onResumeIntegration(executionId)
                }
                resumeDisabled={teamBusy}
              />
            )}
            <dl>
              <dt>Thread</dt>
              <dd>{worker.threadId}</dd>
              <dt>Token</dt>
              <dd>{worker.usage.tokens}</dd>
              <dt>更新</dt>
              <dd>
                <time dateTime={worker.updatedAt}>
                  {new Date(worker.updatedAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </time>
              </dd>
            </dl>
          </div>
        </details>
      </div>
    </div>
  );
}
