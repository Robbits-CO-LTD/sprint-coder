// Slice 4.7e: the platform gate is the single decision point for whether the dormant
// Edit Saga native mutation authority may activate. It is a pure function — no I/O, no
// Electron import — so it can be exercised deterministically in tests. Production callers
// must supply real evidence; any missing, malformed, or non-conforming input is denied
// (fail-closed) rather than throwing, so a defensive caller can never accidentally enable
// mutation by mishandling an exception.

export type NativeMutationPackagedLoadEvidence = Readonly<{
  source: 'packaged-app';
  addonPath: string;
  loadedFromUnpacked: true;
}>;

export type NativeMutationPlatformGateProbeInput = Readonly<{
  available: boolean;
  capabilities: Readonly<{ mutation: boolean }>;
}>;

export type NativeMutationPlatformGateInput = Readonly<{
  platform: string;
  packagedLoadEvidence: NativeMutationPackagedLoadEvidence | null;
  probe: NativeMutationPlatformGateProbeInput;
  persistenceAuthorityAvailable: boolean;
}>;

export type NativeMutationPlatformGateResult = Readonly<{
  allowed: boolean;
  reasons: readonly string[];
}>;

const DENY_INVALID_INPUT = Object.freeze({
  allowed: false,
  reasons: Object.freeze(['INVALID_GATE_INPUT']),
}) satisfies NativeMutationPlatformGateResult;

export function evaluateNativeMutationPlatformGate(
  input: unknown,
): NativeMutationPlatformGateResult {
  if (!isRecord(input)) return DENY_INVALID_INPUT;

  const reasons: string[] = [];

  if (input['platform'] !== 'darwin') reasons.push('PLATFORM_NOT_DARWIN');

  if (!isValidPackagedLoadEvidence(input['packagedLoadEvidence']))
    reasons.push('PACKAGED_LOAD_EVIDENCE_MISSING');

  const probe = input['probe'];
  if (!isRecord(probe) || probe['available'] !== true) reasons.push('PROBE_UNAVAILABLE');
  if (
    !isRecord(probe) ||
    !isRecord(probe['capabilities']) ||
    probe['capabilities']['mutation'] !== true
  )
    reasons.push('PROBE_MUTATION_NOT_TRUE');

  if (input['persistenceAuthorityAvailable'] !== true)
    reasons.push('PERSISTENCE_AUTHORITY_UNAVAILABLE');

  return Object.freeze({ allowed: reasons.length === 0, reasons: Object.freeze(reasons) });
}

function isValidPackagedLoadEvidence(value: unknown): value is NativeMutationPackagedLoadEvidence {
  return (
    isRecord(value) &&
    value['source'] === 'packaged-app' &&
    typeof value['addonPath'] === 'string' &&
    value['addonPath'].length > 0 &&
    value['loadedFromUnpacked'] === true
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
