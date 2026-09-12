import { describe, expect, it } from 'vitest';
import { graphMissionOrder } from './graph-mission';
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
