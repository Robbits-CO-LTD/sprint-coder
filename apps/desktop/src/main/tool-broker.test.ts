import { describe, expect, it } from 'vitest';
import {
  ToolRegistry,
  createToolDefinition,
  createToolId,
  type ToolExecutionContext,
} from '@sprint-coder/domain';
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
    let terminalized = false;
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
      authorizationDenied: () => {
        terminalized = true;
      },
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
    expect(terminalized).toBe(true);
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
    let terminalized = false;
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
      authorizationDenied: () => {
        terminalized = true;
      },
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
    expect(terminalized).toBe(true);
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

  it('terminalizes prepared input when execution revalidation throws', async () => {
    const { registry, command } = createRegistry();
    let terminalized = false;
    let executed = false;
    const broker = new ToolBroker(
      registry,
      () => 3,
      () => ({
        decision: 'allow',
        reason: 'test_allow',
        beforeExecute: () => {
          throw new Error('identity probe failed');
        },
      }),
    );
    broker.registerImplementation({
      toolId: command.toolId,
      implementationKind: 'command-runner',
      authorizationDenied: () => {
        terminalized = true;
      },
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
        callId: 'call-revalidation-throws',
        providerName: 'run_command',
        input: { executable: '/bin/echo', argv: [] },
      }),
    ).rejects.toThrow('identity probe failed');
    expect(terminalized).toBe(true);
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

  it('serializes process and mutation claims within one Turn', async () => {
    const { registry, command } = createRegistry();
    const broker = new ToolBroker(registry, () => 3, authorizeAll);
    let active = 0;
    let maximum = 0;
    broker.registerImplementation({
      toolId: command.toolId,
      implementationKind: 'command-runner',
      execute: async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return {};
      },
    });
    broker.startTurn(context, 'mock');
    await Promise.all([
      broker.dispatch({
        taskId: context.taskId,
        turnId: context.turnId,
        callId: 'command-one',
        providerName: 'run_command',
        input: { executable: '/bin/echo', argv: ['one'] },
      }),
      broker.dispatch({
        taskId: context.taskId,
        turnId: context.turnId,
        callId: 'command-two',
        providerName: 'run_command',
        input: { executable: '/bin/echo', argv: ['two'] },
      }),
    ]);
    expect(maximum).toBe(1);
  });

  it('derives independent scheduler keys from prepared tool input', async () => {
    const { registry, command } = createRegistry();
    const broker = new ToolBroker(registry, () => 3, authorizeAll);
    let active = 0;
    let maximum = 0;
    broker.registerImplementation({
      toolId: command.toolId,
      implementationKind: 'command-runner',
      resourceClaims: (input) => [
        {
          key: `workspace:${(input as { argv: string[] }).argv[0]}`,
          mode: 'write',
        },
      ],
      execute: async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return {};
      },
    });
    broker.startTurn(context, 'mock');
    await Promise.all([
      broker.dispatch({
        taskId: context.taskId,
        turnId: context.turnId,
        callId: 'independent-one',
        providerName: 'run_command',
        input: { executable: '/bin/echo', argv: ['root-a'] },
      }),
      broker.dispatch({
        taskId: context.taskId,
        turnId: context.turnId,
        callId: 'independent-two',
        providerName: 'run_command',
        input: { executable: '/bin/echo', argv: ['root-b'] },
      }),
    ]);
    expect(maximum).toBe(2);
  });

  it('returns concurrently completed results to the Runtime in call ordinal order', async () => {
    const { registry, echo } = createRegistry();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const broker = new ToolBroker(registry, () => 3, authorizePure);
    broker.registerImplementation({
      toolId: echo.toolId,
      implementationKind: 'built-in',
      execute: async (input) => {
        const value = input as { text: string };
        if (value.text === 'first') await firstGate;
        return value;
      },
    });
    broker.startTurn(context, 'mock');
    const returned: string[] = [];
    const first = broker
      .dispatch({
        taskId: context.taskId,
        turnId: context.turnId,
        callId: 'ordered-1',
        providerName: 'mock_echo',
        input: { text: 'first' },
      })
      .then(() => returned.push('first'));
    const second = broker
      .dispatch({
        taskId: context.taskId,
        turnId: context.turnId,
        callId: 'ordered-2',
        providerName: 'mock_echo',
        input: { text: 'second' },
      })
      .then(() => returned.push('second'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(returned).toEqual([]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(returned).toEqual(['first', 'second']);
  });

  it('bounds parallel read-only tool execution', async () => {
    const { registry, echo } = createRegistry();
    let active = 0;
    let maximum = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const broker = new ToolBroker(registry, () => 3, authorizePure);
    broker.registerImplementation({
      toolId: echo.toolId,
      implementationKind: 'built-in',
      execute: async (input) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await gate;
        active -= 1;
        return input;
      },
    });
    broker.startTurn(context, 'mock');
    const calls = Array.from({ length: 9 }, (_, index) =>
      broker.dispatch({
        taskId: context.taskId,
        turnId: context.turnId,
        callId: `bounded-${index}`,
        providerName: 'mock_echo',
        input: { text: String(index) },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(maximum).toBe(8);
    release();
    await Promise.all(calls);
  });

  it('enforces sealed output metadata without inferring background authority for other tools', async () => {
    const { registry, echo, command } = createRegistry();
    const broker = new ToolBroker(registry, () => 3, authorizeAll);
    broker.registerImplementation({
      toolId: echo.toolId,
      implementationKind: 'built-in',
      execute: () => ({ text: 'x'.repeat(1024 * 1024) }),
    });
    broker.registerImplementation({
      toolId: command.toolId,
      implementationKind: 'command-runner',
      execute: () => ({ state: 'running', sessionId: 'forged-session' }),
    });
    broker.startTurn(context, 'mock');
    await expect(
      broker.dispatch({
        taskId: context.taskId,
        turnId: context.turnId,
        callId: 'oversized-output',
        providerName: 'mock_echo',
        input: { text: 'go' },
      }),
    ).rejects.toThrow('pinned output limit');
    await expect(
      broker.dispatch({
        taskId: context.taskId,
        turnId: context.turnId,
        callId: 'forged-background',
        providerName: 'run_command',
        input: { executable: '/bin/echo', argv: [] },
      }),
    ).resolves.toEqual({ state: 'running', sessionId: 'forged-session' });
  });

  it('emits one ordered terminal lifecycle for a successful managed call', async () => {
    const { registry, echo } = createRegistry();
    const states: string[] = [];
    const broker = new ToolBroker(
      registry,
      () => 3,
      authorizePure,
      (event) => states.push(event.state),
    );
    broker.registerImplementation({
      toolId: echo.toolId,
      implementationKind: 'built-in',
      execute: (input) => input,
    });
    broker.startTurn(context, 'mock');
    await broker.dispatch({
      taskId: context.taskId,
      turnId: context.turnId,
      callId: 'lifecycle-one',
      providerName: 'mock_echo',
      input: { text: 'ok' },
    });
    expect(states).toEqual([
      'requested',
      'prepared',
      'awaiting_approval',
      'queued',
      'running',
      'succeeded',
    ]);
  });

  it('replaces a hostile raw result before generic schema and size inspection', async () => {
    const { registry, echo } = createRegistry();
    const raw = Object.defineProperties(
      {},
      {
        text: {
          enumerable: true,
          get: () => {
            throw new Error('raw text getter must stay private');
          },
        },
        toJSON: {
          get: () => {
            throw new Error('raw JSON serialization must stay private');
          },
        },
      },
    );
    const broker = new ToolBroker(registry, () => 3, authorizePure);
    broker.registerImplementation({
      toolId: echo.toolId,
      implementationKind: 'built-in',
      execute: () => raw,
    });
    broker.startTurn(context, 'mock');

    await expect(
      broker.dispatch(
        {
          taskId: context.taskId,
          turnId: context.turnId,
          callId: 'private-result',
          providerName: 'mock_echo',
          input: { text: 'go' },
        },
        (result) => {
          expect(result).toBe(raw);
          return { text: 'metadata only' };
        },
      ),
    ).resolves.toEqual({ text: 'metadata only' });
  });

  it('validates consumer metadata and keeps ordinary dispatch ordering unchanged', async () => {
    const { registry, echo } = createRegistry();
    const states: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const broker = new ToolBroker(
      registry,
      () => 3,
      authorizePure,
      ({ callId, state }) => states.push(`${callId}:${state}`),
    );
    broker.registerImplementation({
      toolId: echo.toolId,
      implementationKind: 'built-in',
      execute: async (input) => {
        if ((input as { text: string }).text === 'first') await firstBlocked;
        return input;
      },
      resourceClaims: () => [{ key: 'parallel', mode: 'read' }],
    });
    broker.startTurn(context, 'mock');
    const first = broker.dispatch({
      taskId: context.taskId,
      turnId: context.turnId,
      callId: 'ordinary-first',
      providerName: 'mock_echo',
      input: { text: 'first' },
    });
    const second = broker.dispatch({
      taskId: context.taskId,
      turnId: context.turnId,
      callId: 'ordinary-second',
      providerName: 'mock_echo',
      input: { text: 'second' },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(states).toContain('ordinary-second:succeeded');
    releaseFirst();
    await Promise.all([first, second]);

    await expect(
      broker.dispatch(
        {
          taskId: context.taskId,
          turnId: context.turnId,
          callId: 'invalid-consumer-metadata',
          providerName: 'mock_echo',
          input: { text: 'raw' },
        },
        () => ({ wrong: true }),
      ),
    ).rejects.toThrow('pinned schema');
    await expect(
      broker.dispatch(
        {
          taskId: context.taskId,
          turnId: context.turnId,
          callId: 'large-consumer-metadata',
          providerName: 'mock_echo',
          input: { text: 'raw' },
        },
        () => ({ text: 'x'.repeat(1024 * 1024) }),
      ),
    ).rejects.toThrow('pinned output limit');
  });

  it('cancels after ordered consumer completion without a success or double completion', async () => {
    const { registry, echo } = createRegistry();
    const states: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const broker = new ToolBroker(
      registry,
      () => 3,
      authorizePure,
      ({ callId, state }) => states.push(`${callId}:${state}`),
    );
    broker.registerImplementation({
      toolId: echo.toolId,
      implementationKind: 'built-in',
      execute: async (input) => {
        if ((input as { text: string }).text === 'first') await firstBlocked;
        return input;
      },
      resourceClaims: () => [{ key: 'parallel', mode: 'read' }],
    });
    broker.startTurn(context, 'mock');
    const first = broker.dispatch({
      taskId: context.taskId,
      turnId: context.turnId,
      callId: 'gate-first',
      providerName: 'mock_echo',
      input: { text: 'first' },
    });
    const controller = new AbortController();
    const consumed: string[] = [];
    const second = broker.dispatch(
      {
        taskId: context.taskId,
        turnId: context.turnId,
        callId: 'gate-second',
        providerName: 'mock_echo',
        input: { text: 'second' },
        signal: controller.signal,
      },
      (result) => {
        consumed.push((result as { text: string }).text);
        return result;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(consumed).toEqual(['second']);
    controller.abort(new Error('canceled at ordered result gate'));
    releaseFirst();
    await first;
    await expect(second).rejects.toThrow('canceled at ordered result gate');
    expect(states).toContain('gate-second:canceled');
    expect(states).not.toContain('gate-second:succeeded');

    await expect(
      broker.dispatch({
        taskId: context.taskId,
        turnId: context.turnId,
        callId: 'gate-third',
        providerName: 'mock_echo',
        input: { text: 'third' },
      }),
    ).resolves.toEqual({ text: 'third' });
  });
});
