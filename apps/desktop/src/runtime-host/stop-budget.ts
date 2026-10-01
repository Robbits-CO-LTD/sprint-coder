import type { RuntimeKind } from './protocol';

export const RUNTIME_PROCESS_TREE_GRACE_MS = 2_000;
export const RUNTIME_TASKKILL_TIMEOUT_MS = 10_000;
// Grok awaits the forced taskkill between its initial and final exit-confirmation windows.
export const GROK_WINDOWS_PROCESS_TREE_STOP_BUDGET_MS =
  2 * RUNTIME_PROCESS_TREE_GRACE_MS + RUNTIME_TASKKILL_TIMEOUT_MS;
const STOP_RECEIPT_DELIVERY_MARGIN_MS = 1_000;

export function runtimeStopConfirmationTimeoutMs(
  kind: RuntimeKind,
  platform: string = process.platform,
): number {
  return kind === 'grok' && platform === 'win32'
    ? GROK_WINDOWS_PROCESS_TREE_STOP_BUDGET_MS + STOP_RECEIPT_DELIVERY_MARGIN_MS
    : 5_000;
}
