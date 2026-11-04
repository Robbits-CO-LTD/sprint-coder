import { findBuild } from './test-support/msvc-build';
import { execFile, type ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Keep the worker responsive to Vitest RPC during native compilation and execution.
function runAsync(file: string, args: string[], options: ExecFileOptionsWithStringEncoding) {
  return new Promise<{ status: number | null; output: string }>((resolve) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      resolve({
        status: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        output: `${error ?? ''}\n${stdout}\n${stderr}`,
      });
    });
  });
}

const build = findBuild();

// The native seam uses fake hooks and windows; it sends no real OS input.
describe.skipIf(build === null)('Windows background monitor native component', () => {
  async function compileAndRun(source: string) {
    const native = join(__dirname, '../../computer-use-native');
    const directory = mkdtempSync(join(tmpdir(), 'sc-bgmon-'));
    try {
      const exe = join(directory, 'bgmon.exe');
      const command = build!.wrap([
        '/nologo',
        '/std:c++20',
        '/EHsc',
        '/W4',
        '/utf-8',
        '/DUNICODE',
        '/D_UNICODE',
        '/DNOMINMAX',
        '/DWIN32_LEAN_AND_MEAN',
        '/D_WIN32_WINNT=0x0A00',
        `/I${native}`,
        join(native, source),
        `/Fe:${exe}`,
        'user32.lib',
        'ole32.lib',
        'oleaut32.lib',
        'advapi32.lib',
      ]);
      const compiled = await runAsync(command.file, command.args, {
        cwd: directory,
        encoding: 'utf8',
        windowsHide: true,
        windowsVerbatimArguments: command.verbatim,
        timeout: 500000,
      });
      expect(compiled.status, `Compile:\n${compiled.output}\nRun: NOT_RUN`).toBe(0);
      const result = await runAsync(exe, [], {
        cwd: directory,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 120000,
      });
      const output = `Compile:\n${compiled.output}\nRun:\n${result.output}`;
      expect(result.status, output).toBe(0);
      return { result, output };
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }

  it('compiles and runs the background monitor native seam', async () => {
    const { result, output } = await compileAndRun(
      'computer_use_windows_background_monitor_test.cc',
    );
    expect(result.output, output).toContain('Background monitor native seam: PASS');
  }, 540000);

  it('compiles and runs the background executor native seam', async () => {
    await compileAndRun('computer_use_windows_background_executor_test.cc');
  }, 540000);
});
