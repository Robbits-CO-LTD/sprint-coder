import { describe, expect, it, vi } from 'vitest';
import { configureWindowsKillStop } from './computer-use-windows-product';

describe('PR10a product wiring', () => {
  it('keeps product activation off by default and on macOS', () => {
    const open = vi.fn(() => {
      throw new Error('must not open');
    });
    expect(
      configureWindowsKillStop({ platform: 'win32', userData: 'C:/synthetic', open }).options,
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
