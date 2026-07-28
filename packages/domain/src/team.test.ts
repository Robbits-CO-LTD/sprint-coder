import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MANAGER_POLICY,
  DEFAULT_TEAM_POLICY,
  assertDelegationAllowed,
  assertLeaderRoutedMessage,
  assertManagerPolicy,
  assertTeamPolicy,
  assertWorkerPersistenceInput,
  transitionTeam,
  transitionTeamMessage,
  transitionWorker,
} from './team';

describe('team domain', () => {
  it('enforces the team lifecycle', () => {
    expect(transitionTeam('draft', 'forming')).toBe('forming');
    expect(transitionTeam('active', 'paused')).toBe('paused');
    expect(transitionTeam('paused', 'active')).toBe('active');
    expect(transitionTeam('winding_down', 'completed')).toBe('completed');
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

  it('rejects worker-to-worker and leader-to-leader messages', () => {
    expect(() => assertLeaderRoutedMessage('worker', 'worker')).toThrow(
      'must be routed between the leader and a worker',
    );
    expect(() => assertLeaderRoutedMessage('leader', 'leader')).toThrow(
      'must be routed between the leader and a worker',
    );
    expect(() => assertLeaderRoutedMessage('leader', 'worker')).not.toThrow();
    expect(() => assertLeaderRoutedMessage('worker', 'leader')).not.toThrow();
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
    expect(() =>
      assertDelegationAllowed({
        requester: { ...requester, depth: 4 },
        requestedChildCanDelegate: false,
        directChildCount: 0,
        teamPolicy: DEFAULT_TEAM_POLICY,
      }),
    ).toThrow('depth exceeds 4');
  });

  it('rejects delegation by a non-Manager and enforces Manager child limits', () => {
    expect(() =>
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
    ).toThrow('Only a Manager');

    expect(() =>
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
    ).toThrow('forbids hiring another Manager');
    expect(() =>
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
    ).toThrow('direct-child limit reached');
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
