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

/**
 * The classifier version that opens the native approval path (the core's own version 2). A build
 * attests this only when it was compiled for it (C5-2); until then every build attests 1.
 */
export const COMPUTER_USE_APPROVAL_CLASSIFIER_VERSION = 2 as const;

/**
 * Whether this build attests classifier v2 for the approval path (ADR v2 D7, C5). It is derived from
 * the eligibility compiled into Main and nothing else: the handshake already had to equal it (a v2
 * Main requires manifest and attest to be identical to its own declaration, or the gate is closed),
 * so a Main compiled for classifier 2 whose gate is open has been attested classifier 2 by the
 * native. A Main without a compiled eligibility, a v1 allow-list Main, and a v2 Main compiled for a
 * classifier version below 2 are all "not attested". No environment variable and no flag is read.
 */
export function computerUseClassifierV2Attested(input: {
  compiled: ComputerUseEligibility | null;
  /** The native gate is open (package, signature, provenance and eligibility all passed). */
  gateOpen: boolean;
}): boolean {
  const { compiled } = input;
  return (
    input.gateOpen &&
    compiled !== null &&
    compiled.mode === 'v2-denylist' &&
    compiled.classifierVersion === COMPUTER_USE_APPROVAL_CLASSIFIER_VERSION
  );
}

/**
 * The route a session's native side is actually bound to: `unbound` for a session started without
 * a route (a direct host user; Main always binds one), `v2` only when the build attested classifier
 * 2 and the session asked for v2, `v1` otherwise.
 */
export type ComputerUseApprovalRoute = ComputerUseClassifierRoute | 'unbound';

/**
 * "The native approval path is open" (ADR v2 S4-4 addendum, section 0; C5). All of these, nothing
 * less: macOS, the addon exports the whole approval surface, the handshake attests classifier 2, and
 * for a bound session the effective mode is the v2 deny-list and the route is v2. A session on v1
 * never has an approval, whatever the rest says; an unbound session keeps the rule from before
 * routes existed (the attest decides). Used by the host and, through it, by the controller.
 */
export function computerUseApprovalPathEnabled(input: {
  platform: string;
  methodsExported: boolean;
  attestedClassifierVersion: number;
  effectiveMode: ComputerUseEligibilityMode;
  route: ComputerUseApprovalRoute;
}): boolean {
  if (
    input.platform !== 'darwin' ||
    !input.methodsExported ||
    input.attestedClassifierVersion !== COMPUTER_USE_APPROVAL_CLASSIFIER_VERSION
  )
    return false;
  if (input.route === 'unbound') return true;
  return input.route === 'v2' && input.effectiveMode === 'v2-denylist';
}
