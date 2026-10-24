import type { PersistenceClient } from './persistence';

export const TEAM_EXECUTION_ESTIMATE = Object.freeze({
  costCents: 100,
  tokens: 20_000,
  timeMs: 60_000,
  toolCalls: 10,
});

export type TeamExecutionUsage = Readonly<
  Partial<Record<keyof typeof TEAM_EXECUTION_ESTIMATE, number>>
>;

export type TeamExecutionBudgetScope = Readonly<{
  settle(usage?: TeamExecutionUsage): void;
  release(): void;
}>;

type BudgetPersistence = Pick<
  PersistenceClient,
  'reserveTeamBudget' | 'settleTeamBudget' | 'releaseTeamBudget'
>;

/** One invocation owns one reservation set, even when a resumed invocation reuses its purpose. */
export function reserveTeamExecutionBudget(
  persistence: BudgetPersistence,
  input: { teamId: string; workerId: string; purpose: string; now(): string },
): TeamExecutionBudgetScope {
  const entries = Object.entries(TEAM_EXECUTION_ESTIMATE).map(([kind, amount]) => ({
    kind: kind as keyof typeof TEAM_EXECUTION_ESTIMATE,
    amount,
  }));
  const reservations = persistence.reserveTeamBudget({
    teamId: input.teamId,
    entries: [
      ...entries.map((entry) => ({ ...entry, scope: 'team' as const })),
      ...entries.map((entry) => ({ ...entry, scope: 'worker' as const, agentId: input.workerId })),
    ],
    purpose: input.purpose,
    now: input.now(),
  });
  const reservationIds = reservations.map(({ id }) => id);
  let state: 'reserved' | 'settled' | 'released' = 'reserved';

  return Object.freeze({
    settle(usage?: TeamExecutionUsage): void {
      if (state !== 'reserved') throw new Error(`Team execution budget is already ${state}`);
      const actuals: Record<string, number> = {};
      for (const reservation of reservations) {
        const value = usage?.[reservation.kind as keyof TeamExecutionUsage];
        if (typeof value === 'number') actuals[reservation.id] = value;
      }
      // Persistence settles the entire set atomically; a rejected transaction leaves this scope usable.
      persistence.settleTeamBudget({ reservationIds, actuals, now: input.now() });
      state = 'settled';
    },
    release(): void {
      if (state !== 'reserved') return;
      persistence.releaseTeamBudget({ reservationIds, now: input.now() });
      state = 'released';
    },
  });
}
