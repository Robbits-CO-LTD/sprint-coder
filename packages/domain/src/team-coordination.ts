import { createHash } from 'node:crypto';
import { assertTeamMessageAllowed } from './team';

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

/** The concurrency the stored Team budget defaults were sized for (the former fixed cap of 8). */
export const TEAM_BUDGET_BASELINE_CONCURRENCY = 8;

/**
 * The cap a reservation is checked against once concurrency is configurable.
 *
 * - `spawnSlots` is a concurrency lease held only while a Worker starts, so it follows the
 *   concurrency limits themselves: the app-wide setting globally, and the smaller of the Team
 *   policy and that setting per Team.
 * - A Team's cumulative budget (cost, tokens, Worker time, tool calls) keeps its per-Worker share:
 *   the stored defaults were sized for 8 concurrent Workers, so a Team allowed 50 gets 50/8 of
 *   them. It never shrinks below what is stored, so a small Team keeps what it had before.
 * - Everything else (global and per-Worker caps) is exactly what is stored.
 */
export function effectiveBudgetCap(input: {
  scope: BudgetScope;
  kind: BudgetKind;
  storedCap: number;
  teamConcurrency: number;
  appConcurrency: number;
}): number {
  if (input.kind === 'spawnSlots') {
    if (input.scope === 'global') return input.appConcurrency;
    if (input.scope === 'team') return Math.min(input.teamConcurrency, input.appConcurrency);
    return input.storedCap;
  }
  if (input.scope !== 'team') return input.storedCap;
  const scaled = Math.ceil(
    (DEFAULT_TEAM_BUDGET_LIMITS.team[input.kind] * input.teamConcurrency) /
      TEAM_BUDGET_BASELINE_CONCURRENCY,
  );
  return Math.max(input.storedCap, scaled);
}

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

/** Free-form messages (Agent to Agent, or a person's direct message to a Worker) per Team. Worker
 * reports and assignments are not counted here (Issue #854): reports answer work that was already
 * admitted, and assignments are paced by {@link TEAM_ASSIGNMENT_RATE_LIMIT} instead. */
export const TEAM_MESSAGE_RATE_LIMIT = { limit: 30, windowMs: 60000 } as const;
/** Assignments per Team. One beyond it is not refused but queued to start when the window has
 * room, so a Leader can hand work to every Worker without losing any. Each Worker can hold only one
 * unfinished execution, so a burst is also bounded by the Team's size. */
export const TEAM_ASSIGNMENT_RATE_LIMIT = { limit: 100, windowMs: 60000 } as const;

/**
 * The earliest time (>= `nowMs`) at which one more event fits a sliding window of `limit` events
 * per `windowMs`. `admittedAtMs` holds the times already admitted in nondecreasing order, and may
 * include times in the future (events queued for later).
 */
export function nextRateWindowSlot(
  admittedAtMs: readonly number[],
  nowMs: number,
  limit: number,
  windowMs: number,
): number {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid rate limit');
  if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new Error('Invalid rate window');
  const live = admittedAtMs.filter((at) => at > nowMs - windowMs);
  if (live.length < limit) return nowMs;
  // The event `limit` places back has to leave the window before one more fits.
  return Math.max(nowMs, live[live.length - limit]! + windowMs);
}

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
  assertTeamMessageAllowed({
    source: { id: input.sourceAgentId, kind: input.sourceKind },
    target: { id: input.targetAgentId, kind: input.targetKind },
    allowWorkerDirectMessages: true,
  });
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
