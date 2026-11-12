// Issue #1211: Main tells a Team Worker's runtime that its desktop operation may have taken effect,
// through the Worker's runtime Turn id (`runtimeTurnId`), so a connection failure after it never
// runs the Worker's request again on another runtime. This goes the whole way: the runtime's tool
// call, Main's managed dispatch and its binding of the Worker's call, the broker and the command
// tool, the run's start, and the runtime's choice whether to run the request again.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry, type TeamEnvelope } from '@sprint-coder/domain';
import type * as RuntimeHostModule from './runtime-host';

type Kind = 'claude' | 'codex' | 'grok';
type Invoke = (
  taskId: string,
  turnId: string,
  request: { callId: string; toolName: string; arguments: unknown },
  signal: AbortSignal,
) => Promise<unknown>;

const host = vi.hoisted(() => ({
  starts: [] as Array<{ kind: string; turnId: string }>,
  /** How the started runtime makes its one tool call (Codex's own path, or the Worker MCP). */
  call: null as
    null | ((kind: string, taskId: string, turnId: string, invoke: unknown) => Promise<unknown>),
  results: [] as unknown[],
}));

vi.mock('./runtime-host', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeHostModule>();
  class RuntimeHostClient {
    constructor(
      private readonly onEvent: (taskId: string, turnId: string, event: unknown) => void,
      private readonly onFailure: (taskId: string, turnId: string, error: unknown) => void,
      _prepareContext?: unknown,
      _onContextAccepted?: unknown,
      private readonly kind: string = 'codex',
      _isolationRoot?: unknown,
      _bindTeamMcp?: unknown,
      private readonly invoke?: unknown,
    ) {}
    async probe() {
      return { available: true, readiness: 'ready', models: [] };
    }
    start(taskId: string, turnId: string): boolean {
      host.starts.push({ kind: this.kind, turnId });
      void (async () => {
        this.onEvent(taskId, turnId, {
          type: 'operation',
          phase: 'tool_call_start',
          label: 'managed tool call started (exec_command)',
          sideEffect: false,
        });
        try {
          host.results.push(await host.call!(this.kind, taskId, turnId, this.invoke));
        } catch (error) {
          host.results.push(error);
        }
        // The connection to the model is lost after the call.
        this.onFailure(taskId, turnId, {
          code: 'RUNTIME_UNAVAILABLE',
          userMessage: '接続先で一時的な障害が発生しました。',
          retryable: true,
        });
      })();
      return true;
    }
    async cancel() {
      return { turnId: 'turn', forced: false, stoppedAt: new Date().toISOString() };
    }
    waitForTurnExit(): Promise<void> {
      return Promise.resolve();
    }
    dispose(): void {}
  }
  return { ...actual, RuntimeHostClient };
});

import { IpcRouter } from './ipc';
import {
  RuntimeHostTeamWorkerRuntime,
  TeamRuntimeAvailabilityTracker,
} from './team-worker-runtime';
import { ToolBroker } from './tool-broker';
import {
  MANAGED_EXEC_COMMAND_TOOL,
  registerCommandRunnerTool,
  type CommandToolBoundary,
} from './default-tools';
import { CommandRunner } from './command-runner';
import * as desktopControlModule from './desktop-control';
import {
  configureDesktopControlTeamCursors,
  markDesktopControlWorker,
  resetDesktopControlSessions,
} from './desktop-control-session';
import type { AgentRecord } from './persistence';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  resetDesktopControlSessions();
  configureDesktopControlTeamCursors(false);
  host.starts.length = 0;
  host.results.length = 0;
  host.call = null;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const worker: AgentRecord = {
  id: 'worker-1',
  teamId: 'team-1',
  threadId: 'thread-1',
  taskId: 'task-1',
  kind: 'worker',
  role: 'Checker',
  state: 'ready',
  objective: '窓を操作する',
  parentCapabilityCeiling: null,
  contextInheritancePolicy: 'summary',
  writeCapable: false,
  currentActivity: null,
  runtimeKind: 'codex',
  modelSelection: {
    connectionId: 'builtin:codex-cli',
    requestedProvider: 'openai',
    requestedModel: 'gpt-5.6-terra',
  },
  parentAgentId: 'leader-1',
  depth: 1,
  canDelegate: false,
  managerPolicy: null,
  blueprintRoleKey: null,
  createdAt: '2026-11-13T00:00:00.000Z',
  updatedAt: '2026-11-13T00:00:00.000Z',
};

const envelope: TeamEnvelope = {
  teamId: 'team-1',
  messageId: 'message-1',
  deliveryId: 'delivery-1',
  sourceAgentId: 'leader-1',
  targetAgentId: 'worker-1',
  sourceKind: 'leader',
  targetKind: 'worker',
  seq: 1,
  attempt: 1,
  issuedAt: '2026-11-13T00:00:00.000Z',
};

/** The Leader's Turn the Worker's calls reach the broker under. */
const parent = {
  taskId: 'task-1',
  turnId: 'leader-turn',
  workspaceId: 'workspace-1',
  policyEpoch: 1,
};

async function setUp(first: Kind, second: Kind) {
  const workspace = await mkdtemp(join(tmpdir(), 'sprint-coder-worker-side-effect-'));
  const worktree = await mkdtemp(join(tmpdir(), 'sprint-coder-worker-side-effect-tree-'));
  roots.push(workspace, worktree);
  const runner = new CommandRunner({ sandboxed: true });
  const run = vi.spyOn(runner, 'run').mockImplementation(async (spec, options = {}) => {
    options.beforeSpawn?.();
    const text =
      spec.argv[1] === 'start' ? JSON.stringify({ ok: true, data: { session_id: 'run-1' } }) : '';
    await options.onBatch?.([{ seq: 0, stream: 'stdout', text, byteLength: text.length }]);
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
  const managedWorkerTurn = new Map<string, unknown>();
  const router = Object.create(IpcRouter.prototype) as Record<string, unknown> & {
    managedWorkerOf(turnId: string, callId: string): unknown;
    recordManagedWorkerSideEffect(turnId: string, callId: string): void;
    createGenericManagedRuntimeToolHandlers(): {
      cliTeam: Invoke;
      teamMcp: (
        input: unknown,
        context: {
          taskId: string;
          turnId: string;
          callId: string;
          toolName: string;
          catalogDigest: string;
          signal?: AbortSignal;
        },
      ) => Promise<unknown>;
    };
  };
  const registry = new ToolRegistry();
  registry.register(MANAGED_EXEC_COMMAND_TOOL);
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
  let n = 0;
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
      prepareCommand: () => ({ id: `command-${(n += 1)}` }) as never,
      beginCommand: () => ({}) as never,
      startCommand: () => ({ command: {} as never, event: {} as never }),
      appendCommandOutputBatch: () => [],
      completeCommand: () => ({ command: {} as never, event: {} as never }),
      getCommand: (id: string) => ({ id, state: 'running', outputBytes: 0 }) as never,
    },
    publish: () => undefined,
    // What Main gives the command tool (see the IpcRouter constructor).
    workerFor: (turnId: string, callId: string) => router.managedWorkerOf(turnId, callId),
    workerSideEffect: (turnId: string, callId: string) =>
      router.recordManagedWorkerSideEffect(turnId, callId),
  } as unknown as CommandToolBoundary;
  registerCommandRunnerTool(broker, runner, boundary, MANAGED_EXEC_COMMAND_TOOL);
  broker.startTurn(parent, 'codex');
  const runtime = new RuntimeHostTeamWorkerRuntime({
    selectRuntimes: () => [
      { kind: first, model: `${first}-model` },
      { kind: second, model: `${second}-model` },
    ],
    availability: new TeamRuntimeAvailabilityTracker(),
    workspaceFor: () => workspace,
    // Main binds the Worker's runtime Turn as it prepares the Turn's catalog.
    catalogFor: (kind, taskId, runtimeTurnId) => {
      managedWorkerTurn.set(runtimeTurnId, {
        taskId,
        parentTurnId: parent.turnId,
        workerId: worker.id,
        snapshot: {
          digest: 'd'.repeat(64),
          providerId: kind,
          entries: [{ providerName: 'exec_command' }],
        },
        workspace: { roots: [{ path: worktree }] },
        mutationBindings: new Map(),
        released: new AbortController(),
      });
      return { tools: [] };
    },
    releaseManagedTurn: (turnId) => managedWorkerTurn.delete(turnId),
    authorizeEgress: () => true,
    invokeManagedTool: (taskId, turnId, request, signal) =>
      handlers.cliTeam(taskId, turnId, request as never, signal),
  });
  Object.assign(router, {
    managedWorkerTurn,
    managedWorkerCall: new Map(),
    managedCodingHarness: { broker },
    persistence: { readTurnWorkspaceSetForTask: () => null },
    cliTeamWorkerRuntime: runtime,
  });
  const handlers = router.createGenericManagedRuntimeToolHandlers();
  vi.spyOn(desktopControlModule, 'isDesktopControlExecutable').mockReturnValue(true);
  configureDesktopControlTeamCursors(true);
  markDesktopControlWorker(parent.taskId, worker.id, worker.role);
  /** Each runtime's own way to the managed tool: Codex's, or the Worker MCP's for Claude and Grok. */
  const callWith = (argv: string[]) => {
    host.call = (kind, taskId, turnId, invoke) => {
      const request = {
        callId: `call-${kind}`,
        toolName: 'exec_command',
        arguments: { executable: process.execPath, argv, purpose: 'Worker の窓を操作する' },
      };
      return kind === 'codex'
        ? (invoke as Invoke)(taskId, turnId, request, new AbortController().signal)
        : handlers.teamMcp(request.arguments, {
            taskId,
            turnId,
            callId: request.callId,
            toolName: request.toolName,
            catalogDigest: 'd'.repeat(64),
          });
    };
  };
  const desktopRuns = () =>
    run.mock.calls
      .map(([spec]) => spec.argv.join(' '))
      .filter((argv) => !argv.startsWith('session') && !argv.startsWith('cursor-overlay'));
  return { runtime, callWith, desktopRuns };
}

describe('a Team Worker’s desktop operation, reported to its runtime by Main', () => {
  it.each([
    ['codex', 'grok'],
    ['grok', 'codex'],
    ['claude', 'codex'],
  ] as const)(
    'keeps a %s Worker’s request from running again on %s after a connection failure',
    async (first, second) => {
      const { runtime, callWith, desktopRuns } = await setUp(first, second);
      callWith(['click', '@s1:e1']);

      await expect(
        runtime.execute({ worker, envelope, content: '窓のボタンを押す' }),
      ).rejects.toThrow('接続先で一時的な障害が発生しました。');

      // The click ran (once), and the request was not run again on the next runtime.
      expect(host.results).toEqual([expect.objectContaining({ exitCode: 0 })]);
      expect(desktopRuns()).toEqual(['click @s1:e1']);
      expect(host.starts.map(({ kind }) => kind)).toEqual([first]);
    },
  );

  it.each(['codex', 'grok', 'claude'] as const)(
    'still runs a %s Worker’s request again after a connection failure that followed only a read',
    async (first) => {
      const second = first === 'codex' ? 'grok' : 'codex';
      const { runtime, callWith, desktopRuns } = await setUp(first, second);
      callWith(['snapshot', '-i']);

      await expect(runtime.execute({ worker, envelope, content: '窓を読む' })).rejects.toThrow(
        '接続先で一時的な障害が発生しました。',
      );

      expect(desktopRuns()).toEqual(['snapshot -i', 'snapshot -i']);
      expect(host.starts.map(({ kind }) => kind)).toEqual([first, second]);
    },
  );
});
