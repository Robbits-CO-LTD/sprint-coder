import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ComputerUseAction } from '@sprint-coder/contracts';
import { computerUseActionDigest } from './computer-use-action';
import {
  ComputerUseRuntimeCapture,
  computerUseCaptureDigest,
} from './computer-use-runtime-capture';

/**
 * #786: a typed string must not be recoverable from what Computer Use writes down. The audit row
 * (SQLite, kept across restarts) and the runtime capture (final-gate evidence) both carry a digest
 * of the action; a short secret the planner typed — a six-digit code, a PIN — has to stay out of
 * reach of anyone who reads them and guesses.
 */

const SIX_DIGITS = 1_000_000;
const pin = (value: number) => String(value).padStart(6, '0');

/** Every unkeyed construction this code base has used, or an attacker would try first. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
    )
    .join(',')}}`;
}
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
/** The audit digest before #786: the text swapped for its unsalted sha256, then hashed whole. */
const auditGuess = (action: ComputerUseAction, field: 'text' | 'value', guess: string) =>
  sha256(
    stableStringify({
      ...action,
      [field]: { byteLength: Buffer.byteLength(guess, 'utf8'), sha256: sha256(guess) },
    }),
  );
/** The runtime-capture digest before #786: the raw action JSON, hashed. */
const captureGuess = (action: ComputerUseAction, field: 'text' | 'value', guess: string) =>
  sha256(JSON.stringify({ ...action, [field]: guess }));

describe('Computer Use action digest (#786)', () => {
  const secret = '482913';
  const typed: ComputerUseAction = { type: 'type', text: secret };
  const setText: ComputerUseAction = { type: 'set_text', targetId: 'otp', text: secret };

  it('stays a 64-character hex digest, so the audit column and native ticket accept it', () => {
    for (const action of [typed, setText, { type: 'wait', milliseconds: 0 } as const])
      expect(computerUseActionDigest(action)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('binds the exact text within the process: same action, same digest; other text, other digest', () => {
    // Plan grants, approvals and request-id reuse compare digests, so a same-length string must
    // never pass for the approved one. This is why a byte length alone would not do.
    expect(computerUseActionDigest(typed)).toBe(computerUseActionDigest({ ...typed }));
    expect(computerUseActionDigest(typed)).not.toBe(
      computerUseActionDigest({ type: 'type', text: '482914' }),
    );
    expect(computerUseActionDigest(setText)).not.toBe(
      computerUseActionDigest({ ...setText, text: '000000' }),
    );
  });

  it.each([
    ['type', typed, 'text'],
    ['set_text', setText, 'text'],
    ['select', { type: 'select', targetId: 'otp', value: secret } as ComputerUseAction, 'value'],
  ] as const)(
    'gives a six-digit %s back to no unkeyed guess among all 10^6',
    (_kind, action, field) => {
      const recorded = computerUseActionDigest(action);
      let matches = 0;
      for (let value = 0; value < SIX_DIGITS; value += 1)
        if (auditGuess(action, field, pin(value)) === recorded) matches += 1;
      expect(matches).toBe(0);
    },
    120_000,
  );

  it('gives the runtime capture nothing a guess can match either', () => {
    const events: { type: string; actionDigest?: string }[] = [];
    const capture = new ComputerUseRuntimeCapture((event) => events.push(event));
    const sessionDigest = computerUseCaptureDigest('session-1');
    capture.start({
      type: 'session',
      sessionDigest,
      appDigest: 'a'.repeat(64),
      windowDigest: 'b'.repeat(64),
      manifestDigest: 'f'.repeat(64),
      platform: 'darwin',
    });
    capture.actionResult('session-1', 1, typed, 'completed', null);
    const recorded = events.find((event) => event.type === 'action_result')?.actionDigest;
    expect(recorded).toMatch(/^[0-9a-f]{64}$/u);
    let matches = 0;
    for (let value = 0; value < SIX_DIGITS; value += 1)
      if (captureGuess(typed, 'text', pin(value)) === recorded) matches += 1;
    expect(matches).toBe(0);
  }, 120_000);
});
