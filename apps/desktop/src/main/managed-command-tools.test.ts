import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolBroker, type ManagedToolLifecycleEvent } from './tool-broker';
import { ToolRegistry, type Capability } from '@sprint-coder/domain';
import {
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
import { ManagedCommandSessions } from './managed-command-sessions';
import { probeSandboxRunner } from './sandbox-runner';

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
