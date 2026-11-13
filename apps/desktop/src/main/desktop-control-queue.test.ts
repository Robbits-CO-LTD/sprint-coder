import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry, type ExecutionSpec } from '@sprint-coder/domain';
import { ToolBroker } from './tool-broker';
import {
  COMMAND_RUNNER_TOOL,
  MANAGED_EXEC_COMMAND_TOOL,
  registerCommandRunnerTool,
  type CommandToolBoundary,
} from './default-tools';
import {
  CommandRunner,
  type CommandOutputChunk,
  type CommandResult,
  type RunOptions,
} from './command-runner';
import * as desktopControlModule from './desktop-control';
import {
  DESKTOP_CONTROL_QUEUE_WAIT_MS,
  DESKTOP_CONTROL_RETRY_DELAY_MS,
  DesktopControlQueueError,
  desktopControlQueueState,
  desktopControlReportsUndelivered,
  endDesktopControlQueue,
  endDesktopControlQueues,
  queuedDesktopControlRun,
} from './desktop-control-queue';
import {
  configureDesktopControlTeamCursors,
  endDesktopControlSession,
  endDesktopControlSessions,
  markDesktopControlWorker,
  resetDesktopControlSessions,
} from './desktop-control-session';
import { ManagedCommandSessions } from './managed-command-sessions';
import { providerWorkspaceToolFailure } from './provider-tool-result';

/** The executable's answers, as `crates/core/src/response/output.rs` prints them. */
function envelope(
  code: string,
  delivery: string,
  retry: string,
  command = 'click',
  details: Record<string, unknown> = { kind: 'lock_timeout', purpose: 'ref store lock' },
): string {
  return `${JSON.stringify({
    version: '2.6',
    ok: false,
    command,
    error: {
      code,
      message: 'Operation exceeded its deadline',
      details,
      disposition: { delivery, retry },
    },
  })}\n`;
}
/** A run that waited for a lock another run held until its time ran out: nothing was sent. */
const UNDELIVERED = envelope('TIMEOUT', 'not_delivered', 'safe');
/** A `wait` whose condition was not met in its own time (`commands/wait_timeout.rs`). */
const WAIT_TIMED_OUT = envelope('TIMEOUT', 'not_delivered', 'safe', 'wait', {
  kind: 'wait_timeout',
  predicate: 'text',
  timeout_ms: 150_000,
});
const DONE = `${JSON.stringify({ version: '2.6', ok: true, command: 'click', data: {} })}\n`;

const natural: CommandResult = {
  executionId: 'execution',
  exitCode: 0,
  signal: null,
  canceled: false,
  termination: 'natural',
  durationMs: 1,
  outputBytes: 0,
  truncated: false,
};

const spec = (argv: string[] = ['click', '@s1:e1']) => ({ argv }) as unknown as ExecutionSpec;

type Pending = {
  spec: ExecutionSpec;
  options: RunOptions;
  /** Prints `stdout` (if any), then ends with `result`. */
  finish(stdout?: string, result?: Partial<CommandResult>): void;
  fail(error: Error): void;
};

/** A run that ends only when the test ends it, as the executable would. */
function fakeRun() {
  const pending: Pending[] = [];
  const run = vi.fn(
    (runSpec: ExecutionSpec, options: RunOptions) =>
      new Promise<CommandResult>((resolve, reject) => {
        options.beforeSpawn?.();
        options.onStarted?.({
          executionId: `execution-${pending.length + 1}`,
          pid: pending.length + 1,
          startedAt: 0,
          processStartIdentity: 'identity',
          executionImageDigest: 'a'.repeat(64),
          executionImageIdentity: 'identity',
        });
        pending.push({
          spec: runSpec,
          options,
          finish: (stdout = '', result = {}) => {
            void (async () => {
              if (stdout !== '')
                await options.onBatch?.([
                  {
                    seq: 1,
                    stream: 'stdout',
                    text: stdout,
                    byteLength: Buffer.byteLength(stdout),
                  },
                ]);
              resolve({ ...natural, ...result });
            })();
          },
          fail: reject,
        });
      }),
  );
  return { run, pending };
}

/** A consumer of a run's output and start, as the tool's hooks are. */
function hooks(signal?: AbortSignal) {
  const output: CommandOutputChunk[] = [];
  const beforeSpawn = vi.fn();
  const onStarted = vi.fn();
  const options: RunOptions = {
    ...(signal === undefined ? {} : { signal }),
    beforeSpawn,
    onStarted,
    onBatch: (chunks) => void output.push(...chunks),
  };
  return {
    options,
    beforeSpawn,
    onStarted,
    stdout: () => output.map(({ text }) => text).join(''),
  };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

describe('the Task’s desktop-control order', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    endDesktopControlQueues();
    vi.useRealTimers();
  });

  it('starts the Task’s runs one at a time, in the order they came', async () => {
    const { run, pending } = fakeRun();
    const queued = queuedDesktopControlRun('task-1', run);
    const done: string[] = [];
    const results = ['a', 'b', 'c'].map((name) =>
      queued(spec(['click', name]), hooks().options).then(() => void done.push(name)),
    );
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(desktopControlQueueState('task-1')).toEqual({ busy: true, waiting: 2 });
    for (const [index, name] of ['a', 'b', 'c'].entries()) {
      expect(pending[index]!.spec.argv[1]).toBe(name);
      expect(run).toHaveBeenCalledTimes(index + 1);
      pending[index]!.finish(DONE);
      await settle();
    }
    await Promise.all(results);
    expect(done).toEqual(['a', 'b', 'c']);
    expect(desktopControlQueueState('task-1')).toEqual({ busy: false, waiting: 0 });
  });

  it('runs another Task’s runs alongside, without waiting', async () => {
    const { run, pending } = fakeRun();
    void queuedDesktopControlRun('task-1', run)(spec(), hooks().options);
    // Refused when the test ends the order, as it never got its turn.
    const waiting = queuedDesktopControlRun('task-1', run)(spec(), hooks().options);
    waiting.catch(() => undefined);
    void queuedDesktopControlRun('task-2', run)(spec(), hooks().options);
    await settle();
    expect(run).toHaveBeenCalledTimes(2);
    expect(pending.map(({ spec: { argv } }) => argv)).toHaveLength(2);
    expect(desktopControlQueueState('task-1')).toEqual({ busy: true, waiting: 1 });
    expect(desktopControlQueueState('task-2')).toEqual({ busy: true, waiting: 0 });
  });

  it('runs once more, with the same sealed spec, only when the executable said it was not delivered', async () => {
    const { run, pending } = fakeRun();
    const consumer = hooks();
    const sealed = spec();
    const result = queuedDesktopControlRun('task-1', run)(sealed, consumer.options);
    await settle();
    pending[0]!.finish(UNDELIVERED, { exitCode: 1 });
    await settle();
    // Not before the executable's own pause.
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DESKTOP_CONTROL_RETRY_DELAY_MS);
    expect(run).toHaveBeenCalledTimes(2);
    expect(pending[1]!.spec).toBe(sealed);
    // Still in its turn: no other run of the Task starts in between.
    expect(desktopControlQueueState('task-1').busy).toBe(true);
    pending[1]!.finish(DONE);
    await expect(result).resolves.toMatchObject({ exitCode: 0 });
    // Started and recorded once; its output is the last run's alone.
    expect(consumer.beforeSpawn).toHaveBeenCalledTimes(1);
    expect(consumer.onStarted).toHaveBeenCalledTimes(1);
    expect(consumer.stdout()).toBe(DONE);
  });

  it('runs again only once, however the second run ends', async () => {
    const { run, pending } = fakeRun();
    const consumer = hooks();
    const result = queuedDesktopControlRun('task-1', run)(spec(), consumer.options);
    await settle();
    pending[0]!.finish(UNDELIVERED, { exitCode: 1 });
    await vi.advanceTimersByTimeAsync(DESKTOP_CONTROL_RETRY_DELAY_MS);
    pending[1]!.finish(UNDELIVERED, { exitCode: 1 });
    await vi.advanceTimersByTimeAsync(DESKTOP_CONTROL_RETRY_DELAY_MS * 10);
    await expect(result).resolves.toMatchObject({ exitCode: 1 });
    expect(run).toHaveBeenCalledTimes(2);
    expect(consumer.stdout()).toBe(UNDELIVERED);
  });

  it.each([
    ['delivery not known', envelope('TIMEOUT', 'unknown', 'unknown'), {}],
    ['delivery uncertain', envelope('TIMEOUT', 'delivery_uncertain', 'unsafe'), {}],
    ['delivered', envelope('TIMEOUT', 'delivered_unverified', 'unsafe'), {}],
    ['another failure that was not delivered', envelope('STALE_REF', 'not_delivered', 'safe'), {}],
    ['a wait that timed out on its own', WAIT_TIMED_OUT, {}],
    [
      'a wait that timed out waiting for a lock',
      envelope('TIMEOUT', 'not_delivered', 'safe', 'wait'),
      {},
    ],
    [
      'a read past its own deadline',
      envelope('TIMEOUT', 'not_delivered', 'safe', 'snapshot', {
        kind: 'deadline',
        timeout_ms: 5000,
        elapsed_ms: 5001,
      }),
      {},
    ],
    [
      'a timeout that names no lock',
      envelope('TIMEOUT', 'not_delivered', 'safe', 'snapshot', {}),
      {},
    ],
    ['an answer that is not JSON', 'agent-desktop: failed to write response\n', {}],
    ['two answers', `${UNDELIVERED}${UNDELIVERED}`, {}],
    ['no answer', '', {}],
    ['an answer that says ok', UNDELIVERED.replace('"ok":false', '"ok":true'), {}],
    ['a run Main stopped', UNDELIVERED, { canceled: true, termination: 'cooperative' }],
    ['a run Main forced to end', UNDELIVERED, { termination: 'forced', exitCode: null }],
    ['a run ended by a signal', UNDELIVERED, { signal: 'SIGKILL', exitCode: null }],
    ['an answer cut short', UNDELIVERED, { truncated: true }],
    ['an exit that says it succeeded', UNDELIVERED, { exitCode: 0 }],
  ] as const)('does not run again after %s', async (_name, stdout, result) => {
    const { run, pending } = fakeRun();
    const consumer = hooks();
    const answer = queuedDesktopControlRun('task-1', run)(spec(), consumer.options);
    await settle();
    pending[0]!.finish(stdout, { exitCode: 1, ...result });
    await vi.advanceTimersByTimeAsync(DESKTOP_CONTROL_RETRY_DELAY_MS * 10);
    await answer;
    expect(run).toHaveBeenCalledTimes(1);
    // Its output reaches the caller as it was printed.
    expect(consumer.stdout()).toBe(stdout);
  });

  it('gives a long wait’s own TIMEOUT as it is, after one run, and frees the turn', async () => {
    const { run, pending } = fakeRun();
    const queued = queuedDesktopControlRun('task-1', run);
    const consumer = hooks();
    const waited = queued(
      spec(['wait', '--text', 'done', '--timeout', '150000']),
      consumer.options,
    );
    const next = queued(spec(['click', 'next']), hooks().options);
    await settle();
    pending[0]!.finish(WAIT_TIMED_OUT, { exitCode: 1, durationMs: 150_000 });
    await expect(waited).resolves.toMatchObject({ exitCode: 1 });
    expect(consumer.stdout()).toBe(WAIT_TIMED_OUT);
    await vi.advanceTimersByTimeAsync(DESKTOP_CONTROL_RETRY_DELAY_MS * 10);
    // The next run of the Task, not the wait again, has the turn.
    expect(run).toHaveBeenCalledTimes(2);
    expect(pending[1]!.spec.argv[1]).toBe('next');
    pending[1]!.finish(DONE);
    await next;
  });

  it('does not run again when the answer was more than it holds back', async () => {
    const { run, pending } = fakeRun();
    const consumer = hooks();
    const answer = queuedDesktopControlRun('task-1', run)(spec(), consumer.options);
    await settle();
    const padding = { stream: 'stderr' as const, text: 'x'.repeat(70_000), byteLength: 70_000 };
    await pending[0]!.options.onBatch!([{ seq: 0, ...padding }]);
    // Past what it holds back, the output goes on as it comes.
    expect(consumer.stdout()).toHaveLength(70_000);
    pending[0]!.finish(UNDELIVERED, { exitCode: 1 });
    await vi.advanceTimersByTimeAsync(DESKTOP_CONTROL_RETRY_DELAY_MS * 10);
    await answer;
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('gives the held output to a consumer that takes it chunk by chunk', async () => {
    const { run, pending } = fakeRun();
    const chunks: string[] = [];
    const answer = queuedDesktopControlRun('task-1', run)(spec(), {
      onChunk: (chunk) => void chunks.push(chunk.text),
    });
    await settle();
    pending[0]!.finish(DONE);
    await answer;
    expect(chunks).toEqual([DONE]);
  });

  it('does not run again when the Turn is canceled during the pause', async () => {
    const { run, pending } = fakeRun();
    const controller = new AbortController();
    const consumer = hooks(controller.signal);
    const answer = queuedDesktopControlRun('task-1', run)(spec(), consumer.options);
    await settle();
    pending[0]!.finish(UNDELIVERED, { exitCode: 1 });
    await settle();
    controller.abort();
    await vi.advanceTimersByTimeAsync(DESKTOP_CONTROL_RETRY_DELAY_MS * 10);
    await expect(answer).resolves.toMatchObject({ exitCode: 1 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(consumer.stdout()).toBe(UNDELIVERED);
  });

  it('fails a run whose turn does not come in time, without starting it, and goes on', async () => {
    const { run, pending } = fakeRun();
    const queued = queuedDesktopControlRun('task-1', run);
    void queued(spec(['click', 'long']), hooks().options);
    const late = hooks();
    const waiting = queued(spec(['click', 'late']), late.options);
    const rejected = expect(waiting).rejects.toThrow(DesktopControlQueueError);
    const next = queued(spec(['click', 'next']), hooks().options);
    const nextRejected = expect(next).rejects.toThrow(DesktopControlQueueError);
    await vi.advanceTimersByTimeAsync(DESKTOP_CONTROL_QUEUE_WAIT_MS - 1);
    expect(desktopControlQueueState('task-1').waiting).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    await expect(waiting).rejects.toThrow(
      /実行しなかった（操作は届いていない）。同じ操作を、もう一度実行してよい/,
    );
    expect(late.beforeSpawn).not.toHaveBeenCalled();
    // The next one waited as long, and also gave up; the long run is still running.
    await nextRejected;
    expect(run).toHaveBeenCalledTimes(1);
    // One that comes now waits for the long run, and runs after it.
    const after = queued(spec(['click', 'after']), hooks().options);
    pending[0]!.finish(DONE);
    await settle();
    expect(run).toHaveBeenCalledTimes(2);
    expect(pending[1]!.spec.argv[1]).toBe('after');
    pending[1]!.finish(DONE);
    await expect(after).resolves.toMatchObject({ exitCode: 0 });
  });

  it('takes a run out of the order without starting it when its Turn is canceled', async () => {
    const { run, pending } = fakeRun();
    const queued = queuedDesktopControlRun('task-1', run);
    void queued(spec(['click', 'first']), hooks().options);
    const controller = new AbortController();
    const canceled = hooks(controller.signal);
    const waiting = queued(spec(['click', 'canceled']), canceled.options);
    const third = queued(spec(['click', 'third']), hooks().options);
    await settle();
    controller.abort();
    // Answered as the runner answers a run canceled before it started.
    await expect(waiting).resolves.toMatchObject({ canceled: true, exitCode: null });
    expect(canceled.beforeSpawn).not.toHaveBeenCalled();
    expect(desktopControlQueueState('task-1').waiting).toBe(1);
    pending[0]!.finish(DONE);
    await settle();
    expect(pending.map(({ spec: { argv } }) => argv[1])).toEqual(['first', 'third']);
    pending[1]!.finish(DONE);
    await third;
    // Canceled before it came: never waits, never starts.
    const already = new AbortController();
    already.abort();
    await expect(queued(spec(), hooks(already.signal).options)).resolves.toMatchObject({
      canceled: true,
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('goes on to the next run after one that failed or threw', async () => {
    const { run, pending } = fakeRun();
    const queued = queuedDesktopControlRun('task-1', run);
    const threw = queued(spec(['click', 'throws']), hooks().options);
    const failed = queued(spec(['click', 'fails']), hooks().options);
    const last = queued(spec(['click', 'last']), hooks().options);
    await settle();
    pending[0]!.fail(new Error('spawn failed'));
    await expect(threw).rejects.toThrow('spawn failed');
    await settle();
    pending[1]!.finish(envelope('ACTION_FAILED', 'delivered_unverified', 'unsafe'), {
      exitCode: 1,
    });
    await expect(failed).resolves.toMatchObject({ exitCode: 1 });
    await settle();
    expect(pending[2]!.spec.argv[1]).toBe('last');
    pending[2]!.finish(DONE);
    await expect(last).resolves.toMatchObject({ exitCode: 0 });
    expect(desktopControlQueueState('task-1')).toEqual({ busy: false, waiting: 0 });
  });

  it('leaves no run waiting when the Task’s session ends, and starts none of them', async () => {
    const { run, pending } = fakeRun();
    const queued = queuedDesktopControlRun('task-1', run);
    const running = queued(spec(['click', 'running']), hooks().options);
    const waiting = queued(spec(['click', 'waiting']), hooks().options);
    const other = queuedDesktopControlRun('task-2', run);
    void other(spec(['click', 'other-running']), hooks().options);
    const otherWaiting = other(spec(['click', 'other-waiting']), hooks().options);
    const refused = waiting.then(
      () => {
        throw new Error('the waiting run should have been refused');
      },
      (error: unknown) => {
        // Told to the agent as it is, as the queue's own refusal.
        expect(JSON.parse(providerWorkspaceToolFailure(error))).toMatchObject({
          error: {
            code: 'DESKTOP_CONTROL_NOT_RUN',
            message: expect.stringContaining('session が終わったため'),
          },
        });
      },
    );
    const otherRefused = expect(otherWaiting).rejects.toThrow('session が終わったため');
    await settle();
    // Archiving the Task ends its session.
    await endDesktopControlSession('task-1');
    await refused;
    expect(desktopControlQueueState('task-1')).toEqual({ busy: false, waiting: 0 });
    expect(desktopControlQueueState('task-2')).toEqual({ busy: true, waiting: 1 });
    // The run already running is left to end as it would.
    pending[0]!.finish(DONE);
    await expect(running).resolves.toMatchObject({ exitCode: 0 });
    await settle();
    expect(pending.map(({ spec: { argv } }) => argv[1])).toEqual(['running', 'other-running']);
    // Quitting Sprint Coder ends every session.
    await endDesktopControlSessions();
    await otherRefused;
    expect(run).toHaveBeenCalledTimes(2);
    // A run of a new session of the Task does not wait for the old one's.
    const again = queued(spec(['click', 'again']), hooks().options);
    await settle();
    expect(run).toHaveBeenCalledTimes(3);
    pending[2]!.finish(DONE);
    await again;
    endDesktopControlQueue('task-2');
  });
});

describe('the executable’s answer that an operation was not delivered', () => {
  it('reads only a lock’s TIMEOUT with delivery not_delivered and retry safe', () => {
    expect(desktopControlReportsUndelivered(UNDELIVERED)).toBe(true);
    expect(desktopControlReportsUndelivered(UNDELIVERED.trim())).toBe(true);
    // The interaction lease's own lock answers the same kind (`interaction_lease/mod.rs`).
    expect(
      desktopControlReportsUndelivered(
        envelope('TIMEOUT', 'not_delivered', 'safe', 'snapshot', {
          kind: 'lock_timeout',
          path: 'interaction.lock',
          contention_count: 3,
        }),
      ),
    ).toBe(true);
    for (const stdout of [
      WAIT_TIMED_OUT,
      envelope('TIMEOUT', 'not_delivered', 'safe', 'wait'),
      envelope('TIMEOUT', 'not_delivered', 'safe', 'click', { kind: 'deadline' }),
      envelope('TIMEOUT', 'not_delivered', 'safe', 'click', { kind: 'wait_timeout' }),
      envelope('TIMEOUT', 'not_delivered', 'safe', 'click', {}),
      UNDELIVERED.replace(',"details":{"kind":"lock_timeout","purpose":"ref store lock"}', ''),
      envelope('TIMEOUT', 'not_delivered', 'unsafe'),
      envelope('TIMEOUT', 'unknown', 'unknown'),
      envelope('TIMEOUT', 'delivered_verified', 'unsafe'),
      envelope('POLICY_DENIED', 'not_delivered', 'safe'),
      envelope('APP_UNRESPONSIVE', 'not_delivered', 'safe'),
      DONE,
      'null',
      '"TIMEOUT"',
      '{"ok":false}',
      '{"ok":false,"error":{"code":"TIMEOUT"}}',
      '{"ok":false,"error":{"code":"TIMEOUT","disposition":"not_delivered"}}',
      '',
    ])
      expect(desktopControlReportsUndelivered(stdout)).toBe(false);
  });
});

/** The persistence and events a command run records, in memory. */
function createBoundary(workspace: string) {
  const rows = new Map<string, { state: string; outputBytes: number }>();
  const startCommand = vi.fn(({ commandId }: { commandId: string }) => {
    const row = rows.get(commandId)!;
    if (row.state !== 'starting') throw new Error('Command is not starting');
    row.state = 'running';
    return { command: {} as never, event: {} as never };
  });
  const boundary = {
    persistence: {
      readTurnWorkspaceSet: () => ({
        source: 'task' as const,
        projectId: null,
        primaryRootId: 'root-a',
        roots: [
          {
            rootId: 'root-a',
            path: workspace,
            label: 'Workspace',
            role: 'primary' as const,
            status: 'available' as const,
          },
        ],
        digest: 'a'.repeat(64),
      }),
      getTurnWorkspaceRootIdentities: () => new Map(),
      prepareCommand: (input: { id: string }) => {
        rows.set(input.id, { state: 'prepared', outputBytes: 0 });
        return { id: input.id, state: 'prepared' } as never;
      },
      beginCommand: (id: string) => {
        const row = rows.get(id)!;
        if (row.state !== 'prepared') throw new Error('Command is not prepared');
        row.state = 'starting';
        return { id, ...row } as never;
      },
      startCommand,
      appendCommandOutput: () => ({}) as never,
      appendCommandOutputBatch: () => [],
      completeCommand: ({ commandId, state }: { commandId: string; state: string }) => {
        rows.get(commandId)!.state = state;
        return { command: {} as never, event: { type: 'command.completed' } as never };
      },
      getCommand: (id: string) => ({ id, ...rows.get(id)! }) as never,
      createBackgroundActivity: () => ({}) as never,
      transitionBackgroundActivity: () => ({}) as never,
      completeBackgroundActivity: () => ({}) as never,
    },
    publish: vi.fn(),
  } as unknown as CommandToolBoundary;
  return { boundary, rows, startCommand };
}

describe.each([
  ['run_command', 'without managed sessions'],
  ['exec_command', 'through managed sessions'],
] as const)('a desktop-control tool call (%s, %s)', (providerName, _path) => {
  const workspaces: string[] = [];
  afterEach(async () => {
    resetDesktopControlSessions();
    vi.restoreAllMocks();
    await Promise.all(
      workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  async function setUp() {
    const workspace = await mkdtemp(join(tmpdir(), 'sprint-coder-desktop-queue-'));
    workspaces.push(workspace);
    const registry = new ToolRegistry();
    const definition =
      providerName === 'run_command' ? COMMAND_RUNNER_TOOL : MANAGED_EXEC_COMMAND_TOOL;
    registry.register(definition);
    const { boundary, rows, startCommand } = createBoundary(workspace);
    const runner = new CommandRunner({ sandboxed: true });
    const taskId = `task-queue-${providerName}`;
    // Each operation's answers, in turn; Main's own runs answer as the executable does.
    const answers: string[] = [];
    const operations: { argv: readonly string[]; spec: ExecutionSpec; queued: boolean }[] = [];
    const run = vi.spyOn(runner, 'run').mockImplementation(async (runSpec, options = {}) => {
      options.beforeSpawn?.();
      options.onStarted?.({
        executionId: 'execution',
        pid: 1,
        startedAt: Date.now(),
        processStartIdentity: 'identity',
        executionImageDigest: 'a'.repeat(64),
        executionImageIdentity: 'identity',
      });
      const own = runSpec.argv[0] === 'session' || runSpec.argv[0] === 'cursor-overlay';
      if (!own)
        operations.push({
          argv: runSpec.argv,
          spec: runSpec,
          queued: desktopControlQueueState(taskId).busy,
        });
      const text = own
        ? JSON.stringify({ ok: true, data: { session_id: 'run-q' } })
        : (answers.shift() ?? DONE);
      await options.onBatch?.([{ seq: 1, stream: 'stdout', text, byteLength: text.length }]);
      return { ...natural, exitCode: desktopControlReportsUndelivered(text) ? 1 : 0 };
    });
    const sessions =
      providerName === 'exec_command' ? new ManagedCommandSessions(runner) : undefined;
    const broker = new ToolBroker(
      registry,
      () => 1,
      () => ({
        decision: 'allow',
        reason: 'test',
        beforeExecute: () => true,
        approvalDecision: 'allow_once',
      }),
    );
    // The Worker calls whose run started something (`recordManagedSideEffect`).
    const sideEffects: string[] = [];
    const withWorkers = {
      ...boundary,
      workerFor: (_turnId: string, callId: string) =>
        callId.startsWith('worker:') ? { workerId: 'agent-1', roots: [] } : undefined,
      workerSideEffect: (_turnId: string, callId: string) => void sideEffects.push(callId),
    } as CommandToolBoundary;
    registerCommandRunnerTool(broker, runner, withWorkers, definition, sessions);
    const owner = { taskId, turnId: `turn-${taskId}`, workspaceId: 'w', policyEpoch: 1 };
    broker.startTurn(owner, 'codex');
    vi.spyOn(desktopControlModule, 'isDesktopControlExecutable').mockReturnValue(true);
    const dispatch = (callId: string, argv: string[] = ['click', '@s1:e1']) =>
      broker.dispatch({
        ...owner,
        callId,
        providerName,
        input: { executable: process.execPath, argv, purpose: 'desktop queue' },
      }) as Promise<{ stdout: string; exitCode: number }>;
    const dispose = async () => {
      await broker.dispose();
      await sessions?.dispose();
    };
    return {
      dispatch,
      dispose,
      run,
      answers,
      operations,
      rows,
      startCommand,
      sideEffects,
      taskId,
    };
  }

  it('tells the agent that an operation whose turn did not come was not run, and records it failed', async () => {
    const { dispatch, dispose, operations, rows, startCommand, sideEffects, taskId } =
      await setUp();
    // Only the timers: the spec is still prepared on the real file system.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    try {
      configureDesktopControlTeamCursors(true);
      markDesktopControlWorker(taskId, 'agent-1', 'Checker');
      // Another run of the Task holds its turn the whole time (a long `wait`, say).
      let endHolder = (): void => undefined;
      const holder = queuedDesktopControlRun(
        taskId,
        () =>
          new Promise<CommandResult>((resolve) => {
            endHolder = () => resolve(natural);
          }),
      )(spec(['wait', '--timeout-ms', '120000']), {});
      const call = dispatch('worker:1').then(
        () => {
          throw new Error('the call should have failed');
        },
        (error: unknown) => error,
      );
      await vi.waitFor(() => expect(desktopControlQueueState(taskId).waiting).toBe(1), {
        timeout: 10_000,
      });
      const started = startCommand.mock.calls.length;
      await vi.advanceTimersByTimeAsync(DESKTOP_CONTROL_QUEUE_WAIT_MS);
      const error = await call;
      // What the Worker's MCP result carries (the bridge's `error.message`) and what the Leader's
      // provider is told (`providerWorkspaceToolFailure`): the words, with no path or id.
      expect(error).toBeInstanceOf(DesktopControlQueueError);
      const message = (error as Error).message;
      expect(message).toContain(
        '実行しなかった（操作は届いていない）。同じ操作を、もう一度実行してよい。',
      );
      expect(message).not.toMatch(/[\\/]|task-|worker:|run-q/u);
      expect(JSON.parse(providerWorkspaceToolFailure(error))).toEqual({
        ok: false,
        error: { code: 'DESKTOP_CONTROL_NOT_RUN', message },
      });
      // Nothing started: no operation ran, the command never began, and no side effect is known.
      expect(operations).toEqual([]);
      expect(startCommand.mock.calls.length).toBe(started);
      expect(sideEffects).toEqual([]);
      expect([...rows.values()].at(-1)?.state).toBe('failed');
      endHolder();
      await holder;
    } finally {
      vi.useRealTimers();
      await dispose();
    }
  });

  it('without the opt-in, runs as before: outside any order, and never again', async () => {
    const { dispatch, dispose, answers, operations, startCommand } = await setUp();
    try {
      answers.push(UNDELIVERED);
      const result = await dispatch('leader:1');
      expect(result.stdout).toBe(UNDELIVERED);
      expect(result.exitCode).toBe(1);
      expect(operations).toEqual([
        { argv: ['click', '@s1:e1'], spec: operations[0]!.spec, queued: false },
      ]);
      expect(startCommand).toHaveBeenCalledTimes(1);
    } finally {
      await dispose();
    }
  });

  it('with the opt-in, runs each operation in the Task’s order, and once more when not delivered', async () => {
    const { dispatch, dispose, answers, operations, rows, startCommand, taskId } = await setUp();
    try {
      configureDesktopControlTeamCursors(true);
      markDesktopControlWorker(taskId, 'agent-1', 'Checker');
      answers.push(UNDELIVERED, DONE);
      const result = await dispatch('worker:1');
      expect(result.stdout).toBe(DONE);
      expect(result.exitCode).toBe(0);
      expect(operations.map(({ argv, queued }) => [argv.join(' '), queued])).toEqual([
        ['click @s1:e1', true],
        ['click @s1:e1', true],
      ]);
      // The same sealed spec the card allowed, started and recorded as one command.
      expect(operations[1]!.spec).toBe(operations[0]!.spec);
      expect(startCommand).toHaveBeenCalledTimes(1);
      expect([...rows.values()].at(-1)?.state).toBe('exited');
      // An answer that does not say it was not delivered is given as it is.
      operations.splice(0);
      const unknown = envelope('TIMEOUT', 'unknown', 'unknown');
      answers.push(unknown);
      const reported = await dispatch('leader:2');
      expect(reported.stdout).toBe(unknown);
      expect(operations).toHaveLength(1);
      // A run that only prints stays out of the order.
      operations.splice(0);
      await dispatch('leader:3', ['skills', 'get', 'desktop']);
      expect(operations.map(({ queued }) => queued)).toEqual([false]);
    } finally {
      await dispose();
    }
  });
});
