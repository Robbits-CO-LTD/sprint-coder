import { describe, expect, it } from 'vitest';
import { TEAM_GLOBAL_EXECUTION_LIMIT, TeamExecutionScheduler } from './team-execution-scheduler';
import { ConnectionAdmissionController } from './connection-admission';
import type { ProviderConnection } from '@sprint-coder/contracts';

type Deferred = Readonly<{
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}>;

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function settleScheduler(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

describe('TeamExecutionScheduler', () => {
  it('keeps global slots available when one external Connection is saturated', async () => {
    const admission = new ConnectionAdmissionController(() =>
      Date.parse('2026-07-28T00:00:01.000Z'),
    );
    const providerConnection = (
      id: string,
      runtimeKind: ProviderConnection['runtimeKind'],
      maxConcurrentRequests: number | null,
    ): ProviderConnection => ({
      id,
      providerId: id.split(':')[0]!,
      runtimeKind,
      displayName: id,
      enabled: true,
      secretReference: null,
      verification: {
        status: runtimeKind === 'builtin_cli' ? 'not_required' : 'verified',
        verifiedAt: null,
        expiresAt: null,
        message: null,
      },
      rateLimit: {
        mode: runtimeKind === 'builtin_cli' ? 'bypass' : 'auto',
        maxConcurrentRequests,
        requestsPerMinute: null,
        tokensPerMinute: null,
        lastObservedRateLimitHeaders: null,
      },
      createdAt: '2026-07-28T00:00:00.000Z',
      updatedAt: '2026-07-28T00:00:00.000Z',
    });
    for (const connection of [
      providerConnection('openai:primary', 'official_api', 1),
      providerConnection('anthropic:primary', 'official_api', 1),
      providerConnection('builtin:claude-cli', 'builtin_cli', null),
    ])
      admission.configure(connection);
    const scheduler = new TeamExecutionScheduler(4, admission);
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const started: string[] = [];
    const waiting: string[] = [];
    for (const [index, connectionId] of [
      'openai:primary',
      'openai:primary',
      'anthropic:primary',
      'builtin:claude-cli',
    ].entries())
      scheduler.submit({
        executionId: `execution-${index + 1}`,
        teamId: `team-${index + 1}`,
        teamLimit: 8,
        connection: {
          connectionId,
          queueOrdinal: index + 1,
          queuedAt: '2026-07-28T00:00:00.000Z',
          estimatedTokens: 10,
        },
        onConnectionWait: (reason) => waiting.push(reason),
        run: async () => {
          started.push(`execution-${index + 1}`);
          await gates[index]!.promise;
        },
      });

    await settleScheduler();
    expect(started).toEqual(['execution-1', 'execution-3', 'execution-4']);
    expect(waiting).toContain('connection_concurrency');
    gates[0]!.resolve();
    await settleScheduler();
    expect(started).toEqual(['execution-1', 'execution-3', 'execution-4', 'execution-2']);
    for (const gate of gates.slice(1)) gate.resolve();
    await settleScheduler();
  });

  it('runs at most eight jobs and leaves queued jobs outside the active count', async () => {
    const scheduler = new TeamExecutionScheduler();
    const gates = Array.from({ length: 10 }, deferred);
    let active = 0;
    let maximum = 0;
    for (let index = 0; index < gates.length; index += 1) {
      const gate = gates[index]!;
      scheduler.submit({
        executionId: `execution-${index}`,
        teamId: 'team-1',
        teamLimit: TEAM_GLOBAL_EXECUTION_LIMIT,
        run: async () => {
          active += 1;
          maximum = Math.max(maximum, active);
          await gate.promise;
          active -= 1;
        },
      });
    }

    await settleScheduler();
    expect(maximum).toBe(8);
    expect(scheduler.snapshot()).toMatchObject({
      activeCount: 8,
      queuedExecutionIds: ['execution-8', 'execution-9'],
    });

    gates[0]!.resolve();
    gates[1]!.resolve();
    await settleScheduler();
    expect(scheduler.snapshot()).toMatchObject({
      activeCount: 8,
      queuedExecutionIds: [],
    });
    for (const gate of gates.slice(2)) gate.resolve();
    await settleScheduler();
    expect(scheduler.snapshot().activeCount).toBe(0);
  });

  it('honors each Team limit without blocking an admissible job from another Team', async () => {
    const scheduler = new TeamExecutionScheduler();
    const teamAFirst = deferred();
    const teamASecond = deferred();
    const teamB = deferred();
    const started: string[] = [];
    for (const [executionId, teamId, gate] of [
      ['a-1', 'team-a', teamAFirst],
      ['a-2', 'team-a', teamASecond],
      ['b-1', 'team-b', teamB],
    ] as const)
      scheduler.submit({
        executionId,
        teamId,
        teamLimit: 1,
        run: async () => {
          started.push(executionId);
          await gate.promise;
        },
      });

    await settleScheduler();
    expect(started).toEqual(['a-1', 'b-1']);
    expect(scheduler.snapshot().queuedExecutionIds).toEqual(['a-2']);

    teamAFirst.resolve();
    await settleScheduler();
    expect(started).toEqual(['a-1', 'b-1', 'a-2']);
    teamASecond.resolve();
    teamB.resolve();
    await settleScheduler();
  });

  it('keeps FIFO order among jobs that become admissible together', async () => {
    const scheduler = new TeamExecutionScheduler(1);
    const gates = [deferred(), deferred(), deferred()];
    const started: string[] = [];
    for (let index = 0; index < gates.length; index += 1) {
      const gate = gates[index]!;
      scheduler.submit({
        executionId: `execution-${index}`,
        teamId: 'team-1',
        teamLimit: 8,
        run: async () => {
          started.push(`execution-${index}`);
          await gate.promise;
        },
      });
    }

    await settleScheduler();
    expect(started).toEqual(['execution-0']);
    gates[0]!.resolve();
    await settleScheduler();
    expect(started).toEqual(['execution-0', 'execution-1']);
    gates[1]!.resolve();
    await settleScheduler();
    expect(started).toEqual(['execution-0', 'execution-1', 'execution-2']);
    gates[2]!.resolve();
    await settleScheduler();
  });

  it('releases a slot after a rejected job', async () => {
    const scheduler = new TeamExecutionScheduler(1);
    const second = deferred();
    const started: string[] = [];
    scheduler.submit({
      executionId: 'failed',
      teamId: 'team-1',
      teamLimit: 8,
      run: async () => {
        started.push('failed');
        throw new Error('runtime failed');
      },
    });
    scheduler.submit({
      executionId: 'next',
      teamId: 'team-1',
      teamLimit: 8,
      run: async () => {
        started.push('next');
        await second.promise;
      },
    });

    await settleScheduler();
    expect(started).toEqual(['failed', 'next']);
    expect(scheduler.snapshot().activeCount).toBe(1);
    second.resolve();
    await settleScheduler();
    expect(scheduler.snapshot().activeCount).toBe(0);
  });

  it('removes a queued job without consuming a slot or disturbing FIFO', async () => {
    const scheduler = new TeamExecutionScheduler(1);
    const first = deferred();
    const third = deferred();
    const started: string[] = [];
    for (const [executionId, gate] of [
      ['first', first],
      ['canceled', deferred()],
      ['third', third],
    ] as const)
      scheduler.submit({
        executionId,
        teamId: 'team-1',
        teamLimit: 8,
        run: async () => {
          started.push(executionId);
          await gate.promise;
        },
      });

    await settleScheduler();
    expect(scheduler.cancelQueued('canceled')).toBe(true);
    expect(scheduler.cancelQueued('canceled')).toBe(false);
    expect(scheduler.snapshot().queuedExecutionIds).toEqual(['third']);
    first.resolve();
    await settleScheduler();
    expect(started).toEqual(['first', 'third']);
    third.resolve();
    await settleScheduler();
  });

  it('records cancellation while an admitted job is still active', async () => {
    const scheduler = new TeamExecutionScheduler(1);
    const preflight = deferred();
    scheduler.submit({
      executionId: 'preflight',
      teamId: 'team-1',
      teamLimit: 1,
      run: () => preflight.promise,
    });

    await settleScheduler();
    expect(scheduler.snapshot().activeExecutionIds).toEqual(['preflight']);
    expect(scheduler.cancelQueued('preflight')).toBe(true);
    expect(scheduler.isCancellationRequested('preflight')).toBe(true);

    preflight.resolve();
    await settleScheduler();
    expect(scheduler.isCancellationRequested('preflight')).toBe(false);
  });

  it('does not treat an active job as preflight after dispatch closes the fence', async () => {
    const scheduler = new TeamExecutionScheduler(1);
    const running = deferred();
    scheduler.submit({
      executionId: 'running',
      teamId: 'team-1',
      teamLimit: 1,
      run: () => running.promise,
    });

    await settleScheduler();
    expect(scheduler.tryFinishPreflight('running')).toBe(true);
    expect(scheduler.cancelQueued('running')).toBe(false);
    expect(scheduler.isCancellationRequested('running')).toBe(false);

    running.resolve();
    await settleScheduler();
  });

  it('cannot claim dispatch after preflight cancellation is recorded', async () => {
    const scheduler = new TeamExecutionScheduler(1);
    const preflight = deferred();
    scheduler.submit({
      executionId: 'canceled-preflight',
      teamId: 'team-1',
      teamLimit: 1,
      run: () => preflight.promise,
    });

    await settleScheduler();
    expect(scheduler.cancelQueued('canceled-preflight')).toBe(true);
    expect(scheduler.tryFinishPreflight('canceled-preflight')).toBe(false);
    preflight.resolve();
    await settleScheduler();
  });

  it('requeues an active execution only after its current run releases the slot', async () => {
    const scheduler = new TeamExecutionScheduler(1);
    const first = deferred();
    const resumed = deferred();
    const started: string[] = [];
    scheduler.submit({
      executionId: 'execution-1',
      teamId: 'team-1',
      teamLimit: 8,
      run: async () => {
        started.push('first-attempt');
        await first.promise;
      },
    });
    await settleScheduler();
    expect(
      scheduler.requeueActive('execution-1', {
        executionId: 'execution-1',
        teamId: 'team-1',
        teamLimit: 8,
        run: async () => {
          started.push('resumed-attempt');
          await resumed.promise;
        },
      }),
    ).toBe(true);
    expect(scheduler.snapshot()).toMatchObject({ activeCount: 1, queuedExecutionIds: [] });

    first.resolve();
    await settleScheduler();
    expect(started).toEqual(['first-attempt', 'resumed-attempt']);
    expect(scheduler.snapshot().activeCount).toBe(1);
    resumed.resolve();
    await settleScheduler();
  });

  it('cancels a replacement that is waiting for the active run to release', async () => {
    const scheduler = new TeamExecutionScheduler(1);
    const first = deferred();
    const started: string[] = [];
    scheduler.submit({
      executionId: 'execution-1',
      teamId: 'team-1',
      teamLimit: 8,
      run: async () => {
        started.push('first-attempt');
        await first.promise;
      },
    });
    await settleScheduler();
    expect(
      scheduler.requeueActive('execution-1', {
        executionId: 'execution-1',
        teamId: 'team-1',
        teamLimit: 8,
        run: async () => {
          started.push('must-not-restart');
        },
      }),
    ).toBe(true);

    expect(scheduler.cancelQueued('execution-1')).toBe(true);
    first.resolve();
    await settleScheduler();
    expect(started).toEqual(['first-attempt']);
    expect(scheduler.snapshot()).toMatchObject({ activeCount: 0, queuedExecutionIds: [] });
  });
});
