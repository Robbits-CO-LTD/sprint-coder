import {
  ToolRegistry,
  createToolDefinition,
  createToolId,
  type ToolCatalogSnapshot,
  type ToolExecutionContext,
  type ExecutionSpec,
  type JsonValue,
} from '@sprint-coder/domain';
import { randomUUID } from 'node:crypto';
import { ToolBroker, type ToolAuthorizer } from './tool-broker';
import {
  CommandRunner,
  prepareExecutionSpec,
  type CommandOutputChunk,
  type CommandResult,
} from './command-runner';
import type { PersistenceClient } from './persistence';
import type { TurnEvent } from '@sprint-coder/contracts';
import type { TeamCoordinator } from './team-coordinator';
import type { ManagedCommandSessions } from './managed-command-sessions';
import { registerTeamTools, TEAM_TOOLS } from './team-tools';
import { resolveWorkspaceToolRoot } from './workspace-root-resolution';

export const MOCK_ECHO_TOOL = createToolDefinition({
  toolId: createToolId({ provider: 'builtin', namespace: 'mock', name: 'echo', version: '1' }),
  providerName: 'mock_echo',
  kind: 'search',
  schemaVersion: 1,
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  outputSchema: { type: 'string' },
  sideEffect: 'none',
  risk: 'low',
  requiredCapabilities: [],
  executionTarget: 'main',
  implementationKind: 'built-in',
  priority: 10,
  workspaceBinding: { kind: 'none' },
  providerCompatibility: ['mock'],
});

export const COMMAND_RUNNER_TOOL = createToolDefinition({
  toolId: createToolId({ provider: 'builtin', namespace: 'command', name: 'run', version: '1' }),
  providerName: 'run_command',
  kind: 'shell',
  schemaVersion: 1,
  inputSchema: {
    type: 'object',
    properties: {
      executable: { type: 'string' },
      argv: { type: 'array', items: { type: 'string' } },
      rootId: { type: 'string' },
      cwd: { type: 'string' },
      purpose: { type: 'string' },
    },
    required: ['executable', 'argv', 'purpose'],
    additionalProperties: false,
  },
  outputSchema: { type: 'object' },
  sideEffect: 'process',
  risk: 'high',
  requiredCapabilities: ['shell.execute'],
  executionTarget: 'command-runner',
  implementationKind: 'command-runner',
  priority: 10,
  workspaceBinding: { kind: 'any' },
  providerCompatibility: ['*'],
});

export const MANAGED_EXEC_COMMAND_TOOL = createToolDefinition({
  ...COMMAND_RUNNER_TOOL,
  toolId: createToolId({
    provider: 'builtin',
    namespace: 'command',
    name: 'exec',
    version: '1',
  }),
  providerName: 'exec_command',
  description:
    'Execute one sealed executable and argv in the managed OS sandbox. Long-running work may continue as an owned background session.',
  parallelism: 'serial',
  maxOutputBytes: 2 * 1024 * 1024,
  supportsCancellation: true,
  supportsBackground: true,
  inputSchema: {
    type: 'object',
    properties: {
      executable: { type: 'string' },
      argv: { type: 'array', items: { type: 'string' } },
      rootId: { type: 'string' },
      cwd: { type: 'string' },
      purpose: { type: 'string' },
      background: { type: 'boolean' },
      verification: { type: 'boolean' },
    },
    required: ['executable', 'argv', 'purpose'],
    additionalProperties: false,
  },
});

function managedCommandControlTool(
  name: string,
  providerName: string,
  properties: Record<string, JsonValue>,
  required: string[],
) {
  return createToolDefinition({
    toolId: createToolId({ provider: 'builtin', namespace: 'command', name, version: '1' }),
    providerName,
    // These calls can only address a random, Task/Turn-bound session that was already authorized
    // by exec_command. They do not mint new process authority, so ownership is the boundary.
    kind: 'search',
    schemaVersion: 1,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    outputSchema: { type: 'object' },
    sideEffect: 'none',
    risk: 'low',
    requiredCapabilities: [],
    executionTarget: 'main',
    implementationKind: 'built-in',
    priority: 10,
    workspaceBinding: { kind: 'any' },
    providerCompatibility: ['*'],
  });
}

export const POLL_COMMAND_TOOL = managedCommandControlTool(
  'poll',
  'poll_command',
  { sessionId: { type: 'string' }, afterSeq: { type: 'integer', minimum: 0 } },
  ['sessionId'],
);
export const WRITE_STDIN_TOOL = managedCommandControlTool(
  'write-stdin',
  'write_stdin',
  { sessionId: { type: 'string' }, chars: { type: 'string' }, close: { type: 'boolean' } },
  ['sessionId', 'chars'],
);
export const TERMINATE_COMMAND_TOOL = managedCommandControlTool(
  'terminate',
  'terminate_command',
  { sessionId: { type: 'string' } },
  ['sessionId'],
);

export const UPDATE_PLAN_TOOL = createToolDefinition({
  toolId: createToolId({
    provider: 'builtin',
    namespace: 'control',
    name: 'update-plan',
    version: '1',
  }),
  providerName: 'update_plan',
  kind: 'search',
  schemaVersion: 1,
  inputSchema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        items: {
          type: 'object',
          properties: {
            step: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['step', 'status'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
    additionalProperties: false,
  },
  outputSchema: { type: 'object' },
  sideEffect: 'none',
  risk: 'low',
  requiredCapabilities: [],
  executionTarget: 'main',
  implementationKind: 'built-in',
  priority: 10,
  workspaceBinding: { kind: 'none' },
  providerCompatibility: ['*'],
});

export const REQUEST_USER_INPUT_TOOL = createToolDefinition({
  toolId: createToolId({
    provider: 'builtin',
    namespace: 'control',
    name: 'request-user-input',
    version: '1',
  }),
  providerName: 'request_user_input',
  kind: 'agentControl',
  schemaVersion: 1,
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string' },
      choices: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'string' } },
    },
    required: ['question', 'choices'],
    additionalProperties: false,
  },
  outputSchema: { type: 'object' },
  sideEffect: 'control',
  risk: 'low',
  requiredCapabilities: ['external.open'],
  executionTarget: 'main',
  implementationKind: 'built-in',
  priority: 10,
  workspaceBinding: { kind: 'none' },
  providerCompatibility: ['*'],
});

export function registerManagedControlTools(
  broker: ToolBroker,
  recordPlan?: (
    context: ToolExecutionContext,
    items: readonly { step: string; status: 'pending' | 'in_progress' | 'completed' }[],
  ) => { revision: number },
): void {
  const plans = new WeakMap<object, unknown>();
  broker.registerImplementation({
    toolId: UPDATE_PLAN_TOOL.toolId,
    implementationKind: 'built-in',
    execute: (input, context) => {
      const items = (input as { items: unknown[] }).items;
      plans.set(context, items);
      const persisted = recordPlan?.(
        context,
        items as { step: string; status: 'pending' | 'in_progress' | 'completed' }[],
      );
      return { updated: true, revision: persisted?.revision ?? 0, items };
    },
  });
  broker.registerImplementation({
    toolId: REQUEST_USER_INPUT_TOOL.toolId,
    implementationKind: 'built-in',
    execute: (input, _context, control) => {
      const request = input as { question: string; choices: string[] };
      if (
        !Number.isInteger(control.userInputSelection) ||
        control.userInputSelection! < 0 ||
        control.userInputSelection! >= request.choices.length
      )
        throw new Error('request_user_input requires a separately authorized choice');
      const selectedIndex = control.userInputSelection!;
      return {
        question: request.question,
        selectedIndex,
        selected: request.choices[selectedIndex],
      };
    },
  });
}

export type CommandToolBoundary = Readonly<{
  persistence: Pick<
    PersistenceClient,
    | 'readTurnWorkspaceSet'
    | 'getTurnWorkspaceRootIdentities'
    | 'prepareCommand'
    | 'beginCommand'
    | 'startCommand'
    | 'appendCommandOutput'
    | 'appendCommandOutputBatch'
    | 'completeCommand'
    | 'getCommand'
    | 'createBackgroundActivity'
    | 'transitionBackgroundActivity'
    | 'completeBackgroundActivity'
    | 'recordCommandVerification'
  >;
  publish(event: TurnEvent): void;
}>;

export const APPROVAL_PROBE_TOOL = createToolDefinition({
  toolId: createToolId({ provider: 'builtin', namespace: 'approval', name: 'probe', version: '1' }),
  providerName: 'approval_probe',
  kind: 'network',
  schemaVersion: 1,
  inputSchema: {
    type: 'object',
    properties: { origin: { type: 'string' } },
    required: ['origin'],
    additionalProperties: false,
  },
  outputSchema: { type: 'string' },
  sideEffect: 'network',
  risk: 'medium',
  requiredCapabilities: ['network.fetch'],
  executionTarget: 'main',
  implementationKind: 'built-in',
  priority: 10,
  workspaceBinding: { kind: 'none' },
  providerCompatibility: ['mock'],
});

export function createDefaultToolBroker(
  getCurrentPolicyEpoch: (taskId: string) => number,
  authorizer?: ToolAuthorizer,
  command?: CommandToolBoundary,
  // Leader team tools (Slice 5.2 / FR-TEAM-06): only registered when a TeamCoordinator is
  // supplied, i.e. only on the mock/intelligence-loop broker — real Codex/Claude adapters never
  // pass this bundle, so they stay no-tools per the current production boundary.
  team?: { coordinator: TeamCoordinator },
): ToolBroker {
  const commandRunner = new CommandRunner();
  const registry = new ToolRegistry();
  registry.register(MOCK_ECHO_TOOL);
  registry.register(COMMAND_RUNNER_TOOL);
  registry.register(APPROVAL_PROBE_TOOL);
  if (team !== undefined) for (const definition of TEAM_TOOLS) registry.register(definition);
  const defaultAuthorizer: ToolAuthorizer = ({ entry }) =>
    entry.sideEffect === 'none' && entry.requiredCapabilities.length === 0
      ? { decision: 'allow', reason: 'pure_builtin' }
      : {
          decision: 'deny',
          reason: 'capability authorization is unavailable until Slice 4.3',
        };
  const broker = new ToolBroker(registry, getCurrentPolicyEpoch, authorizer ?? defaultAuthorizer);
  registerApprovalProbeTool(broker);
  broker.registerImplementation({
    toolId: MOCK_ECHO_TOOL.toolId,
    implementationKind: 'built-in',
    execute: (input) => {
      if (
        typeof input !== 'object' ||
        input === null ||
        typeof (input as { text?: unknown }).text !== 'string'
      )
        throw new Error('mock_echo requires a string text argument');
      return (input as { text: string }).text;
    },
  });
  registerCommandRunnerTool(broker, commandRunner, command);
  if (team !== undefined) registerTeamTools(broker, team.coordinator);
  return broker;
}

export function registerApprovalProbeTool(broker: ToolBroker): void {
  broker.registerImplementation({
    toolId: APPROVAL_PROBE_TOOL.toolId,
    implementationKind: 'built-in',
    execute: (input) => {
      const origin = (input as { origin?: unknown }).origin;
      if (typeof origin !== 'string') throw new Error('approval_probe requires an origin');
      return `承認された確認対象: ${origin}（外部通信は実行していません）`;
    },
  });
}

export function registerCommandRunnerTool(
  broker: ToolBroker,
  commandRunner: CommandRunner,
  command?: CommandToolBoundary,
  definition = COMMAND_RUNNER_TOOL,
  sessions?: ManagedCommandSessions,
  foregroundToBackgroundMs = 10_000,
  disposeSessions = true,
): void {
  const commandIds = new WeakMap<object, string>();
  const resourceKeys = new WeakMap<object, string>();
  const backgroundSpecs = new WeakSet<object>();
  const verificationSpecs = new WeakSet<object>();
  broker.registerImplementation({
    toolId: definition.toolId,
    implementationKind: 'command-runner',
    dispose: async () => {
      await Promise.all([
        commandRunner.dispose(),
        ...(disposeSessions ? [sessions?.dispose()] : []),
      ]);
    },
    prepare: async (input, context, control) => {
      if (command === undefined)
        throw new Error('CommandRunner execution boundary is not configured');
      const request = input as {
        executable: string;
        argv: string[];
        rootId?: string;
        cwd?: string;
        purpose: string;
        background?: boolean;
        verification?: boolean;
      };
      const workspace = command.persistence.readTurnWorkspaceSet(context.turnId);
      if (workspace === null)
        throw new Error('CommandRunner requires a sealed Turn Workspace snapshot');
      const root = resolveWorkspaceToolRoot(workspace, request.rootId);
      if (root === null) throw new Error('CommandRunner requires a valid Workspace rootId');
      const expectedRootIdentityDigest =
        workspace.source === 'project'
          ? command.persistence.getTurnWorkspaceRootIdentities(context.turnId).get(root.rootId)
          : undefined;
      if (workspace.source === 'project' && expectedRootIdentityDigest === undefined)
        throw new Error('CommandRunner Turn Workspace identity is incomplete');
      const spec = await prepareExecutionSpec({
        rootId: root.rootId,
        workspacePath: root.path,
        ...(expectedRootIdentityDigest === undefined ? {} : { expectedRootIdentityDigest }),
        executable: request.executable,
        argv: request.argv,
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      });
      const persisted = command.persistence.prepareCommand({
        id: randomUUID(),
        taskId: context.taskId,
        turnId: context.turnId,
        callId: control.callId,
        spec,
        purpose: request.purpose,
        risk: definition.risk,
        createdAt: new Date().toISOString(),
      });
      commandIds.set(spec, persisted.id);
      resourceKeys.set(spec, `workspace:${workspace.digest}`);
      if (request.background === true) backgroundSpecs.add(spec);
      if (request.verification === true) verificationSpecs.add(spec);
      return spec;
    },
    resourceClaims: (input) => [
      { key: resourceKeys.get(input as object) ?? 'workspace:unbound', mode: 'write' },
    ],
    authorizationDenied: (input) => {
      if (command === undefined) return;
      const commandId = commandIds.get(input as object);
      if (commandId === undefined) return;
      const current = command.persistence.getCommand(commandId);
      if (current.state !== 'prepared') return;
      const persisted = command.persistence.completeCommand({
        commandId,
        state: 'canceled',
        exitCode: null,
        signal: null,
        outputBytes: 0,
        truncated: false,
        finishedAt: new Date().toISOString(),
      });
      command.publish(persisted.event);
    },
    execute: async (input, _context, control) => {
      if (command === undefined)
        throw new Error('CommandRunner execution boundary is not configured');
      const spec = input as ExecutionSpec;
      const commandId = commandIds.get(spec);
      if (commandId === undefined) throw new Error('Command ExecutionSpec has no durable identity');
      const toolOutput = { stdout: '', stderr: '', truncated: false };
      const hooks = {
        ...(control.signal === undefined ? {} : { signal: control.signal }),
        beforeSpawn: () => {
          command.persistence.beginCommand(commandId);
        },
        onStarted: ({
          pid,
          startedAt,
          processStartIdentity,
        }: {
          pid: number;
          startedAt: number;
          processStartIdentity: string;
        }) => {
          const persisted = command.persistence.startCommand({
            commandId,
            pid,
            processStartTime: processStartIdentity,
            startedAt: new Date(startedAt).toISOString(),
          });
          command.publish(persisted.event);
        },
        onBatch: (chunks: readonly CommandOutputChunk[]) => {
          for (const chunk of chunks) appendCommandToolOutput(toolOutput, chunk);
          const events = command.persistence.appendCommandOutputBatch({
            commandId,
            chunks,
            createdAt: new Date().toISOString(),
          });
          for (const event of events) command.publish(event);
        },
      };
      if (sessions !== undefined) {
        const owner = { taskId: _context.taskId, turnId: _context.turnId };
        const sessionId = randomUUID();
        let backgroundPersisted = false;
        const persistBackground = (): void => {
          if (backgroundPersisted) return;
          backgroundPersisted = true;
          command.persistence.createBackgroundActivity({
            id: sessionId,
            taskId: owner.taskId,
            ownerThreadId: owner.turnId,
            ownerTurnId: owner.turnId,
            kind: 'command',
            wakePolicy: 'nextSafePoint',
            requiredCapabilities: ['shell.execute'],
            volumeQuotaBytes: 1_048_576,
            createdAt: new Date().toISOString(),
          });
          command.persistence.transitionBackgroundActivity(
            sessionId,
            'running',
            new Date().toISOString(),
          );
        };
        if (backgroundSpecs.has(spec)) persistBackground();
        const started = await sessions.start(spec, owner, hooks, sessionId);
        const finalize = (snapshot: Awaited<ReturnType<ManagedCommandSessions['wait']>>): void => {
          const persisted =
            snapshot.result === null
              ? command.persistence.completeCommand({
                  commandId,
                  state: snapshot.state === 'canceled' ? 'canceled' : 'failed',
                  exitCode: null,
                  signal: null,
                  outputBytes: command.persistence.getCommand(commandId).outputBytes,
                  truncated: false,
                  finishedAt: new Date().toISOString(),
                })
              : completePersistedCommand(command.persistence, commandId, snapshot.result);
          command.publish(persisted.event);
          if (verificationSpecs.has(spec) && snapshot.result?.exitCode === 0)
            command.persistence.recordCommandVerification({
              taskId: owner.taskId,
              turnId: owner.turnId,
              commandId,
              exitCode: 0,
              createdAt: new Date().toISOString(),
            });
          if (snapshot.state === 'canceled')
            command.persistence.transitionBackgroundActivity(
              sessionId,
              'canceled',
              new Date().toISOString(),
            );
          else
            command.persistence.completeBackgroundActivity({
              activityId: sessionId,
              completionId: randomUUID(),
              outcome: snapshot.state === 'exited' ? 'completed' : 'failed',
              payload: JSON.stringify({
                sessionId: snapshot.sessionId,
                state: snapshot.state,
                result: snapshot.result,
                error: snapshot.error,
              }),
              outputCursor: snapshot.nextCursor,
              completedAt: new Date().toISOString(),
            });
        };
        if (backgroundSpecs.has(spec)) {
          void sessions.wait(started.sessionId, owner).then(finalize);
          return started;
        }
        const completed = await sessions.waitFor(
          started.sessionId,
          owner,
          foregroundToBackgroundMs,
        );
        if (completed === null) {
          persistBackground();
          void sessions.wait(started.sessionId, owner).then(finalize);
          return sessions.poll(started.sessionId, owner);
        }
        const persisted =
          completed.result === null
            ? command.persistence.completeCommand({
                commandId,
                state: completed.state === 'canceled' ? 'canceled' : 'failed',
                exitCode: null,
                signal: null,
                outputBytes: command.persistence.getCommand(commandId).outputBytes,
                truncated: false,
                finishedAt: new Date().toISOString(),
              })
            : completePersistedCommand(command.persistence, commandId, completed.result);
        command.publish(persisted.event);
        if (completed.result === null)
          throw new Error(completed.error ?? 'Managed command failed before completion');
        if (verificationSpecs.has(spec) && completed.result.exitCode === 0)
          command.persistence.recordCommandVerification({
            taskId: owner.taskId,
            turnId: owner.turnId,
            commandId,
            exitCode: 0,
            createdAt: new Date().toISOString(),
          });
        return {
          ...completed.result,
          ...toolOutput,
          truncated: commandToolTruncated(completed.result.truncated, toolOutput.truncated),
        };
      }
      try {
        const result = await commandRunner.run(spec, hooks);
        const persisted = completePersistedCommand(command.persistence, commandId, result);
        command.publish(persisted.event);
        if (verificationSpecs.has(spec) && result.exitCode === 0)
          command.persistence.recordCommandVerification({
            taskId: _context.taskId,
            turnId: _context.turnId,
            commandId,
            exitCode: 0,
            createdAt: new Date().toISOString(),
          });
        return {
          ...result,
          ...toolOutput,
          truncated: commandToolTruncated(result.truncated, toolOutput.truncated),
        };
      } catch (error) {
        const current = command.persistence.getCommand(commandId);
        if (
          current.state === 'prepared' ||
          current.state === 'starting' ||
          current.state === 'running'
        ) {
          const persisted = command.persistence.completeCommand({
            commandId,
            state: 'failed',
            exitCode: null,
            signal: null,
            outputBytes: current.outputBytes,
            truncated: current.state === 'running',
            finishedAt: new Date().toISOString(),
          });
          command.publish(persisted.event);
        }
        throw error;
      }
    },
  });
}

export function registerManagedCommandControlTools(
  broker: ToolBroker,
  sessions: ManagedCommandSessions,
  command?: CommandToolBoundary,
): void {
  broker.registerImplementation({
    toolId: POLL_COMMAND_TOOL.toolId,
    implementationKind: 'built-in',
    execute: (input, context) => {
      const request = input as { sessionId: string; afterSeq?: number };
      return sessions.poll(request.sessionId, context, request.afterSeq ?? 0);
    },
  });
  broker.registerImplementation({
    toolId: WRITE_STDIN_TOOL.toolId,
    implementationKind: 'built-in',
    execute: (input, context) => {
      const request = input as { sessionId: string; chars: string; close?: boolean };
      return {
        written: sessions.writeStdin(
          request.sessionId,
          context,
          request.chars,
          request.close === true,
        ),
      };
    },
  });
  broker.registerImplementation({
    toolId: TERMINATE_COMMAND_TOOL.toolId,
    implementationKind: 'built-in',
    execute: (input, context) => {
      const sessionId = (input as { sessionId: string }).sessionId;
      const terminated = sessions.terminate(sessionId, context);
      if (terminated)
        command?.persistence.transitionBackgroundActivity(
          sessionId,
          'canceled',
          new Date().toISOString(),
        );
      return { terminated };
    },
  });
}

const MAX_COMMAND_TOOL_OUTPUT_BYTES = 64 * 1024;

function appendCommandToolOutput(
  output: { stdout: string; stderr: string; truncated: boolean },
  chunk: CommandOutputChunk,
): void {
  const used = Buffer.byteLength(output.stdout, 'utf8') + Buffer.byteLength(output.stderr, 'utf8');
  const remaining = MAX_COMMAND_TOOL_OUTPUT_BYTES - used;
  if (remaining <= 0) {
    output.truncated = true;
    return;
  }
  const bytes = Buffer.from(chunk.text, 'utf8');
  const text = bytes.subarray(0, remaining).toString('utf8');
  output[chunk.stream] += text;
  if (bytes.byteLength > remaining) output.truncated = true;
}

export function commandToolTruncated(
  runnerTruncated: boolean,
  outputBufferTruncated: boolean,
): boolean {
  return runnerTruncated || outputBufferTruncated;
}

function completePersistedCommand(
  persistence: Pick<PersistenceClient, 'completeCommand'>,
  commandId: string,
  result: CommandResult,
) {
  return persistence.completeCommand({
    commandId,
    state: result.canceled ? 'canceled' : 'exited',
    exitCode: result.exitCode,
    signal: result.signal,
    outputBytes: result.outputBytes,
    truncated: result.truncated,
    finishedAt: new Date().toISOString(),
  });
}

export function startMockTurnCatalog(
  broker: ToolBroker,
  context: ToolExecutionContext,
): ToolCatalogSnapshot {
  return broker.startTurn(context, 'mock');
}

export function createEmptyToolCatalogSnapshot(
  providerId: string,
  workspaceId: string | null,
): ToolCatalogSnapshot {
  return new ToolRegistry().createSnapshot({ providerId, workspaceId });
}
