import {
  ToolRegistry,
  createToolDefinition,
  createToolId,
  type ToolCatalogSnapshot,
  type ToolExecutionContext,
} from '@vibe/domain';
import { ToolBroker, type ToolAuthorizer } from './tool-broker';

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
    },
    required: ['executable', 'argv'],
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
): ToolBroker {
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
    execute: () => {
      throw new Error('CommandRunner execution boundary is not available until Slice 4.4');
    },
  });
  return broker;
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
