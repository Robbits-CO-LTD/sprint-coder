import { describe, expect, it } from 'vitest';
import {
  INSPECTOR_STATES,
  INSPECTOR_WIDTH,
  nextInspectorState,
  type InspectorState,
} from './inspector-preference';

// Issue #16: four progressive-disclosure states. The cycle order is the only logic worth testing —
// the widths are data, but a cycle that cannot reach every state or cannot get back to hidden would
// trap the user.

describe('inspector states', () => {
  it('hidden takes no width, and every other state takes some', () => {
    expect(INSPECTOR_WIDTH.hidden).toBe(0);
    for (const state of INSPECTOR_STATES.filter((s) => s !== 'hidden'))
      expect(INSPECTOR_WIDTH[state]).toBeGreaterThan(0);
  });

  it('widths increase along the disclosure order', () => {
    expect(INSPECTOR_WIDTH.rail).toBeLessThan(INSPECTOR_WIDTH.panel);
    expect(INSPECTOR_WIDTH.panel).toBeLessThan(INSPECTOR_WIDTH.wide);
  });
});

describe('nextInspectorState', () => {
  it('walks every state and returns to hidden', () => {
    const visited: InspectorState[] = [];
    let state: InspectorState = 'hidden';
    for (let step = 0; step < INSPECTOR_STATES.length; step += 1) {
      state = nextInspectorState(state);
      visited.push(state);
    }
    // Reachability and escapability in one assertion: a cycle that misses a state makes it
    // unreachable, and one that never returns to hidden traps the user in a panel they cannot close.
    expect(new Set(visited)).toEqual(new Set(INSPECTOR_STATES));
    expect(state).toBe('hidden');
  });

  it('opens straight to the useful width rather than the rail', () => {
    // The rail shows a gauge and nothing else; a first click should land somewhere legible.
    expect(nextInspectorState('hidden')).toBe('panel');
  });
});
