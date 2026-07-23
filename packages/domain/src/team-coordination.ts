import { createHash } from 'node:crypto';
import type { CapabilityCeiling } from './permission';
import { assertLeaderRoutedMessage } from './team';

export const budgetScopes = ['global', 'team', 'worker'] as const;
export type BudgetScope = (typeof budgetScopes)[number];

export const budgetKinds = ['costCents', 'tokens', 'timeMs', 'toolCalls', 'spawnSlots'] as const;
export type BudgetKind = (typeof budgetKinds)[number];

export type TeamBudgetLimits = Readonly<Record<BudgetKind, number>>;

export const DEFAULT_TEAM_BUDGET_LIMITS: Readonly<Record<BudgetScope, TeamBudgetLimits>> = {
  global: {
    costCents: 100_000,
    tokens: 5_000_000,
    timeMs: 14_400_000,
    toolCalls: 1000,
    spawnSlots: 24,
  },
  team: {
    costCents: 20_000,
    tokens: 1_000_000,
    timeMs: 3_600_000,
    toolCalls: 200,
    spawnSlots: 8,
  },
  worker: {
    costCents: 5_000,
    tokens: 200_000,
    timeMs: 900_000,
    toolCalls: 50,
    spawnSlots: 0,
  },
};

export const budgetReservationStates = ['reserved', 'settled', 'released'] as const;
export type BudgetReservationState = (typeof budgetReservationStates)[number];

const budgetReservationTransitions: Readonly<
  Record<BudgetReservationState, readonly BudgetReservationState[]>
> = {
  reserved: ['settled', 'released'],
  settled: [],
  released: [],
};

export function transitionBudgetReservation(
  from: BudgetReservationState,
  to: BudgetReservationState,
): BudgetReservationState {
  if (!budgetReservationTransitions[from].includes(to))
    throw new Error(`Invalid budget reservation transition: ${from} -> ${to}`);
  return to;
}

export class TeamBudgetExceededError extends Error {
  readonly scope: BudgetScope;
  readonly kind: BudgetKind;
  readonly cap: number;
  readonly committed: number;
  readonly reserved: number;
  readonly requested: number;

  constructor(input: {
    scope: BudgetScope;
    kind: BudgetKind;
    cap: number;
    committed: number;
    reserved: number;
    requested: number;
  }) {
    super(
      `Team budget exceeded for ${input.scope}/${input.kind}: ` +
        `cap=${input.cap} committed=${input.committed} reserved=${input.reserved} requested=${input.requested}`,
    );
    this.name = 'TeamBudgetExceededError';
    this.scope = input.scope;
    this.kind = input.kind;
    this.cap = input.cap;
    this.committed = input.committed;
    this.reserved = input.reserved;
    this.requested = input.requested;
  }
}

export function assertReservationWithinCap(input: {
  scope: BudgetScope;
  kind: BudgetKind;
  cap: number;
  committed: number;
  reserved: number;
  requested: number;
}): void {
  if (!Number.isSafeInteger(input.requested) || input.requested <= 0)
    throw new Error('Invalid requested amount');
  if (!Number.isSafeInteger(input.committed) || input.committed < 0)
    throw new Error('Invalid committed amount');
  if (!Number.isSafeInteger(input.reserved) || input.reserved < 0)
    throw new Error('Invalid reserved amount');
  if (!Number.isSafeInteger(input.cap) || input.cap < 0) throw new Error('Invalid budget cap');
  if (input.committed + input.reserved + input.requested > input.cap)
    throw new TeamBudgetExceededError(input);
}

export function assertSpawnAuthority(requesterKind: 'leader' | 'worker'): void {
  if (requesterKind === 'worker')
    throw new Error('Workers cannot spawn sub-workers: max worker depth is 1');
}

export function assertWorkerCeilingForbidsSpawn(ceiling: CapabilityCeiling): void {
  if (ceiling.maxWorkerDepth !== 0)
    throw new Error(
      'Worker capability ceilings must forbid further spawning (maxWorkerDepth must be 0)',
    );
}

export const TEAM_MESSAGE_RATE_LIMIT = { limit: 30, windowMs: 60000 } as const;

export class TeamMessageRateLimitError extends Error {
  readonly limit: number;
  readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    super(`Team message rate limit exceeded: ${limit} per ${windowMs}ms`);
    this.name = 'TeamMessageRateLimitError';
    this.limit = limit;
    this.windowMs = windowMs;
  }
}

export function assertTeamMessageRate(input: {
  recentCount: number;
  limit: number;
  windowMs: number;
}): void {
  if (!Number.isSafeInteger(input.recentCount) || input.recentCount < 0)
    throw new Error('Invalid recent message count');
  if (input.recentCount >= input.limit)
    throw new TeamMessageRateLimitError(input.limit, input.windowMs);
}

export const teamDeliveryStates = [
  'persisted',
  'dispatched',
  'acked',
  'timedOut',
  'failed',
] as const;
export type TeamDeliveryState = (typeof teamDeliveryStates)[number];

const teamDeliveryTransitions: Readonly<Record<TeamDeliveryState, readonly TeamDeliveryState[]>> = {
  persisted: ['dispatched', 'failed'],
  dispatched: ['acked', 'timedOut', 'failed'],
  timedOut: ['dispatched', 'failed'],
  acked: [],
  failed: [],
};

export function transitionTeamDelivery(
  from: TeamDeliveryState,
  to: TeamDeliveryState,
): TeamDeliveryState {
  if (!teamDeliveryTransitions[from].includes(to))
    throw new Error(`Invalid team delivery transition: ${from} -> ${to}`);
  return to;
}

export const TEAM_DELIVERY_MAX_ATTEMPTS = 3;

export function assertDeliveryRetryAllowed(input: { attempt: number; maxAttempts: number }): void {
  if (!Number.isSafeInteger(input.attempt) || input.attempt <= 0)
    throw new Error('Invalid delivery attempt');
  if (input.attempt >= input.maxAttempts)
    throw new Error(
      `Team delivery retry limit exceeded: attempt ${input.attempt} >= max ${input.maxAttempts}`,
    );
}

export function teamDeliveryId(input: {
  teamId: string;
  messageId: string;
  targetAgentId: string;
}): string {
  assertNonEmpty(input.teamId, 'teamId');
  assertNonEmpty(input.messageId, 'messageId');
  assertNonEmpty(input.targetAgentId, 'targetAgentId');
  return createHash('sha256')
    .update(
      JSON.stringify({
        teamId: input.teamId,
        messageId: input.messageId,
        targetAgentId: input.targetAgentId,
      }),
    )
    .digest('hex');
}

function assertNonEmpty(value: string, name: string): void {
  if (value.length < 1) throw new Error(`Invalid ${name}`);
}

export type TeamEnvelope = Readonly<{
  teamId: string;
  messageId: string;
  deliveryId: string;
  sourceAgentId: string;
  targetAgentId: string;
  sourceKind: 'leader' | 'worker';
  targetKind: 'leader' | 'worker';
  seq: number;
  attempt: number;
  issuedAt: string;
}>;

export function buildTeamEnvelope(input: Omit<TeamEnvelope, 'deliveryId'>): TeamEnvelope {
  assertLeaderRoutedMessage(input.sourceKind, input.targetKind);
  if (input.sourceAgentId === input.targetAgentId)
    throw new Error('Team envelope source and target agents must differ');
  if (!Number.isSafeInteger(input.seq) || input.seq <= 0) throw new Error('Invalid envelope seq');
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1)
    throw new Error('Invalid envelope attempt');
  const deliveryId = teamDeliveryId({
    teamId: input.teamId,
    messageId: input.messageId,
    targetAgentId: input.targetAgentId,
  });
  return { ...input, deliveryId };
}

export class TeamIdentityError extends Error {
  constructor(field: string) {
    super(`Team envelope identity mismatch: ${field}`);
    this.name = 'TeamIdentityError';
  }
}

export function assertEnvelopeMatchesClaims(
  envelope: TeamEnvelope,
  claims: { deliveryId?: string; sourceAgentId?: string; targetAgentId?: string },
): void {
  if (claims.deliveryId !== undefined && claims.deliveryId !== envelope.deliveryId)
    throw new TeamIdentityError('deliveryId');
  if (claims.sourceAgentId !== undefined && claims.sourceAgentId !== envelope.sourceAgentId)
    throw new TeamIdentityError('sourceAgentId');
  if (claims.targetAgentId !== undefined && claims.targetAgentId !== envelope.targetAgentId)
    throw new TeamIdentityError('targetAgentId');
}
