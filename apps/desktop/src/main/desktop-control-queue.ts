import { randomUUID } from 'node:crypto';
import type { ExecutionSpec } from '@sprint-coder/domain';
import type { CommandOutputChunk, CommandResult, RunOptions } from './command-runner';
import { secureLogger } from './secure-logger';

/**
 * The order in which the desktop-control runs of one Task's session start, kept by Main, so that
 * the Leader and the Team's desktop Workers do not wait for each other inside the executable.
 *
 * The executable lets one run at a time act on the desktop: an action holds the interaction lease
 * (`crates/windows/src/system/interaction_lease`, one lock file per Windows user) for as long as it
 * acts, a snapshot of an Electron or Chrome window takes it too (`tree/renderer_accessibility.rs`),
 * and every run in the session takes the session's ref store lock (`refstore.lock`) as it starts
 * and as it saves refs. A run that cannot have a lock within its own deadline (5 seconds, unless
 * `--timeout-ms` gives a ref action more) ends with `TIMEOUT`. So every run of the Task's session
 * that reads or operates the desktop goes through here, one after another, reads included; a run
 * that only prints (guides, help, version, status) never runs in the session and never waits.
 *
 * Used only for a run Main placed in the Task's session (`SPRINT_CODER_DESKTOP_TEAM_CURSORS=1`);
 * without it nothing here runs. A run waits after its approval card, never before it: the card is
 * decided before the tool's execution starts, so a card left open holds no one's turn.
 *
 * A run whose turn does not come within `DESKTOP_CONTROL_QUEUE_WAIT_MS` does not start, and fails
 * with a message saying so. A run whose Turn is canceled while it waits does not start either. A
 * run's turn ends when its process ends, however it ends (the Leader's run may go on in the
 * background after its call returned, and still holds the turn). When the Task's session ends
 * (the Task is archived, Sprint Coder quits), the runs still waiting do not start.
 *
 * In its turn, a run the executable reports as not delivered (`DESKTOP_CONTROL_RETRY` below) runs
 * once more with the same sealed argv, which its card allowed.
 */

export type DesktopControlCommandRun = (
  spec: ExecutionSpec,
  options: RunOptions,
) => Promise<CommandResult>;

/**
 * How long a run waits for its turn. A desktop operation takes a few seconds at most (the
 * executable gives up on its own waits after 5 seconds unless told longer), and a Task has at most
 * four agents on the desktop (the Leader and three Workers), so a run with three ahead of it waits
 * about 15 seconds; four times that is left for slow apps. A run that waits longer is behind a long
 * one (a `wait` or a `batch` with a long timeout), and its agent is told so instead of being held.
 */
export const DESKTOP_CONTROL_QUEUE_WAIT_MS = 60_000;
/** The pause before the one run again (the executable's own `recovery.retry_after_ms`). */
export const DESKTOP_CONTROL_RETRY_DELAY_MS = 250;
/**
 * The output kept back from a run until it is known whether it runs again: its printed answer is
 * one small JSON. A run that prints more is not one that was not delivered, and its output then
 * goes on as it comes.
 */
const HELD_OUTPUT_BYTES = 64 * 1024;

type Waiter = {
  grant(): void;
  refuse(error: Error): void;
};

type TaskQueue = {
  busy: boolean;
  waiting: Waiter[];
};

const queues = new Map<string, TaskQueue>();

/** Thrown for a run that did not start because its turn did not come; nothing of it was done. */
export class DesktopControlQueueError extends Error {
  override readonly name = 'DesktopControlQueueError';
  /** How the agent's tool result names it (`providerWorkspaceToolFailure`). */
  readonly code = 'DESKTOP_CONTROL_NOT_RUN';
}

/**
 * `run`, through the Task's order: it starts only in its turn, and runs once more when the
 * executable reports that it was not delivered.
 */
export function queuedDesktopControlRun(
  taskId: string,
  run: DesktopControlCommandRun,
): DesktopControlCommandRun {
  return async (spec, options) => {
    if (options.signal?.aborted) return canceledBeforeStart();
    const release = await turnOf(taskId, options.signal);
    if (release === null) return canceledBeforeStart();
    try {
      return await runRetryingUndelivered(run, spec, options);
    } finally {
      release();
    }
  };
}

/** Refuses the Task's runs still waiting, which then do not start (when its session ends). */
export function endDesktopControlQueue(taskId: string): void {
  const queue = queues.get(taskId);
  if (queue === undefined) return;
  queues.delete(taskId);
  refuseWaiting(queue);
}

/** Refuses every Task's runs still waiting (when Sprint Coder quits, and for tests). */
export function endDesktopControlQueues(): void {
  const all = [...queues.values()];
  queues.clear();
  for (const queue of all) refuseWaiting(queue);
}

/** For tests: how many runs of the Task wait, and whether one holds its turn. */
export function desktopControlQueueState(
  taskId: string,
): Readonly<{ busy: boolean; waiting: number }> {
  const queue = queues.get(taskId);
  return { busy: queue?.busy ?? false, waiting: queue?.waiting.length ?? 0 };
}

function refuseWaiting(queue: TaskQueue): void {
  const waiting = queue.waiting.splice(0);
  for (const waiter of waiting)
    waiter.refuse(
      new DesktopControlQueueError(
        'この Task のデスクトップ操作の session が終わったため、順番を待っていたこの操作は実行しなかった（操作は届いていない）。',
      ),
    );
}

/** Resolves with the release of the turn once it is this run's, or `null` when canceled first. */
function turnOf(taskId: string, signal: AbortSignal | undefined): Promise<(() => void) | null> {
  let queue = queues.get(taskId);
  if (queue === undefined) {
    queue = { busy: false, waiting: [] };
    queues.set(taskId, queue);
  }
  const held = queue;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    const next = held.waiting.shift();
    if (next !== undefined) {
      next.grant();
      return;
    }
    held.busy = false;
    if (queues.get(taskId) === held) queues.delete(taskId);
  };
  if (!held.busy) {
    held.busy = true;
    return Promise.resolve(release);
  }
  return new Promise((resolve, reject) => {
    const leave = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const index = held.waiting.indexOf(waiter);
      if (index >= 0) held.waiting.splice(index, 1);
    };
    const onAbort = (): void => {
      leave();
      resolve(null);
    };
    const waiter: Waiter = {
      grant: () => {
        leave();
        resolve(release);
      },
      refuse: (error) => {
        leave();
        reject(error);
      },
    };
    const timer = setTimeout(() => {
      leave();
      secureLogger.warn(
        'Desktop control run did not get its turn in time',
        { waitMs: DESKTOP_CONTROL_QUEUE_WAIT_MS },
        { event: 'desktop_control_queue_timeout' },
      );
      reject(
        new DesktopControlQueueError(
          `ほかのデスクトップ操作の順番を ${Math.round(DESKTOP_CONTROL_QUEUE_WAIT_MS / 1000)} 秒待っても回ってこなかったため、この操作は実行しなかった（操作は届いていない）。同じ操作を、もう一度実行してよい。`,
        ),
      );
    }, DESKTOP_CONTROL_QUEUE_WAIT_MS);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    held.waiting.push(waiter);
  });
}

/** As the runner answers a run that was canceled before it started: nothing was started. */
function canceledBeforeStart(): CommandResult {
  return {
    executionId: randomUUID(),
    exitCode: null,
    signal: null,
    canceled: true,
    termination: 'cooperative',
    durationMs: 0,
    outputBytes: 0,
    truncated: false,
  };
}

/**
 * Runs `spec`, and once more, with the same sealed spec, only when the first run ended by itself
 * with the executable's own answer that the operation was not delivered (`desktopControlReportsUndelivered`).
 * Never a third time, and never after a run Main stopped, canceled, or whose output it could not
 * read in full: whether that one landed is not known, and doing an operation twice is worse than
 * failing it.
 *
 * The run again is the same command as far as its caller can tell: it is started (`beforeSpawn`,
 * `onStarted`) and recorded once, by the first run, and its output is the last run's. The first
 * run's output is held back until it is known whether it runs again.
 */
async function runRetryingUndelivered(
  run: DesktopControlCommandRun,
  spec: ExecutionSpec,
  options: RunOptions,
): Promise<CommandResult> {
  const forward = async (chunks: readonly CommandOutputChunk[]): Promise<void> => {
    if (chunks.length === 0) return;
    if (options.onBatch !== undefined) await options.onBatch(Object.freeze([...chunks]));
    else if (options.onChunk !== undefined)
      for (const chunk of chunks) await options.onChunk(chunk);
  };
  const held: CommandOutputChunk[] = [];
  let heldBytes = 0;
  let passing = false;
  const { onChunk: _onChunk, ...rest } = options;
  const first = await run(spec, {
    ...rest,
    onBatch: async (chunks) => {
      if (passing) return forward(chunks);
      held.push(...chunks);
      heldBytes += chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      if (heldBytes > HELD_OUTPUT_BYTES) {
        passing = true;
        await forward(held.splice(0));
      }
    },
  });
  const undelivered =
    !passing &&
    endedByItself(first) &&
    // `batch` answers each step's failure inside its own `ok: true`; this reads only a run's own.
    desktopControlReportsUndelivered(
      held
        .filter(({ stream }) => stream === 'stdout')
        .map(({ text }) => text)
        .join(''),
    );
  if (!undelivered || options.signal?.aborted || !(await pause(options.signal))) {
    await forward(held.splice(0));
    return first;
  }
  secureLogger.info(
    'Desktop control run was not delivered and runs once more',
    { command: spec.argv.find((argument) => !argument.startsWith('-')) ?? null },
    { event: 'desktop_control_retry_undelivered' },
  );
  const { beforeSpawn: _beforeSpawn, onStarted: _onStarted, ...again } = options;
  return run(spec, again);
}

/** Whether the run ended by itself, with an answer Main read in full. */
function endedByItself(result: CommandResult): boolean {
  return (
    !result.canceled &&
    result.termination === 'natural' &&
    result.signal === null &&
    !result.truncated &&
    typeof result.exitCode === 'number' &&
    result.exitCode !== 0
  );
}

/**
 * Whether what the executable printed is its own answer that the operation did not reach the
 * desktop because it ran out of time first, and may be run again: one JSON envelope with
 * `ok: false`, `error.code: "TIMEOUT"` and `error.disposition` `{ delivery: "not_delivered",
 * retry: "safe" }` (`crates/core/src/response/output.rs`, `actions/delivery_semantics.rs`). The
 * executable answers so only when it knows nothing was sent: a lock or deadline that ran out before
 * the command began (`pre_dispatch_error` in `src/main.rs`: the session's `refstore.lock` as the
 * run starts, among others) or a read (`dispatch/disposition.rs`). A timed-out operation that may
 * have been sent is answered `unknown` or `delivered_*` (a ref action that ran out of time waiting
 * for the interaction lease is answered `unknown` as well), and does not run again; nor
 * does any other failure (`STALE_REF` and the like would only be refused again).
 */
export function desktopControlReportsUndelivered(stdout: string): boolean {
  let output: unknown;
  try {
    output = JSON.parse(stdout);
  } catch {
    return false;
  }
  if (typeof output !== 'object' || output === null) return false;
  const { ok, error } = output as { ok?: unknown; error?: unknown };
  if (ok !== false || typeof error !== 'object' || error === null) return false;
  const { code, disposition } = error as { code?: unknown; disposition?: unknown };
  if (code !== 'TIMEOUT' || typeof disposition !== 'object' || disposition === null) return false;
  const { delivery, retry } = disposition as { delivery?: unknown; retry?: unknown };
  return delivery === 'not_delivered' && retry === 'safe';
}

/** Waits `DESKTOP_CONTROL_RETRY_DELAY_MS`; `false` when canceled first. */
function pause(signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, DESKTOP_CONTROL_RETRY_DELAY_MS);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
