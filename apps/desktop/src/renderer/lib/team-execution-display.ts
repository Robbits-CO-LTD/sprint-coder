import type { TeamExecutionSummary } from '../types/sprint-coder';

// Display facts for the persisted Team execution row that backs a Worker card (Core C1b).
//
// Values come from durable execution fields plus Main's live Worker-admission projection
// (see types/sprint-coder.d.ts and TeamDetail.executions). Nothing is inferred from
// `WorkerSummary.state`, from the requested model name, or from the mere absence of a value: an
// unknown fact gets its own explicit wording rather than an empty string, a 0, or a `false`.

export type TeamExecutionState = TeamExecutionSummary['state'];
export type TeamQueueReason = NonNullable<TeamExecutionSummary['queueReason']>;

export const EXECUTION_STATE_LABELS: Readonly<Record<TeamExecutionState, string>> = {
  assigned: '割り当て済み',
  queued: '順番待ち',
  waiting_verification: '接続確認待ち',
  waiting_rate_limit: 'レート制限待ち',
  running: '実行中',
  waiting_resume: '再開待ち',
  completed: '完了',
  failed: '失敗',
  canceled: 'キャンセル済み',
};

export const QUEUE_REASON_LABELS: Readonly<Record<TeamQueueReason, string>> = {
  global_concurrency: 'Team全体の同時実行上限',
  connection_concurrency: 'Connectionの同時実行上限',
  verification: '接続の再確認',
  rate_limit: 'Provider rate limit',
  budget: '予算上限',
  recovery: '再起動から復元',
  automatic_retry: '安全な自動再試行',
};

/** `queueReason: null` is a real backend state (waiting without a recorded cause), not missing
 * data — it gets its own wording instead of a blank. */
export const UNKNOWN_QUEUE_REASON_LABEL = '実行枠を待っています';

export const BUILTIN_CONNECTION_LABELS: Readonly<Record<string, string>> = {
  'builtin:claude-cli': 'Claude CLI',
  'builtin:codex-cli': 'Codex CLI',
  'builtin:grok-cli': 'Grok CLI',
};

export const UNKNOWN_CONNECTION_LABEL = 'Connection不明';
export const EMPTY_INSTRUCTION_LABEL = '指示プレビューなし';
export const UNKNOWN_STATE_LABEL = '状態不明';

/** `TeamExecutionSummary.accessMode` のTeam画面向け日本語表示（issue #551）。安全設定（Taskの
 * Access preset）は画面が知らない情報なので、確認のされ方（ask/auto/full）はここでは出さない —
 * それは割り当て結果（team_assign_task/team_assign_mission）の writeScopeNote の役目。 */
export const WRITE_SCOPE_LABELS: Readonly<Record<TeamExecutionSummary['accessMode'], string>> = {
  'read-only': '読み取り専用（Leaderの依頼）',
  'workspace-write': 'Workspaceへ書き込み（隔離worktreeで変更し、完了後に統合）',
};

export function writeScopeLabel(accessMode: TeamExecutionSummary['accessMode']): string {
  return WRITE_SCOPE_LABELS[accessMode];
}

/**
 * Main が team_executions/team_attempts の terminal_reason に書く値の日本語ラベル（issue #551）。
 * 出どころ（file:line、apps/desktop/src/main 配下）:
 *  - 'heartbeat_timeout' / 'idle_timeout' / 'hard_timeout': team-coordinator.ts の
 *    WorkerRuntimeControlErrorCode（163-168行）。runScheduledExecution の監視タイマーが
 *    expire(code, message) で送出し（5690, 5698, 5704行）、失敗経路で error.code がそのまま
 *    terminalReason になる（3337-3341行）。
 *  - 'runtime_failure': 上と同じ失敗経路のデフォルト（3341, 3587行）で、WorkerRuntimeControlError
 *    でも ProviderRateLimitedError でもない実行時エラー全般。
 *  - 'user_canceled': ユーザーからの通常キャンセル（handleRequestedInterruption、3650行、
 *    control.kind !== 'steer' のとき）。
 *  - 'stop_unconfirmed': WorkerRuntimeControlErrorCode の1値（168行）。プロセス終了を確認できずに
 *    強制停止したとき。既存の訳（強制停止）をそのまま維持する。
 *  - 'worker_reported_failure': team-coordinator.ts 3148行。Worker自身が失敗を報告した通常完了経路。
 *  - 'rate_limited': team-coordinator.ts 3340行。ProviderRateLimitedError による失敗。
 *  - 'steered': team-coordinator.ts 3650行。修正指示（team_steer_execution）による中断。
 *  - 'app_restart': persistence.ts 12377/12459行。アプリ再起動からの復元時に未確定のまま終了扱いに
 *    した実行の起点。
 * Graph Mission の中断（persistence.ts の interruptGraphStep、team-coordinator.ts 1551/1593/1616行）
 * は呼び出し元のエラーメッセージをそのまま terminalReason にするため固定値ではなく、辞書に無い値
 * として下のフォールバック（コードのまま表示）に落ちる — 挙動は変えていない。
 */
export const TERMINAL_REASON_LABELS: Readonly<Record<string, string>> = {
  heartbeat_timeout: 'ハートビート応答なしで停止',
  idle_timeout: '進捗が止まったため停止',
  hard_timeout: '実行時間の上限に到達',
  runtime_failure: '実行時エラー',
  user_canceled: '利用者がキャンセル',
  stop_unconfirmed: '強制停止',
  worker_reported_failure: 'Workerが失敗を報告',
  rate_limited: 'レート制限で停止',
  steered: '修正指示により中断',
  app_restart: 'アプリ再起動で中断',
};

/** 辞書に無い値（未知のコードや Graph Mission の自由記述の理由）はコードのまま表示する。 */
export function terminalReasonLabel(reason: string): string {
  return TERMINAL_REASON_LABELS[reason] ?? reason;
}
export const ATTEMPT_START_REASON_LABELS = {
  initial: '通常開始',
  automatic_retry: '自動再試行',
  manual_resume: '手動再開',
  steer: '修正指示から再開',
  app_restart: 'アプリ再起動から復元',
} as const;

/** States in which the execution is holding a queue slot rather than running. Waiting-specific
 * facts (reason / waiting-since / queue position) are only meaningful for these. */
const WAITING_STATES: ReadonlySet<string> = new Set<TeamExecutionState>([
  'queued',
  'waiting_verification',
  'waiting_rate_limit',
  'waiting_resume',
]);

const TERMINAL_STATES: ReadonlySet<string> = new Set<TeamExecutionState>([
  'completed',
  'failed',
  'canceled',
]);

export function isWaitingExecutionState(state: string): boolean {
  return WAITING_STATES.has(state);
}

export function isTerminalExecutionState(state: string): boolean {
  return TERMINAL_STATES.has(state);
}

export function executionStateLabel(state: string): string {
  return EXECUTION_STATE_LABELS[state as TeamExecutionState] ?? UNKNOWN_STATE_LABEL;
}

export function queueReasonLabel(reason: string | null | undefined): string {
  if (reason == null) return UNKNOWN_QUEUE_REASON_LABEL;
  return QUEUE_REASON_LABELS[reason as TeamQueueReason] ?? reason;
}

/** Built-in runtimes get their product name; anything else is a user-created Connection whose
 * display name this contract does not carry, so the id itself is shown verbatim. */
export function connectionLabel(connectionId: string | null | undefined): string {
  if (connectionId == null || connectionId === '') return UNKNOWN_CONNECTION_LABEL;
  return BUILTIN_CONNECTION_LABELS[connectionId] ?? connectionId;
}

export function instructionLabel(preview: string | null | undefined): string {
  if (preview == null || preview.trim() === '') return EMPTY_INSTRUCTION_LABEL;
  return preview;
}

/** ISO timestamps sort correctly as strings, but only when both parse; fall back to lexicographic
 * order so a malformed value can never make the comparison non-deterministic. */
function compareTimestamps(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Prefer the running execution, then unfinished work, then completed history. Within a tier,
 * the newest updatedAt wins; ties resolve to the later array position. Returns null when
 * the Worker has no persisted execution at all — callers keep their existing display in that case
 * rather than inventing one.
 */
export function latestExecutionForWorker(
  executions: readonly TeamExecutionSummary[] | null | undefined,
  workerId: string,
): TeamExecutionSummary | null {
  if (executions == null) return null;
  let latest: TeamExecutionSummary | null = null;
  const priority = (execution: TeamExecutionSummary) =>
    execution.state === 'running' ? 2 : isTerminalExecutionState(execution.state) ? 0 : 1;
  for (const execution of executions) {
    if (execution.assigneeAgentId !== workerId) continue;
    if (
      latest === null ||
      priority(execution) > priority(latest) ||
      (priority(execution) === priority(latest) &&
        compareTimestamps(execution.updatedAt, latest.updatedAt) >= 0)
    ) {
      latest = execution;
    }
  }
  return latest;
}

/** Local wall-clock `HH:MM`, matching the Worker card footer's existing `更新 HH:MM`. An
 * unparseable timestamp is echoed back rather than rendered blank. */
export function formatClockTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export type TeamExecutionDisplay = {
  state: string;
  stateLabel: string;
  isWaiting: boolean;
  isTerminal: boolean;
  /** Queue cause wording — present only while waiting. */
  waitReasonLabel: string | null;
  /** When the wait started: `queuedAt` when recorded, otherwise the assignment time. */
  waitingSinceIso: string | null;
  waitingSinceLabel: string | null;
  /** `queueOrdinal` is rendered whenever it is a number — 0 is a position, not "unknown". */
  queueOrdinalLabel: string | null;
  connectionLabel: string;
  instructionLabel: string;
  progressLabel: string | null;
  attemptReasonLabel: string | null;
  terminalReasonLabel: string | null;
  /** `execution.accessMode` の日本語表示（issue #551）。安全設定は画面が知らないので、確認の
   * され方はここに出ない。 */
  writeScopeLabel: string;
  /** Single-sentence announcement for the polite live region. */
  ariaSummary: string;
};

export function describeExecution(execution: TeamExecutionSummary): TeamExecutionDisplay {
  const isWaiting = isWaitingExecutionState(execution.state);
  const workerWaiting =
    isWaiting && execution.state !== 'waiting_resume' && execution.waitingForWorker === true;
  const stateLabel = workerWaiting ? '担当Workerの終了待ち' : executionStateLabel(execution.state);
  const connection = connectionLabel(execution.connectionId);
  const instruction = instructionLabel(execution.instructionPreview);

  const waitingSinceIso = isWaiting ? (execution.queuedAt ?? execution.assignedAt) : null;
  const waitingSinceLabel = waitingSinceIso === null ? null : formatClockTime(waitingSinceIso);
  const waitReasonLabel = isWaiting
    ? execution.state === 'waiting_resume'
      ? '既存変更を確認してから再開'
      : workerWaiting
        ? '同じWorkerの先行実行が終了するまで待機'
        : queueReasonLabel(execution.queueReason)
    : null;
  const queueOrdinalLabel =
    isWaiting && typeof execution.queueOrdinal === 'number'
      ? `待機順 ${execution.queueOrdinal}`
      : null;

  const parts = [`実行状態 ${stateLabel}`];
  if (waitReasonLabel !== null) parts.push(`理由 ${waitReasonLabel}`);
  if (waitingSinceLabel !== null) parts.push(`待機開始 ${waitingSinceLabel}`);
  if (queueOrdinalLabel !== null) parts.push(queueOrdinalLabel);
  parts.push(`Connection ${connection}`);
  const progressLabel =
    execution.lastProgressAt === null ? null : formatClockTime(execution.lastProgressAt);
  const attemptReasonLabel =
    execution.attemptStartReason === null
      ? null
      : (ATTEMPT_START_REASON_LABELS[execution.attemptStartReason] ?? execution.attemptStartReason);
  const terminalReasonText =
    execution.terminalReason === null ? null : terminalReasonLabel(execution.terminalReason);

  return {
    state: execution.state,
    stateLabel,
    isWaiting,
    isTerminal: isTerminalExecutionState(execution.state),
    waitReasonLabel,
    waitingSinceIso,
    waitingSinceLabel,
    queueOrdinalLabel,
    connectionLabel: connection,
    instructionLabel: instruction,
    progressLabel,
    attemptReasonLabel,
    terminalReasonLabel: terminalReasonText,
    writeScopeLabel: writeScopeLabel(execution.accessMode),
    ariaSummary: parts.join('、'),
  };
}
