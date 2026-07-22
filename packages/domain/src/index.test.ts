import { describe, expect, it } from 'vitest';
import {
  canTransitionTurn,
  InvalidIntelligenceStepTransitionError,
  reduceTurn,
  transitionIntelligenceStep,
  transitionTurn,
  turnStates,
  type TurnState,
} from './index';

const valid: Record<TurnState, readonly TurnState[]> = {
  queued: ['understanding', 'canceling', 'failed', 'interrupted'],
  understanding: ['planning', 'canceling', 'failed', 'interrupted'],
  planning: ['executing', 'canceling', 'failed', 'interrupted'],
  executing: ['synthesizing', 'canceling', 'failed', 'interrupted'],
  synthesizing: ['completed', 'canceling', 'failed', 'interrupted'],
  canceling: ['canceled', 'failed', 'interrupted'],
  completed: [],
  canceled: [],
  failed: [],
  interrupted: [],
};

describe('Turn state machine', () => {
  for (const from of turnStates) {
    for (const to of turnStates) {
      const accepted = valid[from].includes(to);
      it(`${from} -> ${to} is ${accepted ? 'accepted' : 'rejected'}`, () => {
        expect(canTransitionTurn(from, to)).toBe(accepted);
        if (accepted) {
          expect(transitionTurn(from, to)).toBe(to);
          expect(reduceTurn(from, { type: 'state.transitioned', state: to })).toBe(to);
        } else {
          expect(() => transitionTurn(from, to)).toThrow('Invalid turn transition');
        }
      });
    }
  }
});

describe('intelligence step state machine', () => {
  it('supports a final answer without a tool dispatch', () => {
    expect(transitionIntelligenceStep('prepared', 'sampling')).toBe('sampling');
    expect(transitionIntelligenceStep('sampling', 'sampled')).toBe('sampled');
    expect(transitionIntelligenceStep('sampled', 'completed')).toBe('completed');
  });

  it('supports a committed tool result before completion', () => {
    expect(transitionIntelligenceStep('sampled', 'dispatching')).toBe('dispatching');
    expect(transitionIntelligenceStep('dispatching', 'toolsCommitted')).toBe('toolsCommitted');
    expect(transitionIntelligenceStep('toolsCommitted', 'completed')).toBe('completed');
  });

  it('rejects replaying a completed step', () => {
    expect(() => transitionIntelligenceStep('completed', 'sampling')).toThrow(
      InvalidIntelligenceStepTransitionError,
    );
  });
});
