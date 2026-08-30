import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolBroker } from './tool-broker';
import { ToolRegistry } from '@sprint-coder/domain';
import {
  MANAGED_EXEC_COMMAND_TOOL,
  POLL_COMMAND_TOOL,
  TERMINATE_COMMAND_TOOL,
  WRITE_STDIN_TOOL,
  registerCommandRunnerTool,
  registerManagedCommandControlTools,
  type CommandToolBoundary,
} from './default-tools';
import { CommandRunner } from './command-runner';
import { ManagedCommandSessions } from './managed-command-sessions';
import { probeSandboxRunner } from './sandbox-runner';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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
      const commandRows = new Map<string, { state: string; outputBytes: number }>();
      const backgroundTransitions: string[] = [];
      let backgroundCreated = 0;
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
            const row = { state: 'prepared', outputBytes: 0 };
            commandRows.set(input.id, row);
            return { id: input.id, ...row } as never;
          },
          beginCommand: (id: string) => {
            commandRows.get(id)!.state = 'starting';
            return { id, ...commandRows.get(id)! } as never;
          },
          startCommand: ({ commandId }: { commandId: string }) => {
            commandRows.get(commandId)!.state = 'running';
            return { command: {} as never, event: {} as never };
          },
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
          completeCommand: ({ commandId, state }: { commandId: string; state: string }) => {
            commandRows.get(commandId)!.state = state;
            return { command: {} as never, event: {} as never };
          },
          getCommand: (id: string) => ({ id, ...commandRows.get(id)! }) as never,
          createBackgroundActivity: () => {
            backgroundCreated += 1;
            return {} as never;
          },
          transitionBackgroundActivity: (_id: string, state: string) => {
            backgroundTransitions.push(state);
            return {} as never;
          },
          completeBackgroundActivity: () => ({}) as never,
          recordCommandVerification: () => null,
        },
        publish: () => undefined,
      } as unknown as CommandToolBoundary;
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
          callId: 'background-verification-denied',
          providerName: 'exec_command',
          input: {
            executable: '/bin/sh',
            argv: ['-c', 'exit 0'],
            purpose: 'must not verify while edits can continue',
            background: true,
            verification: true,
          },
        }),
      ).rejects.toThrow('Verification commands cannot run in the background');
      const verification = (await broker.dispatch({
        ...owner,
        callId: 'foreground-verification',
        providerName: 'exec_command',
        input: {
          executable: '/bin/sh',
          argv: ['-c', 'sleep 0.05; exit 0'],
          purpose: 'must remain foreground until verification completes',
          verification: true,
        },
      })) as { exitCode: number };
      expect(verification.exitCode).toBe(0);
      expect(backgroundCreated).toBe(0);
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
      await broker.dispose();
    });
  },
);
