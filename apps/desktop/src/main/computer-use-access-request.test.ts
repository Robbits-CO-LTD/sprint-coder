import { describe, expect, it } from 'vitest';
import { COMPUTER_ACCESS_REASON_MAX_CHARACTERS } from '@sprint-coder/contracts';
import {
  computerAppGrantAllowedDecisions,
  computerAppGrantCardFactsMatch,
  computerAppGrantIntentDigest,
  sanitizeComputerAccessReason,
  COMPUTER_ACCESS_REQUEST_TASK_LIMIT,
  COMPUTER_ACCESS_REQUEST_TIMEOUT_MS,
  COMPUTER_ACCESS_REQUEST_TURN_LIMIT,
  type ComputerAppGrantCardFacts,
} from './computer-use-access-request';

const intent = {
  appToken: 'app-token-1',
  grantIdentityDigest: 'a'.repeat(64),
  denyRulesetVersion: 1,
  policyEpoch: 3,
  taskId: 'task-1',
} as const;

const facts: ComputerAppGrantCardFacts = Object.freeze({
  platform: 'darwin',
  identityKind: 'verified-signed',
  publisher: 'TEAMID1234',
  appId: 'com.example.notes',
  grantIdentityDigest: 'a'.repeat(64),
  denied: false,
  maximumMode: 'full_access_app',
});

describe('application approval card intent digest', () => {
  it('moves when any of the five bound facts moves', () => {
    const base = computerAppGrantIntentDigest(intent);
    for (const change of [
      { appToken: 'app-token-2' },
      { grantIdentityDigest: 'b'.repeat(64) },
      { denyRulesetVersion: 2 },
      { policyEpoch: 4 },
      { taskId: 'task-2' },
    ])
      expect(computerAppGrantIntentDigest({ ...intent, ...change })).not.toBe(base);
    expect(computerAppGrantIntentDigest({ ...intent })).toBe(base);
  });

  it('does not let one field borrow characters from its neighbour', () => {
    // Without length prefixes these two would concatenate to the same input, and a card built for
    // one application would authorise a click made for another.
    expect(computerAppGrantIntentDigest({ ...intent, appToken: 'ab', taskId: 'cd' })).not.toBe(
      computerAppGrantIntentDigest({ ...intent, appToken: 'abc', taskId: 'd' }),
    );
  });
});

describe('application approval card facts', () => {
  it('requires every fact the card showed to still hold', () => {
    expect(computerAppGrantCardFactsMatch(facts, { ...facts })).toBe(true);
    for (const change of [
      { platform: 'win32' as const },
      { identityKind: 'unverified' as const },
      { publisher: null },
      { appId: 'com.example.other' },
      { grantIdentityDigest: 'b'.repeat(64) },
      // A ruleset update that forbids the class, and a native boundary that attests a weaker
      // ceiling, are both changes the user never read.
      { denied: true },
      { maximumMode: 'supervised' as const },
    ])
      expect(computerAppGrantCardFactsMatch(facts, { ...facts, ...change })).toBe(false);
  });
});

describe('model-authored reason', () => {
  it('removes what a label removes, at the longer budget the card allows', () => {
    // The Unicode Tag block encodes one ASCII character per invisible codepoint.
    const smuggled = `Open the notes\u{E0041}\u{E0042}\u200b\u202e`;
    expect(sanitizeComputerAccessReason(smuggled)).toBe('Open the notes');
    expect(sanitizeComputerAccessReason('a\nb\tc')).toBe('a b c');
    const long = 'x'.repeat(COMPUTER_ACCESS_REASON_MAX_CHARACTERS + 50);
    expect([...(sanitizeComputerAccessReason(long) ?? '')]).toHaveLength(
      COMPUTER_ACCESS_REASON_MAX_CHARACTERS,
    );
  });

  it('answers null rather than inventing a word the model never wrote', () => {
    expect(sanitizeComputerAccessReason('')).toBeNull();
    expect(sanitizeComputerAccessReason('\u200b\u200b')).toBeNull();
    // Unless the model really did write it.
    expect(sanitizeComputerAccessReason('unnamed')).toBe('unnamed');
  });
});

describe('card shape', () => {
  it('offers both approvals at equal footing for an application, and one for a destination', () => {
    expect(computerAppGrantAllowedDecisions('app-grant')).toEqual([
      'allow_once',
      'allow_always',
      'deny',
    ]);
    // §6.4: only B is re-asked, and A is left alone, so there is nothing to grant "just once".
    expect(computerAppGrantAllowedDecisions('provider-egress')).toEqual(['allow_always', 'deny']);
  });

  it('keeps the published ceilings where the ADR put them', () => {
    expect(COMPUTER_ACCESS_REQUEST_TIMEOUT_MS).toBe(120_000);
    expect(COMPUTER_ACCESS_REQUEST_TURN_LIMIT).toBe(2);
    expect(COMPUTER_ACCESS_REQUEST_TASK_LIMIT).toBe(5);
  });
});
