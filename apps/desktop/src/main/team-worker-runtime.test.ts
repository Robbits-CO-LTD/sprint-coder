import { describe, expect, it, vi } from 'vitest';
import type { TeamEnvelope } from '@sprint-coder/domain';
import type { AgentRecord } from './persistence';

const runtimeHostMock = vi.hoisted(() => ({
  starts: [] as unknown[][],
}));

vi.mock('./runtime-host', () => ({
  RuntimeHostClient: class {
    constructor(
      private readonly onEvent: (taskId: string, turnId: string, event: unknown) => void,
    ) {}

    async probe(): Promise<{ available: boolean; models: never[] }> {
      return { available: true, models: [] };
    }

    start(...args: unknown[]): void {
      runtimeHostMock.starts.push(args);
      const taskId = args[0] as string;
      const turnId = args[1] as string;
      this.onEvent(taskId, turnId, { type: 'delta', delta: '完了' });
      this.onEvent(taskId, turnId, { type: 'completed' });
    }

    cancel(): void {}
    dispose(): void {}
  },
}));

import {
  RuntimeHostTeamWorkerRuntime,
  buildInheritedWorkerContext,
  type TeamWorkerRuntimeDeps,
} from './team-worker-runtime';

function worker(canDelegate: boolean): AgentRecord {
  return {
    id: canDelegate ? 'manager-1' : 'worker-1',
    teamId: 'team-1',
    threadId: 'thread-1',
    taskId: 'task-1',
    kind: 'worker',
    role: canDelegate ? 'Manager' : 'Worker',
    state: 'ready',
    objective: '担当作業',
    parentCapabilityCeiling: null,
    contextInheritancePolicy: 'summary',
    writeCapable: false,
    currentActivity: null,
    runtimeKind: 'claude',
    modelSelection: {
      connectionId: 'builtin:claude-cli',
      requestedProvider: 'anthropic',
      requestedModel: 'claude-opus-5',
    },
    parentAgentId: 'leader-1',
    depth: 1,
    canDelegate,
    managerPolicy: canDelegate
      ? { maxDirectChildren: 2, maxDelegationDepth: 3, allowManagerChildren: false }
      : null,
    blueprintRoleKey: null,
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
  };
}

const envelope: TeamEnvelope = {
  teamId: 'team-1',
  messageId: 'message-1',
  deliveryId: 'delivery-1',
  sourceAgentId: 'leader-1',
  targetAgentId: 'manager-1',
  sourceKind: 'leader',
  targetKind: 'worker',
  seq: 1,
  attempt: 1,
  issuedAt: '2026-07-28T00:00:00.000Z',
};

function runtime(
  overrides: {
    teamMcpFor?: () => { socketPath: string; token: string; guidance: string } | undefined;
    releaseTeamMcp?: (turnId: string) => void;
    contextFor?: TeamWorkerRuntimeDeps['contextFor'];
    writeScopeFor?: TeamWorkerRuntimeDeps['writeScopeFor'];
  } = {},
): RuntimeHostTeamWorkerRuntime {
  return new RuntimeHostTeamWorkerRuntime({
    selectRuntime: () => ({ kind: 'claude', model: 'claude-opus-5' }),
    workspaceFor: () => '/workspace',
    catalogFor: () => ({ tools: [] }),
    authorizeEgress: () => true,
    ...(overrides.teamMcpFor === undefined ? {} : { teamMcpFor: overrides.teamMcpFor }),
    ...(overrides.releaseTeamMcp === undefined ? {} : { releaseTeamMcp: overrides.releaseTeamMcp }),
    ...(overrides.contextFor === undefined ? {} : { contextFor: overrides.contextFor }),
    ...(overrides.writeScopeFor === undefined ? {} : { writeScopeFor: overrides.writeScopeFor }),
  });
}

describe('RuntimeHostTeamWorkerRuntime Manager MCP', () => {
  it('applies inherited context and write capability to the CLI turn', async () => {
    runtimeHostMock.starts.length = 0;
    const writableWorker = {
      ...worker(false),
      contextInheritancePolicy: 'full_fork' as const,
      writeCapable: true,
    };
    const inherited = buildInheritedWorkerContext(writableWorker, [
      {
        id: 'message-1',
        taskId: writableWorker.taskId,
        turnId: 'turn-1',
        author: 'user',
        content: '親Taskの要件',
        createdAt: '2026-07-28T00:00:00.000Z',
      },
    ]);
    const subject = runtime({
      contextFor: () => inherited,
      writeScopeFor: () => 'workspace-write',
    });

    await subject.execute({
      worker: writableWorker,
      envelope: { ...envelope, targetAgentId: writableWorker.id },
      content: '実装する',
    });

    expect(runtimeHostMock.starts[0]?.[6]).toEqual(inherited);
    expect(runtimeHostMock.starts[0]?.[9]).toBe('workspace-write');
    expect(runtimeHostMock.starts[0]?.[2]).toContain('Workspace書き込み: 許可範囲内で可');
  });

  it('does not inherit context for none or unselected selected_items', () => {
    const messages = [
      {
        id: 'message-1',
        taskId: 'task-1',
        turnId: 'turn-1',
        author: 'user' as const,
        content: 'secret parent context',
        createdAt: '2026-07-28T00:00:00.000Z',
      },
    ];
    expect(
      buildInheritedWorkerContext({ ...worker(false), contextInheritancePolicy: 'none' }, messages)
        .fragments,
    ).toEqual([]);
    expect(
      buildInheritedWorkerContext(
        { ...worker(false), contextInheritancePolicy: 'selected_items' },
        messages,
      ).fragments,
    ).toEqual([]);
  });

  it('passes a caller-bound MCP only to a Manager and releases it after the turn', async () => {
    runtimeHostMock.starts.length = 0;
    const releaseTeamMcp = vi.fn();
    const teamMcpFor = vi.fn(() => ({
      socketPath: '/tmp/team.sock',
      token: 'manager-token',
      guidance: 'manager guidance',
    }));
    const subject = runtime({ teamMcpFor, releaseTeamMcp });

    await subject.execute({
      worker: worker(true),
      envelope,
      content: '部下へ再委譲する',
    });

    expect(teamMcpFor).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'manager-1', canDelegate: true }),
      expect.any(String),
    );
    expect(runtimeHostMock.starts).toHaveLength(1);
    expect(runtimeHostMock.starts[0]?.[7]).toEqual({
      socketPath: '/tmp/team.sock',
      token: 'manager-token',
      guidance: 'manager guidance',
    });
    expect(releaseTeamMcp).toHaveBeenCalledWith(expect.any(String));
  });

  it('offers communication MCP to a leaf Worker and fails closed for an unbound Manager', async () => {
    runtimeHostMock.starts.length = 0;
    const teamMcpFor = vi.fn(() => undefined);
    const subject = runtime({ teamMcpFor });

    await subject.execute({
      worker: worker(false),
      envelope: { ...envelope, targetAgentId: 'worker-1' },
      content: '通常作業',
    });
    expect(teamMcpFor).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'worker-1', canDelegate: false }),
      expect.any(String),
    );
    expect(runtimeHostMock.starts[0]?.[7]).toBeUndefined();

    await expect(
      subject.execute({
        worker: worker(true),
        envelope,
        content: '再委譲',
      }),
    ).rejects.toThrow('Manager Team MCP is unavailable');
    expect(runtimeHostMock.starts).toHaveLength(1);
  });
});
