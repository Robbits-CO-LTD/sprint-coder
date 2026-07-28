import type { TeamExecutionSummary } from '../types/sprint-coder';
import { describeExecution } from '../lib/team-execution-display';

/**
 * Team Activity Card (Core C1b): the persisted execution row behind a Worker, rendered identically
 * on the Canvas (WorkerNode) and in the List (TeamListView). `variant` only picks a spacing class —
 * both surfaces show the exact same facts, from the exact same helper.
 *
 * Deliberately inert: no buttons, no `tabIndex`, no `<details>`, so it adds nothing to either
 * surface's keyboard order (the Canvas's arrow-key node navigation and the List's focusable
 * `<li>`s are untouched). Every state is carried by words, never by colour alone, and nothing here
 * animates, so `prefers-reduced-motion` has nothing new to suppress.
 *
 * `execution == null` renders nothing at all — a Worker with no persisted execution keeps exactly
 * the display it had before this card existed.
 */
export function TeamExecutionStatus({
  execution,
  variant,
}: {
  execution: TeamExecutionSummary | null;
  variant: 'canvas' | 'list';
}) {
  if (execution === null) return null;
  const display = describeExecution(execution);

  return (
    <div
      className={`team-exec team-exec-${variant}`}
      data-testid="team-execution-status"
      data-execution-state={display.state}
    >
      {/* Concise polite announcement of the same facts shown below — mirrors the Team status live
          region already used by TeamListView. Never assertive: an execution moving through the
          queue must not interrupt whatever the user is reading. */}
      <p className="visually-hidden" aria-live="polite" data-testid="team-execution-live">
        {display.ariaSummary}
      </p>
      <p className="team-exec-row" data-testid="team-execution-state">
        <span className="team-exec-key">実行状態</span>
        <span className="team-exec-value">{display.stateLabel}</span>
      </p>
      {display.isWaiting && (
        <p className="team-exec-row team-exec-wait" data-testid="team-execution-wait">
          <span className="team-exec-key">待機理由</span>
          <span className="team-exec-value">
            {display.waitReasonLabel}
            {display.waitingSinceLabel !== null && (
              <>
                {' · 待機開始 '}
                <time dateTime={display.waitingSinceIso ?? undefined}>
                  {display.waitingSinceLabel}
                </time>
              </>
            )}
            {display.queueOrdinalLabel !== null && ` · ${display.queueOrdinalLabel}`}
          </span>
        </p>
      )}
      <p className="team-exec-row" data-testid="team-execution-connection">
        <span className="team-exec-key">Connection</span>
        <span className="team-exec-value">{display.connectionLabel}</span>
      </p>
      <p className="team-exec-row" data-testid="team-execution-instruction">
        <span className="team-exec-key">指示</span>
        <span className="team-exec-value team-exec-instruction">{display.instructionLabel}</span>
      </p>
    </div>
  );
}
