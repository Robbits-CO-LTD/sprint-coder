import { expect, it } from 'vitest';
import { runtimeCliStopOnRootExitSupported, runtimeStopConfirmationTimeoutMs } from './stop-budget';

it('starts root-exit cleanup only on supported owned-group and Job platforms', () => {
  for (const platform of ['win32', 'linux', 'darwin'])
    expect(runtimeCliStopOnRootExitSupported(platform)).toBe(true);
  expect(runtimeCliStopOnRootExitSupported('freebsd')).toBe(false);
});

it.each(['codex', 'claude', 'grok'] as const)(
  '%s uses the bounded tree budget only on supported POSIX platforms',
  (kind) => {
    expect(runtimeStopConfirmationTimeoutMs(kind, 'linux')).toBe(9_000);
    expect(runtimeStopConfirmationTimeoutMs(kind, 'darwin')).toBe(9_000);
    expect(runtimeStopConfirmationTimeoutMs(kind, 'win32')).toBe(kind === 'grok' ? 15_000 : 5_000);
    expect(runtimeStopConfirmationTimeoutMs(kind, 'freebsd')).toBe(5_000);
  },
);
