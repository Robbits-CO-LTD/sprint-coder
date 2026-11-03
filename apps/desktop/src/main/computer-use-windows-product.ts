import type { ComputerUseNativeHostOptions } from './computer-use-native-host';
import { openWindowsLedgerStore } from './computer-use-windows-ledger-store';
import { secureLogger } from './secure-logger';

// PR10b changes this default only after the complete PR10a connection is verified.
export const WINDOWS_KILL_STOP_ENABLED = false;

export function configureWindowsKillStop(input: {
  platform: NodeJS.Platform;
  userData: string;
  enabled?: boolean;
  open?: typeof openWindowsLedgerStore;
}): { options: ComputerUseNativeHostOptions; close(): void } {
  if (input.platform !== 'win32' || !(input.enabled ?? WINDOWS_KILL_STOP_ENABLED))
    return { options: {}, close() {} };
  const options: ComputerUseNativeHostOptions = {
    windowsKillStopTermination: { enabled: true },
    windowsStartIdentity: { enabled: true },
  };
  try {
    const store = (input.open ?? openWindowsLedgerStore)({
      userData: input.userData,
      requireRealpath: true,
    });
    return { options: { ...options, windowsLedger: store }, close: () => store.close() };
  } catch {
    // Missing storage deliberately leaves the enabled Host unavailable, never on the old path.
    secureLogger.warn('Windows Computer Use ledger unavailable', undefined, {
      event: 'computer_use.windows_ledger.open_failed',
    });
    return { options, close() {} };
  }
}
