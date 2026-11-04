import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { allowWindowsHelperForeground, readWindowsMainIdentity } from './computer-use-windows-main';

describe('P5c1 Windows Main addon boundary (OS calls stubbed)', () => {
  it.each([undefined, 0, -1, 1.5, 0xffff_ffff, NaN, 43])(
    'rejects unknown/invalid helper PID or a different requested PID: %s',
    (pid) => {
      const createHelperPermit = vi.fn();
      expect(
        allowWindowsHelperForeground({ createHelperPermit, readMainIdentity: vi.fn() }, pid, 42),
      ).toBe(false);
      expect(createHelperPermit).not.toHaveBeenCalled();
    },
  );
  it.each([true, false])('returns the native result for only the bound helper: %s', (result) => {
    const permit = vi.fn(() => result);
    const createHelperPermit = vi.fn(() => permit);
    expect(
      allowWindowsHelperForeground({ createHelperPermit, readMainIdentity: vi.fn() }, 42, 42),
    ).toBe(result);
    expect(createHelperPermit).toHaveBeenCalledExactlyOnceWith(42);
    expect(permit).toHaveBeenCalledExactlyOnceWith(42);
  });
  it('fails closed if the native permit cannot be created', () => {
    expect(
      allowWindowsHelperForeground(
        {
          createHelperPermit: () => {
            throw new Error();
          },
          readMainIdentity: vi.fn(),
        },
        42,
        42,
      ),
    ).toBe(false);
  });
  it('derives the current process PID and executable digest from native process facts', () => {
    expect(
      readWindowsMainIdentity({
        createHelperPermit: vi.fn(),
        readMainIdentity: () => ({
          mainPid: process.pid,
          mainProcessStartTime: '123',
          imagePath: process.execPath,
        }),
      }),
    ).toEqual({
      mainPid: process.pid,
      mainProcessStartTime: '123',
      mainImageIdentity: createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),
    });
  });
  it.each([
    false,
    {},
    { mainPid: 0 },
    { mainPid: process.pid, mainProcessStartTime: '0', imagePath: process.execPath },
    { mainPid: process.pid, mainProcessStartTime: '123', imagePath: 'missing-main-image' },
  ])('rejects unavailable Main identity: %j', (facts) => {
    expect(() =>
      readWindowsMainIdentity({ readMainIdentity: () => facts, createHelperPermit: vi.fn() }),
    ).toThrow();
  });
  it('pins native PID restriction, one-shot/liveness checks, actual Main facts and no all-process grant', () => {
    const source = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_windows_main.cc'),
      'utf8',
    );
    expect(source).not.toContain('ASFW_ANY');
    expect(source).toContain('number >= MAXDWORD');
    expect(source).toContain('requested != permit->pid');
    expect(source).toContain('permit->consumed = true');
    expect(source).toContain('WaitForSingleObject(permit->process, 0) != WAIT_TIMEOUT');
    expect(source.match(/AllowSetForegroundWindow\(/gu)).toHaveLength(1);
    expect(source).toContain('AllowSetForegroundWindow(permit->pid)');
    expect(source).toContain('GetProcessTimes(GetCurrentProcess()');
    expect(source).toContain('QueryFullProcessImageNameW(GetCurrentProcess()');
    expect(source).toContain('GetCurrentProcessId()');
    expect(source).not.toMatch(/SendInput|SetForegroundWindow\(\s*(?!permit->pid)/u);
  });
});
