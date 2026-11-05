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

/** ADR G: prepared for N7-7, which connects this check when Windows v2 builds are enabled. */
export function checkComputerUseWindowsV2InterlockAttestation(input: {
  platform: string;
  compiled: ComputerUseEligibility | null;
  manifest: ComputerUseEligibility | undefined;
  attested: ComputerUseEligibility | undefined;
}): 'ok' | 'interlock_unattested' {
  if (input.platform !== 'win32' || input.compiled?.mode !== 'v2-denylist') return 'ok';
  return [input.compiled, input.manifest, input.attested].every(
    (declared) => declared?.interlockEnforced === true,
  )
    ? 'ok'
    : 'interlock_unattested';
}

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
 * native side then expects v2 only if the build also attested classifier 3 (see the host), so this
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
 * Approval classifier versions are OS-specific: macOS retains 3; Windows page policy uses 4.
 * The build, manifest and handshake must agree before either can open an approval route.
 */
export const COMPUTER_USE_APPROVAL_CLASSIFIER_VERSION = 3 as const;
export const COMPUTER_USE_WINDOWS_APPROVAL_CLASSIFIER_VERSION = 4 as const;
export function computerUseApprovalClassifierVersion(platform: string): 3 | 4 {
  return platform === 'win32'
    ? COMPUTER_USE_WINDOWS_APPROVAL_CLASSIFIER_VERSION
    : COMPUTER_USE_APPROVAL_CLASSIFIER_VERSION;
}

/**
 * Whether this build attests classifier v2 for the approval path (ADR v2 D7, C5). It is derived from
 * the eligibility compiled into Main and nothing else: the handshake already had to equal it (a v2
 * Main requires manifest and attest to be identical to its own declaration, or the gate is closed),
 * so the compiled classifier must match this platform's approval classifier. Missing eligibility,
 * v1 mode and mixed versions are not attested. No environment variable or feature flag is read.
 */
export function computerUseClassifierV2Attested(input: {
  compiled: ComputerUseEligibility | null;
  platform?: string;
  /** The native gate is open (package, signature, provenance and eligibility all passed). */
  gateOpen: boolean;
}): boolean {
  const { compiled } = input;
  return (
    input.gateOpen &&
    compiled !== null &&
    compiled.mode === 'v2-denylist' &&
    compiled.classifierVersion ===
      computerUseApprovalClassifierVersion(input.platform ?? process.platform)
  );
}

/**
 * The route a session's native side is actually bound to: `v2` only when the build attested
 * the platform approval classifier and the session asked for v2, `v1` otherwise. `unbound` is a session the host has
 * no binding for (one started without a route, one whose binding was dropped by a verified close or
 * a failed start): nothing is known about it, so it is never given an approval.
 */
export type ComputerUseApprovalRoute = ComputerUseClassifierRoute | 'unbound';

/**
 * "The native approval path is open" (ADR v2 S4-4 addendum, section 0; C5). All of these, nothing
 * less: macOS (or verified Windows approval evidence), the whole approval surface, the platform classifier, and
 * the session is bound to route v2 under the v2 deny-list. A session on v1 never has an approval,
 * whatever the rest says, and neither does a session with no binding (fail closed). Used by the
 * host and, through it, by the controller; there is no session-less answer.
 */
export function computerUseApprovalPathEnabled(input: {
  platform: string;
  methodsExported: boolean;
  attestedClassifierVersion: number;
  effectiveMode: ComputerUseEligibilityMode;
  route: ComputerUseApprovalRoute;
  windowsApprovalReady?: boolean;
}): boolean {
  if (
    (input.platform !== 'darwin' &&
      !(input.platform === 'win32' && input.windowsApprovalReady === true)) ||
    !input.methodsExported ||
    input.attestedClassifierVersion !== computerUseApprovalClassifierVersion(input.platform)
  )
    return false;
  return input.route === 'v2' && input.effectiveMode === 'v2-denylist';
}
