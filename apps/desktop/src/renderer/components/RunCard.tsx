import { useEffect, useId, useState } from 'react';
import { STAGE_LABEL, STAGE_ORDER, useAppStore, type TurnRuntimeState } from '../store/appStore';
import { formatElapsed } from '../lib/format';
import { ReasoningPanel } from './ReasoningPanel';

// Run Card, collapsed to a single "思考中" pill with the reasoning behind a disclosure (issue #17).
//
// The five stages used to be listed permanently, ~140px per turn, of which only the current row said
// anything the user did not already know. FR-RUN-04 requires elapsed time, current stage, and stop to
// stay visible at all times — all three are on the pill, so the requirement is met at a fraction of
// the height, and §4.3's stage visibility survives as the five-segment bar inside the panel.
//
// `data-testid="run-card"`, `data-run-status` (same six values) and
// `data-testid="run-card-stop-button"` are preserved exactly: eight existing E2E specs key off them,
// and this is a density change, not a contract change.

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
  onStop,
  variant = 'main',
}: {
  turn: TurnRuntimeState;
  onStop: () => void;
  variant?: 'main' | 'node';
}) {
  const isActive = turn.status === 'running' || turn.status === 'canceling';
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const reasoning = useAppStore((s) => s.reasoningSeenByTurn[turn.turnId]);

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
  const currentIndex = STAGE_ORDER.indexOf(turn.stage);

  // Degraded path as a first-class case: plenty of turns produce no reasoning at all (verified —
  // Claude emits thinking blocks at `--effort max` on a demanding prompt, and not at `--effort high`
  // on a trivial one). With nothing to show, the pill becomes a plain label rather than a disclosure
  // that opens onto emptiness.
  const hasReasoning = reasoning?.seen === true;
  // `waiting_approval` replaces the label outright: the turn is stopped waiting for the user, and
  // calling that "思考中" would blame the model for the user's turn.
  const label =
    isActive && turn.stage === 'waiting_approval' ? '承認待ち' : TITLE_BY_STATUS[turn.status];

  return (
    <div
      className={`run-card ${cardStateClass}${isActive ? '' : ' compact'}`}
      data-testid="run-card"
      data-run-status={turn.status}
      data-has-reasoning={hasReasoning ? 'true' : 'false'}
    >
      <div className="run-head">
        {hasReasoning ? (
          <button
            type="button"
            className="think-toggle"
            data-testid="run-card-reasoning-toggle"
            aria-expanded={expanded}
            aria-controls={panelId}
            onClick={() => setExpanded((value) => !value)}
          >
            <span className="run-dot" aria-hidden="true" />
            <span className={`run-title${isActive ? ' sheen' : ''}`}>{label}</span>
            <span className="run-stage-inline">· {STAGE_LABEL[turn.stage]}</span>
            <span className="think-chevron" aria-hidden="true">
              {expanded ? '⌃' : '⌄'}
            </span>
          </button>
        ) : (
          // Non-interactive span, not a disabled button: there is nothing to disclose, and a disabled
          // control invites the user to wonder what they did wrong.
          <span className="think-toggle think-toggle--static">
            <span className="run-dot" aria-hidden="true" />
            <span className={`run-title${isActive ? ' sheen' : ''}`}>{label}</span>
            <span className="run-stage-inline">· {STAGE_LABEL[turn.stage]}</span>
          </span>
        )}
        {/* aria-hidden: this ticks every 500ms and would otherwise be announced each time
            (NFR-A11Y-03). Stage changes are announced by ChatSurface's own live region. */}
        <span className="run-elapsed" aria-hidden="true">
          {formatElapsed(now - turn.startedAt)}
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
      {expanded && hasReasoning && (
        <>
          {/* §4.3's five stages, preserved as a 3px bar rather than five text rows. */}
          <div className="think-progress" role="presentation" data-testid="reasoning-progress">
            {STAGE_ORDER.map((stage, i) => (
              <span
                key={stage}
                className={`think-seg${i < currentIndex ? ' done' : i === currentIndex ? ' current' : ''}`}
              />
            ))}
          </div>
          <ReasoningPanel
            turnId={turn.turnId}
            truncated={reasoning?.truncated === true}
            panelId={panelId}
            variant={variant}
          />
        </>
      )}
    </div>
  );
}
