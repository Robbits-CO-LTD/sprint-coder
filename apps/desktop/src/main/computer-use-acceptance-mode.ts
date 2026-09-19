import {
  computerUseAcceptanceModeSchema,
  type ComputerUseAcceptanceMode,
} from '@sprint-coder/contracts';

export const COMPUTER_USE_WINDOWS_UNSIGNED_ACCEPTANCE = 'windows-unsigned-acceptance' as const;

/**
 * Build-time only.  Vite bakes this constant into the Main bundle from the build host's
 * environment; after the build there is no identifier left to shadow and no runtime input — no
 * environment variable, CLI argument, settings value or packaged manifest field — can reach it.
 * An ordinary build compiles it to `null`, so every shape other than the exact payload is "off".
 */
declare const __SPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD__: unknown;

export function computerUseCompiledAcceptanceMode(): ComputerUseAcceptanceMode | null {
  if (typeof __SPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD__ === 'undefined') return null;
  const value = __SPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD__;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const parsed = computerUseAcceptanceModeSchema.safeParse(
    (value as Record<string, unknown>)['mode'],
  );
  return parsed.success ? parsed.data : null;
}

/**
 * The only waiver this mode grants: a Windows package that carries no Authenticode signer at all.
 * A signed package keeps its full signer verification even when the constant is compiled in, and
 * macOS is never waived.
 */
export function computerUseWindowsSignerWaived(
  platform: NodeJS.Platform,
  signerDigest: string | null,
): boolean {
  return (
    platform === 'win32' &&
    signerDigest === null &&
    computerUseCompiledAcceptanceMode() === COMPUTER_USE_WINDOWS_UNSIGNED_ACCEPTANCE
  );
}
