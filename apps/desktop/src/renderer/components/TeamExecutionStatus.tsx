import type { TeamExecutionSummary, TeamMissionWorktreeSummary } from '../types/sprint-coder';
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
  onResume,
}: {
  execution: TeamExecutionSummary | null;
  variant: 'canvas' | 'list';
  onResume?: (() => void) | undefined;
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
      {display.attemptReasonLabel !== null && (
        <p className="team-exec-row" data-testid="team-execution-attempt-reason">
          <span className="team-exec-key">開始理由</span>
          <span className="team-exec-value">{display.attemptReasonLabel}</span>
        </p>
      )}
      {display.progressLabel !== null && (
        <p className="team-exec-row" data-testid="team-execution-progress">
          <span className="team-exec-key">最終進捗</span>
          <span className="team-exec-value">{display.progressLabel}</span>
        </p>
      )}
      {display.terminalReasonLabel !== null && (
        <p className="team-exec-row" data-testid="team-execution-terminal-reason">
          <span className="team-exec-key">終了理由</span>
          <span className="team-exec-value">{display.terminalReasonLabel}</span>
        </p>
      )}
      {execution.state === 'waiting_resume' &&
        execution.missionId !== null &&
        onResume !== undefined && (
          <button
            type="button"
            className="w-stop-btn"
            data-testid="team-mission-resume"
            onClick={onResume}
          >
            Missionを再開
          </button>
        )}
      {execution.worktree !== null && (
        <p className="team-exec-row" data-testid="team-execution-worktree">
          <span className="team-exec-key">Worktree</span>
          <span className="team-exec-value">
            {worktreeStateLabel(execution.worktree.state)}
            {execution.worktree.changedFiles.length > 0 &&
              ` · 変更${execution.worktree.changedFiles.length}件`}
            {execution.worktree.reason !== null && ` · ${execution.worktree.reason}`}
          </span>
        </p>
      )}
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

function worktreeStateLabel(state: TeamMissionWorktreeSummary['state']): string {
  switch (state) {
    case 'created':
      return '分離環境を準備済み';
    case 'active':
      return '分離環境で実行中';
    case 'ready':
      return '統合待ち';
    case 'integrated':
      return 'Workspaceへ統合済み';
    case 'cleaned':
      return '統合・片付け済み';
    case 'quarantined':
      return '変更を保持して再開待ち';
  }
}
