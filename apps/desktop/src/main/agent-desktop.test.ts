import { describe, expect, it } from 'vitest';
import { resolveAgentDesktopCommand } from './agent-desktop';

const files = (...paths: string[]) => {
  const set = new Set(paths);
  return (path: string) => set.has(path);
};

describe('agent-desktop lookup', () => {
  it('uses an explicit absolute path when it names an existing file', () => {
    expect(
      resolveAgentDesktopCommand({
        env: { SPRINT_CODER_AGENT_DESKTOP: 'C:\\tools\\agent-desktop.exe' },
        platform: 'win32',
        isFile: files('C:\\tools\\agent-desktop.exe'),
      }),
    ).toBe('C:\\tools\\agent-desktop.exe');
  });

  it('does not fall back to PATH when the explicit path is relative or missing', () => {
    const onPath = files('C:\\npm\\agent-desktop.cmd');
    const env = { Path: 'C:\\npm' };
    expect(
      resolveAgentDesktopCommand({
        env: { ...env, SPRINT_CODER_AGENT_DESKTOP: 'agent-desktop.exe' },
        platform: 'win32',
        isFile: onPath,
      }),
    ).toBeNull();
    expect(
      resolveAgentDesktopCommand({
        env: { ...env, SPRINT_CODER_AGENT_DESKTOP: 'C:\\missing\\agent-desktop.exe' },
        platform: 'win32',
        isFile: onPath,
      }),
    ).toBeNull();
  });

  it('finds the npm shim on the Windows Path in order and skips relative entries', () => {
    expect(
      resolveAgentDesktopCommand({
        env: { Path: '.;"C:\\Program Files\\nodejs";C:\\npm;C:\\later' },
        platform: 'win32',
        isFile: files('C:\\npm\\agent-desktop.cmd', 'C:\\later\\agent-desktop.exe'),
      }),
    ).toBe('C:\\npm\\agent-desktop.cmd');
  });

  it('finds the executable on a POSIX PATH', () => {
    expect(
      resolveAgentDesktopCommand({
        env: { PATH: 'relative:/usr/bin:/opt/homebrew/bin' },
        platform: 'darwin',
        isFile: files('/opt/homebrew/bin/agent-desktop'),
      }),
    ).toBe('/opt/homebrew/bin/agent-desktop');
  });

  it('returns null when nothing is installed', () => {
    expect(
      resolveAgentDesktopCommand({ env: { PATH: '/usr/bin' }, platform: 'linux', isFile: files() }),
    ).toBeNull();
    expect(resolveAgentDesktopCommand({ env: {}, platform: 'linux', isFile: files() })).toBeNull();
  });
});
