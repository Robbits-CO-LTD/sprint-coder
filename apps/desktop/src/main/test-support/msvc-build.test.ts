import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findBuild } from './msvc-build';

const mockSpawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawnSync: mockSpawn }));
vi.mock('node:fs', () => ({ existsSync: vi.fn() }));
const result = (status: number | null, stdout = '') => ({
  pid: 0,
  output: [],
  stdout,
  stderr: '',
  status,
  signal: null,
});

beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  vi.stubEnv('CI', '');
  mockSpawn.mockReturnValue(result(1));
  vi.mocked(existsSync).mockReturnValue(false);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe('MSVC discovery', () => {
  it('fails instead of skipping when Windows CI has no MSVC', () => {
    vi.stubEnv('CI', 'true');
    expect(() => findBuild()).toThrow('MSVC required on Windows CI');
  });
  it('allows local Windows to skip without MSVC', () => {
    expect(findBuild()).toBeNull();
  });
  it.each(['linux', 'darwin'] as const)('allows %s CI to skip without probing MSVC', (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    vi.stubEnv('CI', 'true');
    expect(findBuild()).toBeNull();
    expect(mockSpawn).not.toHaveBeenCalled();
  });
  it.each([
    { ...result(null), stdout: undefined, error: new Error('spawn failed') },
    { ...result(null), stdout: null },
    result(1, 'C:\\VS'),
    result(0, '  '),
  ])('handles failed or empty vswhere output safely: %j', (failed) => {
    vi.mocked(existsSync).mockReturnValue(true);
    mockSpawn.mockReturnValueOnce(result(1)).mockImplementationOnce(() => failed);
    expect(findBuild()).toBeNull();
    vi.stubEnv('CI', 'true');
    mockSpawn.mockReturnValueOnce(result(1)).mockImplementationOnce(() => failed);
    expect(() => findBuild()).toThrow('MSVC required on Windows CI');
  });
  it('requires vcvars64 to exist', () => {
    vi.mocked(existsSync).mockReturnValueOnce(true).mockReturnValueOnce(false);
    mockSpawn.mockReturnValueOnce(result(1)).mockReturnValueOnce(result(0, 'C:\\VS'));
    expect(findBuild()).toBeNull();
  });
  it('preserves direct compiler arguments in both result shapes', () => {
    vi.stubEnv('CI', 'true');
    mockSpawn.mockReturnValue(result(0));
    const args = ['/nologo', 'source with spaces.cc'];
    expect(findBuild()?.wrap(args)).toEqual({ file: 'cl.exe', args, verbatim: false });
    expect(findBuild(args)).toEqual({ name: 'cl.exe', file: 'cl.exe', args, verbatim: false });
  });
  it('preserves vcvars quoting and verbatim arguments', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    mockSpawn.mockReturnValueOnce(result(1)).mockReturnValueOnce(result(0, ' C:\\VS Root\r\n'));
    const vcvars = join('C:\\VS Root', 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
    expect(findBuild(['source file.cc', '/Fe:output.exe'])).toEqual({
      name: 'cl.exe (vcvars64)',
      file: 'cmd.exe',
      verbatim: true,
      args: [
        '/d',
        '/s',
        '/c',
        `"call "${vcvars}" >nul && cl.exe "source file.cc" "/Fe:output.exe""`,
      ],
    });
  });
});
