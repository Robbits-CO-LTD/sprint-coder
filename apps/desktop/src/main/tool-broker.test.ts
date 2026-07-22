import { describe, expect, it } from 'vitest';
import {
  ToolRegistry,
  createToolDefinition,
  createToolId,
  type ToolExecutionContext,
} from '@vibe/domain';
import { ToolBroker, type ToolAuthorizer } from './tool-broker';

const inputSchema = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
} as const;
const outputSchema = inputSchema;
const authorizePure: ToolAuthorizer = ({ entry }) =>
  entry.sideEffect === 'none' && entry.requiredCapabilities.length === 0
    ? { decision: 'allow', reason: 'test_pure' }
    : { decision: 'deny', reason: 'test_capability_required' };
const authorizeAll: ToolAuthorizer = () => ({ decision: 'allow', reason: 'test_allow' });

function createRegistry() {
  const registry = new ToolRegistry();
  const echo = createToolDefinition({
    toolId: createToolId({ provider: 'builtin', namespace: 'mock', name: 'echo', version: '1' }),
    providerName: 'mock_echo',
    kind: 'search',
    schemaVersion: 1,
    inputSchema,
    outputSchema,
    sideEffect: 'none',
    risk: 'low',
    requiredCapabilities: [],
    executionTarget: 'main',
    implementationKind: 'built-in',
    priority: 10,
    workspaceBinding: { kind: 'none' },
    providerCompatibility: ['mock'],
  });
  const command = createToolDefinition({
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
    providerCompatibility: ['mock'],
  });
  registry.register(echo);
  registry.register(command);
  return { registry, echo, command };
}

const context: ToolExecutionContext = {
  taskId: 'task-1',
  turnId: 'turn-1',
  workspaceId: 'workspace-1',
  policyEpoch: 3,
};

describe('Main ToolBroker', () => {
  it('dispatches only the exact ToolId pinned by the Turn snapshot', async () => {
    const { registry, echo } = createRegistry();
    const broker = new ToolBroker(registry, () => 3, authorizePure);
    broker.registerImplementation({
      toolId: echo.toolId,
      implementationKind: 'built-in',
      execute: (input) => ({ text: (input as { text: string }).text }),
    });
    const snapshot = broker.startTurn(context, 'mock');

    await expect(
      broker.dispatch({
        taskId: 'task-1',
        turnId: 'turn-1',
        callId: 'call-1',
        providerName: 'mock_echo',
        input: { text: 'ok' },
      }),
    ).resolves.toEqual({ text: 'ok' });
    await expect(
      broker.dispatch({
        taskId: 'task-1',
        turnId: 'turn-1',
        callId: 'call-2',
        providerName: 'unknown',
        input: {},
      }),
    ).rejects.toThrow('Tool name is not present in the Turn catalog');
    expect(snapshot.entries.find(({ providerName }) => providerName === 'mock_echo')?.toolId).toBe(
      echo.toolId,
    );
  });

  it('does not expose registry changes to an already-started Turn', async () => {
    const { registry, echo } = createRegistry();
    const broker = new ToolBroker(registry, () => 3, authorizePure);
    broker.registerImplementation({
      toolId: echo.toolId,
      implementationKind: 'built-in',
      execute: () => ({ text: 'ok' }),
    });
    broker.startTurn(context, 'mock');
    const late = createToolDefinition({
      ...echo,
      toolId: createToolId({ provider: 'builtin', namespace: 'late', name: 'echo', version: '1' }),
      providerName: 'late_echo',
    });
    registry.register(late);
    broker.registerImplementation({
      toolId: late.toolId,
      implementationKind: 'built-in',
      execute: () => ({ text: 'late' }),
    });

    await expect(
      broker.dispatch({
        taskId: 'task-1',
        turnId: 'turn-1',
        callId: 'call-1',
        providerName: 'late_echo',
        input: {},
      }),
    ).rejects.toThrow('Tool name is not present in the Turn catalog');
    const next = broker.startTurn({ ...context, turnId: 'turn-2' }, 'mock');
    expect(next.entries.some(({ providerName }) => providerName === 'late_echo')).toBe(true);
  });

  it('does not expose an implementation registered after the Turn snapshot', async () => {
    const { registry, echo, command } = createRegistry();
    const broker = new ToolBroker(registry, () => 3, authorizePure);
    broker.registerImplementation({
      toolId: echo.toolId,
      implementationKind: 'built-in',
      execute: () => ({ text: 'ok' }),
    });
    const first = broker.startTurn(context, 'mock');
    expect(first.entries.some(({ toolId }) => toolId === command.toolId)).toBe(false);
    broker.registerImplementation({
      toolId: command.toolId,
      implementationKind: 'command-runner',
      execute: () => ({ status: 'late' }),
    });
    await expect(
      broker.dispatch({
        taskId: 'task-1',
        turnId: 'turn-1',
        callId: 'call-1',
        providerName: 'run_command',
        input: { executable: '/bin/echo', argv: [] },
      }),
    ).rejects.toThrow('not present in the Turn catalog');
    const second = broker.startTurn({ ...context, turnId: 'turn-2' }, 'mock');
    expect(second.entries.some(({ toolId }) => toolId === command.toolId)).toBe(true);
  });

  it('registers CommandRunner through the same broker but keeps it fail-closed until Slice 4.4', async () => {
    const { registry, command } = createRegistry();
    const broker = new ToolBroker(registry, () => 3, authorizeAll);
    broker.registerImplementation({
      toolId: command.toolId,
      implementationKind: 'command-runner',
      execute: () => {
        throw new Error('CommandRunner execution boundary is not available');
      },
    });
    broker.startTurn(context, 'mock');

    await expect(
      broker.dispatch({
        taskId: 'task-1',
        turnId: 'turn-1',
        callId: 'call-1',
        providerName: 'run_command',
        input: { executable: '/bin/echo', argv: ['ok'] },
      }),
    ).rejects.toThrow('CommandRunner execution boundary is not available');
  });

  it('rejects implementation-kind mismatches and cross-Turn dispatch', async () => {
    const { registry, echo } = createRegistry();
    const broker = new ToolBroker(registry, () => 3, authorizePure);
    expect(() =>
      broker.registerImplementation({
        toolId: echo.toolId,
        implementationKind: 'command-runner',
        execute: () => null,
      }),
    ).toThrow('implementation kind does not match');
    broker.startTurn(context, 'mock');
    await expect(
      broker.dispatch({
        taskId: 'task-1',
        turnId: 'turn-other',
        callId: 'call-1',
        providerName: 'mock_echo',
        input: {},
      }),
    ).rejects.toThrow('No ToolCatalogSnapshot is bound to this Turn');
  });

  it('validates model input and implementation output against the pinned schemas', async () => {
    const { registry, echo } = createRegistry();
    const broker = new ToolBroker(registry, () => 3, authorizePure);
    broker.registerImplementation({
      toolId: echo.toolId,
      implementationKind: 'built-in',
      execute: () => ({ unexpected: true }),
    });
    broker.startTurn(context, 'mock');
    await expect(
      broker.dispatch({
        taskId: 'task-1',
        turnId: 'turn-1',
        callId: 'call-1',
        providerName: 'mock_echo',
        input: { text: 42 },
      }),
    ).rejects.toThrow('Tool input does not match');
    await expect(
      broker.dispatch({
        taskId: 'task-1',
        turnId: 'turn-1',
        callId: 'call-2',
        providerName: 'mock_echo',
        input: { text: 'ok' },
      }),
    ).rejects.toThrow('Tool output does not match');
  });

  it('rejects dispatch when the Task policy epoch changes after the Turn snapshot', async () => {
    const { registry, echo } = createRegistry();
    let currentEpoch = 3;
    const broker = new ToolBroker(registry, () => currentEpoch, authorizePure);
    broker.registerImplementation({
      toolId: echo.toolId,
      implementationKind: 'built-in',
      execute: () => ({ text: 'unsafe' }),
    });
    broker.startTurn(context, 'mock');
    currentEpoch = 4;
    await expect(
      broker.dispatch({
        taskId: 'task-1',
        turnId: 'turn-1',
        callId: 'call-1',
        providerName: 'mock_echo',
        input: { text: 'blocked' },
      }),
    ).rejects.toThrow('policy epoch changed');
  });

  it('rechecks policy epoch after asynchronous authorization before execution', async () => {
    const { registry, echo } = createRegistry();
    let currentEpoch = 3;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let executed = false;
    const broker = new ToolBroker(
      registry,
      () => currentEpoch,
      async () => {
        await gate;
        return { decision: 'allow', reason: 'approved' };
      },
    );
    broker.registerImplementation({
      toolId: echo.toolId,
      implementationKind: 'built-in',
      execute: () => {
        executed = true;
        return { text: 'unsafe' };
      },
    });
    broker.startTurn(context, 'mock');
    const dispatch = broker.dispatch({
      taskId: 'task-1',
      turnId: 'turn-1',
      callId: 'call-1',
      providerName: 'mock_echo',
      input: { text: 'approved' },
    });
    currentEpoch = 4;
    release();

    await expect(dispatch).rejects.toThrow('policy epoch changed');
    expect(executed).toBe(false);
  });

  it('pins and freezes tool input before asynchronous authorization', async () => {
    const { registry, echo } = createRegistry();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let executedInput: unknown;
    const broker = new ToolBroker(
      registry,
      () => 3,
      async ({ input }) => {
        expect(Object.isFrozen(input)).toBe(true);
        await gate;
        return { decision: 'allow', reason: 'approved' };
      },
    );
    broker.registerImplementation({
      toolId: echo.toolId,
      implementationKind: 'built-in',
      execute: (input) => {
        executedInput = input;
        return input;
      },
    });
    broker.startTurn(context, 'mock');
    const mutableInput = { text: 'approved' };
    const dispatch = broker.dispatch({
      taskId: 'task-1',
      turnId: 'turn-1',
      callId: 'call-1',
      providerName: 'mock_echo',
      input: mutableInput,
    });
    mutableInput.text = 'mutated';
    release();

    await expect(dispatch).resolves.toEqual({ text: 'approved' });
    expect(executedInput).toEqual({ text: 'approved' });
    expect(Object.isFrozen(executedInput)).toBe(true);
  });

  it('does not execute after the Turn ends during asynchronous authorization', async () => {
    const { registry, echo } = createRegistry();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let executed = false;
    const broker = new ToolBroker(
      registry,
      () => 3,
      async () => {
        await gate;
        return { decision: 'allow', reason: 'approved' };
      },
    );
    broker.registerImplementation({
      toolId: echo.toolId,
      implementationKind: 'built-in',
      execute: () => {
        executed = true;
        return { text: 'unsafe' };
      },
    });
    broker.startTurn(context, 'mock');
    const dispatch = broker.dispatch({
      taskId: 'task-1',
      turnId: 'turn-1',
      callId: 'call-1',
      providerName: 'mock_echo',
      input: { text: 'approved' },
    });
    broker.finishTurn('task-1', 'turn-1');
    release();

    await expect(dispatch).rejects.toThrow('Turn ended during authorization');
    expect(executed).toBe(false);
  });

  it('claims each callId once and rejects replay, concurrent duplicates, and finished Turns', async () => {
    const { registry, echo } = createRegistry();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const broker = new ToolBroker(
      registry,
      () => 3,
      async () => {
        await gate;
        return { decision: 'allow', reason: 'approved' };
      },
    );
    broker.registerImplementation({
      toolId: echo.toolId,
      implementationKind: 'built-in',
      execute: (input) => input,
    });
    broker.startTurn(context, 'mock');
    const first = broker.dispatch({
      taskId: 'task-1',
      turnId: 'turn-1',
      callId: 'same-call',
      providerName: 'mock_echo',
      input: { text: 'once' },
    });
    await expect(
      broker.dispatch({
        taskId: 'task-1',
        turnId: 'turn-1',
        callId: 'same-call',
        providerName: 'mock_echo',
        input: { text: 'twice' },
      }),
    ).rejects.toThrow('Duplicate tool call id');
    release();
    await expect(first).resolves.toEqual({ text: 'once' });
    await expect(
      broker.dispatch({
        taskId: 'task-1',
        turnId: 'turn-1',
        callId: 'same-call',
        providerName: 'mock_echo',
        input: { text: 'replay' },
      }),
    ).rejects.toThrow('Duplicate tool call id');
    broker.finishTurn('task-1', 'turn-1');
    await expect(
      broker.dispatch({
        taskId: 'task-1',
        turnId: 'turn-1',
        callId: 'new-call',
        providerName: 'mock_echo',
        input: { text: 'late' },
      }),
    ).rejects.toThrow('No ToolCatalogSnapshot');
  });

  it('denies capability-bearing tools before invoking their implementation', async () => {
    const { registry, command } = createRegistry();
    let executed = false;
    const broker = new ToolBroker(registry, () => 3, authorizePure);
    broker.registerImplementation({
      toolId: command.toolId,
      implementationKind: 'command-runner',
      execute: () => {
        executed = true;
        return {};
      },
    });
    broker.startTurn(context, 'mock');
    await expect(
      broker.dispatch({
        taskId: 'task-1',
        turnId: 'turn-1',
        callId: 'call-1',
        providerName: 'run_command',
        input: { executable: '/bin/echo', argv: [] },
      }),
    ).rejects.toThrow('authorization deny');
    expect(executed).toBe(false);
  });

  it('rejects stale catalog binding and keeps MCP as an unconnected Public Beta interface', () => {
    const { registry } = createRegistry();
    const staleBroker = new ToolBroker(registry, () => 4, authorizePure);
    expect(() => staleBroker.startTurn(context, 'mock')).toThrow('stale policy epoch');

    const mcp = createToolDefinition({
      toolId: createToolId({ provider: 'mcp', namespace: 'example', name: 'lookup', version: '1' }),
      providerName: 'mcp_lookup',
      kind: 'network',
      schemaVersion: 1,
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      sideEffect: 'network',
      risk: 'medium',
      requiredCapabilities: ['network.fetch'],
      executionTarget: 'mcp-gateway',
      implementationKind: 'mcp-gateway',
      priority: 1,
      workspaceBinding: { kind: 'none' },
      providerCompatibility: ['mock'],
    });
    registry.register(mcp);
    const broker = new ToolBroker(registry, () => 3, authorizePure);
    expect(() =>
      broker.registerImplementation({
        toolId: mcp.toolId,
        implementationKind: 'mcp-gateway',
        execute: () => ({}),
      }),
    ).toThrow('reserved for Public Beta');
  });
});
