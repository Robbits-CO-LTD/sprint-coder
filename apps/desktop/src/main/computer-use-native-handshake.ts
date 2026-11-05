import {
  computerUseEligibilitySchema,
  computerUseWindowsDocumentViewersSchema,
  type ComputerUseEligibility,
} from '@sprint-coder/contracts';

export const WINDOWS_APPROVAL_WIRE_VERSION = 3;

/**
 * Validates the native handshake and returns the eligibility the native attests, or null when it
 * attests nothing (a native built before D7). Any other extension claim is still refused.
 */
export function parseNativeHandshake(
  value: unknown,
  platform: NodeJS.Platform,
): ComputerUseEligibility | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('HANDSHAKE_INVALID');
  const handshake = value as Record<string, unknown>;
  // Current native builds implement V1 only. Do not ignore extension claims that a future
  // native could otherwise make before the coordinated mode/ruleset handshake is implemented.
  const keys = ['protocolVersion', 'apiVersion', 'platform', 'napiVersion', 'eligibility'];
  if (platform === 'win32')
    keys.push(
      'sourceCommit',
      'backend',
      'architecture',
      'available',
      'capabilities',
      'reason',
      'windowsDocumentViewers',
      // Independently parsed by the background protocol; incompatibility closes only that route.
      'windowsBackgroundInput',
    );
  if (Reflect.ownKeys(handshake).some((key) => typeof key !== 'string' || !keys.includes(key)))
    throw new Error('HANDSHAKE_INVALID');
  if (
    handshake['protocolVersion'] !== 1 ||
    handshake['apiVersion'] !== 3 ||
    handshake['platform'] !== platform ||
    handshake['napiVersion'] !== 10
  )
    throw new Error('HANDSHAKE_INVALID');
  if (platform === 'win32') {
    if (
      Object.hasOwn(handshake, 'windowsDocumentViewers') &&
      !computerUseWindowsDocumentViewersSchema.safeParse(handshake['windowsDocumentViewers'])
        .success
    )
      throw new Error('HANDSHAKE_INVALID');
    if (
      (handshake['sourceCommit'] !== undefined &&
        (typeof handshake['sourceCommit'] !== 'string' ||
          !/^[a-f0-9]{40}$/u.test(handshake['sourceCommit']))) ||
      (handshake['architecture'] !== undefined && handshake['architecture'] !== 'x64') ||
      (handshake['available'] !== undefined && typeof handshake['available'] !== 'boolean') ||
      ['backend', 'reason'].some(
        (key) =>
          handshake[key] !== undefined &&
          (typeof handshake[key] !== 'string' ||
            !/^[a-zA-Z0-9._-]{1,128}$/u.test(handshake[key] as string)),
      )
    )
      throw new Error('HANDSHAKE_INVALID');
    const capabilities = handshake['capabilities'];
    if (capabilities !== undefined) {
      if (
        typeof capabilities !== 'object' ||
        capabilities === null ||
        Array.isArray(capabilities) ||
        Object.entries(capabilities).some(([key, enabled]) =>
          key === 'approvalWire'
            ? enabled !== WINDOWS_APPROVAL_WIRE_VERSION
            : ![
                'observe',
                'control',
                'uiAutomation',
                'graphicsCapture',
                'sendInput',
                'cancellableWindowDiscovery',
                'identityBoundStart',
                'artifactRead',
                'approval',
              ].includes(key) || typeof enabled !== 'boolean',
        )
      )
        throw new Error('HANDSHAKE_INVALID');
      const claims = capabilities as Record<string, unknown>;
      if (
        claims['approval'] === true
          ? claims['approvalWire'] !== WINDOWS_APPROVAL_WIRE_VERSION
          : Object.hasOwn(claims, 'approvalWire')
      )
        throw new Error('HANDSHAKE_INVALID');
    }
  }
  if (!Reflect.ownKeys(handshake).includes('eligibility')) return null;
  const eligibility = computerUseEligibilitySchema.safeParse(handshake['eligibility']);
  if (!eligibility.success) throw new Error('HANDSHAKE_INVALID');
  return eligibility.data;
}

/** Approval-only comparison; ordinary capabilities retain their existing eligibility predicate. */
export function windowsApprovalEvidenceMatches(
  compiled: unknown,
  manifest: unknown,
  handshake: unknown,
): boolean {
  const object = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  try {
    const attested = parseNativeHandshake(handshake, 'win32');
    const wire = object(object(handshake)['capabilities']);
    if (wire['approval'] !== true || wire['approvalWire'] !== WINDOWS_APPROVAL_WIRE_VERSION)
      return false;
    const pin = computerUseEligibilitySchema.safeParse(object(compiled)['eligibility']);
    const declared = computerUseEligibilitySchema.safeParse(object(manifest)['eligibility']);
    if (
      !pin.success ||
      !declared.success ||
      attested === null ||
      pin.data.mode !== 'v2-denylist' ||
      pin.data.classifierVersion !== 3 ||
      !pin.data.ticketRequired ||
      pin.data.interlockEnforced !== true
    )
      return false;
    for (const value of [declared.data, attested])
      if (
        value.mode !== pin.data.mode ||
        value.classifierVersion !== pin.data.classifierVersion ||
        value.rulesetVersion !== pin.data.rulesetVersion ||
        value.lexiconVersion !== pin.data.lexiconVersion ||
        value.ticketRequired !== pin.data.ticketRequired ||
        value.interlockEnforced !== true
      )
        return false;
    const viewers = [compiled, manifest, handshake].map((value) =>
      computerUseWindowsDocumentViewersSchema.safeParse(object(value)['windowsDocumentViewers']),
    );
    const expected = viewers[0];
    return (
      expected?.success === true &&
      viewers.every(
        (value) =>
          value.success &&
          value.data.version === expected.data.version &&
          value.data.digest === expected.data.digest,
      )
    );
  } catch {
    return false;
  }
}
