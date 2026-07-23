import { useState } from 'react';
import { useAppStore } from '../store/appStore';
import type { TaskSummary, TeamMessageSummary } from '../types/sprint-coder';

export function TeamListView({ task }: { task: TaskSummary }) {
  const detail = useAppStore((state) => state.teamByTask[task.id]);
  const busy = useAppStore((state) => state.teamBusy);
  const hire = useAppStore((state) => state.hireTeamWorker);
  const send = useAppStore((state) => state.sendTeamMessage);
  const stop = useAppStore((state) => state.stopTeamWorker);
  const stopAll = useAppStore((state) => state.stopAllTeamWorkers);
  const [role, setRole] = useState('');
  const [objective, setObjective] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  if (!detail)
    return (
      <section className="team-list-view" aria-labelledby="team-list-title">
        <h2 id="team-list-title">Teamを準備しています</h2>
      </section>
    );

  const workers = detail.workers.filter(({ kind }) => kind === 'worker');
  const agents = new Map(detail.workers.map((worker) => [worker.id, worker]));

  return (
    <section className="team-list-view" aria-labelledby="team-list-title" data-testid="team-list">
      <div
        className="team-list-toolbar"
        id={`team-agent-${detail.team.leaderAgentId}`}
        tabIndex={-1}
      >
        <div>
          <h2 id="team-list-title">Team List</h2>
          <p aria-live="polite">
            {detail.team.state} · Worker {workers.length}/3
          </p>
        </div>
        <button
          type="button"
          className="danger-btn"
          disabled={busy || workers.length === 0 || detail.team.state === 'completed'}
          onClick={() => void stopAll(task.id)}
          data-testid="team-stop-all"
        >
          すべて停止
        </button>
      </div>

      <form
        className="team-hire-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!role.trim() || !objective.trim()) return;
          void hire(task.id, role.trim(), objective.trim()).then(() => {
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
        <button type="submit" disabled={busy || workers.length >= 3} data-testid="team-hire">
          Workerを起動
        </button>
      </form>

      <div className="team-worker-list" aria-label="Worker一覧">
        {workers.map((worker) => {
          const canSend = worker.state === 'ready' || worker.state === 'waiting';
          return (
            <article
              className="team-worker-card"
              data-testid="team-worker"
              id={`team-agent-${worker.id}`}
              tabIndex={-1}
              key={worker.id}
            >
              <div className="team-worker-heading">
                <div>
                  <h3>{worker.role}</h3>
                  <span className={`team-status team-status--${worker.state}`}>{worker.state}</span>
                </div>
                <button
                  type="button"
                  disabled={busy || ['done', 'failed', 'stopped'].includes(worker.state)}
                  onClick={() => void stop(task.id, worker.id)}
                >
                  停止
                </button>
              </div>
              <p>{worker.objective}</p>
              <p className="team-current-task">
                現在: {worker.currentActivity ?? (worker.state === 'done' ? '完了' : '待機')}
              </p>
              <dl className="team-usage">
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
              <form
                className="team-message-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const content = drafts[worker.id]?.trim();
                  if (!content) return;
                  void send(task.id, worker.id, content).then(() =>
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
                  disabled={!canSend || busy}
                  rows={2}
                />
                <button type="submit" disabled={!canSend || busy}>
                  Leaderから送信
                </button>
              </form>
            </article>
          );
        })}
      </div>

      <div className="team-message-timeline">
        <h3>Message timeline</h3>
        {detail.messages.length === 0 ? (
          <p>まだ通信はありません。</p>
        ) : (
          <ol>
            {detail.messages.map((message) => (
              <li key={message.id}>
                <button type="button" onClick={() => focusAgent(message.sourceAgentId)}>
                  {agentLabel(message.sourceAgentId, message.sourceKind, agents)}
                </button>
                <span aria-hidden="true"> → </span>
                <button type="button" onClick={() => focusAgent(message.targetAgentId)}>
                  {agentLabel(message.targetAgentId, message.targetKind, agents)}
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
    </section>
  );
}

function focusAgent(agentId: string): void {
  document.getElementById(`team-agent-${agentId}`)?.focus();
}

function agentLabel(
  agentId: string,
  kind: 'leader' | 'worker',
  agents: Map<string, { role: string }>,
): string {
  return kind === 'leader' ? 'Leader' : (agents.get(agentId)?.role ?? 'Worker');
}

function messageText(message: TeamMessageSummary): string {
  if (message.sourceKind !== 'worker') return message.content;
  try {
    const parsed = JSON.parse(message.content) as { summary?: unknown };
    return typeof parsed.summary === 'string' ? parsed.summary : message.content;
  } catch {
    return message.content;
  }
}
