import type { TeamExecutionIsolation, TeamMissionState } from '@sprint-coder/contracts';
import type { TeamExecutionState } from '@sprint-coder/domain';

/**
 * Whether a worktree a Team Worker left on disk may be discarded now (issue #544). The coordinator
 * reads these facts when it lists the worktree and again right before it discards one, so the two
 * never disagree about the rule.
 */
export type RetainedWorktreeFacts = Readonly<{
  /** False when the app runs without a worktree manager. */
  managerAvailable: boolean;
  /** The recorded path is exactly the directory Sprint Coder created for this repository. */
  owned: boolean;
  executionState: TeamExecutionState;
  isolationPhase: TeamExecutionIsolation['phase'];
  resumeKind: TeamExecutionIsolation['resumeKind'];
  /** The owning Graph Mission's state, or null when the execution is not a Graph Mission step. */
  graphMissionState: TeamMissionState | null;
  /**
   * The Worker runtime still has a Turn of this execution whose exit it has not confirmed, so the
   * CLI may still be writing into the worktree.
   */
  runtimeUnsettled: boolean;
}>;

const TERMINAL_EXECUTION_STATES: ReadonlySet<TeamExecutionState> = new Set([
  'completed',
  'failed',
  'canceled',
]);
/** Phases in which Main may still be using the worktree: running, sealing, integrating, resuming. */
const ACTIVE_ISOLATION_PHASES: ReadonlySet<TeamExecutionIsolation['phase']> = new Set([
  'preparing',
  'running',
  'finalizing',
  'waiting_integration',
  'integrating',
  'waiting_resume',
]);
const TERMINAL_MISSION_STATES: ReadonlySet<TeamMissionState> = new Set([
  'completed',
  'failed',
  'canceled',
]);

/**
 * A refusal or failure the user can act on, written in Japanese for the Team screen (issue #544).
 * The IPC layer shows its message as is, where any other error becomes a generic one.
 */
export class RetainedWorktreeError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
    options?: Readonly<{ cause?: unknown }>,
  ) {
    super(message, options);
    this.name = 'RetainedWorktreeError';
  }
}

/** Why the worktree cannot be discarded now, in Japanese, or null when it can. */
export function retainedWorktreeBlockedReason(facts: RetainedWorktreeFacts): string | null {
  if (!facts.managerAvailable)
    return 'この環境ではWorkerのworktreeを管理できないため、ここからは破棄できません。';
  if (!facts.owned)
    return '記録されたパスがSprint Coderの作ったworktreeの場所と一致しないため、破棄できません。';
  if (!TERMINAL_EXECUTION_STATES.has(facts.executionState))
    return 'この実行はまだ終わっていないため破棄できません。再開や統合で使われます。';
  if (facts.resumeKind !== null || ACTIVE_ISOLATION_PHASES.has(facts.isolationPhase))
    return 'この実行は統合や再開の途中にあるため破棄できません。';
  if (facts.graphMissionState !== null && !TERMINAL_MISSION_STATES.has(facts.graphMissionState))
    return 'この実行が属するGraph Missionがまだ終わっていないため破棄できません。';
  if (facts.runtimeUnsettled)
    return 'Workerの処理（CLI）が終了したことをまだ確認できていないため破棄できません。終了を確認できると破棄できるようになります。';
  return null;
}

