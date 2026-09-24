import { afterEach, describe, expect, it, vi } from 'vitest';
import { workerCompletionSchema } from '@sprint-coder/contracts';
import type { TeamEnvelope } from '@sprint-coder/domain';
import type { AgentRecord } from './persistence';
import { assessProviderEgressDisclosure } from './provider-disclosure-classifier';
import type * as PromptContextModule from './prompt-context';

const runtimeHostMock = vi.hoisted(() => ({
  starts: [] as Array<{ kind: 'claude' | 'codex' | 'grok'; args: unknown[] }>,
  waitForExit: vi.fn<(turnId: string) => Promise<void>>(async (_turnId: string) => undefined),
  startSucceeds: true,
  finalText: '完了',
  beforeComplete: null as ((turnId: string) => void) | null,
  failures: new Map<
    'claude' | 'codex' | 'grok',
    {
      code: 'RUNTIME_RATE_LIMIT' | 'RUNTIME_UNAVAILABLE' | 'RUNTIME_BILLING_REQUIRED';
      userMessage: string;
      retryable: boolean;
      retryAt?: string;
      defer?: boolean;
      emitOperation?: boolean;
      emitReadOperation?: boolean;
      diagnostic?: unknown;
    }
  >(),
}));

const promptContextMock = vi.hoisted(() => ({ compileFailure: null as string | null }));

vi.mock('./prompt-context', async (importOriginal) => {
  const actual = await importOriginal<typeof PromptContextModule>();
  return {
    ...actual,
    compilePromptGuidance: (...args: Parameters<typeof actual.compilePromptGuidance>) => {
      if (promptContextMock.compileFailure !== null)
        throw new Error(promptContextMock.compileFailure);
      return actual.compilePromptGuidance(...args);
    },
  };
});

vi.mock('./runtime-host', () => ({
  RuntimeHostClient: class {
    constructor(
      private readonly onEvent: (taskId: string, turnId: string, event: unknown) => void,
      private readonly onFailure: (
        taskId: string,
        turnId: string,
        error: {
          code: 'RUNTIME_RATE_LIMIT' | 'RUNTIME_UNAVAILABLE' | 'RUNTIME_BILLING_REQUIRED';
          userMessage: string;
          retryable: boolean;
          retryAt?: string;
        },
        diagnostic?: unknown,
      ) => void,
      _prepareContext?: unknown,
      _onContextAccepted?: unknown,
      private readonly kind: 'claude' | 'codex' | 'grok' = 'codex',
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
        if (failure.defer === true)
          queueMicrotask(() => this.onFailure(taskId, turnId, failure, failure.diagnostic));
        else this.onFailure(taskId, turnId, failure, failure.diagnostic);
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
      runtimeHostMock.beforeComplete?.(turnId);
      this.onEvent(taskId, turnId, { type: 'delta', delta: runtimeHostMock.finalText });
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
  chooseWorkerRuntime,
  type TeamWorkerRuntimeDeps,
} from './team-worker-runtime';
import {
  WorkerRuntimeExitUnconfirmedError,
  WorkerRuntimeFailureError,
  runtimeStopConfirmed,
} from './team-coordinator';
import type { RuntimeTeamMcpOption } from '../runtime-host/protocol';
import { runtimeWorkspaceSetFromLegacyPath } from '../runtime-host/protocol';
import { TEAM_CORE_MCP_TOOL_NAMES } from '../runtime-host/team-mcp-tool-contract';

afterEach(() => {
  runtimeHostMock.failures.clear();
  runtimeHostMock.startSucceeds = true;
  runtimeHostMock.finalText = '完了';
  runtimeHostMock.beforeComplete = null;
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
    releaseManagedTurn?: (turnId: string) => void;
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
    ...(overrides.releaseManagedTurn === undefined
      ? {}
      : { releaseManagedTurn: overrides.releaseManagedTurn }),
    ...(overrides.contextFor === undefined ? {} : { contextFor: overrides.contextFor }),
    ...(overrides.writeScopeFor === undefined ? {} : { writeScopeFor: overrides.writeScopeFor }),
  });
}

describe('RuntimeHostTeamWorkerRuntime Manager MCP', () => {
  it('selects Grok, uses Team MCP, resolves xai and passes no effort override', async () => {
    runtimeHostMock.starts.length = 0;
    expect(chooseWorkerRuntime('grok', 'grok-test-model', false)).toEqual({
      kind: 'grok',
      model: 'grok-test-model',
    });
    const teamMcp = {
      socketPath: '/tmp/grok-team.sock',
      token: 'fixture-token',
      guidance: 'Use the managed tools.',
      toolNames: TEAM_CORE_MCP_TOOL_NAMES,
    };
    const subject = runtime({
      selectRuntimes: () => [{ kind: 'grok', model: 'grok-test-model' }],
      teamMcpFor: () => teamMcp,
    });
    const result = await subject.execute({ worker: worker(true), envelope, content: 'test' });
    expect(result.resolution).toEqual({
      resolvedProvider: 'xai',
      resolvedModel: 'grok-test-model',
    });
    const start = runtimeHostMock.starts.at(-1)!;
    expect(start.kind).toBe('grok');
    expect(start.args[7]).toBe(teamMcp);
    expect(start.args[8]).toBeUndefined();
    expect(start.args[12]).toBeUndefined();
    subject.dispose();
    runtimeHostMock.starts.length = 0;
  });

  it('tracks Grok cooldown independently and allows retry after expiry', () => {
    const tracker = new TeamRuntimeAvailabilityTracker();
    tracker.markUnavailable('grok', undefined, 1000);
    expect(tracker.isAvailable('grok', 60999)).toBe(false);
    expect(tracker.isAvailable('claude', 1000)).toBe(true);
    expect(tracker.isAvailable('codex', 1000)).toBe(true);
    expect(tracker.isAvailable('grok', 61000)).toBe(true);
  });
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

  it('does not cool down Grok or switch runtimes when the balance is exhausted', async () => {
    runtimeHostMock.starts.length = 0;
    runtimeHostMock.failures.set('grok', {
      code: 'RUNTIME_BILLING_REQUIRED',
      userMessage: 'Grok Buildの利用残高が不足しています。残高を追加してから再試行してください。',
      retryable: false,
    });
    const availability = new TeamRuntimeAvailabilityTracker();
    const markUnavailable = vi.spyOn(availability, 'markUnavailable');
    const subject = runtime({
      availability,
      selectRuntimes: () => [
        { kind: 'grok', model: 'grok-4.5' },
        { kind: 'codex', model: 'gpt-5.6-terra' },
      ],
    });

    await expect(
      subject.execute({
        worker: worker(false),
        envelope: { ...envelope, targetAgentId: 'worker-1' },
        content: '調査する',
      }),
    ).rejects.toThrow('利用残高が不足');

    expect(runtimeHostMock.starts.map(({ kind }) => kind)).toEqual(['grok']);
    expect(markUnavailable).not.toHaveBeenCalled();
    expect(availability.isAvailable('grok')).toBe(true);
    expect(availability.isAvailable('codex')).toBe(true);
    subject.dispose();
  });

  it('passes the runtime failure diagnostic, kind, and runtime turn id to the Worker failure', async () => {
    runtimeHostMock.starts.length = 0;
    runtimeHostMock.failures.set('grok', {
      code: 'RUNTIME_BILLING_REQUIRED',
      userMessage: 'Grok Buildの利用残高が不足しています。残高を追加してから再試行してください。',
      retryable: false,
      diagnostic: {
        runtimeKind: 'grok',
        failureStage: 'billing_error',
        httpStatus: 402,
      },
    });
    const subject = runtime({
      selectRuntimes: () => [{ kind: 'grok', model: 'grok-4.5' }],
    });

    const error = await subject
      .execute({
        worker: worker(false),
        envelope: { ...envelope, targetAgentId: 'worker-1' },
        content: '調査する',
      })
      .then(
        () => {
          throw new Error('expected runtime failure');
        },
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(WorkerRuntimeFailureError);
    if (!(error instanceof WorkerRuntimeFailureError))
      throw new Error('expected WorkerRuntimeFailureError');
    expect(error.publicError.code).toBe('RUNTIME_BILLING_REQUIRED');
    expect(error.runtimeKind).toBe('grok');
    expect(error.runtimeTurnId).toBe(runtimeHostMock.starts[0]?.args[1]);
    expect(error.failureDiagnostic).toMatchObject({
      failureStage: 'billing_error',
      httpStatus: 402,
    });
    subject.dispose();
  });

  it('drops a failure diagnostic reported for a different runtime kind', async () => {
    runtimeHostMock.starts.length = 0;
    runtimeHostMock.failures.set('grok', {
      code: 'RUNTIME_BILLING_REQUIRED',
      userMessage: 'Grok Buildの利用残高が不足しています。残高を追加してから再試行してください。',
      retryable: false,
      diagnostic: {
        runtimeKind: 'codex',
        failureStage: 'protocol_error',
      },
    });
    const subject = runtime({
      selectRuntimes: () => [{ kind: 'grok', model: 'grok-4.5' }],
    });

    const error = await subject
      .execute({
        worker: worker(false),
        envelope: { ...envelope, targetAgentId: 'worker-1' },
        content: '調査する',
      })
      .then(
        () => {
          throw new Error('expected runtime failure');
        },
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(WorkerRuntimeFailureError);
    if (!(error instanceof WorkerRuntimeFailureError))
      throw new Error('expected WorkerRuntimeFailureError');
    expect(error.failureDiagnostic).toBeUndefined();
    subject.dispose();
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

  it('reports an unconfirmed process-tree exit as WorkerRuntimeExitUnconfirmedError', async () => {
    runtimeHostMock.waitForExit.mockRejectedValueOnce(
      new Error('Runtime process tree exit was not confirmed within 30 seconds'),
    );
    const subject = runtime();

    const error = await subject
      .execute({
        worker: worker(false),
        envelope: { ...envelope, targetAgentId: 'worker-1' },
        content: '実装する',
      })
      .then(
        () => {
          throw new Error('expected execute to reject');
        },
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(WorkerRuntimeExitUnconfirmedError);
    expect(error).toMatchObject({
      message: 'Runtime process tree exit was not confirmed within 30 seconds',
    });
    // The Turn itself completed, so there is no earlier failure to carry.
    expect(error).toHaveProperty('originalError', undefined);
    // It did run, so its own worktree must not be treated as free.
    expect(error).toHaveProperty('startRefused', false);
    subject.dispose();
  });

  it('reports a synchronously failing process-tree exit wait as WorkerRuntimeExitUnconfirmedError', async () => {
    runtimeHostMock.waitForExit.mockImplementationOnce(() => {
      throw new Error('Runtime host is disposed');
    });
    const subject = runtime();

    const error = await subject
      .execute({
        worker: worker(false),
        envelope: { ...envelope, targetAgentId: 'worker-1' },
        content: '実装する',
      })
      .then(
        () => {
          throw new Error('expected execute to reject');
        },
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(WorkerRuntimeExitUnconfirmedError);
    expect(error).toMatchObject({ message: 'Runtime host is disposed' });
    subject.dispose();
  });

  it('keeps the Turn failure and its diagnostic when that Turn exit is then unconfirmed', async () => {
    runtimeHostMock.starts.length = 0;
    runtimeHostMock.failures.set('grok', {
      code: 'RUNTIME_BILLING_REQUIRED',
      userMessage: 'Grok Buildの利用残高が不足しています。残高を追加してから再試行してください。',
      retryable: false,
      diagnostic: { runtimeKind: 'grok', failureStage: 'billing_error', httpStatus: 402 },
    });
    runtimeHostMock.waitForExit.mockRejectedValueOnce(
      new Error('Runtime process tree exit was not confirmed within 30 seconds'),
    );
    const subject = runtime({ selectRuntimes: () => [{ kind: 'grok', model: 'grok-4.5' }] });

    const error = await subject
      .execute({
        worker: worker(false),
        envelope: { ...envelope, targetAgentId: 'worker-1' },
        content: '調査する',
      })
      .then(
        () => {
          throw new Error('expected runtime failure');
        },
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(WorkerRuntimeExitUnconfirmedError);
    if (!(error instanceof WorkerRuntimeExitUnconfirmedError))
      throw new Error('expected WorkerRuntimeExitUnconfirmedError');
    expect(error.message).toBe('Runtime process tree exit was not confirmed within 30 seconds');
    const original = error.originalError;
    expect(original).toBeInstanceOf(WorkerRuntimeFailureError);
    if (!(original instanceof WorkerRuntimeFailureError))
      throw new Error('expected the original WorkerRuntimeFailureError');
    expect(original.publicError.code).toBe('RUNTIME_BILLING_REQUIRED');
    expect(original.runtimeKind).toBe('grok');
    expect(original.runtimeTurnId).toBe(runtimeHostMock.starts[0]?.args[1]);
    expect(original.failureDiagnostic).toMatchObject({
      failureStage: 'billing_error',
      httpStatus: 402,
    });
    subject.dispose();
  });

  it('starts no other CLI Turn for a Worker until its unconfirmed Turn is confirmed to have exited', async () => {
    runtimeHostMock.starts.length = 0;
    let confirmExit: (() => void) | undefined;
    runtimeHostMock.waitForExit
      .mockRejectedValueOnce(
        new Error('Runtime process tree exit was not confirmed within 30 seconds'),
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            confirmExit = resolve;
          }),
      );
    const subject = runtime();
    const readOnlyWorker = worker(false);
    const run = (agent: AgentRecord, executionId: string) =>
      subject.execute({
        worker: agent,
        envelope: { ...envelope, targetAgentId: agent.id },
        content: '調査する',
        executionId,
      });

    await expect(run(readOnlyWorker, 'execution-1')).rejects.toBeInstanceOf(
      WorkerRuntimeExitUnconfirmedError,
    );
    const unconfirmedTurnId = runtimeHostMock.starts[0]?.args[1];
    // The Worker keeps waiting for that same Turn to exit.
    await vi.waitFor(() => expect(runtimeHostMock.waitForExit).toHaveBeenCalledTimes(2));
    expect(runtimeHostMock.waitForExit).toHaveBeenLastCalledWith(unconfirmedTurnId);

    // Dispatched again while that exit is unconfirmed, the Worker is held rather than refused.
    let outcome: unknown = 'pending';
    const held = run(readOnlyWorker, 'execution-2').then(
      () => {
        outcome = 'started';
      },
      (caught: unknown) => {
        outcome = caught;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(outcome).toBe('pending');
    expect(runtimeHostMock.starts).toHaveLength(1);

    // Only that Worker is held back.
    await expect(run({ ...readOnlyWorker, id: 'worker-2' }, 'execution-3')).resolves.toMatchObject({
      completion: { status: 'succeeded' },
    });
    expect(runtimeHostMock.starts).toHaveLength(2);

    // The re-check confirms the exit during the hold, so the held execution starts.
    confirmExit?.();
    await held;
    expect(outcome).toBe('started');
    expect(runtimeHostMock.starts).toHaveLength(3);
    subject.dispose();
  });

  it('keeps a Worker blocked and checking again when the Runtime Host goes away before the exit is confirmed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const subject = runtime();
    try {
      runtimeHostMock.starts.length = 0;
      let confirmExit: (() => void) | undefined;
      runtimeHostMock.waitForExit
        .mockRejectedValueOnce(
          new Error('Runtime process tree exit was not confirmed within 30 seconds'),
        )
        .mockRejectedValueOnce(new Error('Runtime Host exited before process exit confirmation'))
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              confirmExit = resolve;
            }),
        );
      const run = () =>
        subject.execute({
          worker: worker(false),
          envelope: { ...envelope, targetAgentId: 'worker-1' },
          content: '調査する',
        });
      const settle = () => new Promise((resolve) => setImmediate(resolve));

      await expect(run()).rejects.toBeInstanceOf(WorkerRuntimeExitUnconfirmedError);
      await settle();
      expect(runtimeHostMock.waitForExit).toHaveBeenCalledTimes(2);
      let outcome: unknown = 'pending';
      const held = run().then(
        () => {
          outcome = 'started';
        },
        (caught: unknown) => {
          outcome = caught;
        },
      );
      await settle();
      // A Host that went away does not prove the CLI process tree ended with it.
      expect(outcome).toBe('pending');
      expect(runtimeHostMock.starts).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1_000);
      await settle();
      expect(runtimeHostMock.waitForExit).toHaveBeenCalledTimes(3);
      expect(outcome).toBe('pending');
      expect(runtimeHostMock.starts).toHaveLength(1);

      confirmExit?.();
      await held;
      expect(outcome).toBe('started');
      expect(runtimeHostMock.starts).toHaveLength(2);
    } finally {
      subject.dispose();
      vi.useRealTimers();
    }
  });

  it('stops checking an unconfirmed exit once disposed and still starts no CLI for that Worker', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const subject = runtime();
    try {
      runtimeHostMock.starts.length = 0;
      runtimeHostMock.waitForExit.mockRejectedValue(
        new Error('Runtime process tree exit was not confirmed within 30 seconds'),
      );
      const run = () =>
        subject.execute({
          worker: worker(false),
          envelope: { ...envelope, targetAgentId: 'worker-1' },
          content: '調査する',
        });
      const settle = () => new Promise((resolve) => setImmediate(resolve));

      await expect(run()).rejects.toBeInstanceOf(WorkerRuntimeExitUnconfirmedError);
      await settle();
      expect(runtimeHostMock.waitForExit).toHaveBeenCalledTimes(2);

      subject.dispose();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(runtimeHostMock.waitForExit).toHaveBeenCalledTimes(2);

      // Nothing can confirm that exit any more, so a new execution is held only up to the limit.
      let outcome: unknown = 'pending';
      void run().then(
        () => {
          outcome = 'started';
        },
        (caught: unknown) => {
          outcome = caught;
        },
      );
      await settle();
      expect(outcome).toBe('pending');
      await vi.advanceTimersByTimeAsync(30_000);
      await settle();
      expect(outcome).toBeInstanceOf(WorkerRuntimeExitUnconfirmedError);

      // A stop ends such a hold at once, and reports it as the refusal it still is.
      const stopped = run();
      await settle();
      await subject.stop('worker-1');
      await expect(stopped).rejects.toBeInstanceOf(WorkerRuntimeExitUnconfirmedError);
      expect(runtimeHostMock.starts).toHaveLength(1);
    } finally {
      subject.dispose();
      vi.useRealTimers();
    }
  });

  describe('while the previous Turn of the Worker still waits for its exit', () => {
    const run = (subject: RuntimeHostTeamWorkerRuntime, executionId = 'execution-1') =>
      subject.execute({
        worker: worker(false),
        envelope: { ...envelope, targetAgentId: 'worker-1' },
        content: '調査する',
        executionId,
      });
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    it('holds a new execution without starting a CLI and starts it once that exit is confirmed', async () => {
      runtimeHostMock.starts.length = 0;
      let confirmExit: (() => void) | undefined;
      runtimeHostMock.waitForExit.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            confirmExit = resolve;
          }),
      );
      const subject = runtime();
      const first = run(subject);
      await vi.waitFor(() => expect(runtimeHostMock.waitForExit).toHaveBeenCalledOnce());
      // A watchdog timeout stops the Worker and hands it straight back to the Scheduler, while the
      // stopped Turn is still waiting for its process tree to exit.
      await subject.stop('worker-1');
      const second = run(subject);
      await settle();
      expect(runtimeHostMock.starts).toHaveLength(1);

      confirmExit?.();
      await expect(first).resolves.toMatchObject({ completion: { status: 'succeeded' } });
      await expect(second).resolves.toMatchObject({ completion: { status: 'succeeded' } });
      expect(runtimeHostMock.starts).toHaveLength(2);
      subject.dispose();
    });

    it.each([
      // Refused before starting, with nothing of its own left running: its worktree is free.
      ['another execution', 'execution-2', true],
      // A steer re-runs the same execution in the same worktree, which that Turn may still use.
      ['the same execution', 'execution-1', false],
    ])(
      'refuses a held start for %s without starting a CLI when that exit stays unconfirmed',
      async (_label, executionId, startRefused) => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const subject = runtime();
        try {
          runtimeHostMock.starts.length = 0;
          let failExit: ((error: Error) => void) | undefined;
          runtimeHostMock.waitForExit
            .mockImplementationOnce(
              () =>
                new Promise<void>((_resolve, reject) => {
                  failExit = reject;
                }),
            )
            // The background check keeps waiting, so the exit stays unconfirmed.
            .mockImplementationOnce(() => new Promise<void>(() => undefined));
          const first = run(subject).then(
            () => null,
            (caught: unknown) => caught,
          );
          await settle();
          expect(runtimeHostMock.waitForExit).toHaveBeenCalledOnce();
          await subject.stop('worker-1');
          let refused: unknown = 'pending';
          void run(subject, executionId).then(
            () => {
              refused = 'started';
            },
            (caught: unknown) => {
              refused = caught;
            },
          );
          await settle();
          expect(runtimeHostMock.starts).toHaveLength(1);

          // The failed wait leaves an unconfirmed record whose re-check may still confirm the exit,
          // so the hold goes on for the rest of the limit instead of refusing at once.
          failExit?.(new Error('Runtime Host exited before process exit confirmation'));
          await settle();
          expect(refused).toBe('pending');
          const unconfirmed = await first;
          expect(unconfirmed).toBeInstanceOf(WorkerRuntimeExitUnconfirmedError);
          expect(unconfirmed).toMatchObject({ startRefused: false });

          await vi.advanceTimersByTimeAsync(30_000);
          await settle();
          expect(refused).toBeInstanceOf(WorkerRuntimeExitUnconfirmedError);
          expect(refused).toMatchObject({
            message: expect.stringContaining('前回のCLI実行が終了したことをまだ確認できていない'),
            startRefused,
          });
          expect(runtimeStopConfirmed(refused)).toBe(startRefused);
          expect(runtimeHostMock.starts).toHaveLength(1);
        } finally {
          subject.dispose();
          vi.useRealTimers();
        }
      },
    );

    it.each([
      ['another execution', 'execution-2', true],
      // A steer re-runs the same execution in the worktree the stopped Turn may still use.
      ['the same execution', 'execution-1', false],
    ])(
      'lets a stop end the hold of %s without starting a CLI, reported as that refusal',
      async (_label, executionId, startRefused) => {
        runtimeHostMock.starts.length = 0;
        runtimeHostMock.waitForExit.mockImplementationOnce(
          () => new Promise<void>(() => undefined),
        );
        const subject = runtime();
        void run(subject).catch(() => undefined);
        await vi.waitFor(() => expect(runtimeHostMock.waitForExit).toHaveBeenCalledOnce());
        await subject.stop('worker-1');
        const second = run(subject, executionId).then(
          () => 'started',
          (caught: unknown) => caught,
        );
        await settle();

        // The stop does not end the earlier Turn, so it is no confirmed stop of this execution.
        await subject.stop('worker-1');
        const outcome = await second;
        expect(outcome).toBeInstanceOf(WorkerRuntimeExitUnconfirmedError);
        // The stop that ended the hold is kept as the cause.
        expect(outcome).toMatchObject({
          startRefused,
          cause: expect.objectContaining({ message: 'Worker execution stopped' }),
        });
        expect(runtimeStopConfirmed(outcome)).toBe(startRefused);
        expect(runtimeHostMock.starts).toHaveLength(1);
        subject.dispose();
      },
    );

    it('keeps the hold-ending stop of an unconfirmed Turn from passing for a plain stop', async () => {
      runtimeHostMock.starts.length = 0;
      runtimeHostMock.waitForExit
        .mockRejectedValueOnce(
          new Error('Runtime process tree exit was not confirmed within 30 seconds'),
        )
        // The background check keeps waiting, so the exit stays unconfirmed.
        .mockImplementationOnce(() => new Promise<void>(() => undefined));
      const subject = runtime();
      await expect(run(subject)).rejects.toMatchObject({ startRefused: false });
      // A steer re-queues the same execution while its stopped Turn is still unconfirmed.
      const second = run(subject).then(
        () => 'started',
        (caught: unknown) => caught,
      );
      await settle();

      await subject.stop('worker-1');
      const outcome = await second;
      expect(outcome).toBeInstanceOf(WorkerRuntimeExitUnconfirmedError);
      expect(outcome).toMatchObject({
        startRefused: false,
        cause: expect.objectContaining({ message: 'Worker execution stopped' }),
      });
      expect(runtimeStopConfirmed(outcome)).toBe(false);
      expect(runtimeHostMock.starts).toHaveLength(1);
      subject.dispose();
    });

    it.each([
      ['another execution', 'execution-2', true],
      ['the same execution', 'execution-1', false],
    ])(
      'refuses an already stopped start of %s behind an unconfirmed Turn rather than just stopping it',
      async (_label, executionId, startRefused) => {
        runtimeHostMock.starts.length = 0;
        runtimeHostMock.waitForExit
          .mockRejectedValueOnce(
            new Error('Runtime process tree exit was not confirmed within 30 seconds'),
          )
          .mockImplementationOnce(() => new Promise<void>(() => undefined));
        const subject = runtime();
        await expect(run(subject)).rejects.toMatchObject({ startRefused: false });
        const stopped = new AbortController();
        const stop = new Error('Worker execution stopped');
        stopped.abort(stop);

        const outcome = await subject
          .execute({
            worker: worker(false),
            envelope: { ...envelope, targetAgentId: 'worker-1' },
            content: '調査する',
            executionId,
            signal: stopped.signal,
          })
          .then(
            () => 'started',
            (caught: unknown) => caught,
          );
        expect(outcome).toBeInstanceOf(WorkerRuntimeExitUnconfirmedError);
        expect(outcome).toMatchObject({ startRefused });
        expect((outcome as Error).cause).toBe(stop);
        expect(runtimeStopConfirmed(outcome)).toBe(startRefused);
        expect(runtimeHostMock.starts).toHaveLength(1);
        subject.dispose();
      },
    );

    it('still reports a stop as a stop when no earlier Turn blocks the Worker', async () => {
      runtimeHostMock.starts.length = 0;
      const subject = runtime();
      const stopped = new AbortController();
      stopped.abort(new Error('Worker execution stopped'));

      const outcome = await subject
        .execute({
          worker: worker(false),
          envelope: { ...envelope, targetAgentId: 'worker-1' },
          content: '調査する',
          executionId: 'execution-1',
          signal: stopped.signal,
        })
        .then(
          () => 'started',
          (caught: unknown) => caught,
        );
      expect(outcome).not.toBeInstanceOf(WorkerRuntimeExitUnconfirmedError);
      expect(outcome).toMatchObject({ message: 'Worker execution stopped' });
      expect(runtimeHostMock.starts).toHaveLength(0);
      subject.dispose();
    });

    it('gives up holding after 30 seconds and refuses while that exit is still unsettled', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const subject = runtime();
      try {
        runtimeHostMock.starts.length = 0;
        runtimeHostMock.waitForExit.mockImplementationOnce(
          () => new Promise<void>(() => undefined),
        );
        void run(subject).catch(() => undefined);
        await settle();
        expect(runtimeHostMock.waitForExit).toHaveBeenCalledOnce();
        let outcome: unknown = 'pending';
        void run(subject, 'execution-2').then(
          () => {
            outcome = 'started';
          },
          (caught: unknown) => {
            outcome = caught;
          },
        );

        await vi.advanceTimersByTimeAsync(29_999);
        await settle();
        expect(outcome).toBe('pending');
        await vi.advanceTimersByTimeAsync(1);
        await settle();
        expect(outcome).toBeInstanceOf(WorkerRuntimeExitUnconfirmedError);
        expect(outcome).toMatchObject({ startRefused: true });
        expect(runtimeHostMock.starts).toHaveLength(1);
      } finally {
        subject.dispose();
        vi.useRealTimers();
      }
    });
  });

  it.each<[string, string | undefined, string | undefined, boolean]>([
    ['another execution', 'execution-1', 'execution-2', true],
    // A steer re-runs the same execution in the worktree that the unconfirmed Turn may still use.
    ['the same execution', 'execution-1', 'execution-1', false],
    ['an execution the unconfirmed Turn did not name', undefined, 'execution-2', false],
    ['an execution that names none', 'execution-1', undefined, false],
  ])(
    'refuses a start for %s behind an unconfirmed Turn exit, marking it start-refused only for another execution',
    async (_label, previousExecutionId, executionId, startRefused) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const subject = runtime();
      try {
        runtimeHostMock.starts.length = 0;
        runtimeHostMock.waitForExit
          .mockRejectedValueOnce(
            new Error('Runtime process tree exit was not confirmed within 30 seconds'),
          )
          // The background check keeps waiting, so the exit stays unconfirmed.
          .mockImplementationOnce(() => new Promise<void>(() => undefined));
        const run = (id: string | undefined) =>
          subject.execute({
            worker: worker(false),
            envelope: { ...envelope, targetAgentId: 'worker-1' },
            content: '調査する',
            ...(id === undefined ? {} : { executionId: id }),
          });
        const settle = () => new Promise((resolve) => setImmediate(resolve));

        await expect(run(previousExecutionId)).rejects.toMatchObject({ startRefused: false });
        let refused: unknown = 'pending';
        void run(executionId).then(
          () => {
            refused = 'started';
          },
          (caught: unknown) => {
            refused = caught;
          },
        );
        // Held for the whole limit while the exit stays unconfirmed, then refused.
        await vi.advanceTimersByTimeAsync(29_999);
        await settle();
        expect(refused).toBe('pending');
        await vi.advanceTimersByTimeAsync(1);
        await settle();
        expect(refused).toBeInstanceOf(WorkerRuntimeExitUnconfirmedError);
        expect(refused).toMatchObject({
          message: expect.stringContaining('前回のCLI実行が終了したことをまだ確認できていない'),
          startRefused,
        });
        // Nothing stopped this execution; the hold simply ran out.
        expect((refused as Error).cause).toBeUndefined();
        expect(runtimeStopConfirmed(refused)).toBe(startRefused);
        expect(runtimeHostMock.starts).toHaveLength(1);
      } finally {
        subject.dispose();
        vi.useRealTimers();
      }
    },
  );

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
      // The declared root is the canonical spelling Main derives from the legacy path, which on
      // Windows resolves onto the current drive rather than staying `/workspace`.
      runtimeWorkspaceSetFromLegacyPath('/workspace').roots.map(({ path }) => path),
    );
    expect(runtimeHostMock.starts[0]?.args[6]).toMatchObject({
      projectItems: [{ id: 'project:one:instruction' }, { id: 'project:one:reference:one' }],
    });
  });

  it('declares the execution isolation worktree root to the egress gate', async () => {
    runtimeHostMock.starts.length = 0;
    const isolationRoot =
      '/Users/dev/Library/Application Support/Sprint Coder/team-worker-worktrees/worktree-3f1c9a7e-5b2d-4e8a-9c04-7d6b1f2a8e35-1';
    const authorizeEgress = vi.fn(() => true);
    const subject = runtime({ authorizeEgress });

    await subject.execute({
      worker: { ...worker(false), writeCapable: true },
      envelope: { ...envelope, targetAgentId: 'worker-1' },
      executionId: 'execution-isolated-1',
      accessMode: 'workspace-write',
      workspacePath: isolationRoot,
      workspaceSet: {
        primaryRootId: 'root-1',
        digest: 'f'.repeat(64),
        roots: [
          { rootId: 'root-1', path: isolationRoot, label: 'workspace', role: 'primary' as const },
        ],
      },
      content: '実装する',
    });

    const [, , , prompt, , knownWorkspaceRoots] = authorizeEgress.mock.calls[0] as unknown as [
      string,
      string,
      string,
      string,
      unknown,
      readonly string[],
    ];
    expect(knownWorkspaceRoots).toEqual([isolationRoot]);
    expect(prompt).toContain(isolationRoot);
    // The Worker cannot work without naming that directory, so the scan must read it as clean.
    expect(assessProviderEgressDisclosure(prompt).classification).toBe('sensitive');
    expect(assessProviderEgressDisclosure(prompt, knownWorkspaceRoots).classification).toBe('safe');
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

  it.each([
    ['prompt guidance compilation', {}, 'prompt guidance unavailable', true],
    ['the egress gate', { authorizeEgress: () => false }, 'Team Worker egress was denied', false],
  ])(
    'releases the managed parent Turn when %s fails after the catalog was bound',
    async (_label, overrides, message, failGuidance) => {
      runtimeHostMock.starts.length = 0;
      promptContextMock.compileFailure = failGuidance ? message : null;
      const releaseManagedTurn = vi.fn();
      // `catalogFor` has already registered the Turn with Main at this point. A Graph Mission's
      // session Turn is closed by this release, so a missed one strands the whole Mission on
      // `waiting_resume` with `authorizationTurnIsActive` still true.
      const catalogFor = vi.fn((..._args: unknown[]) => ({ tools: [] }));
      const subject = runtime({ ...overrides, releaseManagedTurn, catalogFor });

      try {
        await expect(
          subject.execute({
            worker: worker(false),
            envelope: { ...envelope, targetAgentId: 'worker-1' },
            executionId: 'execution-preflight-failure',
            content: '実装する',
          }),
        ).rejects.toThrow(message);
      } finally {
        promptContextMock.compileFailure = null;
      }

      const boundTurnId = catalogFor.mock.calls[0]![2] as unknown as string;
      expect(releaseManagedTurn.mock.calls).toEqual([[boundTurnId]]);
      expect(runtimeHostMock.starts).toHaveLength(0);
    },
  );

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

describe('RuntimeHostTeamWorkerRuntime write outcome', () => {
  const completionOf = (result: { completion: unknown }) =>
    workerCompletionSchema.parse(result.completion);
  const writableWorker = (): AgentRecord => ({ ...worker(false), writeCapable: true });
  const writeInput = {
    envelope: { ...envelope, targetAgentId: 'worker-1' },
    content: 'ファイルを作成してください',
    accessMode: 'workspace-write' as const,
    workspacePath: '/isolated/worktree',
  };

  it('reports a Worker downgraded to read-only as failed and tells it that it cannot edit', async () => {
    runtimeHostMock.starts.length = 0;
    const subject = runtime({ writeScopeFor: () => 'read-only' });

    const result = await subject.execute({ ...writeInput, worker: writableWorker() });

    const start = runtimeHostMock.starts.at(-1)!;
    expect(start.args[9]).toBe('read-only');
    expect(start.args[2]).toContain('Workspace書き込み: 禁止（読み取り専用）');
    expect(start.args[2]).toContain('ファイルを変更できません');
    expect(start.args[2]).not.toContain('隔離範囲内で可');
    expect(completionOf(result).status).toBe('failed');
    expect(completionOf(result).verification).toContainEqual(
      expect.objectContaining({ name: 'worker-write-scope', outcome: 'fail' }),
    );
    expect(completionOf(result).summary).toContain('安全設定「確認する」');
    subject.dispose();
  });

  it('names why a write execution ran read-only when the Worker is not write-capable or has no Workspace', async () => {
    const notWritable = runtime({ writeScopeFor: () => 'workspace-write' });
    const notWritableResult = await notWritable.execute({ ...writeInput, worker: worker(false) });
    expect(completionOf(notWritableResult).status).toBe('failed');
    expect(completionOf(notWritableResult).verification).toContainEqual(
      expect.objectContaining({
        name: 'worker-write-scope',
        outcome: 'fail',
        detail: expect.stringContaining('書き込み可能として採用されていない'),
      }),
    );
    notWritable.dispose();

    const noWorkspace = runtime({
      writeScopeFor: (_worker, workspacePath) =>
        workspacePath === null ? 'read-only' : 'workspace-write',
    });
    const noWorkspaceResult = await noWorkspace.execute({
      ...writeInput,
      workspacePath: null,
      worker: writableWorker(),
    });
    expect(completionOf(noWorkspaceResult).status).toBe('failed');
    expect(completionOf(noWorkspaceResult).verification).toContainEqual(
      expect.objectContaining({
        name: 'worker-write-scope',
        outcome: 'fail',
        detail: expect.stringContaining('書き込み先のWorkspaceがない'),
      }),
    );
    noWorkspace.dispose();
  });

  it('fails a write execution whose every workspace write was denied', async () => {
    const subject = runtime({ writeScopeFor: () => 'workspace-write' });
    runtimeHostMock.beforeComplete = (turnId) => {
      subject.recordManagedToolDenied(turnId, 'create_file');
      subject.recordManagedToolDenied(turnId, 'create_file');
    };

    const result = await subject.execute({ ...writeInput, worker: writableWorker() });

    expect(completionOf(result).status).toBe('failed');
    expect(completionOf(result).verification).toContainEqual(
      expect.objectContaining({ name: 'worker-write-denied', outcome: 'fail' }),
    );
    expect(completionOf(result).summary).toContain('2件');
    subject.dispose();
  });

  it('keeps a write execution with a committed change successful and reports denied writes as a risk', async () => {
    const subject = runtime({ writeScopeFor: () => 'workspace-write' });
    runtimeHostMock.beforeComplete = (turnId) => {
      subject.recordManagedToolDenied(turnId, 'create_file');
      subject.recordManagedToolResult(turnId, {
        rootId: 'root-1',
        path: 'a.txt',
        sagaId: 'saga-1',
        kind: 'add',
        state: 'committed',
      });
    };

    const result = await subject.execute({ ...writeInput, worker: writableWorker() });

    expect(completionOf(result).status).toBe('succeeded');
    expect(completionOf(result).risks).toHaveLength(1);
    expect(completionOf(result).risks[0]).toContain('1件');
    subject.dispose();
  });

  it('counts a committed directory creation as a write when judging denied writes', async () => {
    const subject = runtime({ writeScopeFor: () => 'workspace-write' });
    runtimeHostMock.beforeComplete = (turnId) => {
      subject.recordManagedToolResult(turnId, {
        rootId: 'root-1',
        path: 'generated',
        sagaId: 'saga-mkdir',
        state: 'committed',
        kind: 'mkdir',
      });
      subject.recordManagedToolDenied(turnId, 'apply_patch');
    };

    const result = await subject.execute({ ...writeInput, worker: writableWorker() });

    expect(completionOf(result).status).toBe('succeeded');
    expect(completionOf(result).risks).toEqual([
      expect.stringContaining('反映された書き込みは1件'),
    ]);
    subject.dispose();
  });

  it('ignores denied non-write tools when judging a write execution', async () => {
    const subject = runtime({ writeScopeFor: () => 'workspace-write' });
    runtimeHostMock.beforeComplete = (turnId) => {
      subject.recordManagedToolDenied(turnId, 'read_file');
    };

    const result = await subject.execute({ ...writeInput, worker: writableWorker() });

    expect(completionOf(result).status).toBe('succeeded');
    expect(completionOf(result).risks).toEqual([]);
    subject.dispose();
  });

  it('does not fail a read-only investigation or a write execution that attempted no writes', async () => {
    const investigation = runtime();
    const readResult = await investigation.execute({
      worker: worker(false),
      envelope: { ...envelope, targetAgentId: 'worker-1' },
      content: '調査してください',
    });
    expect(completionOf(readResult).status).toBe('succeeded');
    investigation.dispose();

    const writer = runtime({ writeScopeFor: () => 'workspace-write' });
    const writeResult = await writer.execute({ ...writeInput, worker: writableWorker() });
    expect(completionOf(writeResult).status).toBe('succeeded');
    expect(completionOf(writeResult).risks).toEqual([]);
    writer.dispose();
  });
});

describe('RuntimeHostTeamWorkerRuntime done criteria report', () => {
  const completionOf = (result: { completion: unknown }) =>
    workerCompletionSchema.parse(result.completion);
  const doneCriteria = ['答えを見つける', '出典を示す'];
  const input = {
    worker: worker(false),
    envelope: { ...envelope, targetAgentId: 'worker-1' },
    content: '調査してください',
    doneCriteria,
  };

  it('gives the CLI the numbered criteria and the report format', async () => {
    runtimeHostMock.starts.length = 0;
    const subject = runtime();

    await subject.execute(input);

    const prompt = runtimeHostMock.starts[0]?.args[2] as string;
    expect(prompt).toContain('1. 答えを見つける');
    expect(prompt).toContain('2. 出典を示す');
    expect(prompt).toContain('```json');
    expect(prompt.indexOf('依頼: 調査してください')).toBeLessThan(
      prompt.indexOf('1. 答えを見つける'),
    );
    subject.dispose();
  });

  it('returns the per-criterion report with the task criteria and a summary without the block', async () => {
    runtimeHostMock.finalText = [
      '答えは42です。',
      '```json',
      JSON.stringify({
        criteria: [
          { index: 1, status: 'done', evidence: 'read_file で確認しました' },
          { index: 2, status: 'not_done', evidence: '出典が見つかりません' },
        ],
      }),
      '```',
    ].join('\n');
    const subject = runtime();

    const completion = completionOf(await subject.execute(input));

    expect(completion.status).toBe('succeeded');
    expect(completion.summary).toBe('答えは42です。');
    expect(completion.criteria).toEqual([
      { criterion: '答えを見つける', status: 'done', evidence: 'read_file で確認しました' },
      { criterion: '出典を示す', status: 'not_done', evidence: '出典が見つかりません' },
    ]);
    expect(completion.verification.map(({ name }) => name)).toEqual(['worker-runtime:claude']);
    subject.dispose();
  });

  it('keeps an answer longer than 4000 characters within the completion summary', async () => {
    runtimeHostMock.finalText = [
      'x'.repeat(5_000),
      '```json',
      JSON.stringify({
        criteria: [
          { index: 1, status: 'done', evidence: 'ok' },
          { index: 2, status: 'done', evidence: 'ok' },
        ],
      }),
      '```',
    ].join('\n');
    const subject = runtime();

    const completion = completionOf(await subject.execute(input));

    expect(completion.summary.length).toBeLessThanOrEqual(4_000);
    expect(completion.criteria).toHaveLength(2);
    subject.dispose();
  });

  const allDone = [
    '```json',
    JSON.stringify({
      criteria: [
        { index: 1, status: 'done', evidence: '確認しました' },
        { index: 2, status: 'done', evidence: '出典を示しました' },
      ],
    }),
    '```',
  ].join('\n');

  it.each([
    [
      'a report followed by more text',
      `答えは42です。\n${allDone}\n補足: 以上です。`,
      '補足: 以上です。',
    ],
    [
      'a report written mid-turn and then only "未完了です"',
      `全部できました。\n${allDone}\n未完了です。`,
      '未完了です。',
    ],
  ])('takes no criteria from %s', async (_label, finalText, remains) => {
    runtimeHostMock.finalText = finalText;
    const subject = runtime();

    const completion = completionOf(await subject.execute(input));

    expect(completion.criteria).toBeUndefined();
    expect(completion.verification).toContainEqual({
      name: 'criteria-report',
      outcome: 'fail',
      detail: expect.stringContaining('最終回答の最後にありません'),
    });
    expect(completion.summary).toContain(remains);
    subject.dispose();
  });

  it('takes the criteria from a report followed only by whitespace', async () => {
    runtimeHostMock.finalText = `答えは42です。\n${allDone}\n\n  \n`;
    const subject = runtime();

    const completion = completionOf(await subject.execute(input));

    expect(completion.criteria).toHaveLength(2);
    expect(completion.summary).toBe('答えは42です。');
    subject.dispose();
  });

  it('returns no criteria and a failed criteria-report verification for a missing report', async () => {
    runtimeHostMock.finalText = '全部終わりました。';
    const subject = runtime();

    const completion = completionOf(await subject.execute(input));

    expect(completion.summary).toBe('全部終わりました。');
    expect(completion.criteria).toBeUndefined();
    expect(completion.verification).toContainEqual({
      name: 'criteria-report',
      outcome: 'fail',
      detail: expect.stringContaining('```json'),
    });
    subject.dispose();
  });
});
