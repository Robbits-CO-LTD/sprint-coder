import {
  COMPUTER_USE_LEGACY_ELIGIBILITY,
  type ComputerUseEligibility,
  type ComputerUseEligibilityMode,
} from '@sprint-coder/contracts';

/**
 * ADR v2 D7: which applications are eligible is decided when the native is compiled, never by an
 * environment variable at run time. The only variable involved can make things stricter.
 */
export const COMPUTER_USE_FORCE_V1_ALLOWLIST_ENV =
  'SPRINT_CODER_COMPUTER_USE_FORCE_V1_ALLOWLIST' as const;

export type ComputerUseEligibilityVerdict = 'ok' | 'mismatch' | 'ticket_unattested';

/** The fields a legacy (pre-D7) declaration can be compared on. */
function sameCore(
  left: Pick<
    ComputerUseEligibility,
    'mode' | 'rulesetVersion' | 'classifierVersion' | 'lexiconVersion'
  >,
  right: Pick<
    ComputerUseEligibility,
    'mode' | 'rulesetVersion' | 'classifierVersion' | 'lexiconVersion'
  >,
): boolean {
  return (
    left.mode === right.mode &&
    left.rulesetVersion === right.rulesetVersion &&
    left.classifierVersion === right.classifierVersion &&
    left.lexiconVersion === right.lexiconVersion
  );
}

/**
 * Compares the three places an eligibility is declared: the constant compiled into Main (`null`
 * for a Main built before D7), the manifest, and the handshake attestation.
 *
 * - A v1 Main accepts an artifact that declares nothing (a legacy artifact) or declares exactly
 *   the same v1. A v1 Main never opens for a v2 or otherwise different declaration.
 * - A v2 Main requires both declarations, equal to its own in every field, and requires the build
 *   to attest that it demands a ticket. Anything missing or different closes the capability; a
 *   deny-list is never guessed.
 */
export function checkComputerUseEligibility(input: {
  compiled: ComputerUseEligibility | null;
  manifest: ComputerUseEligibility | undefined;
  attested: ComputerUseEligibility | undefined;
}): ComputerUseEligibilityVerdict {
  const { compiled, manifest, attested } = input;
  if (compiled === null || compiled.mode === 'v1-allowlist') {
    const core = compiled ?? COMPUTER_USE_LEGACY_ELIGIBILITY;
    for (const declared of [manifest, attested]) {
      if (declared === undefined) continue;
      if (!sameCore(declared, core)) return 'mismatch';
      if (compiled !== null && declared.ticketRequired !== compiled.ticketRequired)
        return 'mismatch';
    }
    return 'ok';
  }
  if (manifest === undefined || attested === undefined) return 'mismatch';
  for (const declared of [manifest, attested])
    if (!sameCore(declared, compiled) || declared.ticketRequired !== compiled.ticketRequired)
      return 'mismatch';
  return compiled.ticketRequired ? 'ok' : 'ticket_unattested';
}

/** Which classifier a session is bound to: the panel's v1, or an agent session's v2 (ADR v2 D7). */
export type ComputerUseClassifierRoute = 'v1' | 'v2';

/**
 * The classifier route Main asks for when it creates a session. Only a Main agent session under an
 * effective v2-denylist asks for v2; the panel path keeps the classification it always had. The
 * native side then expects v2 only if the build also attested classifier 2 (see the host), so this
 * asks and the attest decides. Nothing the model, the Renderer or the environment says reaches it.
 */
export function computerUseClassifierRoute(input: {
  agent: boolean;
  effectiveMode: ComputerUseEligibilityMode;
}): ComputerUseClassifierRoute {
  return input.agent && input.effectiveMode === 'v2-denylist' ? 'v2' : 'v1';
}

/**
 * The mode a session may use. `v2-denylist` only for a build compiled as v2, with the V2 flag on,
 * and without `FORCE_V1_ALLOWLIST=1`. A v1 build is v1 whatever the flag or the environment says,
 * and the environment can only lower a v2 build, never raise a v1 one.
 */
export function effectiveComputerUseEligibilityMode(input: {
  compiled: ComputerUseEligibilityMode | null;
  agentDrivenV2: boolean;
  environment: Readonly<Record<string, string | undefined>>;
}): ComputerUseEligibilityMode {
  if (input.compiled !== 'v2-denylist') return 'v1-allowlist';
  if (!input.agentDrivenV2) return 'v1-allowlist';
  if (input.environment[COMPUTER_USE_FORCE_V1_ALLOWLIST_ENV] === '1') return 'v1-allowlist';
  return 'v2-denylist';
}
