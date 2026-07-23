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
  providerCompatibility: ['mock', 'codex'],
});

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
  command?: {
    persistence: Pick<
      PersistenceClient,
      | 'getWorkspace'
      | 'prepareCommand'
      | 'beginCommand'
      | 'startCommand'
      | 'appendCommandOutput'
      | 'appendCommandOutputBatch'
      | 'completeCommand'
      | 'getCommand'
    >;
    publish(event: TurnEvent): void;
  },
): ToolBroker {
  const commandRunner = new CommandRunner();
  const commandIds = new WeakMap<object, string>();
  const registry = new ToolRegistry();
  registry.register(MOCK_ECHO_TOOL);
  registry.register(COMMAND_RUNNER_TOOL);
  registry.register(APPROVAL_PROBE_TOOL);
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
  broker.registerImplementation({
    toolId: COMMAND_RUNNER_TOOL.toolId,
    implementationKind: 'command-runner',
    dispose: () => commandRunner.dispose(),
    prepare: async (input, context, control) => {
      if (command === undefined)
        throw new Error('CommandRunner execution boundary is not configured');
      const workspacePath = command.persistence.getWorkspace(context.taskId);
      if (workspacePath === null) throw new Error('CommandRunner requires a selected Workspace');
      const request = input as {
        executable: string;
        argv: string[];
        cwd?: string;
        purpose: string;
      };
      const spec = await prepareExecutionSpec({
        workspacePath,
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
        return result;
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
  return broker;
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
