import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MANAGER_POLICY,
  DEFAULT_TEAM_POLICY,
  TeamDelegationError,
  assertDelegationAllowed,
  assertManagerPolicy,
  assertTeamMessageAllowed,
  assertTeamPolicy,
  assertWorkerPersistenceInput,
  isWorkerActive,
  transitionTeam,
  transitionTeamMessage,
  transitionWorker,
  workerStates,
} from './team';

function delegationError(action: () => void): TeamDelegationError {
  try {
    action();
  } catch (error) {
    if (error instanceof TeamDelegationError) return error;
    throw error;
  }
  throw new Error('Expected TeamDelegationError');
}

describe('worker liveness', () => {
  it('calls a Worker active exactly while the machine can still move it', () => {
    expect(workerStates.filter(isWorkerActive)).toEqual([
      'invited',
      'spawning',
      'ready',
      'busy',
      'waiting',
    ]);
    expect(workerStates.filter((state) => !isWorkerActive(state))).toEqual([
      'done',
      'failed',
      'stopped',
    ]);
  });

  it('classifies every declared state', () => {
    for (const state of workerStates) expect(typeof isWorkerActive(state)).toBe('boolean');
  });
});

describe('team domain', () => {
  it('enforces the team lifecycle', () => {
    expect(transitionTeam('draft', 'forming')).toBe('forming');
    expect(transitionTeam('active', 'paused')).toBe('paused');
    expect(transitionTeam('paused', 'active')).toBe('active');
    expect(transitionTeam('winding_down', 'completed')).toBe('completed');
    expect(transitionTeam('completed', 'forming')).toBe('forming');
    expect(() => transitionTeam('completed', 'active')).toThrow('Invalid team transition');
  });

  it('separates worker invitation from runtime readiness', () => {
    expect(transitionWorker('invited', 'spawning')).toBe('spawning');
    expect(transitionWorker('spawning', 'ready')).toBe('ready');
    expect(transitionWorker('ready', 'busy')).toBe('busy');
    expect(() => transitionWorker('invited', 'ready')).toThrow('Invalid worker transition');
  });

  it('requires every delivery state in order', () => {
    expect(transitionTeamMessage('created', 'persisted')).toBe('persisted');
    expect(transitionTeamMessage('persisted', 'dispatching')).toBe('dispatching');
    expect(transitionTeamMessage('dispatching', 'delivered')).toBe('delivered');
    expect(transitionTeamMessage('delivered', 'acknowledged')).toBe('acknowledged');
    expect(() => transitionTeamMessage('persisted', 'delivered')).toThrow(
      'Invalid team message transition',
    );
  });

  it('allows Worker direct messages only when Team Policy permits them', () => {
    const source = { id: 'worker-1', kind: 'worker' } as const;
    const target = { id: 'worker-2', kind: 'worker' } as const;
    expect(() =>
      assertTeamMessageAllowed({ source, target, allowWorkerDirectMessages: true }),
    ).not.toThrow();
    expect(() =>
      assertTeamMessageAllowed({ source, target, allowWorkerDirectMessages: false }),
    ).toThrow('Team Policy forbids');
    expect(() =>
      assertTeamMessageAllowed({
        source,
        target: source,
        allowWorkerDirectMessages: true,
      }),
    ).toThrow('must differ');
  });

  it('validates the persisted worker policy without spawning a runtime', () => {
    expect(() =>
      assertWorkerPersistenceInput({
        role: 'reviewer',
        objective: 'Review the current slice.',
        contextInheritancePolicy: 'summary',
        parentCapabilityCeiling: {
          entries: [],
          maxWorkerDepth: 0,
          maxConcurrentWorkers: 0,
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertWorkerPersistenceInput({
        role: '',
        objective: 'Review',
        contextInheritancePolicy: 'none',
        parentCapabilityCeiling: {
          entries: [],
          maxWorkerDepth: 0,
          maxConcurrentWorkers: 0,
        },
      }),
    ).toThrow('Invalid worker role');
  });

  it('accepts the default Team and Manager policies', () => {
    expect(assertTeamPolicy(DEFAULT_TEAM_POLICY)).toEqual(DEFAULT_TEAM_POLICY);
    expect(assertManagerPolicy(DEFAULT_MANAGER_POLICY, DEFAULT_TEAM_POLICY)).toEqual(
      DEFAULT_MANAGER_POLICY,
    );
  });

  it('allows Manager delegation through depth 4 and rejects depth 5', () => {
    const requester = {
      kind: 'worker',
      depth: 3,
      canDelegate: true,
      managerPolicy: DEFAULT_MANAGER_POLICY,
    } as const;
    expect(
      assertDelegationAllowed({
        requester,
        requestedChildCanDelegate: false,
        directChildCount: 0,
        teamPolicy: DEFAULT_TEAM_POLICY,
      }),
    ).toBe(4);
    try {
      assertDelegationAllowed({
        requester: { ...requester, depth: 4 },
        requestedChildCanDelegate: false,
        directChildCount: 0,
        teamPolicy: DEFAULT_TEAM_POLICY,
      });
      throw new Error('Expected Team depth rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(TeamDelegationError);
      expect(error).toMatchObject({
        code: 'team_depth_limit',
        details: { requesterDepth: 4, requestedChildDepth: 5, maxAgentDepth: 4 },
      });
    }
  });

  it('distinguishes a Manager delegation ceiling from the Team depth ceiling', () => {
    try {
      assertDelegationAllowed({
        requester: {
          kind: 'worker',
          depth: 1,
          canDelegate: true,
          managerPolicy: {
            maxDirectChildren: 2,
            maxDelegationDepth: 1,
            allowManagerChildren: false,
          },
        },
        requestedChildCanDelegate: false,
        directChildCount: 0,
        teamPolicy: DEFAULT_TEAM_POLICY,
      });
      throw new Error('Expected Manager delegation rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(TeamDelegationError);
      expect(error).toMatchObject({
        code: 'manager_delegation_limit',
        details: { requesterDepth: 1, requestedChildDepth: 2, maxDelegationDepth: 1 },
      });
    }
  });

  it('rejects delegation by a non-Manager and enforces Manager child limits', () => {
    expect(
      delegationError(() =>
        assertDelegationAllowed({
          requester: {
            kind: 'worker',
            depth: 1,
            canDelegate: false,
            managerPolicy: null,
          },
          requestedChildCanDelegate: false,
          directChildCount: 0,
          teamPolicy: DEFAULT_TEAM_POLICY,
        }),
      ),
    ).toMatchObject({
      code: 'not_manager',
      message: expect.stringContaining('Only a Manager'),
    });

    expect(
      delegationError(() =>
        assertDelegationAllowed({
          requester: {
            kind: 'worker',
            depth: 1,
            canDelegate: true,
            managerPolicy: {
              maxDirectChildren: 2,
              maxDelegationDepth: 4,
              allowManagerChildren: false,
            },
          },
          requestedChildCanDelegate: true,
          directChildCount: 1,
          teamPolicy: DEFAULT_TEAM_POLICY,
        }),
      ),
    ).toMatchObject({
      code: 'manager_child_forbidden',
      message: expect.stringContaining('forbids hiring another Manager'),
    });
    expect(
      delegationError(() =>
        assertDelegationAllowed({
          requester: {
            kind: 'worker',
            depth: 1,
            canDelegate: true,
            managerPolicy: {
              maxDirectChildren: 2,
              maxDelegationDepth: 4,
              allowManagerChildren: true,
            },
          },
          requestedChildCanDelegate: false,
          directChildCount: 2,
          teamPolicy: DEFAULT_TEAM_POLICY,
        }),
      ),
    ).toMatchObject({
      code: 'direct_child_limit',
      message: expect.stringContaining('direct-child limit reached'),
    });
  });

  it('rejects Team policy values beyond the Core safety bounds', () => {
    expect(() => assertTeamPolicy({ ...DEFAULT_TEAM_POLICY, maxAgentDepth: 5 })).toThrow(
      'between 1 and 4',
    );
    expect(() => assertTeamPolicy({ ...DEFAULT_TEAM_POLICY, maxConcurrentExecutions: 9 })).toThrow(
      'between 1 and 8',
    );
  });
});
