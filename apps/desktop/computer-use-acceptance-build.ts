import { COMPUTER_USE_WINDOWS_UNSIGNED_ACCEPTANCE } from './src/main/computer-use-acceptance-mode';

export const COMPUTER_USE_ACCEPTANCE_BUILD_ENV = 'SPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD';
export const COMPUTER_USE_ACCEPTANCE_BUILD_RECEIPT_NAME = 'computer-use-acceptance-build.json';

/**
 * This string must never appear in any module that Vite bundles into Main.  It is injected only as
 * part of the compiled acceptance payload, so the packaged Main bundle contains it exactly when the
 * acceptance mode was enabled for that build — which is what lets the release path verify on the
 * produced artifact instead of trusting its own inputs.
 */
export const COMPUTER_USE_ACCEPTANCE_BUILD_MARKER =
  'sprint-coder-computer-use-acceptance-build-do-not-release';

export type ComputerUseAcceptanceBuild = Readonly<{
  mode: typeof COMPUTER_USE_WINDOWS_UNSIGNED_ACCEPTANCE;
  marker: typeof COMPUTER_USE_ACCEPTANCE_BUILD_MARKER;
}>;

/**
 * Resolve the acceptance build payload from the build host's environment.  Both the Vite `define`
 * and the Forge hooks read it through here so they can never disagree.  An unusable value fails the
 * build rather than silently producing an ordinary package under an acceptance-looking command.
 */
export function computerUseAcceptanceBuildForEnv(
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): ComputerUseAcceptanceBuild | null {
  const value = environment[COMPUTER_USE_ACCEPTANCE_BUILD_ENV];
  if (value === undefined || value.length === 0) return null;
  if (value !== COMPUTER_USE_WINDOWS_UNSIGNED_ACCEPTANCE)
    throw new Error(
      `${COMPUTER_USE_ACCEPTANCE_BUILD_ENV} accepts only the acceptance build mode ${COMPUTER_USE_WINDOWS_UNSIGNED_ACCEPTANCE}`,
    );
  if (platform !== 'win32')
    throw new Error(
      `${COMPUTER_USE_WINDOWS_UNSIGNED_ACCEPTANCE} requires a Windows build host; ${platform} cannot produce it`,
    );
  return Object.freeze({
    mode: COMPUTER_USE_WINDOWS_UNSIGNED_ACCEPTANCE,
    marker: COMPUTER_USE_ACCEPTANCE_BUILD_MARKER,
  });
}
