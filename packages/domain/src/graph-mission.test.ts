import { describe, expect, it } from 'vitest';
import { graphMissionOrder, graphMissionConstraintUpdate } from './graph-mission';
const steps = [
  { key: 'a', nodeId: 'implement-a', dependsOn: [] },
  { key: 'b', nodeId: 'implement-b', dependsOn: [] },
  { key: 'c', nodeId: 'join', dependsOn: ['a', 'b'] },
];
describe('graph Mission dependency declarations', () => {
  it('accepts parallel roots and requires every predecessor of a join', () => {
    expect(graphMissionOrder([steps[2]!, steps[0]!, steps[1]!])).toEqual(['a', 'b', 'c']);
  });
  it.each([
    [steps[0]!],
    [steps[0]!, steps[0]!],
    [steps[0]!, { ...steps[1]!, nodeId: steps[0]!.nodeId }],
    [{ ...steps[0]!, dependsOn: ['a'] }, steps[1]!],
    [{ ...steps[0]!, dependsOn: ['absent'] }, steps[1]!],
    [{ ...steps[0]!, dependsOn: ['b', 'b'] }, steps[1]!],
    [
      { ...steps[0]!, dependsOn: ['b'] },
      { ...steps[1]!, dependsOn: ['a'] },
    ],
    [
      ...steps,
      { key: 'd', nodeId: 'loop-d', dependsOn: ['e'] },
      { key: 'e', nodeId: 'loop-e', dependsOn: ['d'] },
    ],
  ])('rejects malformed, disconnected-cycle and ambiguous graphs %#', (...invalid) => {
    expect(() => graphMissionOrder(invalid)).toThrow();
  });
});

const plan = () => ({
  objective: 'Implement',
  doneCriteria: ['joined'],
  steps: steps.map((step) => ({
    ...step,
    workerId: `worker-${step.key}`,
    objective: step.key,
    doneCriteria: ['verified'],
    access: 'workspace-write' as const,
    writeClaims: [{ rootId: 'root', path: step.key, semanticKeys: [] as string[] }],
    resourceClaims: [] as { scope: 'machine'; rootId: null; key: string }[],
  })),
});

describe('graph Mission constraint revision', () => {
  it('stops changed steps and their downstream closure while leaving the independent branch unchanged', () => {
    const previous = plan();
    const proposed = plan();
    proposed.steps[0]!.dependsOn = ['b'];
    expect(graphMissionConstraintUpdate(previous, proposed, new Set())).toEqual({
      changedKeys: ['a'],
      affectedKeys: ['a', 'c'],
    });
  });
  it('treats write scope and resource changes as constraints, without merging the concepts', () => {
    const previous = plan();
    const proposed = plan();
    proposed.steps[1]!.writeClaims[0]!.path = 'new-path';
    proposed.steps[1]!.resourceClaims = [{ scope: 'machine', rootId: null, key: 'db' }];
    expect(graphMissionConstraintUpdate(previous, proposed, new Set(['a']))).toEqual({
      changedKeys: ['b'],
      affectedKeys: ['b', 'c'],
    });
  });
  it('does not invalidate checkpoints for reordered dependency or semantic-key declarations', () => {
    const previous = plan();
    const proposed = plan();
    proposed.steps[2]!.dependsOn.reverse();
    expect(graphMissionConstraintUpdate(previous, proposed, new Set(['a', 'b', 'c']))).toEqual({
      changedKeys: [],
      affectedKeys: [],
    });
  });
  it.each(['workerId', 'objective', 'nodeId'] as const)(
    'refuses changes to %s in a running Mission',
    (field) => {
      const proposed = plan();
      proposed.steps[0]![field] = 'other';
      expect(() => graphMissionConstraintUpdate(plan(), proposed, new Set())).toThrow(
        'separate plan',
      );
    },
  );
  it('refuses completed-step changes, cycles and a change invalidating a completed descendant', () => {
    const proposed = plan();
    proposed.steps[0]!.dependsOn = ['b'];
    expect(() => graphMissionConstraintUpdate(plan(), proposed, new Set(['a']))).toThrow(
      'immutable',
    );
    expect(() => graphMissionConstraintUpdate(plan(), proposed, new Set(['c']))).toThrow(
      'completed checkpoint',
    );
    proposed.steps[1]!.dependsOn = ['a'];
    expect(() => graphMissionConstraintUpdate(plan(), proposed, new Set())).toThrow('cycle');
  });
});
