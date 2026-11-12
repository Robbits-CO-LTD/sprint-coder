import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolBroker, type ManagedToolLifecycleEvent } from './tool-broker';
import { ToolRegistry, type Capability } from '@sprint-coder/domain';
import {
  COMMAND_RUNNER_TOOL,
  MANAGED_EXEC_COMMAND_TOOL,
  POLL_COMMAND_TOOL,
  TERMINATE_COMMAND_TOOL,
  WRITE_STDIN_TOOL,
  registerCommandRunnerTool,
  registerManagedCommandControlTools,
  type CommandToolBoundary,
} from './default-tools';
import { MANAGED_STDIN_MAX_CHARACTERS } from './managed-command-stdin';
import { CommandRunner, CommandRunnerError, type CommandResult } from './command-runner';
import * as commandRunnerModule from './command-runner';
import * as desktopControlModule from './desktop-control';
import {
  configureDesktopControlTeamCursors,
  endDesktopControlSessions,
  markDesktopControlWorker,
  resetDesktopControlSessions,
} from './desktop-control-session';
import { ManagedCommandSessions } from './managed-command-sessions';
import { probeSandboxRunner } from './sandbox-runner';
import { ProviderWorkspaceTools } from './provider-workspace-tools';
import { getTrustedWindowsSystemDirectory } from './prepared-execution-image';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function createCommandBoundary(workspace: string) {
  const commandRows = new Map<
    string,
    {
      state: string;
      outputBytes: number;
      pid: number | null;
      startedAt: string | null;
      finishedAt: string | null;
    }
  >();
  const backgroundTransitions: string[] = [];
  const backgroundCompletions: Parameters<
    CommandToolBoundary['persistence']['completeBackgroundActivity']
  >[0][] = [];
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
        const row = {
          state: 'prepared',
          outputBytes: 0,
          pid: null,
          startedAt: null,
          finishedAt: null,
        };
        commandRows.set(input.id, row);
        return { id: input.id, ...row } as never;
      },
      beginCommand: (id: string) => {
        commandRows.get(id)!.state = 'starting';
        return { id, ...commandRows.get(id)! } as never;
      },
      startCommand: vi.fn(
        ({
          commandId,
          pid,
          startedAt,
        }: Parameters<CommandToolBoundary['persistence']['startCommand']>[0]) => {
          const row = commandRows.get(commandId)!;
          row.state = 'running';
          row.pid = pid;
          row.startedAt = startedAt;
          return { command: {} as never, event: {} as never };
        },
      ),
      appendCommandOutput: () => ({}) as never,
      appendCommandOutputBatch: ({
        commandId,
        chunks,
      }: {
        commandId: string;
        chunks: readonly { byteLength: number }[];
      }) => {
        commandRows.get(commandId)!.outputBytes += chunks.reduce(
          (sum, chunk) => sum + chunk.byteLength,
          0,
        );
        return [];
      },
      completeCommand: vi.fn(
        ({
          commandId,
          state,
          finishedAt,
        }: Parameters<CommandToolBoundary['persistence']['completeCommand']>[0]) => {
          const row = commandRows.get(commandId)!;
          row.state = state;
          row.finishedAt = finishedAt;
          return { command: {} as never, event: { type: 'command.completed' } as never };
        },
      ),
      getCommand: (id: string) => ({ id, ...commandRows.get(id)! }) as never,
      createBackgroundActivity: () => ({}) as never,
      transitionBackgroundActivity: (_id: string, state: string) => {
        backgroundTransitions.push(state);
        return {} as never;
      },
      completeBackgroundActivity: vi.fn(
        (
          input: Parameters<CommandToolBoundary['persistence']['completeBackgroundActivity']>[0],
        ) => {
          backgroundCompletions.push(input);
          backgroundTransitions.push(input.outcome);
          return {} as never;
        },
      ),
    },
    publish,
  } as unknown as CommandToolBoundary;
  return { boundary, commandRows, backgroundTransitions, backgroundCompletions, publish };
}

describe('managed command policy changes (issue #885)', () => {
  it('executes a real command with output and exit status after changing policy during the Turn', async ({
    skip,
  }) => {
    const sandbox = await probeSandboxRunner();
    if (
      process.platform === 'linux' &&
      sandbox.reason === 'bubblewrap_landlock_seccomp_probe_failed'
    )
      skip('Linux host does not support the sandbox filesystem boundary probe');
    expect(sandbox.available).toBe(true);
    const workspace = await mkdtemp(join(tmpdir(), 'sprint-coder-policy-command-'));
    roots.push(workspace);
    const { boundary, commandRows } = createCommandBoundary(workspace);
    let epoch = 1;
    const authorizedEpochs: number[] = [];
    const tools = new ProviderWorkspaceTools({
      workspaceFor: () => boundary.persistence.readTurnWorkspaceSet('turn-policy-command'),
      rootIdentityFor: () => undefined,
      policyEpochFor: () => epoch,
      authorizer: ({ context }) => {
        authorizedEpochs.push(context.policyEpoch);
        return { decision: 'allow', reason: 'test', beforeExecute: () => true };
      },
      command: boundary,
    });
    tools.setCommandSandboxAvailable(true);
    const owner = {
      taskId: 'task-policy-command',
      turnId: 'turn-policy-command',
      workspaceId: 'a'.repeat(64),
      policyEpoch: 1,
    };
    tools.startTurn(owner, 'codex');
    const call = (callId: string) =>
      tools.broker.dispatch({
        ...owner,
        callId,
        providerName: 'exec_command',
        input: {
          executable:
            process.platform === 'win32'
              ? join(getTrustedWindowsSystemDirectory(), 'cmd.exe')
              : process.platform === 'linux'
                ? '/bin/sh'
                : '/bin/echo',
          argv:
            process.platform === 'win32'
              ? ['/d', '/s', '/c', 'echo policy-command-ok']
              : process.platform === 'linux'
                ? ['-c', "printf 'policy-command-ok\\n'"]
                : ['policy-command-ok'],
          purpose: 'verify command execution after a policy change',
        },
      });
    try {
      await expect(call('before-change')).resolves.toMatchObject({
        exitCode: 0,
        stdout: expect.stringContaining('policy-command-ok'),
      });
      epoch = 2;
      await tools.policyEpochChanged(owner.taskId);
      await expect(call('after-change')).resolves.toMatchObject({
        exitCode: 0,
        stdout: expect.stringContaining('policy-command-ok'),
      });
      expect(authorizedEpochs).toEqual([1, 2]);
      expect([...commandRows.values()].map(({ state }) => state)).toEqual(['exited', 'exited']);
    } finally {
      await tools.dispose();
    }
  });
});

describe('managed command root selection (issue #840)', () => {
  it('runs in the secondary root when cwd is an absolute path inside it and rootId is omitted', async () => {
    const primary = await mkdtemp(join(tmpdir(), 'sprint-coder-command-root-a-'));
    const secondary = await mkdtemp(join(tmpdir(), 'sprint-coder-command-root-b-'));
    roots.push(primary, secondary);
    const registry = new ToolRegistry();
    registry.register(MANAGED_EXEC_COMMAND_TOOL);
    const { boundary } = createCommandBoundary(primary);
    const single = boundary.persistence.readTurnWorkspaceSet('turn')!;
    boundary.persistence.readTurnWorkspaceSet = () => ({
      ...single,
      roots: [
        single.roots[0]!,
        {
          rootId: 'root-b',
          path: secondary,
          label: 'b',
          role: 'secondary',
          status: 'available',
        },
      ],
    });
    const runner = new CommandRunner();
    const sessions = new ManagedCommandSessions(runner);
    const prepare = vi
      .spyOn(commandRunnerModule, 'prepareExecutionSpec')
      .mockRejectedValueOnce(new Error('stop after root selection'));
    const broker = new ToolBroker(
      registry,
      () => 1,
      () => ({ decision: 'allow', reason: 'test' }),
    );
    registerCommandRunnerTool(broker, runner, boundary, MANAGED_EXEC_COMMAND_TOOL, sessions);
    const owner = {
      taskId: 'task-command-root',
      turnId: 'turn-command-root',
      workspaceId: 'workspace-command-root',
      policyEpoch: 1,
    };
    broker.startTurn(owner, 'grok');
    try {
      await expect(
        broker.dispatch({
          ...owner,
          callId: 'exec-secondary',
          providerName: 'exec_command',
          input: {
            executable: process.execPath,
            argv: ['-e', ''],
            cwd: secondary,
            purpose: 'secondary root cwd',
          },
        }),
      ).rejects.toThrow('stop after root selection');
      expect(prepare).toHaveBeenCalledWith(
        expect.objectContaining({ rootId: 'root-b', workspacePath: secondary, cwd: secondary }),
      );
    } finally {
      prepare.mockRestore();
      await sessions.dispose();
    }
  });
});

describe('desktop control Workspace roots', () => {
  it('hands the Turn roots to the runner only for desktop control allowed on its card or touching no other app', async () => {
    const primary = await mkdtemp(join(tmpdir(), 'sprint-coder-desktop-roots-a-'));
    const secondary = await mkdtemp(join(tmpdir(), 'sprint-coder-desktop-roots-b-'));
    roots.push(primary, secondary);
    const registry = new ToolRegistry();
    registry.register(MANAGED_EXEC_COMMAND_TOOL);
    registry.register(COMMAND_RUNNER_TOOL);
    const { boundary } = createCommandBoundary(primary);
    const single = boundary.persistence.readTurnWorkspaceSet('turn')!;
    boundary.persistence.readTurnWorkspaceSet = () => ({
      ...single,
      roots: [
        single.roots[0]!,
        { rootId: 'root-b', path: secondary, label: 'b', role: 'secondary', status: 'available' },
      ],
    });
    const result: CommandResult = {
      executionId: 'execution',
      exitCode: 0,
      signal: null,
      canceled: false,
      termination: 'natural',
      durationMs: 1,
      outputBytes: 0,
      truncated: false,
    };
    const managedRunner = new CommandRunner({ sandboxed: true });
    const directRunner = new CommandRunner({ sandboxed: true });
    const managedRun = vi.spyOn(managedRunner, 'run').mockResolvedValue(result);
    const directRun = vi.spyOn(directRunner, 'run').mockResolvedValue(result);
    const sessions = new ManagedCommandSessions(managedRunner);
    // What the person chose on the card; `undefined` is a preset or policy allow with no card.
    let approvalDecision: 'allow_once' | 'allow_task' | undefined = 'allow_once';
    const broker = new ToolBroker(
      registry,
      () => 1,
      () => ({
        decision: 'allow',
        reason: 'test',
        beforeExecute: () => true,
        ...(approvalDecision === undefined ? {} : { approvalDecision }),
      }),
    );
    registerCommandRunnerTool(broker, managedRunner, boundary, MANAGED_EXEC_COMMAND_TOOL, sessions);
    registerCommandRunnerTool(broker, directRunner, boundary, COMMAND_RUNNER_TOOL);
    const owner = {
      taskId: 'task-desktop-roots',
      turnId: 'turn-desktop-roots',
      workspaceId: 'workspace-desktop-roots',
      policyEpoch: 1,
    };
    broker.startTurn(owner, 'grok');
    let input = { executable: process.execPath, argv: ['list-windows'], purpose: 'desktop roots' };
    const expected = expect.objectContaining({
      desktopControlWorkspaceRoots: [primary, secondary],
    });
    const dispatchAll = async (suffix: string) => {
      for (const [callId, providerName, background] of [
        ['exec-foreground', 'exec_command', false],
        ['exec-background', 'exec_command', true],
        ['run-command', 'run_command', false],
      ] as const)
        await broker.dispatch({
          ...owner,
          callId: `${callId}-${suffix}`,
          providerName,
          input: { ...input, ...(background ? { background } : {}) },
        });
      await vi.waitFor(() => expect(managedRun).toHaveBeenCalledTimes(2));
    };
    // Prepared as the shipped desktop control (by its sealed bytes); the runner is mocked here.
    const desktop = vi
      .spyOn(desktopControlModule, 'isDesktopControlExecutable')
      .mockReturnValue(true);
    try {
      await dispatchAll('once');
      expect(desktop).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringMatching(/^[a-f0-9]{64}$/u),
      );
      expect(managedRun.mock.calls.map(([, options]) => options)).toEqual([expected, expected]);
      expect(directRun).toHaveBeenCalledExactlyOnceWith(expect.anything(), expected);

      approvalDecision = 'allow_task';
      managedRun.mockClear();
      directRun.mockClear();
      await dispatchAll('task');
      expect(directRun).toHaveBeenCalledExactlyOnceWith(expect.anything(), expected);

      // A preset or policy allow never lets a command out of the sandbox.
      approvalDecision = undefined;
      managedRun.mockClear();
      directRun.mockClear();
      await dispatchAll('preset');
      for (const [, options] of [...managedRun.mock.calls, ...directRun.mock.calls])
        expect(options).not.toHaveProperty('desktopControlWorkspaceRoots');

      // A run that only prints the guides or the status needs no card, and runs outside the
      // sandbox with the roots, judged again on the sealed argv.
      for (const argv of [['status'], ['skills', 'get', 'desktop']]) {
        input = { ...input, argv };
        managedRun.mockClear();
        directRun.mockClear();
        await dispatchAll(`inert-${argv.join('-')}`);
        expect(managedRun.mock.calls.map(([, options]) => options)).toEqual([expected, expected]);
        expect(directRun).toHaveBeenCalledExactlyOnceWith(expect.anything(), expected);
      }

      // Any other command never gets the roots, even when the person allowed it on its card, or
      // when it has the same arguments as a desktop-control status check.
      desktop.mockReturnValue(false);
      for (const decision of ['allow_once', 'allow_task', undefined] as const) {
        approvalDecision = decision;
        managedRun.mockClear();
        directRun.mockClear();
        await dispatchAll(`ordinary-${decision ?? 'preset'}`);
        expect(directRun).toHaveBeenCalledOnce();
        for (const [, options] of [...managedRun.mock.calls, ...directRun.mock.calls])
          expect(options).not.toHaveProperty('desktopControlWorkspaceRoots');
      }
    } finally {
      desktop.mockRestore();
      await broker.dispose();
      await sessions.dispose();
      managedRun.mockRestore();
      directRun.mockRestore();
    }
  });

  it('seals a launch by name with the Start menu path before the card, and runs that path', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'sprint-coder-desktop-launch-name-'));
    roots.push(workspace);
    const registry = new ToolRegistry();
    registry.register(COMMAND_RUNNER_TOOL);
    const { boundary } = createCommandBoundary(workspace);
    const result: CommandResult = {
      executionId: 'execution',
      exitCode: 0,
      signal: null,
      canceled: false,
      termination: 'natural',
      durationMs: 1,
      outputBytes: 0,
      truncated: false,
    };
    const runner = new CommandRunner({ sandboxed: true });
    const run = vi.spyOn(runner, 'run').mockResolvedValue(result);
    // What the card is raised for: the input the authorizer sees.
    const carded: unknown[] = [];
    const broker = new ToolBroker(
      registry,
      () => 1,
      (request) => {
        carded.push(request.input);
        return {
          decision: 'allow',
          reason: 'test',
          beforeExecute: () => true,
          approvalDecision: 'allow_once',
        };
      },
    );
    registerCommandRunnerTool(broker, runner, boundary, COMMAND_RUNNER_TOOL);
    const owner = {
      taskId: 'task-launch-name',
      turnId: 'turn-launch-name',
      workspaceId: 'workspace-launch-name',
      policyEpoch: 1,
    };
    broker.startTurn(owner, 'grok');
    // An absolute path outside the Workspace as this OS reads one, since the replaced arguments
    // are judged again with the checks of an absolute path.
    const path =
      process.platform === 'win32'
        ? 'C:\\Program Files\\RabbitMail\\rabbitmail-desktop.exe'
        : '/opt/RabbitMail/rabbitmail-desktop';
    const desktop = vi
      .spyOn(desktopControlModule, 'isDesktopControlExecutable')
      .mockReturnValue(true);
    const byName = vi
      .spyOn(desktopControlModule, 'desktopControlLaunchByName')
      .mockImplementation((argv) =>
        argv[1] === 'RabbitMail'
          ? { argv: ['launch', path] }
          : argv[1] === 'Missing'
            ? { refusal: 'デスクトップ操作の実行を拒否した: 見つからない。' }
            : null,
      );
    try {
      await broker.dispatch({
        ...owner,
        callId: 'launch-name',
        providerName: 'run_command',
        input: { executable: process.execPath, argv: ['launch', 'RabbitMail'], purpose: 'open' },
      });
      expect(carded).toEqual([expect.objectContaining({ argv: ['launch', path] })]);
      expect(run).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ argv: ['launch', path] }),
        expect.anything(),
      );
      expect(run.mock.calls[0]![0]).toBe(carded[0]);

      // A name the Start menu does not settle is refused before any card.
      await expect(
        broker.dispatch({
          ...owner,
          callId: 'launch-missing',
          providerName: 'run_command',
          input: { executable: process.execPath, argv: ['launch', 'Missing'], purpose: 'open' },
        }),
      ).rejects.toThrow('見つからない');
      expect(carded).toHaveLength(1);
    } finally {
      desktop.mockRestore();
      byName.mockRestore();
      run.mockRestore();
      await broker.dispose();
    }
  });

  it.skipIf(
    process.platform !== 'win32' || desktopControlModule.resolveDesktopControlCommand() === null,
  )(
    'runs the shipped guides and status outside the sandbox without a decision of the person',
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), 'sprint-coder-desktop-inert-'));
      roots.push(workspace);
      const registry = new ToolRegistry();
      registry.register(COMMAND_RUNNER_TOOL);
      const { boundary } = createCommandBoundary(workspace);
      // What the ApprovalCoordinator returns for such a run: an allow with no card behind it.
      const broker = new ToolBroker(
        registry,
        () => 1,
        () => ({ decision: 'allow', reason: 'test', beforeExecute: () => true }),
      );
      registerCommandRunnerTool(
        broker,
        new CommandRunner({ sandboxed: true }),
        boundary,
        COMMAND_RUNNER_TOOL,
      );
      const owner = {
        taskId: 'task-desktop-inert',
        turnId: 'turn-desktop-inert',
        workspaceId: 'workspace-desktop-inert',
        policyEpoch: 1,
      };
      broker.startTurn(owner, 'grok');
      const executable = desktopControlModule.resolveDesktopControlCommand()!;
      const dispatch = (callId: string, argv: string[]) =>
        broker.dispatch({
          ...owner,
          callId,
          providerName: 'run_command',
          input: { executable, argv, purpose: 'desktop guides' },
        }) as Promise<{ exitCode: number; stdout: string }>;
      try {
        // Both guides at once, as the agent asks for them at the start of a Turn, and the status,
        // which fails inside the sandbox (no home folder there).
        const results = await Promise.all([
          dispatch('guide-desktop', ['skills', 'get', 'desktop']),
          dispatch('guide-platform', ['skills', 'get', 'platform']),
          dispatch('status', ['status']),
        ]);
        for (const result of results) {
          expect(result.exitCode).toBe(0);
          expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });
        }
      } finally {
        await broker.dispose();
      }
    },
    60_000,
  );

  it('with the Task’s cursors on, starts the Task’s session once and runs the Leader in it', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'sprint-coder-desktop-session-'));
    roots.push(workspace);
    const registry = new ToolRegistry();
    registry.register(COMMAND_RUNNER_TOOL);
    const { boundary, commandRows } = createCommandBoundary(workspace);
    const runner = new CommandRunner({ sandboxed: true });
    let startExit = 0;
    const run = vi.spyOn(runner, 'run').mockImplementation(async (spec, options = {}) => {
      if (spec.argv[0] === 'session' && spec.argv[1] === 'start')
        await options.onBatch?.([
          {
            seq: 0,
            stream: 'stdout',
            text: JSON.stringify({ ok: true, data: { session_id: 'run-77' } }),
            byteLength: 1,
          },
        ]);
      return {
        executionId: 'execution',
        exitCode: spec.argv[1] === 'start' ? startExit : 0,
        signal: null,
        canceled: false,
        termination: 'natural',
        durationMs: 1,
        outputBytes: 0,
        truncated: false,
      };
    });
    const authorize = vi.fn(() => ({
      decision: 'allow' as const,
      reason: 'test',
      beforeExecute: () => true,
      approvalDecision: 'allow_once' as const,
    }));
    const broker = new ToolBroker(registry, () => 1, authorize);
    registerCommandRunnerTool(broker, runner, boundary, COMMAND_RUNNER_TOOL);
    const owner = {
      taskId: 'task-desktop-session',
      turnId: 'turn-desktop-session',
      workspaceId: 'workspace-desktop-session',
      policyEpoch: 1,
    };
    broker.startTurn(owner, 'grok');
    const dispatch = (callId: string, argv: string[]) =>
      broker.dispatch({
        ...owner,
        callId,
        providerName: 'run_command',
        input: { executable: process.execPath, argv, purpose: 'desktop session' },
      });
    const calls = () =>
      run.mock.calls.map(([spec, options]) => ({
        argv: spec.argv,
        session: options?.desktopControlSession,
        roots: options?.desktopControlWorkspaceRoots,
      }));
    const desktop = vi
      .spyOn(desktopControlModule, 'isDesktopControlExecutable')
      .mockReturnValue(true);
    const leader = { id: 'run-77', agentId: 'leader' };
    try {
      // Off: the runs are exactly as before, `--session` included, and Main runs nothing itself.
      await dispatch('off', ['--session', 'mine', 'list-windows']);
      expect(calls()).toEqual([
        { argv: ['--session', 'mine', 'list-windows'], session: undefined, roots: [workspace] },
      ]);
      run.mockClear();

      configureDesktopControlTeamCursors(true);
      // A run whose session cannot be started does not start, and its command is failed.
      startExit = 1;
      await expect(dispatch('no-session', ['list-windows'])).rejects.toThrow('実行しなかった');
      expect(calls().map(({ argv }) => argv[0])).toEqual(['session', 'session']);
      expect([...commandRows.values()].at(-1)?.state).toBe('failed');
      run.mockClear();
      startExit = 0;

      await dispatch('first', ['list-windows']);
      await dispatch('second', ['click', '@s1:e1']);
      expect(calls()).toEqual([
        {
          argv: [
            'session',
            'start',
            '--name',
            'sprint-coder',
            '--cursor',
            '--multi-agent',
            '--no-trace',
          ],
          session: undefined,
          roots: [workspace],
        },
        {
          argv: ['cursor-overlay', 'enable', '--label', 'Leader', '--accent', '#2563EB'],
          session: leader,
          roots: [workspace],
        },
        { argv: ['list-windows'], session: leader, roots: [workspace] },
        { argv: ['click', '@s1:e1'], session: leader, roots: [workspace] },
      ]);
      // A run that only prints stays out of the session.
      run.mockClear();
      await dispatch('inert', ['status']);
      expect(calls()).toEqual([{ argv: ['status'], session: undefined, roots: [workspace] }]);

      // The agent may not choose a session or agent id, nor manage sessions or cursors itself.
      run.mockClear();
      authorize.mockClear();
      for (const argv of [
        ['click', '@s1:e1', '--session', 'run-77'],
        ['--agent-id', 'w1', 'click', '@s1:e1'],
        ['session', 'end'],
        ['cursor-overlay', 'disable'],
      ])
        await expect(dispatch(`refused-${argv.join('-')}`, argv)).rejects.toThrow(
          'デスクトップ操作の実行を拒否した',
        );
      expect(authorize).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();

      // Quitting ends the Task's session through the same runner.
      await endDesktopControlSessions();
      expect(calls()).toEqual([
        { argv: ['session', 'end', 'run-77'], session: undefined, roots: [workspace] },
      ]);
    } finally {
      desktop.mockRestore();
      resetDesktopControlSessions();
      run.mockRestore();
      await broker.dispose();
    }
  });

  it('runs only desktop control for a Team Worker the Leader marked, as that Worker’s cursor', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'sprint-coder-desktop-worker-'));
    roots.push(workspace);
    const registry = new ToolRegistry();
    registry.register(COMMAND_RUNNER_TOOL);
    const { boundary } = createCommandBoundary(workspace);
    // Main's binding of each call: these call ids are a Worker's, any other the Leader's.
    const workers = new Map([
      ['marked', 'agent-1'],
      ['unmarked', 'agent-2'],
      ['unbound', ''],
    ]);
    const withWorkers = {
      ...boundary,
      workerFor: (_turnId: string, callId: string) => {
        const workerId = workers.get(callId.split(':')[0]!);
        return workerId === undefined ? undefined : { workerId };
      },
    } as CommandToolBoundary;
    const runner = new CommandRunner({ sandboxed: true });
    const run = vi.spyOn(runner, 'run').mockImplementation(async (spec, options = {}) => {
      if (spec.argv[1] === 'start')
        await options.onBatch?.([
          {
            seq: 0,
            stream: 'stdout',
            text: JSON.stringify({ ok: true, data: { session_id: 'run-9' } }),
            byteLength: 1,
          },
        ]);
      return {
        executionId: 'execution',
        exitCode: 0,
        signal: null,
        canceled: false,
        termination: 'natural',
        durationMs: 1,
        outputBytes: 0,
        truncated: false,
      };
    });
    const authorize = vi.fn(() => ({
      decision: 'allow' as const,
      reason: 'test',
      beforeExecute: () => true,
      approvalDecision: 'allow_once' as const,
    }));
    const broker = new ToolBroker(registry, () => 1, authorize);
    registerCommandRunnerTool(broker, runner, withWorkers, COMMAND_RUNNER_TOOL);
    const owner = {
      taskId: 'task-desktop-worker',
      turnId: 'turn-desktop-worker',
      workspaceId: 'workspace-desktop-worker',
      policyEpoch: 1,
    };
    broker.startTurn(owner, 'grok');
    let n = 0;
    const dispatch = (who: string, argv: string[], extra: Record<string, unknown> = {}) =>
      broker.dispatch({
        ...owner,
        callId: `${who}:${(n += 1)}`,
        providerName: 'run_command',
        input: { executable: process.execPath, argv, purpose: 'desktop worker', ...extra },
      });
    const desktop = vi
      .spyOn(desktopControlModule, 'isDesktopControlExecutable')
      .mockReturnValue(true);
    try {
      configureDesktopControlTeamCursors(true);
      markDesktopControlWorker(owner.taskId, 'agent-1', 'Checker');
      await dispatch('marked', ['click', '@s1:e1']);
      await dispatch('marked', ['click', '@s1:e2']);
      await dispatch('leader', ['click', '@s1:e3']);
      expect(
        run.mock.calls.map(([spec, options]) => [
          spec.argv.join(' '),
          options?.desktopControlSession?.agentId,
        ]),
      ).toEqual([
        ['session gc --ended', undefined],
        ['session start --name sprint-coder --cursor --multi-agent --no-trace', undefined],
        ['cursor-overlay enable --label Leader --accent #2563EB', 'leader'],
        ['cursor-overlay enable --label Checker --accent #16A34A', 'agent-1'],
        ['click @s1:e1', 'agent-1'],
        ['click @s1:e2', 'agent-1'],
        ['click @s1:e3', 'leader'],
      ]);
      run.mockClear();
      authorize.mockClear();
      // Refused before any card: an unmarked or unbound Worker, a background run, a session the
      // Worker chose, and every other executable.
      for (const [who, argv, extra, reason] of [
        ['unmarked', ['click', '@s1:e1'], {}, '任されていません'],
        ['unbound', ['click', '@s1:e1'], {}, '任されていません'],
        ['marked', ['click', '@s1:e1'], { background: true }, 'background'],
        ['marked', ['--session', 'x', 'click', '@s1:e1'], {}, '--session'],
      ] as const)
        await expect(dispatch(who, [...argv], extra)).rejects.toThrow(reason);
      desktop.mockReturnValue(false);
      await expect(dispatch('marked', ['-e', '1'])).rejects.toThrow(
        'デスクトップ操作の実行ファイルだけ',
      );
      // Without the opt-in, even a marked Worker runs nothing.
      desktop.mockReturnValue(true);
      configureDesktopControlTeamCursors(false);
      await expect(dispatch('marked', ['click', '@s1:e1'])).rejects.toThrow('任されていません');
      expect(authorize).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    } finally {
      desktop.mockRestore();
      resetDesktopControlSessions();
      run.mockRestore();
      await broker.dispose();
    }
  });

  it('refuses desktop-control arguments before a command or card exists', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'sprint-coder-desktop-refusal-'));
    roots.push(workspace);
    const registry = new ToolRegistry();
    registry.register(COMMAND_RUNNER_TOOL);
    const { boundary, commandRows } = createCommandBoundary(workspace);
    const runner = new CommandRunner({ sandboxed: true });
    const run = vi.spyOn(runner, 'run');
    const authorize = vi.fn(() => ({ decision: 'allow' as const, reason: 'test' }));
    const broker = new ToolBroker(registry, () => 1, authorize);
    registerCommandRunnerTool(broker, runner, boundary, COMMAND_RUNNER_TOOL);
    const owner = {
      taskId: 'task-desktop-refusal',
      turnId: 'turn-desktop-refusal',
      workspaceId: 'workspace-desktop-refusal',
      policyEpoch: 1,
    };
    broker.startTurn(owner, 'grok');
    const desktop = vi
      .spyOn(desktopControlModule, 'isDesktopControlExecutable')
      .mockReturnValue(true);
    try {
      await expect(
        broker.dispatch({
          ...owner,
          callId: 'desktop-mcp',
          providerName: 'run_command',
          input: { executable: process.execPath, argv: ['mcp'], purpose: 'desktop refusal' },
        }),
      ).rejects.toThrow('デスクトップ操作の実行を拒否した: mcp は使えない。');
      expect(authorize).not.toHaveBeenCalled();
      expect(commandRows.size).toBe(0);
      expect(run).not.toHaveBeenCalled();
    } finally {
      desktop.mockRestore();
      await broker.dispose();
    }
  });
});

describe('managed command startup persistence', () => {
  it.each([
    { state: 'prepared', beforeSpawn: false, background: false, terminationUnconfirmed: true },
    { state: 'starting', beforeSpawn: true, background: false, terminationUnconfirmed: false },
    { state: 'background', beforeSpawn: false, background: true, terminationUnconfirmed: false },
  ])('terminalizes a rejected $state start without spawning', async (scenario) => {
    const workspace = await mkdtemp(join(tmpdir(), 'sprint-coder-managed-start-failure-'));
    roots.push(workspace);
    const registry = new ToolRegistry();
    registry.register(MANAGED_EXEC_COMMAND_TOOL);
    const { boundary, commandRows, backgroundTransitions, backgroundCompletions, publish } =
      createCommandBoundary(workspace);
    const runner = new CommandRunner();
    const sessions = new ManagedCommandSessions(runner);
    const run = vi.spyOn(runner, 'run').mockImplementation(async (_spec, options) => {
      if (scenario.beforeSpawn) options?.beforeSpawn?.();
      expect([...commandRows.values()][0]?.state).toBe(
        scenario.beforeSpawn ? 'starting' : 'prepared',
      );
      throw new CommandRunnerError(
        scenario.terminationUnconfirmed ? 'PROCESS_TREE_TERMINATION_FAILED' : 'SPAWN_FAILED',
        'synthetic startup failure',
      );
    });
    const startSession = sessions.start.bind(sessions);
    let startError: unknown;
    const start = vi.spyOn(sessions, 'start').mockImplementation(async (...args) => {
      try {
        return await startSession(...args);
      } catch (error) {
        startError = error;
        throw error;
      }
    });
    const broker = new ToolBroker(
      registry,
      () => 1,
      () => ({
        decision: 'allow',
        reason: 'test',
        beforeExecute: () => true,
      }),
    );
    registerCommandRunnerTool(broker, runner, boundary, MANAGED_EXEC_COMMAND_TOOL, sessions);
    const owner = {
      taskId: 'task-start-failure',
      turnId: 'turn-start-failure',
      workspaceId: 'workspace-start-failure',
      policyEpoch: 1,
    };
    broker.startTurn(owner, 'grok');
    try {
      const error = await broker
        .dispatch({
          ...owner,
          callId: 'exec-start-failure',
          providerName: 'exec_command',
          input: {
            executable: process.execPath,
            argv: ['-e', ''],
            purpose: 'startup persistence contract',
            background: scenario.background,
          },
        })
        .then(
          () => null,
          (failure: unknown) => failure,
        );
      expect(error).toBeInstanceOf(Error);
      expect(error).toBe(startError);
      expect(error).toHaveProperty('message', 'synthetic startup failure');
      expect(run).toHaveBeenCalledOnce();
      expect(commandRows.size).toBe(1);
      expect([...commandRows.values()][0]).toMatchObject({
        state: 'failed',
        outputBytes: 0,
        pid: null,
        startedAt: null,
        finishedAt: expect.any(String),
      });
      expect(Number.isFinite(Date.parse([...commandRows.values()][0]!.finishedAt!))).toBe(true);
      expect(boundary.persistence.startCommand).not.toHaveBeenCalled();
      expect(boundary.persistence.completeCommand).toHaveBeenCalledOnce();
      expect(boundary.persistence.completeCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          state: 'failed',
          exitCode: null,
          signal: null,
          outputBytes: 0,
          truncated: false,
        }),
      );
      expect(publish).toHaveBeenCalledExactlyOnceWith({ type: 'command.completed' });
      if (scenario.background) {
        expect(backgroundTransitions).toEqual(['running', 'failed']);
        expect(backgroundCompletions).toHaveLength(1);
        expect(backgroundCompletions[0]).toMatchObject({
          outcome: 'failed',
          outputCursor: 0,
          completedAt: expect.any(String),
        });
        expect(JSON.parse(backgroundCompletions[0]!.payload)).toEqual({
          sessionId: expect.any(String),
          state: 'failed',
        });
      } else {
        expect(backgroundCompletions).toHaveLength(0);
      }
      expect(sessions.hasActiveTurnSessions(owner)).toBe(scenario.terminationUnconfirmed);
      expect(
        sessions.hasActiveWorkspaceSessions([{ path: workspace, rootIdentityDigest: undefined }]),
      ).toBe(scenario.terminationUnconfirmed);
      if (scenario.terminationUnconfirmed)
        await expect(sessions.terminateTurn(owner)).rejects.toThrow('could not be confirmed');
      else await expect(sessions.terminateTurn(owner)).resolves.toBeUndefined();
    } finally {
      await broker.dispose();
      start.mockRestore();
      run.mockRestore();
    }
  });
});

describe('managed background tool completion', () => {
  it.each([
    {
      scenario: 'explicit success',
      mode: 'explicit',
      outcome: 'exited',
      exitCode: 0,
      stop: 'none',
    },
    { scenario: 'auto nonzero exit', mode: 'auto', outcome: 'exited', exitCode: 7, stop: 'none' },
    {
      scenario: 'explicit failure',
      mode: 'explicit',
      outcome: 'failed',
      exitCode: 0,
      stop: 'none',
    },
    { scenario: 'auto failure', mode: 'auto', outcome: 'failed', exitCode: 0, stop: 'none' },
    { scenario: 'Turn stop', mode: 'explicit', outcome: 'canceled', exitCode: 0, stop: 'turn' },
    { scenario: 'epoch revocation', mode: 'auto', outcome: 'canceled', exitCode: 0, stop: 'task' },
    {
      scenario: 'unconfirmed stop',
      mode: 'explicit',
      outcome: 'failed',
      exitCode: 0,
      stop: 'unconfirmed',
    },
    {
      scenario: 'foreground success',
      mode: 'foreground',
      outcome: 'exited',
      exitCode: 0,
      stop: 'none',
    },
    {
      scenario: 'foreground nonzero exit',
      mode: 'foreground',
      outcome: 'exited',
      exitCode: 7,
      stop: 'none',
    },
    {
      scenario: 'auto terminal poll',
      mode: 'auto-race',
      outcome: 'failed',
      exitCode: 0,
      stop: 'none',
    },
  ])(
    'terminalizes the original background tool after its $scenario completion',
    async (scenario) => {
      const workspace = await mkdtemp(join(tmpdir(), 'sprint-coder-background-completion-'));
      roots.push(workspace);
      const registry = new ToolRegistry();
      registry.register(MANAGED_EXEC_COMMAND_TOOL);
      const { boundary, backgroundTransitions } = createCommandBoundary(workspace);
      const events: ManagedToolLifecycleEvent[] = [];
      let complete!: (result: CommandResult) => void;
      let reject!: (error: Error) => void;
      const completion = new Promise<CommandResult>((resolve, fail) => {
        complete = resolve;
        reject = fail;
      });
      const runner = new CommandRunner();
      // この契約テストは実行対象の封印後から始め、OSプロセスを起動しない。
      const prepare = vi.spyOn(commandRunnerModule, 'prepareExecutionSpec').mockResolvedValueOnce(
        Object.freeze({
          absoluteExecutable: process.execPath,
          argv: Object.freeze(['-e', '']),
          cwdIdentity: Object.freeze({ canonicalPath: workspace }),
        }) as never,
      );
      const run = vi.spyOn(runner, 'run').mockImplementation(async (_spec, options) => {
        options?.beforeSpawn?.();
        await options?.onStarted?.({
          executionId: 'synthetic-execution',
          pid: 123,
          startedAt: Date.now(),
          processStartIdentity: 'synthetic-process-identity',
          executionImageDigest: 'a'.repeat(64),
          executionImageIdentity: 'synthetic-image-identity',
        });
        options?.signal?.addEventListener(
          'abort',
          () => {
            if (scenario.stop === 'unconfirmed')
              reject(
                new CommandRunnerError(
                  'PROCESS_TREE_TERMINATION_FAILED',
                  'synthetic unconfirmed stop',
                ),
              );
            else complete(result);
          },
          { once: true },
        );
        return completion;
      });
      const sessions = new ManagedCommandSessions(runner, 1);
      const waitFor =
        scenario.mode === 'auto-race'
          ? vi.spyOn(sessions, 'waitFor').mockImplementation(async (sessionId, owner) => {
              reject(new Error('synthetic post-start failure'));
              await sessions.wait(sessionId, owner);
              return null;
            })
          : undefined;
      const broker = new ToolBroker(
        registry,
        () => 1,
        () => ({ decision: 'allow', reason: 'test' }),
        (event) => {
          if (event.state === 'succeeded' || event.state === 'failed' || event.state === 'canceled')
            expect(boundary.persistence.completeCommand).toHaveBeenCalledOnce();
          events.push(event);
        },
      );
      registerCommandRunnerTool(broker, runner, boundary, MANAGED_EXEC_COMMAND_TOOL, sessions, 1);
      const owner = {
        taskId: 'task-background-completion',
        turnId: 'turn-background-completion',
        workspaceId: 'workspace-background-completion',
        policyEpoch: 1,
      };
      broker.startTurn(owner, 'grok');
      const result: CommandResult = {
        executionId: 'synthetic-execution',
        exitCode: scenario.exitCode,
        signal: null,
        canceled: scenario.outcome === 'canceled',
        termination: scenario.outcome === 'canceled' ? 'forced' : 'natural',
        durationMs: 1,
        outputBytes: 0,
        truncated: false,
      };
      try {
        if (scenario.mode === 'foreground') complete(result);
        const output = await broker.dispatch({
          ...owner,
          callId: 'original-background-call',
          providerName: 'exec_command',
          input: {
            executable: process.execPath,
            argv: ['-e', ''],
            purpose: 'background completion contract',
            background: scenario.mode === 'explicit',
          },
        });
        if (scenario.mode === 'foreground') {
          expect(output).toMatchObject({ exitCode: scenario.exitCode });
        } else if (scenario.mode !== 'auto-race') {
          expect(output).toMatchObject({ state: 'running' });
          expect(events.at(-1)?.state).toBe('backgrounded');
          broker.finishTurn(owner.taskId, owner.turnId);
          if (scenario.stop === 'turn') await sessions.terminateTurn(owner);
          else if (scenario.stop === 'task') await sessions.terminateTask(owner.taskId);
          else if (scenario.stop === 'unconfirmed')
            await expect(sessions.terminateTurn(owner)).rejects.toThrow('could not be confirmed');
          else if (scenario.outcome === 'failed') reject(new Error('synthetic post-start failure'));
          else complete(result);
        } else expect(output).toMatchObject({ state: 'failed' });
        await vi.waitFor(() => expect(boundary.persistence.completeCommand).toHaveBeenCalledOnce());
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(backgroundTransitions).toEqual(
          scenario.mode === 'foreground'
            ? []
            : ['running', scenario.outcome === 'exited' ? 'completed' : scenario.outcome],
        );
        expect(events.map(({ state }) => state)).toEqual([
          'requested',
          'prepared',
          'awaiting_approval',
          'queued',
          'running',
          ...(['foreground', 'auto-race'].includes(scenario.mode) ? [] : ['backgrounded']),
          scenario.outcome === 'exited' ? 'succeeded' : scenario.outcome,
        ]);
        if (scenario.stop === 'unconfirmed') {
          expect(sessions.hasActiveTurnSessions(owner)).toBe(true);
          await expect(
            sessions.start({} as never, { taskId: 'another-task', turnId: 'another-turn' }),
          ).rejects.toThrow('session limit reached');
          await expect(sessions.terminateTurn(owner)).rejects.toThrow('could not be confirmed');
        } else expect(sessions.hasActiveTurnSessions(owner)).toBe(false);
      } finally {
        complete(result);
        await broker.dispose();
        prepare.mockRestore();
        run.mockRestore();
        waitFor?.mockRestore();
      }
    },
  );
});

describe.runIf(process.platform === 'darwin' || process.platform === 'linux')(
  'managed command tool contract',
  () => {
    it('executes, writes, polls, and enforces Turn ownership through one Broker', async () => {
      if (process.platform === 'linux' && !(await probeSandboxRunner()).available) return;
      const workspace = await mkdtemp(join(tmpdir(), 'sprint-coder-managed-tools-'));
      roots.push(workspace);
      const registry = new ToolRegistry();
      for (const definition of [
        MANAGED_EXEC_COMMAND_TOOL,
        POLL_COMMAND_TOOL,
        WRITE_STDIN_TOOL,
        TERMINATE_COMMAND_TOOL,
      ])
        registry.register(definition);
      const { boundary, commandRows, backgroundTransitions } = createCommandBoundary(workspace);
      const sessions = new ManagedCommandSessions();
      const broker = new ToolBroker(
        registry,
        () => 1,
        () => ({
          decision: 'allow',
          reason: 'test',
          beforeExecute: () => true,
        }),
      );
      registerCommandRunnerTool(
        broker,
        new CommandRunner({ sandboxed: true }),
        boundary,
        MANAGED_EXEC_COMMAND_TOOL,
        sessions,
        10,
      );
      registerManagedCommandControlTools(broker, sessions, boundary);
      const owner = {
        taskId: 'task-1',
        turnId: 'turn-1',
        workspaceId: 'workspace-1',
        policyEpoch: 1,
      };
      broker.startTurn(owner, 'codex');
      await expect(
        broker.dispatch({
          ...owner,
          callId: 'legacy-boolean-verification-denied',
          providerName: 'exec_command',
          input: {
            executable: '/bin/sh',
            argv: ['-c', 'exit 0'],
            purpose: 'legacy model assertion is not a verification plan',
            verification: true,
          },
        }),
      ).rejects.toThrow('input does not match');
      const started = (await broker.dispatch({
        ...owner,
        callId: 'exec-1',
        providerName: 'exec_command',
        input: {
          executable: '/bin/sh',
          argv: ['-c', 'IFS= read -r value; printf "%s\\n" "$value"'],
          purpose: 'stdin contract',
          background: true,
        },
      })) as { sessionId: string };
      await broker.dispatch({
        ...owner,
        callId: 'stdin-1',
        providerName: 'write_stdin',
        input: { sessionId: started.sessionId, chars: 'hello\n', close: true },
      });
      let snapshot: { state: string; chunks: { text: string }[] };
      do {
        await new Promise((resolve) => setTimeout(resolve, 10));
        snapshot = (await broker.dispatch({
          ...owner,
          callId: `poll-${Date.now()}`,
          providerName: 'poll_command',
          input: { sessionId: started.sessionId },
        })) as typeof snapshot;
      } while (snapshot.state === 'running');
      expect(snapshot.state).toBe('exited');
      expect(snapshot.chunks.map(({ text }) => text).join('')).toContain('hello');
      expect(() =>
        sessions.poll(started.sessionId, { taskId: 'task-2', turnId: 'turn-2' }),
      ).toThrow('owner mismatch');

      const canceled = (await broker.dispatch({
        ...owner,
        callId: 'exec-canceled',
        providerName: 'exec_command',
        input: {
          executable: '/bin/sh',
          argv: ['-c', 'while :; do sleep 1; done'],
          purpose: 'cancel persistence contract',
          background: true,
        },
      })) as { sessionId: string };
      await broker.dispatch({
        ...owner,
        callId: 'terminate-canceled',
        providerName: 'terminate_command',
        input: { sessionId: canceled.sessionId },
      });
      await expect(sessions.wait(canceled.sessionId, owner)).resolves.toMatchObject({
        state: 'canceled',
      });
      await vi.waitFor(() => expect(backgroundTransitions).toContain('canceled'));

      const autoBackgrounded = (await broker.dispatch({
        ...owner,
        callId: 'exec-auto-background',
        providerName: 'exec_command',
        input: {
          executable: '/bin/sh',
          argv: ['-c', 'sleep 0.2; printf done'],
          purpose: 'foreground promotion contract',
        },
      })) as { sessionId: string; state: string };
      expect(autoBackgrounded).toMatchObject({ state: 'running' });
      expect(autoBackgrounded.sessionId).toBeTruthy();
      await expect(sessions.wait(autoBackgrounded.sessionId, owner)).resolves.toMatchObject({
        state: 'exited',
      });

      // Providers repeat the executable as argv[0] although the tool contract forbids it (#467).
      // The call is refused before any process starts, and the provider can resend the same work.
      const commandRowsBeforeRejection = commandRows.size;
      await expect(
        broker.dispatch({
          ...owner,
          callId: 'exec-repeated-executable',
          providerName: 'exec_command',
          input: {
            executable: '/bin/sh',
            argv: ['/bin/sh', '-c', 'printf rejected'],
            purpose: 'repeated executable contract',
            background: true,
          },
        }),
      ).rejects.toMatchObject({
        name: 'CommandRunnerError',
        code: 'ARGV_REPEATS_EXECUTABLE',
        message: expect.stringContaining('resend without it'),
      });
      // Nothing was sealed: no command row, and therefore no approval card and no process.
      expect(commandRows.size).toBe(commandRowsBeforeRejection);
      // The Turn survives the rejection: the corrected call runs in the same Turn.
      const resent = (await broker.dispatch({
        ...owner,
        callId: 'exec-resent-executable',
        providerName: 'exec_command',
        input: {
          executable: '/bin/sh',
          argv: ['-c', 'printf resent'],
          purpose: 'repeated executable contract',
          background: true,
        },
      })) as { sessionId: string };
      await expect(sessions.wait(resent.sessionId, owner)).resolves.toMatchObject({
        state: 'exited',
        result: { exitCode: 0 },
      });
      const resentSnapshot = (await broker.dispatch({
        ...owner,
        callId: 'poll-resent-executable',
        providerName: 'poll_command',
        input: { sessionId: resent.sessionId },
      })) as typeof snapshot;
      expect(resentSnapshot.chunks.map(({ text }) => text).join('')).toBe('resent');
      await broker.dispose();
    });

    /**
     * Issue #473: every write to a running command's stdin is authorized like the command it
     * feeds. Polling is unchanged — it mints no new authority, so it never reaches an approval.
     */
    it('authorizes every stdin write and writes nothing when the user refuses', async () => {
      if (process.platform === 'linux' && !(await probeSandboxRunner()).available) return;
      const workspace = await mkdtemp(join(tmpdir(), 'sprint-coder-stdin-approval-'));
      roots.push(workspace);
      const registry = new ToolRegistry();
      for (const definition of [
        MANAGED_EXEC_COMMAND_TOOL,
        POLL_COMMAND_TOOL,
        WRITE_STDIN_TOOL,
        TERMINATE_COMMAND_TOOL,
      ])
        registry.register(definition);
      const { boundary } = createCommandBoundary(workspace);
      const sessions = new ManagedCommandSessions();
      const authorized: { providerName: string; capabilities: readonly Capability[] }[] = [];
      let stdinDecision: 'allow' | 'deny' = 'deny';
      const broker = new ToolBroker(
        registry,
        () => 1,
        ({ entry }) => {
          // Mirrors ApprovalCoordinator.authorizeTool: a Tool requiring no capability is allowed
          // without ever raising an approval.
          if (entry.requiredCapabilities.length === 0)
            return { decision: 'allow', reason: 'no_capability_required' };
          authorized.push({
            providerName: entry.providerName,
            capabilities: entry.requiredCapabilities,
          });
          if (entry.providerName === 'write_stdin' && stdinDecision === 'deny')
            return { decision: 'deny', reason: 'approval_deny' };
          return { decision: 'allow', reason: 'approval_allow_once', beforeExecute: () => true };
        },
      );
      registerCommandRunnerTool(
        broker,
        new CommandRunner({ sandboxed: true }),
        boundary,
        MANAGED_EXEC_COMMAND_TOOL,
        sessions,
        10,
      );
      registerManagedCommandControlTools(broker, sessions, boundary);
      const owner = {
        taskId: 'task-1',
        turnId: 'turn-1',
        workspaceId: 'workspace-1',
        policyEpoch: 1,
      };
      broker.startTurn(owner, 'codex');
      const started = (await broker.dispatch({
        ...owner,
        callId: 'exec-stdin-approval',
        providerName: 'exec_command',
        input: {
          executable: '/bin/sh',
          argv: ['-c', 'IFS= read -r value; printf "%s" "$value"'],
          purpose: 'stdin approval contract',
          background: true,
        },
      })) as { sessionId: string };

      await expect(
        broker.dispatch({
          ...owner,
          callId: 'stdin-denied',
          providerName: 'write_stdin',
          input: { sessionId: started.sessionId, chars: 'denied\n', close: true },
        }),
      ).rejects.toThrow('Tool authorization deny');
      // The refusal reaches the process as silence: it is still blocked on its own read.
      const afterDenial = (await broker.dispatch({
        ...owner,
        callId: 'poll-after-denial',
        providerName: 'poll_command',
        input: { sessionId: started.sessionId },
      })) as { state: string; chunks: { text: string }[] };
      expect(afterDenial.state).toBe('running');
      expect(afterDenial.chunks).toEqual([]);

      stdinDecision = 'allow';
      await expect(
        broker.dispatch({
          ...owner,
          callId: 'stdin-approved',
          providerName: 'write_stdin',
          input: { sessionId: started.sessionId, chars: 'approved\n', close: true },
        }),
      ).resolves.toEqual({ written: true });
      await expect(sessions.wait(started.sessionId, owner)).resolves.toMatchObject({
        state: 'exited',
      });
      const afterApproval = (await broker.dispatch({
        ...owner,
        callId: 'poll-after-approval',
        providerName: 'poll_command',
        input: { sessionId: started.sessionId },
      })) as { chunks: { text: string }[] };
      expect(afterApproval.chunks.map(({ text }) => text).join('')).toBe('approved');

      expect(authorized.map(({ providerName }) => providerName)).toEqual([
        'exec_command',
        'write_stdin',
        'write_stdin',
      ]);
      expect(authorized.every(({ capabilities }) => capabilities.includes('shell.execute'))).toBe(
        true,
      );
      await broker.dispose();
    });

    it('refuses a write larger than the approval card can show, before authorizing it', async () => {
      if (process.platform === 'linux' && !(await probeSandboxRunner()).available) return;
      const registry = new ToolRegistry();
      for (const definition of [POLL_COMMAND_TOOL, WRITE_STDIN_TOOL, TERMINATE_COMMAND_TOOL])
        registry.register(definition);
      const sessions = new ManagedCommandSessions();
      let authorizations = 0;
      const broker = new ToolBroker(
        registry,
        () => 1,
        () => {
          authorizations += 1;
          return { decision: 'allow', reason: 'test', beforeExecute: () => true };
        },
      );
      registerManagedCommandControlTools(broker, sessions);
      const owner = {
        taskId: 'task-1',
        turnId: 'turn-1',
        workspaceId: 'workspace-1',
        policyEpoch: 1,
      };
      broker.startTurn(owner, 'codex');

      // A card that summarises is a bypass: harmless-looking text followed by a real command would
      // be approved on the strength of the part the user could see.
      await expect(
        broker.dispatch({
          ...owner,
          callId: 'stdin-oversized',
          providerName: 'write_stdin',
          input: {
            sessionId: 'not-reached',
            chars: `# ${'x'.repeat(MANAGED_STDIN_MAX_CHARACTERS)}\nrm -rf .`,
          },
        }),
      ).rejects.toMatchObject({
        name: 'ManagedStdinRejection',
        code: 'STDIN_TOO_LARGE',
        // The provider is told the limit and how to stay inside it, so it resends as smaller
        // writes instead of treating this as an unexplained failure.
        message: expect.stringContaining('Split the input into consecutive write_stdin calls'),
      });
      expect(authorizations).toBe(0);
      await broker.dispose();
    });

    it('refuses a stdin write for a session this Turn does not own before any approval', async () => {
      if (process.platform === 'linux' && !(await probeSandboxRunner()).available) return;
      const registry = new ToolRegistry();
      for (const definition of [POLL_COMMAND_TOOL, WRITE_STDIN_TOOL, TERMINATE_COMMAND_TOOL])
        registry.register(definition);
      const sessions = new ManagedCommandSessions();
      let authorizations = 0;
      const broker = new ToolBroker(
        registry,
        () => 1,
        () => {
          authorizations += 1;
          return { decision: 'allow', reason: 'test', beforeExecute: () => true };
        },
      );
      registerManagedCommandControlTools(broker, sessions);
      const owner = {
        taskId: 'task-1',
        turnId: 'turn-1',
        workspaceId: 'workspace-1',
        policyEpoch: 1,
      };
      broker.startTurn(owner, 'codex');

      await expect(
        broker.dispatch({
          ...owner,
          callId: 'stdin-unknown-session',
          providerName: 'write_stdin',
          input: { sessionId: 'not-a-session', chars: 'ignored' },
        }),
      ).rejects.toThrow('Managed command session not found');
      expect(authorizations).toBe(0);
      await broker.dispose();
    });
  },
);
