import type {
  TeamExecutionIsolation,
  TeamExecutionSummary,
  TeamMissionWorktreeSummary,
} from '../types/sprint-coder';
import { describeExecution } from '../lib/team-execution-display';

/**
 * Team Activity Card (Core C1b): the persisted execution row behind a Worker, rendered identically
 * on the Canvas (WorkerNode) and in the List (TeamListView). `variant` only picks a spacing class —
 * both surfaces show the exact same facts, from the exact same helper.
 *
 * Adds no `tabIndex` of its own to either surface's keyboard order (the Canvas's arrow-key node
 * navigation and the List's focusable `<li>`s are untouched) — its own resume `<button>` and
 * repository `<details>` follow normal tab order instead. Every state is carried by words, never
 * by colour alone, and nothing here animates, so `prefers-reduced-motion` has nothing new to
 * suppress.
 *
 * `execution == null` renders nothing at all — a Worker with no persisted execution keeps exactly
 * the display it had before this card existed.
 */
export function TeamExecutionStatus({
  execution,
  variant,
  onResume,
  onResumeIntegration,
  resumeDisabled = false,
}: {
  execution: TeamExecutionSummary | null;
  variant: 'canvas' | 'list';
  onResume?: (() => void) | undefined;
  onResumeIntegration?: (() => void) | undefined;
  resumeDisabled?: boolean;
}) {
  if (execution === null) return null;
  const display = describeExecution(execution);
  const isolation = execution.isolation ?? null;
  // Only repositories that recorded an integrated HEAD count. A failed or canceled Worker's
  // unchanged worktree is also `cleaned` (issue #529), but it integrated nothing.
  const integratedRepositories = isolation?.repositories.filter(repositoryIntegrated).length ?? 0;
  const resume = isolationResumeAction(execution, onResume, onResumeIntegration);

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
      <p className="team-exec-row" data-testid="team-execution-write-scope">
        <span className="team-exec-key">書き込み</span>
        <span className="team-exec-value">{display.writeScopeLabel}</span>
      </p>
      {execution.state === 'running' && (execution.workerQueueDepth ?? 0) > 0 ? (
        <p className="team-exec-row" data-testid="team-execution-worker-queue">
          後続{execution.workerQueueDepth}件が待機中
        </p>
      ) : null}
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
      {resume !== null && (
        <button
          type="button"
          className="w-stop-btn"
          data-testid={resume.testId}
          disabled={resumeDisabled}
          onClick={resume.onClick}
        >
          {resume.label}
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
      {isolation !== null && (
        <div className="team-exec-isolation" data-testid="team-execution-isolation">
          <p className="team-exec-row">
            <span className="team-exec-key">Repository</span>
            <span className="team-exec-value">
              {integratedRepositories}/{isolation.repositories.length} repository統合済み ·{' '}
              {isolationPhaseLabel(isolation)}
            </span>
          </p>
          <details className="team-exec-repositories">
            <summary>repository別の状態</summary>
            <div>
              {isolation.repositories.map((repository) => (
                <p className="team-exec-row" key={repository.ordinal}>
                  <span className="team-exec-key">Repo {repository.ordinal}</span>
                  <span className="team-exec-value">
                    {isolationRepositoryStateLabel(repository)} · {repository.changedFiles.length}
                    件変更
                  </span>
                </p>
              ))}
            </div>
          </details>
          {isolation.reason !== null && (
            <p className="team-exec-row team-exec-isolation-reason" role="alert">
              <span className="team-exec-key">失敗理由</span>
              <span className="team-exec-value">{isolation.reason}</span>
            </p>
          )}
        </div>
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

function isolationResumeAction(
  execution: TeamExecutionSummary,
  onResumeMission: (() => void) | undefined,
  onResumeIntegration: (() => void) | undefined,
): { label: string; testId: string; onClick: () => void } | null {
  // Only a Worker actually waiting to resume gets a manual action at all — a running execution
  // whose isolation is separately queued for integration (`phase === 'waiting_integration'`) shows
  // that fact as a state label only (issue #571), never a button.
  if (execution.state !== 'waiting_resume') return null;
  const isolation = execution.isolation;
  // `waiting_integration` covers an execution that resumed (e.g. after an app restart) while its
  // isolation was still queued for integration; the schema's own invariant only ever sets
  // `resumeKind: 'integration'` while `phase === 'waiting_resume'`, so both must be checked (see
  // team-coordinator.ts's `resumeExecutionIntegration`, which accepts either).
  const integrationResume =
    isolation?.phase === 'waiting_integration' ||
    (isolation?.phase === 'waiting_resume' && isolation.resumeKind === 'integration');
  if (integrationResume) {
    const onClick = execution.missionId === null ? onResumeIntegration : onResumeMission;
    return onClick === undefined
      ? null
      : { label: '統合を再開', testId: 'team-integration-resume', onClick };
  }
  return execution.missionId !== null && onResumeMission !== undefined
    ? { label: 'Workerを再開', testId: 'team-worker-resume', onClick: onResumeMission }
    : null;
}

function repositoryIntegrated(repository: TeamExecutionIsolation['repositories'][number]): boolean {
  // A repository whose worktree cleanup failed after it integrated keeps its integrated HEAD while
  // it is quarantined (issue #544): its change is in the Workspace, so it counts as integrated.
  return (
    (repository.state === 'integrated' ||
      repository.state === 'cleaned' ||
      repository.state === 'quarantined') &&
    repository.integratedHead !== null
  );
}

// Keyed by the canonical contracts `TeamExecutionIsolation['phase']` union (issue #571): a plain `switch` compiles
// even when it silently drops a case, but an object literal typed as `Record<phase, ...>` does not
// — omitting a key here, or forgetting one after contracts adds a new phase, is a type error rather
// than a card that renders blank at runtime.
const ISOLATION_PHASE_LABEL: Record<
  TeamExecutionIsolation['phase'],
  (isolation: TeamExecutionIsolation) => string
> = {
  preparing: () => '隔離環境を準備中',
  running: () => '隔離環境で実行中',
  finalizing: () => 'commitを確定中',
  // The execution itself may still be `running` (or have resumed and be `waiting_resume`) while its
  // isolation sits in this phase — it means the Workspace-wide integration order has not reached
  // this repository set yet, distinct from `integrating` (its turn has come).
  waiting_integration: () => '統合の順番待ち',
  integrating: () => 'repositoryを統合中',
  waiting_resume: () => '再開待ち',
  completed: () => '統合完了',
  quarantined: (isolation) => {
    const { repositories } = isolation;
    // Nothing is left to review once every worktree was removed unchanged (issue #529).
    if (
      repositories.length > 0 &&
      repositories.every(
        ({ state, integratedHead }) => state === 'cleaned' && integratedHead === null,
      )
    )
      return '片付け済み（統合なし）';
    // Every change reached the Workspace; only removing a worktree afterwards failed, or the
    // user has since discarded what was left (issue #544). Nothing unintegrated needs review.
    if (repositories.length > 0 && repositories.every(repositoryIntegrated))
      return repositories.some(({ state }) => state === 'quarantined')
        ? '統合後の片付けに失敗'
        : '統合・片付け済み';
    return '隔離して要確認';
  },
};

function isolationPhaseLabel(isolation: TeamExecutionIsolation): string {
  // Widen the lookup for a runtime value the canonical contracts union does not actually admit (e.g. an
  // unvalidated IPC payload from a mismatched build) — the object above stays fully keyed for the
  // compile-time exhaustiveness check, this cast only relaxes how it is *read*, so an unrecognized
  // phase falls back to a safe, non-committal label instead of throwing or rendering blank.
  const table = ISOLATION_PHASE_LABEL as Record<
    string,
    ((isolation: TeamExecutionIsolation) => string) | undefined
  >;
  return table[isolation.phase]?.(isolation) ?? '状態を確認してください';
}

function isolationRepositoryStateLabel(
  repository: TeamExecutionIsolation['repositories'][number],
): string {
  switch (repository.state) {
    case 'active':
      return '実行中';
    case 'ready':
      return '統合待ち';
    case 'integrated':
      return '統合済み';
    case 'cleaned':
      return repository.integratedHead === null ? '片付け済み（統合なし）' : '統合・片付け済み';
    case 'quarantined':
      // Integrated, then kept on disk only because removing its worktree failed (issue #544).
      return repository.integratedHead === null ? '隔離済み' : '統合済み（片付けに失敗）';
  }
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
