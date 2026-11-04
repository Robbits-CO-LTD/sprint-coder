import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

// Build host only: neither the path nor the environment is consulted at runtime.
export function backgroundAcceptanceFixtureDigest(environment) {
  const path = environment.SPRINT_CODER_BACKGROUND_ACCEPTANCE_FIXTURE;
  if (!path || !isAbsolute(path))
    throw new Error('Background acceptance requires an absolute fixture path');
  const bytes = readFileSync(path);
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ')
    throw new Error('Background acceptance fixture must be a PE executable');
  const pe = bytes.readUInt32LE(60);
  if (
    pe > bytes.length - 94 ||
    bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0' ||
    bytes.readUInt16LE(pe + 92) !== 2
  )
    throw new Error('Background acceptance fixture must use the Windows GUI subsystem');
  return createHash('sha256').update(bytes).digest('hex');
}

// Kept in step with Main's computerUseAcceptanceBuildForEnv by the acceptance-mode tests.
// Only the build process reads the environment; the helper receives a literal through /FI.
export function nativeAcceptanceBuildHeader(environment, platform) {
  const value = environment.SPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD;
  const enabled = value !== undefined && value !== '';
  if (
    enabled &&
    (!['windows-unsigned-acceptance', 'windows-background-acceptance'].includes(value) ||
      platform !== 'win32')
  )
    throw new Error('Computer Use native acceptance mode requires a Windows acceptance build');
  if (value === 'windows-background-acceptance') {
    const digest = backgroundAcceptanceFixtureDigest(environment);
    return `#pragma once\n#define SPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD 1\n#define SPRINT_CODER_WINDOWS_BACKGROUND_ACCEPTANCE 1\n#define SPRINT_CODER_BACKGROUND_FIXTURE_SHA256 "${digest}"\n`;
  }
  return `#pragma once\n#define SPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD ${enabled ? 1 : 0}\n`;
}
