import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { teamDeliveryId, DEFAULT_TEAM_BUDGET_LIMITS } from '@vibe/domain';
import { SqlitePersistenceClient, TeamConflictError } from './persistence';

const cleanup: string[] = [];
const runsWithElectronAbi = process.env.VIBE_ELECTRON_DB_TEST === '1';

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createPersistence(): { persistence: SqlitePersistenceClient; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'vibe-team-coordinator-'));
  cleanup.push(directory);
  const path = join(directory, 'test.sqlite3');
  return { persistence: new SqlitePersistenceClient(path), path };
}

const emptyCeiling = {
  entries: [],
  maxWorkerDepth: 0,
  maxConcurrentWorkers: 0,
} as const;

function buildActiveTeam(
  persistence: SqlitePersistenceClient,
  options: { writeCapable?: boolean } = {},
): {
  taskId: string;
  teamId: string;
  leaderId: string;
  workerId: string;
} {
  const task = persistence.createTask('Coordinator task');
  const team = persistence.promoteTaskToTeam(task.id);
  const leader = persistence.getTaskLeader(task.id);
  persistence.transitionTeamState(team.id, 'forming');
  const worker = persistence.registerTeamWorker({
    teamId: team.id,
    role: 'implementer',
    objective: 'Implement the bounded slice.',
    parentCapabilityCeiling: emptyCeiling,
    contextInheritancePolicy: 'summary',
    ...(options.writeCapable === undefined ? {} : { writeCapable: options.writeCapable }),
  });
  persistence.transitionTeamState(team.id, 'active');
  return { taskId: task.id, teamId: team.id, leaderId: leader.id, workerId: worker.id };
}

function statusFor(
  persistence: SqlitePersistenceClient,
  teamId: string,
  scope: 'global' | 'team' | 'worker',
  kind: 'costCents' | 'tokens' | 'timeMs' | 'toolCalls' | 'spawnSlots',
): { cap: number; committed: number; reserved: number } {
  const entry = persistence
    .getTeamBudgetStatus(teamId)
    .find((status) => status.scope === scope && status.kind === kind);
  if (entry === undefined) throw new Error(`missing status ${scope}/${kind}`);
  return { cap: entry.cap, committed: entry.committed, reserved: entry.reserved };
}

if (runsWithElectronAbi)
  describe('team coordinator persistence', () => {
    it('promotes with a structured team/worker budget and backfills legacy teams', () => {
      const { persistence } = createPersistence();
      const { teamId } = buildActiveTeam(persistence);
      expect(persistence.getTeam(teamId).budget).toEqual({
        team: DEFAULT_TEAM_BUDGET_LIMITS.team,
        worker: DEFAULT_TEAM_BUDGET_LIMITS.worker,
      });
      expect(statusFor(persistence, teamId, 'team', 'costCents').cap).toBe(
        DEFAULT_TEAM_BUDGET_LIMITS.team.costCents,
      );
      expect(statusFor(persistence, teamId, 'worker', 'costCents').cap).toBe(
        DEFAULT_TEAM_BUDGET_LIMITS.worker.costCents,
      );
      expect(statusFor(persistence, teamId, 'global', 'spawnSlots').cap).toBe(
        DEFAULT_TEAM_BUDGET_LIMITS.global.spawnSlots,
      );
      persistence.close();
    });

    it('reserves budget, allows the exact cap, and rejects an over-cap entry', () => {
      const { persistence } = createPersistence();
      const { teamId } = buildActiveTeam(persistence);
      const cap = DEFAULT_TEAM_BUDGET_LIMITS.team.costCents;

      const reserved = persistence.reserveTeamBudget({
        teamId,
        entries: [{ scope: 'team', kind: 'costCents', amount: cap }],
        purpose: 'exact cap',
        now: '2026-07-23T00:00:00.000Z',
      });
      expect(reserved).toHaveLength(1);
      expect(reserved[0]).toMatchObject({
        scope: 'team',
        kind: 'costCents',
        amount: cap,
        state: 'reserved',
      });
      expect(statusFor(persistence, teamId, 'team', 'costCents').reserved).toBe(cap);

      expect(() =>
        persistence.reserveTeamBudget({
          teamId,
          entries: [{ scope: 'team', kind: 'costCents', amount: 1 }],
          purpose: 'over cap',
          now: '2026-07-23T00:00:01.000Z',
        }),
      ).toThrow('Team budget exceeded');
      persistence.close();
    });

    it('rolls back every entry when a later entry in the batch violates its cap', () => {
      const { persistence } = createPersistence();
      const { teamId } = buildActiveTeam(persistence);

      expect(() =>
        persistence.reserveTeamBudget({
          teamId,
          entries: [
            { scope: 'team', kind: 'costCents', amount: 100 },
            { scope: 'team', kind: 'tokens', amount: DEFAULT_TEAM_BUDGET_LIMITS.team.tokens + 1 },
          ],
          purpose: 'partial violation',
          now: '2026-07-23T00:00:00.000Z',
        }),
      ).toThrow('Team budget exceeded');

      expect(statusFor(persistence, teamId, 'team', 'costCents').reserved).toBe(0);
      expect(statusFor(persistence, teamId, 'team', 'tokens').reserved).toBe(0);
      persistence.close();
    });

    it('requires an agentId for worker-scope reservations (CHECK constraint)', () => {
      const { persistence } = createPersistence();
      const { teamId } = buildActiveTeam(persistence);
      expect(() =>
        persistence.reserveTeamBudget({
          teamId,
          entries: [{ scope: 'worker', kind: 'costCents', amount: 10 }],
          purpose: 'missing agent',
          now: '2026-07-23T00:00:00.000Z',
        }),
      ).toThrow();
      expect(statusFor(persistence, teamId, 'worker', 'costCents').reserved).toBe(0);
      persistence.close();
    });

    it('settles with and without actuals, releases, and rejects re-settlement', () => {
      const { persistence } = createPersistence();
      const { teamId, workerId } = buildActiveTeam(persistence);
      const reservations = persistence.reserveTeamBudget({
        teamId,
        entries: [
          { scope: 'team', kind: 'costCents', amount: 100 },
          { scope: 'team', kind: 'timeMs', amount: 200 },
          { scope: 'team', kind: 'toolCalls', amount: 5 },
          { scope: 'worker', kind: 'tokens', amount: 400, agentId: workerId },
        ],
        purpose: 'work',
        now: '2026-07-23T00:00:00.000Z',
      });
      const costReservation = reservations[0]!;
      const timeReservation = reservations[1]!;
      const releaseReservation = reservations[2]!;
      const workerReservation = reservations[3]!;

      const settled = persistence.settleTeamBudget({
        reservationIds: [costReservation.id, timeReservation.id, workerReservation.id],
        actuals: { [costReservation.id]: 80 },
        now: '2026-07-23T00:01:00.000Z',
      });
      expect(settled.map((row) => row.settledAmount)).toEqual([80, 200, 400]);
      expect(settled.every((row) => row.state === 'settled')).toBe(true);

      const released = persistence.releaseTeamBudget({
        reservationIds: [releaseReservation.id],
        now: '2026-07-23T00:02:00.000Z',
      });
      expect(released[0]).toMatchObject({ state: 'released', settledAmount: null });

      expect(() =>
        persistence.settleTeamBudget({
          reservationIds: [costReservation.id],
          now: '2026-07-23T00:03:00.000Z',
        }),
      ).toThrow('Invalid budget reservation transition');

      expect(persistence.getTeamUsageTotals(teamId)).toEqual({
        costCents: 80,
        tokens: 400,
        timeMs: 200,
        toolCalls: 0,
      });
      expect(persistence.getWorkerUsageTotals(workerId)).toEqual({
        costCents: 0,
        tokens: 400,
        timeMs: 0,
        toolCalls: 0,
      });
      persistence.close();
    });

    it('reflects both committed and reserved amounts in the budget status', () => {
      const { persistence } = createPersistence();
      const { teamId } = buildActiveTeam(persistence);
      const mixed = persistence.reserveTeamBudget({
        teamId,
        entries: [
          { scope: 'team', kind: 'costCents', amount: 100 },
          { scope: 'team', kind: 'timeMs', amount: 300 },
        ],
        purpose: 'mixed',
        now: '2026-07-23T00:00:00.000Z',
      });
      const settleRow = mixed[1]!;
      persistence.settleTeamBudget({
        reservationIds: [settleRow.id],
        actuals: { [settleRow.id]: 150 },
        now: '2026-07-23T00:01:00.000Z',
      });
      expect(statusFor(persistence, teamId, 'team', 'costCents')).toMatchObject({
        reserved: 100,
        committed: 0,
      });
      expect(statusFor(persistence, teamId, 'team', 'timeMs')).toMatchObject({
        reserved: 0,
        committed: 150,
      });
      persistence.close();
    });

    it('creates a delivery whose id matches the domain hash and advances to acked', () => {
      const { persistence, path } = createPersistence();
      const { teamId, leaderId, workerId } = buildActiveTeam(persistence);
      const message = persistence.createTeamMessage({
        teamId,
        sourceAgentId: leaderId,
        targetAgentId: workerId,
        content: 'Please implement.',
      });

      const created = persistence.createTeamDelivery({
        messageId: message.id,
        now: '2026-07-23T00:00:00.000Z',
      });
      expect(created.deliveryId).toBe(
        teamDeliveryId({ teamId, messageId: message.id, targetAgentId: workerId }),
      );
      expect(created).toMatchObject({ state: 'persisted', attempt: 0, revision: 1 });

      const dispatched = persistence.transitionTeamDelivery({
        messageId: message.id,
        to: 'dispatched',
        now: '2026-07-23T00:00:01.000Z',
      });
      expect(dispatched).toMatchObject({ state: 'dispatched', attempt: 1, revision: 2 });
      expect(dispatched.dispatchedAt).toBe('2026-07-23T00:00:01.000Z');

      const acked = persistence.transitionTeamDelivery({
        messageId: message.id,
        to: 'acked',
        now: '2026-07-23T00:00:02.000Z',
      });
      expect(acked).toMatchObject({ state: 'acked', attempt: 1, revision: 3 });
      expect(acked.ackedAt).toBe('2026-07-23T00:00:02.000Z');

      expect(() =>
        persistence.transitionTeamDelivery({
          messageId: message.id,
          to: 'dispatched',
          now: '2026-07-23T00:00:03.000Z',
        }),
      ).toThrow('Invalid team delivery transition');

      persistence.close();
      const reopened = new SqlitePersistenceClient(path);
      expect(reopened.getTeamSnapshot(teamId).deliveries).toMatchObject([
        { messageId: message.id, state: 'acked', attempt: 1 },
      ]);
      reopened.close();
    });

    it('increments the attempt on retry and rejects retries past the max attempts', () => {
      const { persistence } = createPersistence();
      const { teamId, leaderId, workerId } = buildActiveTeam(persistence);
      const message = persistence.createTeamMessage({
        teamId,
        sourceAgentId: leaderId,
        targetAgentId: workerId,
        content: 'Retry me.',
      });
      persistence.createTeamDelivery({ messageId: message.id, now: '2026-07-23T00:00:00.000Z' });

      const cycle = (to: 'dispatched' | 'timedOut', at: string): number =>
        persistence.transitionTeamDelivery({ messageId: message.id, to, now: at, error: 'timeout' })
          .attempt;

      expect(cycle('dispatched', '2026-07-23T00:00:01.000Z')).toBe(1);
      expect(cycle('timedOut', '2026-07-23T00:00:02.000Z')).toBe(1);
      expect(cycle('dispatched', '2026-07-23T00:00:03.000Z')).toBe(2);
      expect(cycle('timedOut', '2026-07-23T00:00:04.000Z')).toBe(2);
      expect(cycle('dispatched', '2026-07-23T00:00:05.000Z')).toBe(3);
      expect(cycle('timedOut', '2026-07-23T00:00:06.000Z')).toBe(3);
      expect(() => cycle('dispatched', '2026-07-23T00:00:07.000Z')).toThrow(
        'Team delivery retry limit exceeded',
      );
      expect(persistence.getTeamDelivery(message.id)?.state).toBe('timedOut');
      persistence.close();
    });

    it('counts recent team messages with an inclusive lower bound', () => {
      const { persistence } = createPersistence();
      const { teamId, leaderId, workerId } = buildActiveTeam(persistence);
      const message = persistence.createTeamMessage({
        teamId,
        sourceAgentId: leaderId,
        targetAgentId: workerId,
        content: 'Hello.',
      });
      const at = message.createdAt;
      const justAfter = new Date(Date.parse(at) + 1).toISOString();
      expect(persistence.countRecentTeamMessages(teamId, at)).toBe(1);
      expect(persistence.countRecentTeamMessages(teamId, justAfter)).toBe(0);
      persistence.close();
    });

    it('records and transitions a worker worktree', () => {
      const { persistence } = createPersistence();
      const { teamId, workerId } = buildActiveTeam(persistence);
      persistence.transitionTeamState(teamId, 'paused');
      const secondWorker = persistence.registerTeamWorker({
        teamId,
        role: 'reviewer',
        objective: 'Review the slice.',
        parentCapabilityCeiling: emptyCeiling,
        contextInheritancePolicy: 'summary',
      });
      const baseHead = 'a'.repeat(40);

      const worktree = persistence.recordWorkerWorktree({
        agentId: workerId,
        path: '/tmp/worktree-1',
        baseHead,
        now: '2026-07-23T00:00:00.000Z',
      });
      expect(worktree).toMatchObject({ agentId: workerId, state: 'created', baseHead });

      expect(
        persistence.transitionWorkerWorktree({
          agentId: workerId,
          to: 'active',
          now: '2026-07-23T00:00:01.000Z',
        }).state,
      ).toBe('active');
      expect(
        persistence.transitionWorkerWorktree({
          agentId: workerId,
          to: 'quarantined',
          reason: 'dirty tree',
          now: '2026-07-23T00:00:02.000Z',
        }),
      ).toMatchObject({ state: 'quarantined', reason: 'dirty tree' });
      expect(() =>
        persistence.transitionWorkerWorktree({
          agentId: workerId,
          to: 'active',
          now: '2026-07-23T00:00:03.000Z',
        }),
      ).toThrow('Invalid worker worktree transition');

      persistence.recordWorkerWorktree({
        agentId: secondWorker.id,
        path: '/tmp/worktree-2',
        baseHead,
        now: '2026-07-23T00:00:04.000Z',
      });
      expect(
        persistence.transitionWorkerWorktree({
          agentId: secondWorker.id,
          to: 'cleaned',
          now: '2026-07-23T00:00:05.000Z',
        }).state,
      ).toBe('cleaned');

      expect(() =>
        persistence.recordWorkerWorktree({
          agentId: secondWorker.id,
          path: '/tmp/short-head',
          baseHead: 'tooshort',
          now: '2026-07-23T00:00:06.000Z',
        }),
      ).toThrow();
      persistence.close();
    });

    it('sets a worker current activity and persists write capability', () => {
      const { persistence } = createPersistence();
      const { workerId } = buildActiveTeam(persistence, { writeCapable: true });
      const updated = persistence.setWorkerCurrentActivity(
        workerId,
        'writing tests',
        '2026-07-23T00:00:00.000Z',
      );
      expect(updated).toMatchObject({ writeCapable: true, currentActivity: 'writing tests' });
      expect(
        persistence.setWorkerCurrentActivity(workerId, null, '2026-07-23T00:00:01.000Z')
          .currentActivity,
      ).toBeNull();
      persistence.close();
    });

    it('recovers active teams, workers, threads, and deliveries on startup', () => {
      const { persistence } = createPersistence();
      const { teamId, leaderId, workerId } = buildActiveTeam(persistence);
      persistence.transitionWorkerState(workerId, 'spawning');
      persistence.transitionWorkerState(workerId, 'ready');
      persistence.transitionWorkerState(workerId, 'busy');
      const message = persistence.createTeamMessage({
        teamId,
        sourceAgentId: leaderId,
        targetAgentId: workerId,
        content: 'Work please.',
      });
      persistence.createTeamDelivery({ messageId: message.id, now: '2026-07-23T00:00:00.000Z' });
      persistence.transitionTeamDelivery({
        messageId: message.id,
        to: 'dispatched',
        now: '2026-07-23T00:00:01.000Z',
      });
      persistence.reserveTeamBudget({
        teamId,
        entries: [{ scope: 'team', kind: 'tokens', amount: 100 }],
        purpose: 'interrupted worker execution',
        now: '2026-07-23T00:00:02.000Z',
      });
      expect(statusFor(persistence, teamId, 'team', 'tokens').reserved).toBe(100);

      const counts = persistence.recoverTeamsOnStartup('2026-07-23T01:00:00.000Z');
      expect(counts).toEqual({ teams: 1, workers: 1, threads: 1, deliveries: 1 });

      const snapshot = persistence.getTeamSnapshot(teamId);
      expect(snapshot.team.state).toBe('paused');
      expect(snapshot.agents.find((agent) => agent.id === workerId)?.state).toBe('stopped');
      expect(snapshot.deliveries[0]?.state).toBe('timedOut');
      expect(persistence.getTeamDelivery(message.id)?.state).toBe('timedOut');
      expect(statusFor(persistence, teamId, 'team', 'tokens').reserved).toBe(0);
      persistence.close();
    });

    it('exposes the delivery conflict guard as a typed error', () => {
      expect(new TeamConflictError()).toBeInstanceOf(Error);
    });
  });
else
  describe('team coordinator persistence Electron ABI bridge', () => {
    it('runs the Team coordinator SQLite suite with Electron', () => {
      const result = spawnSync(
        join(process.cwd(), '../../node_modules/.bin/electron'),
        [
          join(process.cwd(), '../../node_modules/vitest/vitest.mjs'),
          'run',
          'src/main/team-coordinator-persistence.test.ts',
        ],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VIBE_ELECTRON_DB_TEST: '1' },
          timeout: 60_000,
        },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    }, 65_000);
  });
