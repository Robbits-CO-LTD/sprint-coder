import { computerUseEligibilitySchema, type ComputerUseEligibility } from '@sprint-coder/contracts';

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
    keys.push('sourceCommit', 'backend', 'architecture', 'available', 'capabilities', 'reason');
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
        Object.entries(capabilities).some(
          ([key, enabled]) =>
            !['observe', 'control', 'uiAutomation', 'graphicsCapture', 'sendInput'].includes(key) ||
            typeof enabled !== 'boolean',
        )
      )
        throw new Error('HANDSHAKE_INVALID');
    }
  }
  if (!Reflect.ownKeys(handshake).includes('eligibility')) return null;
  const eligibility = computerUseEligibilitySchema.safeParse(handshake['eligibility']);
  if (!eligibility.success) throw new Error('HANDSHAKE_INVALID');
  return eligibility.data;
}
