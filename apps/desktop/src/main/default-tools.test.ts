import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MANAGED_EXEC_COMMAND_TOOL,
  POLL_COMMAND_TOOL,
  TERMINATE_COMMAND_TOOL,
  WRITE_STDIN_TOOL,
  rejectWindowsSandboxedNodeTestIsolationWithVersion,
} from './default-tools';
import { MANAGED_STDIN_MAX_CHARACTERS } from './managed-command-stdin';
import type { CommandRunnerError } from './command-runner';
import { secureLogger } from './secure-logger';
import { readWindowsExecutableFileVersion } from './windows-pe-version';

vi.mock('./windows-pe-version', () => ({ readWindowsExecutableFileVersion: vi.fn() }));

describe('managed exec command guidance', () => {
  it('explains the Windows sealed-executable and Node test constraints', () => {
    expect(MANAGED_EXEC_COMMAND_TOOL.description).toContain('absolute .exe path');
    expect(MANAGED_EXEC_COMMAND_TOOL.description).toContain('direct file I/O');
    expect(MANAGED_EXEC_COMMAND_TOOL.description).toContain('--test-isolation=none');
    expect(MANAGED_EXEC_COMMAND_TOOL.description).toContain('--experimental-test-isolation=none');
    expect(MANAGED_EXEC_COMMAND_TOOL.description).not.toContain('launches a blocked child process');
    expect(MANAGED_EXEC_COMMAND_TOOL.description).toContain('must not repeat executable');
    expect(MANAGED_EXEC_COMMAND_TOOL.description).toContain('never creates Edit Saga assurance');
    expect(
      (MANAGED_EXEC_COMMAND_TOOL.inputSchema as { properties?: Record<string, unknown> })
        .properties,
    ).not.toHaveProperty('verification');
  });
});

describe('managed command session control authority', () => {
  it('gives a stdin write the same authority as the command it feeds', () => {
    // Whatever reaches stdin becomes what the approved command does, so the write is authorized
    // like the command itself rather than by session ownership alone (Issue #473).
    expect(WRITE_STDIN_TOOL.requiredCapabilities).toEqual(
      MANAGED_EXEC_COMMAND_TOOL.requiredCapabilities,
    );
    expect(WRITE_STDIN_TOOL.requiredCapabilities).toEqual(['shell.execute']);
    expect(WRITE_STDIN_TOOL.sideEffect).toBe(MANAGED_EXEC_COMMAND_TOOL.sideEffect);
    expect(WRITE_STDIN_TOOL.kind).toBe('shell');
    expect(WRITE_STDIN_TOOL.risk).toBe('high');
  });

  it('advertises the per-call stdin limit that keeps the approval card complete', () => {
    // The pinned schema does not enforce string bounds, so this is what tells the provider the
    // limit; `prepare` is what refuses a call that exceeds it (Issue #473).
    expect(
      (WRITE_STDIN_TOOL.inputSchema as { properties: { chars: { maxLength?: number } } }).properties
        .chars.maxLength,
    ).toBe(MANAGED_STDIN_MAX_CHARACTERS);
  });

  it('leaves polling and termination free of new authority', () => {
    for (const definition of [POLL_COMMAND_TOOL, TERMINATE_COMMAND_TOOL]) {
      expect(definition.requiredCapabilities).toEqual([]);
      expect(definition.sideEffect).toBe('none');
      expect(definition.risk).toBe('low');
    }
  });
});

describe('rejectWindowsSandboxedNodeTestIsolationWithVersion', () => {
  const readVersionMock = vi.mocked(readWindowsExecutableFileVersion);

  afterEach(() => {
    readVersionMock.mockReset();
    vi.restoreAllMocks();
  });

  it('never reads the file version when the command would not be rejected', async () => {
    // sandboxed: false alone is enough to make shouldReject false regardless of platform, so this
    // exercises the gate without depending on which OS actually runs the test (Issue #549).
    await expect(
      rejectWindowsSandboxedNodeTestIsolationWithVersion(
        'C:\\Program Files\\nodejs\\node.exe',
        ['--test'],
        false,
      ),
    ).resolves.toBeUndefined();
    expect(readVersionMock).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'win32')(
    'reads the file version only on the path that is about to reject, and folds it into the thrown message',
    async () => {
      vi.spyOn(secureLogger, 'warn').mockImplementation(() => undefined);
      readVersionMock.mockResolvedValue({ major: 22, minor: 14, build: 0 });

      await expect(
        rejectWindowsSandboxedNodeTestIsolationWithVersion(
          'C:\\Program Files\\nodejs\\node.exe',
          ['--test'],
          true,
        ),
      ).rejects.toMatchObject({
        name: 'CommandRunnerError',
        code: 'NODE_TEST_ISOLATION_REQUIRED',
        message: expect.stringContaining('v22.14.0'),
      } satisfies Partial<CommandRunnerError>);
      expect(readVersionMock).toHaveBeenCalledOnce();
      expect(readVersionMock).toHaveBeenCalledWith('C:\\Program Files\\nodejs\\node.exe');
    },
  );

  it.runIf(process.platform === 'win32')(
    'still rejects, without a version in the message, when reading the version fails',
    async () => {
      vi.spyOn(secureLogger, 'warn').mockImplementation(() => undefined);
      readVersionMock.mockResolvedValue(null);

      await expect(
        rejectWindowsSandboxedNodeTestIsolationWithVersion(
          'C:\\Program Files\\nodejs\\node.exe',
          ['--test'],
          true,
        ),
      ).rejects.toMatchObject({
        code: 'NODE_TEST_ISOLATION_REQUIRED',
        message: expect.stringContaining('First check the version with node.exe --version'),
      } satisfies Partial<CommandRunnerError>);
    },
  );

  it.runIf(process.platform === 'win32')(
    'does not read the version when isolation is already disabled',
    async () => {
      await expect(
        rejectWindowsSandboxedNodeTestIsolationWithVersion(
          'C:\\Program Files\\nodejs\\node.exe',
          ['--test', '--test-isolation=none'],
          true,
        ),
      ).resolves.toBeUndefined();
      expect(readVersionMock).not.toHaveBeenCalled();
    },
  );
});
