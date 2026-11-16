// @vitest-environment jsdom
import type * as ThemeModule from './theme';
import type { SprintCoderApi } from '@sprint-coder/contracts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

function deferredSave() {
  let resolve!: (value: { saved: boolean }) => void;
  const promise = new Promise<{ saved: boolean }>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const set = vi.fn<SprintCoderApi['theme']['set']>();
let theme: typeof ThemeModule;

beforeEach(async () => {
  vi.resetModules();
  theme = await import('./theme');
  document.documentElement.removeAttribute('data-theme');
  set.mockReset().mockResolvedValue({ saved: true });
  Object.defineProperty(window, 'sprintCoder', {
    configurable: true,
    value: { theme: { set } },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, 'sprintCoder');
  document.documentElement.removeAttribute('data-theme');
});

it('applies immediately, reports failure and retries the same theme successfully', async () => {
  const result = deferredSave();
  set.mockReturnValueOnce(result.promise);
  const listener = vi.fn();
  const unsubscribe = theme.subscribeThemeSave(listener);
  theme.setTheme('white');
  expect(theme.activeTheme()).toBe('white');
  expect(theme.themeSaveFailed()).toBe(false);
  result.resolve({ saved: false });
  await result.promise;
  expect(theme.themeSaveFailed()).toBe(true);
  expect(listener).toHaveBeenCalledOnce();
  theme.retryThemeSave();
  await Promise.resolve();
  expect(set.mock.calls).toEqual([['white'], ['white']]);
  expect(theme.themeSaveFailed()).toBe(false);
  expect(listener).toHaveBeenCalledTimes(2);
  unsubscribe();
});

it.each([true, false])(
  'ignores an older result with saved=%s after a newer selection',
  async (saved) => {
    const older = deferredSave();
    set.mockReturnValueOnce(older.promise).mockResolvedValueOnce({ saved: !saved });
    theme.setTheme('white');
    theme.setTheme('gray');
    await Promise.resolve();
    expect(theme.themeSaveFailed()).toBe(saved);
    older.resolve({ saved });
    await older.promise;
    expect(theme.themeSaveFailed()).toBe(saved);
    expect(theme.activeTheme()).toBe('gray');
  },
);

it('treats rejection as failure and clears failure immediately on a different selection', async () => {
  set.mockRejectedValueOnce(new Error('disconnected'));
  theme.setTheme('white');
  await Promise.resolve();
  expect(theme.themeSaveFailed()).toBe(true);
  theme.setTheme('gray');
  expect(theme.themeSaveFailed()).toBe(false);
  await Promise.resolve();
  expect(theme.themeSaveFailed()).toBe(false);
});
