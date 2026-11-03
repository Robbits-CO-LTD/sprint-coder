import type { ComputerUseNativeHostOptions } from './computer-use-native-host';
import { openWindowsLedgerStore } from './computer-use-windows-ledger-store';
import { secureLogger } from './secure-logger';

// PR10b: Windows kill-stop (E1 / E2, R11 / R12 / R13 and the PR5b, PR8 and PR9 paths) is on in
// the product. E3 / E4 stay on their current paths until PR11.
export const WINDOWS_KILL_STOP_ENABLED = true;

export function configureWindowsKillStop(input: {
  platform: NodeJS.Platform;
  userData: string;
  enabled?: boolean;
  open?: typeof openWindowsLedgerStore;
}): { options: ComputerUseNativeHostOptions; close(): void } {
  if (input.platform !== 'win32') return { options: {}, close() {} };
  const options: ComputerUseNativeHostOptions = {
    windowsKillStopTermination: { enabled: true },
    windowsStartIdentity: { enabled: true },
  };
  // N5-G removed the Stop-only new-start worker, and N5-I the discovery one, so the old path is gone:
  // a disabled build leaves the Host unavailable, exactly like a missing ledger, instead of starting
  // or discovering without kill-stop.
  if (!(input.enabled ?? WINDOWS_KILL_STOP_ENABLED)) return { options, close() {} };
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
