import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TeamEnvelope } from '@sprint-coder/domain';
import type { AgentRecord } from './persistence';

const runtimeHostMock = vi.hoisted(() => ({
  starts: [] as Array<{ kind: 'claude' | 'codex'; args: unknown[] }>,
  waitForExit: vi.fn<(turnId: string) => Promise<void>>(async (_turnId: string) => undefined),
  startSucceeds: true,
  failures: new Map<
    'claude' | 'codex',
    {
      code: 'RUNTIME_RATE_LIMIT' | 'RUNTIME_UNAVAILABLE';
      userMessage: string;
      retryable: boolean;
      retryAt?: string;
      defer?: boolean;
      emitOperation?: boolean;
      emitReadOperation?: boolean;
    }
  >(),
}));

vi.mock('./runtime-host', () => ({
  RuntimeHostClient: class {
    constructor(
      private readonly onEvent: (taskId: string, turnId: string, event: unknown) => void,
      private readonly onFailure: (
        taskId: string,
        turnId: string,
        error: {
          code: 'RUNTIME_RATE_LIMIT' | 'RUNTIME_UNAVAILABLE';
          userMessage: string;
          retryable: boolean;
          retryAt?: string;
        },
      ) => void,
      _prepareContext?: unknown,
      _onContextAccepted?: unknown,
      private readonly kind: 'claude' | 'codex' = 'codex',
    ) {}

    async probe(): Promise<{ available: boolean; readiness: 'ready'; models: never[] }> {
      return { available: true, readiness: 'ready', models: [] };
    }

    start(...args: unknown[]): boolean {
      runtimeHostMock.starts.push({ kind: this.kind, args });
      const taskId = args[0] as string;
      const turnId = args[1] as string;
      const failure = runtimeHostMock.failures.get(this.kind);
      if (failure !== undefined) {
        if (failure.emitOperation === true)
          this.onEvent(taskId, turnId, {
            type: 'operation',
            phase: 'tool_call_start',
            label: 'Claude tool call started (mcp__team__team_hire)',
            sideEffect: true,
          });
        if (failure.emitReadOperation === true)
          this.onEvent(taskId, turnId, {
            type: 'operation',
            phase: 'tool_call_start',
            label: 'Claude tool call started (Read)',
            sideEffect: false,
          });
        if (failure.defer === true) queueMicrotask(() => this.onFailure(taskId, turnId, failure));
        else this.onFailure(taskId, turnId, failure);
        return true;
      }
      if (!runtimeHostMock.startSucceeds) {
        this.onFailure(taskId, turnId, {
          code: 'RUNTIME_UNAVAILABLE',
          userMessage: 'runtime unavailable',
          retryable: false,
        });
        return false;
      }
      this.onEvent(taskId, turnId, { type: 'delta', delta: '完了' });
      this.onEvent(taskId, turnId, { type: 'completed' });
      return true;
    }

    async cancel(): Promise<{ turnId: string; forced: false; stoppedAt: string }> {
      return { turnId: 'turn', forced: false, stoppedAt: new Date().toISOString() };
    }
    waitForTurnExit(turnId: string): Promise<void> {
      return runtimeHostMock.waitForExit(turnId);
    }
    dispose(): void {}
  },
}));

import {
  RuntimeHostTeamWorkerRuntime,
  applyWorkerContextInheritance,
  buildInheritedWorkerContext,
  TeamRuntimeAvailabilityTracker,
  type TeamWorkerRuntimeDeps,
} from './team-worker-runtime';
import type { RuntimeTeamMcpOption } from '../runtime-host/protocol';
import { TEAM_CORE_MCP_TOOL_NAMES } from '../runtime-host/team-mcp-tool-contract';

afterEach(() => {
  runtimeHostMock.failures.clear();
  runtimeHostMock.startSucceeds = true;
  runtimeHostMock.waitForExit.mockReset();
  runtimeHostMock.waitForExit.mockResolvedValue(undefined);
});

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
    teamMcpFor?: () => RuntimeTeamMcpOption | undefined;
    releaseTeamMcp?: (turnId: string) => void;
    contextFor?: TeamWorkerRuntimeDeps['contextFor'];
    writeScopeFor?: TeamWorkerRuntimeDeps['writeScopeFor'];
    authorizeEgress?: TeamWorkerRuntimeDeps['authorizeEgress'];
    selectRuntimes?: TeamWorkerRuntimeDeps['selectRuntimes'];
    availability?: TeamRuntimeAvailabilityTracker;
    catalogFor?: TeamWorkerRuntimeDeps['catalogFor'];
  } = {},
): RuntimeHostTeamWorkerRuntime {
  return new RuntimeHostTeamWorkerRuntime({
    selectRuntimes:
      overrides.selectRuntimes ?? (() => [{ kind: 'claude', model: 'claude-opus-5' }]),
    availability: overrides.availability ?? new TeamRuntimeAvailabilityTracker(),
    workspaceFor: () => '/workspace',
    catalogFor: overrides.catalogFor ?? (() => ({ tools: [] })),
    authorizeEgress: overrides.authorizeEgress ?? (() => true),
    ...(overrides.teamMcpFor === undefined ? {} : { teamMcpFor: overrides.teamMcpFor }),
    ...(overrides.releaseTeamMcp === undefined ? {} : { releaseTeamMcp: overrides.releaseTeamMcp }),
    ...(overrides.contextFor === undefined ? {} : { contextFor: overrides.contextFor }),
    ...(overrides.writeScopeFor === undefined ? {} : { writeScopeFor: overrides.writeScopeFor }),
  });
}

describe('RuntimeHostTeamWorkerRuntime Manager MCP', () => {
  it('does not start a Worker stopped while its tool catalog is preparing', async () => {
    let releaseCatalog!: (value: { tools: never[] }) => void;
    const catalog = new Promise<{ tools: never[] }>((resolve) => {
      releaseCatalog = resolve;
    });
    const catalogFor = vi.fn(() => catalog);
    const subject = runtime({ catalogFor });
    const pending = subject.execute({ worker: worker(false), envelope, content: 'test' });
    const outcome = pending.then(
      () => 'completed',
      () => 'stopped',
    );
    await vi.waitFor(() => expect(catalogFor).toHaveBeenCalled());
    await subject.stop('worker-1');
    releaseCatalog({ tools: [] });
    expect(await outcome).toBe('stopped');
    expect(runtimeHostMock.starts).toHaveLength(0);
    subject.dispose();
  });
  it('re-enables a runtime after a short retry delay when no reset time is known', () => {
    const availability = new TeamRuntimeAvailabilityTracker();
    const unavailableAt = Date.parse('2026-08-09T12:00:00.000Z');

    availability.markUnavailable('claude', undefined, unavailableAt);

    expect(availability.isAvailable('claude', unavailableAt + 59_999)).toBe(false);
    expect(availability.isAvailable('claude', unavailableAt + 60_000)).toBe(true);
  });

  it('falls back to another available AI and suppresses the rate-limited runtime until reset', async () => {
    runtimeHostMock.starts.length = 0;
    runtimeHostMock.failures.set('claude', {
      code: 'RUNTIME_RATE_LIMIT',
      userMessage: 'Claude Codeの利用上限に達しました。',
      retryable: false,
      retryAt: '2099-08-10T02:00:00.000Z',
    });
    const availability = new TeamRuntimeAvailabilityTracker();
    const activities: string[] = [];
    const teamMcpFor = vi.fn(() => ({
      socketPath: '/tmp/team.sock',
      token: 'manager-token',
      guidance: 'manager guidance',
      toolNames: TEAM_CORE_MCP_TOOL_NAMES,
    }));
    const releaseTeamMcp = vi.fn();
    const subject = runtime({
      availability,
      teamMcpFor,
      releaseTeamMcp,
      selectRuntimes: () => [
        { kind: 'claude', model: 'claude-sonnet-5' },
        { kind: 'codex', model: 'gpt-5.6-terra' },
      ],
    });

    const result = await subject.execute({
      worker: worker(true),
      envelope,
      content: '部下へ再委譲する',
      onEvent: (event) => {
        if (event.type === 'activity') activities.push(event.label);
      },
    });

    expect(runtimeHostMock.starts.map(({ kind }) => kind)).toEqual(['claude', 'codex']);
    expect(result.resolution).toEqual({
      resolvedProvider: 'openai',
      resolvedModel: 'gpt-5.6-terra',
    });
    expect(activities).toContain('Codexへfallbackして続行');
    expect(teamMcpFor).toHaveBeenCalledTimes(2);
    expect(releaseTeamMcp).toHaveBeenCalledTimes(2);
    expect(availability.isAvailable('claude', Date.parse('2099-08-10T01:59:59.000Z'))).toBe(false);
    expect(availability.isAvailable('claude', Date.parse('2099-08-10T02:00:00.000Z'))).toBe(true);
  });

  it('does not retry a workspace-write task after the runtime has started', async () => {
    runtimeHostMock.starts.length = 0;
    runtimeHostMock.failures.set('claude', {
      code: 'RUNTIME_UNAVAILABLE',
      userMessage: 'Claude runtimeが途中で利用不能になりました。',
      retryable: false,
      defer: true,
    });
    const subject = runtime({
      writeScopeFor: () => 'workspace-write',
      selectRuntimes: () => [
        { kind: 'claude', model: 'claude-sonnet-5' },
        { kind: 'codex', model: 'gpt-5.6-terra' },
      ],
    });

    await expect(
      subject.execute({
        worker: { ...worker(false), writeCapable: true },
        envelope: { ...envelope, targetAgentId: 'worker-1' },
        content: '実装する',
        accessMode: 'workspace-write',
      }),
    ).rejects.toThrow('Claude runtimeが途中で利用不能になりました。');

    expect(runtimeHostMock.starts.map(({ kind }) => kind)).toEqual(['claude']);
  });

  it('does not retry a read-only task after a Team MCP operation may have side effects', async () => {
    runtimeHostMock.starts.length = 0;
    runtimeHostMock.failures.set('claude', {
      code: 'RUNTIME_RATE_LIMIT',
      userMessage: 'Claude Codeの利用上限に達しました。',
      retryable: false,
      defer: true,
      emitOperation: true,
    });
    const subject = runtime({
      teamMcpFor: () => ({
        socketPath: '/tmp/team.sock',
        token: 'manager-token',
        guidance: 'manager guidance',
        toolNames: TEAM_CORE_MCP_TOOL_NAMES,
      }),
      selectRuntimes: () => [
        { kind: 'claude', model: 'claude-sonnet-5' },
        { kind: 'codex', model: 'gpt-5.6-terra' },
      ],
    });

    await expect(
      subject.execute({
        worker: worker(true),
        envelope,
        content: '部下を採用する',
      }),
    ).rejects.toThrow('Claude Codeの利用上限に達しました。');

    expect(runtimeHostMock.starts.map(({ kind }) => kind)).toEqual(['claude']);
  });

  it('retries a read-only task after an operation without side effects', async () => {
    runtimeHostMock.starts.length = 0;
    runtimeHostMock.failures.set('claude', {
      code: 'RUNTIME_RATE_LIMIT',
      userMessage: 'Claude Codeの利用上限に達しました。',
      retryable: false,
      defer: true,
      emitReadOperation: true,
    });
    const subject = runtime({
      selectRuntimes: () => [
        { kind: 'claude', model: 'claude-sonnet-5' },
        { kind: 'codex', model: 'gpt-5.6-terra' },
      ],
    });

    await expect(
      subject.execute({
        worker: worker(false),
        envelope: { ...envelope, targetAgentId: 'worker-1' },
        content: '調査する',
      }),
    ).resolves.toMatchObject({
      resolution: { resolvedProvider: 'openai', resolvedModel: 'gpt-5.6-terra' },
    });

    expect(runtimeHostMock.starts.map(({ kind }) => kind)).toEqual(['claude', 'codex']);
  });

  it('fails immediately without waiting for exit when the runtime was not started', async () => {
    runtimeHostMock.startSucceeds = false;
    runtimeHostMock.waitForExit.mockClear();
    const subject = runtime();

    await expect(
      subject.execute({
        worker: worker(false),
        envelope: { ...envelope, targetAgentId: 'worker-1' },
        content: '実装する',
      }),
    ).rejects.toThrow('runtime unavailable');
    expect(runtimeHostMock.waitForExit).not.toHaveBeenCalled();
    runtimeHostMock.startSucceeds = true;
  });

  it('does not report Worker completion until the Codex process tree exits', async () => {
    let confirmExit: (() => void) | undefined;
    runtimeHostMock.waitForExit.mockImplementationOnce(
      () => new Promise<void>((resolve) => (confirmExit = resolve)),
    );
    const subject = runtime();
    let settled = false;
    const execution = subject
      .execute({
        worker: worker(false),
        envelope: { ...envelope, targetAgentId: 'worker-1' },
        content: '実装する',
      })
      .finally(() => {
        settled = true;
      });

    await vi.waitFor(() => expect(runtimeHostMock.waitForExit).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    confirmExit?.();
    await expect(execution).resolves.toMatchObject({ completion: { status: 'succeeded' } });
  });

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
        attachments: [],
        createdAt: '2026-07-28T00:00:00.000Z',
      },
    ]);
    const subject = runtime({
      contextFor: () => inherited,
      writeScopeFor: () => 'full',
    });

    await subject.execute({
      worker: writableWorker,
      envelope: { ...envelope, targetAgentId: writableWorker.id },
      content: '実装する',
      accessMode: 'workspace-write',
      workspacePath: '/isolated/worktree',
    });

    expect(runtimeHostMock.starts[0]?.args[3]).toBe('/isolated/worktree');
    expect(runtimeHostMock.starts[0]?.args[6]).toEqual(inherited);
    expect(runtimeHostMock.starts[0]?.args[9]).toBe('workspace-write');
    expect(runtimeHostMock.starts[0]?.args[2]).toContain('Workspace書き込み: 隔離範囲内で可');
    expect(runtimeHostMock.starts[0]?.args[2]).toContain('隔離worktree: /isolated/worktree');
    expect(runtimeHostMock.starts[0]?.args[11]).toMatchObject({
      text: expect.stringContaining('実行主体: subagent / write-capable'),
      digest: expect.any(String),
    });
  });

  it('passes the complete isolated root set while deriving policy from its Primary root', async () => {
    runtimeHostMock.starts.length = 0;
    const writeScopeFor = vi.fn(() => 'workspace-write' as const);
    const subject = runtime({ writeScopeFor });
    const writableWorker = { ...worker(false), writeCapable: true };
    const workspaceSet = {
      primaryRootId: 'root-primary',
      roots: [
        {
          rootId: 'root-primary',
          path: '/isolated/primary',
          label: 'primary',
          role: 'primary' as const,
        },
        {
          rootId: 'root-secondary',
          path: '/isolated/secondary',
          label: 'secondary',
          role: 'secondary' as const,
        },
      ],
      digest: 'a'.repeat(64),
    };

    await subject.execute({
      worker: writableWorker,
      envelope: { ...envelope, targetAgentId: writableWorker.id },
      content: '両方を変更する',
      accessMode: 'workspace-write',
      workspaceSet,
    });

    expect(runtimeHostMock.starts[0]?.args[3]).toEqual(workspaceSet);
    expect(writeScopeFor).toHaveBeenCalledWith(
      expect.objectContaining({ id: writableWorker.id }),
      '/isolated/primary',
    );
    expect(runtimeHostMock.starts[0]?.args[2]).toContain(
      '隔離root: primary=/isolated/primary, secondary=/isolated/secondary',
    );
  });

  it('reserves every sealed Project item and binds context lookup to the durable execution', async () => {
    runtimeHostMock.starts.length = 0;
    const contextFor = vi.fn(() => ({
      fragments: [],
      projectItems: [
        {
          id: 'project:one:instruction',
          kind: 'instruction' as const,
          authority: 'user' as const,
          localOnly: false,
          content: 'Keep the public API stable.',
          sealedDigest: 'a'.repeat(64),
          sourceTaskId: null,
          sourceTurnId: null,
          sourceReferenceId: null,
          capturedAt: '2026-07-31T00:00:00.000Z',
        },
        {
          id: 'project:one:reference:one',
          kind: 'reference' as const,
          authority: 'none' as const,
          localOnly: false,
          content: 'Untrusted reference data.',
          sealedDigest: 'b'.repeat(64),
          sourceTaskId: 'source-task',
          sourceTurnId: null,
          sourceReferenceId: 'reference-one',
          capturedAt: '2026-07-31T00:00:01.000Z',
        },
      ],
      projectSnapshotDigest: 'c'.repeat(64),
      usageEvents: [],
      compacted: false,
    }));
    const authorizeEgress = vi.fn(() => true);
    const subject = runtime({ contextFor, authorizeEgress });

    await subject.execute({
      worker: worker(false),
      envelope: { ...envelope, targetAgentId: 'worker-1' },
      executionId: 'execution-durable-1',
      content: '実装する',
    });

    expect(contextFor).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'worker-1' }),
      'execution-durable-1',
    );
    expect(authorizeEgress).toHaveBeenCalledWith(
      'claude',
      'task-1',
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        projectItems: [
          expect.objectContaining({ id: 'project:one:instruction' }),
          expect.objectContaining({ id: 'project:one:reference:one' }),
        ],
      }),
    );
    expect(runtimeHostMock.starts[0]?.args[6]).toMatchObject({
      projectItems: [{ id: 'project:one:instruction' }, { id: 'project:one:reference:one' }],
    });
  });

  it('fails explicitly before dispatch rather than silently subsetting oversized Project items', async () => {
    runtimeHostMock.starts.length = 0;
    const authorizeEgress = vi.fn(() => true);
    const subject = runtime({
      authorizeEgress,
      contextFor: () => ({
        fragments: [],
        projectItems: [
          {
            id: 'oversized-project-item',
            kind: 'reference',
            authority: 'none',
            localOnly: false,
            content: 'x'.repeat(64 * 1024 + 1),
            sealedDigest: 'd'.repeat(64),
            sourceTaskId: 'source-task',
            sourceTurnId: null,
            sourceReferenceId: 'reference-one',
            capturedAt: '2026-07-31T00:00:00.000Z',
          },
        ],
        projectSnapshotDigest: 'e'.repeat(64),
        usageEvents: [],
        compacted: false,
      }),
    });

    await expect(
      subject.execute({
        worker: worker(false),
        envelope: { ...envelope, targetAgentId: 'worker-1' },
        executionId: 'execution-over-budget',
        content: '実装する',
      }),
    ).rejects.toThrow('Inherited Project context cannot fit the Worker protocol budget');
    expect(authorizeEgress).not.toHaveBeenCalled();
    expect(runtimeHostMock.starts).toHaveLength(0);
  });

  it('places the Agent own prior Team conversation before a tool-prohibited final instruction', async () => {
    runtimeHostMock.starts.length = 0;
    const subject = runtime();

    await subject.execute({
      worker: worker(false),
      envelope: { ...envelope, targetAgentId: 'worker-1' },
      content: 'すでに作成した論点を使って最終回答を書いてください。ツールは禁止です。',
      priorConversation: [
        { direction: 'received', role: 'Leader', content: 'AI便益論の論点を作成してください。' },
        { direction: 'sent', role: 'Leader', content: '便益は生産性向上と知識アクセスです。' },
      ],
    });

    const prompt = runtimeHostMock.starts[0]?.args[2] as string;
    expect(prompt).toContain('便益は生産性向上と知識アクセスです。');
    expect(prompt).toContain('この内容を取得し直すためにTeamツールを呼ぶ必要はありません。');
    expect(prompt.indexOf('便益は生産性向上と知識アクセスです。')).toBeLessThan(
      prompt.indexOf('依頼: すでに作成した論点を使って'),
    );
  });

  it('does not inherit context for none or unselected selected_items', () => {
    const messages = [
      {
        id: 'message-1',
        taskId: 'task-1',
        turnId: 'turn-1',
        author: 'user' as const,
        content: 'secret parent context',
        attachments: [],
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

  it('applies conversation policy without removing sealed Project items', () => {
    const sealed = {
      fragments: [
        {
          id: 'history-1',
          taskId: 'task-1',
          source: 'history' as const,
          trust: 'user' as const,
          tokenEstimate: 2,
          content: 'parent conversation',
          createdAt: '2026-07-31T00:00:00.000Z',
          messageId: 'message-1',
        },
      ],
      projectItems: [
        {
          id: 'project-item-1',
          kind: 'instruction' as const,
          authority: 'user' as const,
          localOnly: false,
          content: 'always inherited',
          sealedDigest: 'f'.repeat(64),
          sourceTaskId: null,
          sourceTurnId: null,
          sourceReferenceId: null,
          capturedAt: '2026-07-31T00:00:00.000Z',
        },
      ],
      projectSnapshotDigest: 'a'.repeat(64),
      usageEvents: [],
      compacted: false,
    };

    const inherited = applyWorkerContextInheritance(
      { ...worker(false), contextInheritancePolicy: 'none' },
      sealed,
    );
    expect(inherited.fragments).toEqual([]);
    expect(inherited.projectItems).toEqual(sealed.projectItems);
    expect(inherited.projectSnapshotDigest).toBe(sealed.projectSnapshotDigest);
  });

  it('passes a caller-bound MCP only to a Manager and releases it after the turn', async () => {
    runtimeHostMock.starts.length = 0;
    const releaseTeamMcp = vi.fn();
    const teamMcpFor = vi.fn(() => ({
      socketPath: '/tmp/team.sock',
      token: 'manager-token',
      guidance: 'manager guidance',
      toolNames: TEAM_CORE_MCP_TOOL_NAMES,
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
      undefined,
      expect.objectContaining({ entries: expect.any(Array), digest: expect.any(String) }),
    );
    expect(runtimeHostMock.starts).toHaveLength(1);
    expect(runtimeHostMock.starts[0]?.args[7]).toEqual({
      socketPath: '/tmp/team.sock',
      token: 'manager-token',
      guidance: 'manager guidance',
      toolNames: TEAM_CORE_MCP_TOOL_NAMES,
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
      undefined,
      expect.objectContaining({ entries: expect.any(Array), digest: expect.any(String) }),
    );
    expect(runtimeHostMock.starts[0]?.args[7]).toBeUndefined();

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
