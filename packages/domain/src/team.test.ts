import { describe, expect, it } from 'vitest';
import {
  assertLeaderRoutedMessage,
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
});
