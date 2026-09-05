// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SkillSettingsSection } from './SkillSettingsSection';

afterEach(() => vi.unstubAllGlobals());

it('waits for an explicit reload after a failed initial request', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // Only the first request rejects; a buggy automatic retry therefore terminates deterministically.
  const list = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ items: [] });
  Object.defineProperty(window, 'sprintCoder', {
    configurable: true,
    value: {
      skills: { list, listDrafts: vi.fn().mockResolvedValue([]) },
    },
  });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<SkillSettingsSection active />));
    expect(list).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('再読み込み');
    const reload = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('再読み込み'),
    );
    expect(reload?.disabled).toBe(false);
    await act(async () => reload?.click());
    expect(list).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    Reflect.deleteProperty(window, 'sprintCoder');
  }
});
