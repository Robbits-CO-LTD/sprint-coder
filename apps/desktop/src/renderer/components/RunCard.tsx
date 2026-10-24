import { useEffect, useId, useState } from 'react';
import { STAGE_LABEL, useAppStore, type TurnRuntimeState } from '../store/appStore';
import { formatWorkElapsed } from '../lib/format';
import { teamRunProgress } from '../lib/team-progress';
import { ChevronDown } from './icons';
import { ReasoningPanel } from './ReasoningPanel';

// A single quiet status line above the answer, read left to right the way Codex prints it:
// `思考中  方針を組み立て中 · 12s · 停止`. The status word carries the motion (a light band sweeping
// through grey while the model works); everything after it is muted. Once the Turn settles the line
// becomes a fold — `完了 · 12s ›` followed by a hairline that runs to the edge of the column — so a
// finished Turn reads as a closed section rather than as a header. No icon or progress rail — the
// words already say what is happening. Terminal turns keep the same DOM, so streaming content can
// begin below without replacing the status line.
//
// `data-testid="run-card"`, `data-run-status` (same six values) and
// `data-testid="run-card-stop-button"` are preserved exactly: eight existing E2E specs key off them,
// and this remains a presentation change rather than a Runtime contract change.

const TITLE_BY_STATUS: Record<TurnRuntimeState['status'], string> = {
  running: '思考中',
  canceling: '停止しています…',
  completed: '完了',
  canceled: '中止',
  failed: '失敗',
  interrupted: '中断',
};

export function RunCard({
  turn,
  taskId,
  onStop,
  variant = 'main',
}: {
  turn: TurnRuntimeState;
  taskId: string;
  onStop: () => void;
  variant?: 'main' | 'node';
}) {
  const isActive = turn.status === 'running' || turn.status === 'canceling';
  const runtimeStarting = turn.status === 'running' && turn.runtimeStarting;
  const isWorking =
    turn.status === 'running' && !runtimeStarting && turn.stage !== 'waiting_approval';
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const reasoning = useAppStore((s) => s.reasoningSeenByTurn[turn.turnId]);
  const team = useAppStore((s) => s.teamByTask[taskId]);

  useEffect(() => {
    if (!isActive) return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [isActive]);

  const cardStateClass = isActive
    ? 'running'
    : turn.status === 'completed'
      ? 'done'
      : turn.status === 'failed'
        ? 'blocked'
        : 'done';
  // Degraded path as a first-class case: plenty of turns produce no reasoning at all (verified —
  // Claude emits thinking blocks at `--effort max` on a demanding prompt, and not at `--effort high`
  // on a trivial one). With nothing to show, the pill becomes a plain label rather than a disclosure
  // that opens onto emptiness.
  const hasReasoning = reasoning?.seen === true;
  // `waiting_approval` replaces the label outright: the turn is stopped waiting for the user, and
  // calling that "思考中" would blame the model for the user's turn.
  const teamProgress = isActive ? teamRunProgress(team) : null;
  const label = runtimeStarting
    ? '起動中'
    : (teamProgress?.label ??
      (isActive && turn.stage === 'waiting_approval' ? '承認待ち' : TITLE_BY_STATUS[turn.status]));
  const stageLabel = runtimeStarting
    ? 'Runtime起動待ち'
    : (teamProgress?.detail ??
      (isActive
        ? STAGE_LABEL[turn.stage]
        : turn.status === 'completed'
          ? null
          : turn.streamingContent.trim() === ''
            ? '未完了'
            : '部分回答'));

  return (
    <div
      className={`run-card ${cardStateClass}${isActive ? '' : ' compact'}${
        variant === 'node' ? ' run-card--node' : ''
      }`}
      data-testid="run-card"
      data-run-status={turn.status}
      data-has-reasoning={hasReasoning ? 'true' : 'false'}
      data-expanded={expanded ? 'true' : 'false'}
    >
      <div className="run-head">
        <div className="run-copy">
          {hasReasoning ? (
            <button
              type="button"
              className="think-toggle"
              data-testid="run-card-reasoning-toggle"
              aria-expanded={expanded}
              aria-controls={panelId}
              onClick={() => setExpanded((value) => !value)}
            >
              <span className={`run-title${isWorking ? ' sheen' : ''}`}>{label}</span>
              <ChevronDown className="think-chevron" size={13} aria-hidden="true" />
            </button>
          ) : (
            // Non-interactive span, not a disabled button: there is nothing to disclose, and a
            // disabled control invites the user to wonder what they did wrong.
            <span className="think-toggle think-toggle--static">
              <span className={`run-title${isWorking ? ' sheen' : ''}`}>{label}</span>
            </span>
          )}
          {stageLabel !== null && <span className="run-stage-inline">{stageLabel}</span>}
          {/* aria-hidden: this ticks every 500ms and would otherwise be announced each time
              (NFR-A11Y-03). Stage changes are announced by ChatSurface's own live region. */}
          <span className="run-elapsed" aria-hidden="true">
            {formatWorkElapsed((turn.finishedAt ?? now) - turn.startedAt)}
          </span>
          {isActive && (
            // Sibling of the disclosure, never nested inside it: a button inside a button is invalid
            // and would make every stop click ambiguous.
            <button
              type="button"
              className="run-stop"
              data-testid="run-card-stop-button"
              onClick={onStop}
              disabled={turn.status === 'canceling'}
            >
              停止
            </button>
          )}
        </div>
        {!isActive && <span className="run-rule" aria-hidden="true" />}
      </div>
      {expanded && hasReasoning && (
        <div className="run-reasoning">
          <ReasoningPanel
            turnId={turn.turnId}
            truncated={reasoning?.truncated === true}
            panelId={panelId}
            variant={variant}
          />
        </div>
      )}
    </div>
  );
}
