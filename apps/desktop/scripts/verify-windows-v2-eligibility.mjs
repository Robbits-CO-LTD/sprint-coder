import { computerUseEligibilitySchema } from '@sprint-coder/contracts';
import { parseNativeHandshake } from '../src/main/computer-use-native-handshake.ts';

/**
 * P4 preparation only: no production caller and no Windows V2 build authorization.
 * The full-build CI caller must supply the pin embedded in Main, the built manifest and the
 * actual helper handshake, after artifact digest/provenance verification. Never reconstruct the
 * Main pin from the manifest here. `expected` is the independently requested build declaration.
 * @param {{ expected: unknown, compiled: unknown, manifest: unknown, handshake: unknown }} input
 * @returns {string[]}
 */
export function windowsV2EligibilityProblems(input) {
  const expected = computerUseEligibilitySchema.safeParse(input.expected);
  if (
    !expected.success ||
    expected.data.mode !== 'v2-denylist' ||
    expected.data.classifierVersion !== 2 ||
    !expected.data.ticketRequired ||
    expected.data.interlockEnforced !== true
  )
    return ['expected Windows V2 eligibility is invalid'];

  /** @type {string[]} */
  const problems = [];
  for (const source of ['compiled', 'manifest', 'handshake']) {
    const value = input[source];
    /** @type {unknown} */
    let declaration;
    if (source === 'handshake') {
      try {
        declaration = parseNativeHandshake(value, 'win32');
      } catch {
        problems.push('handshake is invalid');
        continue;
      }
    } else if (typeof value === 'object' && value !== null && 'eligibility' in value) {
      declaration = value.eligibility;
    }
    const parsed = computerUseEligibilitySchema.safeParse(declaration);
    if (!parsed.success) {
      problems.push(`${source} eligibility is missing or invalid`);
      continue;
    }
    for (const key of [
      'mode',
      'rulesetVersion',
      'classifierVersion',
      'lexiconVersion',
      'ticketRequired',
      'interlockEnforced',
    ]) {
      if (parsed.data[key] !== expected.data[key])
        problems.push(`${source} eligibility.${key} differs`);
    }
  }
  return problems;
}
