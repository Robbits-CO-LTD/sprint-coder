import { computerUseEligibilitySchema } from '@sprint-coder/contracts';
import { readFileSync } from 'node:fs';
import { readMainNativePin } from './read-main-native-pin';
import { parseNativeHandshake } from '../src/main/computer-use-native-handshake';

export function windowsV2ArtifactProblems(input: {
  expected: unknown;
  mainBundlePath: string;
  manifestPath: string;
  handshakePath: string;
}): string[] {
  return windowsV2EligibilityProblems({
    expected: input.expected,
    compiled: readMainNativePin(input.mainBundlePath),
    manifest: JSON.parse(readFileSync(input.manifestPath, 'utf8')) as unknown,
    handshake: JSON.parse(readFileSync(input.handshakePath, 'utf8')) as unknown,
  });
}

/**
 * P4 preparation only: no production caller and no Windows V2 build authorization.
 * The full-build CI caller must supply the pin embedded in Main, the built manifest and the
 * actual helper handshake, after artifact digest/provenance verification. Never reconstruct the
 * Main pin from the manifest here. `expected` is the independently requested build declaration.
 */
export function windowsV2EligibilityProblems(input: {
  expected: unknown;
  compiled: unknown;
  manifest: unknown;
  handshake: unknown;
}): string[] {
  const expected = computerUseEligibilitySchema.safeParse(input.expected);
  if (
    !expected.success ||
    expected.data.mode !== 'v2-denylist' ||
    expected.data.classifierVersion !== 4 ||
    !expected.data.ticketRequired ||
    expected.data.interlockEnforced !== true
  )
    return ['expected Windows V2 eligibility is invalid'];

  const problems: string[] = [];
  for (const source of ['compiled', 'manifest', 'handshake'] as const) {
    const value = input[source];
    let declaration: unknown;
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
    ] as const) {
      if (parsed.data[key] !== expected.data[key])
        problems.push(`${source} eligibility.${key} differs`);
    }
  }
  return problems;
}
