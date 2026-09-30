import { expect, it } from 'vitest';
import { runtimeStopConfirmationTimeoutMs } from './stop-budget';

it.each(['codex', 'claude', 'grok'] as const)(
  '%s uses the bounded tree budget only on supported POSIX platforms',
  (kind) => {
    expect(runtimeStopConfirmationTimeoutMs(kind, 'linux')).toBe(9_000);
    expect(runtimeStopConfirmationTimeoutMs(kind, 'darwin')).toBe(9_000);
    expect(runtimeStopConfirmationTimeoutMs(kind, 'win32')).toBe(kind === 'grok' ? 15_000 : 5_000);
    expect(runtimeStopConfirmationTimeoutMs(kind, 'freebsd')).toBe(5_000);
  },
);
