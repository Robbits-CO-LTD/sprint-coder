// Kept in step with Main's computerUseAcceptanceBuildForEnv by the acceptance-mode tests.
// Only the build process reads the environment; the helper receives a literal through /FI.
export function nativeAcceptanceBuildHeader(environment, platform) {
  const value = environment.SPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD;
  const enabled = value !== undefined && value !== '';
  if (enabled && (value !== 'windows-unsigned-acceptance' || platform !== 'win32'))
    throw new Error('Computer Use native acceptance mode requires a Windows acceptance build');
  return `#pragma once\n#define SPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD ${enabled ? 1 : 0}\n`;
}
