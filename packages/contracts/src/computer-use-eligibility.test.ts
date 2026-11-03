import { describe, expect, it } from 'vitest';
import { computerUseEligibilitySchema } from './index';

describe('Computer Use interlock eligibility wire', () => {
  const legacy = {
    mode: 'v1-allowlist',
    rulesetVersion: 1,
    classifierVersion: 1,
    lexiconVersion: 1,
    ticketRequired: true,
  };

  it('preserves legacy declarations without adding a default claim', () => {
    expect(computerUseEligibilitySchema.parse(legacy)).toEqual(legacy);
  });

  it('preserves boolean claims and rejects malformed claims', () => {
    for (const interlockEnforced of [true, false]) {
      const declaration = { ...legacy, interlockEnforced };
      expect(computerUseEligibilitySchema.parse(declaration)).toEqual(declaration);
    }
    for (const interlockEnforced of [null, 0, 1, 'true', {}, []])
      expect(computerUseEligibilitySchema.safeParse({ ...legacy, interlockEnforced }).success).toBe(
        false,
      );
  });
});
