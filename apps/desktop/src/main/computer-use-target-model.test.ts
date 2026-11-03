import { describe, expect, it } from 'vitest';
import {
  computerTargetAppBindingMatches,
  computerTargetTokenBindingMatches,
  type ComputerTargetTokenBinding,
} from './computer-use-target-model';

const helper = Object.freeze({ helperGeneration: 1 });
const binding: ComputerTargetTokenBinding = {
  taskId: 'task',
  turnId: 'turn',
  policyEpoch: 0,
  platform: 'win32',
  appIdentityDigest: 'a'.repeat(64),
  profileRevision: 1,
  nativeWindowId: 'window',
  windowIdentityDigest: 'b'.repeat(64),
  windowsGeneration: { helper, listGeneration: 7, rulesetVersion: 1 },
};

describe('Windows target generation binding', () => {
  it.each([
    { helper: { helperGeneration: 2 }, listGeneration: 7, rulesetVersion: 1 },
    { helper: { helperGeneration: 1 }, listGeneration: 7, rulesetVersion: 1 },
    { helper, listGeneration: 8, rulesetVersion: 1 },
    { helper, listGeneration: 7, rulesetVersion: 2 },
  ])('rejects a different helper capability, list generation or ruleset: %j', (generation) => {
    const other = { ...binding, windowsGeneration: generation };
    expect(computerTargetAppBindingMatches(binding, other)).toBe(false);
    expect(computerTargetTokenBindingMatches(binding, other)).toBe(false);
  });
  it('does not accept a generation binding omitted by the consumer', () => {
    const { windowsGeneration: _generation, ...legacy } = binding;
    expect(computerTargetTokenBindingMatches(binding, legacy)).toBe(false);
    expect(computerTargetTokenBindingMatches(legacy, binding)).toBe(false);
    expect(computerTargetTokenBindingMatches(legacy, legacy)).toBe(true);
    expect(computerTargetTokenBindingMatches(binding, { ...binding })).toBe(true);
  });
});
