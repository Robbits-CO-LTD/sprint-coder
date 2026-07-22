import { describe, expect, it } from 'vitest';
import * as domain from './index';

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
