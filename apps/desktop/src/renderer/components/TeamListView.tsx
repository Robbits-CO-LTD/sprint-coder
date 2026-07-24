import { useState } from 'react';
import { useAppStore } from '../store/appStore';
import { ArrowLeft, LayoutGrid } from './icons';
import type { TaskSummary, TeamMessageSummary, WorkerSummary } from '../types/sprint-coder';

const MAX_WORKERS = 3;
const TERMINAL_STATES = new Set<WorkerSummary['state']>(['done', 'failed', 'stopped']);

// Team List View (Slice 6.1 item 4): an accessible ALTERNATE projection of the exact same store
// selectors/actions the Canvas uses (see TeamCanvas.tsx) — not a simplified or read-only variant.
// Reintroduces the pre-Canvas list (see `git show 5d6238d -- .../TeamListView.tsx` for the deleted
// original) as a cleaner, presentational rewrite. Canvas and List are mutually exclusive (App only
// ever mounts one at a time per the renderer-only view preference), so this intentionally reuses
// the Canvas's testids/labels (`team-worker`, `team-hire`, `team-stop-all`, 依頼/役割/目的, …) —
// there is never a collision, and e2e specs can keep one selector for either mode.
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
  const hireTeamWorker = useAppStore((state) => state.hireTeamWorker);
  const sendTeamMessage = useAppStore((state) => state.sendTeamMessage);
  const stopTeamWorker = useAppStore((state) => state.stopTeamWorker);
  const stopAllTeamWorkers = useAppStore((state) => state.stopAllTeamWorkers);

  const [role, setRole] = useState('');
  const [objective, setObjective] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  if (!detail) {
    return (
      <section
        className="team-list-view"
        data-testid="team-list"
        aria-label="Team list"
        aria-labelledby="team-list-title"
      >
        <h2 id="team-list-title">Teamを準備しています</h2>
      </section>
    );
  }

  const workers = detail.workers.filter((w) => w.kind === 'worker');
  const hireVisible =
    workers.length < MAX_WORKERS &&
    detail.team.state !== 'completed' &&
    detail.team.state !== 'failed';
  const canSubmitHire = !teamBusy && role.trim() !== '' && objective.trim() !== '';

  return (
    <section
      className="team-list-view"
      data-testid="team-list"
      aria-label="Team list"
      aria-labelledby="team-list-title"
    >
      <header
        className="tlv-header"
        id={`team-agent-${detail.team.leaderAgentId}`}
        tabIndex={-1}
        aria-label={`Leader · ${detail.team.state}`}
      >
        <button type="button" className="team-back-btn" data-testid="team-back" onClick={onBack}>
          <ArrowLeft size={14} /> Chatに戻る
        </button>
        <h2 id="team-list-title" className="team-title">
          {task.title}
        </h2>
        <span className="team-status-chip">{`${detail.team.state} · Worker ${workers.length}/${MAX_WORKERS}`}</span>
        <button
          type="button"
          className="team-view-toggle-btn"
          data-testid="team-view-toggle"
          onClick={onSwitchToCanvasView}
          title="Team Canvasに切り替え"
        >
          <LayoutGrid size={14} /> Canvas表示
        </button>
        <button
          type="button"
          className="team-stop-all-btn"
          data-testid="team-stop-all"
          disabled={teamBusy || workers.length === 0 || detail.team.state === 'completed'}
          onClick={() => void stopAllTeamWorkers(task.id)}
        >
          すべて停止
        </button>
      </header>
      <div aria-live="polite" className="visually-hidden">
        {`Team status: ${detail.team.state}, workers ${workers.length} of ${MAX_WORKERS}`}
      </div>

      <div className="tlv-body">
        <ul className="tlv-workers" aria-label="Worker一覧">
          {workers.map((worker) => {
            const canSend = (worker.state === 'ready' || worker.state === 'waiting') && !teamBusy;
            const canStop = !teamBusy && !TERMINAL_STATES.has(worker.state);
            const relevant = detail.messages
              .filter((m) => m.targetAgentId === worker.id || m.sourceAgentId === worker.id)
              .sort((a, b) => a.seq - b.seq)
              .slice(-4);
            return (
              <li
                key={worker.id}
                className="tlv-worker"
                data-testid="team-worker"
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
                <p className="tlv-objective">{worker.objective}</p>
                <p className="tlv-activity">
                  現在: {worker.currentActivity ?? (worker.state === 'done' ? '完了' : '待機')}
                </p>
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
                      const incoming = m.targetAgentId === worker.id;
                      return (
                        <li key={m.id} className={`w-line${incoming ? ' msg-in' : ''}`}>
                          <span className={`tag${incoming ? '' : ' out'}`}>
                            {incoming ? 'Leaderから' : '報告'}
                          </span>
                          {incoming ? m.content : summarize(m.content)}
                        </li>
                      );
                    })}
                  </ul>
                )}
                <form
                  className="w-compose"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const content = drafts[worker.id]?.trim();
                    if (!content) return;
                    void sendTeamMessage(task.id, worker.id, content).then(() =>
                      setDrafts((current) => ({ ...current, [worker.id]: '' })),
                    );
                  }}
                >
                  <label htmlFor={`team-message-${worker.id}`}>依頼</label>
                  <textarea
                    id={`team-message-${worker.id}`}
                    value={drafts[worker.id] ?? ''}
                    onChange={(event) =>
                      setDrafts((current) => ({ ...current, [worker.id]: event.target.value }))
                    }
                    disabled={!canSend}
                    rows={2}
                  />
                  <button
                    type="submit"
                    className="cc-btn"
                    disabled={!canSend || !(drafts[worker.id]?.trim())}
                  >
                    Leaderから送信
                  </button>
                </form>
              </li>
            );
          })}
          {workers.length === 0 && <li className="tlv-empty">まだWorkerがいません。</li>}
        </ul>

        {hireVisible && (
          <form
            className="hire-form tlv-hire-form"
            aria-label="Workerを追加"
            onSubmit={(event) => {
              event.preventDefault();
              if (!canSubmitHire) return;
              void hireTeamWorker(task.id, role.trim(), objective.trim()).then(() => {
                setRole('');
                setObjective('');
              });
            }}
          >
            <h3>Workerを追加</h3>
            <label>
              役割
              <input value={role} onChange={(event) => setRole(event.target.value)} maxLength={100} />
            </label>
            <label>
              目的
              <textarea
                value={objective}
                onChange={(event) => setObjective(event.target.value)}
                maxLength={10_000}
                rows={2}
              />
            </label>
            <button type="submit" data-testid="team-hire" className="cc-btn" disabled={!canSubmitHire}>
              Workerを起動
            </button>
          </form>
        )}

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
