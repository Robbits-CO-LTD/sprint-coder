import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { openWindowsLedgerStore } from './computer-use-windows-ledger-store';
import {
  configureWindowsKillStop,
  WINDOWS_KILL_STOP_ENABLED,
} from './computer-use-windows-product';

describe('PR10a product wiring', () => {
  it('closes persistence even when Windows kill-stop shutdown throws', async () => {
    const source = readFileSync(join(__dirname, 'index.ts'), 'utf8');
    const start = source.indexOf('async function disposeApplicationResources()');
    const end = source.indexOf('\nfunction createWindow()', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const close = vi.fn();
    const error = vi.fn();
    await runInNewContext(
      ts.transpileModule(`${source.slice(start, end)}\ndisposeApplicationResources();`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText,
      {
        autoUpdateController: undefined,
        router: { dispose: async () => undefined },
        windowsKillStop: {
          close: () => {
            throw new Error('synthetic shutdown failure');
          },
        },
        persistence: { close },
        secureLogger: { error },
      },
    );
    expect(close).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
  });
  it('turns product activation on by default on Windows and never on macOS (PR10b)', () => {
    expect(WINDOWS_KILL_STOP_ENABLED).toBe(true);
    const store = { close: vi.fn() };
    const opened = vi.fn(() => store as unknown as ReturnType<typeof openWindowsLedgerStore>);
    const windows = configureWindowsKillStop({
      platform: 'win32',
      userData: 'C:/synthetic',
      open: opened,
    });
    expect(opened).toHaveBeenCalledOnce();
    expect(windows.options).toMatchObject({
      windowsKillStopTermination: { enabled: true },
      windowsStartIdentity: { enabled: true },
      windowsLedger: store,
    });
    const open = vi.fn(() => {
      throw new Error('must not open');
    });
    expect(
      configureWindowsKillStop({
        platform: 'win32',
        userData: 'C:/synthetic',
        enabled: false,
        open,
      }).options,
    ).toEqual({});
    expect(
      configureWindowsKillStop({ platform: 'darwin', userData: '/synthetic', enabled: true, open })
        .options,
    ).toEqual({});
    expect(open).not.toHaveBeenCalled();
  });
  it('keeps the fail-closed policy when the shared store cannot open', () => {
    const open = vi.fn(() => {
      throw new Error('synthetic storage failure');
    });
    const product = configureWindowsKillStop({
      platform: 'win32',
      userData: 'C:/synthetic',
      enabled: true,
      open,
    });
    expect(open).toHaveBeenCalledWith({ userData: 'C:/synthetic', requireRealpath: true });
    expect(product.options).toMatchObject({
      windowsKillStopTermination: { enabled: true },
      windowsStartIdentity: { enabled: true },
    });
    expect(product.options.windowsLedger).toBeUndefined();
    product.close();
  });
});
