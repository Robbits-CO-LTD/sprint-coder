import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAppStore } from '../store/appStore';
import { ArrowLeft, LayoutGrid } from './icons';
import { TeamExecutionStatus } from './TeamExecutionStatus';
import { TeamPolicyDialog, TeamPolicyTrigger } from './TeamPolicyDialog';
import { latestExecutionForWorker } from '../lib/team-execution-display';
import {
  describeMessagePeer,
  describeWorkerModel,
  workerRuntimeLabel,
} from '../lib/team-activity-display';
// Hierarchy vocabulary is imported from the Canvas's placement module on purpose: it is a pure,
// DOM-free helper, and sharing it (rather than re-wording the same facts here) is what keeps
// List/Canvas parity true by construction — the same reason this view reuses the Canvas's testids.
import { describeHierarchy, parentAgentOf } from './TeamCanvas/placement';
import type { TaskSummary, TeamMessageSummary, WorkerSummary } from '../types/sprint-coder';

const TERMINAL_STATES = new Set<WorkerSummary['state']>(['done', 'failed', 'stopped']);

// Team List View (Slice 6.1 item 4): an accessible ALTERNATE projection of the exact same store
// selectors/actions the Canvas uses (see TeamCanvas.tsx) — not a simplified or read-only variant.
// Reintroduces the pre-Canvas list (see `git show 5d6238d -- .../TeamListView.tsx` for the deleted
// original) as a cleaner, presentational rewrite. Canvas and List are mutually exclusive (App only
// ever mounts one at a time per the renderer-only view preference), so this intentionally reuses
// the Canvas's testids/labels (`team-worker`, `team-stop-all`, …) — there is never a collision,
// and e2e specs can keep one selector for either mode.
//
// The Leader hires and dispatches Workers on its own during its Turn (FR-TEAM-06/13,
// team-tools.ts) — there is no hire form or per-worker send form here either; this stays an
// observation surface, exactly like the Canvas's Worker cards.
export function TeamListView({
  task,
  onBack,
  onSwitchToCanvasView,
}: {
  task: TaskSummary;
  /** Exits Team mode entirely (mirrors TeamCanvas's "← Chatに戻る"). List mode never plays the
   * Canvas's camera FLIP — there's no camera here — so this is a direct store toggle. */
  onBack: () => void;
  /** Switches the renderer-only Team view preference back to 'canvas'. */
  onSwitchToCanvasView: () => void;
}) {
  const detail = useAppStore((state) => state.teamByTask[task.id]);
  const teamBusy = useAppStore((state) => state.teamBusy);
  const stopTeamWorker = useAppStore((state) => state.stopTeamWorker);
  const resumeTeamMission = useAppStore((state) => state.resumeTeamMission);
  const stopAllTeamWorkers = useAppStore((state) => state.stopAllTeamWorkers);
  const sectionRef = useRef<HTMLElement>(null);
  // Open state is local to the view, not the store: the dialog is a modal task (open, adjust,
  // close), and each view owns its own instance of the SAME component — see TeamPolicyDialog.tsx.
  const [policyOpen, setPolicyOpen] = useState(false);

  // Mount-time focus (a11y fix, Phase 7 / NFR-A11Y-02), mirroring TeamCanvas's own mount-focus
  // fix: switching from Canvas to List view (the "List表示" button, itself INSIDE TeamCanvas)
  // unmounts TeamCanvas in the very same commit this component mounts. Without this, the browser
  // drops focus to `document.body` the instant that button's own DOM node is removed — moving
  // focus onto this view's root the moment it exists keeps keyboard focus somewhere sensible.
  useEffect(() => {
    sectionRef.current?.focus({ preventScroll: true });
  }, []);

  if (!detail) {
    return (
      <section
        ref={sectionRef}
        className="team-list-view"
        data-testid="team-list"
        aria-label="Team list"
        aria-labelledby="team-list-title"
        tabIndex={-1}
      >
        <h2 id="team-list-title">Teamを準備しています</h2>
      </section>
    );
  }

  const workers = detail.workers.filter((w) => w.kind === 'worker');

  return (
    <section
      ref={sectionRef}
      className="team-list-view"
      data-testid="team-list"
      aria-label="Team list"
      aria-labelledby="team-list-title"
      tabIndex={-1}
    >
      <header
        className="tlv-header"
        data-testid="team-list-header"
        id={`team-agent-${detail.team.leaderAgentId}`}
        tabIndex={-1}
        aria-label={`Leader · ${detail.team.state}`}
      >
        <div className="tlv-header-main">
          <button type="button" className="team-back-btn" data-testid="team-back" onClick={onBack}>
            <ArrowLeft size={14} /> Chatに戻る
          </button>
          <h2 id="team-list-title" className="team-title">
            {task.title}
          </h2>
        </div>
        <div className="tlv-header-actions">
          {/* Same wording as TeamCanvas's chip (the a11y list/canvas parity spec compares the two
              verbatim) and, like it, no denominator: the Worker count is dynamic — see the note on
              TeamCanvas's `liveText`. */}
          <span className="team-status-chip">{`${detail.team.state} · Worker ${workers.length}人`}</span>
          <button
            type="button"
            className="team-view-toggle-btn"
            data-testid="team-view-toggle"
            onClick={onSwitchToCanvasView}
            title="Team Canvasに切り替え"
          >
            <LayoutGrid size={14} /> Canvas表示
          </button>
          <TeamPolicyTrigger onOpen={() => setPolicyOpen(true)} />
          <button
            type="button"
            className="team-stop-all-btn"
            data-testid="team-stop-all"
            disabled={teamBusy || workers.length === 0 || detail.team.state === 'completed'}
            onClick={() => void stopAllTeamWorkers(task.id)}
          >
            すべて停止
          </button>
        </div>
      </header>
      <div aria-live="polite" className="visually-hidden">
        {`Team status: ${detail.team.state}, workers ${workers.length}`}
      </div>

      <div className="tlv-body">
        <ul className="tlv-workers" aria-label="Worker一覧">
          {workers.map((worker) => {
            const canStop = !teamBusy && !TERMINAL_STATES.has(worker.state);
            const model = describeWorkerModel(worker);
            // Null when the parent is the Leader (it is not in `workers`) — exactly what the
            // Canvas passes into WorkerNode, so both views name the same parent.
            const hierarchy = describeHierarchy(worker, parentAgentOf(worker, workers));
            const relevant = detail.messages
              .filter((m) => m.targetAgentId === worker.id || m.sourceAgentId === worker.id)
              .sort((a, b) => a.seq - b.seq)
              .slice(-4);
            return (
              <li
                key={worker.id}
                className="tlv-worker"
                data-testid="team-worker"
                data-depth={worker.depth}
                data-parent-agent-id={parentAgentOf(worker, workers)?.id ?? ''}
                id={`team-agent-${worker.id}`}
                tabIndex={-1}
                aria-label={`Worker ${worker.role} · ${worker.state}`}
              >
                <div className="tlv-worker-heading">
                  <div>
                    <span className="role-name">{worker.role}</span>
                    <span className={`w-status team-status ${statusDotClass(worker.state)}`}>
                      <span className="dot" aria-hidden="true" />
                      {worker.state}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="w-stop-btn"
                    disabled={!canStop}
                    onClick={() => void stopTeamWorker(task.id, worker.id)}
                  >
                    停止
                  </button>
                </div>
                {/* Same text the Canvas renders in `.role-sub`, from the same pure helper — the
                    a11y list/canvas parity spec diffs the two innerTexts verbatim, and the runtime
                    name must come from `connectionId` (the execution identity) rather than from the
                    compatibility field `engine`. A null objective renders as nothing on both sides
                    ("Claude ·"), so there is no placeholder to invent here. */}
                <p className="tlv-objective">
                  {workerRuntimeLabel(worker)} · {worker.objective}
                </p>
                <p className="tlv-activity">
                  現在: {worker.currentActivity ?? (worker.state === 'done' ? '完了' : '待機')}
                </p>
                {/* Same helper, same wording, same testids as the Canvas's Worker card — only the
                    variant class differs (see WorkerNode.tsx), so the two views never disagree
                    about which model a Worker got. */}
                <div className="team-exec team-exec-list" data-testid="team-worker-model">
                  {/* Same helper, same wording, same testid as the Canvas's Worker card — the
                      depth/parent/kind facts must read identically in both views. */}
                  <p className="team-exec-row" data-testid="team-worker-hierarchy">
                    <span className="team-exec-key">階層</span>
                    <span className="team-exec-value team-exec-instruction">{hierarchy}</span>
                  </p>
                  <p className="team-exec-row" data-testid="team-worker-model-name">
                    <span className="team-exec-key">モデル</span>
                    <span className="team-exec-value team-exec-instruction">
                      {model.modelLabel}
                    </span>
                  </p>
                  <p className="team-exec-row" data-testid="team-worker-model-connection">
                    <span className="team-exec-key">Connection</span>
                    <span className="team-exec-value team-exec-instruction">
                      {model.connectionLabel}
                    </span>
                  </p>
                </div>
                {/* Same component, same helper, same facts as the Canvas's Worker card. */}
                <TeamExecutionStatus
                  execution={latestExecutionForWorker(detail.executions, worker.id)}
                  variant="list"
                  onResume={(() => {
                    const execution = latestExecutionForWorker(detail.executions, worker.id);
                    return execution?.missionId == null
                      ? undefined
                      : () => void resumeTeamMission(task.id, execution.missionId!);
                  })()}
                />
                <dl className="tlv-usage">
                  <div>
                    <dt>Tokens</dt>
                    <dd>{worker.usage.tokens}</dd>
                  </div>
                  <div>
                    <dt>時間</dt>
                    <dd>{worker.usage.timeMs}ms</dd>
                  </div>
                  <div>
                    <dt>Tools</dt>
                    <dd>{worker.usage.toolCalls}</dd>
                  </div>
                </dl>
                {relevant.length > 0 && (
                  <ul className="tlv-recent" aria-label={`${worker.role}との最近のやり取り`}>
                    {relevant.map((m) => {
                      // Same helper, same context (`leaderAgentId` + the Team's Workers) as the
                      // Canvas card, so a Worker-to-Worker message is tagged with the sibling's own
                      // role in BOTH views instead of being attributed to the Leader in either.
                      const peer = describeMessagePeer(m, {
                        agentId: worker.id,
                        leaderAgentId: detail.team.leaderAgentId,
                        agents: workers,
                      });
                      const incoming = peer.direction === 'incoming';
                      return (
                        <li key={m.id} className={`w-line${incoming ? ' msg-in' : ''}`}>
                          <span className={`tag${incoming ? '' : ' out'}`}>{peer.tagLabel}</span>
                          {/* Same renderer/options as WorkerNode.tsx, deliberately: the parity
                              spec diffs innerText, and plain text here collapsed the block break
                              the Canvas's Markdown <p> produces ("Leaderから本文" vs
                              "Leaderから\n\n本文"). `.w-line :where(p, …)` styles both alike, and
                              raw HTML/images stay out of the DOM exactly as on the Canvas. */}
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            skipHtml
                            disallowedElements={['img']}
                            unwrapDisallowed
                          >
                            {incoming ? m.content : summarize(m.content)}
                          </ReactMarkdown>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
          {workers.length === 0 && (
            <li className="tlv-empty">Leaderに依頼すると、必要に応じてWorkerを雇用します</li>
          )}
        </ul>

        <div className="tlv-timeline">
          <h3>Message timeline</h3>
          {detail.messages.length === 0 ? (
            <p className="tlv-empty">まだ通信はありません。</p>
          ) : (
            <ol>
              {detail.messages.map((message) => (
                <li key={message.id}>
                  <button type="button" onClick={() => focusAgent(message.sourceAgentId)}>
                    {agentLabel(message.sourceAgentId, message.sourceKind, detail.team, workers)}
                  </button>
                  <span aria-hidden="true"> → </span>
                  <button type="button" onClick={() => focusAgent(message.targetAgentId)}>
                    {agentLabel(message.targetAgentId, message.targetKind, detail.team, workers)}
                  </button>
                  <p>{messageText(message)}</p>
                  <small>
                    {message.deliveryState ?? message.state} · attempt {message.attempt}
                  </small>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>

      {policyOpen && (
        <TeamPolicyDialog
          open
          taskId={task.id}
          detail={detail}
          onClose={() => setPolicyOpen(false)}
        />
      )}
    </section>
  );
}

function statusDotClass(state: WorkerSummary['state']): string {
  if (state === 'ready' || state === 'waiting') return 'ready';
  if (state === 'busy' || state === 'spawning' || state === 'invited') return 'busy';
  if (state === 'done') return 'done';
  return '';
}

function focusAgent(agentId: string): void {
  document.getElementById(`team-agent-${agentId}`)?.focus();
}

function agentLabel(
  agentId: string,
  kind: 'leader' | 'worker',
  team: { leaderAgentId: string },
  workers: readonly { id: string; role: string }[],
): string {
  if (kind === 'leader' || agentId === team.leaderAgentId) return 'Leader';
  return workers.find((w) => w.id === agentId)?.role ?? 'Worker';
}

// Worker report messages are structured envelopes; unwrap `{summary}` when present (mirrors
// WorkerNode.tsx's identical helper).
function summarize(content: string): string {
  try {
    const parsed = JSON.parse(content) as { summary?: unknown };
    return typeof parsed.summary === 'string' ? parsed.summary : content;
  } catch {
    return content;
  }
}

function messageText(message: TeamMessageSummary): string {
  if (message.sourceKind !== 'worker') return message.content;
  return summarize(message.content);
}
