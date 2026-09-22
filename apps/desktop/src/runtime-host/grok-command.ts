import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { environmentValue, type CliCommandCandidate } from './cli-command-resolution';

/** Resolve the native official installer path; never execute a Workspace-local Windows shim. */
export function resolveGrokCommandCandidates(
  command = 'grok',
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  platform: NodeJS.Platform = process.platform,
): CliCommandCandidate[] {
  const path = platform === 'win32' ? win32 : posix;
  const explicit = environmentValue(environment, 'SPRINT_CODER_GROK_COMMAND', platform);
  if (explicit || command !== 'grok') {
    const executable = explicit || command;
    return path.isAbsolute(executable) ? [{ executable, source: 'explicit' }] : [];
  }
  const userHome =
    environmentValue(environment, 'HOME', platform) ??
    environmentValue(environment, 'USERPROFILE', platform) ??
    homedir();
  const grokHome =
    environmentValue(environment, 'GROK_HOME', platform) || path.join(userHome, '.grok');
  const name = platform === 'win32' ? 'grok.exe' : 'grok';
  const candidates: CliCommandCandidate[] = [
    { executable: path.join(grokHome, 'bin', name), source: 'user-local' },
    { executable: path.join(userHome, '.local', 'bin', name), source: 'user-local' },
    ...(environmentValue(environment, 'PATH', platform) ?? '')
      .split(platform === 'win32' ? ';' : ':')
      .map((entry) => entry.trim().replace(/^"(.*)"$/u, '$1'))
      .filter((entry) => path.isAbsolute(entry))
      .map((entry) => ({ executable: path.join(entry, name), source: 'path' as const })),
    ...(platform === 'darwin'
      ? ['/opt/homebrew/bin', '/usr/local/bin'].map((entry) => ({
          executable: path.join(entry, name),
          source: 'path' as const,
        }))
      : []),
  ];
  return candidates.filter(({ executable }, index) => {
    if (
      !path.isAbsolute(executable) ||
      candidates.findIndex((c) => c.executable === executable) !== index
    )
      return false;
    try {
      if (!statSync(executable).isFile()) return false;
      accessSync(executable, platform === 'win32' ? constants.F_OK : constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}
