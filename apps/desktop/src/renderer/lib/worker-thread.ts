import type {
  TeamExecutionSummary,
  TeamMessageSummary,
  WorkerActivityEntry,
  WorkerSummary,
} from '../types/sprint-coder';

// A Worker card reads as a read-only conversation, in the manner of a T3 Code / Codex thread: the
// Leader's request, then the Worker's steps (tool calls, file edits), then its report back. These
// helpers turn the Worker's messages and work log into that one ordered thread.

export type WorkerThreadItem =
  | { kind: 'message'; message: TeamMessageSummary }
  | { kind: 'step'; step: WorkerActivityEntry; index: number };

/**
 * Messages and work-log steps merged by time, oldest first. On a tie the message goes first: the
 * request that started the work is recorded in the same instant as its first step.
 */
export function workerThread(
  messages: readonly TeamMessageSummary[],
  steps: readonly WorkerActivityEntry[],
): WorkerThreadItem[] {
  const items: { item: WorkerThreadItem; at: number; order: number }[] = [];
  messages.forEach((message, order) =>
    items.push({ item: { kind: 'message', message }, at: Date.parse(message.createdAt), order }),
  );
  steps.forEach((step, index) =>
    items.push({
      item: { kind: 'step', step, index },
      at: Date.parse(step.at),
      order: messages.length + index,
    }),
  );
  return items
    .sort((a, b) => {
      const at = (Number.isNaN(a.at) ? 0 : a.at) - (Number.isNaN(b.at) ? 0 : b.at);
      if (at !== 0) return at;
      if (a.item.kind !== b.item.kind) return a.item.kind === 'message' ? -1 : 1;
      return a.order - b.order;
    })
    .map(({ item }) => item);
}

/**
 * A work-log label as a step name. Runtime labels are phrased as live status (`Workerが
 * read_fileを実行中`); in a log of finished steps the tool name alone says it.
 */
const TOOL_CALL_LABEL = /^(?:Worker|Manager)が(.+)を実行中$/;

export function workStepLabel(label: string): string {
  return TOOL_CALL_LABEL.exec(label)?.[1] ?? label;
}

export type WorkStepIcon = 'edit' | 'read' | 'search' | 'tool' | 'status';

export function workStepIcon(step: WorkerActivityEntry): WorkStepIcon {
  if (step.kind === 'fileChange') return 'edit';
  // A runtime stage (依頼を処理中, 方針を組み立て中…) is a status, not a tool the Worker ran.
  if (!TOOL_CALL_LABEL.test(step.label) && step.label.endsWith('中')) return 'status';
  const label = step.label.toLowerCase();
  if (/(search|grep|glob|find|検索)/.test(label)) return 'search';
  if (/(read|list|view|cat|読)/.test(label)) return 'read';
  return 'tool';
}

/**
 * Whether the execution has something the user must see without opening the details: a resume it
 * is waiting for, a wait that explains why the Worker is idle, a failure, or an isolation alert.
 */
export function executionNeedsAttention(execution: TeamExecutionSummary | null): boolean {
  if (execution === null) return false;
  const isolation = execution.isolation ?? null;
  if (isolation !== null) {
    if (isolation.reason !== null) return true;
    if (isolation.phase === 'waiting_integration' || isolation.phase === 'quarantined') return true;
  }
  return (
    execution.state === 'waiting_resume' ||
    execution.state === 'waiting_rate_limit' ||
    execution.state === 'waiting_verification' ||
    execution.state === 'queued' ||
    execution.state === 'failed'
  );
}

/**
 * Worker report messages are structured envelopes; unwrap `{summary}` when present (see
 * demo/index.html's `results` map) and fall back to the raw content otherwise.
 */
export function workerReportText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { summary?: unknown };
    return typeof parsed.summary === 'string' ? parsed.summary : content;
  } catch {
    return content;
  }
}

export type WorkerGlance = { state: string; line: string };

type GlanceWorker = Pick<
  WorkerSummary,
  'id' | 'state' | 'reasoningActive' | 'currentActivity' | 'liveOutput'
>;

const GLANCE_LINE_CHARS = 160;

/** One line of Markdown or streamed text as plain prose: the first (or last) non-empty line,
 * without block markers or inline emphasis, cut to a length a zoomed-out card can show. */
function plainLine(text: string, from: 'first' | 'last'): string {
  const lines = text.split('\n').map((line) => line.trim());
  const picked = (from === 'first' ? lines : lines.reverse()).find((line) => line !== '') ?? '';
  const plain = picked
    .replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/[*_`]+/g, '')
    .trim();
  return plain.length > GLANCE_LINE_CHARS ? `${plain.slice(0, GLANCE_LINE_CHARS)}…` : plain;
}

function glanceState(worker: GlanceWorker): string {
  switch (worker.state) {
    case 'busy':
      return worker.reasoningActive ? '思考中' : '作業中';
    case 'invited':
    case 'spawning':
      return '準備中';
    case 'ready':
    case 'waiting':
      return '待機中';
    case 'done':
      return '完了';
    case 'failed':
      return '失敗';
    case 'stopped':
      return '停止済み';
  }
}

/**
 * What a zoomed-out Worker card shows in place of its thread (FR-CAN-04): the state in words and
 * the newest thing the Worker did or said, so a far view of the Team reads as who is doing what
 * rather than as a grid of empty cards. A busy Worker's current step or streaming text wins over
 * the thread, since that is what it is doing now.
 */
export function workerGlance(
  worker: GlanceWorker,
  thread: readonly WorkerThreadItem[],
): WorkerGlance {
  const state = glanceState(worker);
  const busy = worker.state === 'busy';
  if (busy && worker.currentActivity !== null)
    return { state, line: workStepLabel(worker.currentActivity) };
  if (busy && worker.liveOutput.trim() !== '')
    return { state, line: plainLine(worker.liveOutput, 'last') };
  const newest = thread.at(-1);
  if (newest?.kind === 'step') return { state, line: workStepLabel(newest.step.label) };
  if (newest?.kind === 'message') {
    const { content, sourceAgentId } = newest.message;
    return {
      state,
      line: plainLine(sourceAgentId === worker.id ? workerReportText(content) : content, 'first'),
    };
  }
  return {
    state,
    line:
      worker.state === 'ready' || worker.state === 'waiting'
        ? 'Leaderからの依頼を待っています'
        : '',
  };
}
