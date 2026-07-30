import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEAM_BUDGET_LIMITS,
  TEAM_DELIVERY_MAX_ATTEMPTS,
  TEAM_MESSAGE_RATE_LIMIT,
  TeamBudgetExceededError,
  TeamIdentityError,
  TeamMessageRateLimitError,
  assertDeliveryRetryAllowed,
  assertEnvelopeMatchesClaims,
  assertReservationWithinCap,
  assertTeamMessageRate,
  buildTeamEnvelope,
  teamDeliveryId,
  transitionBudgetReservation,
  transitionTeamDelivery,
} from './team-coordination';

describe('team budget domain', () => {
  it('exposes default limits per scope', () => {
    expect(DEFAULT_TEAM_BUDGET_LIMITS.global.spawnSlots).toBe(24);
    expect(DEFAULT_TEAM_BUDGET_LIMITS.team.toolCalls).toBe(200);
    expect(DEFAULT_TEAM_BUDGET_LIMITS.worker.spawnSlots).toBe(0);
  });

  it('allows only reserved -> settled or reserved -> released', () => {
    expect(transitionBudgetReservation('reserved', 'settled')).toBe('settled');
    expect(transitionBudgetReservation('reserved', 'released')).toBe('released');
    expect(() => transitionBudgetReservation('settled', 'released')).toThrow(
      'Invalid budget reservation transition',
    );
    expect(() => transitionBudgetReservation('released', 'reserved')).toThrow(
      'Invalid budget reservation transition',
    );
  });

  it('allows a reservation that lands exactly on the cap', () => {
    expect(() =>
      assertReservationWithinCap({
        scope: 'team',
        kind: 'toolCalls',
        cap: 200,
        committed: 150,
        reserved: 20,
        requested: 30,
      }),
    ).not.toThrow();
  });

  it('rejects a reservation that exceeds the cap by one', () => {
    expect(() =>
      assertReservationWithinCap({
        scope: 'team',
        kind: 'toolCalls',
        cap: 200,
        committed: 150,
        reserved: 20,
        requested: 31,
      }),
    ).toThrow(TeamBudgetExceededError);
  });

  it('carries scope/kind/cap/committed/reserved/requested on the error', () => {
    try {
      assertReservationWithinCap({
        scope: 'worker',
        kind: 'costCents',
        cap: 100,
        committed: 50,
        reserved: 40,
        requested: 20,
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(TeamBudgetExceededError);
      const budgetError = error as TeamBudgetExceededError;
      expect(budgetError.scope).toBe('worker');
      expect(budgetError.kind).toBe('costCents');
      expect(budgetError.cap).toBe(100);
      expect(budgetError.committed).toBe(50);
      expect(budgetError.reserved).toBe(40);
      expect(budgetError.requested).toBe(20);
    }
  });

  it('rejects non-safe-integer or out-of-range inputs', () => {
    expect(() =>
      assertReservationWithinCap({
        scope: 'team',
        kind: 'tokens',
        cap: 100,
        committed: 0,
        reserved: 0,
        requested: 0,
      }),
    ).toThrow('Invalid requested amount');
    expect(() =>
      assertReservationWithinCap({
        scope: 'team',
        kind: 'tokens',
        cap: 100,
        committed: -1,
        reserved: 0,
        requested: 1,
      }),
    ).toThrow('Invalid committed amount');
    expect(() =>
      assertReservationWithinCap({
        scope: 'team',
        kind: 'tokens',
        cap: 100,
        committed: 0,
        reserved: -1,
        requested: 1,
      }),
    ).toThrow('Invalid reserved amount');
    expect(() =>
      assertReservationWithinCap({
        scope: 'team',
        kind: 'tokens',
        cap: -1,
        committed: 0,
        reserved: 0,
        requested: 1,
      }),
    ).toThrow('Invalid budget cap');
    expect(() =>
      assertReservationWithinCap({
        scope: 'team',
        kind: 'tokens',
        cap: 100,
        committed: 0,
        reserved: 0,
        requested: 1.5,
      }),
    ).toThrow('Invalid requested amount');
  });
});

describe('team message rate limit', () => {
  it('exposes the default limit constants', () => {
    expect(TEAM_MESSAGE_RATE_LIMIT.limit).toBe(30);
    expect(TEAM_MESSAGE_RATE_LIMIT.windowMs).toBe(60000);
  });

  it('allows one below the limit and rejects at the boundary', () => {
    expect(() =>
      assertTeamMessageRate({ recentCount: 29, limit: 30, windowMs: 60000 }),
    ).not.toThrow();
    expect(() => assertTeamMessageRate({ recentCount: 30, limit: 30, windowMs: 60000 })).toThrow(
      TeamMessageRateLimitError,
    );
    expect(() => assertTeamMessageRate({ recentCount: 31, limit: 30, windowMs: 60000 })).toThrow(
      TeamMessageRateLimitError,
    );
  });

  it('rejects an invalid recent count', () => {
    expect(() => assertTeamMessageRate({ recentCount: -1, limit: 30, windowMs: 60000 })).toThrow(
      'Invalid recent message count',
    );
    expect(() => assertTeamMessageRate({ recentCount: 1.2, limit: 30, windowMs: 60000 })).toThrow(
      'Invalid recent message count',
    );
  });
});

describe('team delivery lifecycle', () => {
  it('walks persisted through dispatched to acked', () => {
    expect(transitionTeamDelivery('persisted', 'dispatched')).toBe('dispatched');
    expect(transitionTeamDelivery('dispatched', 'acked')).toBe('acked');
  });

  it('allows timing out and retrying via re-dispatch', () => {
    expect(transitionTeamDelivery('dispatched', 'timedOut')).toBe('timedOut');
    expect(transitionTeamDelivery('timedOut', 'dispatched')).toBe('dispatched');
    expect(transitionTeamDelivery('timedOut', 'failed')).toBe('failed');
  });

  it('rejects transitions out of terminal states and skipped states', () => {
    expect(() => transitionTeamDelivery('acked', 'dispatched')).toThrow(
      'Invalid team delivery transition',
    );
    expect(() => transitionTeamDelivery('failed', 'dispatched')).toThrow(
      'Invalid team delivery transition',
    );
    expect(() => transitionTeamDelivery('persisted', 'acked')).toThrow(
      'Invalid team delivery transition',
    );
  });

  it('allows retries below the max attempt count and rejects at the boundary', () => {
    expect(TEAM_DELIVERY_MAX_ATTEMPTS).toBe(3);
    expect(() =>
      assertDeliveryRetryAllowed({ attempt: 2, maxAttempts: TEAM_DELIVERY_MAX_ATTEMPTS }),
    ).not.toThrow();
    expect(() =>
      assertDeliveryRetryAllowed({ attempt: 3, maxAttempts: TEAM_DELIVERY_MAX_ATTEMPTS }),
    ).toThrow('Team delivery retry limit exceeded');
    expect(() =>
      assertDeliveryRetryAllowed({ attempt: 0, maxAttempts: TEAM_DELIVERY_MAX_ATTEMPTS }),
    ).toThrow('Invalid delivery attempt');
  });
});

describe('teamDeliveryId', () => {
  const input = { teamId: 'team-1', messageId: 'msg-1', targetAgentId: 'agent-1' };

  it('is deterministic and 64 hex chars (sha256)', () => {
    const id = teamDeliveryId(input);
    expect(id).toBe(teamDeliveryId(input));
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs when any argument differs', () => {
    const id = teamDeliveryId(input);
    expect(teamDeliveryId({ ...input, teamId: 'team-2' })).not.toBe(id);
    expect(teamDeliveryId({ ...input, messageId: 'msg-2' })).not.toBe(id);
    expect(teamDeliveryId({ ...input, targetAgentId: 'agent-2' })).not.toBe(id);
  });

  it('rejects empty string arguments', () => {
    expect(() => teamDeliveryId({ ...input, teamId: '' })).toThrow('Invalid teamId');
    expect(() => teamDeliveryId({ ...input, messageId: '' })).toThrow('Invalid messageId');
    expect(() => teamDeliveryId({ ...input, targetAgentId: '' })).toThrow('Invalid targetAgentId');
  });
});

describe('team envelope', () => {
  const base = {
    teamId: 'team-1',
    messageId: 'msg-1',
    sourceAgentId: 'leader-1',
    targetAgentId: 'worker-1',
    sourceKind: 'leader' as const,
    targetKind: 'worker' as const,
    seq: 1,
    attempt: 1,
    issuedAt: '2026-07-23T00:00:00.000Z',
  };

  it('builds an envelope with a derived delivery id', () => {
    const envelope = buildTeamEnvelope(base);
    expect(envelope.deliveryId).toBe(
      teamDeliveryId({
        teamId: base.teamId,
        messageId: base.messageId,
        targetAgentId: base.targetAgentId,
      }),
    );
  });

  it('rejects leader-to-leader routing and permits a Worker direct envelope', () => {
    expect(() =>
      buildTeamEnvelope({ ...base, sourceKind: 'leader', targetKind: 'leader' }),
    ).toThrow('multiple Leaders');
    expect(
      buildTeamEnvelope({ ...base, sourceKind: 'worker', targetKind: 'worker' }),
    ).toMatchObject({ sourceKind: 'worker', targetKind: 'worker' });
  });

  it('rejects a source and target that are the same agent', () => {
    expect(() => buildTeamEnvelope({ ...base, targetAgentId: base.sourceAgentId })).toThrow(
      'source and target Agents must differ',
    );
  });

  it('requires a positive seq and an attempt of at least 1', () => {
    expect(() => buildTeamEnvelope({ ...base, seq: 0 })).toThrow('Invalid envelope seq');
    expect(() => buildTeamEnvelope({ ...base, seq: -1 })).toThrow('Invalid envelope seq');
    expect(() => buildTeamEnvelope({ ...base, attempt: 0 })).toThrow('Invalid envelope attempt');
    expect(() => buildTeamEnvelope({ ...base, attempt: 1 })).not.toThrow();
  });

  it('accepts claims that match and rejects claims that do not', () => {
    const envelope = buildTeamEnvelope(base);
    expect(() =>
      assertEnvelopeMatchesClaims(envelope, {
        deliveryId: envelope.deliveryId,
        sourceAgentId: envelope.sourceAgentId,
        targetAgentId: envelope.targetAgentId,
      }),
    ).not.toThrow();

    expect(() =>
      assertEnvelopeMatchesClaims(envelope, { deliveryId: 'not-the-real-delivery-id' }),
    ).toThrow(TeamIdentityError);
    expect(() => assertEnvelopeMatchesClaims(envelope, { sourceAgentId: 'someone-else' })).toThrow(
      TeamIdentityError,
    );
    expect(() => assertEnvelopeMatchesClaims(envelope, { targetAgentId: 'someone-else' })).toThrow(
      TeamIdentityError,
    );
  });
});
