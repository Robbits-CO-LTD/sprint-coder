import { describe, expect, it } from 'vitest';
import * as domain from './index';
import { createComputerUseApprovalRecord, resolveComputerUseApproval } from './index';

const approvalStates = ['pending', 'resolved', 'canceled', 'stale', 'expired'] as const;
type ApprovalState = (typeof approvalStates)[number];

type ApprovalRecord = Readonly<{
  id: string;
  taskId: string;
  turnId: string;
  callId: string;
  requestDigest: string;
  executionSpecDigest: string;
  policyEpoch: number;
  capability: string;
  resource: Readonly<{ kind: string; origin: string }>;
  state: ApprovalState;
  decision: null;
  revision: number;
}>;

type ApprovalDomainApi = {
  approvalStates: readonly ApprovalState[];
  transitionApproval(from: ApprovalState, to: ApprovalState): ApprovalState;
  createApprovalRecord(
    input: Omit<ApprovalRecord, 'state' | 'decision' | 'revision'>,
  ): ApprovalRecord;
  transitionTurn(from: string, to: string): string;
};

const approvalDomain = domain as unknown as ApprovalDomainApi;

describe('Approval state machine', () => {
  const terminal = approvalStates.filter((state) => state !== 'pending');

  it('exposes the closed set of approval states', () => {
    expect(approvalDomain.approvalStates).toEqual(approvalStates);
  });

  for (const state of terminal) {
    it(`allows pending -> ${state}`, () => {
      expect(approvalDomain.transitionApproval('pending', state)).toBe(state);
    });
  }

  for (const from of terminal) {
    for (const to of approvalStates) {
      it(`rejects terminal transition ${from} -> ${to}`, () => {
        expect(() => approvalDomain.transitionApproval(from, to)).toThrow(
          'Invalid approval transition',
        );
      });
    }
  }

  it('clones and deeply freezes immutable authorization facts', () => {
    const resource = { kind: 'network', origin: 'https://example.com' };
    const record = approvalDomain.createApprovalRecord({
      id: 'approval-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      callId: 'call-1',
      requestDigest: 'a'.repeat(64),
      executionSpecDigest: 'b'.repeat(64),
      policyEpoch: 3,
      capability: 'network.fetch',
      resource,
    });
    resource.origin = 'https://attacker.example';

    expect(record).toMatchObject({ state: 'pending', decision: null, revision: 0 });
    expect(record.resource.origin).toBe('https://example.com');
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.resource)).toBe(true);
  });
});

describe('Turn approval transitions', () => {
  it.each(['planning', 'executing'])('allows %s -> waiting_approval -> executing', (from) => {
    expect(approvalDomain.transitionTurn(from, 'waiting_approval')).toBe('waiting_approval');
    expect(approvalDomain.transitionTurn('waiting_approval', 'executing')).toBe('executing');
  });

  it.each(['blocked', 'canceling', 'failed', 'interrupted'])(
    'allows waiting_approval -> %s',
    (to) => {
      expect(approvalDomain.transitionTurn('waiting_approval', to)).toBe(to);
    },
  );

  it('does not allow a denied approval to complete the Turn directly', () => {
    expect(() => approvalDomain.transitionTurn('waiting_approval', 'completed')).toThrow(
      'Invalid turn transition',
    );
  });
});

describe('Computer Use approval lane', () => {
  const base = {
    id: 'computer-approval-1',
    sessionId: 'session-1',
    taskId: 'task-1',
    actionType: 'invoke' as const,
    actionDigest: 'a'.repeat(64),
    targetLabel: 'Save',
    preview: 'Invoke Save',
    risk: 'low' as const,
    policyEpoch: 3,
    observationRevision: 4,
    eligibleForPlan: true,
    allowedDecisions: ['allow_once', 'allow_plan', 'deny'] as const,
    challenge: 'challenge-1',
    createdAt: '2026-07-22T12:00:00.000Z',
    expiresAt: '2026-07-22T12:05:00.000Z',
  };

  it('creates an immutable semantic approval and resolves it once', () => {
    const approval = createComputerUseApprovalRecord(base);
    expect(approval).toMatchObject({ state: 'pending', decision: null, revision: 0 });
    expect(Object.isFrozen(approval)).toBe(true);
    const resolved = resolveComputerUseApproval({
      approval,
      expectedRevision: 0,
      challenge: base.challenge,
      decision: 'allow_plan',
      decidedAt: '2026-07-22T12:01:00.000Z',
    });
    expect(resolved).toMatchObject({ state: 'resolved', decision: 'allow_plan', revision: 1 });
    expect(() =>
      resolveComputerUseApproval({
        approval: resolved,
        expectedRevision: 1,
        challenge: base.challenge,
        decision: 'allow_plan',
        decidedAt: '2026-07-22T12:01:01.000Z',
      }),
    ).toThrow('not pending');
  });

  it('allows plans only for the exact semantic action set', () => {
    expect(
      createComputerUseApprovalRecord({
        ...base,
        actionType: 'set_text',
      }).eligibleForPlan,
    ).toBe(true);
    expect(() =>
      createComputerUseApprovalRecord({
        ...base,
        actionType: 'scroll',
      }),
    ).toThrow('exact semantic');
    for (const actionType of ['scroll', 'click', 'type', 'key'] as const) {
      expect(() =>
        createComputerUseApprovalRecord({
          ...base,
          id: `approval-${actionType}`,
          actionType,
          eligibleForPlan: false,
          allowedDecisions: ['allow_once', 'allow_plan', 'deny'],
        }),
      ).toThrow('allow_once only');
      const approval = createComputerUseApprovalRecord({
        ...base,
        id: `approval-${actionType}-valid`,
        actionType,
        eligibleForPlan: false,
        allowedDecisions: ['allow_once', 'deny'],
      });
      expect(approval.allowedDecisions).toEqual(['allow_once', 'deny']);
    }
  });

  it('requires deny on every card and resolves deny through the canonical decision set', () => {
    expect(() =>
      createComputerUseApprovalRecord({
        ...base,
        allowedDecisions: ['allow_once', 'allow_plan'],
      }),
    ).toThrow('deny');
    const approval = createComputerUseApprovalRecord(base);
    expect(
      resolveComputerUseApproval({
        approval,
        expectedRevision: 0,
        challenge: base.challenge,
        decision: 'deny',
        decidedAt: '2026-07-22T12:01:00.000Z',
      }),
    ).toMatchObject({ state: 'resolved', decision: 'deny' });
  });

  it('rejects stale, wrong-challenge, and persistent decision attempts', () => {
    const approval = createComputerUseApprovalRecord(base);
    expect(() =>
      resolveComputerUseApproval({
        approval,
        expectedRevision: 1,
        challenge: base.challenge,
        decision: 'allow_once',
        decidedAt: '2026-07-22T12:01:00.000Z',
      }),
    ).toThrow('stale');
    expect(() =>
      resolveComputerUseApproval({
        approval,
        expectedRevision: 0,
        challenge: 'wrong-challenge',
        decision: 'allow_once',
        decidedAt: '2026-07-22T12:01:00.000Z',
      }),
    ).toThrow('challenge mismatch');
    expect(domain.isComputerUsePersistentDecision('allow_task')).toBe(true);
  });
});
