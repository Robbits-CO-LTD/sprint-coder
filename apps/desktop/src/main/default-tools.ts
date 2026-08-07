import {
  ToolRegistry,
  createToolDefinition,
  createToolId,
  type ToolCatalogSnapshot,
  type ToolExecutionContext,
  type ExecutionSpec,
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
  broker.registerImplementation({
    toolId: APPROVAL_PROBE_TOOL.toolId,
    implementationKind: 'built-in',
    execute: (input) => {
      const origin = (input as { origin?: unknown }).origin;
      if (typeof origin !== 'string') throw new Error('approval_probe requires an origin');
      return `承認された確認対象: ${origin}（外部通信は実行していません）`;
    },
  });
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

export function registerCommandRunnerTool(
  broker: ToolBroker,
  commandRunner: CommandRunner,
  command?: CommandToolBoundary,
): void {
  const commandIds = new WeakMap<object, string>();
  broker.registerImplementation({
    toolId: COMMAND_RUNNER_TOOL.toolId,
    implementationKind: 'command-runner',
    dispose: () => commandRunner.dispose(),
    prepare: async (input, context, control) => {
      if (command === undefined)
        throw new Error('CommandRunner execution boundary is not configured');
      const request = input as {
        executable: string;
        argv: string[];
        rootId?: string;
        cwd?: string;
        purpose: string;
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
        risk: COMMAND_RUNNER_TOOL.risk,
        createdAt: new Date().toISOString(),
      });
      commandIds.set(spec, persisted.id);
      return spec;
    },
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
      try {
        const result = await commandRunner.run(spec, {
          ...(control.signal === undefined ? {} : { signal: control.signal }),
          beforeSpawn: () => {
            command.persistence.beginCommand(commandId);
          },
          onStarted: ({ pid, startedAt, processStartIdentity }) => {
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
        });
        const persisted = completePersistedCommand(command.persistence, commandId, result);
        command.publish(persisted.event);
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
