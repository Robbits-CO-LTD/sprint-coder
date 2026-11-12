// Issue #1211: the bound on how long a Team Worker's desktop-control run is waited for (at most 300
// seconds). Past the bound the run is stopped and nothing of it is left running; a Turn canceled
// at the same moment still gets one result; and a run that asks to wait longer than the bound
// leaves room for is refused before its card.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '@sprint-coder/domain';
import { ToolBroker } from './tool-broker';
import {
  MANAGED_EXEC_COMMAND_TOOL,
  desktopControlWorkerWaitMs,
  desktopControlWorkerWaitRefusal,
  registerCommandRunnerTool,
  type CommandToolBoundary,
} from './default-tools';
import { CommandRunner, CommandRunnerError, type RunOptions } from './command-runner';
import * as desktopControlModule from './desktop-control';
import {
  configureDesktopControlTeamCursors,
  markDesktopControlWorker,
  resetDesktopControlSessions,
} from './desktop-control-session';
import { ManagedCommandSessions } from './managed-command-sessions';

const roots: string[] = [];
const spawnedPids: number[] = [];
afterEach(async () => {
  for (const pid of spawnedPids.splice(0)) killProcessIfAlive(pid);
  vi.restoreAllMocks();
  resetDesktopControlSessions();
  configureDesktopControlTeamCursors(false);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Row = { state: string; outputBytes: number };

function createBoundary(workspace: string, workerCall: (callId: string) => boolean) {
  const rows = new Map<string, Row>();
  const completions: Array<{ commandId: string; state: string }> = [];
  const backgroundActivities: string[] = [];
  const publish = vi.fn();
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
        return { id: input.id } as never;
      },
      beginCommand: (id: string) => {
        rows.get(id)!.state = 'starting';
        return { id } as never;
      },
      startCommand: ({ commandId }: { commandId: string }) => {
        rows.get(commandId)!.state = 'running';
        return { command: {} as never, event: { type: 'command.started' } as never };
      },
      appendCommandOutputBatch: () => [],
      completeCommand: ({ commandId, state }: { commandId: string; state: string }) => {
        completions.push({ commandId, state });
        rows.get(commandId)!.state = state;
        return { command: {} as never, event: { type: 'command.completed', commandId } as never };
      },
      getCommand: (id: string) => ({ id, ...rows.get(id)! }) as never,
      createBackgroundActivity: ({ id }: { id: string }) => {
        backgroundActivities.push(id);
        return {} as never;
      },
      transitionBackgroundActivity: () => ({}) as never,
      completeBackgroundActivity: () => ({}) as never,
    },
    publish,
    workerFor: (_turnId: string, callId: string) =>
      workerCall(callId) ? { workerId: 'agent-1', roots: [] } : undefined,
  } as unknown as CommandToolBoundary;
  return { boundary, rows, completions, backgroundActivities, publish };
}

const owner = {
  taskId: 'task-worker-wait-bound',
  turnId: 'turn-worker-wait-bound',
  workspaceId: 'workspace-worker-wait-bound',
  policyEpoch: 1,
};

const succeeded = {
  executionId: 'execution',
  exitCode: 0,
  signal: null,
  canceled: false,
  termination: 'natural' as const,
  durationMs: 1,
  outputBytes: 0,
  truncated: false,
};

/**
 * A broker with the managed `exec_command` for a Worker marked for desktop control, over `runner`,
 * whose wait for the Worker's run is cut to `waitMs` (the bound it was asked for is recorded).
 */
async function setUp(runner: CommandRunner, waitMs: (sessions: ManagedCommandSessions) => number) {
  const workspace = await mkdtemp(join(tmpdir(), 'sprint-coder-worker-wait-'));
  roots.push(workspace);
  const registry = new ToolRegistry();
  registry.register(MANAGED_EXEC_COMMAND_TOOL);
  const harness = createBoundary(workspace, (callId) => callId.startsWith('worker:'));
  const sessions = new ManagedCommandSessions(runner);
  const asked: number[] = [];
  const waitFor = sessions.waitFor.bind(sessions);
  vi.spyOn(sessions, 'waitFor').mockImplementation(async (sessionId, sessionOwner, timeoutMs) => {
    asked.push(timeoutMs);
    return waitFor(sessionId, sessionOwner, waitMs(sessions));
  });
  const authorize = vi.fn(() => ({
    decision: 'allow' as const,
    reason: 'test',
    beforeExecute: () => true,
    approvalDecision: 'allow_once' as const,
  }));
  const broker = new ToolBroker(registry, () => 1, authorize);
  registerCommandRunnerTool(
    broker,
    runner,
    harness.boundary,
    MANAGED_EXEC_COMMAND_TOOL,
    sessions,
    50,
  );
  broker.startTurn(owner, 'codex');
  vi.spyOn(desktopControlModule, 'isDesktopControlExecutable').mockReturnValue(true);
  configureDesktopControlTeamCursors(true);
  markDesktopControlWorker(owner.taskId, 'agent-1', 'Checker');
  const dispatch = (callId: string, argv: string[], signal?: AbortSignal) =>
    broker.dispatch({
      ...owner,
      callId,
      providerName: 'exec_command',
      input: { executable: process.execPath, argv, purpose: 'worker wait bound' },
      ...(signal === undefined ? {} : { signal }),
    });
  return { ...harness, workspace, sessions, asked, authorize, broker, dispatch };
}

/** A runner whose desktop-control `click` runs until it is stopped; Main's own runs succeed. */
function hangingRunner(onStop: (options: RunOptions) => Promise<unknown>) {
  const runner = new CommandRunner({ sandboxed: true });
  const clicks: RunOptions[] = [];
  vi.spyOn(runner, 'run').mockImplementation(async (spec, options = {}) => {
    options.beforeSpawn?.();
    if (spec.argv[0] !== 'click') {
      const text =
        spec.argv[1] === 'start' ? JSON.stringify({ ok: true, data: { session_id: 'run-1' } }) : '';
      await options.onBatch?.([{ seq: 0, stream: 'stdout', text, byteLength: text.length }]);
      return succeeded;
    }
    clicks.push(options);
    options.onStarted?.({
      executionId: 'execution',
      pid: 1,
      startedAt: Date.now(),
      processStartIdentity: 'identity',
      executionImageDigest: 'a'.repeat(64),
      executionImageIdentity: 'identity',
    });
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted) resolve();
      else options.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    return onStop(options) as never;
  });
  return { runner, clicks };
}

describe('the bound on a Team Worker’s desktop-control run', () => {
  it('stops a run past its bound, waits for it to end, and reports it as not known to have landed', async () => {
    let ended = false;
    const { runner, clicks } = hangingRunner(async () => {
      // The runner ends the run's process tree before it settles.
      await new Promise((resolve) => setTimeout(resolve, 20));
      ended = true;
      return { ...succeeded, exitCode: null, canceled: true, termination: 'forced' };
    });
    const { dispatch, asked, rows, completions, sessions, backgroundActivities } = await setUp(
      runner,
      () => 30,
    );

    const outcome = await dispatch('worker:1', ['click', '@s1:e1', '--timeout-ms', '90000']).then(
      () => 'resolved',
      (error: unknown) => {
        // Settled only once the run itself has ended.
        expect(ended).toBe(true);
        return (error as Error).message;
      },
    );

    expect(outcome).toContain('105 秒以内に終わらなかったため、止めた');
    expect(asked).toEqual([105_000]);
    expect(clicks).toHaveLength(1);
    expect(clicks[0]!.signal?.aborted).toBe(true);
    const click = completions.filter(({ commandId }) => rows.get(commandId) !== undefined).at(-1)!;
    expect(click.state).toBe('canceled');
    expect(completions.filter(({ commandId }) => commandId === click.commandId)).toHaveLength(1);
    // Nothing of it is left running, and it never went on in the background.
    expect(sessions.hasActiveTurnSessions(owner)).toBe(false);
    expect(backgroundActivities).toEqual([]);
    await sessions.dispose();
  });

  it('keeps a run whose stop could not be confirmed as still owning its Turn', async () => {
    const { runner } = hangingRunner(async () => {
      throw new CommandRunnerError('PROCESS_TREE_TERMINATION_FAILED', 'a process remains');
    });
    const { dispatch, rows, completions, sessions } = await setUp(runner, () => 30);

    await expect(dispatch('worker:1', ['click', '@s1:e1'])).rejects.toThrow(
      '60 秒以内に終わらなかったため、止めた',
    );

    const click = completions.at(-1)!;
    expect(click.state).toBe('failed');
    expect(rows.get(click.commandId)!.state).toBe('failed');
    // The Turn cannot end as if the run had stopped, nor hand its Workspace on.
    expect(sessions.hasActiveTurnSessions(owner)).toBe(true);
    await expect(sessions.terminateTurn(owner)).rejects.toThrow('could not be confirmed');
    await sessions.dispose();
  });

  it.each(['the call’s signal', 'the Turn’s own stop'] as const)(
    'gives one result when %s cancels the run as its bound is reached',
    async (via) => {
      const { runner, clicks } = hangingRunner(async (options) => ({
        ...succeeded,
        exitCode: null,
        canceled: true,
        termination: options.signal?.aborted === true ? 'forced' : 'natural',
      }));
      const turn = new AbortController();
      let sessionsRef: ManagedCommandSessions | undefined;
      const harness = await setUp(runner, (sessions) => {
        sessionsRef = sessions;
        // The Turn is canceled at the moment the bound is reached.
        if (via === 'the call’s signal') turn.abort(new Error('Turn canceled'));
        else void sessions.terminateTurn(owner).catch(() => undefined);
        return 0;
      });

      const settled: string[] = [];
      await harness.dispatch('worker:1', ['click', '@s1:e1'], turn.signal).then(
        () => settled.push('resolved'),
        () => settled.push('rejected'),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(settled).toHaveLength(1);
      expect(clicks).toHaveLength(1);
      const commandId = harness.completions.at(-1)!.commandId;
      expect(harness.completions.filter((entry) => entry.commandId === commandId)).toEqual([
        { commandId, state: 'canceled' },
      ]);
      expect(
        harness.publish.mock.calls.filter(
          ([event]) =>
            (event as { type?: string; commandId?: string }).type === 'command.completed' &&
            (event as { commandId?: string }).commandId === commandId,
        ),
      ).toHaveLength(1);
      expect(harness.backgroundActivities).toEqual([]);
      expect(sessionsRef!.hasActiveTurnSessions(owner)).toBe(false);
      await sessionsRef!.dispose();
    },
  );

  it('refuses before any card a Worker run that asks to wait longer than the bound leaves room for', async () => {
    const { runner } = hangingRunner(async () => succeeded);
    const run = vi.mocked(runner.run);
    const { dispatch, authorize, sessions } = await setUp(runner, () => 30);

    for (const argv of [
      ['click', '@s1:e1', '--timeout-ms', '285001'],
      ['wait', '--window', 'x', '--timeout=400000'],
      ['launch', 'calc', '--timeout', '600000'],
      [
        'batch',
        JSON.stringify([{ command: 'wait', args: { event: 'window-opened', timeout: 300000 } }]),
      ],
      ['batch', '--timeout-ms', '86400000', JSON.stringify([{ command: 'snapshot', args: {} }])],
    ])
      await expect(dispatch(`worker:${argv.join(' ')}`, argv)).rejects.toThrow(
        'デスクトップ操作が待てるのは 285 秒まで',
      );
    expect(authorize).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();

    // The bound itself is still allowed, and the Leader's runs are not bound at all.
    expect(desktopControlWorkerWaitRefusal(['click', '@s1:e1', '--timeout-ms', '285000'])).toBe(
      null,
    );
    expect(desktopControlWorkerWaitMs(['click', '@s1:e1', '--timeout-ms', '285000'])).toBe(300_000);
    await dispatch('leader:1', ['wait', '--window', 'x', '--timeout', '400000']).catch(
      () => undefined,
    );
    expect(authorize).toHaveBeenCalledOnce();
    await sessions.dispose();
  });

  // Not on macOS: there the runner refuses to start a mutable executable such as the test's Node,
  // and desktop control runs on Windows only. Windows and Linux run it.
  it.skipIf(process.platform === 'darwin')(
    'leaves no process of a real run behind once its bound is reached',
    async () => {
      // Unsandboxed, so this runs on both: a Worker run that only prints the executable's status
      // (it needs no session), here a script that starts a child of its own and never ends.
      const runner = new CommandRunner({ sandboxed: false, cancelGraceMs: 30 });
      let pidFile = '';
      const { dispatch, workspace, completions, sessions } = await setUp(runner, () => {
        return 1;
      });
      pidFile = join(workspace, 'pids.json');
      await writeFile(
        join(workspace, 'status'),
        [
          "const { spawn } = require('node:child_process');",
          "const { writeFileSync } = require('node:fs');",
          "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
          `writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ parent: process.pid, child: child.pid }));`,
          'setInterval(() => {}, 1000);',
        ].join('\n'),
      );
      // The bound is reached only once both processes are up.
      const waitFor = sessions.waitFor;
      vi.mocked(waitFor).mockImplementationOnce(async (sessionId, sessionOwner) => {
        const pids = await readPidsWhenReady(pidFile);
        spawnedPids.push(pids.parent, pids.child);
        return ManagedCommandSessions.prototype.waitFor.call(sessions, sessionId, sessionOwner, 1);
      });

      await expect(dispatch('worker:1', ['status'])).rejects.toThrow(
        '60 秒以内に終わらなかったため、止めた',
      );

      const { parent, child } = JSON.parse(await readFile(pidFile, 'utf8')) as {
        parent: number;
        child: number;
      };
      await expectProcessDead(parent);
      await expectProcessDead(child);
      expect(completions.at(-1)!.state).toBe('canceled');
      expect(sessions.hasActiveTurnSessions(owner)).toBe(false);
      await sessions.dispose();
    },
    20_000,
  );
});

async function readPidsWhenReady(path: string): Promise<{ parent: number; child: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const pids = JSON.parse(await readFile(path, 'utf8')) as { parent: number; child: number };
      if (pids.parent > 0 && pids.child > 0) return pids;
    } catch {
      // Not written yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('The run did not publish its process ids');
}

async function expectProcessDead(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } catch {
      return;
    }
  }
  throw new Error(`Process ${pid} survived the stop at the bound`);
}

function killProcessIfAlive(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}
